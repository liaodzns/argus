"use client";

/**
 * A price trace, small enough to read without looking at it.
 *
 * Inline SVG rather than a charting library: this is a dozen points of one
 * series with no axes, no interaction and no tooltip. The candle panel that
 * justified `lightweight-charts` is gone, and so is the dependency.
 *
 * Scaled to its own minimum and maximum, so the shape is the information and
 * the absolute level is not. pump.fun prices sit around 1e-8, where a shared
 * scale would flatten every trace to a line.
 */
export function Sparkline({
  points,
  width = 56,
  height = 16,
}: {
  points: readonly number[];
  width?: number;
  height?: number;
}) {
  const usable = points.filter((p) => Number.isFinite(p) && p > 0);
  if (usable.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden style={{ display: "block" }}>
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="#30363d" strokeWidth={1} />
      </svg>
    );
  }

  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const span = max - min || 1;
  const step = width / (usable.length - 1);
  const path = usable
    .map((p, i) => {
      const x = i * step;
      // 1.5px inset so a flat top or bottom is not clipped to the edge.
      const y = height - 1.5 - ((p - min) / span) * (height - 3);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const last = usable[usable.length - 1] ?? 0;
  const first = usable[0] ?? 0;
  const rising = last >= first;

  return (
    <svg width={width} height={height} aria-hidden style={{ display: "block" }}>
      <path d={path} fill="none" stroke={rising ? "#3fb950" : "#f85149"} strokeWidth={1.25} />
    </svg>
  );
}
