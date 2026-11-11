import type { PaseoApi, PaseoProviderSnapshotResult } from "@getpaseo/client";

// Снимок провайдеров демон собирает отдельно для каждой папки: новая папка запускает опрос провайдеров заново.
// Поэтому ключ - корень проекта, а не папка каждой области или worktree, снимок живет несколько минут,
// а параллельные запросы к одному ключу объединяются в один.
const MAX_AGE_MS = 10 * 60_000;

interface Entry {
  at: number;
  snapshot: PaseoProviderSnapshotResult;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<PaseoProviderSnapshotResult>>();

const keyOf = (cwd?: string) => cwd ?? "";

/** Последний известный снимок любого возраста: чтобы показать список сразу, пока идет обновление. */
export function peekProviders(cwd?: string) {
  return cache.get(keyOf(cwd))?.snapshot;
}

/** После ошибки «модель недоступна»: следующий запрос возьмет свежий снимок. */
export function clearProviders() {
  cache.clear();
}

type Update = (snapshot: PaseoProviderSnapshotResult) => void;
const listeners = new Map<string, Set<Update>>();

export function providersSnapshot(paseo: PaseoApi, cwd?: string, { force = false, onUpdate }: { force?: boolean; onUpdate?: Update } = {}) {
  const key = keyOf(cwd);
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.at < MAX_AGE_MS) return Promise.resolve(cached.snapshot);
  if (onUpdate) {
    const updates = listeners.get(key) ?? new Set<Update>();
    updates.add(onUpdate);
    listeners.set(key, updates);
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const publish = (snapshot: PaseoProviderSnapshotResult) => {
    for (const update of listeners.get(key) ?? []) update(snapshot);
  };
  const options = cwd ? { cwd } : {};
  const request = paseo.providers.snapshot(options)
    .then(async snapshot => {
      publish(snapshot);
      if (!snapshot.entries.some(entry => entry.status === "loading")) return snapshot;
      // Show each provider as soon as its options are ready, even if another is slow.
      const unsubscribe = paseo.providers.subscribe(update => {
        if (update.cwd === snapshot.cwd) publish({ ...update, requestId: snapshot.requestId });
      });
      try { return await paseo.providers.waitForReady(options); }
      finally { unsubscribe(); }
    })
    .then((snapshot) => {
      cache.set(key, { at: Date.now(), snapshot });
      return snapshot;
    })
    .finally(() => { inflight.delete(key); listeners.delete(key); });
  inflight.set(key, request);
  return request;
}
