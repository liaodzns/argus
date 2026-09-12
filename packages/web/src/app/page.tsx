"use client";

import { ChartPanel } from "../components/ChartPanel";
import { useAlertSocket } from "../hooks/useAlertSocket";

const WS_URL = process.env["NEXT_PUBLIC_WS_URL"] ?? "ws://localhost:8080/ws";

/**
 * One panel, which is the whole of step 5. The wall, with ordering, eviction
 * and pinning, is step 8.
 */
export default function Page() {
  const { status, alerts, ticks, evaluated } = useAlertSocket(WS_URL);
  const alert = alerts[0];

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "32px 20px" }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ fontSize: 15, fontWeight: 600, margin: 0, letterSpacing: 0.2 }}>Argus</h1>
        <span style={{ fontSize: 11, color: status === "open" ? "#3fb950" : "#8b949e" }}>
          {status === "open" ? "Watching" : status === "connecting" ? "Connecting" : "Reconnecting"}
        </span>
      </header>

      {alert === undefined ? (
        <section style={{ border: "1px dashed #1b2029", borderRadius: 6, padding: "48px 24px", textAlign: "center" }}>
          <p style={{ margin: "0 0 6px", fontSize: 13, color: "#e6edf3" }}>
            Watching every new pump.fun token for volume acceleration and wallets you follow.
          </p>
          <p style={{ margin: 0, fontSize: 12, color: "#6e7681" }}>
            {evaluated === 0
              ? "Nothing has crossed the threshold yet. A panel opens here the moment something does."
              : `${evaluated} events evaluated. A panel opens here the moment something crosses.`}
          </p>
        </section>
      ) : (
        <ChartPanel alert={alert} tick={ticks[alert.mint]} />
      )}
    </main>
  );
}
