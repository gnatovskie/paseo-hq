import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Animated,
  Easing,
  Image,
  Linking,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  usePaseo,
  useRpc,
  type PluginClientContext,
  type PluginScreenProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import {
  copyText,
  Icon,
  Modal,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import type { PaseoProviderSnapshotResult, PaseoAgentListResult, PaseoProject, PaseoTerminal, PaseoWorkspace } from "@getpaseo/client";
import {
  areaSettingsRpc,
  areaSessionCreateRpc,
  chatRenameRpc,
  panelSettingsRpc,
  pluginSyncRpc,
  projectAddRpc,
  projectCandidatesRpc,
  projectRemoveRpc,
  projectSaveRpc,
  sessionPinRpc,
  sessionTitleSuggestRpc,
  sessionTransferRpc,
  sidebarReadRpc,
  type AvatarUpdate,
  type CandidateDir,
  type ProjectMeta,
  type SidebarState,
} from "./shared/contracts";
import { projectAgentConfig } from "./shared/project-agent-config";
import { compareProjectOrder } from "./shared/project-order";
import { GENERATOR_TITLE, titleModelOptions } from "./shared/title-models";
import { TitleModelPicker } from "./client/title-model-picker.client";
import { TooltipPressable } from "./client/tooltip.client";
import { HostMetricsBar } from "./client/host-widget";
import { TeamSurface } from "./client/team-surface";

import { contributeComposerPills } from "./client/pills.client";
import { contributeLimitAlerts } from "./client/limit-alerts.client";
import { UsageLimitsPanel, UsageLimitsSurface } from "./client/limits.client";
import { UsageHistoryPanel, UsageHistorySurface } from "./client/history.client";
import { UsageSettingsSurface } from "./client/settings.client";
import { GitWorkspaceSurface } from "./client/git-workspace-surface";
import { GitWorkspaceSettings } from "./client/git-workspace-settings";
import { Services } from "./client/services-surface";
import { ArtifactsSurface } from "./client/artifacts-surface";
import contributeGenuiClient from "./client/genui/contribute";
import { splitHqTimelineMessage } from "./client/hq-timeline";
import { ArtifactCard } from "./client/artifact-card";
import {
  ARTIFACT_BLOCK_KIND,
  ARTIFACT_TEXT_KIND,
} from "./client/artifacts-segment";
import {
  BUCKET_PRIORITY,
  countSessionBuckets,
  deriveAgentBucket,
  pickWorkspaceBucket,
  resolveChatBucket,
  type UiSessionBucket,
} from "./client/session-buckets";
import { z } from "zod";
import { Markdown } from "@getpaseo/plugin/client/ui";


const EMOJI_PRESETS = ["🚀", "⚡", "🛠", "📦", "🧠", "🌐", "💳", "🎨", "🔒", "📱", "🤖", "🔥"];
const AREA_SESSION_FILTERS = [
  { value: "all", label: "Все" },
  { value: "agents", label: "Агенты" },
  { value: "terminals", label: "Терминалы" },
] as const;
const COLOR_PRESETS = ["#3B82F6", "#8B5CF6", "#10B981", "#F59E0B", "#EF4444", "#EC4899", "#06B6D4", "#64748B"];

const DEFAULT_META: ProjectMeta = {
  avatarUri: null,
  avatarEmoji: null,
  avatarBg: null,
  newSessionMode: "directory",
  hidden: false,
  pinned: false,
  sessionTitleModel: null,
  sessionsSortMode: "auto",
  sessionOrder: [],
};

type AddProjectMode = "existing" | "create" | "clone";
type AgentEntry = PaseoAgentListResult["entries"][number];

interface ProjectGroup {
  id: string;
  name: string;
  customName: string | null;
  displayName: string;
  rootPath: string;
  meta: ProjectMeta;
  resolvedAvatarUri: string | null;
  lastRunningAt: number;
  /** Последний промпт любого агента проекта, используется для порядка внутри группы. */
  lastPromptAt: number;
  hasRunning: boolean;
  summaryBucket: UiSessionBucket;
  chats: PaseoWorkspace[];
}

function parseIsoMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function projectTitle(p: PaseoProject): string {
  return p.projectCustomName || p.projectDisplayName || p.projectRootPath.split("/").pop() || "Проект";
}

interface FamilyBadgeInfo {
  label: string;
  bg: string;
  text: string;
}

function resolveModelFamilyBadge(agent?: AgentEntry["agent"]): FamilyBadgeInfo | null {
  if (!agent) return null;
  const p = (agent.provider || "").toLowerCase();
  const m = (agent.model || "").toLowerCase();
  const raw = `${p}/${m}`;

  let family = "AI";
  let specific = "";
  let bg = "rgba(148, 163, 184, 0.16)";
  let text = "#94A3B8";

  if (raw.includes("claude") || raw.includes("opus") || raw.includes("sonnet") || raw.includes("haiku")) {
    family = "Claude";
    bg = "rgba(217, 119, 6, 0.16)";
    text = "#F59E0B";
    if (raw.includes("opus-5-5") || raw.includes("opus 5.5")) specific = "Opus 5.5";
    else if (raw.includes("opus-5")) specific = "Opus 5";
    else if (raw.includes("opus-4")) specific = "Opus 4";
    else if (raw.includes("opus")) specific = "Opus";
    else if (raw.includes("sonnet-5-5") || raw.includes("sonnet 5.5")) specific = "Sonnet 5.5";
    else if (raw.includes("sonnet")) specific = "Sonnet";
    else if (raw.includes("haiku-5-5") || raw.includes("haiku 5.5")) specific = "Haiku 5.5";
    else if (raw.includes("haiku")) specific = "Haiku";
    else if (raw.includes("fable")) specific = "Fable";
  } else if (raw.includes("codex") || raw.includes("openai") || raw.includes("gpt")) {
    family = "Codex";
    bg = "rgba(16, 185, 129, 0.16)";
    text = "#10B981";
    if (raw.includes("6.1-sol") || raw.includes("6.1 sol")) specific = "6.1 Sol";
    else if (raw.includes("6.1-terra") || raw.includes("6.1 terra")) specific = "6.1 Terra";
    else if (raw.includes("6-sol")) specific = "6 Sol";
    else if (raw.includes("6-luna")) specific = "6 Luna";
    else if (raw.includes("6-astra")) specific = "6 Astra";
    else if (raw.includes("5.6")) specific = "5.6";
    else if (raw.includes("oss-120b")) specific = "OSS 120B";
  } else if (raw.includes("gemini") || raw.includes("google") || raw.includes("antigravity")) {
    family = "Gemini";
    bg = "rgba(59, 130, 246, 0.16)";
    text = "#3B82F6";
    if (raw.includes("4-argon") || raw.includes("4 argon")) specific = "4 Argon";
    else if (raw.includes("3.8-flash") || raw.includes("3.8 flash")) specific = "3.8 Flash";
    else if (raw.includes("3.5-flash") || raw.includes("3.5 flash")) specific = "3.5 Flash";
    else if (raw.includes("3.1-pro") || raw.includes("3.1 pro")) specific = "3.1 Pro";
    else if (raw.includes("2.5-pro") || raw.includes("2.5 pro")) specific = "2.5 Pro";
    else if (raw.includes("flash")) specific = "Flash";
    else if (raw.includes("pro")) specific = "Pro";
  } else if (raw.includes("deepseek")) {
    family = "DeepSeek";
    bg = "rgba(6, 182, 212, 0.16)";
    text = "#06B6D4";
    if (raw.includes("r1")) specific = "R1";
    else if (raw.includes("v3")) specific = "V3";
    else specific = "Chat";
  } else if (raw.includes("kimi") || raw.includes("moonshot")) {
    family = "Kimi";
    bg = "rgba(139, 92, 246, 0.16)";
    text = "#8B5CF6";
    if (raw.includes("k3.1")) specific = "K3.1";
    else if (raw.includes("k3")) specific = "K3";
    else if (raw.includes("kimi-for-coding")) specific = "K2.8";
    else specific = "Code";
  } else if (raw.includes("copilot")) {
    family = "Copilot";
    bg = "rgba(100, 116, 139, 0.16)";
    text = "#94A3B8";
  } else if (agent.provider) {
    const prefix = agent.provider.split("/")[0].replace(/^@/, "").trim();
    if (prefix) {
      family = prefix.charAt(0).toUpperCase() + prefix.slice(1);
    }
  }

  const label = specific ? `${family} · ${specific}` : family;
  return { label, bg, text };
}

function chatTitle(w: PaseoWorkspace, agent?: AgentEntry["agent"]): string {
  const explicit = (w.title || "").trim();
  if (explicit) return explicit;
  const ag = agent as { title?: string | null; name?: string | null } | undefined;
  const agTitle = (ag?.title || ag?.name || "").trim();
  if (agTitle) return agTitle;
  return "Новая область";
}

/**
 * Время последнего запуска в области:
 * берется из серверного журнала хуков agent.turn.before/after, времени завершения/запроса агента,
 * а для областей с активным ходом - статус-таймштамп активного хода.
 * Простой просмотр области это время не меняет.
 */
function chatLastRunningMs(
  w: PaseoWorkspace,
  bucket: UiSessionBucket,
  lastRunningMap: Record<string, number>,
  agentTurnFinishMap: Record<string, number>,
): number {
  const recordedRun = lastRunningMap[w.id] ?? 0;
  const agentTurnEnd = agentTurnFinishMap[w.id] ?? 0;
  const userPrompt = parseIsoMs(w.lastUserMessageAt);
  const activity = parseIsoMs(w.activityAt);
  const created = parseIsoMs(w.createdAt);
  const liveRun =
    bucket === "running" || bucket === "needs_input" ? parseIsoMs(w.statusEnteredAt) : 0;
  return Math.max(recordedRun, agentTurnEnd, userPrompt, activity, liveRun, created);
}

/**
 * Порядок областей и проектов - только по последнему отправленному промпту.
 * Ответы и работа агентов порядок не меняют, иначе раскрытые проекты скачут.
 */
function chatLastPromptMs(w: PaseoWorkspace, agentPromptMap: Record<string, number>): number {
  // Сводное время области учитывает и служебный генератор названия,
  // поэтому оно лишь запасное, когда агентов области нет в списке.
  return agentPromptMap[w.id] || parseIsoMs(w.lastUserMessageAt) || parseIsoMs(w.createdAt);
}

function formatRussianCount(count: number, one: string, few: string, many: string): string {
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return `${count} ${many}`;
  if (lastDigit === 1) return `${count} ${one}`;
  if (lastDigit >= 2 && lastDigit <= 4) return `${count} ${few}`;
  return `${count} ${many}`;
}

function relativeTime(ms: number): string {
  if (!ms) return "";
  const diffMin = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (diffMin < 1) return "сейчас";
  if (diffMin < 60) return `${diffMin} мин`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `${h} ч`;
  return `${Math.floor(h / 24)} д`;
}

function monogram(name: string): string {
  const clean = name.trim();
  if (!clean) return "P";
  const parts = clean.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function hashColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return COLOR_PRESETS[Math.abs(h) % COLOR_PRESETS.length] ?? "#3B82F6";
}

function pickWebImageAsDataUri(): Promise<string | null> {
  return new Promise((resolve) => {
    const g = globalThis as unknown as {
      document?: {
        createElement: (tag: string) => Record<string, unknown>;
        body?: { appendChild: (el: unknown) => void; removeChild: (el: unknown) => void };
      };
      Image?: new () => {
        onload: (() => void) | null;
        onerror: (() => void) | null;
        width: number;
        height: number;
        src: string;
      };
      FileReader?: new () => {
        onload: (() => void) | null;
        onerror: (() => void) | null;
        result: unknown;
        readAsDataURL: (blob: unknown) => void;
      };
    };
    if (!g.document || !g.FileReader) {
      resolve(null);
      return;
    }

    const input = g.document.createElement("input") as {
      type: string;
      accept: string;
      style: { display: string };
      files?: ArrayLike<{ type?: string; size?: number }>;
      onchange: (() => void) | null;
      oncancel?: (() => void) | null;
      click: () => void;
    };
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    g.document.body?.appendChild(input);

    let settled = false;
    const finish = (val: string | null) => {
      if (settled) return;
      settled = true;
      try {
        g.document?.body?.removeChild(input);
      } catch {
        // Ignore cleanup failure.
      }
      resolve(val);
    };

    input.oncancel = () => finish(null);
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      const reader = new g.FileReader!();
      reader.onerror = () => finish(null);
      reader.onload = () => {
        const rawDataUri = typeof reader.result === "string" ? reader.result : null;
        if (!rawDataUri) {
          finish(null);
          return;
        }
        if (file.type === "image/svg+xml" || file.type === "image/gif" || !g.Image) {
          finish(rawDataUri);
          return;
        }
        const img = new g.Image();
        img.onerror = () => finish(rawDataUri);
        img.onload = () => {
          try {
            const maxSide = 768;
            const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
            const targetW = Math.max(1, Math.round(img.width * scale));
            const targetH = Math.max(1, Math.round(img.height * scale));
            const canvas = g.document!.createElement("canvas") as {
              width: number;
              height: number;
              getContext: (kind: string) => { drawImage: (i: unknown, x: number, y: number, w: number, h: number) => void } | null;
              toDataURL: (mime: string, quality?: number) => string;
            };
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              finish(rawDataUri);
              return;
            }
            ctx.drawImage(img, 0, 0, targetW, targetH);
            const outMime = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
            finish(canvas.toDataURL(outMime, 0.9));
          } catch {
            finish(rawDataUri);
          }
        };
        img.src = rawDataUri;
      };
      reader.readAsDataURL(file);
    };

    input.click();
  });
}

const SESSION_STATUS_SIZE = 14;
const NESTED_ITEM_GAP = 12;

const SESSION_STATUS_LABEL: Record<UiSessionBucket, string> = {
  running: "в работе",
  attention: "требует внимания",
  needs_input: "ожидает ввода",
  failed: "ошибка",
  done: "нет активной работы",
};

function SessionStatusIndicator({
  bucket,
  theme,
  platform,
  size = 18,
}: {
  bucket: UiSessionBucket;
  theme: PluginTheme;
  platform: string;
  size?: number;
}) {
  const spin = useRef(new Animated.Value(0)).current;
  const c = theme.colors;

  useEffect(() => {
    if (bucket !== "running") {
      spin.stopAnimation();
      spin.setValue(0);
      return;
    }
    spin.setValue(0);
    const anim = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: platform !== "web",
      }),
    );
    anim.start();
    return () => anim.stop();
  }, [bucket, platform, spin]);

  if (bucket === "running") {
    const rotate = spin.interpolate({
      inputRange: [0, 1],
      outputRange: ["0deg", "360deg"],
    });
    const dotSize = Math.max(5, Math.round(size * 0.36));
    return (
      <View
        style={{
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Animated.View
          style={{
            position: "absolute",
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 1.8,
            borderColor: "transparent",
            borderTopColor: c.accent,
            borderRightColor: c.accent,
            transform: [{ rotate }],
          }}
        />
        <View
          style={{
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: c.accent,
          }}
        />
      </View>
    );
  }

  if (bucket === "attention") {
    return (
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        <Icon name="CircleCheck" size={size - 1} color={c.statusSuccess} />
      </View>
    );
  }

  if (bucket === "needs_input") {
    return (
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        <Icon name="CircleAlert" size={size - 1} color={c.statusWarning} />
      </View>
    );
  }

  if (bucket === "failed") {
    return (
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        <Icon name="CircleX" size={size - 1} color={c.statusDanger} />
      </View>
    );
  }

  const staticDot = Math.max(6, Math.round(size * 0.38));
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          width: staticDot,
          height: staticDot,
          borderRadius: staticDot / 2,
          backgroundColor: c.foregroundMuted,
          opacity: 0.5,
        }}
      />
    </View>
  );
}

const AREA_SESSION_STATUSES: { bucket: UiSessionBucket; label: string }[] = [
  { bucket: "running", label: "Запущенных сессий" },
  { bucket: "attention", label: "Готовых сессий" },
  { bucket: "done", label: "Неактивных сессий" },
  { bucket: "needs_input", label: "Ожидающих ввода сессий" },
  { bucket: "failed", label: "Сессий с ошибкой" },
];

