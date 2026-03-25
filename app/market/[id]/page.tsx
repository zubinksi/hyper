"use client";

import { useState, useEffect, useRef, useCallback } from "react";
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
import { signAndSubmitOrder } from "../../lib/hyperliquid-sign";

const Liveline = dynamic(
  () => import("liveline").then((m) => ({ default: m.Liveline })),
  { ssr: false }
);

const WINDOWS = [
  { label: "1d", secs: 86400 },
  { label: "3d", secs: 259200 },
  { label: "7d", secs: 604800 },
];

/* ─── Wallet hook ────────────────────────────────────────────── */

interface WalletState {
  address: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: any | null;
  connecting: boolean;
  error: string | null;
}

function useWallet() {
  const [state, setState] = useState<WalletState>({
    address: null,
    provider: null,
    connecting: false,
    error: null,
  });

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      // 1. Try injected provider (MetaMask, Rabby, etc.) first
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const injected = typeof window !== "undefined" ? (window as any).ethereum : null;
      if (injected) {
        const accounts: string[] = await injected.request({
          method: "eth_requestAccounts",
        });
        setState({ address: accounts[0], provider: injected, connecting: false, error: null });
        return;
      }

      // 2. Fall back to WalletConnect
      const projectId =
        process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ||
        "ed1c8661cd48e06fa3397987e8db2281";

      const { default: EthereumProvider } = await import(
        "@walletconnect/ethereum-provider"
      );
      const wcProvider = await EthereumProvider.init({
        projectId,
        chains: [1],
        showQrModal: true,
        methods: [
          "eth_signTypedData_v4",
          "eth_accounts",
          "eth_requestAccounts",
          "personal_sign",
        ],
        events: ["accountsChanged", "disconnect"],
      });

      await wcProvider.connect();
      const accounts: string[] = wcProvider.accounts;
      setState({
        address: accounts[0] ?? null,
        provider: wcProvider,
        connecting: false,
        error: null,
      });
    } catch (err: unknown) {
      setState((s) => ({
        ...s,
        connecting: false,
        error: err instanceof Error ? err.message : "Connection failed",
      }));
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (state.provider?.disconnect) {
      try { await state.provider.disconnect(); } catch { /* ignore */ }
    }
    setState({ address: null, provider: null, connecting: false, error: null });
  }, [state.provider]);

  return { ...state, connect, disconnect };
}

/* ─── Outcome dots ───────────────────────────────────────────── */

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

/* ─── Trading Panel ─────────────────────────────────────────── */

type TradeStatus = "idle" | "pending" | "success" | "error";

