// Modified by GNATOVSKIE for integration into Paseo HQ, 2026-11-10.
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView as SheetScrollView } from "@getpaseo/plugin/client/react-native";
import React, { useMemo, useState } from "react";
import { LayoutChangeEvent, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { parseFlowchart, type Flowchart, type NodeShape } from "../../../shared/genui/diagram/flowchart";
import {
  layoutFlowchart,
  layoutSequence,
  type FlowLayout,
  type LaidOutEdge,
  type LaidOutNode,
} from "../../../shared/genui/diagram/layout";
import { parseSequence, type SeqEvent, type SequenceDiagram } from "../../../shared/genui/diagram/sequence";
import { fitRowZoom, zoomIn, zoomOut, type Size } from "../../../shared/genui/diagram/zoom";
import { detailFor, parseDetails, type DiagramDetail } from "../../../shared/genui/logic/explain-logic";
import { isNode, text, type Props } from "../../../shared/genui/logic/values";
import { MarkdownText } from "../markdown";
import { RenderNode } from "../node-renderer";
import { useUiRuntime } from "../runtime";

const ARROW = 4;
const MIN_MEASURABLE = 120;

type ParsedDiagram =
  | { kind: "flow"; layout: FlowLayout; skipped: Flowchart["skipped"] }
  | { kind: "sequence"; diagram: SequenceDiagram; size: Size }
  | { kind: "unsupported" };

type DrawableDiagram = Exclude<ParsedDiagram, { kind: "unsupported" }>;

function parseDiagram(source: string): ParsedDiagram {
  const flow = parseFlowchart(source);
  if (flow && flow.nodes.length > 0) {
    return { kind: "flow", layout: layoutFlowchart(flow), skipped: flow.skipped };
  }
  const sequence = parseSequence(source);
  if (sequence && sequence.participants.length > 0) {
    const box = layoutSequence(sequence.participants, sequence.events.length);
    return { kind: "sequence", diagram: sequence, size: { width: box.width, height: box.height } };
  }
  return { kind: "unsupported" };
}

function naturalSize(parsed: DrawableDiagram): Size {
  return parsed.kind === "flow"
    ? { width: parsed.layout.width, height: parsed.layout.height }
    : parsed.size;
}

export function Diagram({ props }: { props: Props }) {
  const { theme, compact } = useUiRuntime();
  const source = text(props.mermaid);
  const details = useMemo(() => parseDetails(props.details) ?? [], [props.details]);
  const parsed = useMemo(() => parseDiagram(source), [source]);
  const [selectedDetail, setSelectedDetail] = useState<DiagramDetail | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [popped, setPopped] = useState(false);
  const [available, setAvailable] = useState(0);
  const [zoom, setZoom] = useState(1);

  if (parsed.kind === "unsupported") {
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
        <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12 }}>
          {source}
        </Text>
      </View>
    );
  }

  const natural = naturalSize(parsed);
  const baseScale = available > MIN_MEASURABLE ? Math.min(1.15, Math.max(0.55, available / natural.width)) : 1;
  const fitZoom = fitRowZoom(baseScale, natural.width, available);
  const scale = baseScale * zoom;
  const box = {
    width: Math.max(1, Math.floor(natural.width * scale)),
    height: Math.max(1, Math.floor(natural.height * scale)),
  };

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w >= MIN_MEASURABLE && w !== available) setAvailable(w);
  };

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setZoom(zoomOut)}
          style={{
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            backgroundColor: theme.colors.surface2,
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>−</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => setZoom(fitZoom)}
          style={{
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            backgroundColor: theme.colors.surface2,
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>
            {Math.round(zoom * 100)}%
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => setZoom(zoomIn)}
          style={{
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            backgroundColor: theme.colors.surface2,
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>+</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowCode((s) => !s)}
          style={{
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            backgroundColor: theme.colors.surface2,
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>
            {showCode ? "Diagram" : "Mermaid"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => setPopped(true)}
          style={{
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            backgroundColor: theme.colors.surface2,
          }}
        >
          <Icon name="Maximize2" size={12} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>

      <View onLayout={onLayout} style={{ alignSelf: "stretch", height: 0 }} />

      {parsed.kind === "flow" && parsed.skipped.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            Часть схемы не поддерживается. Пропущенные строки:
          </Text>
          <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontFamily: "monospace" }}>
            {parsed.skipped.join("\n")}
          </Text>
        </View>
      ) : null}

      {showCode ? (
        <View
          style={{
            borderRadius: 8,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface2,
            padding: 10,
          }}
        >
          <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12 }}>
            {source}
          </Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={!compact}>
          <View style={box}>
            <View
              style={{
                width: natural.width,
                height: natural.height,
                transform: [{ scale }],
                transformOrigin: "top left",
              }}
            >
              <Drawing
                parsed={parsed}
                theme={theme}
                details={details}
                selectedKey={selectedDetail?.key ?? null}
                onSelectDetail={(detail) =>
                  setSelectedDetail((prev) => (prev?.key === detail.key ? null : detail))
                }
              />
            </View>
          </View>
        </ScrollView>
      )}

      {selectedDetail !== null ? (
        <View
          style={{
            borderRadius: 8,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface2,
            padding: 10,
            gap: 6,
          }}
        >
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
              {selectedDetail.key}
            </Text>
            <Pressable onPress={() => setSelectedDetail(null)}>
              <Icon name="X" size={13} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
          {selectedDetail.parts.map((part, idx) =>
            typeof part === "string" ? (
              <MarkdownText key={idx} text={part} theme={theme} compact={compact} />
            ) : isNode(part) ? (
              <RenderNode key={idx} node={part} />
            ) : null,
          )}
        </View>
      ) : null}

      {popped ? (
        <Modal
          title="Diagram"
          icon={<Icon name="Workflow" size={16} color={theme.colors.foregroundMuted} />}
          open={popped}
          onOpenChange={setPopped}
        >
          <Modal.Content>
            <SheetScrollView horizontal>
              <Drawing
                parsed={parsed}
                theme={theme}
                details={details}
                selectedKey={selectedDetail?.key ?? null}
                onSelectDetail={(detail) =>
                  setSelectedDetail((prev) => (prev?.key === detail.key ? null : detail))
                }
              />
            </SheetScrollView>
          </Modal.Content>
        </Modal>
      ) : null}
    </View>
  );
}

