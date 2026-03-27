"use client";

import { useState, useEffect, useRef } from "react";
import { useWallet } from "../lib/wallet-context";
import { fetchPredictMarkets, postInfo } from "../lib/markets";

interface PositionRow {
  coinId: string;
  question: string;
  outcomeName: string;
  size: number;
  markPrice: number;
  entryPrice: number | null;
  positionValue: number;
  pnl: number | null;
  roe: number | null;
}

const COLS = ["Prediction", "Size", "Position Value", "Entry Price", "Mark Price", "PNL (ROE %)"];

export default function PositionsFooter() {
  const { address } = useWallet();
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh(addr: string) {
    try {
      const { markets } = await fetchPredictMarkets();

      // Build lookup: all possible coin identifier formats → outcome info.
      // spotClearinghouseState may return coins as "#N" or "@N"; we add both.
      // Multi-outcome markets only expose their YES coinId in options, so we
      // also derive and register the NO coinId (#N+1 / @N+1).
      const lookup = new Map<string, { question: string; outcomeName: string; markPrice: number }>();

      const addCoin = (coinId: string, info: { question: string; outcomeName: string; markPrice: number }) => {
        lookup.set(coinId, info);
        if (coinId.startsWith("#")) lookup.set("@" + coinId.slice(1), info);
        if (coinId.startsWith("@")) lookup.set("#" + coinId.slice(1), info);
      };

      for (const m of markets) {
        for (const opt of m.options) {
          addCoin(opt.coinId, { question: m.question, outcomeName: opt.name, markPrice: opt.price });

          // For multi-outcome markets the NO side (#N+1) is not in options — add it explicitly.
          if (!m.isBinary) {
            const yesNum = parseInt(opt.coinId.slice(1));
            if (!isNaN(yesNum)) {
              addCoin(`#${yesNum + 1}`, {
                question: m.question,
                outcomeName: `No — ${opt.name}`,
                markPrice: opt.price > 0 ? 1 - opt.price : 0,
              });
            }
          }
        }
      }

      // Spot balances — outcome tokens are L1 spot assets on HyperCore
      const data = await postInfo<{
        balances: { coin: string; total: string; entryNtl?: string }[];
      }>({ type: "spotClearinghouseState", user: addr });

      const rows: PositionRow[] = [];
      for (const b of data.balances ?? []) {
        const size = parseFloat(b.total);
        if (!(size > 0)) continue;

        // Normalize coin: strip any "/USDH" or other pair suffix
        const coinKey = b.coin.includes("/") ? b.coin.split("/")[0] : b.coin;
        const info = lookup.get(coinKey);
        if (!info) continue;

        // Normalise to canonical "#N" coinId
        const coinId = coinKey.startsWith("@") ? "#" + coinKey.slice(1) : coinKey;

        const entryPrice = b.entryNtl ? parseFloat(b.entryNtl) / size : null;
        const positionValue = size * info.markPrice;
        const entryNtl = entryPrice !== null ? entryPrice * size : null;
        const pnl = entryNtl !== null ? positionValue - entryNtl : null;
        const roe =
          pnl !== null && entryNtl !== null && entryNtl > 0
            ? (pnl / entryNtl) * 100
            : null;

        rows.push({ coinId, question: info.question, outcomeName: info.outcomeName, size, markPrice: info.markPrice, entryPrice, positionValue, pnl, roe });
      }
      setPositions(rows);
    } catch {
      // silently ignore network errors
    }
  }

  useEffect(() => {
    if (!address) {
      setPositions([]);
      document.body.style.paddingBottom = "";
      return;
    }
    document.body.style.paddingBottom = "88px";
    setLoading(true);
    refresh(address).finally(() => setLoading(false));
    intervalRef.current = setInterval(() => refresh(address), 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.body.style.paddingBottom = "";
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  if (!address) return null;

  const fmtPrice = (v: number) => (v < 0.01 ? v.toFixed(6) : v.toFixed(4));
  const fmtPnl = (pnl: number | null, roe: number | null) => {
    if (pnl === null) return "—";
    const sign = pnl >= 0 ? "+" : "";
    const roeStr = roe !== null ? ` (${pnl >= 0 ? "+" : ""}${roe.toFixed(1)}%)` : "";
    return `${sign}$${pnl.toFixed(2)}${roeStr}`;
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        background: "#fff",
        borderTop: "1px solid #e5e7eb",
        zIndex: 50,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
        maxHeight: 220,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Column headers */}
      <div
        style={{
          display: "flex",
          padding: "7px 16px",
          borderBottom: "1px solid #f3f4f6",
          overflowX: "auto",
          flexShrink: 0,
        }}
      >
        {COLS.map((h, i) => (
          <span
            key={h}
            style={{
              fontSize: 11,
              color: "#9ca3af",
              fontWeight: 500,
              flex: i === 0 ? "3 0 160px" : "1 0 80px",
              whiteSpace: "nowrap",
            }}
          >
            {h}
          </span>
        ))}
      </div>

      {/* Rows */}
      <div style={{ overflowY: "auto", overflowX: "auto" }}>
        {loading && positions.length === 0 ? (
          <div style={{ padding: "10px 16px", fontSize: 12, color: "#9ca3af" }}>Loading…</div>
        ) : positions.length === 0 ? (
          <div style={{ padding: "10px 16px", fontSize: 12, color: "#9ca3af" }}>No predictions</div>
        ) : (
          positions.map((pos) => (
            <div
              key={pos.coinId}
              style={{
                display: "flex",
                padding: "7px 16px",
                borderBottom: "1px solid #f9fafb",
                minWidth: "max-content",
                width: "100%",
                boxSizing: "border-box",
              }}
            >
              <div style={{ flex: "3 0 160px", minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#111", whiteSpace: "nowrap" }}>
                  {pos.outcomeName}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "#9ca3af",
                    whiteSpace: "nowrap",
                    maxWidth: 240,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {pos.question}
                </div>
              </div>
              <span style={{ flex: "1 0 80px", fontSize: 12, color: "#111", alignSelf: "center" }}>
                {pos.size.toFixed(2)}
              </span>
              <span style={{ flex: "1 0 80px", fontSize: 12, color: "#111", alignSelf: "center" }}>
                ${pos.positionValue.toFixed(2)}
              </span>
              <span style={{ flex: "1 0 80px", fontSize: 12, color: "#111", alignSelf: "center" }}>
                {pos.entryPrice !== null ? fmtPrice(pos.entryPrice) : "—"}
              </span>
              <span style={{ flex: "1 0 80px", fontSize: 12, color: "#111", alignSelf: "center" }}>
                {fmtPrice(pos.markPrice)}
              </span>
              <span
                style={{
                  flex: "1 0 80px",
                  fontSize: 12,
                  fontWeight: 500,
                  alignSelf: "center",
                  color: pos.pnl === null ? "#9ca3af" : pos.pnl >= 0 ? "#16a34a" : "#dc2626",
                }}
              >
                {fmtPnl(pos.pnl, pos.roe)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
