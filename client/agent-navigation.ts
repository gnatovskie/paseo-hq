import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";

interface Destination {
  agentId: string;
}
interface Navigation {
  openScreen: PluginSidebarItemProps["openScreen"];
}
let navigationSequence = 0;

export async function openAgentTab(target: Destination, navigation: Navigation) {
  // openScreen dismisses the host sidebar; the bridge calls navigation.openAgent,
  // which reveals the mobile chat panel even when this tab already exists.
  // A workspace ?open= deep link only queues a tab and skips both steps.
  navigation.openScreen({
    screenId: "jump",
    params: { agentId: target.agentId, t: `${Date.now()}-${++navigationSequence}` },
  });
}
