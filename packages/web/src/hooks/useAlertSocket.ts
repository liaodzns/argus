"use client";

import { useEffect, useRef, useState } from "react";
import { ServerFrameSchema, type PositionState } from "@argus/shared";

export type SocketStatus = "connecting" | "open" | "closed";

/** How many prices to keep per mint. Enough for a sparkline, not a chart. */
const HISTORY = 40;

export interface SocketState {
  status: SocketStatus;
  /** Open positions by mint. A closed one is removed rather than flagged. */
  positions: Record<string, PositionState>;
  /** Recent prices per mint, newest last. */
  history: Record<string, number[]>;
  /** Latest trade rate per mint. */
  rates: Record<string, number>;
  ticks: number;
}

const EMPTY: SocketState = {
  status: "connecting",
  positions: {},
  history: {},
  rates: {},
  ticks: 0,
};

/**
 * Subscribes to the gateway and keeps the panel's state.
 *
 * Frames are parsed, not trusted. The socket is the one boundary where another
 * process changing a schema shows up as bad data rather than a compile error.
 */
export function useAlertSocket(url: string): SocketState {
  const [state, setState] = useState<SocketState>(EMPTY);
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
          if (frame.data.type === "position") {
            const position = frame.data.data;
            const positions = { ...s.positions };
            if (position.closed) {
              // The panel goes away when the watch does. Leaving it up with a
              // "closed" badge would mean the screen slowly fills with history.
              delete positions[position.mint];
            } else {
              positions[position.mint] = position;
            }
            return { ...s, positions };
          }
          const tick = frame.data.data;
          const prices = s.history[tick.mint] ?? [];
          const next =
            tick.priceSol === null ? prices : [...prices, tick.priceSol].slice(-HISTORY);
          return {
            ...s,
            history: { ...s.history, [tick.mint]: next },
            rates: { ...s.rates, [tick.mint]: tick.tradesPerMin },
            ticks: s.ticks + 1,
          };
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