function TradingPanel({
  market,
  spotIndexMap,
  walletAddress,
  walletProvider,
  onConnectWallet,
}: {
  market: Market;
  spotIndexMap: Record<string, number>;
  walletAddress: string | null;
  walletProvider: object | null;
  onConnectWallet: () => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [selectedOutcomeIdx, setSelectedOutcomeIdx] = useState(0);
  const [selectedSide, setSelectedSide] = useState<"yes" | "no">("yes");
  const [quantity, setQuantity] = useState("");
  const [tradeStatus, setTradeStatus] = useState<TradeStatus>("idle");
  const [tradeMsg, setTradeMsg] = useState("");

  // Reset status when inputs change
  useEffect(() => { setTradeStatus("idle"); setTradeMsg(""); }, [side, selectedOutcomeIdx, selectedSide, quantity]);

  // Which token we're trading
  const selectedOutcomeOpt = market.options[selectedOutcomeIdx] ?? market.options[0];

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

  const spotIndex = spotIndexMap[tradingCoinId] ?? -1;
  const qty        = parseFloat(quantity) || 0;
  const orderValue = qty * tradingPrice;
  const payout     = qty; // 1 USDH per token at resolution
  const slippageEst =
    tradingPrice > 0 && tradingPrice < 1
      ? ((1 - tradingPrice) * 15).toFixed(4)
      : "0.0000";

  async function handleTrade() {
    if (!walletAddress || !walletProvider) {
      onConnectWallet();
      return;
    }
    if (qty <= 0) {
      setTradeStatus("error");
      setTradeMsg("Enter a quantity first");
      return;
    }

    setTradeStatus("pending");
    setTradeMsg("");

    const result = await signAndSubmitOrder({
      walletProvider,
      spotIndex,
      isBuy: side === "buy",
      price: tradingPrice,
      size: qty,
    });

    setTradeStatus(result.success ? "success" : "error");
    setTradeMsg(result.message);
  }

  // Shared pill button style
  const pillBtn = (active: boolean, activeColor: string): React.CSSProperties => ({
    flex: 1,
    padding: "9px 8px",
    borderRadius: 8,
    border: `1px solid ${active ? activeColor : "#e5e7eb"}`,
    background: active ? `${activeColor}14` : "#f9fafb",
    color: active ? activeColor : "#6b7280",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: 13,
    whiteSpace: "nowrap" as const,
    transition: "all 0.12s",
    fontFamily: "inherit",
  });

  const buyColor  = "#16a34a";
  const sellColor = "#dc2626";
  const activeTabColor = side === "buy" ? buyColor : sellColor;

  const statusColors: Record<TradeStatus, string> = {
    idle:    "#111",
    pending: "#6b7280",
    success: "#16a34a",
    error:   "#dc2626",
  };

  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        overflow: "hidden",
        background: "#fff",
      }}
    >
      {/* Buy / Sell tabs */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid #f3f4f6",
        }}
      >
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            style={{
              flex: 1,
              background: "none",
              border: "none",
              borderBottom: side === s
                ? `2px solid ${s === "buy" ? buyColor : sellColor}`
                : "2px solid transparent",
              color: side === s
                ? (s === "buy" ? buyColor : sellColor)
                : "#6b7280",
              fontSize: 14,
              fontWeight: 700,
              cursor: "pointer",
              padding: "14px 0",
              fontFamily: "inherit",
              textTransform: "capitalize",
            }}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      <div style={{ padding: "16px" }}>

        {/* Multi-outcome: outcome selector row */}
        {!market.isBinary && (
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            {market.options.map((opt, i) => (
              <button
                key={opt.coinId}
                onClick={() => setSelectedOutcomeIdx(i)}
                style={pillBtn(selectedOutcomeIdx === i, activeTabColor)}
              >
                {opt.name}
              </button>
            ))}
          </div>
        )}

        {/* Yes / No row */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button
            onClick={() => setSelectedSide("yes")}
            style={pillBtn(selectedSide === "yes", buyColor)}
          >
            {side === "buy" ? "Buy" : "Sell"}{" "}
            {market.isBinary ? market.options[0].name : "Yes"}
          </button>
          <button
            onClick={() => setSelectedSide("no")}
            style={pillBtn(selectedSide === "no", sellColor)}
          >
            {side === "buy" ? "Buy" : "Sell"}{" "}
            {market.isBinary ? market.options[1].name : "No"}
          </button>
        </div>

        {/* Available to trade */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 10,
            fontSize: 12,
          }}
        >
          <span style={{ color: "#9ca3af" }}>Available to Trade</span>
          <span style={{ color: "#111", fontWeight: 500 }}>
            {side === "buy" ? "0 USDH" : `0 ${tradingName}`}
          </span>
        </div>

        {/* Size input — whole row is the input */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: "12px 14px",
            marginBottom: 16,
            background: "#f9fafb",
            cursor: "text",
            gap: 8,
          }}
        >
          <span style={{ color: "#9ca3af", fontSize: 13, flexShrink: 0 }}>Size</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1, justifyContent: "flex-end" }}>
            <input
              type="number"
              min="0"
              step="any"
              placeholder="0"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#111",
                fontSize: 15,
                fontWeight: 500,
                textAlign: "right",
                width: "80px",
                fontFamily: "inherit",
              }}
            />
            <span style={{ color: "#6b7280", fontSize: 13, flexShrink: 0, whiteSpace: "nowrap" }}>
              {tradingName} ▾
            </span>
          </div>
        </label>

        {/* Trade / Connect button */}
        <button
          onClick={handleTrade}
          disabled={tradeStatus === "pending"}
          style={{
            width: "100%",
            padding: "13px",
            borderRadius: 8,
            border: "none",
            background: tradeStatus === "pending" ? "#e5e7eb" :
              tradeStatus === "success" ? "#16a34a" :
              tradeStatus === "error"   ? "#dc2626" :
              !walletAddress            ? "#111" :
              activeTabColor,
            color: tradeStatus === "pending" ? "#6b7280" : "#fff",
            fontSize: 15,
            fontWeight: 700,
            cursor: tradeStatus === "pending" ? "default" : "pointer",
            fontFamily: "inherit",
            marginBottom: tradeMsg ? 8 : 0,
            transition: "background 0.15s",
          }}
        >
          {tradeStatus === "pending" ? "Submitting…" :
           tradeStatus === "success" ? "Order filled ✓" :
           !walletAddress ? "Connect Wallet" :
           side === "buy" ? `Buy ${tradingName}` : `Sell ${tradingName}`}
        </button>

        {/* Status message */}
        {tradeMsg && (
          <div
            style={{
              fontSize: 12,
              color: statusColors[tradeStatus],
              textAlign: "center",
              padding: "4px 0 8px",
            }}
          >
            {tradeMsg}
          </div>
        )}

        {/* Order details */}
        <div
          style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: "1px solid #f3f4f6",
            display: "flex",
            flexDirection: "column",
            gap: 9,
          }}
        >
          {[
            {
              label: "Order Value",
              value: orderValue > 0 ? `${orderValue.toFixed(2)} USDH` : "—",
              valueColor: "#111",
            },
            {
              label: "Slippage",
              value: `Est: ${slippageEst}% / Max: 8.00%`,
              valueColor: "#6b7280",
            },
            ...(side === "buy" && qty > 0
              ? [{ label: `Payout if ${tradingName}`, value: `${payout.toFixed(2)} USDH`, valueColor: "#16a34a" }]
              : []),
            {
              label: "Fees",
              value: "0.0700% / 0.0400%",
              valueColor: "#6b7280",
            },
          ].map(({ label, value, valueColor }) => (
            <div
              key={label}
              style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}
            >
              <span style={{ color: "#9ca3af" }}>{label}</span>
              <span style={{ color: valueColor, fontWeight: 500 }}>{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Market Page ────────────────────────────────────────────── */

export default function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const coinId = `#${id}`;

  const [markets, setMarkets]       = useState<Market[]>([]);
  const [spotIndexMap, setSpotIndexMap] = useState<Record<string, number>>({});
  const [loading, setLoading]       = useState(true);
  const [currentWindow, setCurrentWindow] = useState(86400);

  // Chart state
  const [ticks, setTicks]             = useState<LivelinePoint[]>([]);
  const [latestTick, setLatestTick]   = useState(0);
  const [multiSeries, setMultiSeries] = useState<LivelineSeries[]>([]);

  const wallet = useWallet();

  const wsRef             = useRef<WebSocket | null>(null);
  const selectedCoinRef   = useRef(coinId);
  const selectedApiCoinRef = useRef(coinId);
  const prevCandleTimeRef = useRef(0);
  const latestTickRef     = useRef(0);

  // Fetch markets
  useEffect(() => {
    fetchPredictMarkets()
      .then(({ markets, spotIndexMap }) => {
        setMarkets(markets);
        setSpotIndexMap(spotIndexMap);
      })
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
        latestTickRef.current     = last.value;
        prevCandleTimeRef.current = last.time;
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

  // WebSocket live prices
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
        // ignore parse errors
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

  // Truncate address for display
  const shortAddr = wallet.address
    ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
    : null;

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#ffffff",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ── Site header ── */}
      <header
        style={{
          borderBottom: "1px solid #f3f4f6",
          padding: "0 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 52,
          flexShrink: 0,
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
          }}
        >
          ← Markets
        </Link>

        {/* Wallet button */}
        {wallet.error && (
          <span style={{ fontSize: 11, color: "#dc2626", maxWidth: 200, textAlign: "right" }}>
            {wallet.error}
          </span>
        )}
        <button
          onClick={wallet.address ? wallet.disconnect : wallet.connect}
          disabled={wallet.connecting}
          style={{
            background: wallet.address ? "#f0fdf4" : "#111",
            color: wallet.address ? "#16a34a" : "#fff",
            border: wallet.address ? "1px solid #bbf7d0" : "none",
            borderRadius: 8,
            padding: "7px 14px",
            fontSize: 13,
            fontWeight: 600,
            cursor: wallet.connecting ? "default" : "pointer",
            fontFamily: "inherit",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {wallet.connecting ? (
            "Connecting…"
          ) : wallet.address ? (
            <>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "#16a34a",
                  display: "inline-block",
                }}
              />
              {shortAddr}
            </>
          ) : (
            "Connect Wallet"
          )}
        </button>
      </header>

      {/* ── Market title + outcomes ── */}
      <div
        style={{
          padding: "14px 16px 10px",
          borderBottom: "1px solid #f3f4f6",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            fontWeight: 700,
            fontSize: "15.6px",
            color: "#111",
            marginBottom: 8,
          }}
        >
          {market?.question ?? "Loading…"}
        </div>
        {market && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <OutcomeDots options={market.options} isBinary={market.isBinary} />
          </div>
        )}
      </div>

      {/* ── Main content: chart + trading panel ── */}
      <div
        className="market-layout"
        style={{ display: "flex", gap: 0, flex: 1, minHeight: 0 }}
      >
        {/* Chart column */}
        <div
          className="market-chart-col"
          style={{
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            borderRight: "1px solid #f3f4f6",
          }}
        >
          {/* Chart */}
          <div className="chart-area" style={{ width: "100%", padding: "0" }}>
            {market ? (
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
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#9ca3af",
                  fontSize: 13,
                }}
              >
                Loading…
              </div>
            )}
          </div>

          {/* Vol + time windows */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 16px",
              borderTop: "1px solid #f3f4f6",
              flexShrink: 0,
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
                    backgroundColor: currentWindow === w.secs ? "rgba(0,0,0,0.07)" : "transparent",
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
        <div className="market-panel-col" style={{ padding: "16px" }}>
          {market ? (
            <TradingPanel
              market={market}
              spotIndexMap={spotIndexMap}
              walletAddress={wallet.address}
              walletProvider={wallet.provider}
              onConnectWallet={wallet.connect}
            />
          ) : (
            <div
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 12,
                height: 200,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#9ca3af",
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
