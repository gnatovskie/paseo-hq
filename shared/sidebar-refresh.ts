/**
 * Sidebar refresh pacing. Each full reload lists projects, workspaces,
 * terminals, the sidebar state and branches, and the agent list carries every
 * agent's full snapshot (tens of KB each). On a slow client link, reloading on
 * every workspace event and every few seconds saturates the connection and
 * delays chat updates. Agents stay live through their own subscription, so the
 * full agent list is only a periodic resync for missed events.
 */
export const SIDEBAR_COALESCE_MS = 1_500;
export const SIDEBAR_PERIODIC_MS = 30_000;
export const SIDEBAR_AGENT_RESYNC_MS = 120_000;

type Timer = unknown;

export interface RefreshScheduler {
  request(): void;
  stop(): void;
}

/** Coalesces reload requests: at most one reload in flight and one queued. */
export function createRefreshScheduler(options: {
  run: () => Promise<void> | void;
  coalesceMs?: number;
  setTimeout?: (fn: () => void, ms: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
}): RefreshScheduler {
  const coalesceMs = options.coalesceMs ?? SIDEBAR_COALESCE_MS;
  const schedule = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const cancel = options.clearTimeout ?? (timer => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>));
  let timer: Timer | null = null;
  let running = false;
  let pending = false;
  let stopped = false;

  const fire = async () => {
    timer = null;
    if (stopped) return;
    running = true;
    try {
      await options.run();
    } catch {
      // A failed reload keeps the previous snapshot. The next request retries.
    } finally {
      running = false;
    }
    if (pending && !stopped) {
      pending = false;
      request();
    }
  };

  function request() {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    if (timer === null) timer = schedule(() => void fire(), coalesceMs);
  }

  return {
    request,
    stop() {
      stopped = true;
      if (timer !== null) cancel(timer);
      timer = null;
    },
  };
}

/** The full agent list is needed on first load, on demand and as a slow resync. */
export function shouldFetchAgents(lastFetchedAt: number | null, now: number, force = false): boolean {
  return force || lastFetchedAt === null || now - lastFetchedAt >= SIDEBAR_AGENT_RESYNC_MS;
}
