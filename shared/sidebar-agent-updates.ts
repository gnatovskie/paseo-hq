import type { PaseoAgentListResult, PaseoAgentUpdate } from "@getpaseo/client";

/** Updates already contain the full agent. Do not refetch the entire sidebar for each event. */
export function applyAgentUpdate(entries: PaseoAgentListResult["entries"], update: PaseoAgentUpdate): PaseoAgentListResult["entries"] {
  const id = update.kind === "remove" ? update.agentId : update.agent.id;
  if (update.kind === "remove" || update.agent.archivedAt || update.agent.internal) {
    return entries.filter(entry => entry.agent.id !== id);
  }
  const existing = entries.find(entry => entry.agent.id === id);
  const project = update.project ?? existing?.project;
  // Older hosts can announce an agent before its placement. The periodic list
  // supplies that missing placement; never fabricate a project from its cwd.
  if (!project) return entries;
  const next = { ...existing, agent: update.agent, project };
  return existing ? entries.map(entry => entry.agent.id === id ? next : entry) : [...entries, next];
}
