type SortableProject = {
  id?: string; name: string; createdAt?: number; lastPromptAt: number; lastReplyAt?: number;
  meta: { pinned?: boolean; pinnedAt?: number; priority?: number };
};
export function compareProjectOrder(a: SortableProject, b: SortableProject, mode: "auto" | "manual" = "auto", basis: "prompt" | "reply" | "created" = "prompt"): number {
  if (a.meta.pinned || b.meta.pinned) return Number(Boolean(b.meta.pinned)) - Number(Boolean(a.meta.pinned))
    || (b.meta.pinnedAt ?? 0) - (a.meta.pinnedAt ?? 0)
    || a.name.localeCompare(b.name, "ru");
  const activity = basis === "reply" ? (b.lastReplyAt ?? 0) - (a.lastReplyAt ?? 0) : b.lastPromptAt - a.lastPromptAt;
  return (mode === "auto" && basis !== "created" ? activity : 0)
    || (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.name.localeCompare(b.name, "ru");
}
