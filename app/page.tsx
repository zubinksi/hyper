"use client";

import { useState, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import type { CandlePoint, LivelinePoint, LivelineSeries } from "liveline";

const Liveline = dynamic(
  () => import("liveline").then((m) => ({ default: m.Liveline })),
  { ssr: false }
);

const HL_TESTNET_INFO = "https://api.hyperliquid-testnet.xyz/info";
const HL_TESTNET_WS = "wss://api.hyperliquid-testnet.xyz/ws";

const MULTI_COLORS = ["#3b82f6", "#f97316", "#8b5cf6", "#10b981", "#f59e0b", "#ec4899"];

interface OutcomeOption {
  name: string;
  coinId: string;
  price: number; // 0–1 probability
}

interface Market {
  question: string;  // display label
  coinId: string;    // primary coin (first option's yes-side)
  testnet: boolean;
  volume: number;
  options: OutcomeOption[];
  isBinary: boolean; // two-option yes/no market
}

interface HLCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
}

async function postInfo<T>(body: object, url = HL_TESTNET_INFO): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function fmtChartValue(v: number): string {
  if (v >= 10000) return `$${Math.round(v).toLocaleString("en-US")}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(5)}`;
}

function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

function fmtDateTime(d: Date): string {
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = (h % 12 || 12).toString();
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} ${hh}:${mm}:${ss}${ampm}`;
}

function toCandle(c: HLCandle): CandlePoint {
  return {
    time: Math.floor(c.t / 1000),
    open: parseFloat(c.o),
    high: parseFloat(c.h),
    low: parseFloat(c.l),
    close: parseFloat(c.c),
  };
}

async function fetchPredictMarkets(): Promise<Market[]> {
  type OutcomeEntry = {
    outcome: number;
    name: string;
    sideSpecs: { name: string }[];
  };
  type QuestionEntry = {
    name: string;
    namedOutcomes: number[];
    fallbackOutcome: number;
  };
  type AssetCtx = { markPx: string; dayNtlVlm: string; prevDayPx: string };

  const [meta, [spotMeta, spotCtxs]] = await Promise.all([
    postInfo<{ outcomes: OutcomeEntry[]; questions?: QuestionEntry[] }>({ type: "outcomeMeta" }),
    postInfo<[{ universe: { name: string }[] }, AssetCtx[]]>({ type: "spotMetaAndAssetCtxs" }),
  ]);

  const priceMap = new Map<string, AssetCtx>();
  spotMeta.universe.forEach((u, i) => priceMap.set(u.name, spotCtxs[i]));

  const outcomeById = new Map<number, OutcomeEntry>();
  for (const e of meta.outcomes) outcomeById.set(e.outcome, e);

  const claimedIds = new Set<number>();
  const markets: Market[] = [];

  // ── Grouped markets from questions[] ──────────────────────────────────
  for (const q of (meta.questions ?? [])) {
    const ids = [...q.namedOutcomes, q.fallbackOutcome].filter((id) => id != null);
    for (const id of ids) claimedIds.add(id);

    let totalVolume = 0;
    const options: OutcomeOption[] = ids.map((id) => {
      const entry = outcomeById.get(id);
      const coinId = `#${10 * id}`;
      const ctx = priceMap.get(coinId);
      const price = parseFloat(ctx?.markPx ?? "0") || 0;
      totalVolume += parseFloat(ctx?.dayNtlVlm ?? "0") || 0;
      return { name: entry?.name ?? String(id), coinId, price };
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

  // ── Standalone (unclaimed) outcomes ───────────────────────────────────
  for (const entry of meta.outcomes) {
    if (claimedIds.has(entry.outcome)) continue;

    const enc0 = 10 * entry.outcome;
    const enc1 = 10 * entry.outcome + 1;
    const ctx0 = priceMap.get(`#${enc0}`);
    const ctx1 = priceMap.get(`#${enc1}`);

    const price0 = parseFloat(ctx0?.markPx ?? "0") || 0;
    const price1Raw = parseFloat(ctx1?.markPx ?? "0") || 0;
    const price1 = price1Raw > 0 ? price1Raw : price0 > 0 ? 1 - price0 : 0;

    markets.push({
      question: entry.name,
      coinId: `#${enc0}`,
      testnet: true,
      volume: parseFloat(ctx0?.dayNtlVlm ?? "0") || 0,
      isBinary: true,
      options: [
        { name: entry.sideSpecs[0]?.name ?? "Yes", coinId: `#${enc0}`, price: price0 },
        { name: entry.sideSpecs[1]?.name ?? "No", coinId: `#${enc1}`, price: price1 },
      ],
    });
  }

  return markets.sort((a, b) => b.volume - a.volume);
}

