"use client";

import { useState, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import type { CandlePoint, LivelinePoint } from "liveline";

const Liveline = dynamic(
  () => import("liveline").then((m) => ({ default: m.Liveline })),
  { ssr: false }
);

const HL_INFO = "https://api.hyperliquid.xyz/info";
const HL_WS = "wss://api.hyperliquid.xyz/ws";
const HL_TESTNET_INFO = "https://api.hyperliquid-testnet.xyz/info";
const HL_TESTNET_WS = "wss://api.hyperliquid-testnet.xyz/ws";

interface Market {
  coin: string;
  coinId: string;
  apiCoin: string;
  testnet: boolean;
  price: number;
  prevDayPx: number;
  change24h: number;
  volume: number;
  yesPct: number;
  noPct: number;
}

interface HLCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
}

async function postInfo<T>(body: object, url = HL_INFO): Promise<T> {
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

/** One row per outcome, collapsed Yes+No sides */
async function fetchPredictMarkets(): Promise<Market[]> {
  type OutcomeEntry = {
    outcome: number;
    name: string;
    description: string;
    sideSpecs: { name: string }[];
  };
  type AssetCtx = { markPx: string; dayNtlVlm: string; prevDayPx: string };

  const [metaResult, spotResult] = await Promise.all([
    postInfo<{ outcomes: OutcomeEntry[] }>({ type: "outcomeMeta" }, HL_TESTNET_INFO),
    postInfo<[{ universe: { name: string }[] }, AssetCtx[]]>(
      { type: "spotMetaAndAssetCtxs" }, HL_TESTNET_INFO
    ),
  ]);

  const [spotMeta, spotCtxs] = spotResult;
  const priceMap = new Map<string, AssetCtx>();
  spotMeta.universe.forEach((u, i) => priceMap.set(u.name, spotCtxs[i]));

  return metaResult.outcomes.map((entry) => {
    const yesEncoding = 10 * entry.outcome + 0;
    const noEncoding = 10 * entry.outcome + 1;
    const yesCoin = `#${yesEncoding}`;
    const noCoin = `#${noEncoding}`;
    const yesCtx = priceMap.get(yesCoin);
    const noCtx = priceMap.get(noCoin);

    const yesPrice = parseFloat(yesCtx?.markPx ?? "0") || 0;
    const noPrice = parseFloat(noCtx?.markPx ?? "0") || 0;
    const yesPrev = parseFloat(yesCtx?.prevDayPx ?? "0") || 0;

    return {
      coin: entry.name,
      coinId: yesCoin,
      apiCoin: yesCoin,
      testnet: true,
      price: yesPrice,
      prevDayPx: yesPrev,
      change24h: yesPrev && yesPrice ? ((yesPrice - yesPrev) / yesPrev) * 100 : 0,
      volume: parseFloat(yesCtx?.dayNtlVlm ?? "0") || 0,
      yesPct: yesPrice * 100,
      noPct: noPrice * 100,
    };
  }).sort((a, b) => b.volume - a.volume);
}

export default function Page() {
  const [now, setNow] = useState(() => new Date());
  const [markets, setMarkets] = useState<Market[]>([]);
  const [selectedCoin, setSelectedCoin] = useState("");
  const [candles, setCandles] = useState<CandlePoint[]>([]);
  const [liveCandle, setLiveCandle] = useState<CandlePoint | undefined>();
  const [ticks, setTicks] = useState<LivelinePoint[]>([]);
  const [latestTick, setLatestTick] = useState(0);
  const [lineMode, setLineMode] = useState(true);
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
  const selectedTestnetRef = useRef(true);

  // Clock
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Screen width tracking
  useEffect(() => {
    const handler = () => setScreenWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  // Fetch predict markets on mount
  useEffect(() => {
    fetchPredictMarkets()
      .then((all) => {
        setMarkets(all);
        if (all.length > 0) {
          selectedTestnetRef.current = all[0].testnet;
          setSelectedCoin(all[0].coinId);
        }
      })
      .catch(() => setMarkets([]));
  }, []);

  // Fetch candle history when selected coin changes
  useEffect(() => {
    if (!selectedCoin) return;
    selectedCoinRef.current = selectedCoin;

    const isTestnet = selectedTestnetRef.current;
    const market = markets.find((m) => m.coinId === selectedCoin);
    const apiCoin = market?.apiCoin ?? selectedCoin;
    selectedApiCoinRef.current = apiCoin;

    setLoading(true);
    setCandles([]);
    setTicks([]);
    setLiveCandle(undefined);
    liveCandleRef.current = undefined;
    prevCandleTimeRef.current = 0;

    const endTime = Date.now();
    const startTime = endTime - 8 * 24 * 60 * 60 * 1000;

    postInfo<HLCandle[]>(
      { type: "candleSnapshot", req: { coin: apiCoin, interval: "1h", startTime, endTime } },
      isTestnet ? HL_TESTNET_INFO : HL_INFO
    ).then((data) => {
      if (!data?.length || selectedCoinRef.current !== selectedCoin) return;
      const pts = data.map(toCandle);
      const live = pts[pts.length - 1];
      setCandles(pts.slice(0, -1));
      setLiveCandle(live);
      liveCandleRef.current = live;
      prevCandleTimeRef.current = live.time;
      const tickPts: LivelinePoint[] = data.map((c) => ({
        time: Math.floor(c.t / 1000),
        value: parseFloat(c.c),
      }));
      setTicks(tickPts);
      setLatestTick(live.close);
      setLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCoin]);

  // WebSocket — recreate when selected coin changes
  useEffect(() => {
    if (!selectedCoin) return;

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const isTestnet = selectedTestnetRef.current;
    const market = markets.find((m) => m.coinId === selectedCoin);
    const apiCoin = market?.apiCoin ?? selectedCoin;
    const wsUrl = isTestnet ? HL_TESTNET_WS : HL_WS;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } }));
      ws.send(JSON.stringify({
        method: "subscribe",
        subscription: { type: "candle", coin: apiCoin, interval: "1h" },
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);

        if (msg.channel === "allMids" && msg.data?.mids) {
          const mids = msg.data.mids as Record<string, string>;
          setMarkets((prev) =>
            prev.map((m) => {
              const raw = mids[m.apiCoin];
              if (!raw) return m;
              const newPrice = parseFloat(raw);
              return {
                ...m,
                price: newPrice,
                yesPct: newPrice * 100,
                change24h: m.prevDayPx
                  ? ((newPrice - m.prevDayPx) / m.prevDayPx) * 100
                  : m.change24h,
              };
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
        // ignore parse errors
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCoin]);

  const selectedMarket = markets.find((m) => m.coinId === selectedCoin);
  const accentColor = selectedMarket && selectedMarket.change24h < 0 ? "#dc2626" : "#16a34a";
  const isNarrow = screenWidth < 1000;
  const sidebarWidth = isNarrow ? 160 : 280;
  const chartWidth = isNarrow ? "90%" : "75%";
  const chartHeight = isNarrow ? "75%" : "50%";

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
                  onClick={() => {
                    selectedTestnetRef.current = m.testnet;
                    setSelectedCoin(m.coinId);
                  }}
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
                    {m.coin}
                  </span>
                  <span
                    style={{
                      color: "#16a34a",
                      fontVariantNumeric: "tabular-nums",
                      flexShrink: 0,
                      fontSize: "11px",
                    }}
                  >
                    {m.yesPct.toFixed(0)}%
                  </span>
                  <span
                    style={{
                      color: "#dc2626",
                      fontVariantNumeric: "tabular-nums",
                      flexShrink: 0,
                      fontSize: "11px",
                    }}
                  >
                    {m.noPct.toFixed(0)}%
                  </span>
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
          {selectedCoin && selectedMarket && (
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 16,
                marginBottom: 4,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontWeight: "bold", fontSize: "13px", color: "#111" }}>
                {selectedMarket.coin}
              </span>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "#16a34a" }}>
                Yes {selectedMarket.yesPct.toFixed(1)}%
              </span>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "#dc2626" }}>
                No {selectedMarket.noPct.toFixed(1)}%
              </span>
            </div>
          )}

          <div style={{ height: chartHeight, width: chartWidth, minHeight: 0 }}>
            {selectedCoin && (
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
