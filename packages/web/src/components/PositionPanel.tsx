"use client";

import type { Clone, PositionState } from "@argus/shared";
import { axiomLink } from "../lib/axiomLink";
import { Sparkline } from "./Sparkline";

/**
 * One position, and whatever is trying to take its narrative.
 *
 * The question this has to answer in about three seconds is whether a clone is
 * outpacing what you hold. So trade rate is a bar, not a number: being outpaced
 * is a shape you see rather than two figures you compare. Your token is always
 * the first row, so the comparison has a fixed anchor.
 *
 * Tracked wallets are named rather than counted, because their buying is the
 * trigger and a name is what makes it credible.
 */

/** A wave produced 24 clones. Twenty-four rows is not a three second read. */
const MAX_ROWS = 6;

export function PositionPanel({
  position,
  history,
  rates,
  now,
}: {
  position: PositionState;
  /** Recent prices per mint, newest last, for the sparklines. */
  history: Record<string, number[]>;
  /** Latest trade rate per mint, from tick frames. */
  rates: Record<string, number>;
  now: number;
}) {
  const symbol = position.meta?.symbol ?? "resolving…";
  const name = position.meta?.name ?? position.mint.slice(0, 16);
  const held = position.entrySolLamports / 1e9;
  const secondsLeft = Math.max(0, Math.round((position.expiresAt - now) / 1000));
  const shown = position.clones.slice(0, MAX_ROWS);
  const hidden = position.clones.length - shown.length;

  const buyers = new Set<string>();
  for (const clone of position.clones) for (const w of clone.rosterWallets) buyers.add(w);

  // Bars are scaled to the busiest row so the tallest is always full width.
  const ownRate = rates[position.mint] ?? 0;
  const peak = Math.max(ownRate, ...position.clones.map((c) => c.tradesPerMin), 1);

  return (
    <article style={position.alerted ? S.panelAlert : S.panel}>
      <header style={S.header}>
        <div style={S.identity}>
          {position.meta?.imageUrl != null && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={position.meta.imageUrl} alt="" width={30} height={30} style={S.avatar} />
          )}
          <div style={{ minWidth: 0 }}>
            <div style={S.symbol}>{symbol}</div>
            <div style={S.name}>{name}</div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          {position.alerted ? (
            <>
              <div style={S.verdict}>Vamped</div>
              <div style={S.score}>{position.score?.toFixed(0) ?? "—"}</div>
            </>
          ) : (
            <>
              <div style={S.watching}>Watching</div>
              <div style={S.countdown}>{formatLeft(secondsLeft)}</div>
            </>
          )}
        </div>
      </header>

      <div style={S.meta}>
        <span>held {held.toFixed(4)} SOL</span>
        <span>
          {buyers.size === 0
            ? position.clones.length === 0
              ? "no clones yet"
              : `${position.clones.length} clone${position.clones.length === 1 ? "" : "s"}, no tracked buyers`
            : `${buyers.size} tracked buyer${buyers.size === 1 ? "" : "s"}`}
        </span>
      </div>

      <div style={S.rows}>
        <Row
          label="yours"
          rate={ownRate}
          peak={peak}
          prices={history[position.mint] ?? []}
          own
        />
        {shown.map((clone) => (
          <Row
            key={clone.mint}
            label={clone.symbol || clone.mint.slice(0, 8)}
            rate={clone.tradesPerMin}
            peak={peak}
            prices={history[clone.mint] ?? []}
            buyers={clone.rosterBuys}
          />
        ))}
        {hidden > 0 && <div style={S.more}>+{hidden} more matching this narrative</div>}
      </div>

      <footer style={S.footer}>
        <span style={S.wallets}>
          {buyers.size === 0 ? " " : namesFor(position.clones).join(", ")}
        </span>
        <a
          href={axiomLink(position.mint)}
          target="_blank"
          rel="noreferrer noopener"
          style={S.action}
        >
          Open on Axiom
        </a>
      </footer>
    </article>
  );
}

function Row({
  label,
  rate,
  peak,
  prices,
  own = false,
  buyers = 0,
}: {
  label: string;
  rate: number;
  peak: number;
  prices: readonly number[];
  own?: boolean;
  buyers?: number;
}) {
  const filled = Math.round((rate / peak) * 18);
  return (
    <div style={S.row}>
      <span style={own ? S.labelOwn : S.label}>{label.slice(0, 12)}</span>
      <span style={S.bar} aria-hidden>
        <span style={{ ...S.barFill, width: `${(filled / 18) * 100}%`, background: own ? "#58a6ff" : "#f0883e" }} />
      </span>
      <span style={S.rate}>{Math.round(rate)}/m</span>
      <Sparkline points={prices} />
      <span style={S.buyers}>{buyers > 0 ? `${buyers} buyer${buyers === 1 ? "" : "s"}` : " "}</span>
    </div>
  );
}

function namesFor(clones: readonly Clone[]): string[] {
  const out: string[] = [];
  for (const clone of clones) {
    if (clone.rosterBuys === 0) continue;
    out.push(`${clone.rosterBuys} on ${clone.symbol || clone.mint.slice(0, 6)}`);
  }
  return out;
}

const formatLeft = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left`;

const S: Record<string, React.CSSProperties> = {
  panel: { background: "#0e1116", border: "1px solid #1b2029", borderRadius: 8, overflow: "hidden" },
  panelAlert: { background: "#17101166", border: "1px solid #f85149", borderRadius: 8, overflow: "hidden" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid #1b2029" },
  identity: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
  avatar: { borderRadius: 5, objectFit: "cover", flexShrink: 0 },
  symbol: { color: "#e6edf3", fontSize: 15, fontWeight: 600, lineHeight: 1.2 },
  name: { color: "#8b949e", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 200 },
  verdict: { color: "#f85149", fontSize: 12, fontWeight: 600, letterSpacing: 0.4 },
  score: { color: "#e6edf3", fontSize: 22, fontWeight: 600, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 },
  watching: { color: "#3fb950", fontSize: 12, fontWeight: 600, letterSpacing: 0.4 },
  countdown: { color: "#8b949e", fontSize: 12, fontVariantNumeric: "tabular-nums" },
  meta: { display: "flex", justifyContent: "space-between", padding: "8px 14px", fontSize: 11, color: "#8b949e", borderBottom: "1px solid #1b2029" },
  rows: { padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6 },
  row: { display: "grid", gridTemplateColumns: "84px 1fr 52px 56px 64px", alignItems: "center", gap: 8 },
  label: { color: "#8b949e", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  labelOwn: { color: "#58a6ff", fontSize: 11, fontWeight: 600 },
  bar: { display: "block", height: 8, background: "#161b22", borderRadius: 2, overflow: "hidden" },
  barFill: { display: "block", height: "100%" },
  rate: { color: "#e6edf3", fontSize: 11, fontVariantNumeric: "tabular-nums", textAlign: "right" },
  buyers: { color: "#f0883e", fontSize: 10, textAlign: "right", whiteSpace: "nowrap" },
  more: { color: "#6e7681", fontSize: 10, paddingTop: 2 },
  footer: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 14px", borderTop: "1px solid #1b2029" },
  wallets: { color: "#f0883e", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  action: { color: "#ffffff", background: "#1f6feb", padding: "6px 12px", borderRadius: 5, fontSize: 11, textDecoration: "none", whiteSpace: "nowrap", fontWeight: 500 },
};
