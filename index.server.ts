import { PluginSyncService } from "./server/plugin-sync.server";
import v8 from "node:v8";
v8.setFlagsFromString("--no-maglev");

import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  areaPreferencesSchema,
  areaSettingsRpc,
  areaSessionCreateRpc,
  chatRenameRpc,
  hostStatsRpc,
  panelSettingsRpc,
  pluginSyncRpc,
  projectAddRpc,
  projectCandidatesRpc,
  projectMetaSchema,
  projectRemoveRpc,
  projectSaveRpc,
  sessionPinRpc,
  terminalRenameRpc,
  areaBranchesRpc,
  areaWorktreeOptionsRpc,
  areaWorktreeCreateRpc,
  areaWorktreeInfoRpc,
  areaWorktreeRemoveRpc,
  sessionTitleSuggestRpc,
  sessionTransferRpc,
  sidebarReadRpc,
  zorActivityRpc,
  zorStatsRpc,
  workersListRpc,
  artifactsListRpc,
  artifactReadRpc,
  artifactSaveRpc,
  artifactUploadYadiskRpc,
  artifactSendTelegramRpc,
  artifactDeleteRpc,
  type CandidateDir,
  type HostStats,
  type ProjectMeta,
  type SidebarState,
} from "./shared/contracts";
import { currentGitBranch, gitCheckoutKind, localGitBranches } from "./server/area-git.server";
import { createWorktree, removeWorktree, worktreeOptions, worktreeStatus } from "./server/area-worktree.server";
import { GENERATOR_TITLE } from "./shared/title-models";
import { ArtifactsService } from "./server/artifacts-service.server";
import {
  EMPTY_BOARD,
  boardSaveRpc,
  boardStateRpc,
  boardSyncRpc,
  boardsConnectRpc,
  boardsDisconnectRpc,
  boardsListRpc,
  boardsSelectRpc,
} from "./shared/team";
import {
  applyBoardChange,
  boardView,
  connectBoard,
  disconnectBoard,
  getActiveBoardId,
  listBoards,
  setActiveBoardId,
  syncBoard,
} from "./server/team.server";

import { contributeSessionTitles, suggestTitle } from "./server/session-titles.server";
import { startSampler } from "./server/sampler";
import { readZorActivity, readZorStats } from "./server/zor";
import { readAllWorkers } from "./server/workers";
import { contributeUsageServer } from "./server/usage-contribute.server";
import { gitWorkspaceSettings } from "./shared/git-settings";
import {
  StartGitLoginRpc,
  GetGitLoginRpc,
  CancelGitLoginRpc,
  CheckAuthRpc,
  ListReposRpc,
  TriggerSyncRpc,
  CreateWorkspaceRpc,
} from "./shared/git-contracts";
import { GitLoginService } from "./server/git-login.server";
import { cloneAndCreateWorkspace } from "./server/git-service.server";
import { repoCacheService } from "./server/git-cache.server";
import { read as readServicesRpc } from "./shared/services-contracts";
import { readServices } from "./server/services.server";
import contributeGenuiServer from "./server/genui/contribute";
import { createDeepSeekHarnessProvider } from "./server/deepseek/provider";
import { createDeepSeekUsageSource } from "./server/deepseek/usage";
import { providersSnapshot } from "./shared/provider-cache";

const execFileAsync = promisify(execFile);
const paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo");
const defaultReposDir = process.env.PASEO_REPOS_DIR || join(homedir(), "repos");
const stateFile =
  process.env.PASEO_HQ_STATE_FILE || join(homedir(), ".local", "state", "paseo-hq", "state.json");
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 500;

type AreaPreferences = ReturnType<typeof areaPreferencesSchema.parse>;

function emptyAreaPreferences(): AreaPreferences {
  return { icon: null, iconBg: null, titleModel: null, defaultBranch: null, launchBranches: {}, worktree: null };
}

interface StoredData {
  areaPreferences: Record<string, AreaPreferences>;
  projects: Record<string, ProjectMeta>;
  lastRunningAt: Record<string, number>;
  pinnedSessions: Record<string, number>;
  terminalNames: Record<string, string>;
  titledSessions: Record<string, number>;
  showHostMetrics: boolean;
  headerTitle: string;
  projectsSortMode: "auto" | "manual";
  projectOrder: string[];
}

let writeQueue: Promise<unknown> = Promise.resolve();

function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function expandHome(p: string): string {
  const t = p.trim();
  if (t === "~") return homedir();
  if (t.startsWith("~/")) return join(homedir(), t.slice(2));
  return resolve(t);
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

function parseStringMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) out[id] = value.trim();
    }
  }
  return out;
}

function parseNumberMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object") {
    for (const [id, ts] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
        out[id] = ts;
      }
    }
  }
  return out;
}

