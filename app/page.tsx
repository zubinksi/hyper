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

interface Market {
  coin: string;
  coinId: string;
  dex?: string;
  marketType: "perp" | "spot" | "tradfi";
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

async function postInfo<T>(body: object): Promise<T> {
  const res = await fetch(HL_INFO, {
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

function fmtLarge(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
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

/** Parse a coinId like "xyz:SILVER" → { apiCoin: "SILVER", dex: "xyz" } */
function parseCoinId(coinId: string): { apiCoin: string; dex: string | undefined } {
  const m = /^([^@][^:]+):(.+)$/.exec(coinId);
  if (m) return { dex: m[1], apiCoin: m[2] };
  return { dex: undefined, apiCoin: coinId };
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
  const [screenWidth, setScreenWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1400
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

  // Screen width tracking
  useEffect(() => {
    const handler = () => setScreenWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  // Fetch top markets on mount (perps + spot combined)
  useEffect(() => {
    const perpsFetch = postInfo<
      [
        { universe: { name: string }[] },
        { markPx: string; dayNtlVlm: string; prevDayPx: string; openInterest?: string }[]
      ]
    >({ type: "metaAndAssetCtxs" }).then(([meta, ctxs]) =>
      meta.universe.map((asset, i): Market => {
        const ctx = ctxs[i];
        const price = parseFloat(ctx.markPx);
        const prev = parseFloat(ctx.prevDayPx);
        return {
          coin: asset.name,
          coinId: asset.name,
          marketType: "perp",
          price,
          prevDayPx: prev,
          change24h: prev ? ((price - prev) / prev) * 100 : 0,
          volume: parseFloat(ctx.dayNtlVlm),
          openInterest: ctx.openInterest ? parseFloat(ctx.openInterest) : undefined,
        };
      })
    );

    const spotFetch = postInfo<
      [
        { universe: { name: string; index: number }[]; tokens: { name: string }[] },
        { dayNtlVlm: string; prevDayPx: string | null; markPx: string | null; midPx: string | null }[]
      ]
    >({ type: "spotMetaAndAssetCtxs" }).then(([meta, ctxs]) =>
      meta.universe
        .map((asset, i): Market => {
          const ctx = ctxs[i];
          const price = parseFloat(ctx.markPx ?? ctx.midPx ?? "0");
          const prev = parseFloat(ctx.prevDayPx ?? "0");
          return {
            coin: asset.name,
            coinId: `@${asset.index}`,
            marketType: "spot",
            price,
            prevDayPx: prev,
            change24h: prev && price ? ((price - prev) / prev) * 100 : 0,
            volume: parseFloat(ctx.dayNtlVlm) || 0,
          };
        })
        .filter((m) => m.price > 0 && m.volume > 0)
    );

    const tradfiFetch = postInfo<
      [
        { universe: { name: string }[] },
        { markPx: string; dayNtlVlm: string; prevDayPx: string; openInterest?: string }[]
      ]
    >({ type: "metaAndAssetCtxs", dex: "xyz" }).then(([meta, ctxs]) =>
      meta.universe.map((asset, i): Market => {
        const ctx = ctxs[i];
        const price = parseFloat(ctx.markPx);
        const prev = parseFloat(ctx.prevDayPx);
        // asset.name already contains the "xyz:" prefix (e.g. "xyz:SILVER")
        return {
          coin: asset.name.replace(/^xyz:/, ""),
          coinId: asset.name,
          dex: "xyz",
          marketType: "tradfi",
          price: isNaN(price) ? 0 : price,
          prevDayPx: isNaN(prev) ? 0 : prev,
          change24h: prev && price ? ((price - prev) / prev) * 100 : 0,
          volume: parseFloat(ctx.dayNtlVlm) || 0,
          openInterest: ctx.openInterest ? parseFloat(ctx.openInterest) : undefined,
        };
      }).filter((m) => m.price > 0 && m.volume > 0)
    ).catch(() => [] as Market[]);

    Promise.all([perpsFetch, spotFetch, tradfiFetch]).then(([perps, spots, tradfi]) => {
      const all = [...perps, ...spots, ...tradfi]
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 10);
      setMarkets(all);
      if (all.length > 0) setSelectedCoin(all[0].coinId);
    });
  }, []);

  // Fetch candle history when selected coin changes
  useEffect(() => {
    if (!selectedCoin) return;
    selectedCoinRef.current = selectedCoin;

    const { apiCoin, dex } = parseCoinId(selectedCoin);
    selectedApiCoinRef.current = apiCoin;

    setLoading(true);
    setCandles([]);
    setTicks([]);
    setLiveCandle(undefined);
    liveCandleRef.current = undefined;
    prevCandleTimeRef.current = 0;

    const endTime = Date.now();
    const startTime = endTime - 2 * 60 * 60 * 1000; // 2 hours

    postInfo<HLCandle[]>({
      type: "candleSnapshot",
      req: {
        coin: apiCoin,
        interval: "1m",
        startTime,
        endTime,
        ...(dex ? { dex } : {}),
      },
    }).then((data) => {
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
  }, [selectedCoin]);

  // WebSocket — recreate when selected coin changes
  useEffect(() => {
    if (!selectedCoin) return;

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const { apiCoin, dex } = parseCoinId(selectedCoin);

    const ws = new WebSocket(HL_WS);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } })
      );
      ws.send(
        JSON.stringify({
          method: "subscribe",
          subscription: {
            type: "candle",
            coin: apiCoin,
            interval: "1m",
            ...(dex ? { dex } : {}),
          },
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);

        // Price updates for sidebar
        if (msg.channel === "allMids" && msg.data?.mids) {
          const mids = msg.data.mids as Record<string, string>;
          setMarkets((prev) =>
            prev.map((m) => {
              const raw = mids[m.coinId];
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

        // Live candle updates
        if (msg.channel === "candle" && msg.data) {
          const c = msg.data as HLCandle & { s: string };
          if (c.s !== selectedApiCoinRef.current) return;

          const pt = toCandle(c);
          const nowTime = pt.time;

          // New candle started — commit the previous live candle
          if (prevCandleTimeRef.current > 0 && nowTime > prevCandleTimeRef.current) {
            const committed = liveCandleRef.current;
            if (committed) {
              setCandles((prev) => [...prev, committed].slice(-300));
            }
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
            return [...prev.slice(-600), tick];
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
  }, [selectedCoin]);

  const selectedMarket = markets.find((m) => m.coinId === selectedCoin);
  const accentColor =
    selectedMarket && selectedMarket.change24h < 0 ? "#dc2626" : "#16a34a";

  // Responsive breakpoint: hide sidebar below 1100px
  const isNarrow = screenWidth < 1100;

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
      {/* Top-left datetime */}
      <div
        style={{
          padding: "16px 24px 8px",
          fontWeight: "normal",
          fontSize: "13px",
          letterSpacing: "0.04em",
          color: "#111",
          flexShrink: 0,
        }}
      >
        {fmtDateTime(now)}
      </div>
      <div style={{ height: 50, flexShrink: 0 }} />

      {/* Main body */}
      <div
        style={{
          display: "flex",
          flex: 1,
          overflow: "hidden",
          minHeight: 0,
        }}
      >
        {/* Sidebar — hidden on narrow screens */}
        {!isNarrow && (
          <div
            style={{
              width: 260,
              flexShrink: 0,
              padding: "8px 0 24px 24px",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                fontWeight: "bold",
                fontSize: "13px",
                marginBottom: 10,
                color: "#111",
              }}
            >
              Top Markets on Hyperliquid
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
                      fontSize: "13px",
                      cursor: "pointer",
                      borderRadius: 4,
                      padding: "4px 8px",
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
                        width: 100,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: "#111",
                        fontSize: "12px",
                      }}
                    >
                      {m.marketType === "perp" ? `${m.coin}-USD` : m.coin}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        textAlign: "right",
                        color: "#333",
                        fontVariantNumeric: "tabular-nums",
                        fontSize: "12px",
                      }}
                    >
                      {fmtSidebarPrice(m.price)}
                    </span>
                    <span
                      style={{
                        width: 44,
                        textAlign: "right",
                        color: m.change24h >= 0 ? "#16a34a" : "#dc2626",
                        fontVariantNumeric: "tabular-nums",
                        fontSize: "12px",
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
        )}

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
                {selectedMarket.marketType === "perp"
                  ? `${selectedMarket.coin}-USD`
                  : selectedMarket.coin}
              </span>
              <span style={{ fontSize: "12px", color: "#555" }}>
                <span style={{ color: "#888", marginRight: 3 }}>Vol</span>
                {fmtLarge(selectedMarket.volume)}
              </span>
              {selectedMarket.openInterest != null && (
                <span style={{ fontSize: "12px", color: "#555" }}>
                  <span style={{ color: "#888", marginRight: 3 }}>OI</span>
                  {fmtLarge(selectedMarket.openInterest)}
                </span>
              )}
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

          <div
            style={{
              height: isNarrow ? "75%" : "50%",
              width: isNarrow ? "80%" : "75%",
              minHeight: 0,
            }}
          >
            {selectedCoin && (
              <Liveline
                mode="candle"
                candles={candles}
                liveCandle={liveCandle}
                candleWidth={60}
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
                window={3600}
                windows={[
                  { label: "5m", secs: 300 },
                  { label: "1h", secs: 3600 },
                  { label: "1d", secs: 86400 },
                ]}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
