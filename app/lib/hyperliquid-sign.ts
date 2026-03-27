/**
 * Hyperliquid testnet order signing and submission.
 *
 * Flow:
 *  1. Build spot order action (msgpack-compatible object)
 *  2. Hash action with keccak256(msgpack(action) + vaultByte + nonce_be)
 *  3. Sign EIP-712 Agent{source:"b", connectionId: hash} with the wallet
 *  4. POST to /exchange
 */

import { encode as msgpackEncode } from "@msgpack/msgpack";
import { keccak256, hexlify, zeroPadValue } from "ethers";

const HL_TESTNET_EXCHANGE = "https://api.hyperliquid-testnet.xyz/exchange";

// Spot asset offset: Hyperliquid identifies spot tokens as 10000 + universeIndex
export const SPOT_ASSET_BASE = 10000;

/** Convert a number to the canonical wire-format string Hyperliquid expects. */
function floatToWire(x: number): string {
  const rounded = parseFloat(x.toFixed(8));
  if (Number.isInteger(rounded)) return String(Math.round(rounded));
  return rounded.toFixed(8).replace(/\.?0+$/, "");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

/**
 * Compute the 32-byte action hash used by Hyperliquid's EIP-712 signing:
 *   keccak256( msgpack(action) ++ vaultByte ++ nonce_big_endian_8bytes )
 */
function computeActionHash(
  action: object,
  vaultAddress: string | null,
  nonce: number
): Uint8Array {
  const packed = msgpackEncode(action);

  const vaultBuf =
    vaultAddress === null
      ? new Uint8Array([0])
      : new Uint8Array([1, ...hexToBytes(vaultAddress.replace(/^0x/, ""))]);

  const nonceBuf = new Uint8Array(8);
  new DataView(nonceBuf.buffer).setBigUint64(0, BigInt(nonce), false); // big-endian

  // Order: action | nonce | vaultMarker [| vaultBytes]
  const combined = new Uint8Array(packed.length + 8 + vaultBuf.length);
  combined.set(packed, 0);
  combined.set(nonceBuf, packed.length);
  combined.set(vaultBuf, packed.length + 8);

  return hexToBytes(keccak256(combined).slice(2));
}

// EIP-712 domain for Hyperliquid (chainId 1337 for both mainnet & testnet)
const AGENT_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
};

export interface OrderParams {
  /** Raw EIP-1193 provider (window.ethereum or WalletConnect EthereumProvider) */
  walletProvider: object;
  /** Index in spotMeta.universe for the token being traded */
  spotIndex: number;
  isBuy: boolean;
  /** Current mid/mark price of the token */
  price: number;
  /** Number of tokens to trade */
  size: number;
}

export interface OrderResult {
  success: boolean;
  message: string;
  txHash?: string;
  data?: unknown;
}

const HL_TESTNET_INFO = "https://api.hyperliquid-testnet.xyz/info";

/**
 * Estimate slippage by walking the L2 order book.
 * Returns percentage slippage (positive = worse than mid), or null if unavailable.
 */
export async function estimateSlippage(
  coinId: string,
  isBuy: boolean,
  size: number
): Promise<number | null> {
  if (size <= 0) return null;
  try {
    const res = await fetch(HL_TESTNET_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "l2Book", coin: coinId }),
    });
    const book = (await res.json()) as {
      levels: Array<Array<{ px: string; sz: string }>>;
    };
    const bids = book.levels?.[0] ?? [];
    const asks = book.levels?.[1] ?? [];
    if (!bids.length || !asks.length) return null;

    const midPrice = (parseFloat(bids[0].px) + parseFloat(asks[0].px)) / 2;
    if (midPrice <= 0) return null;

    const levels = isBuy ? asks : bids;
    let remaining = size;
    let totalCost = 0;
    for (const lvl of levels) {
      if (remaining <= 0) break;
      const px = parseFloat(lvl.px);
      const sz = parseFloat(lvl.sz);
      const filled = Math.min(remaining, sz);
      totalCost += filled * px;
      remaining -= filled;
    }
    if (remaining > 0 && levels.length > 0) {
      totalCost += remaining * parseFloat(levels[levels.length - 1].px);
    }

    const avgPx = totalCost / size;
    return isBuy
      ? ((avgPx - midPrice) / midPrice) * 100
      : ((midPrice - avgPx) / midPrice) * 100;
  } catch {
    return null;
  }
}

