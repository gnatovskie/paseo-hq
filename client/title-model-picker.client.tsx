import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { filterTitleModels, titleModelProviders, type TitleModelOption } from "../shared/title-models";

// Paseo's SettingsSelect cuts long labels and does not scroll on phones, so the
// title model is picked here: provider chips, search, and a bounded scroll list.
export function TitleModelPicker({ theme, options, value, hint, onValueChange }: {
  theme: PluginTheme;
  options: readonly TitleModelOption[];
  value: string;
  hint: string;
  onValueChange(value: string): void;
}) {
  const c = theme.colors;
  const providers = useMemo(() => titleModelProviders(options), [options]);
  const current = options.find(option => option.value === value) ?? options[0];
  const [provider, setProvider] = useState<string | null>(current?.provider || null);
  const [query, setQuery] = useState("");
  // A query searches every provider; otherwise show the chosen provider's models.
  const activeProvider = query ? null : provider ?? providers[0]?.provider ?? null;
  const shown = filterTitleModels(options, activeProvider, query);

  const chip = (key: string, label: string, active: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? c.accent : c.border,
        backgroundColor: active ? c.accent : c.surface1,
      }}
    >
      <Text style={{ fontSize: 12, color: active ? c.accentForeground : c.foreground }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: c.foreground }}>Модель для названий областей</Text>
      <Text style={{ fontSize: 12, color: c.foregroundMuted }}>{hint}</Text>
      <View style={{ padding: 10, borderRadius: 9, borderWidth: 1, borderColor: c.accent, backgroundColor: c.surface1, gap: 2 }}>
        {current?.providerLabel ? <Text style={{ fontSize: 11, color: c.foregroundMuted }}>{current.providerLabel}</Text> : null}
        <Text style={{ fontSize: 14, color: c.foreground }}>{current?.name ?? value}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {chip("first_line", "Без ИИ", value === "first_line", () => onValueChange("first_line"))}
        {providers.map(item => chip(item.provider, `${item.label} · ${item.count}`, activeProvider === item.provider, () => {
          setQuery("");
          setProvider(item.provider);
        }))}
      </View>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Поиск модели по всем провайдерам"
        placeholderTextColor={c.foregroundMuted}
        style={{
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 9,
          backgroundColor: c.surface1,
          borderWidth: 1,
          borderColor: c.border,
          color: c.foreground,
        }}
      />
      <ScrollView
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        style={{ maxHeight: 280, borderRadius: 9, borderWidth: 1, borderColor: c.border }}
      >
        {shown.length === 0 ? (
          <Text style={{ padding: 12, fontSize: 12, color: c.foregroundMuted }}>Ничего не найдено</Text>
        ) : shown.map(option => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              onPress={() => onValueChange(option.value)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 12,
                paddingVertical: 9,
                borderBottomWidth: 1,
                borderBottomColor: c.border,
                backgroundColor: selected ? c.surface2 : "transparent",
              }}
            >
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={{ fontSize: 14, color: c.foreground }}>{query ? option.label : option.name}</Text>
                <Text style={{ fontSize: 11, color: c.foregroundMuted }}>{option.value}</Text>
              </View>
              {selected ? <Icon name="Check" size={16} color={c.accent} /> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
