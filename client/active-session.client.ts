import { useEffect, useState } from "react";
import { Platform } from "react-native";

/** The public SDK has no focused-tab subscription. Web/Electron expose tab identities in the host DOM. */
export function useActiveSession() {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    let focusedPane: Element | null = document.activeElement?.closest('[data-testid^="workspace-pane-"]') ?? null;
    const read = () => {
      const selected = Array.from(document.querySelectorAll('[data-testid="workspace-tabs-row"] [aria-selected="true"][data-testid^="workspace-tab-"]'))
        .filter(node => node.getClientRects().length > 0)
        .map(node => node.getAttribute("data-testid")!.slice("workspace-tab-".length));
      if (focusedPane && !focusedPane.isConnected) focusedPane = null;
      const focusedTab = focusedPane?.querySelector('[data-testid="workspace-tabs-row"] [aria-selected="true"][data-testid^="workspace-tab-"]');
      const identity = focusedTab?.getAttribute("data-testid")?.slice("workspace-tab-".length)
        ?? (selected.length === 1 ? selected[0] : null);
      const next = identity && /^(agent|terminal)_/.test(identity) ? identity : null;
      setActive(previous => previous === next ? previous : next);
    };
    // Sidebar and dialogs must retain the last focused content pane.
    const rememberPane = (event: Event) => {
      const pane = event.target instanceof Element ? event.target.closest('[data-testid^="workspace-pane-"]') : null;
      if (pane) { focusedPane = pane; read(); }
    };
    document.addEventListener("pointerdown", rememberPane, true);
    document.addEventListener("focusin", rememberPane, true);
    const observer = new MutationObserver(read);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected", "data-testid"] });
    window.addEventListener("resize", read);
    read();
    return () => { observer.disconnect(); window.removeEventListener("resize", read); document.removeEventListener("pointerdown", rememberPane, true); document.removeEventListener("focusin", rememberPane, true); };
  }, []);
  return active;
}
