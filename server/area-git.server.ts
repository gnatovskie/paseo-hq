import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runGit = promisify(execFile);

export async function currentGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd, timeout: 1500 });
    return stdout.trim().replace(/^refs\/heads\//, "") || null;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 1 || code === 128) return null;
    throw error;
  }
}

export async function localGitBranches(cwd: string): Promise<string[]> {
  const { stdout } = await runGit(
    "git",
    ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads/"],
    { cwd, timeout: 3000 },
  );
  return stdout.trim().split("\n").filter(Boolean);
}
