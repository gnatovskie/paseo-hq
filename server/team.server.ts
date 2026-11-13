import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import {
  EMPTY_BOARD,
  boardConfigSchema,
  boardSchema,
  taskSchema,
  boardDisplayName,
  mergeBoard,
  newId,
  parseBoard,
  type BoardConfig,
  type TeamBoard,
} from "../shared/team-model.ts";

const execFileAsync = promisify(execFile);

export const BOARD_FILE = "hq.json";
export const PENDING_FILE = "hq.pending.json";
const CONFIG_FILE = () =>
  process.env.PASEO_HQ_TEAM_CONFIG || join(homedir(), ".local", "state", "paseo-hq", "team.json");
const BASE_DIR = () =>
  process.env.PASEO_HQ_TEAM_DIR || join(homedir(), ".local", "state", "paseo-hq");

/** Как часто отправлять накопленные правки в git. */
export const FLUSH_INTERVAL_MS = 60_000;

let cachedConfigs: BoardConfig[] | null = null;
let cachedActiveBoardId: string | null = null;
let cachedConfigPath: string | null = null;

function checkCachePath(): void {
  const current = CONFIG_FILE();
  if (cachedConfigPath !== current) {
    cachedConfigs = null;
    cachedActiveBoardId = null;
    cachedConfigPath = current;
  }
}

interface Draft {
  board: TeamBoard;
  removedTaskIds: Set<string>;
  removedMemberIds: Set<string>;
  dirty: boolean;
  revision: number;
}

const drafts = new Map<string, Draft>();
let hydration: Promise<void> | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}.git`;
  }
  return trimmed;
}

export function canonicalRepoKey(raw: string): string {
  const trimmed = normalizeUrl(raw);
  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2].replace(/^\/+/, "")}`.toLowerCase();
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "file:") {
      return parsed.pathname.replace(/\.git\/?$/, "").replace(/\/+$/, "");
    }
    const host = parsed.host.toLowerCase();
    const pathname = parsed.pathname.replace(/\.git\/?$/, "").replace(/^\/+/, "").replace(/\/+$/, "");
    return `${host}/${pathname}`.toLowerCase();
  } catch {
    return trimmed.replace(/\.git\/?$/, "").replace(/\/+$/, "").toLowerCase();
  }
}

export function sameRepoUrl(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  return canonicalRepoKey(a) === canonicalRepoKey(b);
}

function errorText(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const text = [e?.stderr, e?.stdout, e?.message].filter(Boolean).join("\n").trim();
  return text.split("\n").slice(0, 4).join(" ").slice(0, 400) || "неизвестная ошибка git";
}

async function git(cwd: string, args: string[], timeout = 60000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

async function isRepo(dir: string): Promise<boolean> {
  return stat(join(dir, ".git"))
    .then((s) => s.isDirectory() || s.isFile())
    .catch(() => false);
}

async function hasHead(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function configureGit(dir: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("which", ["gh"]);
    if (stdout.trim()) {
      await git(dir, ["config", "credential.helper", "!gh auth git-credential"]).catch(() => undefined);
    }
  } catch {
    // gh нет - останется обычная авторизация git (ssh-ключи или helper)
  }
  try {
    await git(dir, ["config", "user.name"]);
  } catch {
    await git(dir, ["config", "user.name", "Paseo HQ"]).catch(() => undefined);
    await git(dir, ["config", "user.email", "paseo-hq@localhost"]).catch(() => undefined);
  }
}

async function remoteUrl(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ["remote", "get-url", "origin"])).trim();
  } catch {
    return null;
  }
}

export async function readConfigFile(): Promise<{ boards: BoardConfig[]; activeBoardId: string | null }> {
  checkCachePath();
  if (cachedConfigs) {
    return { boards: cachedConfigs, activeBoardId: cachedActiveBoardId };
  }
  const file = CONFIG_FILE();
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as { boards?: unknown; activeBoardId?: unknown };
    const boards = Array.isArray(raw?.boards)
      ? raw.boards
          .map((b) => boardConfigSchema.safeParse(b))
          .filter((r) => r.success)
          .map((r) => (r as { data: BoardConfig }).data)
      : [];
    const activeBoardId = typeof raw?.activeBoardId === "string" ? raw.activeBoardId : null;
    cachedConfigs = boards;
    cachedActiveBoardId = activeBoardId;
    return { boards, activeBoardId };
  } catch {
    cachedConfigs = [];
    cachedActiveBoardId = null;
    return { boards: [], activeBoardId: null };
  }
}

