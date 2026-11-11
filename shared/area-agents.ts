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

export function compareAreaOrder(a: { id: string }, b: { id: string }, pinned: Record<string, number>, mode: "auto" | "manual", order: readonly string[], activity: (id: string) => number): number {
  const ap = pinned[a.id] || 0, bp = pinned[b.id] || 0;
  if (ap || bp) return bp - ap || a.id.localeCompare(b.id);
  if (mode === "manual") {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi) || a.id.localeCompare(b.id);
  }
  return activity(b.id) - activity(a.id) || a.id.localeCompare(b.id);
}
