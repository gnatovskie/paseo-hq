import type { PaseoApi, PaseoAgent, PaseoAgentConfig, PaseoAgentListResult } from "@getpaseo/client";

/** Reuse the project's last agent choice without copying its prompt or session. */
export async function projectAgentConfig(
  paseo: PaseoApi,
  project: { rootPath: string; chats: { id: string }[] },
  entries: PaseoAgentListResult["entries"],
): Promise<PaseoAgentConfig> {
  const workspaceIds = new Set(project.chats.map(chat => chat.id));
  const recent = entries.map(entry => entry.agent)
    .filter(agent => !agent.internal && !agent.archivedAt && !agent.providerUnavailable)
    .sort((a, b) => Date.parse(b.lastUserMessageAt ?? b.updatedAt) - Date.parse(a.lastUserMessageAt ?? a.updatedAt));
  const previous = recent.find(agent => agent.workspaceId && workspaceIds.has(agent.workspaceId)) ?? recent[0];
  if (previous) return agentConfig(previous);

  const snapshot = await paseo.providers.waitForReady({ cwd: project.rootPath });
  const provider = snapshot.entries.find(entry => entry.enabled && entry.status === "ready");
  if (!provider) throw new Error("Нет доступного провайдера для новой сессии");
  const selectable = provider.models?.filter(model => model.isSelectable !== false);
  const model = selectable?.find(model => model.isDefault) ?? selectable?.[0];
  return {
    provider: model ? `${provider.provider}/${model.id}` : provider.provider,
    ...(provider.defaultModeId ? { modeId: provider.defaultModeId } : {}),
  };
}

function agentConfig(agent: PaseoAgent): PaseoAgentConfig {
  return {
    provider: agent.model ? `${agent.provider}/${agent.model}` : agent.provider,
    ...(agent.currentModeId ? { modeId: agent.currentModeId } : {}),
    ...(agent.thinkingOptionId ? { thinkingOptionId: agent.thinkingOptionId } : {}),
    featureValues: Object.fromEntries((agent.features ?? [])
      .filter(feature => feature.value !== null)
      .map(feature => [feature.id, feature.value])),
  };
}
