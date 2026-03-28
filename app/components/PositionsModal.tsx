"use client";

import { useState, useEffect } from "react";
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

const COLS = ["Prediction", "Size", "Value", "Entry", "Mark", "PNL (ROE%)"];

async function fetchPositions(addr: string): Promise<PositionRow[]> {
  const { markets } = await fetchPredictMarkets();

  const lookup = new Map<string, { question: string; outcomeName: string; markPrice: number }>();
  const addCoin = (coinId: string, info: { question: string; outcomeName: string; markPrice: number }) => {
    lookup.set(coinId, info);
    if (coinId.startsWith("#")) lookup.set("@" + coinId.slice(1), info);
    if (coinId.startsWith("@")) lookup.set("#" + coinId.slice(1), info);
  };
  for (const m of markets) {
    for (const opt of m.options) {
      addCoin(opt.coinId, { question: m.question, outcomeName: opt.name, markPrice: opt.price });
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

  const data = await postInfo<{ balances: { coin: string; total: string; entryNtl?: string }[] }>(
    { type: "spotClearinghouseState", user: addr }
  );

  const rows: PositionRow[] = [];
  for (const b of data.balances ?? []) {
    const size = parseFloat(b.total);
    if (!(size > 0)) continue;
    const coinKey = b.coin.includes("/") ? b.coin.split("/")[0] : b.coin;
    const info = lookup.get(coinKey);
    if (!info) continue;
    const coinId = coinKey.startsWith("@") ? "#" + coinKey.slice(1) : coinKey;
    const entryPrice = b.entryNtl ? parseFloat(b.entryNtl) / size : null;
    const positionValue = size * info.markPrice;
    const entryNtl = entryPrice !== null ? entryPrice * size : null;
    const pnl = entryNtl !== null ? positionValue - entryNtl : null;
    const roe = pnl !== null && entryNtl !== null && entryNtl > 0 ? (pnl / entryNtl) * 100 : null;
    rows.push({ coinId, question: info.question, outcomeName: info.outcomeName, size, markPrice: info.markPrice, entryPrice, positionValue, pnl, roe });
  }
  return rows;
}

export default function PositionsModal() {
  const { address } = useWallet();
  const [open, setOpen] = useState(false);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !address) return;
    setLoading(true);
    fetchPositions(address)
      .then(setPositions)
      .catch(() => setPositions([]))
      .finally(() => setLoading(false));
  }, [open, address]);

  if (!address) return null;

  const fmtP = (v: number) => (v < 0.01 ? v.toFixed(6) : v.toFixed(4));
  const fmtPnl = (pnl: number | null, roe: number | null) => {
    if (pnl === null) return "—";
    const sign = pnl >= 0 ? "+" : "";
    const roeStr = roe !== null ? ` (${pnl >= 0 ? "+" : ""}${roe.toFixed(1)}%)` : "";
    return `${sign}$${pnl.toFixed(2)}${roeStr}`;
  };

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(true)}
        style={{
          background: "transparent",
          border: "1px solid #0E184D",
          borderRadius: 8,
          padding: "7px 14px",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          color: "#0E184D",
          fontFamily: "inherit",
        }}
      >
        Positions
      </button>

      {/* Modal */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setOpen(false)}
            style={{
              position: "fixed", inset: 0,
              background: "rgba(14,24,77,0.35)",
              zIndex: 200,
            }}
          />

          {/* Card */}
          <div
            style={{
              position: "fixed",
              top: "50%", left: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 201,
              background: "#F0E9D7",
              borderRadius: 12,
              padding: "20px 24px",
              width: "min(92vw, 740px)",
              maxHeight: "80vh",
              overflow: "auto",
              fontFamily: "inherit",
              boxShadow: "rgba(0,0,0,0.2) 0px 8px 32px",
            }}
          >
            {/* Header row */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: "#0E184D" }}>Positions</span>
              <button
                onClick={() => setOpen(false)}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  fontSize: 18, color: "#9ca3af", fontFamily: "inherit", lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>

            {/* Column headers */}
            <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb", paddingBottom: 6, marginBottom: 4 }}>
              {COLS.map((h, i) => (
                <span key={h} style={{ fontSize: 11, color: "#9ca3af", fontWeight: 500, flex: i === 0 ? "3 0 160px" : "1 0 70px", whiteSpace: "nowrap" }}>
                  {h}
                </span>
              ))}
            </div>

            {/* Rows */}
            {loading ? (
              <div style={{ padding: "16px 0", fontSize: 12, color: "#9ca3af" }}>Loading…</div>
            ) : positions.length === 0 ? (
              <div style={{ padding: "16px 0", fontSize: 12, color: "#9ca3af" }}>No open positions</div>
            ) : (
              positions.map((pos) => (
                <div key={pos.coinId} style={{ display: "flex", padding: "8px 0", borderBottom: "1px solid #e9e2ce" }}>
                  <div style={{ flex: "3 0 160px", minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#0E184D", whiteSpace: "nowrap" }}>{pos.outcomeName}</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", whiteSpace: "nowrap", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>{pos.question}</div>
                  </div>
                  <span style={{ flex: "1 0 70px", fontSize: 12, color: "#0E184D", alignSelf: "center" }}>{pos.size.toFixed(2)}</span>
                  <span style={{ flex: "1 0 70px", fontSize: 12, color: "#0E184D", alignSelf: "center" }}>${pos.positionValue.toFixed(2)}</span>
                  <span style={{ flex: "1 0 70px", fontSize: 12, color: "#0E184D", alignSelf: "center" }}>{pos.entryPrice !== null ? fmtP(pos.entryPrice) : "—"}</span>
                  <span style={{ flex: "1 0 70px", fontSize: 12, color: "#0E184D", alignSelf: "center" }}>{fmtP(pos.markPrice)}</span>
                  <span style={{ flex: "1 0 70px", fontSize: 12, fontWeight: 500, alignSelf: "center", color: pos.pnl === null ? "#9ca3af" : pos.pnl >= 0 ? "#629F82" : "#F48484" }}>
                    {fmtPnl(pos.pnl, pos.roe)}
                  </span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </>
  );
}
