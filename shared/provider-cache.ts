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

export function providersSnapshot(paseo: PaseoApi, cwd?: string, { force = false } = {}) {
  const key = keyOf(cwd);
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.at < MAX_AGE_MS) return Promise.resolve(cached.snapshot);
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = paseo.providers.waitForReady(cwd ? { cwd } : {})
    .then((snapshot) => {
      cache.set(key, { at: Date.now(), snapshot });
      return snapshot;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}
