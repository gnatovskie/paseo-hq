import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Keyboard, Modal, Platform, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { filterTitleModels, titleModelProviders, type TitleModelOption } from "../shared/title-models";
import { presentWebPopup } from "./web";

interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function TitleModelPicker({ theme, options, value, hint, disabled, pending, onValueChange, label = "Сгенерировать название", icon = "Sparkles", menuLabel = "Модели для названий областей", plain = false, selectionLabel }: {
  theme: PluginTheme;
  options: readonly TitleModelOption[];
  value: string;
  hint?: string;
  disabled?: boolean;
  pending?: boolean;
  onValueChange(value: string): void;
  label?: string;
  /** Простой список с поиском (например, ветки): без провайдеров и без пункта «по первой строке». */
  plain?: boolean;
  /** Accessible option prefix for compact settings selectors. */
  selectionLabel?: string;
  icon?: string;
  menuLabel?: string;
}) {
  const c = theme.colors;
  const { width, height } = useWindowDimensions();
  const trigger = useRef<View>(null);
  const popup = useRef<View>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const isOpen = anchor !== null;
  const providers = useMemo(() => titleModelProviders(options), [options]);
  const current = options.find(option => option.value === value) ?? options[0];
  const [provider, setProvider] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const activeProvider = query ? null : provider;
  const shown = plain
    ? options.filter(option => query.toLowerCase().split(/\s+/).filter(Boolean).every(word => option.label.toLowerCase().includes(word)))
    : filterTitleModels(options, activeProvider, query);
  const firstLine = plain ? undefined : options.find(option => option.value === "first_line");  

  useEffect(() => {
    if (!isOpen) return;
    const show = Keyboard.addListener("keyboardDidShow", event => setKeyboardTop(event.endCoordinates.screenY));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardTop(null));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [isOpen]);

  const measureTrigger = () => {
    trigger.current?.measureInWindow((x, y, measuredWidth, measuredHeight) => {
      setAnchor({ x, y, width: measuredWidth, height: measuredHeight });
    });
  };

  const close = useCallback(() => {
    setAnchor(null);
    setKeyboardTop(null);
  }, []);

  const select = (selectedValue: string) => {
    onValueChange(selectedValue);
    close();
  };

  const open = () => {
    setQuery("");
    setProvider(current?.provider || null);
    measureTrigger();
  };

  const screenBottom = Math.min(height, keyboardTop ?? height);
  const below = anchor ? Math.max(0, screenBottom - anchor.y - anchor.height - 20) : 0;
  const above = anchor ? Math.max(0, Math.min(anchor.y, screenBottom) - 20) : 0;
  const openBelow = below >= Math.min(380, screenBottom - 24) || below >= above;
  const maxHeight = Math.min(380, openBelow ? below : above);
  const popupWidth = Math.min(Math.max(anchor?.width ?? 0, 320), width - 24);
  const left = Math.max(12, Math.min(anchor?.x ?? 12, width - popupWidth - 12));

  const top = openBelow && anchor ? anchor.y + anchor.height + 8 : undefined;
  const bottom = !openBelow && anchor ? height - Math.min(anchor.y, screenBottom) + 8 : undefined;

  useLayoutEffect(() => {
    if (!anchor || Platform.OS !== "web") return;
    return presentWebPopup(popup.current, { left, top, bottom, width: popupWidth, maxHeight }, close);
  }, [isOpen, left, top, bottom, popupWidth, maxHeight, close]);

  const chip = (key: string, label: string, active: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? c.accent : c.border,
        backgroundColor: active ? c.accent : c.surface1,
      }}
    >
      <Text style={{ fontSize: 12, color: active ? c.accentForeground : c.foreground }}>{label}</Text>
    </Pressable>
  );

  const modelRow = (option: TitleModelOption) => {
    const selected = option.value === value;
    return (
      <Pressable
        key={option.value}
        accessibilityRole="menuitem"
        accessibilityLabel={option.value === "first_line" ? option.label : plain ? selectionLabel ? `${selectionLabel}: ${option.label}` : `Выбрать ветку ${option.value}` : `Выбрать модель ${option.value}`}
        accessibilityState={{ selected }}
        onPress={() => select(option.value)}
        style={({ pressed }) => ({
          minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8,
          paddingHorizontal: 12, paddingVertical: 10,
          borderBottomWidth: 1, borderBottomColor: c.border,
          backgroundColor: pressed || selected ? c.surface2 : c.surface1,
        })}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 14, color: c.foreground }}>{option.name}</Text>
          {option.providerLabel ? <Text style={{ fontSize: 11, color: c.foregroundMuted }}>{option.providerLabel}</Text> : null}
        </View>
        {selected ? <Icon name="Check" size={16} color={c.accent} /> : null}
      </Pressable>
    );
  };

  const content = anchor ? (
    <View
      ref={popup}
      accessibilityRole="menu"
      accessibilityLabel={menuLabel}
      accessibilityViewIsModal
      style={{
        position: "absolute", left, top, bottom, width: popupWidth, maxHeight,
        borderRadius: 12, borderWidth: 1, borderColor: c.border, overflow: "hidden",
        backgroundColor: c.surface1, padding: 0, boxShadow: "0 8px 30px rgba(0, 0, 0, 0.2)",
      }}
    >
      {hint ? <Text style={{ padding: 10, color: c.statusWarning, fontSize: 12 }}>{hint}</Text> : null}
      <View style={{ padding: 10, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            accessibilityLabel={plain ? selectionLabel ? `Поиск: ${selectionLabel}` : "Поиск ветки" : "Поиск модели по всем провайдерам"}
            placeholder={plain ? selectionLabel ? `Поиск: ${selectionLabel}` : "Поиск ветки" : "Поиск модели по всем провайдерам"}
            placeholderTextColor={c.foregroundMuted}
            autoCorrect={false}
            autoCapitalize="none"
            style={{
              flex: 1, minWidth: 0, minHeight: 40, paddingHorizontal: 10, paddingVertical: 8,
              borderRadius: 8, borderWidth: 1, borderColor: c.border,
              backgroundColor: c.surface2, color: c.foreground,
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={plain ? selectionLabel ? "Закрыть список вариантов" : "Закрыть список веток" : "Закрыть список моделей"}
            onPress={close}
            style={{ width: 32, height: 40, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="X" size={17} color={c.foregroundMuted} />
          </Pressable>
        </View>
        {plain ? null : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: 6 }}
          >
            {chip("all", "Все", !activeProvider, () => { setQuery(""); setProvider(null); })}
            {providers.map(item => chip(item.provider, `${item.label} · ${item.count}`, activeProvider === item.provider, () => {
              setQuery("");
              setProvider(item.provider);
            }))}
          </ScrollView>
        )}
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        style={{ flexShrink: 1 }}
      >
        {firstLine ? modelRow(firstLine) : null}
        {shown.length ? shown.map(modelRow) : (
          <Text style={{ padding: 12, fontSize: 12, color: c.foregroundMuted }}>{plain ? "Веток не найдено" : "Ничего не найдено"}</Text>
        )}
      </ScrollView>
    </View>
  ) : null;

  return (
    <View style={{ width: 44, height: 44 }}>
      <Pressable
        ref={trigger}
        accessibilityRole="button"
        accessibilityLabel={pending ? `${label}...` : label}
        aria-expanded={isOpen}
        disabled={disabled}
        onPress={open}
        style={({ pressed }) => ({
          width: 44, height: 44, borderRadius: 9, borderWidth: 1,
          borderColor: anchor ? c.accent : c.border,
          backgroundColor: pressed ? c.surface1 : c.surface2,
          alignItems: "center", justifyContent: "center", opacity: disabled ? 0.5 : 1,
        })}
      >
        <Icon name={pending ? "LoaderCircle" : icon} size={18} color={c.foreground} />
      </Pressable>
      {Platform.OS === "web" ? content : (
        <Modal
          visible={isOpen}
          transparent
          presentationStyle="overFullScreen"
          animationType="none"
          supportedOrientations={["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]}
          onOrientationChange={measureTrigger}
          onRequestClose={close}
        >
          <View style={{ flex: 1 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Закрыть меню"
              onPress={close}
              style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
            />
            {content}
          </View>
        </Modal>
      )}
    </View>
  );
}
