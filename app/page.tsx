"use client";

import { useState, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Stepper, useAutoPlay } from "pasito";
import "pasito/styles.css";
import type { LivelinePoint, LivelineSeries } from "liveline";
import {
  fetchPredictMarkets,
  postInfo,
  fmtChartValue,
  fmtPct,
  fmtVolume,
  MULTI_COLORS,
  HL_TESTNET_WS,
} from "./lib/markets";
import type { Market, HLCandle, OutcomeOption } from "./lib/markets";

const Liveline = dynamic(
  () => import("liveline").then((m) => ({ default: m.Liveline })),
  { ssr: false }
);

const WINDOWS = [
  { label: "1d", secs: 86400 },
  { label: "3d", secs: 259200 },
  { label: "7d", secs: 604800 },
];

function OutcomeDots({ options, isBinary }: { options: OutcomeOption[]; isBinary: boolean }) {
  const colors = isBinary ? ["#16a34a", "#dc2626"] : MULTI_COLORS;
  return (
    <>
      {options.map((opt, i) => (
        <span
          key={opt.coinId}
          style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              backgroundColor: colors[i % colors.length],
              display: "inline-block",
              flexShrink: 0,
            }}
          />
          <span style={{ color: "#6b7280", fontSize: "12px" }}>
            {opt.name} {fmtPct(opt.price * 100)}
          </span>
        </span>
      ))}
    </>
  );
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

