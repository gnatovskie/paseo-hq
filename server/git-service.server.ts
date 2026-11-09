import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { RepoItem } from "../shared/git-contracts";
import { existsSync } from "node:fs";

/** glab: PASEO_GLAB_BIN → ~/.local/bin/glab (if present) → "glab" from PATH. */
export function glabBin(): string {
  const fromEnv = process.env.PASEO_GLAB_BIN;
  if (fromEnv) return fromEnv;
  const local = path.join(os.homedir(), ".local/bin/glab");
  return existsSync(local) ? local : "glab";
}

const exec = promisify(execFile);

export function parseGitLabHost(urlOrHost?: string): string {
  if (!urlOrHost || !urlOrHost.trim()) return "gitlab.com";
  const raw = urlOrHost.trim();
  const match = raw.match(/^(?:https?:\/\/)?([^/:]+)(?::\d+)?/);
  if (match && match[1]) {
    return match[1];
  }
  return raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

export function resolveCloneDir(dir?: string): string {
  const d = dir?.trim() || "~/repos";
  if (d.startsWith("~")) {
    return path.join(os.homedir(), d.slice(1));
  }
  return path.resolve(d);
}

export async function checkGitHubAuth(): Promise<{
  installed: boolean;
  loggedIn: boolean;
  user?: string;
  error?: string;
}> {
  try {
    const { stdout, stderr } = await exec("gh", ["auth", "status"]);
    const output = `${stdout}\n${stderr}`;
    const userMatch = output.match(/Logged in to [^ ]+ account ([^ (]+)/i);
    return {
      installed: true,
      loggedIn: true,
      user: userMatch ? userMatch[1] : undefined,
    };
  } catch (err: unknown) {
    const stderr =
      typeof err === "object" && err !== null && "stderr" in err
        ? String(err.stderr)
        : err instanceof Error
          ? err.message
          : String(err);
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String(err.code)
        : "";
    if (code === "ENOENT") {
      return {
        installed: false,
        loggedIn: false,
        error: "GitHub CLI (gh) не установлен",
      };
    }
    return {
      installed: true,
      loggedIn: false,
      error: stderr.trim() || "Вход в GitHub CLI не выполнен",
    };
  }
}

export async function checkGitLabAuth(gitlabUrl?: string): Promise<{
  installed: boolean;
  loggedIn: boolean;
  host: string;
  user?: string;
  error?: string;
}> {
  const host = parseGitLabHost(gitlabUrl);
  try {
    const { stdout, stderr } = await exec(glabBin(), ["auth", "status", "--hostname", host]);
    const output = `${stdout}\n${stderr}`;
    const userMatch = output.match(/Logged in to [^ ]+ as ([^ (]+)/i);
    return {
      installed: true,
      loggedIn: true,
      host,
      user: userMatch ? userMatch[1] : undefined,
    };
  } catch (err: unknown) {
    const stderr =
      typeof err === "object" && err !== null && "stderr" in err
        ? String(err.stderr)
        : err instanceof Error
          ? err.message
          : String(err);
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String(err.code)
        : "";
    if (code === "ENOENT") {
      return {
        installed: false,
        loggedIn: false,
        host,
        error: "GitLab CLI (glab) не установлен",
      };
    }
    return {
      installed: true,
      loggedIn: false,
      host,
      error: stderr.trim() || `GitLab CLI (${host}) вход не выполнен`,
    };
  }
}

async function isGitRepoLocally(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(targetPath, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

// Existing primary checkouts in the root can have names unlike their remote.
export function remoteKey(remote: string): string | undefined {
  const value = remote.trim();
  const match = value.match(/^(?:https?:\/\/|ssh:\/\/(?:git@)?|git@)([^/:]+)[:/]([^?#]+?)(?:\.git)?\/?$/);
  return match ? `${match[1].toLowerCase()}/${match[2].replace(/\.git\/?$/, "").replace(/\/$/, "")}` : undefined;
}

export async function existingCheckouts(base: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(base, { withFileTypes: true }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return index;
    throw error;
  }
  await Promise.all(entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map(async (entry) => {
    const dir = path.join(base, entry.name);
    if (!await isGitRepoLocally(dir)) return;
    try {
      const { stdout } = await exec("git", ["-C", dir, "config", "--get", "remote.origin.url"]);
      const key = remoteKey(stdout);
      if (key) index.set(key, [...(index.get(key) ?? []), dir]);
    } catch { /* A local repository without an origin cannot be matched. */ }
  }));
  return index;
}

export async function resolveExistingCheckout(base: string, host: string, name: string, index: Map<string, string[]>): Promise<string | undefined> {
  const target = path.join(base, host, name);
  const key = `${host.toLowerCase()}/${name}`;
  const matches = [...(index.get(key) ?? [])];
  if (await isGitRepoLocally(target)) {
    const { stdout } = await exec("git", ["-C", target, "config", "--get", "remote.origin.url"]);
    if (remoteKey(stdout) !== key) throw new Error("В целевой папке находится другой репозиторий: " + target);
    if (!matches.includes(target)) matches.push(target);
  }
  if (matches.length > 1) throw new Error("Найдено несколько копий репозитория: " + matches.join(", "));
  return matches[0];
}

interface RawGhRepo {
  fullName?: string;
  nameWithOwner?: string;
  name?: string;
  description?: string;
  url?: string;
  sshUrl?: string;
  isPrivate?: boolean;
  defaultBranchRef?: { name?: string };
}

export async function fetchGitHubRepos(
  query: string | undefined,
  cloneBaseDir: string,
): Promise<RepoItem[]> {
  try {
    let stdout = "";
    if (query && query.trim()) {
      const res = await exec("gh", [
        "search",
        "repos",
        query.trim(),
        "--limit",
        "30",
        "--json",
        "fullName,name,description,url,sshUrl,isPrivate,defaultBranchRef",
      ]);
      stdout = res.stdout;
    } else {
      const res = await exec("gh", [
        "repo",
        "list",
        "--limit",
        "30",
        "--json",
        "nameWithOwner,name,description,url,sshUrl,isPrivate,defaultBranchRef",
      ]);
      stdout = res.stdout;
    }

    const items = JSON.parse(stdout || "[]") as RawGhRepo[];
    const localIndex = await existingCheckouts(cloneBaseDir);
    const results: RepoItem[] = [];

    for (const item of items) {
      const fullName = item.fullName || item.nameWithOwner;
      if (!fullName) continue;
      const matches = localIndex.get(`github.com/${fullName}`) ?? [];
      const target = path.join(cloneBaseDir, "github.com", fullName);
      const localPath = matches.length === 1 ? matches[0] : target;
      const isLocal = matches.length > 0 || await isGitRepoLocally(target);

      results.push({
        id: `github:${fullName}`,
        name: item.name || fullName.split("/")[1] || fullName,
        fullName,
        description: item.description || "",
        url: item.url || `https://github.com/${fullName}`,
        sshUrl: item.sshUrl || `git@github.com:${fullName}.git`,
        httpUrl: item.url ? `${item.url}.git` : `https://github.com/${fullName}.git`,
        defaultBranch: item.defaultBranchRef?.name || "main",
        provider: "github",
        isPrivate: Boolean(item.isPrivate),
        isLocal,
        localPath,
      });
    }

    return results;
  } catch (err: unknown) {
    console.error("fetchGitHubRepos error:", err);
    return [];
  }
}

interface RawGitLabRepo {
  name?: string;
  path_with_namespace?: string;
  description?: string;
  web_url?: string;
  ssh_url_to_repo?: string;
  http_url_to_repo?: string;
  default_branch?: string;
  visibility?: string;
}

export async function fetchGitLabRepos(
  query: string | undefined,
  gitlabUrl: string | undefined,
  cloneBaseDir: string,
): Promise<RepoItem[]> {
  const host = parseGitLabHost(gitlabUrl);
  try {
    const apiPath =
      query && query.trim()
        ? `projects?search=${encodeURIComponent(query.trim())}&membership=true&per_page=30`
        : `projects?membership=true&order_by=last_activity_at&per_page=30`;

    const { stdout } = await exec(glabBin(), [
      "api",
      apiPath,
      "--hostname",
      host,
    ]);

    const items = JSON.parse(stdout || "[]") as RawGitLabRepo[];
    if (!Array.isArray(items)) return [];

    const results: RepoItem[] = [];
    const localIndex = await existingCheckouts(cloneBaseDir);

    for (const item of items) {
      const fullName = item.path_with_namespace;
      if (!fullName) continue;
      const matches = localIndex.get(`${host.toLowerCase()}/${fullName}`) ?? [];
      const target = path.join(cloneBaseDir, host, fullName);
      const localPath = matches.length === 1 ? matches[0] : target;
      const isLocal = matches.length > 0 || await isGitRepoLocally(target);

      results.push({
        id: `gitlab:${host}:${fullName}`,
        name: item.name || fullName.split("/").pop() || fullName,
        fullName,
        description: item.description || "",
        url: item.web_url || `https://${host}/${fullName}`,
        sshUrl: item.ssh_url_to_repo || `git@${host}:${fullName}.git`,
        httpUrl: item.http_url_to_repo || `https://${host}/${fullName}.git`,
        defaultBranch: item.default_branch || "main",
        provider: "gitlab",
        isPrivate: item.visibility === "private" || item.visibility === "internal",
        isLocal,
        localPath,
      });
    }

    return results;
  } catch (err: unknown) {
    const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
    // glab not installed: GitLab is simply unavailable, not an error worth logging.
    if (code === "ENOENT") return [];
    console.error("fetchGitLabRepos error:", err instanceof Error ? err.message.split("\n")[0] : String(err));
    return [];
  }
}

export async function cloneAndCreateWorkspace(
  params: {
    provider: "github" | "gitlab";
    repoFullName: string;
    cloneUrl: string;
    branch?: string;
    isolation: "worktree" | "local";
    gitlabUrl?: string;
    cloneDir?: string;
  },
  paseo: PluginHandlerContext["paseo"],
): Promise<{ workspaceId: string; title: string; localPath: string }> {
  const cloneBaseDir = resolveCloneDir(params.cloneDir);
  const host = params.provider === "github" ? "github.com" : parseGitLabHost(params.gitlabUrl);
  const localIndex = await existingCheckouts(cloneBaseDir);
  const existingPath = await resolveExistingCheckout(cloneBaseDir, host, params.repoFullName, localIndex);
  const targetPath = existingPath ?? path.join(cloneBaseDir, host, params.repoFullName);

  const isLocal = Boolean(existingPath);

  // 1. 如果本地尚未克隆，先执行完整 clone 以确保 .git 和 HEAD 结构完整
  if (!isLocal) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    console.log(`[git-workspace] Cloning ${params.cloneUrl} into ${targetPath}...`);
    await exec("git", ["clone", params.cloneUrl, targetPath]);
    console.log(`[git-workspace] Clone completed for ${params.repoFullName}`);
  }

  // 2. 本地已完整存在，安全创建 Paseo 工作区
  const workspace = await paseo.workspaces.create({
    title: params.repoFullName,
    source:
      params.isolation === "worktree"
        ? {
            kind: "worktree",
            cwd: targetPath,
            action: "checkout",
            refName: params.branch || undefined,
          }
        : {
            kind: "directory",
            path: targetPath,
          },
  });

  return {
    workspaceId: workspace.id,
    title: params.repoFullName,
    localPath: targetPath,
  };
}
