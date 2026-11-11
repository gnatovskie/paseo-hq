import type { PaseoAgentConfig, PaseoProviderSnapshotResult } from "@getpaseo/client";

/** Catalog IDs are provider-specific; never carry unsupported options to another model. */
export function agentCreationOptions(
  entries: PaseoProviderSnapshotResult["entries"],
  selection: string | null,
  preferred: Pick<PaseoAgentConfig, "modeId" | "thinkingOptionId">,
) {
  const provider = entries.find(entry => selection?.startsWith(`${entry.provider}/`));
  const model = provider?.models?.find(model => `${provider.provider}/${model.id}` === selection);
  const modes = provider?.modes ?? [];
  const thinkingOptions = model?.thinkingOptions ?? [];
  return {
    modes,
    thinkingOptions,
    modeId: modes.some(mode => mode.id === preferred.modeId) ? preferred.modeId
      : modes.find(mode => mode.id === provider?.defaultModeId)?.id,
    thinkingOptionId: thinkingOptions.some(option => option.id === preferred.thinkingOptionId) ? preferred.thinkingOptionId
      : thinkingOptions.find(option => option.id === model?.defaultThinkingOptionId)?.id
        ?? thinkingOptions.find(option => option.isDefault)?.id,
  };
}