export default function Page() {
  const [now, setNow] = useState(() => new Date());
  const [markets, setMarkets] = useState<Market[]>([]);
  const [selectedCoin, setSelectedCoin] = useState("");
  // Binary chart state
  const [candles, setCandles] = useState<CandlePoint[]>([]);
  const [liveCandle, setLiveCandle] = useState<CandlePoint | undefined>();
  const [ticks, setTicks] = useState<LivelinePoint[]>([]);
  const [latestTick, setLatestTick] = useState(0);
  const [lineMode, setLineMode] = useState(true);
  // Multi-outcome chart state
  const [multiSeries, setMultiSeries] = useState<LivelineSeries[]>([]);

  const [loading, setLoading] = useState(true);
  const [currentWindow, setCurrentWindow] = useState(86400);
  const [screenWidth, setScreenWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1600
  );

  const wsRef = useRef<WebSocket | null>(null);
  const selectedCoinRef = useRef("");
  const selectedApiCoinRef = useRef("");
  const liveCandleRef = useRef<CandlePoint | undefined>(undefined);
  const prevCandleTimeRef = useRef(0);

  // Clock
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Screen width
  useEffect(() => {
    const handler = () => setScreenWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  // Fetch markets on mount
  useEffect(() => {
    fetchPredictMarkets()
      .then((all) => {
        setMarkets(all);
        if (all.length > 0) setSelectedCoin(all[0].coinId);
      })
      .catch(() => setMarkets([]));
  }, []);

  // Fetch chart data when selection changes
  useEffect(() => {
    if (!selectedCoin) return;
    selectedCoinRef.current = selectedCoin;

    const market = markets.find((m) => m.coinId === selectedCoin);
    if (!market) return;

    setLoading(true);
    setCandles([]);
    setTicks([]);
    setLiveCandle(undefined);
    setMultiSeries([]);
    liveCandleRef.current = undefined;
    prevCandleTimeRef.current = 0;

    const endTime = Date.now();
    const startTime = endTime - 8 * 24 * 60 * 60 * 1000;

    if (market.isBinary) {
      const apiCoin = market.coinId;
      selectedApiCoinRef.current = apiCoin;

      postInfo<HLCandle[]>(
        { type: "candleSnapshot", req: { coin: apiCoin, interval: "1h", startTime, endTime } }
      ).then((data) => {
        if (!data?.length || selectedCoinRef.current !== selectedCoin) return;
        const pts = data.map(toCandle);
        const live = pts[pts.length - 1];
        setCandles(pts.slice(0, -1));
        setLiveCandle(live);
        liveCandleRef.current = live;
        prevCandleTimeRef.current = live.time;
        const tickPts = data.map((c) => ({
          time: Math.floor(c.t / 1000),
          value: parseFloat(c.c),
        }));
        setTicks(tickPts);
        setLatestTick(live.close);
        setLoading(false);
      });
    } else {
      // Fetch candles for all options in parallel
      Promise.all(
        market.options.map((opt) =>
          postInfo<HLCandle[]>(
            { type: "candleSnapshot", req: { coin: opt.coinId, interval: "1h", startTime, endTime } }
          ).then((data) => data ?? [])
        )
      ).then((allData) => {
        if (selectedCoinRef.current !== selectedCoin) return;
        const series: LivelineSeries[] = market.options.map((opt, i) => ({
          id: opt.coinId,
          label: opt.name,
          color: MULTI_COLORS[i % MULTI_COLORS.length],
          value: opt.price,
          data: allData[i].map((c) => ({
            time: Math.floor(c.t / 1000),
            value: parseFloat(c.c),
          })),
        }));
        setMultiSeries(series);
        setLoading(false);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCoin]);

  // WebSocket
  useEffect(() => {
    if (!selectedCoin) return;

    wsRef.current?.close();
    wsRef.current = null;

    const market = markets.find((m) => m.coinId === selectedCoin);
    const ws = new WebSocket(HL_TESTNET_WS);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } }));
      // Only subscribe to candle for binary markets
      if (market?.isBinary) {
        ws.send(JSON.stringify({
          method: "subscribe",
          subscription: { type: "candle", coin: market.coinId, interval: "1h" },
        }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);

        if (msg.channel === "allMids" && msg.data?.mids) {
          const mids = msg.data.mids as Record<string, string>;

          // Update market option prices
          setMarkets((prev) =>
            prev.map((m) => {
              const updatedOptions = m.options.map((opt) => {
                const raw = mids[opt.coinId];
                if (!raw) return opt;
                return { ...opt, price: parseFloat(raw) };
              });
              // For binary: if yes has price, infer no as complement
              if (m.isBinary && updatedOptions[0].price > 0 && !mids[updatedOptions[1].coinId]) {
                updatedOptions[1] = { ...updatedOptions[1], price: 1 - updatedOptions[0].price };
              }
              return { ...m, options: updatedOptions };
            })
          );

          // Update multi-series live values
          setMultiSeries((prev) =>
            prev.map((s) => {
              const raw = mids[s.id];
              return raw ? { ...s, value: parseFloat(raw) } : s;
            })
          );
        }

        if (msg.channel === "candle" && msg.data) {
          const c = msg.data as HLCandle & { s: string };
          if (c.s !== selectedApiCoinRef.current) return;

          const pt = toCandle(c);
          const nowTime = pt.time;

          if (prevCandleTimeRef.current > 0 && nowTime > prevCandleTimeRef.current) {
            const committed = liveCandleRef.current;
            if (committed) setCandles((prev) => [...prev, committed].slice(-500));
          }

          prevCandleTimeRef.current = nowTime;
          liveCandleRef.current = pt;
          setLiveCandle(pt);
          setLatestTick(pt.close);

          setTicks((prev) => {
            const tick: LivelinePoint = { time: nowTime, value: pt.close };
            if (prev.length > 0 && prev[prev.length - 1].time >= nowTime) {
              return [...prev.slice(0, -1), tick];
            }
            return [...prev.slice(-500), tick];
          });
        }
      } catch {
        // ignore
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCoin]);

  const selectedMarket = markets.find((m) => m.coinId === selectedCoin);
  const isNarrow = screenWidth < 1000;
  const sidebarWidth = isNarrow ? 180 : 300;
  const chartWidth = isNarrow ? "90%" : "75%";
  const chartHeight = isNarrow ? "75%" : "50%";

  const yesPrice = selectedMarket?.isBinary ? selectedMarket.options[0].price : 0;
  const accentColor = yesPrice < 0.5 ? "#dc2626" : "#16a34a";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        backgroundColor: "#ffffff",
        overflow: "hidden",
      }}
    >
      {/* Clock */}
      <div style={{ flexShrink: 0, padding: "16px 24px 0" }}>
        <div style={{ fontWeight: "normal", fontSize: "13px", letterSpacing: "0.04em", color: "#111" }}>
          {fmtDateTime(now)}
        </div>
      </div>

      <div style={{ height: 32, flexShrink: 0 }} />

      {/* Main body */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>

        {/* Sidebar */}
        <div
          style={{
            width: sidebarWidth,
            flexShrink: 0,
            padding: "8px 0 24px 24px",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ marginBottom: 10, paddingRight: 8 }}>
            <span style={{ fontWeight: "bold", fontSize: "13px", color: "#111" }}>Markets</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {markets.map((m) => {
              const isSelected = m.coinId === selectedCoin;
              return (
                <div
                  key={m.coinId}
                  onClick={() => setSelectedCoin(m.coinId)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    fontSize: "12px",
                    cursor: "pointer",
                    borderRadius: 4,
                    padding: "4px 8px 4px 0",
                    backgroundColor: "transparent",
                    transition: "background-color 0.1s",
                    gap: 6,
                    userSelect: "none",
                    fontWeight: isSelected ? 700 : 400,
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.backgroundColor = "#f9fafb";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent";
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "#111",
                    }}
                  >
                    {m.question}
                  </span>

                  {m.isBinary ? (
                    // Yes% / No% for binary
                    <>
                      <span style={{ color: "#16a34a", fontVariantNumeric: "tabular-nums", flexShrink: 0, fontSize: "11px" }}>
                        {fmtPct(m.options[0].price * 100)}
                      </span>
                      <span style={{ color: "#dc2626", fontVariantNumeric: "tabular-nums", flexShrink: 0, fontSize: "11px" }}>
                        {fmtPct(m.options[1].price * 100)}
                      </span>
                    </>
                  ) : (
                    // Colored dots + % for multi-outcome
                    <div style={{ display: "flex", gap: 3, flexShrink: 0, alignItems: "center" }}>
                      {m.options.map((opt, i) => (
                        <span
                          key={opt.coinId}
                          title={opt.name}
                          style={{
                            fontSize: "10px",
                            color: MULTI_COLORS[i % MULTI_COLORS.length],
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {Math.round(opt.price * 100)}%
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Chart area */}
        <div
          style={{
            flex: 1,
            padding: "8px 24px 24px 8px",
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          {selectedMarket && (
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 12,
                marginBottom: 4,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontWeight: "bold", fontSize: "13px", color: "#111" }}>
                {selectedMarket.question}
              </span>
              {selectedMarket.isBinary ? (
                <>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "#16a34a" }}>
                    {selectedMarket.options[0].name} {fmtPct(selectedMarket.options[0].price * 100)}
                  </span>
                  <span style={{ fontSize: "12px", fontWeight: 600, color: "#dc2626" }}>
                    {selectedMarket.options[1].name} {fmtPct(selectedMarket.options[1].price * 100)}
                  </span>
                </>
              ) : (
                selectedMarket.options.map((opt, i) => (
                  <span
                    key={opt.coinId}
                    style={{ fontSize: "12px", fontWeight: 600, color: MULTI_COLORS[i % MULTI_COLORS.length] }}
                  >
                    {opt.name} {fmtPct(opt.price * 100)}
                  </span>
                ))
              )}
            </div>
          )}

          <div style={{ height: chartHeight, width: chartWidth, minHeight: 0 }}>
            {selectedCoin && selectedMarket && (
              selectedMarket.isBinary ? (
                <Liveline
                  mode="candle"
                  candles={candles}
                  liveCandle={liveCandle}
                  candleWidth={3600}
                  data={ticks}
                  value={latestTick}
                  lineMode={lineMode}
                  lineData={ticks}
                  lineValue={latestTick}
                  onModeChange={(m) => setLineMode(m === "line")}
                  theme="light"
                  color={accentColor}
                  loading={loading}
                  grid
                  showValue
                  formatValue={fmtChartValue}
                  window={currentWindow}
                  onWindowChange={setCurrentWindow}
                  windows={[
                    { label: "1d", secs: 86400 },
                    { label: "3d", secs: 259200 },
                    { label: "7d", secs: 604800 },
                  ]}
                />
              ) : (
                <Liveline
                  data={[]}
                  value={0}
                  series={multiSeries}
                  theme="light"
                  loading={loading}
                  grid
                  showValue
                  formatValue={(v) => fmtPct(v * 100)}
                  window={currentWindow}
                  onWindowChange={setCurrentWindow}
                  windows={[
                    { label: "1d", secs: 86400 },
                    { label: "3d", secs: 259200 },
                    { label: "7d", secs: 604800 },
                  ]}
                />
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
