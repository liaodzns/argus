/**
 * Reconnection and liveness.
 *
 * The failure this exists to prevent: a stream that stops delivering looks
 * exactly like a quiet market. That is the worst failure mode this product has,
 * because the wall stays up, nothing errors, and you conclude nothing is
 * running. So silence is treated as a fault and escalated, never waited out.
 */

export interface BackoffOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Exponential backoff with full jitter. Jitter matters even for a single
 * client: without it a provider blip lines every reconnect attempt up on the
 * same tick, and the retry storm keeps the connection from recovering.
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const min = options.minDelayMs ?? 500;
  const max = options.maxDelayMs ?? 30_000;
  const ceiling = Math.min(max, min * 2 ** Math.min(attempt, 16));
  return Math.floor(min + Math.random() * (ceiling - min));
}

/**
 * Fires when nothing has arrived for `timeoutMs`.
 *
 * Kick it on every inbound frame, including keepalives. The handler should tear
 * the connection down rather than log and hope — a socket that is open but
 * mute is worse than one that is closed, because only the closed one reconnects.
 */
export class SilenceWatchdog {
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #timeoutMs: number;
  readonly #onSilent: () => void;

  constructor(timeoutMs: number, onSilent: () => void) {
    this.#timeoutMs = timeoutMs;
    this.#onSilent = onSilent;
  }

  kick(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(this.#onSilent, this.#timeoutMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

export interface ReconnectOptions extends BackoffOptions {
  /** Called before each retry, with the attempt number and the chosen delay. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/**
 * Run one connection attempt after another until the signal aborts.
 *
 * `connect` should resolve when its session ends and reject when it fails; both
 * lead to a retry, because a stream that closes cleanly on its own is still a
 * stream that stopped.
 */
export async function runWithReconnect(
  connect: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  options: ReconnectOptions = {},
): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      await connect(signal);
      if (signal.aborted) return;
      attempt += 1;
      options.onRetry?.(attempt, backoffDelay(attempt, options), new Error("stream closed"));
    } catch (error) {
      if (signal.aborted) return;
      attempt += 1;
      options.onRetry?.(attempt, backoffDelay(attempt, options), error);
    }
    const delay = backoffDelay(attempt, options);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, delay);
      t.unref();
      signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}
