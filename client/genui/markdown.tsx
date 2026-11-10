// Modified by GNATOVSKIE for integration into Paseo HQ, 2026-11-10.
import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import React, { useMemo, useContext } from "react";
import { StyleSheet, Text, View } from "react-native";
import { parseInline, parseMarkdown, type Block, type Inline } from "../../shared/genui/diagram/markdown";

import { TextSelectionContext, SelectionText } from "./text-selection";

export function MarkdownText({
  text,
  theme,
  compact = false,
  color,
}: {
  text: string;
  theme: PluginTheme;
  compact?: boolean;
  color?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const selection = useContext(TextSelectionContext);
  if (selection) {
    const plain = blocks.map(block => {
      if (block.kind === "rule") return "";
      if (block.kind === "code") return block.text;
      if (block.kind === "bullet" || block.kind === "ordered") {
        return block.items.map((item, index) => `${block.kind === "bullet" ? "•" : `${block.start + index}.`} ${item.map(span => span.text).join("")}`).join("\n");
      }
      return block.content.map(span => span.text).join("");
    }).join("\n\n");
    return <SelectionText text={plain} theme={theme} />;
  }
  return (
    <View style={{ gap: compact ? 6 : 8 }}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} theme={theme} color={color} />
      ))}
    </View>
  );
}

/** One line of inline Markdown (links, emphasis, code), nested inside a caller's styled Text. */
export function InlineMarkdown({ text, theme }: { text: string; theme: PluginTheme }) {
  const content = useMemo(() => parseInline(text), [text]);
  return <Spans content={content} theme={theme} />;
}

function BlockView({
  block,
  theme,
  color,
}: {
  block: Block;
  theme: PluginTheme;
  color?: string;
}) {
  const body = {
    color: color ?? theme.colors.foreground,
    fontSize: 13.5,
    lineHeight: 20,
  };

  if (block.kind === "rule") {
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

  if (block.kind === "code") {
    return (
      <View
        style={{
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface2,
          padding: 10,
        }}
      >
        <Text
          selectable
          style={{
            color: theme.colors.foreground,
            fontFamily: "monospace",
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          {block.text}
        </Text>
      </View>
    );
  }

  if (block.kind === "heading") {
    return (
      <Text
        selectable
        style={{
          ...body,
          fontSize: Math.max(14, 20 - block.level),
          fontWeight: "700",
        }}
      >
        <Spans content={block.content} theme={theme} />
      </Text>
    );
  }

  if (block.kind === "quote") {
    return (
      <View
        style={{ paddingLeft: 12 }}
      >
        <Text selectable style={{ ...body, color: theme.colors.foregroundMuted }}>
          <Spans content={block.content} theme={theme} />
        </Text>
      </View>
    );
  }

  if (block.kind === "bullet" || block.kind === "ordered") {
    return (
      <View style={{ gap: 4 }}>
        {block.items.map((item, index) => (
          <View key={index} style={{ flexDirection: "row", gap: 8 }}>
            <Text selectable style={{ ...body, color: theme.colors.foregroundMuted }}>
              {block.kind === "bullet" ? "•" : `${block.start + index}.`}
            </Text>
            <Text selectable style={{ ...body, flex: 1 }}>
              <Spans content={item} theme={theme} />
            </Text>
          </View>
        ))}
      </View>
    );
  }

  return (
    <Text selectable style={body}>
      <Spans content={block.content} theme={theme} />
    </Text>
  );
}

function Spans({ content, theme }: { content: Inline[]; theme: PluginTheme }) {
  return (
    <>
      {content.map((span, index) => {
        if (span.kind === "bold") {
          return (
            <Text selectable key={index} style={{ fontWeight: "700" }}>
              {span.text}
            </Text>
          );
        }
        if (span.kind === "italic") {
          return (
            <Text selectable key={index} style={{ fontStyle: "italic" }}>
              {span.text}
            </Text>
          );
        }
        if (span.kind === "code") {
          return (
            <Text
              selectable
              key={index}
              style={{
                fontFamily: "monospace",
                fontSize: 12,
                color: theme.colors.accent,
                backgroundColor: theme.colors.surface2,
              }}
            >
              {span.text}
            </Text>
          );
        }
        if (span.kind === "link") {
          return (
            <Text
              selectable
              key={index}
              accessibilityRole="link"
              onPress={() => void openExternalUrl(span.url)}
              style={{ color: theme.colors.accent, textDecorationLine: "underline" }}
            >
              {span.text}
            </Text>
          );
        }
        return <Text selectable key={index}>{span.text}</Text>;
      })}
    </>
  );
}
