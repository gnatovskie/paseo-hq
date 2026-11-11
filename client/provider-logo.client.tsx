import { Image } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { USAGE_LOGOS } from "../shared/logos.shared";

const logoKeys: Record<string, string> = {
  codex: "codex", claude: "claude", opencode: "opencode-zen",
  copilot: "github-copilot", minimax: "minimax", antigravity: "antigravity",
  gemini: "antigravity", cursor: "cursor",
};

/** Bundled assets: no remote image requests from the model field. */
export function ProviderLogo({ model, color }: { model: string; color: string }) {
  const provider = model.split("/")[0]!;
  const uri = USAGE_LOGOS[logoKeys[provider] ?? provider];
  return uri ? <Image accessibilityLabel={`Провайдер ${provider}`} source={{ uri }} resizeMode="contain"
    style={{ width: 20, height: 20, ...(provider === "codex" || provider === "opencode" ? { tintColor: color } : {}) }} />
    : <Icon name="Bot" size={20} color={color} />;
}
