// Путь worktree по умолчанию: рядом с проектом, <родитель>/<имя проекта>-<ветка>.
export function worktreeSlug(branch: string) {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
}

export function defaultWorktreePath(rootPath: string, branch: string) {
  const root = rootPath.replace(/\/+$/, "");
  const cut = root.lastIndexOf("/");
  return `${root.slice(0, cut)}/${root.slice(cut + 1)}-${worktreeSlug(branch)}`;
}
