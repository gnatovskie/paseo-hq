// Host-only UI adapters for the isolated React Native Web smoke test.
import React, { useMemo } from "react";
import { Text, TextInput, View, ScrollView } from "react-native";
export { TextInput, ScrollView };
export const Icon = () => null;
export const Markdown = ({ children }: { children: React.ReactNode }) => <Text>{children}</Text>;
export const ExternalLink = Markdown;
export const SidebarRow = Markdown;
export const SettingsCard = View;
export const SettingsSection = View;
export const SettingsInput = TextInput;
export const SettingsSwitch = View;
export const SettingsAction = View;
export const Modal = ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? <View>{children}</View> : null;
export const copyText = async (text: string) => {
  let output = document.getElementById("copied");
  if (!output) { output = document.createElement("div"); output.id = "copied"; document.body.appendChild(output); }
  output.textContent = text;
};
export const useToast = () => ({ show() {} });
export const useRevealedText = (text: string) => text;
export const openExternalUrl = async () => {};
export const useSettings = () => ({ status: "loading" });
export const useRpc = (contract: { name: string }) => useMemo(() => async (input: unknown) => {
  const response = await fetch("/rpc", { method: "POST", body: JSON.stringify({ method: contract.name, input }) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}, [contract.name]);
const api = { agents: { ref: () => ({ send: async (text: string) => { document.getElementById("sent")!.textContent = text; } }) } };
export const usePaseo = () => api;