export async function readConfigs(): Promise<BoardConfig[]> {
  const { boards } = await readConfigFile();
  return boards;
}

export async function getActiveBoardId(): Promise<string | null> {
  const { activeBoardId, boards } = await readConfigFile();
  if (activeBoardId && boards.some((b) => b.id === activeBoardId)) {
    return activeBoardId;
  }
  return boards[0]?.id ?? null;
}

export async function setActiveBoardId(boardId: string): Promise<string> {
  const { boards } = await readConfigFile();
  const found = boards.find((b) => b.id === boardId);
  if (!found) {
    throw new Error("доска не найдена");
  }
  await writeConfigFile(boards, boardId);
  return boardId;
}

export async function writeConfigFile(boards: BoardConfig[], activeBoardId?: string | null): Promise<void> {
  const file = CONFIG_FILE();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const active =
    activeBoardId !== undefined
      ? activeBoardId
      : cachedActiveBoardId && boards.some((b) => b.id === cachedActiveBoardId)
        ? cachedActiveBoardId
        : (boards[0]?.id ?? null);
  const payload = {
    activeBoardId: active,
    boards,
  };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
  cachedConfigs = boards;
  cachedActiveBoardId = active;
}

export async function writeConfigs(boards: BoardConfig[]): Promise<void> {
  await writeConfigFile(boards);
}

async function getConfig(boardId: string): Promise<BoardConfig | undefined> {
  const configs = await readConfigs();
  return configs.find((b) => b.id === boardId);
}

