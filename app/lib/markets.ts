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
  // Try the most common field names for volume
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

  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthIdx = parseInt(m[2]) - 1;
  const day      = parseInt(m[3]);
  const hour     = parseInt(m[4]);
  const min      = parseInt(m[5]);
  const ampm     = hour >= 12 ? "PM" : "AM";
  const h12      = (hour % 12 || 12).toString();
  const mm       = min.toString().padStart(2, "0");

  const price    = parseFloat(targetPrice);
  const priceStr = Number.isInteger(price)
    ? price.toLocaleString("en-US")
    : price.toLocaleString("en-US", { maximumFractionDigits: 5 });

  return `${underlying} above ${priceStr} on ${MONTHS[monthIdx]} ${day} at ${h12}:${mm} ${ampm}?`;
}

export async function fetchPredictMarkets(): Promise<Market[]> {
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
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AssetCtx = Record<string, any>;

  const [meta, [spotMeta, spotCtxs]] = await Promise.all([
    postInfo<{ outcomes: OutcomeEntry[]; questions?: QuestionEntry[] }>({ type: "outcomeMeta" }),
    postInfo<[{ universe: { name: string }[] }, AssetCtx[]]>({ type: "spotMetaAndAssetCtxs" }),
  ]);

  // Debug: log raw structure for volume field identification
  if (spotCtxs.length > 0) {
    const predictionSample = spotMeta.universe
      .map((u, i) => ({ name: u.name, ctx: spotCtxs[i] }))
      .find((x) => x.name.startsWith("#"));
    if (predictionSample) {
      console.log("[prediction ctx sample]", predictionSample.name, JSON.stringify(predictionSample.ctx));
    }
  }

  const priceMap = new Map<string, AssetCtx>();
  spotMeta.universe.forEach((u, i) => priceMap.set(u.name, spotCtxs[i]));

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
    });
  }

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

    markets.push({
      question,
      coinId: `#${enc0}`,
      testnet: true,
      volume: volOf(ctx0) + volOf(ctx1),
      isBinary: true,
      options: [
        { name: entry.sideSpecs[0]?.name ?? "Yes", coinId: `#${enc0}`, price: price0 },
        { name: entry.sideSpecs[1]?.name ?? "No",  coinId: `#${enc1}`, price: price1 },
      ],
    });
  }

  return markets.sort((a, b) => b.volume - a.volume);
}
