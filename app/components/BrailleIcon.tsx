"use client";

import { useState, useEffect } from "react";
import type { Market } from "../lib/markets";

// Frame sequences for each market category
const FRAMES = {
  // Recurring: classic spinner — suggests continuous cycling
  recurring: ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧"],
  // Binary Yes/No: left-column breathe — suggests two expanding states
  binary:    ["⠀","⠂","⠆","⠇","⡇","⠇","⠆","⠂","⠀","⠀"],
  // Multi-outcome: heavy dots spinner — suggests many possibilities
  multi:     ["⣾","⣽","⣻","⢿","⡿","⣟","⣯","⣷"],
} as const;

const INTERVAL_MS = { recurring: 120, binary: 200, multi: 110 } as const;

export type BrailleType = keyof typeof FRAMES;

export function getBrailleType(market: Market): BrailleType {
  if (market.isRecurring) return "recurring";
  if (market.isBinary && market.options[0]?.name.toLowerCase() === "yes") return "binary";
  return "multi";
}

export default function BrailleIcon({ type }: { type: BrailleType }) {
  const frames = FRAMES[type];
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIdx((i) => (i + 1) % frames.length), INTERVAL_MS[type]);
    return () => clearInterval(id);
  }, [type, frames.length]);

  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: "1ch",
        textAlign: "center",
        color: "#9ca3af",
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      {frames[idx]}
    </span>
  );
}