function Drawing({
  parsed,
  theme,
  details,
  selectedKey,
  onSelectDetail,
}: {
  parsed: DrawableDiagram;
  theme: PluginTheme;
  details: readonly DiagramDetail[];
  selectedKey: string | null;
  onSelectDetail(detail: DiagramDetail): void;
}) {
  if (parsed.kind === "flow") {
    return (
      <View style={{ width: parsed.layout.width, height: parsed.layout.height, paddingBottom: 4 }}>
        {parsed.layout.edges.map((edge, index) => (
          <EdgeView key={index} edge={edge} theme={theme} />
        ))}
        {parsed.layout.nodes.map((node) => {
          const detail = detailFor(details, node.id, node.label);
          return (
            <NodeView
              key={node.id}
              node={node}
              theme={theme}
              hasDetail={detail !== null}
              selected={detail !== null && selectedKey === detail.key}
              onPress={() => {
                if (detail) onSelectDetail(detail);
              }}
            />
          );
        })}
      </View>
    );
  }
  return <SequenceView diagram={parsed.diagram} size={parsed.size} theme={theme} />;
}

function radiusFor(shape: NodeShape, node: LaidOutNode): number {
  if (shape === "circle") return node.width / 2;
  if (shape === "stadium") return node.height / 2;
  if (shape === "round") return 12;
  return 6;
}