export default function Page() {
  const [now, setNow] = useState(() => new Date());
  const [markets, setMarkets] = useState<Market[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [selectedCoin, setSelectedCoin] = useState("");
  const [ticks, setTicks] = useState<LivelinePoint[]>([]);
  const [latestTick, setLatestTick] = useState(0);
  const [multiSeries, setMultiSeries] = useState<LivelineSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentWindow, setCurrentWindow] = useState(86400);

  const wsRef = useRef<WebSocket | null>(null);
  const selectedCoinRef = useRef("");
  const selectedApiCoinRef = useRef("");
  const prevCandleTimeRef = useRef(0);
  const latestTickRef = useRef(0);

  const topMarkets = markets.slice(0, 6);

  // Sync selectedCoin whenever activeIdx changes
  useEffect(() => {
    const coin = markets[activeIdx]?.coinId;
    if (coin) setSelectedCoin(coin);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, markets.length]);

  const { filling, fillDuration, toggle } = useAutoPlay({
    count: topMarkets.length || 1,
    active: activeIdx,
    onStepChange: setActiveIdx,
    stepDuration: 5000,
    loop: true,
  });

  const autoplayStartedRef = useRef(false);
  useEffect(() => {
    if (topMarkets.length > 0 && !autoplayStartedRef.current) {
      autoplayStartedRef.current = true;
      toggle();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topMarkets.length]);

  // Clock
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Fetch markets
  useEffect(() => {
    fetchPredictMarkets()
      .then(({ markets: all }) => {
        setMarkets(all);
        if (all.length > 0) {
          setSelectedCoin(all[0].coinId);
          setActiveIdx(0);
        }
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
    setTicks([]);
    setMultiSeries([]);
    prevCandleTimeRef.current = 0;
    latestTickRef.current = 0;

    const endTime   = Date.now();
    const startTime = endTime - 8 * 24 * 60 * 60 * 1000;

    if (market.isBinary) {
      const apiCoin = market.coinId;
      selectedApiCoinRef.current = apiCoin;

      postInfo<HLCandle[]>(
        { type: "candleSnapshot", req: { coin: apiCoin, interval: "1h", startTime, endTime } }
      ).then((data) => {
        if (!data?.length || selectedCoinRef.current !== selectedCoin) return;
        const tickPts = data.map((c) => ({
          time:  Math.floor(c.t / 1000),
          value: parseFloat(c.c),
        }));
        const last = tickPts[tickPts.length - 1];
        setTicks(tickPts);
        setLatestTick(last.value);
        latestTickRef.current     = last.value;
        prevCandleTimeRef.current = last.time;
        setLoading(false);
      });
    } else {
      Promise.all(
        market.options.map((opt) =>
          postInfo<HLCandle[]>(
            { type: "candleSnapshot", req: { coin: opt.coinId, interval: "1h", startTime, endTime } }
          ).then((data) => data ?? [])
        )
      ).then((allData) => {
        if (selectedCoinRef.current !== selectedCoin) return;
        const series: LivelineSeries[] = market.options.map((opt, i) => ({
          id:    opt.coinId,
          label: opt.name,
          color: MULTI_COLORS[i % MULTI_COLORS.length],
          value: opt.price,
          data:  allData[i].map((c) => ({
            time:  Math.floor(c.t / 1000),
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

          setMarkets((prev) =>
            prev.map((m) => {
              const updatedOptions = m.options.map((opt) => {
                const raw = mids[opt.coinId];
                if (!raw) return opt;
                return { ...opt, price: parseFloat(raw) };
              });
              if (m.isBinary && updatedOptions[0].price > 0 && !mids[updatedOptions[1].coinId]) {
                updatedOptions[1] = { ...updatedOptions[1], price: 1 - updatedOptions[0].price };
              }
              return { ...m, options: updatedOptions };
            })
          );

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

          const nowTime  = Math.floor(c.t / 1000);
          const closeVal = parseFloat(c.c);

          setLatestTick(closeVal);
          latestTickRef.current = closeVal;

          setTicks((prev) => {
            const tick: LivelinePoint = { time: nowTime, value: closeVal };
            if (prev.length > 0 && prev[prev.length - 1].time >= nowTime) {
              return [...prev.slice(0, -1), tick];
            }
            if (prevCandleTimeRef.current > 0 && nowTime > prevCandleTimeRef.current) {
              prevCandleTimeRef.current = nowTime;
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
  const yesPrice    = selectedMarket?.isBinary ? selectedMarket.options[0].price : 0;
  const accentColor = yesPrice < 0.5 ? "#dc2626" : "#16a34a";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
        backgroundColor: "#ffffff",
        boxSizing: "border-box",
        padding: "12px",
      }}
    >
      {/* Clock */}
      <div style={{ flexShrink: 0, marginBottom: 10 }}>
        <div style={{ fontWeight: "normal", fontSize: "13px", letterSpacing: "0.04em", color: "#111" }}>
          {fmtDateTime(now)}
        </div>
      </div>

      {/* Width-constrained column */}
      <div className="chart-card" style={{ display: "flex", flexDirection: "column" }}>

        {/* Bordered chart card */}
        <div
          style={{
            boxSizing: "border-box",
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Market header — clickable title */}
          {selectedMarket && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                flexShrink: 0,
                padding: "14px 16px 10px",
              }}
            >
              <Link
                href={`/market/${selectedMarket.coinId.slice(1)}`}
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <span
                  style={{
                    fontWeight: "bold",
                    fontSize: "15.6px",
                    color: "#111",
                    cursor: "pointer",
                  }}
                >
                  {selectedMarket.question}
                </span>
              </Link>
              <OutcomeDots options={selectedMarket.options} isBinary={selectedMarket.isBinary} />
            </div>
          )}

          {/* Chart */}
          <div className="chart-area" style={{ width: "100%" }}>
            {selectedCoin && selectedMarket && (
              selectedMarket.isBinary ? (
                <Liveline
                  data={ticks}
                  value={latestTick}
                  theme="light"
                  color={accentColor}
                  loading={loading}
                  grid
                  showValue
                  formatValue={fmtChartValue}
                  window={currentWindow}
                />
              ) : (
                <div className="ll-multi" style={{ width: "100%", height: "100%" }}>
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
                  />
                </div>
              )
            )}
          </div>
        </div>

        {/* Vol / time-windows row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 0",
          }}
        >
          <span style={{ fontSize: "11px", color: "#9ca3af" }}>
            Vol {selectedMarket ? fmtVolume(selectedMarket.volume) : "—"}
          </span>
          <div style={{ display: "flex", gap: 2 }}>
            {WINDOWS.map((w) => (
              <button
                key={w.secs}
                onClick={() => setCurrentWindow(w.secs)}
                style={{
                  fontSize: "11px",
                  padding: "2px 7px",
                  borderRadius: 4,
                  border: "none",
                  cursor: "pointer",
                  fontFamily: "system-ui, -apple-system, sans-serif",
                  backgroundColor: currentWindow === w.secs ? "rgba(0,0,0,0.08)" : "transparent",
                  color: currentWindow === w.secs ? "#111" : "#6b7280",
                  fontWeight: currentWindow === w.secs ? 600 : 400,
                }}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>

        {/* Pasito stepper */}
        {topMarkets.length > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-start", paddingBottom: 4 }}>
            <Stepper
              count={topMarkets.length}
              active={activeIdx}
              onStepClick={setActiveIdx}
              filling={filling}
              fillDuration={fillDuration}
              className="pasito-theme"
            />
          </div>
        )}
      </div>

      {/* Markets list */}
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 0 }}>
        {markets.map((m, i) => (
          <div
            key={m.coinId}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 4px",
              borderTop: i === 0 ? "none" : "1px solid #f3f4f6",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            {/* Name + outcomes */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", flex: 1, minWidth: 0 }}>
              <Link
                href={`/market/${m.coinId.slice(1)}`}
                style={{ textDecoration: "none", color: "inherit", flexShrink: 0 }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    fontSize: "13px",
                    color: "#111",
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                >
                  {m.question}
                </span>
              </Link>
              <OutcomeDots options={m.options} isBinary={m.isBinary} />
            </div>
            {/* Volume */}
            <span style={{ fontSize: "11px", color: "#9ca3af", flexShrink: 0 }}>
              {fmtVolume(m.volume)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
