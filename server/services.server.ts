import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceRow } from "../shared/services-contracts";
import { loadCatalog } from "./services-catalog.server";

const exec = promisify(execFile);

export function status(p: Record<string, string>, scheduled: boolean): string {
  if (p.LoadState === "not-found") return "Не установлена";
  if (p.ActiveState === "failed" || (p.Result && p.Result !== "success")) return "Ошибка";
  if (p.ActiveState === "activating" || (p.ActiveState === "active" && p.SubState === "running")) return "Работает";
  if (p.ActiveState === "active" && p.SubState === "exited") return "Активна";
  if (scheduled) return p.ExecMainStartTimestamp ? "Завершено" : "Еще не запускалась";
  return "Остановлена";
}

/** Catalog keys prefixed with "user:" are queried via `systemctl --user`. */
export const USER_PREFIX = "user:";

async function readScope(
  catalog: Record<string, [string, string]>,
  keys: string[],
  user: boolean,
): Promise<ServiceRow[]> {
  if (keys.length === 0) return [];
  const scopeArgs = user ? ["--user"] : [];
  const units = keys.map((k) => (user ? k.slice(USER_PREFIX.length) : k));

  try {
    const { stdout: timersText } = await exec(
      "systemctl",
      [...scopeArgs, "list-timers", "--all", "--no-pager", "--output=json"],
      { timeout: 8000, maxBuffer: 1024 * 1024 }
    ).catch(() => ({ stdout: "[]" }));

    let timers: { activates: string; unit: string }[] = [];
    try {
      timers = JSON.parse(timersText);
    } catch {
      timers = [];
    }

    const scheduled = new Set(timers.map((t) => t.activates));
    const { stdout } = await exec(
      "systemctl",
      [
        ...scopeArgs,
        "show",
        ...units,
        "-p",
        "Id,LoadState,ActiveState,SubState,Result,ExecMainStartTimestamp,ActiveEnterTimestamp",
      ],
      { timeout: 8000, maxBuffer: 1024 * 1024 }
    );

    const rows: ServiceRow[] = [];
    for (const block of stdout.trim().split(/\n\s*\n/)) {
      if (!block.trim()) continue;
      const p = Object.fromEntries(
        block.split("\n").map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i), l.slice(i + 1)];
        })
      );
      const key = user ? USER_PREFIX + p.Id : p.Id;
      const entry = catalog[key];
      if (!entry || p.LoadState === "not-found") continue;
      const isScheduled = scheduled.has(p.Id);
      rows.push({
        id: key,
        name: entry[0],
        description: entry[1],
        kind: isScheduled ? "По расписанию" : "Постоянная",
        lastRun: p.ExecMainStartTimestamp || p.ActiveEnterTimestamp || null,
        status: status(p, isScheduled),
      });
    }
    return rows;
  } catch {
    // systemctl unavailable (macOS, container without systemd, no user manager): this scope is empty
    return [];
  }
}

export async function readServices(): Promise<{ rows: ServiceRow[] }> {
  const currentCatalog = loadCatalog();
  const keys = Object.keys(currentCatalog);
  const systemKeys = keys.filter((k) => !k.startsWith(USER_PREFIX));
  const userKeys = keys.filter((k) => k.startsWith(USER_PREFIX));
  // Scopes are independent: a failure in one must not hide the other.
  const [system, user] = await Promise.all([
    readScope(currentCatalog, systemKeys, false),
    readScope(currentCatalog, userKeys, true),
  ]);
  return { rows: [...system, ...user] };
}
