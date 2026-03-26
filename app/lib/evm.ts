/**
 * HyperEVM testnet utilities for reading on-chain balances.
 *
 * Chain ID: 998
 * RPC: https://rpc.hyperliquid-testnet.xyz/evm
 */

const EVM_RPC = "https://rpc.hyperliquid-testnet.xyz/evm";

// ERC-20 USDH token on HyperEVM testnet
export const USDH_ADDRESS = "0x471fd4480bb9943a1fe080ab0d4ff36c";
// ERC-1155 outcome markets contract
export const OUTCOME_CONTRACT = "0x6d86b21e853758f5719408633e6bcb2cfd50cf07";

// USDH uses 6 decimals (matches USDC convention)
const USDH_DECIMALS = 6;
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
 * Fetch USDH balance (ERC-20 balanceOf) for an address.
 * Returns balance in human-readable USDH units.
 */
export async function fetchUsdhBalance(address: string): Promise<number> {
  try {
    // balanceOf(address)  selector: 0x70a08231
    const data = "0x70a08231" + pad32(address);
    const result = await evmCall(USDH_ADDRESS, data);
    if (!result || result === "0x") return 0;
    return Number(BigInt(result)) / 10 ** USDH_DECIMALS;
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
