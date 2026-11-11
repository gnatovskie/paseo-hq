import { execFile } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { currentGitBranch, localGitBranches } from "./area-git.server";

// Worktree, которые Штаб создает сам рядом с проектом (а не в ~/.paseo/worktrees, как Paseo).
// Paseo о них не знает и при архивации области не удаляет, поэтому уборка тоже здесь.

const runGit = promisify(execFile);

async function git(cwd: string, args: string[], timeout = 15_000) {
  try {
    const { stdout } = await runGit("git", args, { cwd, timeout });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (error as Error).message);
  }
}

/** Ветки, уже проверенные в каком-то worktree (включая сам корень): git не даст взять их второй раз. */
async function checkedOutBranches(rootPath: string) {
  const out = await git(rootPath, ["worktree", "list", "--porcelain"]);
  return out.split("\n").filter(line => line.startsWith("branch refs/heads/")).map(line => line.slice("branch refs/heads/".length));
}

export async function worktreeOptions(rootPath: string) {
  const isGit = await git(rootPath, ["rev-parse", "--is-inside-work-tree"]).then(out => out === "true", () => false);
  if (!isGit) return { isGit: false, branches: [], checkedOut: [], currentBranch: null };
  const [branches, checkedOut, currentBranch] = await Promise.all([
    localGitBranches(rootPath),
    checkedOutBranches(rootPath),
    currentGitBranch(rootPath),
  ]);
  return { isGit: true, branches, checkedOut, currentBranch };
}

export async function createWorktree(rootPath: string, input: {
  path: string;
  branch: string;
  newBranch: boolean;
  baseBranch?: string;
}) {
  const path = resolve(input.path.trim());
  if (!isAbsolute(input.path.trim())) throw new Error("Укажите полный путь к папке");
  const inside = relative(rootPath, path);
  if (!inside || (!inside.startsWith("..") && !isAbsolute(inside))) {
    throw new Error("Папка worktree не может быть внутри проекта");
  }
  if (await stat(path).then(() => true, () => false)) throw new Error(`Папка уже существует: ${path}`);
  await access(dirname(path), constants.W_OK).catch(() => {
    throw new Error(`Нет доступа на запись в ${dirname(path)}`);
  });

  const branch = input.branch.trim();
  await git(rootPath, ["check-ref-format", "--branch", branch]).catch(() => {
    throw new Error(`Недопустимое имя ветки: ${branch}`);
  });
  const branches = await localGitBranches(rootPath);
  if (input.newBranch) {
    if (branches.includes(branch)) throw new Error(`Ветка ${branch} уже есть, выберите ее как существующую`);
    const base = input.baseBranch?.trim();
    if (!base || !branches.includes(base)) throw new Error("Выберите базовую ветку");
    await git(rootPath, ["worktree", "add", "-b", branch, path, base], 60_000);
  } else {
    if (!branches.includes(branch)) throw new Error(`Ветки ${branch} нет`);
    if ((await checkedOutBranches(rootPath)).includes(branch)) {
      throw new Error(`Ветка ${branch} уже открыта в другой папке`);
    }
    await git(rootPath, ["worktree", "add", path, branch], 60_000);
  }
  return { path, branch };
}

/** Состояние worktree перед удалением: незакоммиченные и неотслеживаемые файлы. */
export async function worktreeStatus(path: string) {
  const exists = await stat(path).then(entry => entry.isDirectory(), () => false);
  if (!exists) return { exists: false, changes: [] as string[] };
  const out = await git(path, ["status", "--porcelain"]);
  return { exists: true, changes: out ? out.split("\n") : [] };
}

export async function removeWorktree(rootPath: string, path: string, force: boolean) {
  const { exists, changes } = await worktreeStatus(path);
  if (!exists) {
    // Папку удалили руками: убираем запись о ней из git.
    await git(rootPath, ["worktree", "prune"]);
    return;
  }
  if (changes.length && !force) throw new Error("В папке есть незакоммиченные изменения");
  await git(rootPath, ["worktree", "remove", ...(force ? ["--force"] : []), path], 60_000);
}
