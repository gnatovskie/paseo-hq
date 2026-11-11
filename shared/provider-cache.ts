import type { PaseoApi, PaseoProviderSnapshotResult } from "@getpaseo/client";
import { expandProviderSnapshot } from "@getpaseo/protocol/provider-snapshot-codec";

// Catalog scope is provider-specific (Codex shares its catalog across directories).
// Reuse project-root snapshots within one host client, never across host clients.
const MAX_AGE_MS = 10 * 60_000;
type Snapshot = PaseoProviderSnapshotResult;
type Update = (snapshot: Snapshot) => void;
interface Entry { at: number; snapshot: Snapshot }
interface State {
  cache: Map<string, Entry>;
  inflight: Map<string, Promise<Snapshot>>;
  listeners: Map<string, Set<Update>>;
}
const states = new WeakMap<PaseoApi, State>();
function stateFor(paseo: PaseoApi) {
  let state = states.get(paseo);
  if (!state) {
    state = { cache: new Map(), inflight: new Map(), listeners: new Map() };
    states.set(paseo, state);
  }
  return state;
}
export function peekProviders(paseo: PaseoApi, cwd?: string) {
  return stateFor(paseo).cache.get(cwd ?? "")?.snapshot;
}
export function clearProviders(paseo: PaseoApi) {
  stateFor(paseo).cache.clear();
}

export function providersSnapshot(paseo: PaseoApi, cwd?: string, { force = false, onUpdate }: { force?: boolean; onUpdate?: Update } = {}) {
  const state = stateFor(paseo);
  const key = cwd ?? "";
  const cached = state.cache.get(key);
  if (!force && cached && Date.now() - cached.at < MAX_AGE_MS) return Promise.resolve(cached.snapshot);
  if (onUpdate) {
    const listeners = state.listeners.get(key) ?? new Set<Update>();
    listeners.add(onUpdate);
    state.listeners.set(key, listeners);
  }
  const pending = state.inflight.get(key);
  if (pending) return pending;
  const options = cwd ? { cwd } : {};
  const request = new Promise<Snapshot>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    let bodyRequest: Promise<Snapshot> | undefined;
    const finish = (error?: unknown, snapshot?: Snapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      if (error) reject(error);
      else resolve(snapshot!);
    };
    const timeout = setTimeout(() => finish(new Error("Каталог провайдеров не загрузился за 60 секунд")), 60_000);
    const publish = (raw: Snapshot) => {
      if (settled) return;
      // Mobile host clients deliberately keep snapshots in compact wire form.
      // The SDK's waitForReady sees entries=[] as ready, so decode before testing readiness.
      const snapshot = raw.compactSnapshot ? { ...raw, entries: expandProviderSnapshot(raw.compactSnapshot) } : raw;
      const ready = !snapshot.entries.some(entry => entry.status === "loading");
      state.cache.set(key, { at: ready ? Date.now() : 0, snapshot });
      for (const update of state.listeners.get(key) ?? []) update(snapshot);
      if (ready) finish(undefined, snapshot);
    };
    const receive = (raw: Snapshot) => {
      if (settled) return;
      try {
        // Live updates may carry only a hash. Never turn that reference into an empty catalog.
        if (raw.snapshotHash && !raw.compactSnapshot && !raw.entries.length) {
          const known = state.cache.get(key)?.snapshot;
          if (known?.snapshotHash === raw.snapshotHash && known.entries.length) {
            publish({ ...raw, entries: known.entries });
          } else if (!bodyRequest) {
            bodyRequest = paseo.providers.snapshot(options);
            void bodyRequest.then(body => {
              bodyRequest = undefined;
              if (body.snapshotHash && !body.compactSnapshot && !body.entries.length) {
                throw new Error("Сервер вернул ссылку на каталог без его содержимого");
              }
              publish(body);
            }).catch(error => finish(error));
          }
        } else publish(raw);
      } catch (error) { finish(error); }
    };
    try {
      unsubscribe = paseo.providers.subscribe(update => {
        if (update.cwd === cwd || update.cwd === state.cache.get(key)?.snapshot.cwd) {
          receive({ ...update, requestId: "provider-update" });
        }
      });
      void paseo.providers.snapshot(options).then(receive).catch(error => finish(error));
    } catch (error) { finish(error); }
  }).finally(() => {
    state.inflight.delete(key);
    state.listeners.delete(key);
  });
  state.inflight.set(key, request);
  return request;
}
