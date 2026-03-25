"use client";

import { useState, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { use } from "react";
import type { LivelinePoint, LivelineSeries } from "liveline";
import {
  postInfo,
  fetchPredictMarkets,
  fmtChartValue,
  fmtPct,
  fmtVolume,
  MULTI_COLORS,
  HL_TESTNET_WS,
} from "../../lib/markets";
import type { Market, HLCandle, OutcomeOption } from "../../lib/markets";

const Liveline = dynamic(
  () => import("liveline").then((m) => ({ default: m.Liveline })),
  { ssr: false }
);

const WINDOWS = [
  { label: "1d", secs: 86400 },
  { label: "3d", secs: 259200 },
  { label: "7d", secs: 604800 },
];

const PANEL_BG     = "#0f1923";
const PANEL_BORDER = "#1e2d3d";
const PANEL_TEAL   = "#4ecca3";
const PANEL_TEXT   = "#e8edf2";
const PANEL_MUTED  = "#8b9ab0";
const PANEL_INPUT  = "#0a1520";

/* ─── Trading Panel ─────────────────────────────────────────── */

function TradingPanel({
  market,
  walletConnected,
  onConnectWallet,
}: {
  market: Market;
  walletConnected: boolean;
  onConnectWallet: () => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [selectedOutcomeIdx, setSelectedOutcomeIdx] = useState(0);
  const [selectedSide, setSelectedSide] = useState<"yes" | "no">("yes");
  const [quantity, setQuantity] = useState("10");
  const [sliderPct, setSliderPct] = useState(100);

  // Derive which token we're trading
  const selectedOutcomeOpt: OutcomeOption = market.options[selectedOutcomeIdx] ?? market.options[0];

  let tradingCoinId: string;
  let tradingName: string;
  let tradingPrice: number;

  if (market.isBinary) {
    const opt = market.options[selectedSide === "yes" ? 0 : 1];
    tradingCoinId = opt.coinId;
    tradingName   = opt.name;
    tradingPrice  = opt.price;
  } else {
    if (selectedSide === "yes") {
      tradingCoinId = selectedOutcomeOpt.coinId;
      tradingName   = selectedOutcomeOpt.name;
      tradingPrice  = selectedOutcomeOpt.price;
    } else {
      const yesNum  = parseInt(selectedOutcomeOpt.coinId.slice(1));
      tradingCoinId = `#${yesNum + 1}`;
      tradingName   = `No ${selectedOutcomeOpt.name}`;
      tradingPrice  = selectedOutcomeOpt.price > 0 ? 1 - selectedOutcomeOpt.price : 0;
    }
  }

  const qty        = parseFloat(quantity) || 0;
  const orderValue = qty * tradingPrice;
  const payout     = qty; // each token pays 1 USDH at resolution
  const slippageEst =
    tradingPrice > 0 && tradingPrice < 1
      ? ((1 - tradingPrice) * 15).toFixed(4)
      : "0.0000";

  const btnStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "10px 8px",
    borderRadius: 8,
    border: `1px solid ${active ? PANEL_TEAL : PANEL_BORDER}`,
    background: active ? PANEL_TEAL : "#152030",
    color: active ? "#0f1923" : PANEL_MUTED,
    fontWeight: 600,
    cursor: "pointer",
    fontSize: 13,
    whiteSpace: "nowrap" as const,
    transition: "all 0.15s",
  });

  return (
    <div
      style={{
        background: PANEL_BG,
        border: `1px solid ${PANEL_BORDER}`,
        borderRadius: 12,
        padding: "16px",
        color: PANEL_TEXT,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      {/* Buy / Sell tabs + Market label */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          borderBottom: `1px solid ${PANEL_BORDER}`,
          paddingBottom: 12,
          marginBottom: 16,
        }}
      >
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            style={{
              background: "none",
              border: "none",
              color: side === s ? PANEL_TEXT : PANEL_MUTED,
              fontSize: 16,
              fontWeight: 600,
              cursor: "pointer",
              paddingBottom: 4,
              marginRight: 16,
              borderBottom: side === s ? `2px solid ${PANEL_TEAL}` : "2px solid transparent",
              textTransform: "capitalize",
            }}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 4,
            color: PANEL_TEXT,
            fontSize: 14,
          }}
        >
          Market <span style={{ color: PANEL_MUTED }}>▾</span>
        </div>
      </div>

      {/* Multi-outcome: outcome selector row */}
      {!market.isBinary && (
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 12,
            flexWrap: "wrap",
          }}
        >
          {market.options.map((opt, i) => (
            <button
              key={opt.coinId}
              onClick={() => setSelectedOutcomeIdx(i)}
              style={btnStyle(selectedOutcomeIdx === i)}
            >
              {opt.name}
            </button>
          ))}
        </div>
      )}

      {/* Yes / No row */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={() => setSelectedSide("yes")} style={btnStyle(selectedSide === "yes")}>
          {side === "buy" ? "Buy" : "Sell"}{" "}
          {market.isBinary ? market.options[0].name : "Yes"}
        </button>
        <button onClick={() => setSelectedSide("no")} style={btnStyle(selectedSide === "no")}>
          {side === "buy" ? "Buy" : "Sell"}{" "}
          {market.isBinary ? market.options[1].name : "No"}
        </button>
      </div>

      {/* Available to trade */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 12,
          fontSize: 13,
        }}
      >
        <span style={{ color: PANEL_MUTED }}>Available to Trade</span>
        <span style={{ color: side === "buy" ? PANEL_TEAL : PANEL_TEXT }}>
          {side === "buy" ? "0 USDH" : `0 ${tradingName}`}
        </span>
      </div>

      {/* Size input */}
      <div
        style={{
          border: `1px solid ${PANEL_BORDER}`,
          borderRadius: 8,
          padding: "12px 14px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
          background: PANEL_INPUT,
        }}
      >
        <span style={{ color: PANEL_MUTED, fontSize: 14 }}>Size</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="number"
            min="0"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            style={{
              background: "transparent",
              border: "none",
              color: PANEL_TEXT,
              textAlign: "right",
              width: 64,
              fontSize: 14,
              outline: "none",
              fontFamily: "inherit",
            }}
          />
          <span
            style={{
              color: PANEL_TEXT,
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 4,
              whiteSpace: "nowrap",
            }}
          >
            {tradingName} <span style={{ color: PANEL_MUTED }}>▾</span>
          </span>
        </div>
      </div>

      {/* Slider + % snap buttons */}
      <div style={{ marginBottom: 20 }}>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={sliderPct}
          onChange={(e) => setSliderPct(parseInt(e.target.value))}
          style={{ width: "100%", accentColor: PANEL_TEAL, cursor: "pointer" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
          {[25, 50, 75, 100].map((pct) => (
            <button
              key={pct}
              onClick={() => setSliderPct(pct)}
              style={{
                background: "none",
                border: "none",
                color: sliderPct === pct ? PANEL_TEAL : PANEL_MUTED,
                fontSize: 11,
                cursor: "pointer",
                padding: "2px 4px",
                fontFamily: "inherit",
              }}
            >
              {pct}%
            </button>
          ))}
        </div>
      </div>

      {/* Trade / Connect button */}
      <button
        onClick={walletConnected ? undefined : onConnectWallet}
        style={{
          background: PANEL_TEAL,
          color: "#0f1923",
          border: "none",
          borderRadius: 8,
          padding: "14px",
          fontSize: 16,
          fontWeight: 700,
          cursor: "pointer",
          width: "100%",
          marginBottom: 16,
          fontFamily: "inherit",
        }}
      >
        {walletConnected ? "Trade" : "Connect"}
      </button>

      {/* Order details */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          fontSize: 13,
          borderTop: `1px solid ${PANEL_BORDER}`,
          paddingTop: 16,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: PANEL_MUTED }}>Order Value</span>
          <span>{orderValue > 0 ? `${orderValue.toFixed(2)} USDH` : "—"}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: PANEL_MUTED, textDecoration: "underline dotted" }}>
            Slippage
          </span>
          <span style={{ color: PANEL_TEAL }}>
            Est: {slippageEst}% / Max: 8.00%
          </span>
        </div>
        {side === "buy" && qty > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: PANEL_MUTED }}>
              Payout if {tradingName}
            </span>
            <span>{payout.toFixed(2)} USDH</span>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: PANEL_MUTED, textDecoration: "underline dotted" }}>
            Fees
          </span>
          <span>0.0700% / 0.0400%</span>
        </div>
      </div>
    </div>
  );
}

