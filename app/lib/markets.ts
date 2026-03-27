export const HL_TESTNET_INFO = "https://api.hyperliquid-testnet.xyz/info";
export const HL_TESTNET_WS = "wss://api.hyperliquid-testnet.xyz/ws";

export const MULTI_COLORS = ["#3b82f6", "#f97316", "#8b5cf6", "#10b981", "#f59e0b", "#ec4899"];

export interface OutcomeOption {
  name: string;
  coinId: string;
  price: number;
}

export interface Market {
  question: string;
  coinId: string;
  testnet: boolean;
  volume: number;
  options: OutcomeOption[];
  isBinary: boolean;
  isRecurring?: boolean;
  description?: string;
}

export interface HLCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
}

export async function postInfo<T>(body: object, url = HL_TESTNET_INFO): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function fmtChartValue(v: number): string {
  if (v >= 10000) return `$${Math.round(v).toLocaleString("en-US")}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(5)}`;
}

export function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

export function fmtVolume(v: number): string {
  if (!v) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function volOf(ctx: Record<string, any> | undefined): number {
  if (!ctx) return 0;
  for (const key of ["dayNtlVlm", "volume", "vol", "vlm", "notionalVolume"]) {
    const v = ctx[key];
    if (v !== undefined && v !== null) {
      const n = parseFloat(String(v));
      if (n > 0) return n;
    }
  }
  return 0;
}

function parseRecurringName(description: string): string | null {
  const parts: Record<string, string> = {};
  for (const part of description.split("|")) {
    const sep = part.indexOf(":");
    if (sep > 0) parts[part.slice(0, sep)] = part.slice(sep + 1);
  }
  if (parts["class"] !== "priceBinary") return null;

  const { underlying, targetPrice, expiry } = parts;
  if (!underlying || !targetPrice || !expiry) return null;

  const m = expiry.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return null;

  // Parse as UTC then display in the user's local timezone (matches Hyperliquid UI)
  const expiryLocal = new Date(Date.UTC(
    parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), parseInt(m[4]), parseInt(m[5])
  ));
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthIdx = expiryLocal.getMonth();
  const day      = expiryLocal.getDate();
  const hour     = expiryLocal.getHours();
  const min      = expiryLocal.getMinutes();
  const ampm     = hour >= 12 ? "PM" : "AM";
  const h12      = (hour % 12 || 12).toString();
  const mm       = min.toString().padStart(2, "0");

  const price    = parseFloat(targetPrice);
  const priceStr = Number.isInteger(price)
    ? price.toLocaleString("en-US")
    : price.toLocaleString("en-US", { maximumFractionDigits: 5 });

  return `${underlying} above ${priceStr} on ${MONTHS[monthIdx]} ${day} at ${h12}:${mm} ${ampm}?`;
}

/** Parses the key fields from a priceBinary description string. */
function parseRecurringMeta(description: string): { underlying: string; expiryMs: number } | null {
  const parts: Record<string, string> = {};
  for (const part of description.split("|")) {
    const sep = part.indexOf(":");
    if (sep > 0) parts[part.slice(0, sep)] = part.slice(sep + 1);
  }
  if (parts["class"] !== "priceBinary") return null;
  const { underlying, expiry } = parts;
  if (!underlying || !expiry) return null;
  const m = expiry.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return null;
  const expiryMs = Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), parseInt(m[4]), parseInt(m[5]));
  return { underlying, expiryMs };
}

export interface MarketsResult {
  markets: Market[];
  /** coinId → index in spotMeta.universe (needed for order placement) */
  spotIndexMap: Record<string, number>;
  /** coinId → szDecimals for the base token (controls valid order size precision) */
  szDecimalsMap: Record<string, number>;
}

