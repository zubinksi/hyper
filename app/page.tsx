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

type MarketSource = "xyz" | "predict";

interface Market {
  coin: string;
  coinId: string;
  apiCoin: string;   // coin name used in API calls (may differ from coinId)
  testnet: boolean;
  marketType: "tradfi" | "predict";
  price: number;
  prevDayPx: number;
  change24h: number;
  volume: number;
  openInterest?: number;
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

function fmtSidebarPrice(p: number): string {
  if (p >= 1000) return Math.round(p).toLocaleString("en-US");
  if (p >= 1) return p.toFixed(2);
  return p.toFixed(5);
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

function getTimeInZone(date: Date, tz: string): { h: number; m: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const rawH = get("hour");
  const h = rawH === "24" ? 0 : parseInt(rawH);
  const m = parseInt(get("minute"));
  const DAY_IDX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { h, m, day: DAY_IDX[get("weekday")] ?? -1 };
}

function tradfiMarketStatus(date: Date): { us: string; europe: string; asia: string } {
  const et = getTimeInZone(date, "America/New_York");
  const etMins = et.h * 60 + et.m;
  const usWkd = et.day >= 1 && et.day <= 5;
  const us = !usWkd ? "Closed"
    : etMins >= 240 && etMins < 570 ? "Pre Market"
    : etMins >= 570 && etMins < 960 ? "Open"
    : "Closed";

  const lon = getTimeInZone(date, "Europe/London");
  const lonMins = lon.h * 60 + lon.m;
  const euWkd = lon.day >= 1 && lon.day <= 5;
  const europe = !euWkd ? "Closed"
    : lonMins >= 480 && lonMins < 1050 ? "Open"
    : "Closed";

  const tky = getTimeInZone(date, "Asia/Tokyo");
  const tkyMins = tky.h * 60 + tky.m;
  const asiaWkd = tky.day >= 1 && tky.day <= 5;
  const asia = !asiaWkd ? "Closed"
    : (tkyMins >= 540 && tkyMins < 690) || (tkyMins >= 750 && tkyMins < 930) ? "Open"
    : "Closed";

  return { us, europe, asia };
}

/** Build xyz (tradfi) markets from mainnet */
async function fetchXyzMarkets(): Promise<Market[]> {
  const [meta, ctxs] = await postInfo<[
    { universe: { name: string }[] },
    { markPx: string; dayNtlVlm: string; prevDayPx: string; openInterest?: string }[]
  ]>({ type: "metaAndAssetCtxs", dex: "xyz" });

  return meta.universe
    .map((asset, i): Market => {
      const ctx = ctxs[i];
      const price = parseFloat(ctx.markPx);
      const prev = parseFloat(ctx.prevDayPx);
      // asset.name already contains "xyz:" prefix
      const apiCoin = asset.name; // full name is the canonical API identifier
      return {
        coin: asset.name.replace(/^xyz:/, ""),
        coinId: asset.name,
        apiCoin,
        testnet: false,
        marketType: "tradfi",
        price: isNaN(price) ? 0 : price,
        prevDayPx: isNaN(prev) ? 0 : prev,
        change24h: prev && price ? ((price - prev) / prev) * 100 : 0,
        volume: parseFloat(ctx.dayNtlVlm) || 0,
        openInterest: ctx.openInterest ? parseFloat(ctx.openInterest) : undefined,
      };
    })
    .filter((m) => m.price > 0 && m.volume > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 15);
}

/** Build predict (outcome) markets from testnet — HIP-4 markets are spot tokens with marketType === "outcome" */
async function fetchPredictMarkets(): Promise<Market[]> {
  // Outcome markets are spot-based (HIP-4); they appear in spotMetaAndAssetCtxs
  const [meta, ctxs] = await postInfo<[
    { universe: { name: string; marketType?: string }[]; tokens: unknown[] },
    { markPx: string; dayNtlVlm: string; prevDayPx: string }[]
  ]>({ type: "spotMetaAndAssetCtxs" }, HL_TESTNET_INFO);

  console.log("[predict] spotMetaAndAssetCtxs universe sample:", meta.universe.slice(0, 5));
  const outcomeMarkets = meta.universe.filter((a) => a.marketType === "outcome");
  console.log("[predict] outcome markets found:", outcomeMarkets.length, outcomeMarkets.slice(0, 3));

  return meta.universe
    .map((asset, i) => ({ asset, ctx: ctxs[i] }))
    .filter(({ asset }) => asset.marketType === "outcome")
    .map(({ asset, ctx }): Market => {
      const price = parseFloat(ctx.markPx);
      const prev = parseFloat(ctx.prevDayPx);
      const cleanName = asset.name.replace(/^predict:/, "");
      return {
        coin: cleanName,
        coinId: `predict:${cleanName}`,
        apiCoin: cleanName, // testnet candle API takes the bare name
        testnet: true,
        marketType: "predict",
        price: isNaN(price) ? 0 : price,
        prevDayPx: isNaN(prev) ? 0 : prev,
        change24h: prev && price ? ((price - prev) / prev) * 100 : 0,
        volume: parseFloat(ctx.dayNtlVlm) || 0,
      };
    })
    .filter((m) => m.price > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 15);
}

export default function Page() {
  const [now, setNow] = useState(() => new Date());
  const [source, setSource] = useState<MarketSource>("xyz");
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
  const selectedApiCoinRef = useRef(""); // bare coin name for WS message matching
  const liveCandleRef = useRef<CandlePoint | undefined>(undefined);
  const prevCandleTimeRef = useRef(0);
  // Track testnet flag alongside selectedCoin changes (updated synchronously)
  const selectedTestnetRef = useRef(false);

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

  // Fetch markets when source changes
  useEffect(() => {
    setMarkets([]);
    setSelectedCoin("");

    const load = source === "xyz" ? fetchXyzMarkets() : fetchPredictMarkets();
    load
      .then((all) => {
        setMarkets(all);
        if (all.length > 0) {
          selectedTestnetRef.current = all[0].testnet;
          setSelectedCoin(all[0].coinId);
        }
      })
      .catch(() => setMarkets([]));
  }, [source]);

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
  const sidebarWidth = isNarrow ? 130 : 260;
  const chartWidth = isNarrow ? "90%" : "75%";
  const chartHeight = isNarrow ? "75%" : "50%";

  const { us, europe, asia } = tradfiMarketStatus(now);
  const statusColor = (s: string) =>
    s === "Open" ? "#16a34a" : s === "Pre Market" ? "#d97706" : "#aaa";

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
      {/* Clock + market status */}
      <div style={{ flexShrink: 0, padding: "16px 24px 0" }}>
        <div style={{ fontWeight: "normal", fontSize: "13px", letterSpacing: "0.04em", color: "#111" }}>
          {fmtDateTime(now)}
        </div>
        <div style={{ display: "flex", gap: 20, marginTop: 6, fontSize: "11px" }}>
          {([
            { label: "US", status: us },
            { label: "Europe", status: europe },
            { label: "Asia", status: asia },
          ] as const).map(({ label, status }) => (
            <span key={label}>
              <span style={{ color: "#aaa" }}>{label}</span>{" "}
              <span style={{ color: statusColor(status) }}>{status}</span>
            </span>
          ))}
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
          {/* Title + source toggle */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
              paddingRight: 8,
            }}
          >
            <span style={{ fontWeight: "bold", fontSize: "13px", color: "#111" }}>Markets</span>
            <div style={{ display: "flex", gap: 2 }}>
              {(["xyz", "predict"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSource(s)}
                  style={{
                    padding: "2px 6px",
                    borderRadius: 3,
                    border: "none",
                    background: source === s ? "#111" : "transparent",
                    color: source === s ? "#fff" : "#aaa",
                    cursor: "pointer",
                    fontSize: "10px",
                    fontWeight: source === s ? 600 : 400,
                    letterSpacing: "0.02em",
                  }}
                >
                  {s === "predict" ? "Predict" : "xyz"}
                </button>
              ))}
            </div>
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
                    gap: 4,
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

                  {!isNarrow && (
                    <span style={{ color: "#333", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                      {fmtSidebarPrice(m.price)}
                    </span>
                  )}

                  <span
                    style={{
                      width: 38,
                      textAlign: "right",
                      color: m.change24h >= 0 ? "#16a34a" : "#dc2626",
                      fontVariantNumeric: "tabular-nums",
                      flexShrink: 0,
                    }}
                  >
                    {m.change24h >= 0 ? "+" : ""}
                    {m.change24h.toFixed(0)}%
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
              <span
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  color: selectedMarket.change24h >= 0 ? "#16a34a" : "#dc2626",
                }}
              >
                {selectedMarket.change24h >= 0 ? "+" : ""}
                {selectedMarket.change24h.toFixed(2)}%
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
