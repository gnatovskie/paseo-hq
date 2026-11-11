import { Platform } from "react-native";

interface PopupPosition {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

// The browser top layer escapes clipping while keeping the popup inside the
// owning dialog's DOM focus scope. Native clients use React Native Modal.
export function presentWebPopup(node: unknown, position: PopupPosition, onClose: () => void): () => void {
  if (Platform.OS !== "web" || !(node instanceof HTMLElement)) return () => {};
  node.setAttribute("popover", "auto");
  Object.assign(node.style, {
    position: "fixed",
    margin: "0",
    inset: "auto",
    left: `${position.left}px`,
    top: position.top === undefined ? "auto" : `${position.top}px`,
    bottom: position.bottom === undefined ? "auto" : `${position.bottom}px`,
    width: `${position.width}px`,
    maxHeight: `${position.maxHeight}px`,
  });
  const toggle = (event: Event) => {
    if ("newState" in event && event.newState === "closed") onClose();
  };
  node.addEventListener("toggle", toggle);
  node.showPopover();
  return () => {
    node.removeEventListener("toggle", toggle);
    node.hidePopover();
    node.removeAttribute("popover");
  };
}
