import React, { createContext, useState } from "react";
import { TextInput, View, Pressable, Text } from "react-native";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";

export const TextSelectionContext = createContext(false);

/** UITextView supplies range selection on iOS; RN Text only copies the paragraph. */
export function SelectionText({ text, theme }: { text: string; theme: PluginTheme }) {
  const [height, setHeight] = useState(60);
  const toast = useToast();
  return <View style={{ gap: 6 }}>
    <TextInput
      accessibilityLabel="Текст для выделения"
      value={text}
      editable={false}
      multiline
      scrollEnabled={false}
      contextMenuHidden={false}
      showSoftInputOnFocus={false}
      onContentSizeChange={event => setHeight(Math.max(44, event.nativeEvent.contentSize.height))}
      style={{ color: theme.colors.foreground, fontSize: 13.5, lineHeight: 20, padding: 0, height, minHeight: 44 }}
    />
    <Pressable accessibilityRole="button" accessibilityLabel="Копировать текст блока" hitSlop={8}
      onPress={() => { void copyText(text).then(
        () => toast.show("Текст скопирован", { variant: "success" }),
        () => toast.error("Не удалось скопировать текст"),
      ); }} style={{ alignSelf: "flex-end", paddingVertical: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Копировать</Text>
    </Pressable>
  </View>;
}