function AreaSessionBadges({ sessions, terminalCount, theme, platform }: {
  sessions: readonly AgentEntry[];
  terminalCount: number;
  theme: PluginTheme;
  platform: PluginSidebarItemProps["layout"]["platform"];
}) {
  const counts = countSessionBuckets(sessions.map(({ agent }) => agent), terminalCount);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
      {AREA_SESSION_STATUSES.filter(({ bucket }) => counts[bucket] > 0).map(({ bucket, label }) => (
        <View
          key={bucket}
          accessible
          accessibilityLabel={`${label}: ${counts[bucket]}`}
          style={{
            minHeight: 20, flexDirection: "row", alignItems: "center", gap: 4,
            paddingHorizontal: 6, borderRadius: 6, backgroundColor: theme.colors.surface2,
          }}
        >
          <Text style={{ fontSize: 11, color: bucket === "done" ? theme.colors.foregroundMuted : theme.colors.foreground }}>
            {counts[bucket]}
          </Text>
          <SessionStatusIndicator bucket={bucket} theme={theme} platform={platform} size={12} />
        </View>
      ))}
    </View>
  );
}

function ProjectAvatar({
  name,
  projectId,
  avatarUri,
  emoji,
  bg,
  size = 30,
}: {
  name: string;
  projectId: string;
  avatarUri: string | null;
  emoji: string | null;
  bg: string | null;
  size?: number;
}) {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [avatarUri]);

  const radius = Math.round(size * 0.28);

  if (avatarUri && !imgFailed) {
    return (
      <Image
        source={{ uri: avatarUri }}
        resizeMode="cover"
        onError={() => setImgFailed(true)}
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: "rgba(128,128,128,0.12)",
        }}
      />
    );
  }

  const fill = bg || hashColor(projectId);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: fill,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{
          color: "#FFFFFF",
          fontSize: emoji ? Math.round(size * 0.54) : Math.round(size * 0.38),
          fontWeight: "700",
        }}
      >
        {emoji || monogram(name)}
      </Text>
    </View>
  );
}

function dispatchNativePress(element: HTMLElement) {
  try {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const opts: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
    };
    element.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...opts,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    element.dispatchEvent(new MouseEvent("mousedown", opts));
    element.dispatchEvent(
      new PointerEvent("pointerup", {
        ...opts,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
    element.dispatchEvent(new MouseEvent("mouseup", opts));
    element.dispatchEvent(new MouseEvent("click", opts));
  } catch {
    // fallback
  }
  try {
    element.click();
  } catch {
    // ignore
  }
}

function openUsageLimits(serverId?: string) {
  if (typeof document !== "undefined") {
    // 1. Ищем строку сайдбара "Лимиты и расход" в DOM по testID Paseo
    const targetEl =
      document.querySelector<HTMLElement>('[data-testid="plugin-sidebar-usage-monitor-limits"]') ||
      document.querySelector<HTMLElement>('[data-testid="plugin-sidebar-limits"]') ||
      document.querySelector<HTMLElement>('[data-testid*="usage-monitor"][data-testid*="limits"]');

    if (targetEl) {
      dispatchNativePress(targetEl);
      return;
    }

    // 2. Ищем элемент строки сайдбара по тексту
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("div, span, p, a, button"));
    for (const el of candidates) {
      if (el.children.length === 0 && el.textContent?.trim() === "Лимиты и расход") {
        const pressable = el.closest<HTMLElement>('[role="button"], a, [tabindex]') || el;
        dispatchNativePress(pressable);
        return;
      }
    }
  }

  // 3. Fallback: роутер Expo Router через history pushState + popstate
  if (typeof window !== "undefined") {
    const effectiveHost =
      serverId ||
      /^\/h\/([^/]+)/.exec(window.location.pathname)?.[1] ||
      "srv_9gLC3h4KJAzP";
    const targetUrl = `/h/${encodeURIComponent(effectiveHost)}/plugin/paseo-hq/surface/limits`;

    if (typeof document !== "undefined") {
      const closeBtn = document.querySelector<HTMLElement>('[data-testid="sidebar-close-button"]');
      if (closeBtn) {
        dispatchNativePress(closeBtn);
      }
    }

    try {
      window.history.pushState(null, "", targetUrl);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch {
      window.location.href = targetUrl;
    }
  }
}

function ChatActionButton({ label, icon, color, disabled, onPress, theme, quiet = false }: {
  label: string;
  icon: string;
  color?: string;
  disabled?: boolean;
  onPress: () => void;
  theme: PluginTheme;
  quiet?: boolean;
}) {
  const c = theme.colors;
  return (
    <TooltipPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      tooltip={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: quiet ? 34 : 44,
        height: quiet ? 36 : 44,
        flexShrink: quiet ? 0 : 1,
        borderRadius: 9,
        borderWidth: quiet ? 0 : 1,
        borderColor: c.border,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? c.surface1 : quiet ? undefined : c.surface2,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Icon name={icon} size={18} color={color ?? c.foreground} />
    </TooltipPressable>
  );
}

function ProjectHeaderPressable({
  group,
  isOpen,
  onToggleOpen,
  theme,
  layout,
  relativeTime,
}: {
  group: ProjectGroup;
  isOpen: boolean;
  onToggleOpen: () => void;
  theme: PluginTheme;
  layout: PluginSidebarItemProps["layout"];
  relativeTime: (ms: number) => string;
}) {
  const c = theme.colors;
  const content = (
    <View
      style={{
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 2,
        minWidth: 0,
      }}
    >
      <ProjectAvatar
        name={group.name}
        projectId={group.id}
        avatarUri={group.resolvedAvatarUri}
        emoji={group.meta.avatarEmoji}
        bg={group.meta.avatarBg}
        size={32}
      />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: c.foreground, fontSize: 14, fontWeight: "600" }}>
            {group.name}
          </Text>
          {group.meta.pinned ? <Text accessibilityLabel="Закрепленный проект" style={{ fontSize: 12 }}>📌</Text> : null}
          {!isOpen && group.summaryBucket !== "done" ? (
            <SessionStatusIndicator
              bucket={group.summaryBucket}
              theme={theme}
              platform={layout.platform}
              size={15}
            />
          ) : null}
        </View>
        <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11 }}>
          {group.chats.length === 0
            ? "нет активных областей"
            : `${formatRussianCount(group.chats.length, "область", "области", "областей")}${
                group.hasRunning
                  ? " · в работе"
                  : group.lastRunningAt
                    ? ` · ${relativeTime(group.lastRunningAt)}`
                    : ""
              }`}
        </Text>
      </View>
    </View>
  );

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onToggleOpen}
      style={{
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
      }}
    >
      {content}
    </Pressable>
  );
}

function agentTitle(agent: AgentEntry["agent"]): string {
  return agent.title?.trim() || "Агент без названия";
}

function AgentSummary({ agent, branch, theme, platform, gap = 4 }: {
  agent: AgentEntry["agent"];
  branch?: string;
  theme: PluginTheme;
  platform: PluginSidebarItemProps["layout"]["platform"];
  gap?: number;
}) {
  const c = theme.colors;
  const family = resolveModelFamilyBadge(agent);
  const bucket = deriveAgentBucket(agent);
  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap }}>
      <View accessible accessibilityLabel={`Статус агента: ${SESSION_STATUS_LABEL[bucket]}`}>
        <SessionStatusIndicator bucket={bucket} theme={theme} platform={platform} size={SESSION_STATUS_SIZE} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "500" }}>
          {agentTitle(agent)}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 16 }}>
          {family ? (
            <View style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: family.bg }}>
              <Text numberOfLines={1} style={{ fontSize: 10, fontWeight: "600", color: family.text }}>
                {family.label}
              </Text>
            </View>
          ) : null}
          {branch ? (
            <View
              accessible
              accessibilityLabel={`Ветка при запуске: ${branch}`}
              style={{ flexShrink: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 3,
                borderRadius: 4, backgroundColor: c.surface2, paddingHorizontal: 4, paddingVertical: 1 }}
            >
              <Icon name="GitBranch" size={11} color={c.foregroundMuted} />
              <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 10, color: c.foregroundMuted }}>{branch}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function openTerminalTab(hostId: string, terminal: PaseoTerminal, platform: PluginSidebarItemProps["layout"]["platform"]) {
  const target = `/h/${encodeURIComponent(hostId)}/workspace/${encodeURIComponent(terminal.workspaceId)}?open=${encodeURIComponent(`terminal:${terminal.id}`)}`;
  if (platform === "web" && typeof window !== "undefined") {
    window.location.assign(target);
    return Promise.resolve();
  }
  return Linking.openURL(`paseo://${target}`);
}

