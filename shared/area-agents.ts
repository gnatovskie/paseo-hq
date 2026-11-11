import type { PaseoAgentListResult } from "@getpaseo/client";

type AgentEntry = PaseoAgentListResult["entries"][number];

export function groupAreaAgents(entries: readonly AgentEntry[]): Map<string, AgentEntry[]> {
  const map = new Map<string, AgentEntry[]>();
  for (const entry of entries) {
    if (entry.agent.archivedAt || entry.agent.internal || !entry.agent.workspaceId) continue;
    const list = map.get(entry.agent.workspaceId) ?? [];
    list.push(entry);
    map.set(entry.agent.workspaceId, list);
  }
  const timestamp = (value: string | null | undefined) => value ? Date.parse(value) || 0 : 0;
  const promptTime = ({ agent }: AgentEntry) => timestamp(agent.lastUserMessageAt) || timestamp(agent.createdAt);
  for (const list of map.values()) {
    // SDK order follows runtime activity. Visible sessions follow the user's prompts instead.
    list.sort((a, b) => promptTime(b) - promptTime(a)
      || timestamp(b.agent.createdAt) - timestamp(a.agent.createdAt)
      || a.agent.id.localeCompare(b.agent.id));
  }
  return map;
}
