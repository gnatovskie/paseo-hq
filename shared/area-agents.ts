import type { PaseoAgentListResult } from "@getpaseo/client";

type AgentEntry = PaseoAgentListResult["entries"][number];

export function groupAreaAgents(entries: readonly AgentEntry[], modes: Record<string, "prompt" | "reply"> = {}, replies: Record<string, number> = {}): Map<string, AgentEntry[]> {
  const map = new Map<string, AgentEntry[]>();
  for (const entry of entries) {
    if (entry.agent.archivedAt || entry.agent.internal || !entry.agent.workspaceId) continue;
    const list = map.get(entry.agent.workspaceId) ?? [];
    list.push(entry);
    map.set(entry.agent.workspaceId, list);
  }
  const timestamp = (value: string | null | undefined) => value ? Date.parse(value) || 0 : 0;
  const promptTime = ({ agent }: AgentEntry) => modes[agent.workspaceId!] === "reply"
    ? replies[agent.id] || timestamp(agent.createdAt)
    : timestamp(agent.lastUserMessageAt) || timestamp(agent.createdAt);
  for (const list of map.values()) {
    // Runtime activity does not determine visible order; use the selected message timestamp.
    list.sort((a, b) => promptTime(b) - promptTime(a)
      || timestamp(b.agent.createdAt) - timestamp(a.agent.createdAt)
      || a.agent.id.localeCompare(b.agent.id));
  }
  return map;
}

export function compareAreaOrder(a: { id: string; createdAt?: string }, b: { id: string; createdAt?: string }, pinned: Record<string, number>, mode: "auto" | "manual", priorities: Record<string, number>, activity: (id: string) => number): number {
  const ap = pinned[a.id] || 0, bp = pinned[b.id] || 0;
  if (ap || bp) return bp - ap || a.id.localeCompare(b.id);
  if (mode === "manual") {
    return (priorities[b.id] ?? 10) - (priorities[a.id] ?? 10)
      || (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0)
      || a.id.localeCompare(b.id);
  }
  return activity(b.id) - activity(a.id) || a.id.localeCompare(b.id);
}