async function readStored(): Promise<StoredData> {
  try {
    const raw = JSON.parse(await readFile(stateFile, "utf8")) as Record<string, unknown>;
    const projects: Record<string, ProjectMeta> = {};
    if (raw.projects && typeof raw.projects === "object") {
      for (const [id, meta] of Object.entries(raw.projects as Record<string, unknown>)) {
        const parsed = projectMetaSchema.safeParse(meta);
        if (parsed.success) {
          projects[id] = parsed.data;
        }
      }
    }
    const areaPreferences: StoredData["areaPreferences"] = {};
    if (raw.areaPreferences && typeof raw.areaPreferences === "object") {
      for (const [id, entry] of Object.entries(raw.areaPreferences)) {
        const parsed = areaPreferencesSchema.safeParse(entry);
        if (parsed.success) areaPreferences[id] = parsed.data;
      }
    }
    return {
      areaPreferences,
      projects,
      lastRunningAt: parseNumberMap(raw.lastRunningAt),
      pinnedSessions: parseNumberMap(raw.pinnedSessions),
      terminalNames: parseStringMap(raw.terminalNames),
      titledSessions: parseNumberMap(raw.titledSessions),
      showHostMetrics: typeof raw.showHostMetrics === "boolean" ? raw.showHostMetrics : true,
      headerTitle: typeof raw.headerTitle === "string" && raw.headerTitle.trim() ? raw.headerTitle.trim() : "Штаб",
      projectsSortMode: raw.projectsSortMode === "manual" ? "manual" : "auto",
      projectOrder: Array.isArray(raw.projectOrder)
        ? raw.projectOrder.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return {
      areaPreferences: {},
      projects: {},
      lastRunningAt: {},
      pinnedSessions: {},
      terminalNames: {},
      titledSessions: {},
      showHostMetrics: true,
      headerTitle: "Штаб",
      projectsSortMode: "auto",
      projectOrder: [],
    };
  }
}

async function saveStored(data: StoredData): Promise<void> {
  const runningEntries = Object.entries(data.lastRunningAt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_HISTORY_ENTRIES);
  const trimmed: StoredData = {
    areaPreferences: data.areaPreferences,
    projects: data.projects,
    lastRunningAt: Object.fromEntries(runningEntries),
    pinnedSessions: data.pinnedSessions,
    terminalNames: data.terminalNames,
    titledSessions: data.titledSessions,
    showHostMetrics: data.showHostMetrics,
    headerTitle: data.headerTitle || "Штаб",
    projectsSortMode: data.projectsSortMode || "auto",
    projectOrder: data.projectOrder || [],
  };
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(trimmed, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, stateFile);
}

async function requireArea(paseo: PaseoApi, workspaceId: string) {
  const area = await paseo.workspaces.ref(workspaceId).refresh();
  if (!area || area.archivingAt) throw new Error("Область не найдена");
  return area;
}

async function recordSessionLaunchBranch(workspaceId: string, agentId: string, cwd: string) {
  const branch = await currentGitBranch(cwd);
  if (!branch) return;
  await serializeWrite(async () => {
    const stored = await readStored();
    const area = stored.areaPreferences[workspaceId] ??= emptyAreaPreferences();
    if (Object.hasOwn(area.launchBranches, agentId)) return;
    area.launchBranches[agentId] = branch;
    await saveStored(stored);
  });
}

async function recordWorkspaceRunning(workspaceId: string | null | undefined): Promise<void> {
  if (!workspaceId) return;
  const now = Date.now();
  await serializeWrite(async () => {
    const stored = await readStored();
    stored.lastRunningAt[workspaceId] = now;
    await saveStored(stored);
  });
}

function detectImageMime(buf: Buffer, hint = ""): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  const head6 = buf.toString("ascii", 0, Math.min(6, buf.length));
  if (head6 === "GIF87a" || head6 === "GIF89a") {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 4 && buf.readUInt16LE(0) === 0 && (buf.readUInt16LE(2) === 1 || buf.readUInt16LE(2) === 2)) {
    return "image/x-icon";
  }
  const headText = buf.toString("utf8", 0, Math.min(512, buf.length)).trimStart();
  if (headText.startsWith("<svg") || (headText.startsWith("<?xml") && headText.includes("<svg"))) {
    return "image/svg+xml";
  }
  const lower = hint.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".ico")) return "image/x-icon";
  return null;
}

async function loadNativeIcons(projectIds: string[]): Promise<Record<string, string>> {
  const icons: Record<string, string> = {};
  await Promise.all(
    projectIds.map(async (projectId) => {
      try {
        const key = createHash("sha256").update(projectId).digest("hex");
        const iconPath = join(paseoHome, "projects", "icons", `${key}.bin`);
        const buf = await readFile(iconPath);
        const mime = detectImageMime(buf);
        if (mime) {
          icons[projectId] = `data:${mime};base64,${buf.toString("base64")}`;
        }
      } catch {
        // Native icon not set for this project.
      }
    }),
  );
  return icons;
}

