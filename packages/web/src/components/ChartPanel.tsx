"use client";

import { useEffect, useRef } from "react";
import { createChart, ColorType, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { AlertPayload, PanelTick } from "@argus/shared";
import { axiomLink } from "../lib/axiomLink";

/**
 * One panel.
 *
 * Rendered directly from the tick stream. No iframe: twelve embedded charts
 * lock a browser up and each takes seconds to appear, which defeats the whole
 * premise of watching several things at once.
 */
export function ChartPanel({ alert, tick }: { alert: AlertPayload; tick: PanelTick | undefined }) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const bucket = useRef<{ time: number; open: number; high: number; low: number; close: number } | null>(null);

  useEffect(() => {
    if (container.current === null) return;
    const instance = createChart(container.current, {
      layout: { background: { type: ColorType.Solid, color: "#0e1116" }, textColor: "#8b949e", fontSize: 11 },
      grid: { vertLines: { color: "#1b2029" }, horzLines: { color: "#1b2029" } },
      rightPriceScale: { borderColor: "#1b2029" },
      timeScale: { borderColor: "#1b2029", timeVisible: true, secondsVisible: true },
      crosshair: { mode: 0 },
      handleScale: false,
      handleScroll: false,
      height: 260,
    });
    series.current = instance.addCandlestickSeries({
      upColor: "#3fb950", downColor: "#f85149",
      borderUpColor: "#3fb950", borderDownColor: "#f85149",
      wickUpColor: "#3fb950", wickDownColor: "#f85149",
      // pump.fun prices sit around 1e-8 SOL, so the default 2 decimals would
      // render every candle as a flat zero.
      priceFormat: { type: "price", precision: 10, minMove: 0.0000000001 },
    });
    chart.current = instance;

    const resize = () => {
      if (container.current !== null) instance.applyOptions({ width: container.current.clientWidth });
    };
    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      instance.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    if (tick === undefined || series.current === null) return;
    // Five-second candles, bucketed on block time. The engine sends ticks; the
    // browser only decides which candle a tick belongs to.
    const time = Math.floor(tick.blockTime / 5000) * 5;
    const price = tick.priceSol;
    const current = bucket.current;
    const next =
      current === null || current.time !== time
        ? { time, open: price, high: price, low: price, close: price }
        : {
            time,
            open: current.open,
            high: Math.max(current.high, price),
            low: Math.min(current.low, price),
            close: price,
          };
    bucket.current = next;
    series.current.update({
      time: next.time as UTCTimestamp,
      open: next.open, high: next.high, low: next.low, close: next.close,
    });
  }, [tick]);

  const price = tick?.priceSol ?? null;

  return (
    <article style={S.panel}>
      <header style={S.header}>
        <div style={S.identity}>
          {alert.meta.imageUrl !== null && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={alert.meta.imageUrl} alt="" width={28} height={28} style={S.avatar} />
          )}
          <div>
            <div style={S.symbol}>{alert.meta.symbol}</div>
            <div style={S.name}>{alert.meta.name}</div>
          </div>
        </div>
        <div style={S.score}>{alert.score.toFixed(0)}</div>
      </header>

      <div ref={container} style={S.chart} />

      <dl style={S.stats}>
        <div style={S.stat}><dt style={S.dt}>Price</dt><dd style={S.dd}>{price === null ? "—" : price.toExponential(3)}</dd></div>
        <div style={S.stat}><dt style={S.dt}>Volume 1m</dt><dd style={S.dd}>{tick === undefined ? "—" : `${tick.volumeSol1m.toFixed(2)} SOL`}</dd></div>
        <div style={S.stat}><dt style={S.dt}>Buyers 1m</dt><dd style={S.dd}>{tick?.buyers1m ?? "—"}</dd></div>
        <div style={S.stat}><dt style={S.dt}>KOLs</dt><dd style={S.dd}>{alert.kols.length}</dd></div>
      </dl>

      <footer style={S.footer}>
        <span style={S.kols}>{alert.kols.map((k) => k.label).join(", ") || "No watched wallets"}</span>
        <a href={axiomLink(alert.mint)} target="_blank" rel="noreferrer noopener" style={S.action}>
          Open on Axiom
        </a>
      </footer>
    </article>
  );
}

const S: Record<string, React.CSSProperties> = {
  panel: { background: "#0e1116", border: "1px solid #1b2029", borderRadius: 6, overflow: "hidden", display: "flex", flexDirection: "column" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "1px solid #1b2029" },
  identity: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
  avatar: { borderRadius: 4, objectFit: "cover", flexShrink: 0 },
  symbol: { color: "#e6edf3", fontSize: 14, fontWeight: 600, lineHeight: 1.2 },
  name: { color: "#8b949e", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 },
  score: { color: "#e6edf3", fontSize: 20, fontVariantNumeric: "tabular-nums", fontWeight: 600 },
  chart: { width: "100%" },
  stats: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 0, margin: 0, padding: 0, borderTop: "1px solid #1b2029" },
  stat: { padding: "8px 12px", borderRight: "1px solid #1b2029" },
  dt: { color: "#6e7681", fontSize: 10, margin: 0 },
  dd: { color: "#e6edf3", fontSize: 12, margin: "2px 0 0", fontVariantNumeric: "tabular-nums" },
  footer: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 12px", borderTop: "1px solid #1b2029" },
  kols: { color: "#8b949e", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  action: { color: "#e6edf3", background: "#1f6feb", padding: "5px 10px", borderRadius: 4, fontSize: 11, textDecoration: "none", whiteSpace: "nowrap" },
};
