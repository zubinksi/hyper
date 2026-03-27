/**
 * HyperEVM testnet utilities for reading on-chain balances.
 *
 * Chain ID: 998
 * RPC: https://rpc.hyperliquid-testnet.xyz/evm
 *
 * Note: USDH is a HyperCore native token (not an EVM ERC-20 contract).
 * Its balance is read via the HyperCore info API (spotClearinghouseState).
 */

const EVM_RPC = "https://rpc.hyperliquid-testnet.xyz/evm";
const HL_TESTNET_INFO = "https://api.hyperliquid-testnet.xyz/info";

// ERC-1155 outcome markets contract on HyperEVM
export const OUTCOME_CONTRACT = "0x6d86b21e853758f5719408633e6bcb2cfd50cf07";

// Outcome token decimals — adjust if balances appear scaled incorrectly
const OUTCOME_DECIMALS = 6;

async function evmCall(to: string, data: string): Promise<string> {
  const res = await fetch(EVM_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result as string;
}

/** Left-pad an address or uint256 to 32 bytes (64 hex chars). */
function pad32(value: string | bigint): string {
  if (typeof value === "string") {
    return value.toLowerCase().replace("0x", "").padStart(64, "0");
  }
  return value.toString(16).padStart(64, "0");
}

/** coinId "#123" → ERC-1155 token ID (100_000_000 + outcomeNumber) */
export function coinIdToTokenId(coinId: string): bigint {
  return BigInt(100_000_000) + BigInt(parseInt(coinId.slice(1)));
}

/**
 * Fetch USDH balance for an address via the HyperCore info API.
 * USDH is a HyperCore native token (spotSend type), not an EVM ERC-20.
 */
export async function fetchUsdhBalance(address: string): Promise<number> {
  try {
    const res = await fetch(HL_TESTNET_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "spotClearinghouseState", user: address }),
    });
    const data = await res.json() as { balances?: { coin: string; total: string }[] };
    const entry = data.balances?.find((b) => b.coin === "USDH");
    return entry ? parseFloat(entry.total) : 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch a single ERC-1155 outcome token balance for an address and coinId.
 * Returns balance in human-readable units.
 */
export async function fetchOutcomeBalance(address: string, coinId: string): Promise<number> {
  try {
    const tokenId = coinIdToTokenId(coinId);
    // balanceOf(address account, uint256 id)  selector: 0x00fdd58e
    const data = "0x00fdd58e" + pad32(address) + pad32(tokenId);
    const result = await evmCall(OUTCOME_CONTRACT, data);
    if (!result || result === "0x") return 0;
    return Number(BigInt(result)) / 10 ** OUTCOME_DECIMALS;
  } catch {
    return 0;
  }
}

/**
 * Fetch a spot token balance from HyperCore (spotClearinghouseState).
 * Works for outcome tokens (#N / @N) and any other spot asset.
 */
export async function fetchSpotBalance(address: string, coinId: string): Promise<number> {
  try {
    const res = await fetch(HL_TESTNET_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "spotClearinghouseState", user: address }),
    });
    const data = await res.json() as { balances?: { coin: string; total: string }[] };
    // Outcome tokens appear as either "#N" or "@N" — match both
    const alt = coinId.startsWith("#")
      ? "@" + coinId.slice(1)
      : coinId.startsWith("@")
      ? "#" + coinId.slice(1)
      : null;
    const entry = data.balances?.find(
      (b) => b.coin === coinId || (alt !== null && b.coin === alt)
    );
    return entry ? parseFloat(entry.total) : 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch ERC-1155 balances for many outcome tokens in one call (balanceOfBatch).
 * Returns a map of coinId → human-readable balance.
 */
export async function fetchOutcomeBalances(
  address: string,
  coinIds: string[]
): Promise<Record<string, number>> {
  if (!coinIds.length) return {};
  try {
    const n = coinIds.length;
    const tokenIds = coinIds.map(coinIdToTokenId);

    // balanceOfBatch(address[] accounts, uint256[] ids)  selector: 0x4e1273f4
    // ABI dynamic tuple encoding:
    //   word 0: offset to accounts[] = 64  (2 header words × 32)
    //   word 1: offset to ids[]      = 64 + 32 + n×32
    //   then accounts[] length + elements
    //   then ids[] length + elements
    const accountsOffset = BigInt(64);
    const idsOffset = accountsOffset + BigInt(32) + BigInt(n * 32);

    let data = "0x4e1273f4";
    data += pad32(accountsOffset);
    data += pad32(idsOffset);
    data += pad32(BigInt(n));
    for (let i = 0; i < n; i++) data += pad32(address);
    data += pad32(BigInt(n));
    for (const id of tokenIds) data += pad32(id);

    const result = await evmCall(OUTCOME_CONTRACT, data);
    if (!result || result === "0x") return {};

    // Return value: abi.encode(uint256[])
    // word 0: offset (32)  word 1: array length  then n words of values
    const hex = result.replace("0x", "");
    const balances: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const chunk = hex.slice(128 + i * 64, 128 + (i + 1) * 64);
      if (chunk.length < 64) continue;
      balances[coinIds[i]] = Number(BigInt("0x" + chunk)) / 10 ** OUTCOME_DECIMALS;
    }
    return balances;
  } catch {
    return {};
  }
}