async function resolveAvatarToDataUri(rawValue: string): Promise<{ dataUri: string; buffer: Buffer; mime: string }> {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith("data:image/")) {
    const comma = trimmed.indexOf(",");
    if (comma === -1) throw new Error("Некорректный формат data:image");
    const meta = trimmed.slice(5, comma);
    const isBase64 = meta.includes(";base64");
    const mime = meta.split(";")[0] || "image/png";
    const payload = trimmed.slice(comma + 1);
    const buf = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
    if (buf.length === 0 || buf.length > MAX_AVATAR_BYTES) {
      throw new Error("Файл слишком большой (максимум 8 МБ)");
    }
    return { dataUri: `data:${mime};base64,${buf.toString("base64")}`, buffer: buf, mime };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(trimmed, {
        signal: controller.signal,
        headers: { Accept: "image/*,*/*;q=0.8", "User-Agent": "PaseoProjectsSidebar/1.0" },
      });
      if (!res.ok) {
        throw new Error(`Не удалось скачать картинку (HTTP ${res.status})`);
      }
      const arr = await res.arrayBuffer();
      const buf = Buffer.from(arr);
      if (buf.length === 0 || buf.length > MAX_AVATAR_BYTES) {
        throw new Error("Картинка пустая или больше 8 МБ");
      }
      const headerCt = (res.headers.get("content-type") || "").split(";")[0]?.trim() || "";
      const mime = detectImageMime(buf, trimmed) || (headerCt.startsWith("image/") ? headerCt : null);
      if (!mime) {
        throw new Error("По ссылке не распознано изображение (поддерживаются PNG, JPG, WebP, GIF, SVG, ICO)");
      }
      return { dataUri: `data:${mime};base64,${buf.toString("base64")}`, buffer: buf, mime };
    } finally {
      clearTimeout(timeout);
    }
  }

  const localPath = expandHome(trimmed);
  let buf: Buffer;
  try {
    buf = await readFile(localPath);
  } catch {
    throw new Error("Не удалось прочитать файл на сервере. Укажите URL https://... или локальный путь к файлу...");
  }
  if (buf.length === 0 || buf.length > MAX_AVATAR_BYTES) {
    throw new Error("Файл пустой или больше 8 МБ");
  }
  const mime = detectImageMime(buf, localPath);
  if (!mime) {
    throw new Error("Формат файла не распознан как изображение");
  }
  return { dataUri: `data:${mime};base64,${buf.toString("base64")}`, buffer: buf, mime };
}

interface DaemonProjectDescriptor {
  projectId: string;
  projectRootPath: string;
}

interface LowLevelDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  addProject(cwd: string): Promise<{ project: DaemonProjectDescriptor | null; error: string | null }>;
  createProjectDirectory(input: {
    parentPath: string;
    name: string;
  }): Promise<{ directoryPath: string | null; project: DaemonProjectDescriptor | null; error: string | null }>;
  removeProject(projectId: string): Promise<{ removedWorkspaceIds: string[] }>;
  renameProject(projectId: string, customName: string | null): Promise<{ customName: string | null }>;
  setProjectIcon(
    projectId: string,
    source: { kind: "auto" } | { kind: "custom"; data: string; mimeType: string },
  ): Promise<void>;
  buildAgentForkContext(
    agentId: string,
    options?: Record<string, unknown>,
  ): Promise<{ attachment: unknown; itemCount: number; error: string | null }>;
}

