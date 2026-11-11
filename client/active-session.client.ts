import { useEffect, useState } from "react";
import { Platform } from "react-native";

/** The public SDK has no focused-tab subscription. Web/Electron expose tab identities in the host DOM. */
export function useActiveSession() {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const read = () => {
      const selected = Array.from(document.querySelectorAll('[data-testid="workspace-tabs-row"] [aria-selected="true"][data-testid^="workspace-tab-"]'))
        .filter(node => node.getClientRects().length > 0)
        .map(node => node.getAttribute("data-testid")!.slice("workspace-tab-".length));
      // Multiple visible pane selections cannot identify a single focused session reliably.
      const next = selected.length === 1 && /^(agent|terminal)_/.test(selected[0]!) ? selected[0]! : null;
      setActive(previous => previous === next ? previous : next);
    };
    const observer = new MutationObserver(read);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected", "data-testid"] });
    window.addEventListener("resize", read);
    read();
    return () => { observer.disconnect(); window.removeEventListener("resize", read); };
  }, []);
  return active;
}