export async function fetchPredictMarkets(): Promise<MarketsResult> {
  type OutcomeEntry = {
    outcome: number;
    name: string;
    description?: string;
    sideSpecs: { name: string }[];
  };
  type QuestionEntry = {
    name: string;
    namedOutcomes: number[];
    fallbackOutcome: number;
    description?: string;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AssetCtx = Record<string, any>;

  const [meta, [spotMetaRaw, spotCtxs]] = await Promise.all([
    postInfo<{ outcomes: OutcomeEntry[]; questions?: QuestionEntry[] }>({ type: "outcomeMeta" }),
    postInfo<[
      { universe: { name: string; tokens: number[] }[]; tokens: { name: string }[] },
      AssetCtx[]
    ]>({ type: "spotMetaAndAssetCtxs" }),
  ]);

  const spotMeta = spotMetaRaw as {
    universe: { name: string; tokens: number[] }[];
    tokens: { name: string; szDecimals: number }[];
  };

  // Build index maps.  The spot universe lists PAIRS (e.g. "#20490/USDH") while
  // prediction-market lookups use just the base token name ("#20490").
  // We resolve via spotMeta.tokens[pair.tokens[0]].name so we match regardless
  // of the quote currency or pair-name format.
  const spotIndexMap: Record<string, number> = {};
  const szDecimalsMap: Record<string, number> = {};
  const priceMap = new Map<string, AssetCtx>();

  const registerAlias = (key: string, i: number, szDec: number) => {
    if (spotIndexMap[key] === undefined) spotIndexMap[key] = i;
    if (szDecimalsMap[key] === undefined) szDecimalsMap[key] = szDec;
  };

  // Log first few outcome-market universe entries so we can see the naming format
  const sampleOutcomeEntries = spotMeta.universe.filter((u) => u.name.startsWith("@")).slice(0, 3);
  if (sampleOutcomeEntries.length > 0) {
    console.log("[markets] Sample @-prefixed universe entries:", sampleOutcomeEntries.map((u, i) => ({
      name: u.name,
      baseToken: spotMeta.tokens?.[u.tokens?.[0]]?.name,
    })));
  }

  spotMeta.universe.forEach((u, i) => {
    const baseTokenIdx = u.tokens?.[0];
    const baseToken = baseTokenIdx !== undefined ? spotMeta.tokens?.[baseTokenIdx] : undefined;
    const szDec = baseToken?.szDecimals ?? 0;

    // Always index by the full pair name
    spotIndexMap[u.name] = i;
    szDecimalsMap[u.name] = szDec;
    priceMap.set(u.name, spotCtxs[i]);

    // Index by base token name from the tokens sub-array (most reliable)
    if (baseToken) {
      registerAlias(baseToken.name, i, szDec);
      priceMap.set(baseToken.name, spotCtxs[i]);
    }

    // Fallback: strip everything after "/" in the pair name
    const slashBase = u.name.split("/")[0];
    if (slashBase !== u.name) {
      registerAlias(slashBase, i, szDec);
      if (!priceMap.has(slashBase)) priceMap.set(slashBase, spotCtxs[i]);
    }

    // Prediction market pairs are named "@N" in the universe but "#N" on the book.
    // Add a "#N" alias so that book coinIds resolve to the correct universe index.
    if (u.name.startsWith("@")) {
      const hashAlias = "#" + u.name.slice(1);
      registerAlias(hashAlias, i, szDec);
      if (!priceMap.has(hashAlias)) priceMap.set(hashAlias, spotCtxs[i]);
    }
  });

  const outcomeById = new Map<number, OutcomeEntry>();
  for (const e of meta.outcomes) outcomeById.set(e.outcome, e);

  const claimedIds = new Set<number>();
  const markets: Market[] = [];

  for (const q of (meta.questions ?? [])) {
    const ids = [...q.namedOutcomes, q.fallbackOutcome].filter((id) => id != null);
    for (const id of ids) claimedIds.add(id);

    let totalVolume = 0;
    const options: OutcomeOption[] = ids.map((id) => {
      const entry = outcomeById.get(id);
      const yesCoinId = `#${10 * id}`;
      const noCoinId  = `#${10 * id + 1}`;
      const yesCtx = priceMap.get(yesCoinId);
      const noCtx  = priceMap.get(noCoinId);
      const price = parseFloat(yesCtx?.markPx ?? "0") || 0;
      totalVolume += volOf(yesCtx) + volOf(noCtx);
      return { name: entry?.name ?? String(id), coinId: yesCoinId, price };
    });

    markets.push({
      question: q.name,
      coinId: options[0]?.coinId ?? "",
      testnet: true,
      volume: totalVolume,
      isBinary: false,
      options,
      description: q.description,
    });
  }

  // Track soonest active recurring market per underlying to deduplicate
  // (Hyperliquid keeps old + new versions simultaneously; we only want the soonest expiry)
  const recurringByUnderlying = new Map<string, { expiryMs: number; market: Market }>();

  // Log all binary outcome IDs to understand the encoding scheme
  console.log("[markets] Binary outcomes (first 10):", meta.outcomes.slice(0, 10).map((e) => ({
    outcome: e.outcome,
    name: e.name,
    enc0: 10 * e.outcome,
    enc1: 10 * e.outcome + 1,
    inPriceMap0: priceMap.has(`#${10 * e.outcome}`),
    inSpotIdx0:  spotIndexMap[`#${10 * e.outcome}`] !== undefined,
    inPriceMapDirect: priceMap.has(`#${e.outcome}`),
    inSpotIdxDirect:  spotIndexMap[`#${e.outcome}`] !== undefined,
  })));

  for (const entry of meta.outcomes) {
    if (claimedIds.has(entry.outcome)) continue;

    const enc0 = 10 * entry.outcome;
    const enc1 = 10 * entry.outcome + 1;
    const ctx0 = priceMap.get(`#${enc0}`);
    const ctx1 = priceMap.get(`#${enc1}`);

    const price0 = parseFloat(ctx0?.markPx ?? "0") || 0;
    const price1Raw = parseFloat(ctx1?.markPx ?? "0") || 0;
    const price1 = price1Raw > 0 ? price1Raw : price0 > 0 ? 1 - price0 : 0;

    const question =
      entry.name === "Recurring" && entry.description
        ? parseRecurringName(entry.description) ?? entry.name
        : entry.name;

    const desc = entry.description && !entry.description.startsWith("class:")
      ? entry.description
      : undefined;

    const isRecurring = entry.name === "Recurring" && !!entry.description;

    const market: Market = {
      question,
      coinId: `#${enc0}`,
      testnet: true,
      volume: volOf(ctx0) + volOf(ctx1),
      isBinary: true,
      isRecurring,
      options: [
        { name: entry.sideSpecs[0]?.name ?? "Yes", coinId: `#${enc0}`, price: price0 },
        { name: entry.sideSpecs[1]?.name ?? "No",  coinId: `#${enc1}`, price: price1 },
      ],
      description: desc,
    };

    if (isRecurring) {
      const meta = parseRecurringMeta(entry.description!);
      if (!meta) continue; // malformed — skip
      if (meta.expiryMs < Date.now()) continue; // already expired — skip
      // Keep only the soonest-expiring active version per underlying
      const existing = recurringByUnderlying.get(meta.underlying);
      if (!existing || meta.expiryMs < existing.expiryMs) {
        recurringByUnderlying.set(meta.underlying, { expiryMs: meta.expiryMs, market });
      }
    } else {
      markets.push(market);
    }
  }

  // Add the single winning recurring market per underlying
  for (const { market } of recurringByUnderlying.values()) {
    markets.push(market);
  }

  return {
    markets: markets.sort((a, b) => b.volume - a.volume),
    spotIndexMap,
    szDecimalsMap,
  };
}