export async function signAndSubmitOrder({
  walletProvider,
  spotIndex,
  isBuy,
  price,
  size,
}: OrderParams): Promise<OrderResult> {
  if (spotIndex < 0) {
    return { success: false, message: "Token not found in spot universe" };
  }
  if (size <= 0) {
    return { success: false, message: "Size must be greater than zero" };
  }

  try {
    const { BrowserProvider } = await import("ethers");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ethersProvider = new BrowserProvider(walletProvider as any);
    const signer = await ethersProvider.getSigner();
    const signerAddress = await signer.getAddress();

    const assetId = SPOT_ASSET_BASE + spotIndex;

    // 10% slippage ceiling for IOC — wide enough to sweep through spreads.
    // Outcome tokens are 0–1 USDH: cap buys at 0.9999, floor sells at 0.0001.
    const SLIPPAGE = 0.10;
    const limitPx = isBuy
      ? Math.min(price * (1 + SLIPPAGE), 0.9999)
      : Math.max(price * (1 - SLIPPAGE), 0.0001);

    const MAX_RETRIES = 3;
    let remaining = size;
    let totalFilledSz = 0;
    let weightedPxSum = 0;
    let txHash: string | undefined;
    let lastError: string | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES && remaining > 0.000001; attempt++) {
      const nonce = Date.now();

      // Keys must match Python SDK insertion order for identical msgpack bytes
      const orderWire = {
        a: assetId,
        b: isBuy,
        p: floatToWire(limitPx),
        s: floatToWire(remaining),
        r: false,
        t: { limit: { tif: "Ioc" } },
      };

      const action = {
        type: "order",
        orders: [orderWire],
        grouping: "na",
      };

      const hashBytes = computeActionHash(action, null, nonce);
      const connectionId = zeroPadValue(hexlify(hashBytes), 32);

      // "b" = testnet source identifier
      const phantomAgent = { source: "b", connectionId };

      const sigHex: string = await signer.signTypedData(
        AGENT_DOMAIN,
        AGENT_TYPES,
        phantomAgent
      );

      // ethers returns 65-byte signature as 0x + r(32) + s(32) + v(1)
      const r = sigHex.slice(0, 66);
      const s = "0x" + sigHex.slice(66, 130);
      const v = parseInt(sigHex.slice(130, 132), 16);

      const payload = {
        action,
        nonce,
        signature: { r, s, v },
        vaultAddress: null,
      };

      const res = await fetch(HL_TESTNET_EXCHANGE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();

      if (json.status !== "ok") {
        const errMsg =
          typeof json.response === "string" ? json.response : JSON.stringify(json.response);
        return { success: false, message: errMsg, data: json };
      }

      const statuses: unknown[] = json.response?.data?.statuses ?? [];
      const first = statuses[0] as Record<string, unknown> | undefined;
      const filled = first?.filled as Record<string, unknown> | undefined;
      const statusError = typeof first?.error === "string" ? first.error : undefined;

      if (statusError) {
        lastError = statusError;
        break;
      }

      if (filled) {
        // filled.totalSz is in shares (tokens), not dollars
        const filledSz = parseFloat(filled.totalSz as string);
        const fillAvgPx = parseFloat(filled.avgPx as string);
        if (filledSz > 0) {
          totalFilledSz += filledSz;
          weightedPxSum += filledSz * fillAvgPx;
          remaining -= filledSz;

          // Fetch tx hash from the exchange on first fill
          if (!txHash) {
            try {
              const fillsRes = await fetch(HL_TESTNET_INFO, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  type: "userFillsByTime",
                  user: signerAddress,
                  startTime: nonce - 5000,
                  endTime: nonce + 30000,
                }),
              });
              const fills = await fillsRes.json() as Array<{ hash?: string; oid?: number }>;
              const oid = filled.oid as number | undefined;
              const match = oid !== undefined ? fills.find((f) => f.oid === oid) : fills[0];
              txHash = match?.hash;
            } catch { /* ignore */ }
          }
        } else {
          break; // zero fill, stop retrying
        }
      } else {
        // IOC not matched — no liquidity at this price
        lastError = lastError ?? "Order was not filled (insufficient liquidity at this price)";
        break;
      }
    }

    if (totalFilledSz > 0) {
      const overallAvg = weightedPxSum / totalFilledSz;
      return {
        success: true,
        message: `Filled ${totalFilledSz.toFixed(4)} @ avg ${overallAvg.toFixed(6)} USDH`,
        txHash,
        data: { totalFilledSz, overallAvg },
      };
    }

    return { success: false, message: lastError ?? "Order was not filled" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message };
  }
}
