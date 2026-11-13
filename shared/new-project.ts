// Черновик нового проекта в окне «Новая сессия»: откуда взять папку и как передать ее серверу.

export type NewProjectSource = "existing" | "create" | "clone";

export interface NewProjectDraft {
  source: NewProjectSource;
  /** Папка на сервере, путь новой папки или куда клонировать (для клона необязательно). */
  path: string;
  repoUrl: string;
  /** Название в списке; пустое - по имени папки. */
  name: string;
  initGit: boolean;
}

export const EMPTY_PROJECT_DRAFT: NewProjectDraft = { source: "existing", path: "", repoUrl: "", name: "", initGit: true };

const trimSlashes = (path: string) => path.trim().replace(/\/+$/, "");

export function splitFolderPath(path: string): { parentPath: string; folderName: string } {
  const clean = trimSlashes(path);
  const cut = clean.lastIndexOf("/");
  if (cut < 0) return { parentPath: "", folderName: clean };
  return { parentPath: clean.slice(0, cut) || "/", folderName: clean.slice(cut + 1) };
}

/** Имя папки из ссылки: git@host:org/repo.git, https://host/org/repo, owner/repo. */
export function repoFolderName(url: string): string {
  const last = url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}

/** Папка, в которой окажется проект. */
export function projectDraftRoot(draft: NewProjectDraft, defaultParent: string): string {
  if (draft.source !== "clone") return trimSlashes(draft.path);
  if (draft.path.trim()) return trimSlashes(draft.path);
  const repo = repoFolderName(draft.repoUrl);
  return repo ? `${trimSlashes(defaultParent)}/${repo}` : "";
}

export function projectDraftFolder(draft: NewProjectDraft, defaultParent: string): string {
  return splitFolderPath(projectDraftRoot(draft, defaultParent)).folderName;
}

export type ProjectAddInput =
  | { mode: "existing"; path: string; customName?: string }
  | { mode: "create"; parentPath: string; folderName: string; customName?: string; initGit: boolean }
  | { mode: "clone"; repoUrl: string; parentPath: string; folderName?: string; customName?: string };

/** Данные для sidebar.add или понятная ошибка, чего не хватает. */
export function projectAddInput(draft: NewProjectDraft, defaultParent: string): ProjectAddInput {
  const customName = draft.name.trim() || undefined;
  if (draft.source === "existing") {
    const path = trimSlashes(draft.path);
    if (!path) throw new Error("Укажите папку на сервере или выберите готовый репозиторий");
    return { mode: "existing", path, customName };
  }
  if (draft.source === "create") {
    const { parentPath, folderName } = splitFolderPath(draft.path);
    if (!folderName) throw new Error("Укажите путь новой папки, например ~/repos/my-project");
    return { mode: "create", parentPath: parentPath || trimSlashes(defaultParent), folderName, customName, initGit: draft.initGit };
  }
  const repoUrl = draft.repoUrl.trim();
  if (!repoUrl) throw new Error("Вставьте ссылку на Git-репозиторий");
  if (!draft.path.trim()) return { mode: "clone", repoUrl, parentPath: trimSlashes(defaultParent), customName };
  const { parentPath, folderName } = splitFolderPath(draft.path);
  return { mode: "clone", repoUrl, parentPath: parentPath || trimSlashes(defaultParent), folderName: folderName || undefined, customName };
}
