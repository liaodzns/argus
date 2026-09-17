"use client";

import { useEffect, useState } from "react";
import { PositionPanel } from "../components/PositionPanel";
import { useAlertSocket } from "../hooks/useAlertSocket";

const WS_URL = process.env["NEXT_PUBLIC_WS_URL"] ?? "ws://localhost:8080/ws";

export default function Page() {
  const { status, positions, history, rates, ticks } = useAlertSocket(WS_URL);

  // The countdown on each panel has to move, and nothing else on the page does.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Alerted positions first: if two things are open, the one being taken is
  // the one you need to look at.
  const open = Object.values(positions).sort(
    (a, b) => Number(b.alerted) - Number(a.alerted) || a.openedAt - b.openedAt,
  );

  return (
    <main style={{ maxWidth: 620, margin: "0 auto", padding: "28px 18px 48px" }}>
      <header style={S.header}>
        <h1 style={S.title}>Argus</h1>
        <span style={{ ...S.status, color: status === "open" ? "#3fb950" : "#8b949e" }}>
          {status === "open" ? "Connected" : status === "connecting" ? "Connecting" : "Reconnecting"}
        </span>
      </header>

      {open.length === 0 ? (
        <section style={S.empty}>
          <p style={S.emptyLead}>
            Watching your wallet. A panel opens here the moment you buy.
          </p>
          <p style={S.emptyBody}>
            Every new pump.fun launch is then checked against what you hold, and if tracked
            wallets start buying a clone of it, this panel says so.
          </p>
          <p style={S.emptyFoot}>
            {ticks === 0 ? "Nothing being monitored right now." : `${ticks} updates received.`}
          </p>
        </section>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {open.map((position) => (
            <PositionPanel
              key={position.mint}
              position={position}
              history={history}
              rates={rates}
              now={now}
            />
          ))}
        </div>
      )}
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  header: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 18 },
  title: { fontSize: 15, fontWeight: 600, margin: 0, letterSpacing: 0.2 },
  status: { fontSize: 11 },
  empty: { border: "1px dashed #1b2029", borderRadius: 8, padding: "40px 24px", textAlign: "center" },
  emptyLead: { margin: "0 0 8px", fontSize: 13, color: "#e6edf3" },
  emptyBody: { margin: "0 0 14px", fontSize: 12, color: "#8b949e", lineHeight: 1.5, maxWidth: 400, marginLeft: "auto", marginRight: "auto" },
  emptyFoot: { margin: 0, fontSize: 11, color: "#6e7681" },
};