export async function ensureRepo(cfg: BoardConfig): Promise<void> {
  if (!(await isRepo(cfg.dir))) {
    await mkdir(dirname(cfg.dir), { recursive: true, mode: 0o700 });
    try {
      await execFileAsync("git", ["clone", "--", cfg.url, cfg.dir], {
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
    } catch (err) {
      throw new Error(`не удалось склонировать репозиторий: ${errorText(err)}`);
    }
  } else {
    const origin = await remoteUrl(cfg.dir);
    if (origin && !sameRepoUrl(origin, cfg.url)) {
      throw new Error("к папке уже подключён другой репозиторий, сначала отключите текущую доску");
    }
  }

  await configureGit(cfg.dir);

  if (!(await hasHead(cfg.dir))) {
    const remoteBranch = await git(cfg.dir, ["rev-parse", "--verify", `refs/remotes/origin/${cfg.branch}`])
      .then(() => true)
      .catch(() => false);
    if (remoteBranch) {
      await git(cfg.dir, ["checkout", "-q", "-B", cfg.branch, `origin/${cfg.branch}`]);
    } else {
      await git(cfg.dir, ["symbolic-ref", "HEAD", `refs/heads/${cfg.branch}`]);
    }
    return;
  }

  const branchExists = await git(cfg.dir, ["rev-parse", "--verify", `refs/heads/${cfg.branch}`])
    .then(() => true)
    .catch(() => false);
  if (!branchExists) {
    await git(cfg.dir, ["checkout", "-q", "-b", cfg.branch]);
  } else {
    const current = (await git(cfg.dir, ["branch", "--show-current"])).trim();
    if (current !== cfg.branch) await git(cfg.dir, ["checkout", "-q", cfg.branch]);
  }
}

export async function pullRepo(cfg: BoardConfig): Promise<void> {
  await ensureRepo(cfg);
  if (!(await hasHead(cfg.dir))) return;
  try {
    await git(cfg.dir, ["pull", "--rebase", "--autostash", "origin", cfg.branch], 120000);
  } catch (err) {
    await git(cfg.dir, ["rebase", "--abort"]).catch(() => undefined);
    const text = errorText(err);
    if (/couldn't find remote ref|no such ref|not found/i.test(text)) return;
    throw new Error(`не удалось обновить доску: ${text}`);
  }
}

export async function readBoard(cfg: BoardConfig): Promise<TeamBoard> {
  let shared = { ...EMPTY_BOARD };
  try {
    shared = parseBoard(JSON.parse(await readFile(join(cfg.dir, BOARD_FILE), "utf8")));
  } catch {
    // An empty/new shared repository is a valid board.
  }
  const local = await readLocalState(cfg);
  // Never adopt another host's personal tasks from legacy shared JSON.
  const tasks = new Map(shared.tasks.filter((task) => !task.personal).map((task) => [task.id, task]));
  for (const task of local.personalTasks) tasks.set(task.id, task);
  return { ...shared, tasks: [...tasks.values()] };
}

const pendingSchema = z.object({
  board: boardSchema,
  removedTaskIds: z.array(z.string()).default([]),
  removedMemberIds: z.array(z.string()).default([]),
});
const localStateSchema = z.object({
  personalTasks: z.array(taskSchema).refine((tasks) => tasks.every((task) => task.personal)),
  pending: pendingSchema.optional(),
});
type LocalState = z.infer<typeof localStateSchema>;

function localStatePath(cfg: BoardConfig): string {
  // Stable across disconnect/reconnect, but isolated per repository and branch.
  const url = isAbsolute(cfg.url) ? pathToFileURL(cfg.url).href : cfg.url;
  const key = createHash("sha256").update(JSON.stringify([canonicalRepoKey(url), cfg.branch])).digest("hex");
  const path = resolve(BASE_DIR(), "local-boards", `${key}.json`);
  if (path.startsWith(resolve(cfg.dir) + sep)) throw new Error("личные задачи нельзя хранить внутри Git-доски");
  return path;
}

function missingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function readLocalState(cfg: BoardConfig): Promise<LocalState> {
  try {
    return localStateSchema.parse(JSON.parse(await readFile(localStatePath(cfg), "utf8")));
  } catch (error) {
    if (!missingFile(error)) throw error; // Do not silently erase corrupt/private data.
  }
  try {
    const pending = pendingSchema.parse(JSON.parse(await readFile(join(cfg.dir, PENDING_FILE), "utf8")));
    return { personalTasks: pending.board.tasks.filter((task) => task.personal), pending };
  } catch (error) {
    if (!missingFile(error)) throw error;
    return { personalTasks: [] };
  }
}

// Serialize the entire local-file transaction, including flush acknowledgment.
// A newer edit's pending snapshot must never be overtaken by an older write/cleanup.
const localWrites = new Map<string, Promise<void>>();
async function withLocalWrite(cfg: BoardConfig, operation: () => Promise<void>): Promise<void> {
  const key = localStatePath(cfg);
  const next = (localWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  localWrites.set(key, next);
  try {
    await next;
  } finally {
    if (localWrites.get(key) === next) localWrites.delete(key);
  }
}

async function writeLocalState(cfg: BoardConfig, state: LocalState): Promise<void> {
  const path = localStatePath(cfg);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
  // A legacy pending file is removed only after its replacement is safely written.
  await unlink(join(cfg.dir, PENDING_FILE)).catch((error: unknown) => {
    if (!missingFile(error)) throw error;
  });
}

async function readPending(cfg: BoardConfig): Promise<Draft | null> {
  const { pending } = await readLocalState(cfg);
  if (!pending) return null;
  return {
    board: pending.board,
    removedTaskIds: new Set(pending.removedTaskIds),
    removedMemberIds: new Set(pending.removedMemberIds),
    dirty: true,
    revision: 0,
  };
}

async function writePending(cfg: BoardConfig, draft: Draft): Promise<void> {
  const pending = structuredClone({
    board: draft.board,
    removedTaskIds: [...draft.removedTaskIds],
    removedMemberIds: [...draft.removedMemberIds],
  });
  const state: LocalState = { personalTasks: pending.board.tasks.filter((task) => task.personal), pending };
  await withLocalWrite(cfg, () => writeLocalState(cfg, state));
}

async function removePending(cfg: BoardConfig): Promise<void> {
  await withLocalWrite(cfg, async () => {
    const state = await readLocalState(cfg);
    await writeLocalState(cfg, { personalTasks: state.personalTasks });
  });
}

async function doHydrate(): Promise<void> {
  const configs = await readConfigs();
  for (const cfg of configs) {
    const draft = await readPending(cfg);
    if (draft) {
      drafts.set(cfg.id, draft);
      await writePending(cfg, draft); // Also migrates legacy pending data outside Git.
    }
  }
  if ([...drafts.values()].some((d) => d.dirty)) scheduleFlush();
}

function ensureHydrated(): Promise<void> {
  if (!hydration) hydration = doHydrate().catch((error: unknown) => {
    hydration = null;
    throw error;
  });
  return hydration;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushAll();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

async function writeAndPush(cfg: BoardConfig, merged: TeamBoard): Promise<void> {
  const shared = { ...merged, tasks: merged.tasks.filter((task) => !task.personal) };
  await writeFile(join(cfg.dir, BOARD_FILE), `${JSON.stringify(shared, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await git(cfg.dir, ["add", BOARD_FILE]);
  try {
    await git(cfg.dir, ["commit", "-q", "-m", `hq: ${new Date().toISOString()}`]);
  } catch (err) {
    const text = errorText(err);
    if (!/nothing to commit|no changes added|empty commit/i.test(text)) {
      throw new Error(`не удалось сохранить доску: ${text}`);
    }
  }
  if (!(await hasHead(cfg.dir))) return;
  try {
    await git(cfg.dir, ["push", "origin", cfg.branch], 120000);
  } catch {
    try {
      await git(cfg.dir, ["pull", "--rebase", "--autostash", "origin", cfg.branch], 120000);
      await git(cfg.dir, ["push", "origin", cfg.branch], 120000);
    } catch (err) {
      await git(cfg.dir, ["rebase", "--abort"]).catch(() => undefined);
      throw new Error(`не удалось отправить доску: ${errorText(err)}`);
    }
  }
}

/** Синхронное сохранение прямо в git: подтянуть, слить, записать, запушить. */
export async function saveBoard(
  cfg: BoardConfig,
  incoming: TeamBoard,
  removedTaskIds: readonly string[] = [],
  removedMemberIds: readonly string[] = [],
): Promise<TeamBoard> {
  // UI edits stay non-blocking, but two Git writers must not overlap.
  if (flushing) throw new Error("синхронизация уже выполняется; сохраните правку через applyBoardChange");
  flushing = true;
  try {
    await ensureHydrated();
    const registered = (await readConfigs()).find(
      (board) => board.branch === cfg.branch && sameRepoUrl(board.url, cfg.url),
    );
    let draft: Draft | undefined;
    let revision = 0;
    let snapshot = incoming;
    let snapshotRemovedTaskIds = [...removedTaskIds];
    let snapshotRemovedMemberIds = [...removedMemberIds];
    if (registered) {
      // Keep the UI and standalone API on the same draft, including another clone.
      await applyBoardChange(registered.id, incoming, removedTaskIds, removedMemberIds);
      draft = drafts.get(registered.id)!;
      revision = draft.revision;
      snapshot = draft.board;
      snapshotRemovedTaskIds = [...draft.removedTaskIds];
      snapshotRemovedMemberIds = [...draft.removedMemberIds];
    } else if ((await readLocalState(cfg)).pending) {
      throw new Error("есть неотправленный черновик; подключите доску перед сохранением");
    }
    await pullRepo(cfg);
    const remote = await readBoard(cfg);
    const merged = mergeBoard(remote, snapshot, snapshotRemovedTaskIds, snapshotRemovedMemberIds);
    if (!registered) {
      await withLocalWrite(cfg, () =>
        writeLocalState(cfg, { personalTasks: merged.tasks.filter((task) => task.personal) }),
      );
    }
    await writeAndPush(cfg, merged);
    if (registered && draft) await acknowledgeDraft(cfg, registered.id, draft, merged, revision);
    return merged;
  } finally {
    flushing = false;
  }
}

async function acknowledgeDraft(
  cfg: BoardConfig,
  boardId: string,
  draft: Draft,
  merged: TeamBoard,
  revision: number,
): Promise<void> {
  await withLocalWrite(cfg, async () => {
    if (drafts.get(boardId) !== draft || draft.revision !== revision) return;
    await writeLocalState(cfg, { personalTasks: merged.tasks.filter((task) => task.personal) });
    // A newer edit's queued pending write follows this acknowledgment.
    if (drafts.get(boardId) !== draft || draft.revision !== revision) return;
    draft.board = merged;
    draft.dirty = false;
    draft.removedTaskIds.clear();
    draft.removedMemberIds.clear();
  });
}

async function flushBoard(boardId: string, draft: Draft): Promise<void> {
  const cfg = await getConfig(boardId);
  if (!cfg || !draft.dirty) return;
  try {
    await pullRepo(cfg);
    const remote = await readBoard(cfg);
    const revision = draft.revision;
    const merged = mergeBoard(remote, draft.board, [...draft.removedTaskIds], [...draft.removedMemberIds]);
    await writeAndPush(cfg, merged);
    await acknowledgeDraft(cfg, boardId, draft, merged, revision);
  } catch (err) {
    console.warn("[team] flush failed:", (err as Error)?.message || err);
  }
}

export async function flushAll(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    await ensureHydrated();
    for (const [boardId, draft] of drafts) {
      if (draft.dirty) await flushBoard(boardId, draft);
    }
  } finally {
    flushing = false;
  }
}

export async function boardView(boardId: string): Promise<TeamBoard> {
  await ensureHydrated();
  const draft = drafts.get(boardId);
  if (draft) return draft.board;
  const cfg = await getConfig(boardId);
  if (!cfg) return { ...EMPTY_BOARD };
  return readBoard(cfg);
}

/**
 * Правка из интерфейса: сразу применяем в память и в локальный pending-файл,
 * а в git отправляем пачкой раз в минуту (flushAll).
 */
export async function applyBoardChange(
  boardId: string,
  incoming: TeamBoard,
  removedTaskIds: readonly string[] = [],
  removedMemberIds: readonly string[] = [],
): Promise<TeamBoard> {
  await ensureHydrated();
  const cfg = await getConfig(boardId);
  if (!cfg) throw new Error("доска не найдена");
  let draft = drafts.get(boardId);
  if (!draft) {
    const board = await readBoard(cfg);
    // Another first edit may have created the draft while readBoard was awaiting IO.
    draft = drafts.get(boardId) ?? {
      board,
      removedTaskIds: new Set<string>(),
      removedMemberIds: new Set<string>(),
      dirty: false,
      revision: 0,
    };
  }
  const merged = mergeBoard(draft.board, incoming, removedTaskIds, removedMemberIds);
  draft.board = merged;
  for (const id of removedTaskIds) draft.removedTaskIds.add(id);
  for (const id of removedMemberIds) draft.removedMemberIds.add(id);
  for (const task of incoming.tasks) draft.removedTaskIds.delete(task.id);
  for (const member of incoming.members) draft.removedMemberIds.delete(member.id);
  draft.dirty = true;
  draft.revision++;
  drafts.set(boardId, draft);
  await writePending(cfg, draft);
  scheduleFlush();
  return merged;
}

export async function connectBoard(
  url: string,
  branch: string,
): Promise<{ id: string; url: string; branch: string; dir: string; name: string }> {
  const normalized = normalizeUrl(url);
  const branchName = branch.trim() || "main";

  // Если репозиторий уже подключён, просто делаем его активным и обновляем
  const configs = await readConfigs();
  const existing = configs.find((b) => sameRepoUrl(b.url, normalized) && b.branch === branchName);
  if (existing) {
    await pullRepo(existing);
    const board = await readBoard(existing);
    await setActiveBoardId(existing.id);
    return {
      id: existing.id,
      url: existing.url,
      branch: existing.branch,
      dir: existing.dir,
      name: boardDisplayName(existing.url, board.name),
    };
  }

  const id = newId("b");
  const cfg: BoardConfig = { id, url: normalized, branch: branchName, dir: join(BASE_DIR(), `board-${id}`) };
  await ensureRepo(cfg);
  await pullRepo(cfg);
  const board = await readBoard(cfg);
  configs.push(cfg);
  await writeConfigFile(configs, id);
  return { id, url: normalized, branch: branchName, dir: cfg.dir, name: boardDisplayName(normalized, board.name) };
}

export async function disconnectBoard(boardId: string): Promise<void> {
  drafts.delete(boardId);
  const { boards, activeBoardId } = await readConfigFile();
  const cfg = boards.find((b) => b.id === boardId);
  const remaining = boards.filter((b) => b.id !== boardId);
  const nextActive = activeBoardId === boardId ? (remaining[0]?.id ?? null) : activeBoardId;
  await writeConfigFile(remaining, nextActive);
  if (cfg) {
    await removePending(cfg);
    await rename(cfg.dir, `${cfg.dir}.previous-${Date.now()}`).catch(() => undefined);
  }
}

export async function listBoards(): Promise<
  { id: string; url: string; branch: string; dir: string; name: string; syncedAt: string | null }[]
> {
  await ensureHydrated();
  const configs = await readConfigs();
  const result = [];
  for (const cfg of configs) {
    const draft = drafts.get(cfg.id);
    const board = draft ? draft.board : await readBoard(cfg);
    result.push({
      id: cfg.id,
      url: cfg.url,
      branch: cfg.branch,
      dir: cfg.dir,
      name: boardDisplayName(cfg.url, board.name),
      syncedAt: board.updatedAt || null,
    });
  }
  return result;
}

export async function syncBoard(boardId: string): Promise<TeamBoard> {
  await ensureHydrated();
  const cfg = await getConfig(boardId);
  if (!cfg) throw new Error("доска не найдена");
  await pullRepo(cfg);
  const remote = await readBoard(cfg);
  const draft = drafts.get(boardId);
  if (draft && draft.dirty) {
    const merged = mergeBoard(remote, draft.board, [...draft.removedTaskIds], [...draft.removedMemberIds]);
    draft.board = merged;
    draft.revision++;
    await writePending(cfg, draft);
    return merged;
  }
  return remote;
}