function TerminalRow({ terminal, onOpen, onMenu, disabled, theme, nested = false }: {
  terminal: PaseoTerminal;
  onOpen: () => void;
  onMenu: () => void;
  disabled?: boolean;
  theme: PluginTheme;
  nested?: boolean;
}) {
  const c = theme.colors;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Открыть терминал ${terminal.name}`}
        onPress={onOpen}
        style={({ pressed }) => ({
          flex: 1, minWidth: 0, flexDirection: "row", alignItems: "flex-start", minHeight: 44,
          gap: nested ? NESTED_ITEM_GAP : 7,
          paddingLeft: nested ? 0 : 10, paddingRight: 10, paddingVertical: 5, borderRadius: 8,
          backgroundColor: pressed ? c.surface2 : undefined,
        })}
      >
        <View style={{ paddingTop: 2 }}>
          <Icon name="Terminal" size={SESSION_STATUS_SIZE} color={c.foregroundMuted} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 13, lineHeight: 18 }}>{terminal.name}</Text>
          <Text
            numberOfLines={1}
            ellipsizeMode="middle"
            accessibilityLabel={`Корень терминала: ${terminal.cwd}`}
            style={{ color: c.foregroundMuted, fontSize: 10, fontFamily: "monospace" }}
          >
            {terminal.cwd}
          </Text>
        </View>
      </Pressable>
      <ChatActionButton
        label={`Меню терминала ${terminal.name}`}
        icon="MoreHorizontal"
        quiet
        disabled={disabled}
        onPress={onMenu}
        theme={theme}
      />
    </View>
  );
}

function ItemMenuActions({ actions, theme, disabled }: {
  actions: { label: string; icon: string; onPress: () => void; danger?: boolean }[];
  theme: PluginTheme;
  disabled: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
      {actions.map(({ label, icon, onPress, danger }) => (
        <ChatActionButton
          key={label}
          label={label}
          icon={icon}
          color={danger ? theme.colors.statusDanger : undefined}
          disabled={disabled}
          onPress={onPress}
          theme={theme}
        />
      ))}
    </View>
  );
}

function SidebarEmbeddedProjects({ theme, layout, host, openScreen, openPopover }: PluginSidebarItemProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const readSidebar = useRpc(sidebarReadRpc);
  const readAreaSettings = useRpc(areaSettingsRpc);
  const createAreaSession = useRpc(areaSessionCreateRpc);
  const saveProject = useRpc(projectSaveRpc);
  const pinSession = useRpc(sessionPinRpc);
  const suggestSessionTitle = useRpc(sessionTitleSuggestRpc);
  const renameAgent = useRpc(chatRenameRpc);
  const loadCandidates = useRpc(projectCandidatesRpc);
  const addProjectRpc = useRpc(projectAddRpc);
  const removeProject = useRpc(projectRemoveRpc);
  const updatePanelSettings = useRpc(panelSettingsRpc);
  const transferSession = useRpc(sessionTransferRpc);
  const syncPluginRpc = useRpc(pluginSyncRpc);

  const [projects, setProjects] = useState<PaseoProject[]>([]);
  const [workspaces, setWorkspaces] = useState<PaseoWorkspace[]>([]);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [terminals, setTerminals] = useState<PaseoTerminal[]>([]);
  const [terminalListFailed, setTerminalListFailed] = useState(false);
  const [archivedIds, setArchivedIds] = useState<Record<string, boolean>>({});
  const [serverState, setServerState] = useState<SidebarState>({
    projects: {},
    nativeIcons: {},
    areaIcons: {},
    areaIconBgs: {},
    lastRunningAt: {},
    pinnedSessions: {},
    showHostMetrics: true,
    headerTitle: "Штаб",
    projectsSortMode: "auto",
    projectOrder: [],
  });

  const [collapsed, setCollapsed] = useState(false);
  const [panelSettingsOpen, setPanelSettingsOpen] = useState(false);
  const [savingPanelSettings, setSavingPanelSettings] = useState(false);
  const [draftHeaderTitle, setDraftHeaderTitle] = useState("Штаб");
  const [syncingPlugin, setSyncingPlugin] = useState(false);
  const [syncResult, setSyncResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleSyncPlugin = async () => {
    if (syncingPlugin) return;
    setSyncingPlugin(true);
    setSyncResult(null);
    try {
      const res = await syncPluginRpc({});
      setSyncResult({ success: res.success, message: res.message });
    } catch (err: any) {
      setSyncResult({
        success: false,
        message: `Ошибка синхронизации: ${err?.message || String(err)}`,
      });
    } finally {
      setSyncingPlugin(false);
    }
  };
  const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>({});
  const [expandedAreaIds, setExpandedAreaIds] = useState<Record<string, boolean>>({});
  const [creatingAreaIds, setCreatingAreaIds] = useState<Record<string, boolean>>({});
  const [expandedAllChats, setExpandedAllChats] = useState<Record<string, boolean>>({});
  const [showHiddenProjects, setShowHiddenProjects] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [creatingTerminalId, setCreatingTerminalId] = useState<string | null>(null);
  const [newAgentWorkspaceId, setNewAgentWorkspaceId] = useState<string | null>(null);
  const [newAgentModels, setNewAgentModels] = useState<PaseoProviderSnapshotResult["entries"]>([]);
  const [newAgentModel, setNewAgentModel] = useState<string | null>(null);
  const [newAgentModelsError, setNewAgentModelsError] = useState<string | null>(null);
  const agentModelsRequest = useRef(0);
  const [newArea, setNewArea] = useState<{
    projectId: string;
    name: string;
    firstTab: "session" | "terminal";
    workspaceId?: string;
  } | null>(null);

  // Модалка добавления нового проекта
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addMode, setAddMode] = useState<AddProjectMode>("existing");
  const [candidates, setCandidates] = useState<CandidateDir[]>([]);
  const [candidateFilter, setCandidateFilter] = useState("");
  const [manualPath, setManualPath] = useState("");
  const [parentPath, setParentPath] = useState("~/repos");
  const [newFolderName, setNewFolderName] = useState("");
  const [cloneRepoUrl, setCloneRepoUrl] = useState("");
  const [addCustomName, setAddCustomName] = useState("");
  const [initGit, setInitGit] = useState(true);
  const [addingProject, setAddingProject] = useState(false);

  // Модалка настроек проекта
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [draftProjectName, setDraftProjectName] = useState("");
  const [draftAvatarUrl, setDraftAvatarUrl] = useState("");
  const [draftAvatarUpdate, setDraftAvatarUpdate] = useState<AvatarUpdate>({ kind: "keep" });
  const [draftNewMode, setDraftNewMode] = useState<"directory" | "worktree">("directory");
  const [draftHidden, setDraftHidden] = useState(false);
  const [draftPinned, setDraftPinned] = useState(false);
  const [titleProviders, setTitleProviders] = useState<PaseoProviderSnapshotResult["entries"]>([]);
  const [titleModelsError, setTitleModelsError] = useState<string | null>(null);
  const [confirmRemoveProject, setConfirmRemoveProject] = useState(false);
  const [savingProject, setSavingProject] = useState(false);

  // Панель области и ее настройки
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [areaSessionFilter, setAreaSessionFilter] = useState<(typeof AREA_SESSION_FILTERS)[number]["value"]>("all");
  const [areaSettingsPanel, setAreaSettingsPanel] = useState<"branch" | null>(null);
  const [draftChatTitle, setDraftChatTitle] = useState<string | null>(null);
  const [draftTitleSelection, setDraftTitleSelection] = useState<{ start: number; end: number }>();
  const draftTitleRevision = useRef(0);
  const [savingChat, setSavingChat] = useState(false);
  const titleSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingTitleSaves = useRef(0);
  const areaTitleInput = useRef<React.ElementRef<typeof TextInput>>(null);
  const [areaSettings, setAreaSettings] = useState<z.infer<typeof areaSettingsRpc.output> | null>(null);
  const [areaSettingsError, setAreaSettingsError] = useState<string | null>(null);
  const [savingAreaSettings, setSavingAreaSettings] = useState(false);
  const [suggestingTitle, setSuggestingTitle] = useState(false);
  const [agentMenuId, setAgentMenuId] = useState<string | null>(null);
  const [draftAgentTitle, setDraftAgentTitle] = useState<string | null>(null);
  const [agentTitleModelChoice, setAgentTitleModelChoice] = useState<string | null>(null);
  const [suggestingAgentTitle, setSuggestingAgentTitle] = useState(false);
  const agentTitleInput = useRef<React.ElementRef<typeof TextInput>>(null);
  const [confirmClosingSession, setConfirmClosingSession] = useState(false);
  const [terminalMenuId, setTerminalMenuId] = useState<string | null>(null);
  const [confirmClosingTerminal, setConfirmClosingTerminal] = useState(false);
  const [chatTransferOpen, setChatTransferOpen] = useState(false);
  const [transferTargetProjectId, setTransferTargetProjectId] = useState<string>("");
  const [transferArchiveOriginal, setTransferArchiveOriginal] = useState<boolean>(true);
  const [transferIncludeHistory, setTransferIncludeHistory] = useState<boolean>(true);
  const [transferringChat, setTransferringChat] = useState<boolean>(false);
  const chatMutationPending = savingChat || transferringChat || savingAreaSettings;

  const c = theme.colors;
  const isWeb = layout.platform === "web" && typeof (globalThis as { document?: unknown }).document !== "undefined";
  const btnSize = layout.compact ? 36 : 30;

  const reloadAll = useCallback(async () => {
    const terminalRefresh = paseo.terminals.list()
      .then(({ entries }) => {
        setTerminals(entries);
        setTerminalListFailed(false);
      }, () => setTerminalListFailed(true));
    try {
      const [projRes, wsRes, agRes] = await Promise.all([
        paseo.projects.list({}),
        paseo.workspaces.list({}),
        paseo.agents.list({}).catch(() => ({ entries: [] as AgentEntry[] })),
      ]);
      const nextProjects = projRes.projects ?? [];
      const nextWorkspaces = (wsRes.entries ?? []).filter((w) => !w.archivingAt && !w.background);
      setProjects(nextProjects);
      setWorkspaces(nextWorkspaces);
      setAgents(agRes.entries ?? []);
      const ids = Array.from(
        new Set([
          ...nextProjects.map((p) => p.projectId),
          ...nextWorkspaces.map((w) => w.projectId),
        ]),
      );
      const st = await readSidebar({ projectIds: ids });
      setServerState(st);
    } catch {
      // Сохраняем прошлый снимок при временной сетевой ошибке.
    }
    await terminalRefresh;
  }, [paseo, readSidebar]);

  useEffect(() => {
    void reloadAll();
    const unsubWs = paseo.workspaces.subscribe(() => void reloadAll());
    const unsubPrj = paseo.projects.subscribe(() => void reloadAll());
    const unsubAg = paseo.agents.subscribe(() => void reloadAll());
    const timer = setInterval(() => void reloadAll(), 5000);
    return () => {
      unsubWs();
      unsubPrj();
      unsubAg();
      clearInterval(timer);
    };
  }, [paseo, reloadAll]);

  const { agentBucketByWorkspace, agentTurnFinishMap, agentPromptMap, latestAgentByWorkspace } = useMemo(() => {
    const bucketMap: Record<string, UiSessionBucket> = {};
    const finishMap: Record<string, number> = {};
    const agentMap: Record<string, AgentEntry["agent"]> = {};
    const promptMap: Record<string, number> = {};
    for (const entry of agents) {
      if (entry.agent.archivedAt || entry.agent.internal) continue;
      const wsId = entry.agent.workspaceId;
      if (!wsId) continue;
      const bucket = deriveAgentBucket(entry.agent);
      bucketMap[wsId] = pickWorkspaceBucket(bucketMap[wsId], bucket);
      const attMs = parseIsoMs(entry.agent.attentionTimestamp);
      const msgMs = parseIsoMs(entry.agent.lastUserMessageAt);
      if (entry.agent.title !== GENERATOR_TITLE && msgMs > (promptMap[wsId] ?? 0)) promptMap[wsId] = msgMs;
      const runMs = entry.agent.status === "running" ? parseIsoMs(entry.agent.updatedAt) : 0;
      const bestTs = Math.max(attMs, msgMs, runMs);
      if (bestTs > (finishMap[wsId] ?? 0)) {
        finishMap[wsId] = bestTs;
      }
      const existing = agentMap[wsId];
      if (!existing) {
        agentMap[wsId] = entry.agent;
      } else {
        const existingTs = Math.max(
          parseIsoMs(existing.attentionTimestamp),
          parseIsoMs(existing.lastUserMessageAt),
          existing.status === "running" ? parseIsoMs(existing.updatedAt) : 0,
        );
        if (bestTs >= existingTs) {
          agentMap[wsId] = entry.agent;
        }
      }
    }
    return { agentBucketByWorkspace: bucketMap, agentTurnFinishMap: finishMap, agentPromptMap: promptMap, latestAgentByWorkspace: agentMap };
  }, [agents]);

  const agentsByWorkspace = useMemo(() => {
    const map = new Map<string, AgentEntry[]>();
    for (const entry of agents) {
      if (entry.agent.archivedAt || entry.agent.internal) continue;
      const wsId = entry.agent.workspaceId;
      if (!wsId) continue;
      const list = map.get(wsId) || [];
      list.push(entry);
      map.set(wsId, list);
    }
    return map;
  }, [agents]);

  const allGroups = useMemo<ProjectGroup[]>(() => {
    const byProject = new Map<string, ProjectGroup>();

    for (const p of projects) {
      const meta = serverState.projects[p.projectId] ?? DEFAULT_META;
      byProject.set(p.projectId, {
        id: p.projectId,
        name: projectTitle(p),
        customName: p.projectCustomName ?? null,
        displayName: p.projectDisplayName || p.projectRootPath.split("/").pop() || "Проект",
        rootPath: p.projectRootPath,
        meta,
        resolvedAvatarUri: meta.avatarUri ?? serverState.nativeIcons[p.projectId] ?? null,
        lastRunningAt: 0,
        lastPromptAt: 0,
        hasRunning: false,
        summaryBucket: "done",
        chats: [],
      });
    }

    for (const w of workspaces) {
      if (archivedIds[w.id]) continue;
      let g = byProject.get(w.projectId);
      if (!g) {
        const meta = serverState.projects[w.projectId] ?? DEFAULT_META;
        const fallbackName = w.projectCustomName || w.projectDisplayName || "Прочие";
        g = {
          id: w.projectId,
          name: fallbackName,
          customName: w.projectCustomName ?? null,
          displayName: w.projectDisplayName || fallbackName,
          rootPath: w.projectRootPath || w.workspaceDirectory,
          meta,
          resolvedAvatarUri: meta.avatarUri ?? serverState.nativeIcons[w.projectId] ?? null,
          lastRunningAt: 0,
          lastPromptAt: 0,
          hasRunning: false,
          summaryBucket: "done",
          chats: [],
        };
        byProject.set(w.projectId, g);
      }
      g.chats.push(w);
    }

    const list = [...byProject.values()];
    const pinnedMap = serverState.pinnedSessions;
    const runningMap = serverState.lastRunningAt;

    for (const g of list) {
      let maxRun = 0;
      let maxPrompt = 0;
      let hasRunning = false;
      let best: UiSessionBucket = "done";

      for (const ch of g.chats) {
        const b = resolveChatBucket(ch, agentBucketByWorkspace);
        if (b === "running") hasRunning = true;
        if (BUCKET_PRIORITY[b] < BUCKET_PRIORITY[best]) {
          best = b;
        }
        const ts = chatLastRunningMs(ch, b, runningMap, agentTurnFinishMap);
        if (ts > maxRun) maxRun = ts;
        maxPrompt = Math.max(maxPrompt, chatLastPromptMs(ch, agentPromptMap));
      }

      g.chats.sort((a, b) => {
        const aPin = Boolean(pinnedMap[a.id]);
        const bPin = Boolean(pinnedMap[b.id]);
        if (aPin !== bPin) return aPin ? -1 : 1;

        const aTs = chatLastPromptMs(a, agentPromptMap);
        const bTs = chatLastPromptMs(b, agentPromptMap);
        if (bTs !== aTs) return bTs - aTs;

        return (pinnedMap[b.id] ?? 0) - (pinnedMap[a.id] ?? 0);
      });

      g.lastRunningAt = maxRun;
      g.lastPromptAt = maxPrompt;
      g.hasRunning = hasRunning;
      g.summaryBucket = best;
    }

    list.sort(compareProjectOrder);
    return list;
  }, [projects, workspaces, archivedIds, serverState, agentBucketByWorkspace, agentTurnFinishMap, agentPromptMap]);

  const hiddenCount = useMemo(() => allGroups.filter((g) => g.meta.hidden).length, [allGroups]);
  const visibleGroups = useMemo(
    () => (showHiddenProjects ? allGroups : allGroups.filter((g) => !g.meta.hidden)),
    [allGroups, showHiddenProjects],
  );

  const isProjectOpen = useCallback(
    (projectId: string, isFirst: boolean) => {
      const explicit = expandedProjectIds[projectId];
      if (explicit !== undefined) return explicit;
      return isFirst;
    },
    [expandedProjectIds],
  );

  const toggleProjectOpen = useCallback((projectId: string, isFirst: boolean) => {
    setExpandedProjectIds((prev) => {
      const current = prev[projectId] !== undefined ? prev[projectId] : isFirst;
      return { ...prev, [projectId]: !current };
    });
  }, []);

  const editingGroup = useMemo(
    () => (editingProjectId ? allGroups.find((g) => g.id === editingProjectId) ?? null : null),
    [allGroups, editingProjectId],
  );

  const editingChat = useMemo(
    () => (editingChatId ? workspaces.find((w) => w.id === editingChatId) ?? null : null),
    [workspaces, editingChatId],
  );

  useEffect(() => {
    if (!editingChatId) return;
    let live = true;
    void readAreaSettings({ workspaceId: editingChatId }).then(
      (info) => { if (live) setAreaSettings(info); },
      (error: unknown) => {
        if (live) setAreaSettingsError(error instanceof Error ? error.message : "Не удалось загрузить настройки области");
      },
    );
    return () => { live = false; };
  }, [editingChatId, readAreaSettings]);

  const editingChatPinned = editingChat ? Boolean(serverState.pinnedSessions[editingChat.id]) : false;
  const editingChatAgent = editingChat ? latestAgentByWorkspace[editingChat.id] : undefined;
  const editingAreaTitle = editingChat ? chatTitle(editingChat, editingChatAgent) : "";
  const editingChatEntries = (editingChat ? agentsByWorkspace.get(editingChat.id) : undefined) ?? [];
  const editingChatTerminals = terminals.filter((terminal) => terminal.workspaceId === editingChatId);
  const visibleAreaAgents = areaSessionFilter === "terminals" ? [] : editingChatEntries;
  const visibleAreaTerminals = areaSessionFilter === "agents" ? [] : editingChatTerminals;
  const queryClient = useQueryClient();
  const closedAgents = useQuery({
    queryKey: ["hq-closed-agents", host.id, editingChat?.id],
    enabled: Boolean(editingChat),
    queryFn: async () => {
      if (!editingChat) return [];
      const archived: AgentEntry["agent"][] = [];
      let cursor: string | null = null;
      do {
        const page: Awaited<ReturnType<typeof paseo.agents.list>> = await paseo.agents.list({
          filter: { includeArchived: true, projectKeys: [editingChat.projectId] },
          page: { limit: 200, cursor: cursor ?? undefined },
        });
        for (const { agent } of page.entries) {
          if (agent.workspaceId === editingChat.id && agent.archivedAt && !agent.internal) archived.push(agent);
        }
        cursor = page.pageInfo.nextCursor;
      } while (cursor);
      return archived.sort((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""));
    },
  });
  const terminalMenuItem = terminals.find((terminal) => terminal.id === terminalMenuId);
  const titleSourceAgent = editingChatEntries[0]?.agent;
  const titleModel = areaSettings?.titleModel ?? (editingChat ? serverState.projects[editingChat.projectId]?.sessionTitleModel : null) ?? "first_line";
  const canSuggestTitle = Boolean(titleSourceAgent) && !suggestingTitle && !chatMutationPending;
  const agentMenuChat = agents.find(({ agent }) =>
    agent.id === agentMenuId && agent.workspaceId && !agent.archivedAt && !agent.internal,
  )?.agent;

  const currentProjectGroup = useMemo(
    () => (editingChat ? allGroups.find((g) => g.id === editingChat.projectId) ?? null : null),
    [allGroups, editingChat],
  );

  const availableTargetProjects = useMemo(
    () => (editingChat ? allGroups.filter((g) => g.id !== editingChat.projectId) : []),
    [allGroups, editingChat],
  );

  const filteredCandidates = useMemo(() => {
    const q = candidateFilter.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (item) => item.name.toLowerCase().includes(q) || item.path.toLowerCase().includes(q),
    );
  }, [candidates, candidateFilter]);

  const jumpToWorkspace = useCallback(
    (workspaceId: string) => {
      openScreen({ screenId: "jump", params: { jump: workspaceId, t: String(Date.now()) } });
    },
    [openScreen],
  );

  const jumpToAgent = (agentId: string) => {
    openScreen({ screenId: "jump", params: { agentId, t: String(Date.now()) } });
  };

  const prepareAgentModels = async (group: ProjectGroup, workspaceId?: string) => {
    const request = ++agentModelsRequest.current;
    setNewAgentModel(null);
    setNewAgentModels([]);
    setNewAgentModelsError(null);
    try {
      const cwd = workspaceId
        ? allGroups.flatMap(item => item.chats).find(chat => chat.id === workspaceId)?.workspaceDirectory ?? group.rootPath
        : group.rootPath;
      const [snapshot, preferred] = await Promise.all([
        paseo.providers.waitForReady({ cwd }),
        projectAgentConfig(paseo, group, agents),
      ]);
      if (request !== agentModelsRequest.current) return;
      const available = snapshot.entries.filter(entry => entry.enabled && entry.status === "ready");
      const options = titleModelOptions(available, "first_line").filter(option => option.provider);
      setNewAgentModels(available);
      setNewAgentModel(options.some(option => option.value === preferred.provider)
        ? preferred.provider : options[0]?.value ?? null);
      if (!options.length) setNewAgentModelsError("Нет доступных моделей для нового агента");
    } catch (error) {
      if (request === agentModelsRequest.current) setNewAgentModelsError(
        error instanceof Error ? error.message : "Не удалось загрузить модели");
    }
  };

  const openNewArea = (group: ProjectGroup) => {
    setNewArea({ projectId: group.id, name: "Новая область", firstTab: "session" });
    void prepareAgentModels(group);
  };

  const openNewAreaAgent = (workspaceId: string) => {
    const group = allGroups.find(item => item.chats.some(chat => chat.id === workspaceId));
    if (!group) return;
    setNewAgentWorkspaceId(workspaceId);
    void prepareAgentModels(group, workspaceId);
  };

  const handleCreateAreaSession = async (workspaceId: string) => {
    if (!newAgentModel) return;
    if (creatingAreaIds[workspaceId]) return;
    setCreatingAreaIds((prev) => ({ ...prev, [workspaceId]: true }));
    try {
      const { agentId } = await createAreaSession({ workspaceId, model: newAgentModel });
      setExpandedAreaIds((prev) => ({ ...prev, [workspaceId]: true }));
      setEditingChatId((current) => current === workspaceId ? null : current);
      setNewAgentWorkspaceId(null);
      jumpToAgent(agentId);
      void reloadAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось создать агента");
    } finally {
      setCreatingAreaIds((prev) => {
        const next = { ...prev };
        delete next[workspaceId];
        return next;
      });
    }
  };

  const openAreaTerminal = (terminal: PaseoTerminal) => {
    void openTerminalTab(host.id, terminal, layout.platform).catch(() => {
      toast.error("Не удалось открыть терминал");
    });
  };

  const handleCreateAreaTerminal = async (workspaceId: string) => {
    if (creatingTerminalId) return;
    setCreatingTerminalId(workspaceId);
    try {
      const terminal = await paseo.workspaces.ref(workspaceId).terminals.create();
      const snapshot = terminal.current();
      if (!snapshot) throw new Error("Терминал создан, но его данные недоступны");
      setExpandedAreaIds((prev) => ({ ...prev, [workspaceId]: true }));
      setEditingChatId((current) => current === workspaceId ? null : current);
      openAreaTerminal(snapshot);
      void reloadAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось создать терминал");
    } finally {
      setCreatingTerminalId(null);
    }
  };

  const createNewArea = async () => {
    if (!newArea || creatingId) return;
    const group = allGroups.find((item) => item.id === newArea.projectId);
    if (!group) return;
    setCreatingId(group.id);
    try {
      let workspaceId = newArea.workspaceId;
      if (!workspaceId) {
        if (newArea.firstTab === "session" && !newAgentModel) throw new Error("Выберите модель агента");
        const agent = newArea.firstTab === "session"
          ? { config: { provider: newAgentModel! }, cwd: group.rootPath }
          : undefined;
        const created = await paseo.workspaces.create({
          title: newArea.name.trim() || "Новая область",
          agent,
          source: group.meta.newSessionMode === "worktree"
            ? { kind: "worktree", cwd: group.rootPath, projectId: group.id }
            : { kind: "directory", path: group.rootPath, projectId: group.id },
        });
        workspaceId = created.id;
        setNewArea({ ...newArea, workspaceId });
      }

      setExpandedProjectIds((prev) => ({ ...prev, [group.id]: true }));
      setExpandedAreaIds((prev) => ({ ...prev, [workspaceId]: true }));
      if (newArea.firstTab === "terminal") {
        const terminal = await paseo.workspaces.ref(workspaceId).terminals.create();
        const snapshot = terminal.current();
        if (!snapshot) throw new Error("Терминал создан, но его данные недоступны");
        openAreaTerminal(snapshot);
      } else {
        jumpToWorkspace(workspaceId);
      }
      setNewArea(null);
      void reloadAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось создать область");
    } finally {
      setCreatingId(null);
    }
  };

  const openAddProjectModal = async () => {
    setAddMode("existing");
    setCandidateFilter("");
    setManualPath("");
    setNewFolderName("");
    setCloneRepoUrl("");
    setAddCustomName("");
    setInitGit(true);
    setAddModalOpen(true);
    try {
      const res = await loadCandidates({ existingPaths: allGroups.map((g) => g.rootPath) });
      setCandidates(res.items);
      setParentPath(res.defaultParent);
    } catch {
      setCandidates([]);
    }
  };

  const handleQuickAddCandidate = async (dir: CandidateDir) => {
    if (addingProject) return;
    setAddingProject(true);
    try {
      const res = await addProjectRpc({
        mode: "existing",
        path: dir.path,
        customName: addCustomName.trim() || undefined,
      });
      await reloadAll();
      setExpandedProjectIds((prev) => ({ ...prev, [res.projectId]: true }));
      setCollapsed(false);
      setAddModalOpen(false);
      toast.show(`Проект ${dir.name} добавлен`, { variant: "success" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось добавить проект");
    } finally {
      setAddingProject(false);
    }
  };

  const handleSubmitAddProject = async () => {
    if (addingProject) return;
    setAddingProject(true);
    try {
      let res: { projectId: string; rootPath: string };
      if (addMode === "existing") {
        const p = manualPath.trim();
        if (!p) {
          throw new Error("Выберите папку из списка выше или введите путь на сервере");
        }
        res = await addProjectRpc({
          mode: "existing",
          path: p,
          customName: addCustomName.trim() || undefined,
        });
      } else if (addMode === "create") {
        const fname = newFolderName.trim();
        if (!fname) {
          throw new Error("Введите имя новой папки проекта");
        }
        res = await addProjectRpc({
          mode: "create",
          parentPath: parentPath.trim() || "~/repos",
          folderName: fname,
          customName: addCustomName.trim() || undefined,
          initGit,
        });
      } else {
        const repo = cloneRepoUrl.trim();
        if (!repo) {
          throw new Error("Введите ссылку на Git-репозиторий");
        }
        res = await addProjectRpc({
          mode: "clone",
          repoUrl: repo,
          parentPath: parentPath.trim() || "~/repos",
          folderName: newFolderName.trim() || undefined,
          customName: addCustomName.trim() || undefined,
        });
      }
      await reloadAll();
      setExpandedProjectIds((prev) => ({ ...prev, [res.projectId]: true }));
      setCollapsed(false);
      setAddModalOpen(false);
      toast.show("Проект добавлен", { variant: "success" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось добавить проект");
    } finally {
      setAddingProject(false);
    }
  };

  const agentMenuWorkspace = workspaces.find(workspace => workspace.id === agentMenuChat?.workspaceId);
  useEffect(() => {
    if (!editingChatId && !agentMenuId) return;
    let cancelled = false;
    setTitleModelsError(null);
    void paseo.providers.waitForReady({ cwd: (editingChat ?? agentMenuWorkspace)?.workspaceDirectory }).then(snapshot => {
      if (!cancelled) setTitleProviders(snapshot.entries);
    }).catch(error => {
      if (!cancelled) setTitleModelsError(error instanceof Error ? error.message : "Каталог моделей недоступен");
    });
    return () => { cancelled = true; };
  }, [editingChatId, agentMenuId, editingChat?.workspaceDirectory, agentMenuWorkspace?.workspaceDirectory, paseo]);

  const openProjectSettings = (group: ProjectGroup) => {
    setEditingProjectId(group.id);
    setDraftProjectName(group.customName ?? group.name);
    setDraftAvatarUrl("");
    setDraftAvatarUpdate({ kind: "keep" });
    setDraftNewMode(group.meta.newSessionMode);
    setDraftHidden(group.meta.hidden);
    setDraftPinned(group.meta.pinned);
    setConfirmRemoveProject(false);
  };

  const handlePickWebFile = async () => {
    const uri = await pickWebImageAsDataUri();
    if (uri) {
      setDraftAvatarUpdate({ kind: "dataUri", dataUri: uri });
      setDraftAvatarUrl("");
    }
  };

  const handleSaveProjectSettings = async () => {
    if (!editingGroup || savingProject) return;
    setSavingProject(true);
    try {
      const trimmedUrl = draftAvatarUrl.trim();
      const avatarPayload: AvatarUpdate = trimmedUrl
        ? { kind: "urlOrPath", value: trimmedUrl }
        : draftAvatarUpdate;
      const trimmedName = draftProjectName.trim();
      const folderName = editingGroup.rootPath.split("/").pop() || "";
      const customName =
        trimmedName === "" || trimmedName === folderName ? null : trimmedName;
      const nameChanged = customName !== (editingGroup.customName ?? null);

      const updated = await saveProject({
        projectId: editingGroup.id,
        customName: nameChanged ? customName : undefined,
        avatar: avatarPayload,
        newSessionMode: draftNewMode,
        hidden: draftHidden,
        pinned: draftPinned,
      });
      setServerState((prev) => ({
        ...prev,
        ...updated,
        nativeIcons: { ...prev.nativeIcons, ...updated.nativeIcons },
      }));
      await reloadAll();
      setEditingProjectId(null);
      toast.show("Настройки проекта сохранены", { variant: "success" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить настройки проекта");
    } finally {
      setSavingProject(false);
    }
  };

  const openPanelSettings = () => {
    setDraftHeaderTitle(serverState.headerTitle || "Штаб");
    setPanelSettingsOpen(true);
  };

  const handleSaveHeaderTitle = async () => {
    if (savingPanelSettings) return;
    const nextTitle = draftHeaderTitle.trim() || "Штаб";
    setSavingPanelSettings(true);
    setServerState((prev) => ({ ...prev, headerTitle: nextTitle }));
    try {
      const updated = await updatePanelSettings({
        headerTitle: nextTitle,
        projectIds: allGroups.map((g) => g.id),
      });
      setServerState(updated);
      toast.show("Название вкладки обновлено", { variant: "success" });
    } catch (err) {
      await reloadAll();
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить название вкладки");
    } finally {
      setSavingPanelSettings(false);
    }
  };

  const handleToggleHostMetrics = async (enabled: boolean) => {
    if (savingPanelSettings) return;
    setSavingPanelSettings(true);
    setServerState((prev) => ({ ...prev, showHostMetrics: enabled }));
    try {
      const updated = await updatePanelSettings({
        showHostMetrics: enabled,
        projectIds: allGroups.map((g) => g.id),
      });
      setServerState(updated);
      toast.show(
        enabled ? "Мониторинг сервера включен" : "Мониторинг сервера отключен (фоновый опрос остановлен)",
        { variant: "info" },
      );
    } catch (err) {
      await reloadAll();
      toast.error(err instanceof Error ? err.message : "Не удалось обновить настройки панели");
    } finally {
      setSavingPanelSettings(false);
    }
  };

  const handleRemoveProject = async () => {
    if (!editingGroup || savingProject) return;
    if (!confirmRemoveProject) {
      setConfirmRemoveProject(true);
      return;
    }
    setSavingProject(true);
    try {
      await removeProject({ projectId: editingGroup.id });
      setEditingProjectId(null);
      setConfirmRemoveProject(false);
      await reloadAll();
      toast.show("Проект убран из списка Paseo", { variant: "info" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось убрать проект");
    } finally {
      setSavingProject(false);
    }
  };

  const updateDraftChatTitle = (value: string | null) => {
    draftTitleRevision.current += 1;
    setDraftChatTitle(value);
    setDraftTitleSelection(undefined);
  };

  const startAreaTitleEdit = () => {
    updateDraftChatTitle(editingAreaTitle);
    setDraftTitleSelection({ start: editingAreaTitle.length, end: editingAreaTitle.length });
  };

  const openAreaActions = (chat: PaseoWorkspace) => {
    if (chatMutationPending) return;
    setAreaSettings(null);
    setAreaSettingsError(null);
    setEditingChatId(chat.id);
    setAreaSessionFilter("all");
    setAreaSettingsPanel(null);
    setAgentMenuId(null);
    setChatTransferOpen(false);
    updateDraftChatTitle(null);
    const others = allGroups.filter((g) => g.id !== chat.projectId);
    setTransferTargetProjectId(others[0]?.id || "");
    setTransferArchiveOriginal(true);
    setTransferIncludeHistory(true);
  };

  const handleSaveAreaSettings = async (change: { defaultBranch: string | null }) => {
    if (!editingChat || chatMutationPending) return;
    const workspaceId = editingChat.id;
    setSavingAreaSettings(true);
    try {
      const settings = await readAreaSettings({ workspaceId, ...change });
      setAreaSettings(settings);

    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сохранить настройки области");
    } finally {
      setSavingAreaSettings(false);
    }
  };

  const handleTransferChat = async () => {
    if (!editingChat || chatMutationPending || !transferTargetProjectId) return;
    setTransferringChat(true);
    const targetGroup = allGroups.find((g) => g.id === transferTargetProjectId);
    const targetName = targetGroup ? (targetGroup.customName || targetGroup.name) : "новый проект";
    try {
      const res = await transferSession({
        workspaceId: editingChat.id,
        targetProjectId: transferTargetProjectId,
        archiveOriginal: transferArchiveOriginal,
        includeHistory: transferIncludeHistory,
      });
      setExpandedProjectIds((prev) => ({ ...prev, [res.targetProjectId]: true }));
      setChatTransferOpen(false);
      setEditingChatId(null);
      await reloadAll();
      toast.show(`Область перенесена в проект "${targetName}"`, { variant: "success" });
      jumpToWorkspace(res.newWorkspaceId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось перенести область");
    } finally {
      setTransferringChat(false);
    }
  };

  const handleRenameChat = () => {
    if (!editingChat || draftChatTitle === null) return;
    const workspaceId = editingChat.id;
    const nextTitle = draftChatTitle.trim() || null;
    if (nextTitle === editingAreaTitle && pendingTitleSaves.current === 0) {
      updateDraftChatTitle(null);
      return;
    }
    const revision = draftTitleRevision.current;
    pendingTitleSaves.current += 1;
    titleSaveQueue.current = titleSaveQueue.current.then(async () => {
      try {
        await paseo.workspaces.ref(workspaceId).setTitle(nextTitle);
        setWorkspaces(previous => previous.map(workspace =>
          workspace.id === workspaceId ? { ...workspace, title: nextTitle } : workspace,
        ));
        if (draftTitleRevision.current === revision) updateDraftChatTitle(null);
        await reloadAll();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Не удалось переименовать область");
      } finally {
        pendingTitleSaves.current -= 1;
      }
    });
  };

  // Выбор модели принадлежит области. Название остается черновиком до сохранения.
  const handleSuggestTitle = async (model: string) => {
    if (!editingChat || !titleSourceAgent || !canSuggestTitle) return;
    if (draftChatTitle === null) startAreaTitleEdit();
    const revision = draftTitleRevision.current;
    setSuggestingTitle(true);
    try {
      const settings = await readAreaSettings({ workspaceId: editingChat.id, titleModel: model });
      setAreaSettings(settings);
      const { title } = await suggestSessionTitle({
        model,
        workspaceId: editingChat.id,
        agentId: titleSourceAgent.id,
        projectId: editingChat.projectId,
      });
      if (draftTitleRevision.current === revision) {
        setDraftChatTitle(title);
        setDraftTitleSelection({ start: title.length, end: title.length });
        requestAnimationFrame(() => areaTitleInput.current?.focus());
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сгенерировать название");
    } finally {
      setSuggestingTitle(false);
    }
  };

  const agentTitleModel = agentTitleModelChoice
    ?? (agentMenuWorkspace ? serverState.projects[agentMenuWorkspace.projectId]?.sessionTitleModel : null)
    ?? "first_line";

  const handleRenameAgent = async () => {
    const title = draftAgentTitle?.trim();
    if (!agentMenuChat?.workspaceId || draftAgentTitle === null) return;
    if (!title || title === (agentMenuChat.title ?? "")) {
      setDraftAgentTitle(null);
      return;
    }
    const { workspaceId, id: agentId } = agentMenuChat;
    try {
      await renameAgent({ workspaceId, agentId, title });
      setDraftAgentTitle(null);
      await reloadAll();
      toast.show("Агент переименован", { variant: "success" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось переименовать агента");
    }
  };

  const handleSuggestAgentTitle = async (model: string) => {
    if (!agentMenuChat?.workspaceId || !agentMenuWorkspace || suggestingAgentTitle || chatMutationPending) return;
    setAgentTitleModelChoice(model);
    setSuggestingAgentTitle(true);
    try {
      const { title } = await suggestSessionTitle({
        model,
        workspaceId: agentMenuChat.workspaceId,
        agentId: agentMenuChat.id,
        projectId: agentMenuWorkspace.projectId,
      });
      setDraftAgentTitle(title);
      requestAnimationFrame(() => agentTitleInput.current?.focus());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сгенерировать название");
    } finally {
      setSuggestingAgentTitle(false);
    }
  };

  const openAgentMenu = (agentId: string) => {
    setAgentTitleModelChoice(null);
    setDraftAgentTitle(null);
    setConfirmClosingSession(false);
    setAgentMenuId(agentId);
  };

  const handleCopyAgentLink = async (agentId: string) => {
    try {
      await copyText(`paseo:///h/${host.id || "local"}/agent/${agentId}`);
      setAgentMenuId((current) => current === agentId ? null : current);
      toast.show("Ссылка на агента скопирована", { variant: "info" });
    } catch {
      toast.error("Не удалось скопировать ссылку");
    }
  };

  const handleAgentMenuAction = async (action: "reload" | "close") => {
    const workspaceId = agentMenuChat?.workspaceId;
    if (!workspaceId || !agentMenuChat || chatMutationPending) return;
    const agentId = agentMenuChat.id;
    const result = {
      reload: "Агент перезагружен",
      close: "Агент закрыт",
    };
    setSavingChat(true);
    try {
      if (action === "reload") {
        await paseo.agents.ref(agentId).reload();
      } else if (action === "close") {
        await paseo.agents.ref(agentId).archive();
        void queryClient.invalidateQueries({ queryKey: ["hq-closed-agents", host.id, workspaceId] });
      }
      await reloadAll();
      setAgentMenuId(null);
      toast.show(result[action], { variant: "success" });
    } catch (err) {
      const fallback = action === "close" ? "Не удалось закрыть агента" : "Не удалось обновить агента";
      toast.error(err instanceof Error ? err.message : fallback);
    } finally {
      setSavingChat(false);
    }
  };

  const openTerminalMenu = (terminalId: string) => {
    setConfirmClosingTerminal(false);
    setTerminalMenuId(terminalId);
  };

  const handleCopyTerminalPath = async (terminal: PaseoTerminal) => {
    try {
      await copyText(terminal.cwd);
      setTerminalMenuId((current) => current === terminal.id ? null : current);
      toast.show("Путь скопирован", { variant: "info" });
    } catch {
      toast.error("Не удалось скопировать путь");
    }
  };

  const handleCloseTerminal = async (terminal: PaseoTerminal) => {
    if (chatMutationPending) return;
    setSavingChat(true);
    try {
      await paseo.terminals.ref(terminal).kill();
      setTerminals((current) => current.filter((item) => item.id !== terminal.id));
      setTerminalMenuId(null);
      toast.show("Терминал закрыт", { variant: "success" });
      void reloadAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось закрыть терминал");
    } finally {
      setSavingChat(false);
    }
  };

  const handleTogglePinChat = async () => {
    if (!editingChat || chatMutationPending) return;
    const chatId = editingChat.id;
    const nextPinned = !serverState.pinnedSessions[chatId];
    setSavingChat(true);
    // Мгновенный локальный отклик закрепления в виджете
    setServerState((prev) => {
      const nextMap = { ...prev.pinnedSessions };
      if (nextPinned) {
        nextMap[chatId] = Date.now();
      } else {
        delete nextMap[chatId];
      }
      return { ...prev, pinnedSessions: nextMap };
    });
    try {
      const updated = await pinSession({
        workspaceId: chatId,
        pinned: nextPinned,
        projectIds: allGroups.map((g) => g.id),
      });
      setServerState(updated);
      setEditingChatId(null);
      toast.show(nextPinned ? "Область закреплена наверху" : "Область откреплена", { variant: "info" });
    } catch (err) {
      await reloadAll();
      toast.error(err instanceof Error ? err.message : "Не удалось изменить закрепление");
    } finally {
      setSavingChat(false);
    }
  };

  const handleArchiveChat = async (chat: PaseoWorkspace) => {
    if (chatMutationPending) return;
    setSavingChat(true);
    try {
      setArchivedIds((prev) => ({ ...prev, [chat.id]: true }));
      const { error } = await paseo.workspaces.archive(chat.id);
      if (error) throw new Error(error);
      if (editingChatId === chat.id) {
        setEditingChatId(null);
      }
      toast.show("Область отправлена в архив", { variant: "success" });
      void reloadAll();
    } catch (err) {
      setArchivedIds((prev) => {
        const copy = { ...prev };
        delete copy[chat.id];
        return copy;
      });
      toast.error(err instanceof Error ? err.message : "Не удалось архивировать область");
    } finally {
      setSavingChat(false);
    }
  };

  const previewAvatar = useMemo(() => {
    if (!editingGroup) return { uri: null, emoji: null, bg: null };
    if (draftAvatarUrl.trim().startsWith("http") || draftAvatarUrl.trim().startsWith("data:image/")) {
      return { uri: draftAvatarUrl.trim(), emoji: null, bg: null };
    }
    if (draftAvatarUpdate.kind === "none") {
      return { uri: null, emoji: null, bg: null };
    }
    if (draftAvatarUpdate.kind === "emoji") {
      return { uri: null, emoji: draftAvatarUpdate.emoji, bg: draftAvatarUpdate.bg };
    }
    if (draftAvatarUpdate.kind === "dataUri") {
      return { uri: draftAvatarUpdate.dataUri, emoji: null, bg: null };
    }
    return {
      uri: editingGroup.resolvedAvatarUri,
      emoji: editingGroup.meta.avatarEmoji,
      bg: editingGroup.meta.avatarBg,
    };
  }, [editingGroup, draftAvatarUpdate, draftAvatarUrl]);

  const { height: windowHeight } = useWindowDimensions();
  const headerMetricsHeight = useMemo(() => {
    let h = layout.compact ? 52 : 46;
    if (serverState.showHostMetrics) h += 40;
    const chromeAndSafeArea = layout.compact ? 90 : 80;
    return h + chromeAndSafeArea;
  }, [layout.compact, serverState.showHostMetrics]);

  const listMaxHeight = Math.max(200, windowHeight - headerMetricsHeight);

  // В Electron шапка сайдбара Paseo лежит в зоне перетаскивания окна (-webkit-app-region: drag).
  // Кнопки там no-drag, а фон и промежутки списка - нет, и на macOS колесо и трекпад над ними
  // уходят окну, а не ScrollView. Снимаем зону перетаскивания со всей панели.
  const rootRef = useRef<View>(null);
  useEffect(() => {
    if (!isWeb) return;
    const node = rootRef.current as unknown as HTMLElement | null;
    node?.style?.setProperty("-webkit-app-region", "no-drag", "important");
  }, [isWeb]);

  // На вебе и в Electron оценка от высоты окна врет: под шапкой у Paseo подвал сайдбара
  // с плагинными строками, его высота зависит от режима окна и настроек. Если список
  // влезает в оценку, но не в реальное место, ScrollView не крутится, а низ режет родитель.
  // Поэтому меряем место от верха списка до подвала сайдбара.
  const listRef = useRef<ScrollView>(null);
  const [measuredMaxHeight, setMeasuredMaxHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!isWeb || collapsed) return;
    const listNode = listRef.current?.getScrollableNode?.() as HTMLElement | undefined;
    if (!listNode) return;
    let sidebar: HTMLElement | null = listNode.parentElement;
    while (sidebar && !sidebar.querySelector('[data-testid="sidebar-footer"]')) {
      sidebar = sidebar.parentElement;
    }
    const footer = sidebar?.querySelector<HTMLElement>('[data-testid="sidebar-footer"]') ?? null;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const sidebarBottom = sidebar
          ? Math.min(sidebar.getBoundingClientRect().bottom, window.innerHeight)
          : window.innerHeight;
        const bottom = sidebarBottom - (footer?.offsetHeight ?? 0);
        const next = Math.max(120, Math.floor(bottom - listNode.getBoundingClientRect().top - 8));
        setMeasuredMaxHeight((prev) => (prev !== null && Math.abs(prev - next) < 2 ? prev : next));
      });
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (footer) observer?.observe(footer);
    if (sidebar) observer?.observe(sidebar);
    const root = rootRef.current as unknown as HTMLElement | null;
    if (root) observer?.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [isWeb, collapsed]);

  return (
    <View ref={rootRef} style={{ marginVertical: 4, paddingHorizontal: 10, gap: 8 }}>
      {/* Полноразмерный заголовок Проекты + кнопка настроек панели + кнопка добавления нового проекта */}
      {/* Строка 1: Заголовок «Штаб» с кнопкой сворачивания */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 2,
          paddingVertical: 2,
        }}
      >
        <Pressable
          accessibilityRole="button"
          onPress={() => setCollapsed((v) => !v)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingVertical: 3,
          }}
        >
          <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={16} color={c.foreground} />
          <Text numberOfLines={1} ellipsizeMode="tail" style={{ color: c.foreground, fontSize: 15, fontWeight: "700" }}>
            {serverState.headerTitle || "Штаб"}
          </Text>
        </Pressable>
      </View>

      {/* Строка 2: Панель кнопок-иконок на строку ниже */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: layout.compact ? 5 : 6,
          paddingHorizontal: 2,
          paddingBottom: 2,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Лимиты и расход"
          onPress={() => {
            try {
              openScreen({ screenId: "limits" });
            } catch {
              openUsageLimits(host?.id);
            }
          }}
          style={({ pressed }) => ({
            flex: 1,
            height: layout.compact ? 34 : 28,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.surface2,
            borderWidth: 1,
            borderColor: c.border,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <Icon name="Gauge" size={14} color={c.foregroundMuted} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Репозитории Git"
          onPress={() => {
            openScreen({ screenId: "git-workspace" });
          }}
          style={({ pressed }) => ({
            flex: 1,
            height: layout.compact ? 34 : 28,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.surface2,
            borderWidth: 1,
            borderColor: c.border,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <Icon name="FolderGit2" size={14} color={c.foregroundMuted} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Службы"
          onPress={() => {
            openScreen({ screenId: "services" });
          }}
          style={({ pressed }) => ({
            flex: 1,
            height: layout.compact ? 34 : 28,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.surface2,
            borderWidth: 1,
            borderColor: c.border,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <Icon name="Server" size={14} color={c.foregroundMuted} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Артефакты"
          onPress={() => {
            openScreen({ screenId: "artifacts" });
          }}
          style={({ pressed }) => ({
            flex: 1,
            height: layout.compact ? 34 : 28,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.surface2,
            borderWidth: 1,
            borderColor: c.border,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <Icon name="Layers" size={14} color={c.foregroundMuted} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Команда и задачи"
          onPress={() => {
            openScreen({ screenId: "team" });
          }}
          style={({ pressed }) => ({
            flex: 1,
            height: layout.compact ? 34 : 28,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.surface2,
            borderWidth: 1,
            borderColor: c.border,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <Icon name="Users" size={14} color={c.foregroundMuted} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Настройки штаба"
          onPress={openPanelSettings}
          style={({ pressed }) => ({
            flex: 1,
            height: layout.compact ? 34 : 28,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.surface2,
            borderWidth: 1,
            borderColor: c.border,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <Icon name="SlidersHorizontal" size={14} color={c.foregroundMuted} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Добавить проект"
          onPress={() => void openAddProjectModal()}
          style={({ pressed }) => ({
            flex: 1,
            height: layout.compact ? 34 : 28,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.surface2,
            borderWidth: 1,
            borderColor: c.border,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <Icon name="FolderPlus" size={15} color={c.accent} />
        </Pressable>
      </View>

      {/* Компактная полоска нагрузки хоста (CPU, ОЗУ, сеть, диск) с всплывающей шторкой */}
      {serverState.showHostMetrics ? (
        <HostMetricsBar
          theme={theme}
          openPopover={openPopover}
          enabled={serverState.showHostMetrics}
        />
      ) : null}

      {/* Раскрывающийся список проектов и областей */}
      {!collapsed ? (
        <ScrollView
          ref={listRef}
          style={{
            maxHeight: measuredMaxHeight ?? listMaxHeight,
          }}
          contentContainerStyle={{
            gap: 7,
            // На телефоне низ списка уходит под подвал сайдбара и home indicator
            paddingBottom: layout.compact ? 120 : 24,
          }}
          nestedScrollEnabled={true}
          showsVerticalScrollIndicator={true}
          keyboardShouldPersistTaps="handled"
        >
          {visibleGroups.map((group, idx) => {
            const isOpen = isProjectOpen(group.id, idx === 0);
            const busy = creatingId === group.id;
            const showAll = Boolean(expandedAllChats[group.id]);
            const displayedChats = showAll ? group.chats : group.chats.slice(0, 8);
            const moreCount = group.chats.length - displayedChats.length;

            return (
              <View
                key={group.id}
                style={{
                  borderRadius: 11,
                  backgroundColor: c.surface1,
                  borderWidth: 1,
                  borderColor: isOpen ? c.accent : c.border,
                  overflow: "hidden",
                  opacity: group.meta.hidden ? 0.65 : 1,
                }}
              >
                {/* Строка проекта: аватарка + название + настройки рядом с плюсом */}
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingLeft: 10,
                    paddingRight: 8,
                    paddingVertical: 8,
                    gap: 6,
                  }}
                >
                  <ProjectHeaderPressable
                    group={group}
                    isOpen={isOpen}
                    onToggleOpen={() => toggleProjectOpen(group.id, idx === 0)}
                    theme={theme}
                    layout={layout}
                    relativeTime={relativeTime}
                  />

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Настройки проекта ${group.name}`}
                    hitSlop={4}
                    onPress={() => openProjectSettings(group)}
                    style={({ pressed }) => ({
                      width: btnSize,
                      height: btnSize,
                      borderRadius: 9,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: c.surface2,
                      borderWidth: 1,
                      borderColor: c.border,
                      opacity: pressed ? 0.7 : 1,
                    })}
                  >
                    <Icon name="SlidersHorizontal" size={15} color={c.foregroundMuted} />
                  </Pressable>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Новая область в проекте ${group.name}`}
                    disabled={busy}
                    onPress={() => openNewArea(group)}
                    style={({ pressed }) => ({
                      width: btnSize,
                      height: btnSize,
                      borderRadius: 9,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: c.accent,
                      opacity: busy ? 0.5 : pressed ? 0.8 : 1,
                    })}
                  >
                    <Icon name="Plus" size={18} color="#FFFFFF" />
                  </Pressable>
                </View>

                {/* Строки областей внутри раскрытого проекта */}
                {isOpen && group.chats.length > 0 ? (
                  <View
                    style={{
                      borderTopWidth: 1,
                      borderTopColor: c.border,
                      paddingVertical: 6,
                      paddingHorizontal: 7,
                      gap: 4,
                    }}
                  >
                    {displayedChats.map((chat) => {
                      const isPinned = Boolean(serverState.pinnedSessions[chat.id]);
                      const title = chatTitle(chat, latestAgentByWorkspace[chat.id]);
                      const expanded = Boolean(expandedAreaIds[chat.id]);
                      const sessions = agentsByWorkspace.get(chat.id) ?? [];
                      const areaTerminals = terminals.filter((terminal) => terminal.workspaceId === chat.id);

                      return (
                        <View key={chat.id}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Сессии области ${title}`}
                              aria-expanded={expanded}
                              onPress={() => setExpandedAreaIds((prev) => ({ ...prev, [chat.id]: !prev[chat.id] }))}
                              style={({ pressed }) => ({
                                flex: 1, minWidth: 0, minHeight: 42, flexDirection: "row", alignItems: "center",
                                gap: 7, paddingHorizontal: 7, paddingVertical: 6, borderRadius: 8,
                                backgroundColor: pressed ? c.surface2 : undefined,
                              })}
                            >
                              <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={18}
                                color={c.foregroundMuted} />
                              <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                                <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
                                  {title}
                                </Text>
                                {!expanded ? (
                                  <AreaSessionBadges sessions={sessions} terminalCount={areaTerminals.length}
                                    theme={theme} platform={layout.platform} />
                                ) : null}
                              </View>
                              {isPinned ? <Icon name="Pin" size={12} color={c.accent} /> : null}
                            </Pressable>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Действия области ${title}`}
                              onPress={() => openAreaActions(chat)}
                              style={({ pressed }) => ({
                                width: btnSize, height: btnSize, borderRadius: 8,
                                alignItems: "center", justifyContent: "center",
                                backgroundColor: pressed ? c.surface2 : undefined,
                              })}
                            >
                              <Icon name="LayoutGrid" size={16} color={c.foreground} />
                            </Pressable>
                          </View>
                          {expanded ? (
                            <View style={{
                              marginLeft: 20 - SESSION_STATUS_SIZE / 2,
                              marginBottom: 4, paddingRight: 3, gap: 2,
                            }}>
                              {sessions.map(({ agent }) => (
                                <View key={agent.id} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                                  <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={`Открыть агента ${agentTitle(agent)}`}
                                    onPress={() => jumpToAgent(agent.id)}
                                    style={({ pressed }) => ({
                                      flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center",
                                      paddingRight: 10, paddingVertical: 5, minHeight: 44, borderRadius: 8,
                                      backgroundColor: pressed ? c.surface2 : undefined,
                                    })}
                                  >
                                    <AgentSummary agent={agent} theme={theme} platform={layout.platform} gap={NESTED_ITEM_GAP} />
                                  </Pressable>
                                  <ChatActionButton
                                    label={`Меню агента ${agentTitle(agent)}`}
                                    icon="MoreHorizontal"
                                    quiet
                                    disabled={chatMutationPending}
                                    onPress={() => openAgentMenu(agent.id)}
                                    theme={theme}
                                  />
                                </View>
                              ))}
                              {areaTerminals.map((terminal) => (
                                <TerminalRow key={terminal.id} terminal={terminal} theme={theme}
                                  nested
                                  disabled={chatMutationPending}
                                  onMenu={() => openTerminalMenu(terminal.id)}
                                  onOpen={() => openAreaTerminal(terminal)} />
                              ))}
                              {terminalListFailed || (!sessions.length && !areaTerminals.length) ? (
                                <Text style={{ padding: 8, color: c.foregroundMuted, fontSize: 12 }}>
                                  {terminalListFailed ? "Не удалось загрузить терминалы" : "Нет сессий"}
                                </Text>
                              ) : null}
                            </View>
                          ) : null}
                        </View>
                      );
                    })}

                    {moreCount > 0 ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() =>
                          setExpandedAllChats((prev) => ({ ...prev, [group.id]: true }))
                        }
                        style={{ paddingVertical: 7, paddingHorizontal: 8, alignItems: "center" }}
                      >
                        <Text style={{ color: c.accent, fontSize: 13, fontWeight: "600" }}>
                          Показать еще {moreCount}
                        </Text>
                      </Pressable>
                    ) : showAll && group.chats.length > 8 ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() =>
                          setExpandedAllChats((prev) => ({ ...prev, [group.id]: false }))
                        }
                        style={{ paddingVertical: 7, paddingHorizontal: 8, alignItems: "center" }}
                      >
                        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Свернуть список</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}

          {hiddenCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setShowHiddenProjects((v) => !v)}
              style={{ paddingVertical: 5, alignItems: "center" }}
            >
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                {showHiddenProjects ? "Скрыть спрятанные проекты" : `Скрытые проекты: ${hiddenCount}`}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      ) : null}

      {/* Модальное окно добавления проекта */}
      <Modal
        title="Добавить проект"
        open={addModalOpen}
        onOpenChange={(open) => {
          if (!open) setAddModalOpen(false);
        }}
      >
        <Modal.Content>
          <View style={{ gap: 16 }}>
            <View
              style={{
                flexDirection: "row",
                padding: 4,
                borderRadius: 10,
                backgroundColor: c.surface2,
                borderWidth: 1,
                borderColor: c.border,
                gap: 4,
              }}
            >
              {(
                [
                  { id: "existing", label: "Папка на сервере" },
                  { id: "create", label: "Новая папка" },
                  { id: "clone", label: "Git-клон" },
                ] as const
              ).map((tab) => {
                const active = addMode === tab.id;
                return (
                  <Pressable
                    key={tab.id}
                    accessibilityRole="button"
                    onPress={() => setAddMode(tab.id)}
                    style={{
                      flex: 1,
                      paddingVertical: 8,
                      paddingHorizontal: 6,
                      borderRadius: 7,
                      alignItems: "center",
                      backgroundColor: active ? c.surface1 : undefined,
                      borderWidth: active ? 1 : 0,
                      borderColor: c.border,
                    }}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        color: active ? c.foreground : c.foregroundMuted,
                        fontSize: 12,
                        fontWeight: active ? "700" : "500",
                      }}
                    >
                      {tab.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={{ gap: 6 }}>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                Название в списке (необязательно - по умолчанию имя папки)
              </Text>
              <TextInput
                value={addCustomName}
                onChangeText={setAddCustomName}
                placeholder="Например: Мой сервис"
                placeholderTextColor={c.foregroundMuted}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  borderRadius: 9,
                  backgroundColor: c.surface2,
                  borderWidth: 1,
                  borderColor: c.border,
                  color: c.foreground,
                  fontSize: 14,
                }}
              />
            </View>

            {addMode === "existing" ? (
              <View style={{ gap: 14 }}>
                {candidates.length > 0 ? (
                  <View style={{ gap: 8 }}>
                    <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>
                      Готовые репозитории в ~/repos (в 1 нажатие)
                    </Text>
                    {candidates.length > 5 ? (
                      <TextInput
                        value={candidateFilter}
                        onChangeText={setCandidateFilter}
                        placeholder="Поиск по названию папки..."
                        placeholderTextColor={c.foregroundMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={{
                          paddingHorizontal: 12,
                          paddingVertical: 9,
                          borderRadius: 9,
                          backgroundColor: c.surface2,
                          borderWidth: 1,
                          borderColor: c.border,
                          color: c.foreground,
                          fontSize: 13,
                        }}
                      />
                    ) : null}
                    <View
                      style={{
                        borderRadius: 11,
                        backgroundColor: c.surface2,
                        borderWidth: 1,
                        borderColor: c.border,
                        overflow: "hidden",
                      }}
                    >
                      {filteredCandidates.slice(0, 12).map((dir, idx) => (
                        <View key={dir.path}>
                          {idx > 0 ? <View style={{ height: 1, backgroundColor: c.border }} /> : null}
                          <Pressable
                            accessibilityRole="button"
                            disabled={addingProject}
                            onPress={() => void handleQuickAddCandidate(dir)}
                            style={({ pressed }) => ({
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 10,
                              paddingHorizontal: 12,
                              paddingVertical: 11,
                              backgroundColor: pressed ? c.surface1 : undefined,
                            })}
                          >
                            <Icon
                              name={dir.isGit ? "GitBranch" : "Folder"}
                              size={16}
                              color={dir.isGit ? c.accent : c.foregroundMuted}
                            />
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
                                {dir.name}
                              </Text>
                              <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11 }}>
                                {dir.path}
                              </Text>
                            </View>
                            <View
                              style={{
                                paddingHorizontal: 10,
                                paddingVertical: 5,
                                borderRadius: 7,
                                backgroundColor: c.accent,
                              }}
                            >
                              <Text style={{ color: "#FFFFFF", fontSize: 12, fontWeight: "600" }}>
                                Добавить
                              </Text>
                            </View>
                          </Pressable>
                        </View>
                      ))}
                    </View>
                  </View>
                ) : null}

                <View style={{ gap: 6 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                    Или укажите любой путь к папке на сервере вручную:
                  </Text>
                  <TextInput
                    value={manualPath}
                    onChangeText={setManualPath}
                    placeholder="~/repos/my-project"
                    placeholderTextColor={c.foregroundMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderRadius: 9,
                      backgroundColor: c.surface2,
                      borderWidth: 1,
                      borderColor: c.border,
                      color: c.foreground,
                      fontSize: 14,
                    }}
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={addingProject || !manualPath.trim()}
                    onPress={() => void handleSubmitAddProject()}
                    style={({ pressed }) => ({
                      marginTop: 4,
                      paddingVertical: 12,
                      borderRadius: 10,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: c.accent,
                      opacity: addingProject || !manualPath.trim() ? 0.45 : pressed ? 0.85 : 1,
                    })}
                  >
                    <Text style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "700" }}>
                      {addingProject ? "Добавление..." : "Добавить по пути"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {addMode === "create" ? (
              <View style={{ gap: 12 }}>
                <View style={{ gap: 6 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Имя новой папки</Text>
                  <TextInput
                    value={newFolderName}
                    onChangeText={setNewFolderName}
                    placeholder="my-new-project"
                    placeholderTextColor={c.foregroundMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderRadius: 9,
                      backgroundColor: c.surface2,
                      borderWidth: 1,
                      borderColor: c.border,
                      color: c.foreground,
                      fontSize: 14,
                    }}
                  />
                </View>

                <View style={{ gap: 6 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Родительский каталог</Text>
                  <TextInput
                    value={parentPath}
                    onChangeText={setParentPath}
                    placeholder="~/repos"
                    placeholderTextColor={c.foregroundMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderRadius: 9,
                      backgroundColor: c.surface2,
                      borderWidth: 1,
                      borderColor: c.border,
                      color: c.foreground,
                      fontSize: 14,
                    }}
                  />
                </View>

                <View
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    backgroundColor: c.surface2,
                    borderWidth: 1,
                    borderColor: c.border,
                  }}
                >
                  <SettingsSwitch
                    label="Инициализировать Git-репозиторий"
                    hint="Выполнить git init в созданной папке"
                    value={initGit}
                    onValueChange={setInitGit}
                  />
                </View>

                <Pressable
                  accessibilityRole="button"
                  disabled={addingProject || !newFolderName.trim()}
                  onPress={() => void handleSubmitAddProject()}
                  style={({ pressed }) => ({
                    paddingVertical: 13,
                    borderRadius: 10,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: c.accent,
                    opacity: addingProject || !newFolderName.trim() ? 0.45 : pressed ? 0.85 : 1,
                  })}
                >
                  <Text style={{ color: "#FFFFFF", fontSize: 15, fontWeight: "700" }}>
                    {addingProject ? "Создание..." : "Создать и добавить проект"}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {addMode === "clone" ? (
              <View style={{ gap: 12 }}>
                <View style={{ gap: 6 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                    URL репозитория (SSH, HTTPS или owner/repo с GitHub)
                  </Text>
                  <TextInput
                    value={cloneRepoUrl}
                    onChangeText={setCloneRepoUrl}
                    placeholder="git@github.com:org/repo.git или owner/repo"
                    placeholderTextColor={c.foregroundMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderRadius: 9,
                      backgroundColor: c.surface2,
                      borderWidth: 1,
                      borderColor: c.border,
                      color: c.foreground,
                      fontSize: 14,
                    }}
                  />
                </View>

                <View style={{ gap: 6 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                    Имя папки (необязательно - определится из URL)
                  </Text>
                  <TextInput
                    value={newFolderName}
                    onChangeText={setNewFolderName}
                    placeholder="repo"
                    placeholderTextColor={c.foregroundMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderRadius: 9,
                      backgroundColor: c.surface2,
                      borderWidth: 1,
                      borderColor: c.border,
                      color: c.foreground,
                      fontSize: 14,
                    }}
                  />
                </View>

                <View style={{ gap: 6 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Куда клонировать</Text>
                  <TextInput
                    value={parentPath}
                    onChangeText={setParentPath}
                    placeholder="~/repos"
                    placeholderTextColor={c.foregroundMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderRadius: 9,
                      backgroundColor: c.surface2,
                      borderWidth: 1,
                      borderColor: c.border,
                      color: c.foreground,
                      fontSize: 14,
                    }}
                  />
                </View>

                <Pressable
                  accessibilityRole="button"
                  disabled={addingProject || !cloneRepoUrl.trim()}
                  onPress={() => void handleSubmitAddProject()}
                  style={({ pressed }) => ({
                    paddingVertical: 13,
                    borderRadius: 10,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: c.accent,
                    opacity: addingProject || !cloneRepoUrl.trim() ? 0.45 : pressed ? 0.85 : 1,
                  })}
                >
                  <Text style={{ color: "#FFFFFF", fontSize: 15, fontWeight: "700" }}>
                    {addingProject ? "Клонирование..." : "Склонировать и добавить"}
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </Modal.Content>
      </Modal>

      {/* Модальное окно настроек проекта */}
      <Modal
        title={editingGroup ? `Проект: ${editingGroup.name}` : "Настройки проекта"}
        open={Boolean(editingGroup)}
        onOpenChange={(open) => {
          if (!open) {
            setEditingProjectId(null);
            setConfirmRemoveProject(false);
          }
        }}
      >
        <Modal.Content>
          {editingGroup ? (
            <View style={{ gap: 18 }}>
              <SettingsSection title="Аватарка проекта (без ограничений размера и пропорций)">
                <View
                  style={{
                    padding: 12,
                    borderRadius: 12,
                    backgroundColor: c.surface2,
                    borderWidth: 1,
                    borderColor: c.border,
                    gap: 12,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                    <ProjectAvatar
                      name={draftProjectName || editingGroup.name}
                      projectId={editingGroup.id}
                      avatarUri={previewAvatar.uri}
                      emoji={previewAvatar.emoji}
                      bg={previewAvatar.bg}
                      size={54}
                    />
                    <View style={{ flex: 1, gap: 6 }}>
                      <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>
                        Любая картинка, пропорции и размер
                      </Text>
                      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                        Не требуется квадрат 1024x1024 - прямоугольные фото и большие PNG/JPG/WebP/SVG кадрируются автоматически.
                      </Text>
                    </View>
                  </View>

                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {isWeb ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => void handlePickWebFile()}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 6,
                          paddingHorizontal: 12,
                          paddingVertical: 9,
                          borderRadius: 9,
                          backgroundColor: c.accent,
                        }}
                      >
                        <Icon name="Upload" size={14} color="#FFFFFF" />
                        <Text style={{ color: "#FFFFFF", fontSize: 13, fontWeight: "600" }}>
                          Загрузить с устройства
                        </Text>
                      </Pressable>
                    ) : null}

                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        setDraftAvatarUrl("");
                        setDraftAvatarUpdate({ kind: "none" });
                      }}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 6,
                        paddingHorizontal: 12,
                        paddingVertical: 9,
                        borderRadius: 9,
                        backgroundColor: c.surface1,
                        borderWidth: 1,
                        borderColor: c.border,
                      }}
                    >
                      <Icon name="RotateCcw" size={14} color={c.foregroundMuted} />
                      <Text style={{ color: c.foreground, fontSize: 13 }}>Сбросить</Text>
                    </Pressable>
                  </View>

                  <View style={{ gap: 6 }}>
                    <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                      Ссылка на картинку (https://...) или локальный путь к файлу (~/...):
                    </Text>
                    <TextInput
                      value={draftAvatarUrl}
                      onChangeText={setDraftAvatarUrl}
                      placeholder="https://... или ~/icon.png"
                      placeholderTextColor={c.foregroundMuted}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        borderRadius: 9,
                        backgroundColor: c.surface1,
                        borderWidth: 1,
                        borderColor: c.border,
                        color: c.foreground,
                        fontSize: 14,
                      }}
                    />
                  </View>

                  <View style={{ gap: 8 }}>
                    <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                      Или быстрый значок и цвет фона:
                    </Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      {EMOJI_PRESETS.map((em) => {
                        const selected = previewAvatar.emoji === em && !previewAvatar.uri;
                        return (
                          <Pressable
                            key={em}
                            accessibilityRole="button"
                            onPress={() => {
                              setDraftAvatarUrl("");
                              setDraftAvatarUpdate({
                                kind: "emoji",
                                emoji: em,
                                bg: previewAvatar.bg || hashColor(editingGroup.id),
                              });
                            }}
                            style={{
                              width: 36,
                              height: 36,
                              borderRadius: 9,
                              alignItems: "center",
                              justifyContent: "center",
                              backgroundColor: c.surface1,
                              borderWidth: selected ? 2 : 1,
                              borderColor: selected ? c.accent : c.border,
                            }}
                          >
                            <Text style={{ fontSize: 18 }}>{em}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {COLOR_PRESETS.map((col) => {
                        const selected = (previewAvatar.bg || hashColor(editingGroup.id)) === col && !previewAvatar.uri;
                        return (
                          <Pressable
                            key={col}
                            accessibilityRole="button"
                            onPress={() => {
                              setDraftAvatarUrl("");
                              setDraftAvatarUpdate({
                                kind: "emoji",
                                emoji: previewAvatar.emoji || monogram(draftProjectName || editingGroup.name),
                                bg: col,
                              });
                            }}
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 14,
                              backgroundColor: col,
                              borderWidth: selected ? 2.5 : 0,
                              borderColor: c.foreground,
                            }}
                          />
                        );
                      })}
                    </View>
                  </View>
                </View>
              </SettingsSection>

              <SettingsSection title="Основное">
                <View
                  style={{
                    padding: 12,
                    borderRadius: 12,
                    backgroundColor: c.surface2,
                    borderWidth: 1,
                    borderColor: c.border,
                    gap: 8,
                  }}
                >
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Название проекта</Text>
                  <TextInput
                    value={draftProjectName}
                    onChangeText={setDraftProjectName}
                    placeholder={editingGroup.rootPath.split("/").pop() || "Проект"}
                    placeholderTextColor={c.foregroundMuted}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderRadius: 9,
                      backgroundColor: c.surface1,
                      borderWidth: 1,
                      borderColor: c.border,
                      color: c.foreground,
                      fontSize: 14,
                    }}
                  />
                  <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11 }}>
                    Папка: {editingGroup.rootPath}
                  </Text>
                </View>
              </SettingsSection>

              <SettingsSection title="Поведение проекта">
                <View
                  style={{
                    padding: 12,
                    borderRadius: 12,
                    backgroundColor: c.surface2,
                    borderWidth: 1,
                    borderColor: c.border,
                    gap: 10,
                  }}
                >
                  <SettingsSelect
                    label="Рабочая папка новой области"
                    hint="Выберите общую папку репозитория или изолированный git worktree"
                    value={draftNewMode}
                    options={[
                      { label: "В папке проекта", value: "directory" },
                      { label: "В отдельном worktree", value: "worktree" },
                    ]}
                    onValueChange={(v) => setDraftNewMode(v)}
                  />
                  <SettingsSwitch
                    label="Закрепить проект наверху"
                    hint="Закрепленные проекты показываются выше остальных"
                    value={draftPinned}
                    onValueChange={setDraftPinned}
                  />
                  <SettingsSwitch
                    label="Скрыть проект из основного списка"
                    hint="Редкие проекты можно убрать под кнопку внизу списка"
                    value={draftHidden}
                    onValueChange={setDraftHidden}
                  />
                </View>
              </SettingsSection>

              <Pressable
                accessibilityRole="button"
                disabled={savingProject}
                onPress={() => void handleSaveProjectSettings()}
                style={({ pressed }) => ({
                  paddingVertical: 13,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: c.accent,
                  opacity: savingProject ? 0.5 : pressed ? 0.85 : 1,
                })}
              >
                <Text style={{ color: "#FFFFFF", fontSize: 15, fontWeight: "700" }}>
                  {savingProject ? "Сохранение..." : "Сохранить настройки"}
                </Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                disabled={savingProject}
                onPress={() => void handleRemoveProject()}
                style={({ pressed }) => ({
                  paddingVertical: 11,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: confirmRemoveProject ? c.statusDanger : c.surface2,
                  borderWidth: 1,
                  borderColor: confirmRemoveProject ? c.statusDanger : c.border,
                  opacity: savingProject ? 0.5 : pressed ? 0.8 : 1,
                })}
              >
                <Text
                  style={{
                    color: confirmRemoveProject ? "#FFFFFF" : c.statusDanger,
                    fontSize: 13,
                    fontWeight: "600",
                  }}
                >
                  {confirmRemoveProject
                    ? "Нажмите еще раз, чтобы убрать проект из Paseo (файлы останутся)"
                    : "Убрать проект из списка Paseo"}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </Modal.Content>
      </Modal>

      <Modal title="Новая область" open={Boolean(newArea)} onOpenChange={(open) => {
        if (!open && !creatingId) setNewArea(null);
      }}>
        <Modal.Content>
          {newArea ? (
            <View style={{ gap: 14 }}>
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Название области</Text>
              <TextInput
                accessibilityLabel="Название новой области"
                value={newArea.name}
                editable={!creatingId && !newArea.workspaceId}
                onChangeText={(name) => setNewArea({ ...newArea, name })}
                style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8,
                  color: c.foreground, backgroundColor: c.surface1, padding: 10 }}
              />
              <SettingsSelect<"session" | "terminal">
                label="Открыть в новой области"
                value={newArea.firstTab}
                options={[{ value: "session", label: "Агент" }, { value: "terminal", label: "Терминал" }]}
                disabled={Boolean(creatingId || newArea.workspaceId)}
                onValueChange={(firstTab) => setNewArea({ ...newArea, firstTab })}
              />
              {newArea.firstTab === "session" ? (
                <View style={{ gap: 7 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Модель нового агента</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ flex: 1, color: c.foreground, fontSize: 13 }} numberOfLines={1}>
                      {newAgentModel ?? newAgentModelsError ?? "Загружаю модели..."}
                    </Text>
                    <TitleModelPicker theme={theme} options={titleModelOptions(newAgentModels, "first_line").filter(option => option.provider)}
                      value={newAgentModel ?? ""} disabled={!newAgentModel || Boolean(creatingId)}
                      label="Выбрать модель нового агента" icon="ChevronDown" menuLabel="Модели нового агента"
                      onValueChange={setNewAgentModel} />
                  </View>
                </View>
              ) : null}
              <Pressable
                accessibilityRole="button"
                disabled={Boolean(creatingId || (newArea.firstTab === "session" && !newAgentModel))}
                onPress={() => void createNewArea()}
                style={({ pressed }) => ({
                  padding: 11, alignItems: "center", borderRadius: 8, backgroundColor: c.accent,
                  opacity: creatingId || (newArea.firstTab === "session" && !newAgentModel) || pressed ? 0.7 : 1,
                })}
              >
                <Text style={{ color: c.accentForeground, fontSize: 14, fontWeight: "600" }}>
                  {creatingId ? "Создаю…" : newArea.workspaceId ? "Создать терминал" : "Создать область"}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </Modal.Content>
      </Modal>

      <Modal
        title="Функционал области"
        open={Boolean(editingChat)}
        onOpenChange={(open) => {
          if (!open) {
            handleRenameChat();
            setEditingChatId(null);
            updateDraftChatTitle(null);
          }
        }}
      >
        <Modal.Content>
          {editingChat ? (
            <View style={{ gap: 16 }} onTouchStart={() => areaTitleInput.current?.blur()}>
              <View style={{ gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View style={{
                    flex: 1, minWidth: 0, height: 44, flexDirection: "row", alignItems: "center",
                    paddingLeft: 12, paddingRight: 4, borderRadius: 9, borderWidth: 1,
                    borderColor: draftChatTitle === null ? c.border : c.accent,
                    backgroundColor: c.surface2,
                  }}>
                    <TextInput
                      ref={areaTitleInput}
                      accessibilityLabel="Название области"
                      onTouchStart={event => event.stopPropagation()}
                      value={draftChatTitle ?? editingAreaTitle}
                      onChangeText={updateDraftChatTitle}
                      onFocus={() => {
                        if (draftChatTitle === null) updateDraftChatTitle(editingAreaTitle);
                      }}
                      selection={draftTitleSelection}
                      onSelectionChange={({ nativeEvent: { selection } }) => {
                        if (selection.start === draftTitleSelection?.start && selection.end === draftTitleSelection.end) {
                          setDraftTitleSelection(undefined);
                        }
                      }}
                      onBlur={handleRenameChat}
                      placeholder="Новая область"
                      placeholderTextColor={c.foregroundMuted}
                      editable={!chatMutationPending}
                      style={{ flex: 1, minWidth: 0, padding: 0, outlineWidth: 0, color: c.foreground, fontSize: 15 }}
                    />
                  </View>
                  <TitleModelPicker
                    theme={theme}
                    value={titleModel}
                    options={titleModelOptions(titleProviders, titleModel)}
                    disabled={!canSuggestTitle}
                    pending={suggestingTitle}
                    hint={titleModelsError ? `Не удалось загрузить модели: ${titleModelsError}` : undefined}
                    onValueChange={(model) => void handleSuggestTitle(model)}
                  />
                </View>

              </View>
              <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
                <ChatActionButton
                  label="Новый агент"
                  icon="Plus"
                  disabled={chatMutationPending || Boolean(creatingAreaIds[editingChat.id])}
                  onPress={() => openNewAreaAgent(editingChat.id)}
                  theme={theme}
                />
                <ChatActionButton
                  label="Новый терминал"
                  icon="Terminal"
                  disabled={chatMutationPending || Boolean(creatingTerminalId)}
                  onPress={() => void handleCreateAreaTerminal(editingChat.id)}
                  theme={theme}
                />
                <ChatActionButton
                  label={editingChatPinned ? "Открепить область" : "Закрепить область"}
                  icon={editingChatPinned ? "PinOff" : "Pin"}
                  color={editingChatPinned ? c.accent : undefined}
                  disabled={chatMutationPending}
                  onPress={() => void handleTogglePinChat()}
                  theme={theme}
                />
                <ChatActionButton
                  label="Скопировать путь к папке проекта"
                  icon="Folders"
                  onPress={() => {
                    const path = currentProjectGroup?.rootPath || editingChat.workspaceDirectory;
                    void copyText(path)
                      .then(() => toast.show("Путь скопирован", { variant: "info" }))
                      .catch(() => toast.error("Не удалось скопировать путь"));
                  }}
                  theme={theme}
                />
                {editingChat.projectKind === "git" ? (
                  <ChatActionButton
                    label="Настройки области"
                    icon="Settings"
                    disabled={chatMutationPending}
                    onPress={() => setAreaSettingsPanel("branch")}
                    theme={theme}
                  />
                ) : null}
                <ChatActionButton
                  label="Перенести в проект"
                  icon="ArrowRightLeft"
                  disabled={chatMutationPending}
                  onPress={() => setChatTransferOpen(true)}
                  theme={theme}
                />
                <ChatActionButton
                  label="Архивировать область"
                  icon="Archive"
                  color={c.statusDanger}
                  disabled={chatMutationPending}
                  onPress={() => void handleArchiveChat(editingChat)}
                  theme={theme}
                />
              </View>

              <View
                style={{
                  borderRadius: 12,
                  backgroundColor: c.surface2,
                  borderWidth: 1,
                  borderColor: c.border,
                  padding: 12,
                  gap: 10,
                }}
              >
                <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>Сессии</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {AREA_SESSION_FILTERS.map(({ value, label }) => {
                    const selected = areaSessionFilter === value;
                    return (
                      <Pressable
                        key={value}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        onPress={() => setAreaSessionFilter(value)}
                        style={({ pressed }) => ({
                          minHeight: 34, paddingHorizontal: 12, borderRadius: 17,
                          borderWidth: 1, borderColor: selected ? c.accent : c.border,
                          justifyContent: "center", backgroundColor: selected ? c.accent : c.surface1,
                          opacity: pressed ? 0.75 : 1,
                        })}
                      >
                        <Text style={{ color: selected ? c.accentForeground : c.foreground, fontSize: 12 }}>
                          {label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {visibleAreaAgents.map((entry) => {
                  const ag = entry.agent;
                  const agTitle = agentTitle(ag);
                  const isCurrent = editingChatAgent?.id === ag.id;
                  return (
                    <View
                      key={ag.id}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        paddingRight: 10,
                        borderRadius: 8,
                        backgroundColor: c.surface1,
                        borderWidth: 1,
                        borderColor: isCurrent ? c.accent : c.border,
                      }}
                    >
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Открыть агента ${agTitle}`}
                        onPress={() => {
                          setEditingChatId(null);
                          jumpToAgent(ag.id);
                        }}
                        style={({ pressed }) => ({
                          flex: 1,
                          minWidth: 0,
                          minHeight: 44,
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 6,
                          paddingHorizontal: 10,
                          paddingVertical: 8,
                          opacity: pressed ? 0.7 : 1,
                        })}
                      >
                        <AgentSummary
                          agent={ag}
                          branch={areaSettings?.launchBranches[ag.id]}
                          theme={theme}
                          platform={layout.platform}
                        />
                        <Icon name="ChevronRight" size={14} color={c.foregroundMuted} />
                      </Pressable>
                      <ChatActionButton
                        label={`Меню агента ${agTitle}`}
                        icon="MoreHorizontal"
                        disabled={chatMutationPending}
                        quiet
                        onPress={() => openAgentMenu(ag.id)}
                        theme={theme}
                      />
                    </View>
                  );
                })}
                {visibleAreaTerminals.map((terminal) => (
                  <TerminalRow key={terminal.id} terminal={terminal} theme={theme}
                    disabled={chatMutationPending}
                    onMenu={() => openTerminalMenu(terminal.id)}
                    onOpen={() => {
                      setEditingChatId(null);
                      openAreaTerminal(terminal);
                    }} />
                ))}
                {terminalListFailed && areaSessionFilter !== "agents" ? (
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Не удалось загрузить терминалы</Text>
                ) : !visibleAreaAgents.length && !visibleAreaTerminals.length ? (
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                    {areaSessionFilter === "agents" ? "Нет агентов" : areaSessionFilter === "terminals" ? "Нет терминалов" : "Нет открытых сессий"}
                  </Text>
                ) : null}
              </View>
              {closedAgents.data?.length || closedAgents.isError ? (
                <View style={{ padding: 12, gap: 8, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 }}>
                  <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>Закрытые сессии</Text>
                  {closedAgents.isError ? (
                    <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Не удалось загрузить историю агентов</Text>
                  ) : null}
                  {closedAgents.data?.map((agent) => (
                    <Pressable
                      key={agent.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Открыть закрытого агента ${agentTitle(agent)}`}
                      onPress={() => {
                        setEditingChatId(null);
                        jumpToAgent(agent.id);
                      }}
                      style={({ pressed }) => ({
                        minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8,
                        paddingHorizontal: 10, borderRadius: 8,
                        backgroundColor: pressed ? c.surface2 : c.surface1,
                      })}
                    >
                      <Icon name="Bot" size={15} color={c.foregroundMuted} />
                      <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 13 }}>
                        {agentTitle(agent)}
                      </Text>
                      <Icon name="ChevronRight" size={14} color={c.foregroundMuted} />
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </Modal.Content>
      </Modal>

      <Modal title="Новый агент" open={Boolean(newAgentWorkspaceId)} onOpenChange={(open) => {
        if (!open && !Object.values(creatingAreaIds).some(Boolean)) setNewAgentWorkspaceId(null);
      }}>
        <Modal.Content>
          <View style={{ gap: 14 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Модель нового агента</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ flex: 1, color: c.foreground, fontSize: 13 }} numberOfLines={1}>
                {newAgentModel ?? newAgentModelsError ?? "Загружаю модели..."}
              </Text>
              <TitleModelPicker theme={theme} options={titleModelOptions(newAgentModels, "first_line").filter(option => option.provider)}
                value={newAgentModel ?? ""} disabled={!newAgentModel || Object.values(creatingAreaIds).some(Boolean)}
                label="Выбрать модель нового агента" icon="ChevronDown" menuLabel="Модели нового агента"
                onValueChange={setNewAgentModel} />
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Создать агента с выбранной моделью"
              disabled={!newAgentModel || Object.values(creatingAreaIds).some(Boolean)}
              onPress={() => { if (newAgentWorkspaceId) void handleCreateAreaSession(newAgentWorkspaceId); }}
              style={({ pressed }) => ({ padding: 11, alignItems: "center", borderRadius: 8,
                backgroundColor: c.accent, opacity: !newAgentModel || pressed ? 0.6 : 1 })}>
              <Text style={{ color: c.accentForeground, fontSize: 14, fontWeight: "600" }}>Создать агента</Text>
            </Pressable>
          </View>
        </Modal.Content>
      </Modal>

      <Modal
        title="Настройки области"
        open={Boolean(editingChat && areaSettingsPanel === "branch")}
        onOpenChange={(open) => {
          if (!open) setAreaSettingsPanel(null);
        }}
      >
        <Modal.Content>
          {editingChat?.projectKind === "git" ? (
            <View style={{ padding: 12, borderRadius: 12, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border }}>
              {areaSettings ? (
                <SettingsSelect
                  label="Ветка по умолчанию"
                  hint="Рабочая папка общая для агентов области. Перед созданием агента переключите область на выбранную ветку."
                  value={areaSettings.defaultBranch ?? ""}
                  options={[
                    { value: "", label: areaSettings.currentBranch ? `Текущая ветка · ${areaSettings.currentBranch}` : "Текущий checkout" },
                    ...Array.from(new Set([
                      ...areaSettings.branches,
                      ...(areaSettings.defaultBranch ? [areaSettings.defaultBranch] : []),
                    ])).map((branch) => ({ value: branch, label: branch })),
                  ]}
                  disabled={chatMutationPending}
                  onValueChange={(value) => void handleSaveAreaSettings({ defaultBranch: value || null })}
                />
              ) : (
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                  {areaSettingsError ?? "Загружаю настройки области…"}
                </Text>
              )}
            </View>
          ) : null}
        </Modal.Content>
      </Modal>

      <Modal
        title={confirmClosingSession
          ? "Закрыть работающего агента"
          : "Действия с агентом"}
        open={Boolean(agentMenuChat)}
        onOpenChange={(open) => {
          if (!open) setAgentMenuId(null);
        }}
      >
        <Modal.Content>
          {agentMenuChat && (
            <View style={{ gap: 8 }}>
              {confirmClosingSession ? (
                <Text style={{ color: c.foreground, fontSize: 14 }}>
                  Текущая работа остановится. Сохраненные сообщения будут доступны в истории Paseo.
                </Text>
              ) : (
                <View style={{ gap: 4 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <View style={{
                      flex: 1, minWidth: 0, height: 44, flexDirection: "row", alignItems: "center",
                      paddingLeft: 12, paddingRight: 4, borderRadius: 9, borderWidth: 1,
                      borderColor: draftAgentTitle === null ? c.border : c.accent,
                      backgroundColor: c.surface2,
                    }}>
                      <TextInput
                        ref={agentTitleInput}
                        accessibilityLabel="Название агента"
                        placeholder="Название агента"
                        placeholderTextColor={c.foregroundMuted}
                        value={draftAgentTitle ?? agentMenuChat.title ?? ""}
                        onChangeText={setDraftAgentTitle}
                        onFocus={() => {
                          if (draftAgentTitle === null) setDraftAgentTitle(agentMenuChat.title ?? "");
                        }}
                        onBlur={() => void handleRenameAgent()}
                        onSubmitEditing={() => void handleRenameAgent()}
                        maxLength={200}
                        editable={!chatMutationPending}
                        style={{ flex: 1, minWidth: 0, padding: 0, outlineWidth: 0, color: c.foreground, fontSize: 15 }}
                      />
                    </View>
                    <TitleModelPicker
                      theme={theme}
                      value={agentTitleModel}
                      options={titleModelOptions(titleProviders, agentTitleModel)}
                      disabled={suggestingAgentTitle || chatMutationPending}
                      pending={suggestingAgentTitle}
                      hint={titleModelsError ? `Не удалось загрузить модели: ${titleModelsError}` : undefined}
                      onValueChange={(model) => void handleSuggestAgentTitle(model)}
                    />
                  </View>
                </View>
              )}
              <ItemMenuActions theme={theme} disabled={chatMutationPending} actions={confirmClosingSession ? [
                { label: "Отмена", icon: "ArrowLeft", onPress: () => setConfirmClosingSession(false) },
                { label: "Остановить и закрыть", icon: "Archive", danger: true, onPress: () => void handleAgentMenuAction("close") },
              ] : [
                { label: "Скопировать ссылку на агента", icon: "Link2", onPress: () => void handleCopyAgentLink(agentMenuChat.id) },
                { label: "Перезагрузить агента", icon: "RefreshCw", onPress: () => void handleAgentMenuAction("reload") },
                {
                  label: "Закрыть агента",
                  icon: "Archive",
                  danger: true,
                  onPress: () => {
                    if (agentMenuChat.status === "running") setConfirmClosingSession(true);
                    else void handleAgentMenuAction("close");
                  },
                },
              ]} />
            </View>
          )}
        </Modal.Content>
      </Modal>

      <Modal
        title={confirmClosingTerminal ? "Закрыть терминал" : "Настройки терминала"}
        open={Boolean(terminalMenuItem)}
        onOpenChange={(open) => {
          if (!open && !chatMutationPending) setTerminalMenuId(null);
        }}
      >
        <Modal.Content>
          {terminalMenuItem ? (
            <View style={{ gap: 10 }}>
              {confirmClosingTerminal ? (
                <Text style={{ color: c.foreground, fontSize: 14 }}>
                  Терминал и запущенные в нем процессы завершатся.
                </Text>
              ) : null}
              <ItemMenuActions theme={theme} disabled={chatMutationPending} actions={confirmClosingTerminal ? [
                { label: "Отмена", icon: "ArrowLeft", onPress: () => setConfirmClosingTerminal(false) },
                { label: "Завершить терминал", icon: "X", danger: true, onPress: () => void handleCloseTerminal(terminalMenuItem) },
              ] : [
                { label: "Скопировать путь терминала", icon: "Copy", onPress: () => void handleCopyTerminalPath(terminalMenuItem) },
                { label: "Закрыть терминал", icon: "X", danger: true, onPress: () => setConfirmClosingTerminal(true) },
              ]} />
            </View>
          ) : null}
        </Modal.Content>
      </Modal>

      <Modal
        title="Перенос области в проект"
        open={Boolean(editingChat && chatTransferOpen)}
        onOpenChange={setChatTransferOpen}
      >
        <Modal.Content>
          {editingChat && chatTransferOpen ? (
            <View
              style={{
                padding: 12,
                borderRadius: 12,
                backgroundColor: c.surface2,
                borderWidth: 1,
                borderColor: c.border,
                gap: 12,
              }}
            >
              <View style={{ gap: 4 }}>
                <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>
                  Проект и рабочий корень
                </Text>
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                  Текущий проект:{" "}
                  <Text style={{ color: c.foreground, fontWeight: "600" }}>
                    {currentProjectGroup?.customName || currentProjectGroup?.name || "Неизвестный проект"}
                  </Text>
                </Text>
                <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11 }}>
                  {editingChat.workspaceDirectory}
                </Text>
              </View>

              {availableTargetProjects.length > 0 ? (
                <>
                  <View style={{ height: 1, backgroundColor: c.border }} />

                  <SettingsSelect
                    label="Целевой проект"
                    hint="Область будет создана в выбранном проекте"
                    value={transferTargetProjectId}
                    options={availableTargetProjects.map((p) => ({
                      label: p.customName || p.name,
                      value: p.id,
                    }))}
                    onValueChange={(val) => setTransferTargetProjectId(val)}
                  />

                  <SettingsSwitch
                    label="Архивировать исходную область"
                    hint="Скрыть область в исходном проекте после переноса"
                    value={transferArchiveOriginal}
                    onValueChange={setTransferArchiveOriginal}
                  />

                  <SettingsSwitch
                    label="Перенести историю последнего агента"
                    hint="Прикрепить сообщения и контекст к агенту в новой области"
                    value={transferIncludeHistory}
                    onValueChange={setTransferIncludeHistory}
                  />

                  <Pressable
                    accessibilityRole="button"
                    disabled={transferringChat || !transferTargetProjectId}
                    onPress={() => void handleTransferChat()}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      gap: 8,
                      paddingVertical: 11,
                      borderRadius: 9,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: c.accent,
                      opacity: transferringChat || !transferTargetProjectId ? 0.5 : pressed ? 0.85 : 1,
                    })}
                  >
                    <Icon name="ArrowRightLeft" size={15} color="#FFFFFF" />
                    <Text style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "600" }}>
                      {transferringChat ? "Переношу область…" : "Перенести в проект"}
                    </Text>
                  </Pressable>
                </>
              ) : (
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                  Нет других проектов в Штабе для переноса.
                </Text>
              )}
            </View>
          ) : null}
        </Modal.Content>
      </Modal>

      {/* Модальное окно настроек панели проектов */}
      <Modal
        title="Настройки панели"
        open={panelSettingsOpen}
        onOpenChange={(open) => {
          if (!open) setPanelSettingsOpen(false);
        }}
      >
        <Modal.Content>
          <View style={{ gap: 16 }}>
            <SettingsSection title="Название вкладки">
              <View
                style={{
                  padding: 12,
                  borderRadius: 12,
                  backgroundColor: c.surface2,
                  borderWidth: 1,
                  borderColor: c.border,
                  gap: 10,
                }}
              >
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                  Отображаемый заголовок в боковой панели (по умолчанию «Штаб»)
                </Text>
                <TextInput
                  value={draftHeaderTitle}
                  onChangeText={setDraftHeaderTitle}
                  placeholder="Штаб"
                  placeholderTextColor={c.foregroundMuted}
                  onSubmitEditing={() => void handleSaveHeaderTitle()}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    borderRadius: 9,
                    backgroundColor: c.surface1,
                    borderWidth: 1,
                    borderColor: c.border,
                    color: c.foreground,
                    fontSize: 14,
                  }}
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={savingPanelSettings || !draftHeaderTitle.trim()}
                  onPress={() => void handleSaveHeaderTitle()}
                  style={({ pressed }) => ({
                    paddingVertical: 11,
                    borderRadius: 9,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: c.accent,
                    opacity: savingPanelSettings || !draftHeaderTitle.trim() ? 0.5 : pressed ? 0.85 : 1,
                  })}
                >
                  <Text style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "600" }}>
                    {savingPanelSettings ? "Сохранение..." : "Сохранить название"}
                  </Text>
                </Pressable>
              </View>
            </SettingsSection>

            <SettingsSection title="Мониторинг сервера">
              <View
                style={{
                  padding: 12,
                  borderRadius: 12,
                  backgroundColor: c.surface2,
                  borderWidth: 1,
                  borderColor: c.border,
                  gap: 10,
                }}
              >
                <SettingsSwitch
                  label="Состояние сервера (CPU, ОЗУ, сеть, диск)"
                  hint="Отображает компактную строку метрик над проектами и подробную шторку с топом процессов по ОЗУ. При выключении фоновый опрос полностью останавливается (0 таймеров, 0 CPU)."
                  value={serverState.showHostMetrics}
                  onValueChange={(val) => void handleToggleHostMetrics(val)}
                  disabled={savingPanelSettings}
                />
              </View>
            </SettingsSection>

            <SettingsSection title="Обновление плагина">
              <View
                style={{
                  padding: 12,
                  borderRadius: 12,
                  backgroundColor: c.surface2,
                  borderWidth: 1,
                  borderColor: c.border,
                  gap: 10,
                }}
              >
                <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
                  Синхронизация Штаба с последними обновлениями и изменениями в репозитории (GitHub).
                </Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={syncingPlugin}
                  onPress={() => void handleSyncPlugin()}
                  style={({ pressed }) => ({
                    paddingVertical: 11,
                    borderRadius: 9,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: c.accent,
                    opacity: syncingPlugin ? 0.5 : pressed ? 0.85 : 1,
                  })}
                >
                  <Text style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "600" }}>
                    {syncingPlugin ? "Синхронизация..." : "Синхронизировать с репозиторием"}
                  </Text>
                </Pressable>
                {syncResult ? (
                  <View
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      backgroundColor: c.surface1,
                      borderWidth: 1,
                      borderColor: syncResult.success ? c.statusSuccess : c.statusDanger,
                    }}
                  >
                    <Text
                      style={{
                        color: syncResult.success ? c.statusSuccess : c.statusDanger,
                        fontSize: 12,
                        fontWeight: "500",
                        lineHeight: 16,
                      }}
                    >
                      {syncResult.message}
                    </Text>
                  </View>
                ) : null}
              </View>
            </SettingsSection>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function JumpBridgeScreen({ navigation, params }: PluginScreenProps) {
  const handledRef = useRef<string | null>(null);
  const { agentId, jump: workspaceId, t } = params;

  useEffect(() => {
    const targetId = agentId || workspaceId;
    if (!navigation || !targetId) return;
    const key = `${agentId ? "agent" : "workspace"}:${targetId}:${t ?? ""}`;
    if (handledRef.current === key) return;
    handledRef.current = key;
    if (agentId) navigation.openAgent({ agentId });
    else navigation.openWorkspace({ workspaceId: targetId });
  }, [agentId, workspaceId, t, navigation]);

  return <View />;
}

export default function contribute(client: PluginClientContext) {
  const removeGenui = contributeGenuiClient(client);
  const disposeScreen = client.addScreen({
    id: "jump",
    title: (params) => (params?.agentId ? "Переход к агенту" : "Переход к области"),
    Component: JumpBridgeScreen,
  });

  const disposeHeader = client.addSidebarHeaderItem({
    id: "projects-quick-header",
    title: "Штаб",
    Component: SidebarEmbeddedProjects,
  });

  client.addSurface("limits", UsageLimitsSurface);
  client.addSurface("history", UsageHistorySurface);
  client.addSurface("settings", UsageSettingsSurface);

  client.addSettingsScreen({
    id: "settings",
    title: "Лимиты и расход",
    icon: "Settings2",
    Component: UsageSettingsSurface,
  });

  client.addWorkspacePanel({
    id: "limits",
    title: "Лимиты и расход",
    icon: "Gauge",
    context: "workspace",
    locations: ["explorer", "workspace"],
    Component: UsageLimitsPanel,
  });
  client.addWorkspacePanel({
    id: "history",
    title: "История расхода",
    icon: "ChartColumn",
    context: "workspace",
    locations: ["explorer", "workspace"],
    Component: UsageHistoryPanel,
  });

  const removeGitSurface = client.addSurface("git-workspace", GitWorkspaceSurface);
  const removeServicesSurface = client.addSurface("services", Services);
  const removeArtifactsSurface = client.addSurface("artifacts", ArtifactsSurface);
  const removeTeamSurface = client.addSurface("team", TeamSurface);

  const removeArtifactsTransformer = client.addTimelineTransformer({
    id: "paseo-hq-artifacts",
    query: { itemType: "assistant_message" },
    transform({ item, phase }) {
      return splitHqTimelineMessage(item.text, phase, item.messageId);
    },
  });

  const removeArtifactsTextRenderer = client.addTimelineRenderer({
    kind: ARTIFACT_TEXT_KIND,
    version: 1,
    schema: z.object({
      text: z.string(),
      phase: z.enum(["streaming", "complete"]).optional(),
    }),
    Component: ({ item }) => (
      <View testID="assistant-message" style={{ marginVertical: 2 }}>
        <Markdown>{item.data.text}</Markdown>
      </View>
    ),
  });

  const removeArtifactsBlockRenderer = client.addTimelineRenderer({
    kind: ARTIFACT_BLOCK_KIND,
    version: 1,
    schema: z.object({
      name: z.string(),
      title: z.string(),
      kind: z.enum(["html", "svg", "markdown", "code", "data", "file"]),
      code: z.string(),
      complete: z.boolean().optional(),
      fenceIndex: z.number().optional(),
      size: z.number().optional(),
      messageId: z.string().optional(),
      projectId: z.string().optional(),
      projectDisplayName: z.string().optional(),
      artifactId: z.string().optional(),
    }),
    Component: ArtifactCard,
  });


  const removeGitSettings = client.addSettingsScreen({
    id: "git-workspace-settings",
    title: "Git и настройки GitLab",
    icon: "FolderGit2",
    Component: GitWorkspaceSettings,
  });

  const removeGitCommand = client.addCommandCenterItem({
    id: "create-from-git",
    title: "Создать область из GitHub / GitLab",
    icon: "FolderGit2",
    context: "global",
    keywords: ["git", "github", "gitlab", "clone", "repo", "workspace", "область", "проект", "клонировать"],
    onSelect({ openSurface }) {
      openSurface("git-workspace");
    },
  });

  const removeGitSlash = client.addSlashCommand({
    name: "git",
    description: "Поиск репозиториев, клонирование и создание области",
    argumentHint: "",
    context: "workspace",
    onSubmit({ openSurface }) {
      openSurface("git-workspace");
    },
  });

  const removePills = contributeComposerPills(client);
  const removeLimitAlerts = contributeLimitAlerts(client);

  return () => {
    removeGenui();
    disposeScreen();
    disposeHeader();
    try {
      removeGitSurface();
      removeServicesSurface();
      removeArtifactsSurface();
      removeTeamSurface();
      removeArtifactsTransformer();
      removeArtifactsTextRenderer();
      removeArtifactsBlockRenderer();
      removeGitSettings();
      removeGitCommand();
      removeGitSlash();
    } catch {
      // ignore
    }
    try {
      removePills();
    } catch {
      // ignore
    }
    try {
      removeLimitAlerts();
    } catch {
      // ignore
    }
  };
}
