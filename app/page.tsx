"use client";

import { useState, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Stepper, useAutoPlay } from "pasito";
import "pasito/styles.css";
import type { LivelinePoint, LivelineSeries, OrderbookData } from "liveline";
import {
  fetchPredictMarkets,
  postInfo,
  fmtChartValue,
  fmtPct,
  fmtVolume,
  fmtTime,
  MULTI_COLORS,
  HL_TESTNET_WS,
} from "./lib/markets";
import type { Market, HLCandle, OutcomeOption } from "./lib/markets";
import BrailleIcon, { getBrailleType } from "./components/BrailleIcon";
import PositionsModal from "./components/PositionsModal";

const Liveline = dynamic(
  () => import("liveline").then((m) => ({ default: m.Liveline })),
  { ssr: false }
);

const WINDOWS_STANDARD  = [
  { label: "1d", secs: 86400 },
  { label: "3d", secs: 259200 },
  { label: "7d", secs: 604800 },
];
const WINDOWS_RECURRING = [
  { label: "1h",  secs: 3600 },
  { label: "6h",  secs: 21600 },
  { label: "1d",  secs: 86400 },
];

function OutcomeDots({ options, isBinary }: { options: OutcomeOption[]; isBinary: boolean }) {
  const isYesNo = isBinary && options[0]?.name.toLowerCase() === "yes";
  const colors = isYesNo ? ["#629F82", "#F48484"] : MULTI_COLORS;
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
              borderRadius: "2px",
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


export default function Page() {
  const router = useRouter();
  const [now, setNow] = useState(() => new Date());
  const [markets, setMarkets] = useState<Market[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [selectedCoin, setSelectedCoin] = useState("");
  const [ticks, setTicks] = useState<LivelinePoint[]>([]);
  const [latestTick, setLatestTick] = useState(0);
  const [multiSeries, setMultiSeries] = useState<LivelineSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentWindow, setCurrentWindow] = useState(86400);
  const [orderbookData, setOrderbookData] = useState<OrderbookData | undefined>(undefined);

  const wsRef = useRef<WebSocket | null>(null);
  const selectedCoinRef = useRef("");
  const selectedApiCoinRef = useRef("");
  const prevCandleTimeRef = useRef(0);
  const latestTickRef = useRef(0);
  const orderbookIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

    const isYesNoBinary = market.isBinary && market.options[0]?.name.toLowerCase() === "yes";

    if (isYesNoBinary) {
      const apiCoin = market.coinId;
      selectedApiCoinRef.current = apiCoin;

      postInfo<HLCandle[]>(
        { type: "candleSnapshot", req: { coin: apiCoin, interval: "1h", startTime, endTime } }
      ).then((data) => {
        if (!Array.isArray(data) || !data.length || selectedCoinRef.current !== selectedCoin) return;
        const tickPts = data
          .map((c) => ({ time: Math.floor(c.t / 1000), value: parseFloat(c.c) }))
          .filter((p) => isFinite(p.value))
          .slice(-500);
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

  // Reset time window and poll orderbook when selected market changes
  useEffect(() => {
    // Clear any existing orderbook poll
    if (orderbookIntervalRef.current) {
      clearInterval(orderbookIntervalRef.current);
      orderbookIntervalRef.current = null;
    }
    setOrderbookData(undefined);

    const market = markets.find((m) => m.coinId === selectedCoin);
    if (!market) return;

    // Reset window to the appropriate default
    const wins = market.isRecurring ? WINDOWS_RECURRING : WINDOWS_STANDARD;
    setCurrentWindow(wins[1].secs); // default to middle option

    // Poll orderbook for yes/no binary recurring markets
    if (!market.isRecurring || market.options[0]?.name.toLowerCase() !== "yes") return;
    const coin = market.coinId;

    async function fetchBook() {
      try {
        const res = await postInfo<{ levels: Array<Array<{ px: string; sz: string }>> }>({
          type: "l2Book",
          coin,
        });
        const bids: [number, number][] = (res.levels?.[0] ?? []).map((l) => [parseFloat(l.px), parseFloat(l.sz)]);
        const asks: [number, number][] = (res.levels?.[1] ?? []).map((l) => [parseFloat(l.px), parseFloat(l.sz)]);
        setOrderbookData({ bids, asks });
      } catch { /* ignore */ }
    }

    fetchBook();
    orderbookIntervalRef.current = setInterval(fetchBook, 3000);
    return () => {
      if (orderbookIntervalRef.current) clearInterval(orderbookIntervalRef.current);
    };
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
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);

        if (msg.channel === "allMids" && msg.data?.mids) {
          const mids = msg.data.mids as Record<string, string>;

          // Update latestTick for the currently displayed binary chart
          const raw = mids[selectedCoinRef.current];
          if (raw) {
            const val = parseFloat(raw);
            if (isFinite(val)) {
              setLatestTick(val);
              latestTickRef.current = val;
            }
          }

          setMarkets((prev) =>
            prev.map((m) => {
              const updatedOptions = m.options.map((opt) => {
                const r = mids[opt.coinId];
                if (!r) return opt;
                return { ...opt, price: parseFloat(r) };
              });
              if (m.isBinary && updatedOptions[0].price > 0 && !mids[updatedOptions[1].coinId]) {
                updatedOptions[1] = { ...updatedOptions[1], price: 1 - updatedOptions[0].price };
              }
              return { ...m, options: updatedOptions };
            })
          );

          setMultiSeries((prev) =>
            prev.map((s) => {
              const r = mids[s.id];
              return r ? { ...s, value: parseFloat(r) } : s;
            })
          );
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
  const accentColor = yesPrice < 0.5 ? "#F48484" : "#629F82";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
        backgroundColor: "#F0E9D7",
        boxSizing: "border-box",
      }}
    >
      {/* Header */}
      <header
        className="page-content"
        style={{
          borderBottom: "12px solid #0E184D",
          paddingTop: 10,
          paddingBottom: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
          gap: 10,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 18, color: "#0E184D", letterSpacing: "-0.01em" }}>
          ODDS + ENDS
        </span>
        <PositionsModal />
      </header>

      {/* Content */}
      <div className="page-content" style={{ padding: "12px 24px", flex: 1 }}>

      {/* Hero section — two columns on desktop */}
      <div className="hero-section">

        {/* Left hero copy — desktop only */}
        <div className="hero-left">
          <span style={{ fontWeight: 800, fontSize: "2rem", color: "#0E184D", lineHeight: 1.1, display: "block" }}>
            Outcome Markets
          </span>
          <span style={{ fontWeight: 400, fontSize: "1rem", color: "#0E184D", opacity: 0.55, display: "block", marginTop: 8 }}>
            Built on Hyperliquid
          </span>
        </div>

        {/* Right column: chart card */}
        {/* Width-constrained column */}
        <div className="chart-card" style={{ display: "flex", flexDirection: "column" }}>

        {/* Bordered chart card — entire card is clickable */}
        <div
          onClick={() => selectedMarket && router.push(`/market/${selectedMarket.coinId.slice(1)}`)}
          style={{
            boxSizing: "border-box",
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            display: "flex",
            flexDirection: "column",
            cursor: selectedMarket ? "pointer" : "default",
            boxShadow: "rgba(0, 0, 0, 0.12) 0px 1px 3px, rgba(0, 0, 0, 0.24) 0px 1px 2px",
          }}
        >
          {/* Market header */}
          {selectedMarket && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 8,
                flexShrink: 0,
                padding: "14px 16px 10px",
              }}
            >
              <span style={{ fontWeight: "bold", fontSize: "15.6px", color: "#0E184D", display: "flex", alignItems: "center", gap: 6 }}>
                <BrailleIcon type={getBrailleType(selectedMarket)} />
                {selectedMarket.question}
              </span>
              {/* Single-line outcome dots — overflow hidden clips any that don't fit */}
              <div style={{ display: "flex", flexWrap: "nowrap", overflow: "hidden", gap: 10, width: "100%" }}>
                <OutcomeDots options={selectedMarket.options} isBinary={selectedMarket.isBinary} />
              </div>
            </div>
          )}

          {/* Chart */}
          <div className="chart-area" style={{ width: "100%" }}>
            {selectedCoin && selectedMarket && (
              selectedMarket.isBinary && selectedMarket.options[0]?.name.toLowerCase() === "yes" ? (
                <Liveline
                  data={ticks}
                  value={latestTick}
                  theme="light"
                  color={accentColor}
                  loading={loading}
                  grid
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
                    formatValue={(v) => fmtPct(v * 100)}
                    window={currentWindow}
                  />
                </div>
              )
            )}
          </div>
        </div>

        {/* Vol / clock / time-windows row */}
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
          <span style={{ fontSize: "11px", color: "#9ca3af", letterSpacing: "0.04em" }}>
            {fmtTime(now)}
          </span>
          <div style={{ display: "flex", gap: 2 }}>
            {(selectedMarket?.isRecurring ? WINDOWS_RECURRING : WINDOWS_STANDARD).map((w) => (
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
        </div> {/* end chart-card */}
      </div> {/* end hero-section */}

      {/* All Markets heading */}
      <div style={{ marginTop: 24, marginBottom: 8, display: "flex", alignItems: "center" }}>
        <span style={{ fontWeight: 700, fontSize: "11px", color: "#0E184D", letterSpacing: "0.1em", textTransform: "uppercase" }}>
          All Markets
        </span>
      </div>

      {/* Markets list */}
      <div style={{ marginTop: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {markets.map((m) => (
          <Link
            key={m.coinId}
            href={`/market/${m.coinId.slice(1)}`}
            style={{
              textDecoration: "none",
              color: "inherit",
              display: "flex",
              flexDirection: "column",
              padding: "10px 12px",
              border: "1px solid #e5e7eb",
              borderRadius: 10,
              gap: 6,
              cursor: "pointer",
              boxShadow: "rgba(0, 0, 0, 0.12) 0px 1px 3px, rgba(0, 0, 0, 0.24) 0px 1px 2px",
            }}
          >
            {/* Question */}
            <span style={{ fontWeight: 600, fontSize: "13px", color: "#0E184D", display: "flex", alignItems: "center", gap: 6 }}>
              <BrailleIcon type={getBrailleType(m)} />
              {m.question}
            </span>
            {/* First two outcomes */}
            <div style={{ display: "flex", flexWrap: "nowrap", gap: 10 }}>
              <OutcomeDots options={m.options.slice(0, 2)} isBinary={m.isBinary} />
            </div>
            {/* Volume */}
            <span style={{ fontSize: "11px", color: "#9ca3af" }}>
              Vol {fmtVolume(m.volume)}
            </span>
          </Link>
        ))}
      </div>
      </div> {/* end content */}
    </div>
  );
}
