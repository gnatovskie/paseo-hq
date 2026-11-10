// Modified by GNATOVSKIE for integration into Paseo HQ, 2026-11-10.
import { Icon } from "@getpaseo/plugin/client/react-native";
import React, { useContext, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { finiteNumber, list, nodes, optionalText, text, type Props } from "../../../shared/genui/logic/values";
import { isButtonLike, RenderNode, RenderNodes } from "../node-renderer";
import { CardDepthContext, propsKey, usePersistedState, useUiRuntime } from "../runtime";

import { TextSelectionContext } from "../text-selection";

export function Card({ props }: { props: Props }) {
  const { theme, compact } = useUiRuntime();
  const depth = useContext(CardDepthContext);
  const inheritedSelection = useContext(TextSelectionContext);
  const [selection, setSelection] = useState(false);
  const title = optionalText(props.title);
  const children = nodes(props.children);

  return (
    <TextSelectionContext.Provider value={selection || inheritedSelection}>
    <CardDepthContext.Provider value={depth + 1}>
      <View
        style={{
          borderRadius: 12,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: depth === 0 ? theme.colors.surface1 : theme.colors.surface2,
          padding: compact ? 12 : 16,
          gap: compact ? 10 : 12,
        }}
      >
        {!inheritedSelection ? <Pressable accessibilityRole="button" onPress={() => setSelection(value => !value)}
          style={{ alignSelf: "flex-end", paddingVertical: 6, paddingHorizontal: 4 }} hitSlop={8}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {selection ? "Вернуть оформление" : "Выделить текст"}
          </Text>
        </Pressable> : null}
        {title !== null && title.trim() !== "" ? (
          <Text
            selectable
            style={{
              color: theme.colors.foreground,
              fontSize: depth === 0 ? 15 : 13.5,
              fontWeight: "600",
            }}
          >
            {title}
          </Text>
        ) : null}
        <View style={{ gap: compact ? 8 : 10 }}>
          <RenderNodes nodes={children} />
        </View>
      </View>
    </CardDepthContext.Provider>
    </TextSelectionContext.Provider>
  );
}

export function Row({ props }: { props: Props }) {
  const { compact } = useUiRuntime();
  const children = nodes(props.children);
  // Equal columns suit content; a row of buttons reads as one group instead.
  if (children.length > 0 && children.every(isButtonLike)) return <RenderNodes nodes={children} />;
  return (
    <View
      style={{
        flexDirection: compact ? "column" : "row",
        flexWrap: "wrap",
        gap: compact ? 8 : 12,
        alignItems: "stretch",
      }}
    >
      {children.map((child, idx) => (
        <View key={`${child.key}:${idx}`} style={compact ? { width: "100%" } : { flex: 1, minWidth: 160 }}>
          <RenderNode node={child} />
        </View>
      ))}
    </View>
  );
}

export function Stack({ props }: { props: Props }) {
  const { compact } = useUiRuntime();
  const children = nodes(props.children);
  return (
    <View style={{ gap: compact ? 8 : 10 }}>
      <RenderNodes nodes={children} />
    </View>
  );
}

export function Grid({ props }: { props: Props }) {
  const { compact } = useUiRuntime();
  const children = nodes(props.children);
  const requestedCols = finiteNumber(props.columns);
  const cols = compact ? 1 : Math.max(1, Math.min(4, requestedCols ? Math.round(requestedCols) : 2));
  const rows: typeof children[] = [];
  for (let i = 0; i < children.length; i += cols) {
    rows.push(children.slice(i, i + cols));
  }
  return (
    <View style={{ gap: compact ? 8 : 10 }}>
      {rows.map((row, rIdx) => (
        <View key={rIdx} style={{ flexDirection: compact ? "column" : "row", gap: compact ? 8 : 10 }}>
          {row.map((child, cIdx) => (
            <View key={`${child.key}:${cIdx}`} style={{ flex: 1 }}>
              <RenderNode node={child} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

export function Tabs({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const labels = list(props.labels).map((item) => text(item));
  const children = nodes(props.children);
  const [selected, setSelected] = usePersistedState<number>(
    `tabs:${propsKey(labels)}`,
    0,
    (v) => (typeof v === "number" && v >= 0 && v < labels.length ? v : null),
  );
  const activeIdx = Math.min(Math.max(0, selected), Math.max(0, labels.length - 1));
  const activeChild = children[activeIdx];

  return (
    <View style={{ gap: 10 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View
          style={{
            flexDirection: "row",
            gap: 4,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: theme.colors.border,
            paddingBottom: 6,
          }}
        >
          {labels.map((label, index) => {
            const active = index === activeIdx;
            return (
              <Pressable
                key={`${label}:${index}`}
                accessibilityRole="tab"
                onPress={() => setSelected(index)}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  borderRadius: 6,
                  backgroundColor: active ? theme.colors.surface2 : "transparent",
                }}
              >
                <Text
                  style={{
                    color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
                    fontSize: 12.5,
                    fontWeight: active ? "600" : "400",
                  }}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      {activeChild ? <RenderNode node={activeChild} /> : null}
    </View>
  );
}

export function Details({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const title = text(props.title);
  const children = nodes(props.children);
  const initialOpen = props.open === true;
  const [open, setOpen] = useState(initialOpen);

  return (
    <View
      style={{
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen((prev) => !prev)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 12,
          paddingVertical: 9,
          gap: 8,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "500", flex: 1 }}>
          {title}
        </Text>
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
      </Pressable>
      {open ? (
        <View
          style={{
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.colors.border,
            padding: 12,
            gap: 8,
          }}
        >
          <RenderNodes nodes={children} />
        </View>
      ) : null}
    </View>
  );
}

export function Divider() {
  const { theme } = useUiRuntime();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border,
        marginVertical: 4,
      }}
    />
  );
}

export function Carousel({ props }: { props: Props }) {
  const { compact } = useUiRuntime();
  const children = nodes(props.children);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={!compact}>
      <View style={{ flexDirection: "row", gap: 12, paddingVertical: 2 }}>
        {children.map((child, idx) => (
          <View key={`${child.key}:${idx}`} style={{ width: compact ? 260 : 320 }}>
            <RenderNode node={child} />
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