/* ─── Outcome dots (light-theme header) ─────────────────────── */

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

/* ─── Market Page ────────────────────────────────────────────── */

export default function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const coinId = `#${id}`;

  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentWindow, setCurrentWindow] = useState(86400);
  const [walletConnected, setWalletConnected] = useState(false);

  // Chart state
  const [ticks, setTicks] = useState<LivelinePoint[]>([]);
  const [latestTick, setLatestTick] = useState(0);
  const [multiSeries, setMultiSeries] = useState<LivelineSeries[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const selectedCoinRef = useRef(coinId);
  const selectedApiCoinRef = useRef(coinId);
  const prevCandleTimeRef = useRef(0);
  const latestTickRef = useRef(0);

  // Fetch all markets (we need the full list to find our market)
  useEffect(() => {
    fetchPredictMarkets()
      .then(setMarkets)
      .catch(() => setMarkets([]));
  }, []);

  const market = markets.find((m) => m.coinId === coinId);

  // Fetch chart data when market is found
  useEffect(() => {
    if (!market) return;

    setLoading(true);
    setTicks([]);
    setMultiSeries([]);
    prevCandleTimeRef.current = 0;
    latestTickRef.current = 0;

    const endTime   = Date.now();
    const startTime = endTime - 8 * 24 * 60 * 60 * 1000;

    if (market.isBinary) {
      selectedApiCoinRef.current = market.coinId;

      postInfo<HLCandle[]>({
        type: "candleSnapshot",
        req: { coin: market.coinId, interval: "1h", startTime, endTime },
      }).then((data) => {
        if (!data?.length) return;
        const pts = data.map((c) => ({
          time:  Math.floor(c.t / 1000),
          value: parseFloat(c.c),
        }));
        const last = pts[pts.length - 1];
        setTicks(pts);
        setLatestTick(last.value);
        latestTickRef.current       = last.value;
        prevCandleTimeRef.current   = last.time;
        setLoading(false);
      });
    } else {
      Promise.all(
        market.options.map((opt) =>
          postInfo<HLCandle[]>({
            type: "candleSnapshot",
            req: { coin: opt.coinId, interval: "1h", startTime, endTime },
          }).then((d) => d ?? [])
        )
      ).then((allData) => {
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
  }, [market?.coinId]);

  // WebSocket for live prices
  useEffect(() => {
    if (!market) return;

    wsRef.current?.close();
    wsRef.current = null;

    const ws = new WebSocket(HL_TESTNET_WS);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } }));
      if (market.isBinary) {
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
                return raw ? { ...opt, price: parseFloat(raw) } : opt;
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
  }, [market?.coinId]);

  const yesPrice    = market?.isBinary ? market.options[0].price : 0;
  const accentColor = yesPrice < 0.5 ? "#dc2626" : "#16a34a";

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#ffffff",
        boxSizing: "border-box",
        padding: "12px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <Link
          href="/"
          style={{
            color: "#6b7280",
            textDecoration: "none",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            gap: 4,
            flexShrink: 0,
          }}
        >
          ← Back
        </Link>

        <span
          style={{
            fontWeight: 700,
            fontSize: "15.6px",
            color: "#111",
            flex: 1,
            minWidth: 0,
          }}
        >
          {market?.question ?? "Loading…"}
        </span>

        {/* Connect Wallet button */}
        <button
          onClick={() => setWalletConnected((v) => !v)}
          style={{
            background: walletConnected ? "#16a34a" : PANEL_BG,
            color: walletConnected ? "#fff" : PANEL_TEAL,
            border: `1px solid ${walletConnected ? "#16a34a" : PANEL_TEAL}`,
            borderRadius: 8,
            padding: "7px 14px",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            flexShrink: 0,
            fontFamily: "inherit",
          }}
        >
          {walletConnected ? "Connected" : "Connect Wallet"}
        </button>
      </div>

      {/* Outcome dots */}
      {market && (
        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          <OutcomeDots options={market.options} isBinary={market.isBinary} />
        </div>
      )}

      {/* Main content: chart + trading panel */}
      <div className="market-layout" style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>

        {/* Chart column */}
        <div className="market-chart-col" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          {/* Chart */}
          <div
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            <div className="chart-area" style={{ width: "100%" }}>
              {market && (
                market.isBinary ? (
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
              {!market && (
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: 13 }}>
                  Loading…
                </div>
              )}
            </div>
          </div>

          {/* Vol + time windows below chart */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 0",
            }}
          >
            <span style={{ fontSize: "11px", color: "#9ca3af" }}>
              Vol {market ? fmtVolume(market.volume) : "—"}
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
        </div>

        {/* Trading panel column */}
        <div className="market-panel-col">
          {market ? (
            <TradingPanel
              market={market}
              walletConnected={walletConnected}
              onConnectWallet={() => setWalletConnected(true)}
            />
          ) : (
            <div
              style={{
                background: PANEL_BG,
                border: `1px solid ${PANEL_BORDER}`,
                borderRadius: 12,
                height: 200,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: PANEL_MUTED,
                fontSize: 13,
              }}
            >
              Loading…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
