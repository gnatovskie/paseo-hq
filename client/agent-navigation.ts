import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";

interface Destination {
  hostId: string;
  workspaceId?: string;
  agentId: string;
  platform: PluginSidebarItemProps["layout"]["platform"];
}
interface Navigation {
  openURL(url: string): Promise<unknown>;
  openScreen: PluginSidebarItemProps["openScreen"];
}
export async function openAgentTab(target: Destination, navigation: Navigation) {
  if (target.platform !== "web" && target.workspaceId) {
    const path = `/h/${encodeURIComponent(target.hostId)}/workspace/${encodeURIComponent(target.workspaceId)}`;
    await navigation.openURL(`paseo://${path}?open=${encodeURIComponent(`agent:${target.agentId}`)}`);
    return;
  }
  navigation.openScreen({ screenId: "jump", params: { agentId: target.agentId, t: String(Date.now()) } });
}