function NodeView({
  node,
  theme,
  hasDetail,
  selected,
  onPress,
}: {
  node: LaidOutNode;
  theme: PluginTheme;
  hasDetail: boolean;
  selected: boolean;
  onPress(): void;
}) {
  const borderColor = selected
    ? theme.colors.accent
    : hasDetail
      ? theme.colors.accent
      : theme.colors.border;

  const content = (
    <View
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        borderRadius: radiusFor(node.shape, node),
        borderWidth: selected || hasDetail ? 1.5 : 1,
        borderColor,
        backgroundColor: theme.colors.surface2,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 8,
      }}
    >
      <Text
        numberOfLines={2}
        style={{
          color: theme.colors.foreground,
          fontSize: 12,
          fontWeight: hasDetail ? "600" : "400",
          textAlign: "center",
        }}
      >
        {node.label}
      </Text>
    </View>
  );

  return hasDetail ? (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

function EdgeView({ edge, theme }: { edge: LaidOutEdge; theme: PluginTheme }) {
  const color = theme.colors.foregroundMuted;
  return (
    <>
      {edge.segments.map((seg, i) => (
        <View
          key={i}
          style={{
            position: "absolute",
            left: seg.x,
            top: seg.y,
            width: seg.width,
            height: seg.height,
            backgroundColor: color,
          }}
        />
      ))}
      {[edge.arrowStartAt, edge.arrowAt].map((point, index) => point ? (
        <View key={index}
          style={{
            position: "absolute",
            left: point.x - ARROW,
            top: point.y - ARROW,
            width: ARROW * 2,
            height: ARROW * 2,
            borderRadius: ARROW,
            backgroundColor: color,
          }}
        />
      ) : null)}
      {edge.label && edge.labelAt ? (
        <View
          style={{
            position: "absolute",
            left: edge.labelAt.x - 40,
            top: edge.labelAt.y - 10,
            minWidth: 80,
            alignItems: "center",
          }}
        >
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              backgroundColor: theme.colors.surface1,
              fontSize: 10.5,
              paddingHorizontal: 4,
            }}
          >
            {edge.label}
          </Text>
        </View>
      ) : null}
    </>
  );
}

function SequenceView({
  diagram,
  size,
  theme,
}: {
  diagram: SequenceDiagram;
  size: Size;
  theme: PluginTheme;
}) {
  const box = layoutSequence(diagram.participants, diagram.events.length);
  const centerById = new Map(box.columns.map((col) => [col.id, col.centerX]));

  return (
    <View style={{ width: size.width, height: size.height }}>
      {box.columns.map((col) => (
        <React.Fragment key={col.id}>
          <View
            style={{
              position: "absolute",
              left: col.centerX - 1,
              top: box.headerHeight,
              width: 1.5,
              height: size.height - box.headerHeight,
              backgroundColor: theme.colors.border,
            }}
          />
          <View
            style={{
              position: "absolute",
              left: col.centerX - col.width / 2,
              top: 4,
              width: col.width,
              height: box.headerHeight - 8,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 6,
            }}
          >
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
              {col.label}
            </Text>
          </View>
        </React.Fragment>
      ))}
      {diagram.events.map((ev: SeqEvent, idx: number) => {
        const row = box.rows[idx];
        const y = (row?.y ?? box.headerHeight) + 20;
        if (ev.kind === "note") {
          const firstId = ev.over[0] ?? "";
          const cx = centerById.get(firstId) ?? 60;
          return (
            <View
              key={idx}
              style={{
                position: "absolute",
                left: Math.max(0, cx - 60),
                top: y - 12,
                width: 120,
                padding: 4,
                borderRadius: 4,
                backgroundColor: theme.colors.surface2,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.border,
              }}
            >
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, textAlign: "center" }}>
                {ev.text}
              </Text>
            </View>
          );
        }
        const x1 = centerById.get(ev.from) ?? 0;
        const x2 = centerById.get(ev.to) ?? 0;
        const left = Math.min(x1, x2);
        const width = Math.max(20, Math.abs(x2 - x1));
        return (
          <View key={idx} style={{ position: "absolute", left, top: y - 14, width }}>
            <Text
              numberOfLines={1}
              style={{ color: theme.colors.foreground, fontSize: 11, textAlign: "center", marginBottom: 2 }}
            >
              {ev.text}
            </Text>
            <View style={{ height: 1.5, backgroundColor: theme.colors.accent }} />
          </View>
        );
      })}
    </View>
  );
}
