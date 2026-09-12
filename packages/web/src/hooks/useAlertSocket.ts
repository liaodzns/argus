"use client";

import { useEffect, useRef, useState } from "react";
import { ServerFrameSchema, type AlertPayload, type PanelTick } from "@argus/shared";

export type SocketStatus = "connecting" | "open" | "closed";

export interface SocketState {
  status: SocketStatus;
  alerts: AlertPayload[];
  /** Latest tick per mint. Panels read their own. */
  ticks: Record<string, PanelTick>;
  evaluated: number;
}

/**
 * Subscribes to the gateway and keeps the newest alert per mint.
 *
 * Frames are parsed, not trusted. The socket is the one place where a schema
 * change in another process shows up as bad data rather than a compile error,
 * so it gets checked here.
 */
export function useAlertSocket(url: string): SocketState {
  const [state, setState] = useState<SocketState>({
    status: "connecting",
    alerts: [],
    ticks: {},
    evaluated: 0,
  });
  const retry = useRef(0);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = (): void => {
      socket = new WebSocket(url);
      socket.onopen = () => {
        retry.current = 0;
        setState((s) => ({ ...s, status: "open" }));
      };
      socket.onclose = () => {
        if (closed) return;
        setState((s) => ({ ...s, status: "closed" }));
        // Backoff with jitter, capped. A gateway restart should not be met with
        // a tight reconnect loop from every open tab.
        const delay = Math.min(15_000, 500 * 2 ** retry.current) * (0.5 + Math.random() / 2);
        retry.current += 1;
        timer = setTimeout(connect, delay);
      };
      socket.onmessage = (event: MessageEvent<string>) => {
        let json: unknown;
        try {
          json = JSON.parse(event.data);
        } catch {
          return;
        }
        const frame = ServerFrameSchema.safeParse(json);
        if (!frame.success) return;

        setState((s) => {
          if (frame.data.type === "tick") {
            const tick = frame.data.data;
            return { ...s, ticks: { ...s.ticks, [tick.mint]: tick }, evaluated: s.evaluated + 1 };
          }
          const alert = frame.data.data;
          const rest = s.alerts.filter((a) => a.mint !== alert.mint);
          return { ...s, alerts: [alert, ...rest], evaluated: s.evaluated + 1 };
        });
      };
    };

    connect();
    return () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      socket?.close();
    };
  }, [url]);

  return state;
}