async function withDaemonClient<T>(fn: (client: LowLevelDaemonClient) => Promise<T>): Promise<T> {
  const nodeBin = dirname(process.execPath);
  const sdkPath = resolve(nodeBin, "../lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/client/dist/daemon-client.js");
  const mod = (await import(pathToFileURL(sdkPath).href)) as {
    DaemonClient: new (cfg: Record<string, unknown>) => LowLevelDaemonClient;
  };
  const password = (await readFile(join(homedir(), ".config", "paseo", "daemon-password"), "utf8")).trim();
  const client = new mod.DaemonClient({
    url: "ws://127.0.0.1:6767/ws",
    clientId: "paseo-hq",
    clientType: "cli",
    password,
    appVersion: "0.15.2",
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function buildState(projectIds: string[]): Promise<SidebarState> {
  const stored = await readStored();
  const ids = Array.from(new Set([...projectIds, ...Object.keys(stored.projects)]));
  const nativeIcons = await loadNativeIcons(ids);
  return {
    projects: stored.projects,
    nativeIcons,
    areaIcons: Object.fromEntries(
      Object.entries(stored.areaPreferences).flatMap(([id, preferences]) => preferences.icon ? [[id, preferences.icon]] : []),
    ),
    areaWorktrees: Object.fromEntries(
      Object.entries(stored.areaPreferences).flatMap(([id, preferences]) =>
        preferences.worktree ? [[id, { path: preferences.worktree.path, branch: preferences.worktree.branch }]] : []),
    ),
    areaIconBgs: Object.fromEntries(
      Object.entries(stored.areaPreferences).flatMap(([id, preferences]) => preferences.iconBg ? [[id, preferences.iconBg]] : []),
    ),
    lastRunningAt: stored.lastRunningAt,
    pinnedSessions: stored.pinnedSessions,
    terminalNames: stored.terminalNames,
    showHostMetrics: stored.showHostMetrics,
    headerTitle: stored.headerTitle || "Штаб",
    projectsSortMode: stored.projectsSortMode || "auto",
    projectOrder: stored.projectOrder || [],
  };
}

function emptyStats(): HostStats {
  const now = Date.now();
  return {
    hostname: "",
    platform: process.platform,
    uptimeSeconds: 0,
    cpuCount: 1,
    cpuModel: "",
    loadAverage: [0, 0, 0],
    memory: { totalBytes: 0, usedBytes: 0, cachedBytes: null, pressure: null },
    memoryTop: { byGroup: [], byPid: [] },
    network: null,
    traffic24h: null,
    publicIps: [],
    disks: [],
    sampleIntervalMs: 2000,
    current: { at: now, cpuPercent: 0, memoryPercent: 0, rxBytesPerSec: 0, txBytesPerSec: 0 },
    history: [],
  };
}

async function scanCandidateDirectories(existingPaths: string[]): Promise<CandidateDir[]> {
  const existingReal = new Set(await Promise.all(existingPaths.map((p) => safeRealpath(expandHome(p)))));
  const seenReal = new Set<string>();
  const results: CandidateDir[] = [];

  try {
    const entries = await readdir(defaultReposDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(defaultReposDir, entry.name);
      try {
        const st = await stat(fullPath);
        if (!st.isDirectory()) continue;
        const real = await safeRealpath(fullPath);
        if (existingReal.has(real) || seenReal.has(real)) continue;
        seenReal.add(real);
        let isGit = false;
        try {
          await stat(join(real, ".git"));
          isGit = true;
        } catch {
          isGit = false;
        }
        results.push({ name: basename(real), path: real, isGit });
      } catch {
        // Ignore broken symlinks or inaccessible folders.
      }
    }
  } catch {
    // ~/repos may not exist yet.
  }

  results.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  return results;
}

function inferRepoFolderName(repoUrl: string): string {
  const cleaned = repoUrl.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = cleaned.split(/[/:]/).filter(Boolean);
  return parts[parts.length - 1] || "new-project";
}

function normalizeCloneUrl(repoUrl: string): string {
  const trimmed = repoUrl.trim();
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}.git`;
  }
  return trimmed;
}

async function pluginSyncService(): Promise<PluginSyncService> {
  const candidates = ["paseo", join(dirname(process.execPath), "paseo"), "/home/zor/.local/paseo/node_modules/.bin/paseo", "/usr/local/bin/paseo", "/usr/bin/paseo"];
  for (const binary of candidates) {
    try { await execFileAsync(binary, ["--version"]); }
    catch { continue; }
    return new PluginSyncService(join(paseoHome, "hq-plugin-updates"), binary);
  }
  throw new Error("Не найдена команда Paseo для обновления Штаба");
}

export default function contribute(server: PluginServerContext) {
  const gitLogin = new GitLoginService();
  const completedGitLogins = new Set<string>();
  server.handle(StartGitLoginRpc, ({ provider, gitlabUrl }) => gitLogin.start(provider, gitlabUrl));
  server.handle(GetGitLoginRpc, async ({ id }) => {
    const state = gitLogin.get(id);
    if (state.state === "complete" && !completedGitLogins.has(id)) {
      completedGitLogins.add(id); repoCacheService.clear();
    }
    return state;
  });
  server.handle(CancelGitLoginRpc, ({ id }) => gitLogin.cancel(id));
  const removeGenui = contributeGenuiServer(server);
  server.registerSettings(gitWorkspaceSettings);
  void repoCacheService.init();

  const disposeTitles = contributeSessionTitles(server, (workspaceId, projectId) => serializeWrite(async () => {
    const stored = await readStored();
    if (stored.titledSessions[workspaceId]) return null;
    stored.titledSessions[workspaceId] = Date.now();
    await saveStored(stored);
    return { model: stored.projects[projectId]?.sessionTitleModel ?? null };
  }));

  let sampler: ReturnType<typeof startSampler> | null = null;

  // Запуск фонового сэмплера при старте плагина, если метрики хоста включены
  void readStored().then((stored) => {
    if (stored.showHostMetrics && !sampler) {
      sampler = startSampler();
    }
  }).catch(() => {
    if (!sampler) sampler = startSampler();
  });

  const artifactsService = new ArtifactsService();
  void artifactsService.init().catch((err) => {
    console.warn("[artifacts] Init failed:", err);
  });

  const disposeLaunchBranch = server.before("agent.session_open", async ({ request }) => {
    if (request.reason === "create" && request.workspaceId && request.title !== GENERATOR_TITLE) {
      try {
        await recordSessionLaunchBranch(request.workspaceId, request.agentId, request.cwd);
      } catch (error) {
        console.warn("[sidebar] Failed to record session launch branch:", error);
      }
    }
    return request;
  });

  // Отслеживаем начало и завершение running-ходов всех агентов для точной сортировки по последнему running
  const disposeTurnBefore = server.addHook("agent.turn.before", async ({ agent }) => {
    await recordWorkspaceRunning(agent.workspaceId);
  });

  const disposeTurnAfter = server.addHook("agent.turn.after", async ({ agent }) => {
    await recordWorkspaceRunning(agent.workspaceId);
    if (agent.cwd) {
      try {
        const artifactsDir = join(agent.cwd, "artifacts");
        const dirStat = await stat(artifactsDir).catch(() => null);
        if (dirStat && dirStat.isDirectory()) {
          await artifactsService.scanTurnFiles(artifactsDir, {
            agentId: agent.id,
            workspaceId: agent.workspaceId ?? undefined,
          });
        }
      } catch (err) {
        console.warn("[artifacts] scanTurnFiles failed:", err);
      }
    }
  });

  server.handle(hostStatsRpc, async () => {
    if (!sampler) {
      const stored = await readStored();
      if (stored.showHostMetrics) {
        sampler = startSampler();
      }
    }
    return sampler ? sampler.read() : emptyStats();
  });

  server.handle(zorStatsRpc, async () => {
    return await readZorStats();
  });

  server.handle(zorActivityRpc, async () => {
    return await readZorActivity();
  });

  server.handle(workersListRpc, async () => {
    const workers = await readAllWorkers();
    return { workers };
  });

  server.handle(boardsListRpc, async () => {
    return {
      boards: await listBoards(),
      activeBoardId: await getActiveBoardId(),
    };
  });

  server.handle(boardsSelectRpc, async ({ boardId }) => {
    const active = await setActiveBoardId(boardId);
    return { ok: true, activeBoardId: active };
  });

  server.handle(boardsConnectRpc, async ({ url, branch }) => {
    try {
      const board = await connectBoard(url, branch);
      return { ok: true, error: null, board };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err), board: null };
    }
  });

  server.handle(boardsDisconnectRpc, async ({ boardId }) => {
    await disconnectBoard(boardId);
    return { ok: true };
  });

  server.handle(boardStateRpc, async ({ boardId }) => {
    try {
      const board = await boardView(boardId);
      return { board, error: null, syncedAt: board.updatedAt || null };
    } catch (err) {
      return {
        board: { ...EMPTY_BOARD },
        error: String((err as Error)?.message || err),
        syncedAt: null,
      };
    }
  });

  server.handle(boardSyncRpc, async ({ boardId }) => {
    try {
      const board = await syncBoard(boardId);
      return { ok: true, error: null, board };
    } catch (err) {
      return {
        ok: false,
        error: String((err as Error)?.message || err),
        board: { ...EMPTY_BOARD },
      };
    }
  });

  server.handle(boardSaveRpc, async ({ boardId, board, removedTaskIds, removedMemberIds }) => {
    try {
      const saved = await applyBoardChange(boardId, board, removedTaskIds, removedMemberIds);
      return { ok: true, error: null, board: saved };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err), board };
    }
  });

  server.handle(sidebarReadRpc, async ({ projectIds }) => {
    return await buildState(projectIds);
  });

  server.handle(
    panelSettingsRpc,
    async ({
      headerTitle,
      showHostMetrics,
      projectsSortMode,
      projectOrder,
      projectIds,
    }) => {
      let nextShow = showHostMetrics;
      await serializeWrite(async () => {
        const stored = await readStored();
        if (typeof headerTitle === "string") {
          const trimmed = headerTitle.trim();
          stored.headerTitle = trimmed || "Штаб";
        }
        if (typeof showHostMetrics === "boolean") {
          stored.showHostMetrics = showHostMetrics;
          nextShow = showHostMetrics;
        }
        if (projectsSortMode === "auto" || projectsSortMode === "manual") {
          stored.projectsSortMode = projectsSortMode;
        }
        if (Array.isArray(projectOrder)) {
          stored.projectOrder = projectOrder;
        }
        await saveStored(stored);
      });
    if (typeof nextShow === "boolean") {
      if (nextShow) {
        if (!sampler) sampler = startSampler();
      } else {
        if (sampler) {
          sampler.stop();
          sampler = null;
        }
      }
    }
    return await buildState(projectIds);
  });

  // Закрепление хранится только внутри нашего виджета и не затрагивает нативный сайдбар Paseo
  server.handle(sessionTitleSuggestRpc, async ({ workspaceId, agentId, projectId, model }, { paseo }) => {
    const stored = await readStored();
    const selectedModel = model ?? stored.areaPreferences[workspaceId]?.titleModel ?? stored.projects[projectId]?.sessionTitleModel ?? "first_line";
    return { title: await suggestTitle(paseo, workspaceId, agentId, selectedModel) };
  });

  server.handle(areaSettingsRpc, async ({ workspaceId, defaultBranch, icon, iconBg, titleModel }, { paseo }) => {
    const area = await requireArea(paseo, workspaceId);
    const [currentBranch, branches]: [string | null, string[]] = area.projectKind === "git"
      ? await Promise.all([currentGitBranch(area.workspaceDirectory), localGitBranches(area.workspaceDirectory)])
      : [null, []];
    if (defaultBranch !== undefined || icon !== undefined || iconBg !== undefined || titleModel !== undefined) {
      if (defaultBranch && !branches.includes(defaultBranch)) {
        throw new Error("Ветка не найдена в этой области");
      }
      await serializeWrite(async () => {
        const stored = await readStored();
        const preferences = stored.areaPreferences[workspaceId] ??= emptyAreaPreferences();
        if (defaultBranch !== undefined) preferences.defaultBranch = defaultBranch;
        if (icon !== undefined) preferences.icon = icon;
        if (iconBg !== undefined) preferences.iconBg = iconBg;
        if (titleModel !== undefined) preferences.titleModel = titleModel;
        await saveStored(stored);
      });
    }
    const preferences = (await readStored()).areaPreferences[workspaceId] ?? emptyAreaPreferences();
    return { ...preferences, currentBranch, branches };
  });

  server.handle(areaSessionCreateRpc, async ({ workspaceId, model, title, modeId, thinkingOptionId }, { paseo }) => {
    const area = await requireArea(paseo, workspaceId);
    const snapshot = await providersSnapshot(paseo, area.projectRootPath);
    const selected = snapshot.entries.some(entry => entry.enabled && entry.status === "ready"
      && (entry.models ?? []).some(option => option.isSelectable !== false && `${entry.provider}/${option.id}` === model));
    if (!selected) throw new Error("Выбранная модель недоступна в этой области");
    const agent = await paseo.workspaces.ref(area).agents.create({ config: { provider: model, modeId, thinkingOptionId }, title: title || undefined });
    return { agentId: agent.id };
  });

  server.handle(chatRenameRpc, async ({ workspaceId, agentId, title }, { paseo }) => {
    const result = await paseo.agents.ref(agentId).refresh();
    const agent = result?.agent;
    if (!agent || agent.id !== agentId || agent.workspaceId !== workspaceId || agent.archivedAt || agent.internal) {
      throw new Error("Агент не найден в этой области");
    }
    await execFileAsync("paseo", ["agent", "update", "--home", paseoHome, `--name=${title}`, "--", agentId], {
      timeout: 15_000,
    });
    return {};
  });

  server.handle(sessionPinRpc, async ({ workspaceId, pinned, projectIds }) => {
    await serializeWrite(async () => {
      const stored = await readStored();
      if (pinned) {
        stored.pinnedSessions[workspaceId] = Date.now();
      } else {
        delete stored.pinnedSessions[workspaceId];
      }
      await saveStored(stored);
    });
    return await buildState(projectIds);
  });

  const projectRoot = async (paseo: PaseoApi, projectId: string) => {
    const project = ((await paseo.projects.list()).projects ?? []).find((item) => item.projectId === projectId);
    if (!project) throw new Error("Проект не найден");
    return project.projectRootPath;
  };

  server.handle(areaBranchesRpc, async ({ workspaceIds }, { paseo }) => {
    const wanted = new Set(workspaceIds);
    const areas = ((await paseo.workspaces.list()).entries ?? []).filter(
      (area) => wanted.has(area.id) && area.projectKind === "git" && area.workspaceDirectory,
    );
    const found = await Promise.all(areas.map(async (area) => {
      const [branch, kind] = await Promise.all([
        currentGitBranch(area.workspaceDirectory!).catch(() => null),
        gitCheckoutKind(area.workspaceDirectory!).catch(() => null),
      ]);
      return { id: area.id, branch, kind };
    }));
    return {
      branches: Object.fromEntries(found.filter((item) => item.branch).map((item) => [item.id, item.branch!])),
      kinds: Object.fromEntries(found.filter((item) => item.kind).map((item) => [item.id, item.kind!])),
    };
  });

  server.handle(areaWorktreeOptionsRpc, async ({ projectId }, { paseo }) => {
    const rootPath = await projectRoot(paseo, projectId);
    return { rootPath, ...(await worktreeOptions(rootPath)) };
  });

  server.handle(areaWorktreeCreateRpc, async ({ projectId, title, path, branch, newBranch, baseBranch, agentModel, agentTitle, modeId, thinkingOptionId }, { paseo }) => {
    const rootPath = await projectRoot(paseo, projectId);
    const worktree = await createWorktree(rootPath, { path, branch, newBranch, baseBranch });
    try {
      const workspace = await paseo.workspaces.create({
        title: title.trim() || worktree.branch,
        agent: agentModel ? { config: { provider: agentModel, modeId, thinkingOptionId }, title: agentTitle || undefined, cwd: worktree.path } : undefined,
        source: { kind: "directory", path: worktree.path, projectId },
      });
      await serializeWrite(async () => {
        const stored = await readStored();
        const area = stored.areaPreferences[workspace.id] ??= emptyAreaPreferences();
        area.worktree = { ...worktree, rootPath };
        await saveStored(stored);
      });
      return { workspaceId: workspace.id, path: worktree.path };
    } catch (error) {
      // Область не создалась: не оставляем пустую папку worktree.
      await removeWorktree(rootPath, worktree.path, true).catch(() => {});
      throw error;
    }
  });

  server.handle(areaWorktreeInfoRpc, async ({ workspaceId }) => {
    const worktree = (await readStored()).areaPreferences[workspaceId]?.worktree ?? null;
    if (!worktree) return { worktree: null, exists: false, changes: [] };
    return { worktree: { path: worktree.path, branch: worktree.branch }, ...(await worktreeStatus(worktree.path)) };
  });

  server.handle(areaWorktreeRemoveRpc, async ({ workspaceId, force }) => {
    const worktree = (await readStored()).areaPreferences[workspaceId]?.worktree;
    if (!worktree) return {};
    // Область к этому моменту уже в архиве и в списке Paseo ее нет: корень берем из записи Штаба.
    const rootPath = worktree.rootPath;
    if (!rootPath) throw new Error("Не известен корень проекта этой папки worktree");
    await removeWorktree(rootPath, worktree.path, force);
    await serializeWrite(async () => {
      const stored = await readStored();
      const area = stored.areaPreferences[workspaceId];
      if (area) area.worktree = null;
      await saveStored(stored);
    });
    return {};
  });

  server.handle(terminalRenameRpc, async ({ terminalId, title, projectIds }) => {
    await serializeWrite(async () => {
      const stored = await readStored();
      const name = title?.trim();
      if (name) stored.terminalNames[terminalId] = name;
      else delete stored.terminalNames[terminalId];
      await saveStored(stored);
    });
    return await buildState(projectIds);
  });

  server.handle(projectCandidatesRpc, async ({ existingPaths }) => {
    const items = await scanCandidateDirectories(existingPaths);
    return {
      defaultParent: defaultReposDir,
      items,
    };
  });

  server.handle(projectAddRpc, async (input) => {
    if (input.mode === "existing") {
      const targetPath = expandHome(input.path);
      const st = await stat(targetPath).catch(() => null);
      if (!st || !st.isDirectory()) {
        throw new Error(`Папка не найдена: ${targetPath}`);
      }
      return await withDaemonClient(async (client) => {
        const added = await client.addProject(targetPath);
        if (added.error || !added.project) {
          throw new Error(added.error || "Не удалось добавить проект");
        }
        const custom = input.customName?.trim();
        if (custom) {
          await client.renameProject(added.project.projectId, custom);
        }
        return {
          projectId: added.project.projectId,
          rootPath: added.project.projectRootPath,
        };
      });
    }

    if (input.mode === "create") {
      const parentPath = expandHome(input.parentPath);
      const folderName = input.folderName.trim();
      if (!folderName || folderName.includes("/") || folderName === "." || folderName === "..") {
        throw new Error("Укажите корректное имя новой папки без слешей");
      }
      await mkdir(parentPath, { recursive: true });
      return await withDaemonClient(async (client) => {
        const created = await client.createProjectDirectory({ parentPath, name: folderName });
        if (created.error || !created.project || !created.directoryPath) {
          throw new Error(created.error || "Не удалось создать папку проекта");
        }
        if (input.initGit) {
          await execFileAsync("git", ["init"], { cwd: created.directoryPath, timeout: 15000 }).catch(() => undefined);
        }
        const custom = input.customName?.trim();
        if (custom) {
          await client.renameProject(created.project.projectId, custom);
        }
        return {
          projectId: created.project.projectId,
          rootPath: created.project.projectRootPath,
        };
      });
    }

    const parentPath = expandHome(input.parentPath);
    const folderName = (input.folderName?.trim() || inferRepoFolderName(input.repoUrl)).trim();
    if (!folderName || folderName.includes("/") || folderName === "." || folderName === "..") {
      throw new Error("Некорректное имя целевой папки");
    }
    await mkdir(parentPath, { recursive: true });
    const targetDir = join(parentPath, folderName);
    const exists = await stat(targetDir).catch(() => null);
    if (exists) {
      throw new Error(`Папка уже существует: ${targetDir}`);
    }
    const cloneUrl = normalizeCloneUrl(input.repoUrl);
    try {
      await execFileAsync("git", ["clone", "--", cloneUrl, targetDir], {
        timeout: 120000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Ошибка git clone";
      throw new Error(`Не удалось клонировать репозиторий: ${msg.split("\n")[0]}`);
    }

    return await withDaemonClient(async (client) => {
      const added = await client.addProject(targetDir);
      if (added.error || !added.project) {
        throw new Error(added.error || "Репозиторий склонирован, но не удалось зарегистрировать проект");
      }
      const custom = input.customName?.trim();
      if (custom) {
        await client.renameProject(added.project.projectId, custom);
      }
      return {
        projectId: added.project.projectId,
        rootPath: added.project.projectRootPath,
      };
    });
  });

  server.handle(projectRemoveRpc, async ({ projectId }) => {
    await withDaemonClient((client) => client.removeProject(projectId));
    return { ok: true };
  });

  server.handle(
    projectSaveRpc,
    async ({
      projectId,
      customName,
      avatar,
      hidden,
      pinned,
      sessionTitleModel,
      sessionsSortMode,
      sessionOrder,
    }) => {
      let resolvedAvatar: { dataUri: string; buffer: Buffer; mime: string } | null = null;
      if (avatar.kind === "dataUri") {
        resolvedAvatar = await resolveAvatarToDataUri(avatar.dataUri);
      } else if (avatar.kind === "urlOrPath") {
        resolvedAvatar = await resolveAvatarToDataUri(avatar.value);
      }

      if (customName !== undefined || avatar.kind === "none" || resolvedAvatar) {
        await withDaemonClient(async (client) => {
          if (customName !== undefined) {
            const trimmed = customName === null ? null : customName.trim() || null;
            await client.renameProject(projectId, trimmed);
          }
          if (avatar.kind === "none") {
            try {
              await client.setProjectIcon(projectId, { kind: "auto" });
            } catch {
              // Ignore if native project has no custom icon.
            }
          } else if (resolvedAvatar && resolvedAvatar.buffer.length <= 512 * 1024) {
            try {
              await client.setProjectIcon(projectId, {
                kind: "custom",
                data: resolvedAvatar.buffer.toString("base64"),
                mimeType: resolvedAvatar.mime,
              });
            } catch {
              // Non-square or >1024x1024 images are rejected by native Paseo,
              // while our sidebar stores and renders them without any restrictions.
            }
          }
        });
      }

      await serializeWrite(async () => {
        const stored = await readStored();
        const prev: ProjectMeta = stored.projects[projectId] ?? {
          avatarUri: null,
          avatarEmoji: null,
          avatarBg: null,
          hidden: false,
          pinned: false,
          sessionTitleModel: null,
          sessionsSortMode: "auto",
          sessionOrder: [],
        };
        const next: ProjectMeta = { ...prev };

        if (avatar.kind === "none") {
          next.avatarUri = null;
          next.avatarEmoji = null;
          next.avatarBg = null;
        } else if (avatar.kind === "emoji") {
          next.avatarUri = null;
          next.avatarEmoji = avatar.emoji;
          next.avatarBg = avatar.bg;
        } else if (resolvedAvatar) {
          next.avatarUri = resolvedAvatar.dataUri;
          next.avatarEmoji = null;
          next.avatarBg = null;
        }

        if (hidden !== undefined) {
          next.hidden = hidden;
        }
        if (pinned !== undefined) {
          next.pinned = pinned;
        }
        if (sessionTitleModel !== undefined) {
          next.sessionTitleModel = sessionTitleModel ? sessionTitleModel.trim() || null : null;
        }
        if (sessionsSortMode === "auto" || sessionsSortMode === "manual") {
          next.sessionsSortMode = sessionsSortMode;
        }
        if (Array.isArray(sessionOrder)) {
          next.sessionOrder = sessionOrder;
        }

        stored.projects[projectId] = next;
        await saveStored(stored);
      });

    return await buildState([projectId]);
  });

  server.handle(
    sessionTransferRpc,
    async ({ workspaceId, targetProjectId, archiveOriginal, includeHistory }, { paseo }) => {
      const projectsRes = await paseo.projects.list();
      const targetProject = (projectsRes.projects ?? []).find((p) => p.projectId === targetProjectId);
      if (!targetProject) {
        throw new Error("Целевой проект не найден");
      }

      const workspacesRes = await paseo.workspaces.list();
      const sourceWs = (workspacesRes.entries ?? []).find((w) => w.id === workspaceId);
      if (!sourceWs) {
        throw new Error("Исходная область не найдена");
      }

      const agentsRes = await paseo.agents.list({}).catch(() => ({ entries: [] as { agent: any }[] }));
      const wsAgents = (agentsRes.entries ?? [])
        .map((e) => e.agent)
        .filter((a) => a && a.workspaceId === workspaceId && !a.archivedAt && !a.internal);
      const sourceAgent = wsAgents.sort(
        (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime(),
      )[0];

      let forkAttachment: any = null;
      if (includeHistory && sourceAgent) {
        try {
          const forkRes = await withDaemonClient((client) => client.buildAgentForkContext(sourceAgent.id));
          if (forkRes && forkRes.attachment) {
            forkAttachment = forkRes.attachment;
          }
        } catch (err) {
          console.warn("[session-transfer] Failed to build fork context:", err);
        }
      }


      const title = sourceWs.title || sourceWs.projectDisplayName || "Область";
      const targetPath = targetProject.projectRootPath;

      let agentPayload: any = undefined;
      if (sourceAgent) {
        const providerStr = sourceAgent.model
          ? `${sourceAgent.provider}/${sourceAgent.model}`
          : sourceAgent.provider;
        agentPayload = {
          config: {
            provider: providerStr,
          },
          cwd: targetPath,
          attachments: forkAttachment ? [forkAttachment] : undefined,
        };
      }

      const createdWs = await paseo.workspaces.create({
        title,
        source: { kind: "directory", path: targetPath, projectId: targetProjectId },
        agent: agentPayload,
      });

      await serializeWrite(async () => {
        const s = await readStored();
        s.titledSessions[createdWs.id] = Date.now();
        if (s.pinnedSessions[workspaceId]) {
          s.pinnedSessions[createdWs.id] = s.pinnedSessions[workspaceId];
        }
        await saveStored(s);
      });

      if (archiveOriginal) {
        try {
          await paseo.workspaces.archive(workspaceId);
        } catch (err) {
          console.warn("[session-transfer] Failed to archive original workspace:", err);
        }
      }

      return {
        newWorkspaceId: createdWs.id,
        targetProjectId,
      };
    },
  );

  server.handle(CheckAuthRpc, async (input) => {
    return await repoCacheService.getAuth(input.gitlabUrl, input.forceRefresh);
  });

  server.handle(ListReposRpc, async (input) => {
    const { repos, lastSyncedAt, isSyncing, auth, errors } = await repoCacheService.getRepos({
      provider: input.provider,
      query: input.query,
      gitlabUrl: input.gitlabUrl,
      cloneDir: input.cloneDir,
      forceRefresh: input.forceRefresh,
    });

    return {
      repos,
      lastSyncedAt,
      isSyncing,
      auth,
      errors,
    };
  });

  server.handle(TriggerSyncRpc, async (input) => {
    const { lastSyncedAt, auth } = await repoCacheService.syncAll(input.gitlabUrl, input.cloneDir);
    const { repos, errors } = await repoCacheService.getRepos({
      gitlabUrl: input.gitlabUrl,
      cloneDir: input.cloneDir,
    });
    return {
      success: errors.length === 0,
      lastSyncedAt,
      count: repos.length,
      errors,
      auth,
    };
  });

  server.handle(CreateWorkspaceRpc, async (input, { paseo }) => {
    return await cloneAndCreateWorkspace(input, paseo);
  });

  server.handle(readServicesRpc, readServices);

  server.handle(artifactsListRpc, async (input) => {
    const artifacts = await artifactsService.list(input);
    return { artifacts };
  });

  server.handle(artifactReadRpc, async ({ id }) => {
    const res = await artifactsService.read(id);
    if (!res) throw new Error("Артефакт не найден");
    return res;
  });

  server.handle(artifactSaveRpc, async (input) => {
    const artifact = await artifactsService.save(input);
    return { artifact };
  });

  server.handle(artifactUploadYadiskRpc, async ({ id }) => {
    return await artifactsService.uploadToYadisk(id);
  });

  server.handle(artifactSendTelegramRpc, async ({ id }) => {
    return await artifactsService.sendToTelegram(id);
  });

  server.handle(artifactDeleteRpc, async ({ id }) => {
    const ok = await artifactsService.delete(id);
    return { ok };
  });

  server.handle(pluginSyncRpc, async ({ action, jobId }) => {
    if (action === "status") {
      return new PluginSyncService(join(paseoHome, "hq-plugin-updates"), "paseo").status(jobId);
    }
    return (await pluginSyncService()).start(jobId);
  });

  const removeUsage = contributeUsageServer(server);

  const deepseekProvider = createDeepSeekHarnessProvider();
  server.registerProvider(deepseekProvider);
  server.registerUsageSource(createDeepSeekUsageSource());

  return () => {
    try {
      void deepseekProvider.dispose().catch((err) => {
        console.warn("[paseo-hq] deepseek provider dispose error", err);
      });
    } catch {
      // ignore
    }
    gitLogin.dispose();
    removeGenui();
    disposeTitles();
    disposeTurnBefore();
    disposeTurnAfter();
    disposeLaunchBranch();
    if (sampler) {
      sampler.stop();
      sampler = null;
    }
    try {
      repoCacheService.destroy();
    } catch {
      // ignore
    }
    try {
      removeUsage();
    } catch {
      // ignore
    }
  };
}
