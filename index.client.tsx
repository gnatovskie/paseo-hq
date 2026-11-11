import { syncPlugin } from "./client/plugin-sync";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Animated,
  Easing,
  Image,
  Linking,
  Modal as NativeModal,
  Platform,
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
  terminalRenameRpc,
  areaBranchesRpc,
  areaWorktreeOptionsRpc,
  areaWorktreeCreateRpc,
  areaWorktreeInfoRpc,
  areaWorktreeRemoveRpc,
  sessionTitleSuggestRpc,
  sessionTransferRpc,
  sidebarReadRpc,
  type AvatarUpdate,
  type CandidateDir,
  type ProjectMeta,
  type SidebarState,
} from "./shared/contracts";
import { agentCreationOptions } from "./shared/agent-creation-options";
import { projectAgentConfig } from "./shared/project-agent-config";
import { compareProjectOrder } from "./shared/project-order";
import { groupAreaAgents } from "./shared/area-agents";
import { GENERATOR_TITLE, titleModelOptions } from "./shared/title-models";
import { useActiveSession } from "./client/active-session.client";
import { ProviderLogo } from "./client/provider-logo.client";
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
import { defaultWorktreePath } from "./shared/worktree";
import { openAgentTab } from "./client/agent-navigation";
import { applyAgentUpdate } from "./shared/sidebar-agent-updates";
import { clearProviders, peekProviders, providersSnapshot } from "./shared/provider-cache";


const EMOJI_PRESETS = ["🚀", "⚡", "🛠", "📦", "🧠", "🌐", "💳", "🎨", "🔒", "📱", "🤖", "🔥"];
const AREA_SESSION_FILTERS = [
  { value: "all", label: "Все" },
  { value: "agents", label: "Агенты" },
  { value: "terminals", label: "Терминалы" },
  { value: "closed", label: "Закрытые" },
] as const;
const COLOR_PRESETS = ["#3B82F6", "#8B5CF6", "#10B981", "#F59E0B", "#EF4444", "#EC4899", "#06B6D4", "#64748B"];

const DEFAULT_META: ProjectMeta = {
  avatarUri: null,
  avatarEmoji: null,
  avatarBg: null,
  hidden: false,
  pinned: false,
  sessionTitleModel: null,
  sessionsSortMode: "auto",
  sessionOrder: [],
  hiddenSections: [],
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
const NESTED_ITEM_GAP = 10;
// Отступ индикатора от края вдавленной рамки равен зазору между индикатором и текстом: 1 (граница) + 4 (поля рамки) + 5.
const NESTED_ITEM_INSET = 5;

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

function ChatActionButton({ label, icon, color, disabled, onPress, onPressIn, theme, quiet = false, selected = false, background }: {
  label: string;
  icon: string;
  color?: string;
  disabled?: boolean;
  onPress: () => void;
  /** Срабатывает до потери фокуса полем ввода, поэтому кнопка не теряет нажатие при blur. */
  onPressIn?: () => void;
  theme: PluginTheme;
  quiet?: boolean;
  /** Выбранный вариант в ряду переключателей. */
  selected?: boolean;
  /** Свой фон кнопки вместо стандартного. */
  background?: string;
}) {
  const c = theme.colors;
  return (
    <TooltipPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      tooltip={label}
      disabled={disabled}
      onPress={onPress}
      onPressIn={onPressIn}
      style={({ pressed }) => ({
        width: quiet ? 34 : 44,
        height: quiet ? 36 : 44,
        flexShrink: quiet ? 0 : 1,
        borderRadius: 9,
        borderWidth: quiet ? 0 : selected ? 2 : 1,
        borderColor: selected ? c.accent : c.border,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? c.surface1 : quiet ? undefined : background ?? c.surface2,
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
          {`${formatRussianCount(group.chats.length, "область", "области", "областей")} · 0 пулов`}
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

const DEFAULT_AGENT_TITLE = "Агент без названия";

function agentTitle(agent: AgentEntry["agent"]): string {
  return agent.title?.trim() || DEFAULT_AGENT_TITLE;
}

function AgentSummary({ agent, branch, theme, platform, gap = 4, selected }: {
  agent: AgentEntry["agent"];
  branch?: string;
  theme: PluginTheme;
  platform: PluginSidebarItemProps["layout"]["platform"];
  gap?: number;
  selected?: boolean;
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
        <Text numberOfLines={1} style={{ color: selected === false ? c.foregroundMuted : c.foreground, fontSize: 13, lineHeight: 18, fontWeight: selected ? "600" : "500" }}>
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

function TerminalRow({ terminal, label, onOpen, onMenu, disabled, theme, nested = false, pinned = false, selected = false }: {
  selected?: boolean;
  terminal: PaseoTerminal;
  label: string;
  onOpen: () => void;
  onMenu: () => void;
  disabled?: boolean;
  theme: PluginTheme;
  nested?: boolean;
  pinned?: boolean;
}) {
  const c = theme.colors;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingRight: nested ? 0 : 10, borderRadius: 8, ...(nested ? { backgroundColor: selected ? c.surface1 : undefined } : { borderWidth: 1, borderColor: selected ? c.accent : "transparent" }) }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Открыть терминал ${label}`}
        accessibilityState={{ selected }}
        aria-selected={selected}
        onPress={onOpen}
        style={({ pressed }) => ({
          flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", minHeight: 44,
          gap: nested ? NESTED_ITEM_GAP : 7,
          paddingLeft: nested ? NESTED_ITEM_INSET : 10, paddingRight: 10, paddingVertical: 5, borderRadius: 8,
          backgroundColor: pressed ? c.surface2 : undefined,
        })}
      >
        <View>
          <Icon name="Terminal" size={SESSION_STATUS_SIZE} color={c.foregroundMuted} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={{ color: nested && !selected ? c.foregroundMuted : c.foreground, fontSize: 13, lineHeight: 18, fontWeight: nested && selected ? "600" : "400" }}>{label}</Text>
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
      {pinned ? <Icon name="Pin" size={12} color={c.accent} /> : null}
      <ChatActionButton
        label={`Меню терминала ${label}`}
        icon="MoreHorizontal"
        quiet
        disabled={disabled}
        onPress={onMenu}
        theme={theme}
      />
    </View>
  );
}

type AreaSession =
  | { kind: "agent"; id: string; entry: AgentEntry }
  | { kind: "terminal"; id: string; terminal: PaseoTerminal };

// Закрепленные идут первыми в порядке закрепления и не зависят от активности, остальные - агенты, затем терминалы.
function orderAreaSessions(
  agents: AgentEntry[],
  terminals: PaseoTerminal[],
  pinned: Record<string, number>,
): AreaSession[] {
  const items: AreaSession[] = [
    ...agents.map((entry): AreaSession => ({ kind: "agent", id: entry.agent.id, entry })),
    ...terminals.map((terminal): AreaSession => ({ kind: "terminal", id: terminal.id, terminal })),
  ];
  const pinnedItems = items.filter(item => pinned[item.id]).sort((a, b) => pinned[a.id]! - pinned[b.id]!);
  return [...pinnedItems, ...items.filter(item => !pinned[item.id])];
}

type SheetAction = { label: string; icon: string; onPress: () => void; danger?: boolean; disabled?: boolean; color?: string; selected?: boolean };

// Все окна Штаба рисуем сами. Они лежат в одном слое HqModalLayer (одна модалка react-native на все окна),
// а окно - обычный оверлей внутри него: так одно окно открывается поверх другого без борьбы за фокус и слои.
// Шапка: название и крупный крестик в одной строке, ряд действий под ней.
const hqWindowClosers: (() => void)[] = [];

function HqModalLayer({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  const closeTop = () => hqWindowClosers[hqWindowClosers.length - 1]?.();
  // В вебе Escape ловим сами: событие модалки react-native приходит только пока фокус внутри нее,
  // а после закрытия верхнего окна фокус теряется.
  useEffect(() => {
    if (Platform.OS !== "web" || !visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTop();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [visible]);
  return (
    <NativeModal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={Platform.OS === "web" ? undefined : closeTop}
    >
      <View style={{ flex: 1 }}>{children}</View>
    </NativeModal>
  );
}

function HqModal({ title, open, onOpenChange, theme, actions, actionsDisabled = false, fixedHeight = false, narrow = false, children }: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  theme: PluginTheme;
  actions?: SheetAction[];
  actionsDisabled?: boolean;
  /** Окно всегда одной высоты, не зависит от длины содержимого. */
  fixedHeight?: boolean;
  /** Окно, открытое поверх другого: уже родительского. */
  narrow?: boolean;
  children: React.ReactNode;
}) {
  const c = theme.colors;
  const close = () => onOpenChange(false);
  const latestClose = useRef(close);
  latestClose.current = close;
  // Синхронно с отрисовкой: иначе Escape сразу после закрытия окна попадает в уже закрытое.
  useLayoutEffect(() => {
    if (!open) return;
    const closer = () => latestClose.current();
    hqWindowClosers.push(closer);
    return () => {
      const index = hqWindowClosers.indexOf(closer);
      if (index >= 0) hqWindowClosers.splice(index, 1);
    };
  }, [open]);
  if (!open) return null;
  return (
    <View style={{
      position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
      alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <Pressable
        accessibilityLabel="Закрыть окно"
        onPress={close}
        style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.55)" }}
      />
      <View style={{
        width: "100%", maxWidth: narrow ? 400 : 520, maxHeight: "90%", ...(fixedHeight ? { height: "85%" } : null), borderRadius: 16,
        borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden",
      }}>
        <View style={{ paddingLeft: 16, paddingRight: 8, paddingTop: 8, paddingBottom: 8, gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 18, fontWeight: "600" }}>
              {title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Закрыть"
              onPress={close}
              style={({ pressed }) => ({
                width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center",
                backgroundColor: pressed ? c.surface2 : undefined,
              })}
            >
              <Icon name="X" size={28} color={c.foreground} />
            </Pressable>
          </View>
          {actions?.length ? (
            <View style={{ paddingRight: 8 }}>
              <ItemMenuActions theme={theme} disabled={actionsDisabled} actions={actions} />
            </View>
          ) : null}
        </View>
        <View style={{ height: 1, backgroundColor: c.border }} />
        <ScrollView keyboardShouldPersistTaps="handled" style={fixedHeight ? { flex: 1 } : { flexShrink: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
          {children}
        </ScrollView>
      </View>
    </View>
  );
}

HqModal.Content = function HqModalContent({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
};

function ActionSheet({ title, open, onClose, theme, actions, disabled, fixedHeight, narrow, children }: {
  title: string;
  open: boolean;
  onClose: () => void;
  theme: PluginTheme;
  actions: SheetAction[];
  disabled: boolean;
  fixedHeight?: boolean;
  narrow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <HqModal title={title} open={open} onOpenChange={(next) => { if (!next) onClose(); }}
      theme={theme} actions={actions} actionsDisabled={disabled} fixedHeight={fixedHeight} narrow={narrow}>
      {children}
    </HqModal>
  );
}

type Choice<T> = { value: T; label: string; icon: string; detail?: string; a11yLabel?: string; badge?: string };

// Список вариантов с галочкой у выбранного, в рамке поля.
function ChoiceList<T>({ theme, options, value, onChange, disabled }: {
  theme: PluginTheme;
  options: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const c = theme.colors;
  return (
    <View style={{ borderRadius: 9, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2, padding: 4, gap: 2 }}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="button"
            accessibilityLabel={option.a11yLabel ?? option.label}
            accessibilityState={{ selected }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => ({
              minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 6,
              borderRadius: 7, backgroundColor: selected || pressed ? c.surface1 : undefined, opacity: disabled ? 0.6 : 1,
            })}
          >
            <Icon name={option.icon} size={15} color={selected ? c.accent : c.foregroundMuted} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 14, fontWeight: selected ? "600" : "400" }}>
                {option.label}
              </Text>
              {option.detail ? (
                <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11 }}>{option.detail}</Text>
              ) : null}
            </View>
            {option.badge ? (
              <View
                accessible
                accessibilityLabel={`Ветка: ${option.badge}`}
                style={{
                  flexShrink: 1, maxWidth: "45%", minHeight: 20, flexDirection: "row", alignItems: "center", gap: 4,
                  paddingHorizontal: 6, borderRadius: 6, backgroundColor: c.surface1,
                }}
              >
                <Icon name="GitBranch" size={11} color={c.foregroundMuted} />
                <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 11, color: c.foregroundMuted }}>{option.badge}</Text>
              </View>
            ) : null}
            {selected ? <Icon name="Check" size={16} color={c.accent} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

type SessionNaming = {
  value: string;
  onChange: (title: string) => void;
};

function EditableName({ theme, value, onChange, onBlur, disabled, label, caption, editLabel, placeholder = "Необязательно" }: {
  theme: PluginTheme; value: string; onChange: (value: string) => void; onBlur?: () => void;
  disabled: boolean; label: string; caption: string; editLabel: string; placeholder?: string;
}) {
  const input = useRef<React.ElementRef<typeof TextInput>>(null);
  const [focused, setFocused] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number }>();
  const edit = () => {
    setSelection({ start: value.length, end: value.length });
    input.current?.focus();
  };
  return <View style={{ gap: 6 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{caption}</Text>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ flex: 1, minWidth: 0, height: 44, justifyContent: "center", paddingHorizontal: 12,
        borderWidth: 1, borderRadius: 9, borderColor: focused ? theme.colors.accent : theme.colors.border, backgroundColor: theme.colors.surface2 }}>
        <TextInput ref={input} accessibilityLabel={label} value={value} placeholder={placeholder}
          placeholderTextColor={theme.colors.foregroundMuted} maxLength={200} editable={!disabled}
          onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); onBlur?.(); }} onSubmitEditing={() => input.current?.blur()}
          onChangeText={onChange} selection={selection}
          onSelectionChange={({ nativeEvent: { selection: next } }) => {
            if (next.start === selection?.start && next.end === selection.end) setSelection(undefined);
          }}
          style={{ padding: 0, outlineWidth: 0, color: theme.colors.foreground, fontSize: 15 }} />
      </View>
      <ChatActionButton theme={theme} label={editLabel} icon="Pencil"
        disabled={disabled} onPress={edit} />
    </View>
  </View>;
}

function NewSessionName({ theme, kind, naming, disabled }: {
  theme: PluginTheme; kind: "agent" | "terminal"; naming: SessionNaming; disabled: boolean;
}) {
  return <EditableName theme={theme} value={naming.value} onChange={naming.onChange} disabled={disabled}
    label={kind === "agent" ? "Название нового агента" : "Название нового терминала"}
    caption={kind === "agent" ? "Название агента" : "Название терминала"} editLabel="Редактировать название сессии" />;
}

function NewAgentOption({ theme, label, options, value, onChange, disabled, fallback }: {
  theme: PluginTheme;
  label: string;
  options: { id: string; label: string }[];
  value?: string;
  onChange: (value: string) => void;
  disabled: boolean;
  fallback: string;
}) {
  const c = theme.colors;
  const selected = options.find(option => option.id === value)?.label ?? (options.length ? "По умолчанию" : fallback);
  return <View style={{ gap: 6 }}>
    <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{label}</Text>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ flex: 1, minWidth: 0, height: 40, justifyContent: "center", paddingHorizontal: 12,
        borderRadius: 9, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 }}>
        <Text accessibilityLabel={`${label}: ${selected}`} style={{ color: c.foreground, fontSize: 14 }} numberOfLines={1}>{selected}</Text>
      </View>
      {options.length ? <TitleModelPicker theme={theme} plain selectionLabel={label}
        options={options.map(option => ({ value: option.id, label: option.label, name: option.label, provider: "", providerLabel: "" }))}
        value={value ?? ""} disabled={disabled} icon="ChevronDown" label={`Выбрать: ${label}`} menuLabel={`Варианты: ${label}`}
        onValueChange={onChange} /> : null}
    </View>
  </View>;
}

// Одна форма для новой области и новой сессии.
function NewSessionWindow({ theme, title, open, onClose, narrow, kind, onKindChange, kindLocked, name, onNameChange, nameEditable,
  target, extra, naming, agentOptions, model, modelsError, modelOptions, onModelChange, folder, busy, submitLabel, submitAgentLabel, onSubmit }: {
  theme: PluginTheme;
  title: string;
  open: boolean;
  onClose: () => void;
  narrow?: boolean;
  kind: "agent" | "terminal";
  onKindChange: (kind: "agent" | "terminal") => void;
  kindLocked?: boolean;
  /** Есть поле названия только у новой области. */
  name?: string;
  onNameChange?: (name: string) => void;
  nameEditable?: boolean;
  /** Куда создавать: новая область или одна из имеющихся (value = id области, null = новая). */
  /** Дополнительные поля после названия (ветка и папка worktree у новой области). */
  extra?: React.ReactNode;
  naming: SessionNaming;
  target?: { value: string | null; options: { value: string; label: string; branch?: string }[]; onChange: (value: string | null) => void; locked?: boolean };
  agentOptions: ReturnType<typeof agentCreationOptions> & {
    onModeChange: (value: string | undefined) => void;
    onThinkingChange: (value: string | undefined) => void;
    loading: boolean;
  };
  model: string | null;
  modelsError: string | null;
  modelOptions: ReturnType<typeof titleModelOptions>;
  onModelChange: (model: string) => void;
  folder: string;
  busy: boolean;
  submitLabel: string;
  submitAgentLabel?: string;
  onSubmit: () => void;
}) {
  const c = theme.colors;
  const disabled = busy || (kind === "agent" && !model);
  const field = { borderRadius: 9, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 } as const;
  const kindActions: SheetAction[] = [
    { label: "Агент", icon: "Bot", selected: kind === "agent", onPress: () => onKindChange("agent") },
    { label: "Терминал", icon: "Terminal", selected: kind === "terminal", onPress: () => onKindChange("terminal") },
  ];
  return (
    <HqModal theme={theme} narrow={narrow} title={title} open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}
      actionsDisabled={kindLocked}
      actions={target ? undefined : kindActions}
    >
      <View style={{ gap: 16 }}>
        {target ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Область</Text>
            <ChoiceList
              theme={theme}
              options={[
                { value: null as string | null, label: "Новая область", icon: "Plus" },
                ...target.options.map((option) => ({
                  value: option.value as string | null, label: option.label, icon: "Folder", a11yLabel: `Область: ${option.label}`,
                  badge: option.branch,
                })),
              ]}
              value={target.value}
              onChange={target.onChange}
              disabled={busy || target.locked}
            />
          </View>
        ) : null}
        {name !== undefined ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Название области</Text>
            <View style={{ ...field, height: 44, justifyContent: "center", paddingHorizontal: 12 }}>
              <TextInput
                accessibilityLabel="Название новой области"
                value={name}
                editable={!busy && nameEditable !== false}
                onChangeText={onNameChange}
                style={{ padding: 0, outlineWidth: 0, color: c.foreground, fontSize: 15 }}
              />
            </View>
          </View>
        ) : null}
        {extra}
        {target ? <ItemMenuActions theme={theme} actions={kindActions} disabled={kindLocked || busy} /> : null}
        <NewSessionName theme={theme} kind={kind} naming={naming} disabled={busy} />
        {kind === "agent" ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Модель нового агента</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ ...field, flex: 1, minWidth: 0, height: 44, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12 }}>
                {model ? <ProviderLogo model={model} color={c.foreground} /> : null}
                <Text style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 15 }} numberOfLines={1}>
                  {model ?? modelsError ?? "Загружаю модели..."}
                </Text>
              </View>
              <TitleModelPicker theme={theme} options={modelOptions}
                value={model ?? ""} disabled={!model || busy || !modelOptions.length}
                label="Выбрать модель нового агента" icon="ChevronDown" menuLabel="Модели нового агента"
                onValueChange={onModelChange} />
            </View>
          </View>
        ) : (
          <View style={{ gap: 6 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Папка терминала</Text>
            <View style={{ ...field, minHeight: 44, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 8 }}>
              <Text accessibilityLabel={`Папка терминала: ${folder}`} selectable
                style={{ color: c.foreground, fontSize: 12, fontFamily: "monospace" }}>
                {folder}
              </Text>
            </View>
          </View>
        )}
        {kind === "agent" ? (
          <View style={{ gap: 12 }}>
            {agentOptions.loading ? <Text style={{ color: c.foregroundMuted }}>Настройки загружаются в фоне. Можно создать агента с настройками последней сессии.</Text> : <>
              <NewAgentOption theme={theme} label="Permissions" options={agentOptions.modes}
                value={agentOptions.modeId} onChange={agentOptions.onModeChange} disabled={busy}
                fallback="Провайдер не предоставляет выбор" />
              <NewAgentOption theme={theme} label="Уровень рассуждения" options={agentOptions.thinkingOptions}
                value={agentOptions.thinkingOptionId} onChange={agentOptions.onThinkingChange} disabled={busy}
                fallback="У модели нет выбора уровня" />
            </>}
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={kind === "agent" ? submitAgentLabel ?? submitLabel : submitLabel}
          disabled={disabled}
          onPress={onSubmit}
          style={({ pressed }) => ({ padding: 12, alignItems: "center", borderRadius: 9,
            backgroundColor: c.accent, opacity: disabled || pressed ? 0.6 : 1 })}
        >
          <Text style={{ color: c.accentForeground, fontSize: 14, fontWeight: "600" }}>
            {busy ? "Создаю…" : submitLabel}
          </Text>
        </Pressable>
      </View>
    </HqModal>
  );
}

function ItemMenuActions({ actions, theme, disabled }: {
  actions: SheetAction[];
  theme: PluginTheme;
  disabled: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-start" }}>
      {actions.map(({ label, icon, onPress, danger, disabled: actionDisabled, color, selected }) => (
        <ChatActionButton
          key={label}
          label={label}
          icon={icon}
          color={danger ? theme.colors.statusDanger : color}
          disabled={disabled || actionDisabled}
          selected={selected}
          onPress={onPress}
          theme={theme}
        />
      ))}
    </View>
  );
}

function SessionInformation({ theme, agent, workspace, path, branch, agentLink, project = false }: {
  theme: PluginTheme; agent?: AgentEntry["agent"]; workspace?: PaseoWorkspace;
  path: string; branch?: string; agentLink?: string; project?: boolean;
}) {
  const c = theme.colors;
  const toast = useToast();
  const copy = async (value: string) => {
    try { await copyText(value); toast.show("Скопировано", { variant: "info" }); }
    catch { toast.error("Не удалось скопировать"); }
  };
  const rows = [
    ...(agent ? [
      { label: "Провайдер", value: agent.provider.split("/")[0], a11y: "Провайдер агента", icon: "Bot" },
      { label: "Модель", value: agent.model || agent.provider.split("/").slice(1).join("/") || "Не указана", a11y: "Модель агента", icon: "Cpu" },
    ] : []),
    ...(agentLink ? [{ label: "Ссылка на агента", value: `ID: ${agent!.id}`, a11y: "Ссылка на агента", icon: "Link2", copy: true }] : []),
    ...(workspace?.projectKind === "git" ? [{ label: "Текущая ветка", value: branch || "Ветка не определена", a11y: "Текущая ветка", icon: "GitBranch", copy: Boolean(branch) }] : []),
    { label: project ? "Папка проекта" : "Рабочая папка", value: path, a11y: project ? "Папка проекта" : "Рабочая папка сессии", icon: "Folder", copy: Boolean(path && path !== "Папка недоступна") },
  ];
  return <View style={{ gap: 12, marginTop: 8, padding: 12, borderRadius: 9, borderWidth: 1, borderColor: c.border }}>
    {rows.map(row => <View key={row.label} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
      <Icon name={row.icon} size={15} color={c.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{row.label}</Text>
        <Text selectable numberOfLines={row.icon === "Link2" ? 1 : undefined} ellipsizeMode="tail" accessibilityLabel={`${row.a11y}: ${row.value}`} style={{ color: c.foreground, fontSize: 12 }}>{row.value}</Text>
      </View>
      {"copy" in row && row.copy ? <Pressable accessibilityRole="button" accessibilityLabel={row.icon === "GitBranch" ? "Скопировать ветку" : row.icon === "Link2" ? "Скопировать ссылку на агента" : project ? "Скопировать папку проекта" : "Скопировать рабочую папку"} onPress={() => void copy(row.icon === "Link2" ? agentLink! : row.value)} style={({ pressed }) => ({ padding: 7, borderRadius: 7, backgroundColor: pressed ? c.surface2 : "transparent" })}><Icon name="Copy" size={15} color={c.foregroundMuted} /></Pressable> : null}
    </View>)}
  </View>;
}

function BranchInformation({ branch, path, kind, theme }: { branch: string; path: string; kind?: "project" | "worktree"; theme: PluginTheme }) {
  const c = theme.colors;
  const toast = useToast();
  const copy = async (value: string, label: string) => {
    try {
      await copyText(value);
      toast.show(`${label} скопирован${label === "Ветка" ? "а" : ""}`, { variant: "info" });
    } catch {
      toast.error(`Не удалось скопировать ${label === "Ветка" ? "ветку" : "путь"}`);
    }
  };
  return <View style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>Рабочая папка</Text>
            {kind ? <Text style={{ color: c.foregroundMuted, fontSize: 10, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 6, backgroundColor: c.surface2 }}>{kind === "worktree" ? "Worktree" : "Папка проекта"}</Text> : null}
          </View>
          {[{ label: "Ветка", value: branch, icon: "GitBranch" }, { label: "Папка области", value: path, icon: "Folder" }].map((item) => <View key={item.label} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Icon name={item.icon} size={15} color={c.foregroundMuted} />
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}><Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{item.label}</Text><Text selectable style={{ color: c.foreground, fontSize: 12 }} numberOfLines={2}>{item.value}</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel={`Скопировать ${item.label === "Ветка" ? "название ветки" : "путь области"}`} onPress={() => void copy(item.value, item.label === "Ветка" ? "Ветка" : "Путь")} style={({ pressed }) => ({ padding: 7, borderRadius: 7, backgroundColor: pressed ? c.surface2 : "transparent" })}><Icon name="Copy" size={15} color={c.foregroundMuted} /></Pressable>
          </View>)}
  </View>;
}

function AreaBranchBadge({ branch, path, kind, theme }: { branch: string; path: string; kind?: "project" | "worktree"; theme: PluginTheme }) {
  const c = theme.colors;
  const toast = useToast();
  const anchor = useRef<View>(null);
  const { width, height } = useWindowDimensions();
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!position || Platform.OS !== "web") return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setPosition(null); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [position]);
  const popupWidth = Math.min(320, width - 24);
  return <>
    <Pressable ref={anchor} accessibilityRole="button" accessibilityLabel={`Ветка области ${branch}`}
      onPress={(event) => {
        event.stopPropagation();
        anchor.current?.measureInWindow((x, y, _w, h) => setPosition({
          x: Math.max(12, Math.min(x, width - popupWidth - 12)),
          y: y + h + 8 + 180 <= height ? y + h + 8 : Math.max(12, y - 188),
        }));
      }}
      style={{ alignSelf: "flex-start", minHeight: 28, maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, borderRadius: 6, backgroundColor: c.surface2 }}>
      <Icon name="GitBranch" size={11} color={c.foregroundMuted} />
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 11, color: c.foregroundMuted }}>{branch}</Text>
    </Pressable>
    <NativeModal transparent visible={position !== null} animationType="fade" onRequestClose={() => setPosition(null)}>
      <View style={{ flex: 1 }}>
        <Pressable accessibilityLabel="Закрыть информацию о ветке" onPress={() => setPosition(null)} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
        {position ? <View style={{ position: "absolute", left: position.x, top: position.y, width: popupWidth, padding: 14, gap: 14, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 8 }}>
          <BranchInformation branch={branch} path={path} kind={kind} theme={theme} />
        </View> : null}
      </View>
    </NativeModal>
  </>;
}

function SidebarEmbeddedProjects({ theme, layout, host, openScreen, openPopover }: PluginSidebarItemProps) {
  const paseo = usePaseo();
  const toast = useToast();
  const activeSession = useActiveSession();
  const readSidebar = useRpc(sidebarReadRpc);
  const readAreaSettings = useRpc(areaSettingsRpc);
  const createAreaSession = useRpc(areaSessionCreateRpc);
  const saveProject = useRpc(projectSaveRpc);
  const pinSession = useRpc(sessionPinRpc);
  const readAreaBranches = useRpc(areaBranchesRpc);
  const readWorktreeOptions = useRpc(areaWorktreeOptionsRpc);
  const [areaBranches, setAreaBranches] = useState<Record<string, string>>({});
  const [areaCheckoutKinds, setAreaCheckoutKinds] = useState<Record<string, "project" | "worktree">>({});
  const createAreaWorktree = useRpc(areaWorktreeCreateRpc);
  const readAreaWorktree = useRpc(areaWorktreeInfoRpc);
  const removeAreaWorktree = useRpc(areaWorktreeRemoveRpc);
  const renameTerminal = useRpc(terminalRenameRpc);
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
    areaWorktrees: {},
    lastRunningAt: {},
    pinnedSessions: {},
    terminalNames: {},
    titleModel: "first_line",
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
      const res = await syncPlugin(syncPluginRpc, "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const value = Math.floor(Math.random() * 16);
        return (c === "x" ? value : (value & 3) | 8).toString(16);
      }));
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
  const [projectSections, setProjectSections] = useState<Record<string, "areas" | "pools">>({});
  const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>({});
  const [expandedAreaIds, setExpandedAreaIds] = useState<Record<string, boolean>>({});
  const [creatingAreaIds, setCreatingAreaIds] = useState<Record<string, boolean>>({});
  const [expandedAllChats, setExpandedAllChats] = useState<Record<string, boolean>>({});
  const [showHiddenProjects, setShowHiddenProjects] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [creatingTerminalId, setCreatingTerminalId] = useState<string | null>(null);
  const [newAgentWorkspaceId, setNewAgentWorkspaceId] = useState<string | null>(null);
  const [newAgentModels, setNewAgentModels] = useState<PaseoProviderSnapshotResult["entries"]>([]);
  const [preferredModeId, setModeId] = useState<string | undefined>();
  const [preferredThinkingOptionId, setThinkingOptionId] = useState<string | undefined>();
  const [newAgentModel, setNewAgentModel] = useState<string | null>(null);
  const creationOptions = agentCreationOptions(newAgentModels, newAgentModel, {
    modeId: preferredModeId, thinkingOptionId: preferredThinkingOptionId,
  });
  const { modeId, thinkingOptionId } = creationOptions;
  const changeAgentModel = (model: string) => {
    const next = agentCreationOptions(newAgentModels, model, { modeId, thinkingOptionId });
    setNewAgentModel(model);
    setModeId(next.modeId);
    setThinkingOptionId(next.thinkingOptionId);
  };
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const [newTerminalTitle, setNewTerminalTitle] = useState<string | null>(null);
  const [newSessionKind, setNewSessionKind] = useState<"agent" | "terminal">("agent");
  const [newAgentModelsError, setNewAgentModelsError] = useState<string | null>(null);
  const agentModelsRequest = useRef(0);
  const [newArea, setNewArea] = useState<{
    projectId: string;
    name: string;
    firstTab: "session" | "terminal";
    workspaceId?: string;
    /** Уже имеющаяся область проекта, куда добавить сессию вместо создания новой. */
    targetWorkspaceId?: string;
    /** Где создать новую область: в папке проекта или в своем worktree на ветке. */
    place?: "project" | "existing" | "new";
    branch?: string;
    newBranch?: string;
    baseBranch?: string;
    /** Путь, вписанный вручную; иначе путь по умолчанию рядом с проектом. */
    worktreePath?: string;
  } | null>(null);
  const [worktreeOptions, setWorktreeOptions] = useState<{
    projectId: string; isGit: boolean; rootPath: string; branches: string[]; checkedOut: string[]; currentBranch: string | null;
  } | null>(null);
  const [worktreeArchive, setWorktreeArchive] = useState<{
    chat: PaseoWorkspace; path: string; branch: string; exists: boolean; changes: string[];
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
  const [draftHidden, setDraftHidden] = useState(false);
  const [draftPinned, setDraftPinned] = useState(false);
  const [titleProviders, setTitleProviders] = useState<PaseoProviderSnapshotResult["entries"]>([]);
  const [titleModelsError, setTitleModelsError] = useState<string | null>(null);
  const [confirmRemoveProject, setConfirmRemoveProject] = useState(false);
  const [savingProject, setSavingProject] = useState(false);

  // Панель области и ее настройки
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [areaSessionFilter, setAreaSessionFilter] = useState<(typeof AREA_SESSION_FILTERS)[number]["value"]>("all");
  const [draftChatTitle, setDraftChatTitle] = useState<string | null>(null);
  const [draftTitleSelection, setDraftTitleSelection] = useState<{ start: number; end: number }>();
  const draftTitleRevision = useRef(0);
  const [savingChat, setSavingChat] = useState(false);
  const titleSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingTitleSaves = useRef(0);
  const areaTitleInput = useRef<React.ElementRef<typeof TextInput>>(null);
  const [areaSettings, setAreaSettings] = useState<z.infer<typeof areaSettingsRpc.output> | null>(null);
  const [areaSettingsError, setAreaSettingsError] = useState<string | null>(null);
  const [suggestingTitle, setSuggestingTitle] = useState(false);
  const [agentMenuId, setAgentMenuId] = useState<string | null>(null);
  const closingAgentIds = useRef(new Set<string>());
  const [draftAgentTitle, setDraftAgentTitle] = useState<string | null>(null);
  const [suggestingAgentTitle, setSuggestingAgentTitle] = useState(false);
  const terminalNameInput = useRef<React.ElementRef<typeof TextInput>>(null);
  const agentTitleInput = useRef<React.ElementRef<typeof TextInput>>(null);
  const [confirmClosingSession, setConfirmClosingSession] = useState(false);
  const [terminalMenuId, setTerminalMenuId] = useState<string | null>(null);
  const [draftTerminalName, setDraftTerminalName] = useState<string | null>(null);
  const [projectSettingsTab, setProjectSettingsTab] = useState<"areas" | "pools">("areas");
  const [projectIconOpen, setProjectIconOpen] = useState(false);
  const [projectNameFocused, setProjectNameFocused] = useState(false);
  const projectNameInput = useRef<React.ElementRef<typeof TextInput>>(null);
  const savedProjectName = useRef<string | null>(null);
  const [areaTitleFocused, setAreaTitleFocused] = useState(false);
  const [agentTitleFocused, setAgentTitleFocused] = useState(false);
  const [terminalNameFocused, setTerminalNameFocused] = useState(false);
  const savedAreaRevision = useRef(-1);
  const savedAgentTitle = useRef<string | null>(null);
  const savedTerminalName = useRef<string | null>(null);
  const [confirmClosingTerminal, setConfirmClosingTerminal] = useState(false);
  const [chatTransferOpen, setChatTransferOpen] = useState(false);
  const [transferTargetProjectId, setTransferTargetProjectId] = useState<string>("");
  const [transferArchiveOriginal, setTransferArchiveOriginal] = useState<boolean>(true);
  const [transferIncludeHistory, setTransferIncludeHistory] = useState<boolean>(true);
  const [transferringChat, setTransferringChat] = useState<boolean>(false);
  const chatMutationPending = savingChat || transferringChat;

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
      void readAreaBranches({ workspaceIds: nextWorkspaces.map((w) => w.id) })
        .then(({ branches, kinds }) => { setAreaBranches(branches); setAreaCheckoutKinds(kinds); }, () => {});
    } catch {
      // Сохраняем прошлый снимок при временной сетевой ошибке.
    }
    await terminalRefresh;
  }, [paseo, readSidebar]);

  useEffect(() => {
    void reloadAll();
    const unsubWs = paseo.workspaces.subscribe(() => void reloadAll());
    const unsubPrj = paseo.projects.subscribe(() => void reloadAll());
    const unsubAg = paseo.agents.subscribe(update => setAgents(entries => applyAgentUpdate(entries, update)));
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

  const agentsByWorkspace = useMemo(() => groupAreaAgents(agents), [agents]);

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
  const closedFilter = areaSessionFilter === "closed";
  const visibleAreaAgents = areaSessionFilter === "terminals" || closedFilter ? [] : editingChatEntries;
  const visibleAreaTerminals = areaSessionFilter === "agents" || closedFilter ? [] : editingChatTerminals;
  const visibleAreaSessions = orderAreaSessions(visibleAreaAgents, visibleAreaTerminals, serverState.pinnedSessions);
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
  const terminalMenuWorkspace = workspaces.find(workspace => workspace.id === terminalMenuItem?.workspaceId);
  useEffect(() => {
    if (agentMenuId || terminalMenuId) void reloadAll();
  }, [agentMenuId, terminalMenuId, reloadAll]);
  const terminalLabel = (terminal: PaseoTerminal) => serverState.terminalNames[terminal.id] ?? terminal.name;
  const titleSourceAgent = editingChatEntries[0]?.agent;
  const titleModel = serverState.titleModel;
  const canSuggestTitle = Boolean(titleSourceAgent) && !suggestingTitle && !chatMutationPending;
  const agentMenuChat = agents.find(({ agent }) =>
    agent.id === agentMenuId && agent.workspaceId && !agent.archivedAt && !agent.internal,
  )?.agent;
  const newSessionWorkspace = workspaces.find(workspace => workspace.id === newAgentWorkspaceId);
  const newAreaGroup = newArea ? allGroups.find((item) => item.id === newArea.projectId) : undefined;
  const newAreaTarget = newArea?.targetWorkspaceId
    ? newAreaGroup?.chats.find((chat) => chat.id === newArea.targetWorkspaceId)
    : undefined;
  const freeBranches = worktreeOptions ? worktreeOptions.branches.filter((branch) => !worktreeOptions.checkedOut.includes(branch)) : [];
  const newAreaPlace = newArea?.place ?? "project";
  const newAreaBranch = newAreaPlace === "existing" ? newArea?.branch ?? freeBranches[0] ?? ""
    : newAreaPlace === "new" ? newArea?.newBranch?.trim() ?? "" : "";
  const newAreaBaseBranch = newArea?.baseBranch ?? worktreeOptions?.currentBranch ?? worktreeOptions?.branches[0] ?? "";
  const newAreaWorktreePath = newAreaPlace === "project" || !worktreeOptions ? ""
    : newArea?.worktreePath ?? (newAreaBranch ? defaultWorktreePath(worktreeOptions.rootPath, newAreaBranch) : "");
  const newAreaFolder = newAreaPlace !== "project" ? newAreaWorktreePath || "Укажите ветку"
    : !newAreaGroup ? ""
    : newAreaGroup.rootPath;
  const creationFolder = newArea ? newAreaTarget?.workspaceDirectory ?? newAreaFolder : newSessionWorkspace?.workspaceDirectory;
  const defaultTerminalTitle = `Terminal ${terminals.filter(terminal => terminal.cwd === creationFolder).length + 1}`;
  const terminalCreationTitle = newTerminalTitle ?? defaultTerminalTitle;
  const creationNaming = (kind: "agent" | "terminal"): SessionNaming => kind === "agent"
    ? { value: newSessionTitle, onChange: setNewSessionTitle }
    : { value: terminalCreationTitle, onChange: setNewTerminalTitle };
  const hqWindowOpen = Boolean(worktreeArchive) || addModalOpen || Boolean(editingGroup) || Boolean(newArea) || Boolean(editingChat)
    || Boolean(newAgentWorkspaceId) || Boolean(agentMenuChat) || Boolean(terminalMenuItem) || panelSettingsOpen;

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

  const jumpToAgent = async (agentId: string) => {
    try {
      await openAgentTab({ agentId }, { openScreen });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось открыть чат агента");
    }
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
      // Модель берем у последней сессии проекта из уже загруженного списка агентов: без запросов к провайдерам.
      const preferred = await projectAgentConfig(paseo, group, agents);
      if (request !== agentModelsRequest.current) return;
      setNewAgentModel(preferred.provider);
      setModeId(preferred.modeId);
      setThinkingOptionId(preferred.thinkingOptionId);
      // Полный список нужен только для выбора из него. Кэш показывает прошлый список сразу и не дергает
      // провайдеров, пока он свежий (корень проекта как ключ, а не папка каждой области).
      const applySnapshot = (snapshot: NonNullable<ReturnType<typeof peekProviders>>) => {
        const available = snapshot.entries.filter(entry => entry.enabled && entry.status === "ready");
        const options = titleModelOptions(available, "first_line").filter(option => option.provider);
        setNewAgentModels(available);
        setNewAgentModel((current) => current && (options.some(option => option.value === current) || snapshot.entries.some(entry => entry.status === "loading"))
          ? current : options[0]?.value ?? current);
        if (!options.length && !snapshot.entries.some(entry => entry.status === "loading")) setNewAgentModelsError("Нет доступных моделей для нового агента");
      };
      const known = peekProviders(paseo, group.rootPath);
      if (known) applySnapshot(known);
      void providersSnapshot(paseo, group.rootPath, { onUpdate: snapshot => {
        if (request === agentModelsRequest.current) applySnapshot(snapshot);
      } }).then((snapshot) => {
        if (request === agentModelsRequest.current && snapshot !== known) applySnapshot(snapshot);
      }).catch((error) => {
        if (request === agentModelsRequest.current) setNewAgentModelsError(
          error instanceof Error ? error.message : "Не удалось загрузить модели");
      });
    } catch (error) {
      if (request === agentModelsRequest.current) setNewAgentModelsError(
        error instanceof Error ? error.message : "Не удалось загрузить модели");
    }
  };

  const changeCreationKind = (kind: "agent" | "terminal") => {
    if (newArea) setNewArea({ ...newArea, firstTab: kind === "agent" ? "session" : "terminal" });
    else setNewSessionKind(kind);
  };

  const openNewArea = (group: ProjectGroup) => {
    setNewSessionTitle("");
    setNewTerminalTitle(null);
    setNewArea({ projectId: group.id, name: "Новая область", firstTab: "session", place: "project" });
    setWorktreeOptions(null);
    void prepareAgentModels(group);
    void readWorktreeOptions({ projectId: group.id })
      .then((options) => setWorktreeOptions({ projectId: group.id, ...options }))
      .catch(() => setWorktreeOptions(null));
  };

  const openNewAreaAgent = (workspaceId: string) => {
    const group = allGroups.find(item => item.chats.some(chat => chat.id === workspaceId));
    if (!group) return;
    setNewSessionTitle("");
    setNewTerminalTitle(null);
    setNewSessionKind("agent");
    setNewAgentWorkspaceId(workspaceId);
    void prepareAgentModels(group, workspaceId);
  };

  const handleCreateAreaSession = async (workspaceId: string) => {
    if (!newAgentModel) return;
    if (creatingAreaIds[workspaceId]) return;
    setCreatingAreaIds((prev) => ({ ...prev, [workspaceId]: true }));
    try {
      const { agentId } = await createAreaSession({ workspaceId, model: newAgentModel, modeId, thinkingOptionId, title: newSessionTitle.trim() });
      setExpandedAreaIds((prev) => ({ ...prev, [workspaceId]: true }));
      setEditingChatId((current) => current === workspaceId ? null : current);
      setNewAgentWorkspaceId(null);
      setNewArea(null);
      await jumpToAgent(agentId);
      void reloadAll();
    } catch (error) {
      clearProviders(paseo);
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
      const terminal = await paseo.workspaces.ref(workspaceId).terminals.create({ name: terminalCreationTitle.trim() || defaultTerminalTitle });
      const snapshot = terminal.current();
      if (!snapshot) throw new Error("Терминал создан, но его данные недоступны");
      setExpandedAreaIds((prev) => ({ ...prev, [workspaceId]: true }));
      setEditingChatId((current) => current === workspaceId ? null : current);
      setNewAgentWorkspaceId(null);
      setNewArea(null);
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
      if (!workspaceId && newAreaPlace !== "project") {
        if (newArea.firstTab === "session" && !newAgentModel) throw new Error("Выберите модель агента");
        if (!newAreaBranch) throw new Error(newAreaPlace === "new" ? "Впишите имя новой ветки" : "Выберите ветку");
        const created = await createAreaWorktree({
          projectId: group.id,
          title: newArea.name.trim() || "Новая область",
          path: newAreaWorktreePath,
          branch: newAreaBranch,
          newBranch: newAreaPlace === "new",
          baseBranch: newAreaPlace === "new" ? newAreaBaseBranch : undefined,
          modeId, thinkingOptionId,
          agentModel: newArea.firstTab === "session" ? newAgentModel ?? undefined : undefined,
          agentTitle: newSessionTitle.trim(),
        });
        workspaceId = created.workspaceId;
        setNewArea({ ...newArea, workspaceId });
      }
      if (!workspaceId) {
        if (newArea.firstTab === "session" && !newAgentModel) throw new Error("Выберите модель агента");
        const agent = newArea.firstTab === "session"
          ? { config: { provider: newAgentModel!, modeId, thinkingOptionId }, title: newSessionTitle.trim() || undefined, cwd: group.rootPath }
          : undefined;
        const created = await paseo.workspaces.create({
          title: newArea.name.trim() || "Новая область",
          agent,
          source: { kind: "directory", path: group.rootPath, projectId: group.id },
        });
        workspaceId = created.id;
        setNewArea({ ...newArea, workspaceId });
      }

      setExpandedProjectIds((prev) => ({ ...prev, [group.id]: true }));
      setExpandedAreaIds((prev) => ({ ...prev, [workspaceId]: true }));
      if (newArea.firstTab === "terminal") {
        const terminal = await paseo.workspaces.ref(workspaceId).terminals.create({ name: terminalCreationTitle.trim() || defaultTerminalTitle });
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
    if (!panelSettingsOpen) return;
    let cancelled = false;
    setTitleModelsError(null);
    const projectRoot = (editingChat ?? agentMenuWorkspace)?.projectRootPath;
    const known = peekProviders(paseo, projectRoot);
    if (known) setTitleProviders(known.entries);
    void providersSnapshot(paseo, projectRoot).then(snapshot => {
      if (!cancelled) setTitleProviders(snapshot.entries);
    }).catch(error => {
      if (!cancelled) setTitleModelsError(error instanceof Error ? error.message : "Каталог моделей недоступен");
    });
    return () => { cancelled = true; };
  }, [panelSettingsOpen, paseo]);

  const openProjectSettings = (group: ProjectGroup) => {
    setEditingProjectId(group.id);
    setDraftProjectName(group.customName ?? group.name);
    setDraftAvatarUrl("");
    setDraftAvatarUpdate({ kind: "keep" });
    setDraftHidden(group.meta.hidden);
    setDraftPinned(group.meta.pinned);
    setConfirmRemoveProject(false);
    setProjectIconOpen(false);
    savedProjectName.current = null;
  };

  const handlePickWebFile = async () => {
    const uri = await pickWebImageAsDataUri();
    if (uri) {
      setDraftAvatarUpdate({ kind: "dataUri", dataUri: uri });
      setDraftAvatarUrl("");
    }
  };

  // Каждая правка проекта сохраняется сразу, как в действиях области.
  const saveProjectPatch = async (patch: {
    customName?: string | null;
    avatar?: AvatarUpdate;
    hiddenSections?: ("areas" | "pools")[];
    hidden?: boolean;
    pinned?: boolean;
  }) => {
    if (!editingGroup) return false;
    setSavingProject(true);
    try {
      const updated = await saveProject({ projectId: editingGroup.id, ...patch });
      setServerState((prev) => ({
        ...prev,
        ...updated,
        nativeIcons: { ...prev.nativeIcons, ...updated.nativeIcons },
      }));
      await reloadAll();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить настройки проекта");
      return false;
    } finally {
      setSavingProject(false);
    }
  };

  const commitProjectName = () => {
    if (!editingGroup) return;
    const trimmedName = draftProjectName.trim();
    const folderName = editingGroup.rootPath.split("/").pop() || "";
    const customName = trimmedName === "" || trimmedName === folderName ? null : trimmedName;
    if (customName === (editingGroup.customName ?? null)) return;
    // Потеря фокуса и закрытие окна приходят вместе: одну правку сохраняем один раз.
    const key = `${editingGroup.id}:${customName ?? ""}`;
    if (savedProjectName.current === key) return;
    savedProjectName.current = key;
    void saveProjectPatch({ customName });
  };

  const acceptProjectName = () => {
    commitProjectName();
    projectNameInput.current?.blur();
  };

  const applyProjectIcon = async () => {
    const trimmedUrl = draftAvatarUrl.trim();
    const avatar: AvatarUpdate = trimmedUrl ? { kind: "urlOrPath", value: trimmedUrl } : draftAvatarUpdate;
    if (await saveProjectPatch({ avatar })) {
      setDraftAvatarUrl("");
      setDraftAvatarUpdate({ kind: "keep" });
      setProjectIconOpen(false);
      toast.show("Иконка проекта обновлена", { variant: "success" });
    }
  };

  const openPanelSettings = () => {
    setDraftHeaderTitle(serverState.headerTitle || "Штаб");
    setPanelSettingsOpen(true);
  };

  const handleSaveHeaderTitle = async () => {
    if (savingPanelSettings) return;
    const nextTitle = draftHeaderTitle.trim() || "Штаб";
    if (nextTitle === serverState.headerTitle) return;
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
    setAgentMenuId(null);
    setChatTransferOpen(false);
    updateDraftChatTitle(null);
    const others = allGroups.filter((g) => g.id !== chat.projectId);
    setTransferTargetProjectId(others[0]?.id || "");
    setTransferArchiveOriginal(true);
    setTransferIncludeHistory(true);
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
    // Потеря фокуса и закрытие окна приходят вместе: одну правку сохраняем один раз.
    if (savedAreaRevision.current === revision) return;
    savedAreaRevision.current = revision;
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

  const acceptAreaTitle = () => {
    handleRenameChat();
    areaTitleInput.current?.blur();
  };

  // Единая модель панели. Название остается черновиком до сохранения.
  const handleSuggestTitle = async (model: string) => {
    if (!editingChat || !titleSourceAgent || !canSuggestTitle) return;
    if (draftChatTitle === null) startAreaTitleEdit();
    const revision = draftTitleRevision.current;
    setSuggestingTitle(true);
    try {
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

  const agentTitleModel = serverState.titleModel;

  const handleRenameAgent = async () => {
    const title = draftAgentTitle?.trim();
    if (!agentMenuChat?.workspaceId || draftAgentTitle === null) return;
    if (!title || title === (agentMenuChat.title ?? "")) {
      setDraftAgentTitle(null);
      return;
    }
    const { workspaceId, id: agentId } = agentMenuChat;
    if (savedAgentTitle.current === `${agentId}:${title}`) return;
    savedAgentTitle.current = `${agentId}:${title}`;
    try {
      await renameAgent({ workspaceId, agentId, title });
      setDraftAgentTitle(null);
      await reloadAll();
      toast.show("Агент переименован", { variant: "success" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось переименовать агента");
    }
  };

  const acceptAgentTitle = () => {
    void handleRenameAgent();
    agentTitleInput.current?.blur();
  };

  const handleSuggestAgentTitle = async (model: string) => {
    if (!agentMenuChat?.workspaceId || !agentMenuWorkspace || suggestingAgentTitle || chatMutationPending) return;
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
    setDraftAgentTitle(null);
    savedAgentTitle.current = null;
    setConfirmClosingSession(false);
    setAgentMenuId(agentId);
  };

  const handleAgentMenuAction = async (action: "reload" | "close") => {
    const workspaceId = agentMenuChat?.workspaceId;
    if (!workspaceId || !agentMenuChat || chatMutationPending) return;
    const agentId = agentMenuChat.id;
    if (action === "close") {
      if (closingAgentIds.current.has(agentId)) return;
      closingAgentIds.current.add(agentId);
      // Only this agent is closing. Keep the sidebar usable during daemon cleanup.
      setAgentMenuId(null);
      try {
        await paseo.agents.ref(agentId).archive();
        setAgents(entries => entries.filter(entry => entry.agent.id !== agentId));
        void queryClient.invalidateQueries({ queryKey: ["hq-closed-agents", host.id, workspaceId] });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Не удалось закрыть агента");
      } finally {
        closingAgentIds.current.delete(agentId);
      }
      return;
    }
    setSavingChat(true);
    try {
      await paseo.agents.ref(agentId).reload();
      await reloadAll();
      setAgentMenuId(null);
      toast.show("Агент перезагружен", { variant: "success" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось обновить агента");
    } finally {
      setSavingChat(false);
    }
  };

  const openTerminalMenu = (terminalId: string) => {
    setDraftTerminalName(null);
    savedTerminalName.current = null;
    setConfirmClosingTerminal(false);
    setTerminalMenuId(terminalId);
  };

  const handleRenameTerminal = async () => {
    if (!terminalMenuItem || draftTerminalName === null) return;
    const terminal = terminalMenuItem;
    const title = draftTerminalName.trim();
    if (savedTerminalName.current === `${terminal.id}:${title}`) return;
    savedTerminalName.current = `${terminal.id}:${title}`;
    setDraftTerminalName(null);
    // Пустое название возвращает исходное имя терминала.
    if (title === terminalLabel(terminal) || (!title && !serverState.terminalNames[terminal.id])) return;
    try {
      setServerState(await renameTerminal({
        terminalId: terminal.id,
        title: title && title !== terminal.name ? title : null,
        projectIds: allGroups.map((g) => g.id),
      }));
      toast.show("Терминал переименован", { variant: "success" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось переименовать терминал");
    }
  };

  const acceptTerminalName = () => {
    void handleRenameTerminal();
    terminalNameInput.current?.blur();
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

  // Закрепление областей, агентов и терминалов хранится в одной карте pinnedSessions по id.
  const togglePin = async (chatId: string, messages: { pinned: string; unpinned: string }, afterSave: () => void) => {
    if (chatMutationPending) return;
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
      afterSave();
      toast.show(nextPinned ? messages.pinned : messages.unpinned, { variant: "info" });
    } catch (err) {
      await reloadAll();
      toast.error(err instanceof Error ? err.message : "Не удалось изменить закрепление");
    } finally {
      setSavingChat(false);
    }
  };

  const handleTogglePinChat = () => {
    if (!editingChat) return Promise.resolve();
    return togglePin(editingChat.id, { pinned: "Область закреплена наверху", unpinned: "Область откреплена" },
      () => setEditingChatId(null));
  };

  const handleTogglePinAgent = (agentId: string) => togglePin(
    agentId,
    { pinned: "Агент закреплен наверху", unpinned: "Агент откреплен" },
    () => setAgentMenuId(null),
  );

  const handleTogglePinTerminal = (terminalId: string) => togglePin(
    terminalId,
    { pinned: "Терминал закреплен наверху", unpinned: "Терминал откреплен" },
    () => setTerminalMenuId(null),
  );

  // Папку worktree, созданную Штабом, Paseo при архивации не удаляет: сначала спрашиваем, что с ней делать.
  const handleArchiveChat = async (chat: PaseoWorkspace, worktreeDecision?: "keep" | "remove" | "force") => {
    if (chatMutationPending) return;
    if (!worktreeDecision && serverState.areaWorktrees[chat.id]) {
      try {
        const info = await readAreaWorktree({ workspaceId: chat.id });
        if (info.worktree) {
          setWorktreeArchive({ chat, ...info.worktree, exists: info.exists, changes: info.changes });
          return;
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Не удалось проверить папку worktree");
        return;
      }
    }
    setSavingChat(true);
    try {
      setArchivedIds((prev) => ({ ...prev, [chat.id]: true }));
      const { error } = await paseo.workspaces.archive(chat.id);
      if (error) throw new Error(error);
      if (editingChatId === chat.id) {
        setEditingChatId(null);
      }
      setWorktreeArchive(null);
      if (worktreeDecision === "remove" || worktreeDecision === "force") {
        await removeAreaWorktree({ workspaceId: chat.id, force: worktreeDecision === "force" }).catch((err) => {
          toast.error(`Область в архиве, но папку не удалось удалить: ${err instanceof Error ? err.message : err}`);
        });
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
            const sections = ([{ key: "areas", label: "Области" }, { key: "pools", label: "Пулы" }] as const)
              .filter(tab => !group.meta.hiddenSections.includes(tab.key));
            const section = sections.find(tab => tab.key === projectSections[group.id])?.key ?? sections[0]?.key;
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

                  {section === "areas" ? <Pressable
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
                  </Pressable> : null}
                </View>

                {isOpen && sections.length ? <View style={{ flexDirection: "row", gap: 4, paddingHorizontal: 10, paddingBottom: 8 }}>
                  {sections.map((tab) => <Pressable key={tab.key} accessibilityRole="tab" accessibilityState={{ selected: section === tab.key }} onPress={() => setProjectSections((prev) => ({ ...prev, [group.id]: tab.key }))} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 7, backgroundColor: section === tab.key ? c.surface2 : "transparent" }}><Text style={{ color: section === tab.key ? c.foreground : c.foregroundMuted, fontSize: 12, fontWeight: section === tab.key ? "600" : "400" }}>{tab.label}</Text></Pressable>)}
                </View> : null}
                {isOpen && section === "pools" ? <View style={{ borderTopWidth: 1, borderTopColor: c.border, padding: 16, gap: 5 }}><Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>Пул генераций</Text><Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Сервис готовится. Здесь появятся пулы генераций проекта.</Text></View> : null}

                {/* Строки областей внутри раскрытого проекта */}
                {isOpen && section === "areas" && group.chats.length > 0 ? (
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
                              <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                                <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>
                                  {title}
                                </Text>
                                {!expanded ? (
                                  <AreaSessionBadges sessions={sessions} terminalCount={areaTerminals.length}
                                    theme={theme} platform={layout.platform} />
                                ) : (
                                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                                    <Pressable accessibilityRole="button" accessibilityLabel={`Новая сессия в области ${title}`}
                                      disabled={chatMutationPending} hitSlop={4}
                                      onPress={(event) => { event.stopPropagation(); openNewAreaAgent(chat.id); }}
                                      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4,
                                        minHeight: 28, paddingHorizontal: 6, borderRadius: 6, backgroundColor: c.accent,
                                        opacity: chatMutationPending || pressed ? 0.65 : 1 })}>
                                      <Icon name="Plus" size={11} color={c.accentForeground} />
                                      <Icon name="Bot" size={12} color={c.accentForeground} />
                                    </Pressable>
                                    {areaBranches[chat.id] ?? serverState.areaWorktrees[chat.id]?.branch ? (
                                      <View style={{ flexShrink: 1, minWidth: 0 }}>
                                        <AreaBranchBadge branch={(areaBranches[chat.id] ?? serverState.areaWorktrees[chat.id]?.branch)!} path={chat.workspaceDirectory} kind={areaCheckoutKinds[chat.id]} theme={theme} />
                                      </View>
                                    ) : null}
                                  </View>
                                )}
                              </View>
                              {isPinned ? <Icon name="Pin" size={12} color={c.accent} /> : null}
                            </Pressable>
                            <Pressable accessibilityRole="button"
                              accessibilityLabel={`${expanded ? "Свернуть" : "Развернуть"} область ${title}`}
                              aria-expanded={expanded}
                              onPress={() => setExpandedAreaIds(prev => ({ ...prev, [chat.id]: !prev[chat.id] }))}
                              style={({ pressed }) => ({ width: layout.compact ? 26 : 22, height: btnSize, borderRadius: 8,
                                transform: [{ translateY: expanded ? -4 : 0 }],
                                alignItems: "center", justifyContent: "center", backgroundColor: pressed ? c.surface2 : undefined })}>
                              <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={c.foregroundMuted} />
                            </Pressable>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Действия области ${title}`}
                              onPress={() => openAreaActions(chat)}
                              style={({ pressed }) => ({
                                width: btnSize, height: btnSize, borderRadius: 8,
                                transform: [{ translateY: expanded ? -4 : 0 }],
                                alignItems: "center", justifyContent: "center",
                                backgroundColor: pressed ? c.surface2 : undefined,
                              })}
                            >
                              <Icon name="LayoutGrid" size={16} color={c.foreground} />
                            </Pressable>
                          </View>
                          {expanded ? (
                            <View style={{
                              marginTop: 2, marginBottom: 8, padding: 4, gap: 2,
                              borderRadius: 10, backgroundColor: c.surface2,
                              borderWidth: 1, borderColor: c.border,
                            }}>
                              {orderAreaSessions(sessions, areaTerminals, serverState.pinnedSessions).map((session) => session.kind === "terminal" ? (
                                <TerminalRow key={session.id} terminal={session.terminal} label={terminalLabel(session.terminal)} theme={theme}
                                  nested selected={activeSession === `terminal_${session.id}`}
                                  pinned={Boolean(serverState.pinnedSessions[session.id])}
                                  disabled={chatMutationPending}
                                  onMenu={() => openTerminalMenu(session.id)}
                                  onOpen={() => openAreaTerminal(session.terminal)} />
                              ) : (
                                <View key={session.id} style={{ flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 8, backgroundColor: activeSession === `agent_${session.id}` ? c.surface1 : undefined }}>
                                  <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={`Открыть агента ${agentTitle(session.entry.agent)}`}
                                    aria-selected={activeSession === `agent_${session.id}`}
                                    onPress={() => jumpToAgent(session.id)}
                                    style={({ pressed }) => ({
                                      flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center",
                                      paddingLeft: NESTED_ITEM_INSET, paddingRight: 10, paddingTop: 3, paddingBottom: 7, minHeight: 44, borderRadius: 8,
                                      backgroundColor: pressed ? c.surface2 : undefined,
                                    })}
                                  >
                                    <AgentSummary agent={session.entry.agent} theme={theme} platform={layout.platform} gap={NESTED_ITEM_GAP} selected={activeSession === `agent_${session.id}`} />
                                  </Pressable>
                                  {serverState.pinnedSessions[session.id] ? <Icon name="Pin" size={12} color={c.accent} /> : null}
                                  <ChatActionButton
                                    label={`Меню агента ${agentTitle(session.entry.agent)}`}
                                    icon="MoreHorizontal"
                                    quiet
                                    disabled={chatMutationPending}
                                    onPress={() => openAgentMenu(session.id)}
                                    theme={theme}
                                  />
                                </View>
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

      <HqModalLayer visible={hqWindowOpen}>
      {/* Модальное окно добавления проекта */}
      <HqModal theme={theme}
        title="Добавить проект"
        open={addModalOpen}
        onOpenChange={(open) => {
          if (!open) setAddModalOpen(false);
        }}
      >
        <HqModal.Content>
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
        </HqModal.Content>
      </HqModal>

      {/* Модальное окно настроек проекта */}
      <HqModal theme={theme}
        title="Настройки проекта"
        open={Boolean(editingGroup)}
        onOpenChange={(open) => {
          if (!open) {
            commitProjectName();
            setProjectIconOpen(false);
            setEditingProjectId(null);
            setConfirmRemoveProject(false);
          }
        }}
        actionsDisabled={savingProject}
        actions={editingGroup ? [
          {
            label: draftPinned ? "Открепить проект" : "Закрепить проект",
            icon: draftPinned ? "PinOff" : "Pin",
            color: draftPinned ? c.accent : undefined,
            onPress: () => {
              const next = !draftPinned;
              setDraftPinned(next);
              void saveProjectPatch({ pinned: next });
            },
          },
          {
            label: draftHidden ? "Показать проект в основном списке" : "Скрыть проект из основного списка",
            icon: draftHidden ? "Eye" : "EyeOff",
            color: draftHidden ? c.accent : undefined,
            onPress: () => {
              const next = !draftHidden;
              setDraftHidden(next);
              void saveProjectPatch({ hidden: next });
            },
          },
          {
            label: confirmRemoveProject ? "Нажмите еще раз, чтобы убрать проект" : "Убрать проект из списка Paseo",
            icon: "Trash2", danger: true,
            onPress: () => void handleRemoveProject(),
          },
        ] : []}
      >
        <HqModal.Content>
          {editingGroup ? (
            <View style={{ gap: 16 }}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Иконка проекта"
                    onPress={() => {
                      setDraftAvatarUrl("");
                      setDraftAvatarUpdate({ kind: "keep" });
                      setProjectIconOpen(true);
                    }}
                    style={({ pressed }) => ({
                      width: 44, height: 44, borderRadius: 9, alignItems: "center", justifyContent: "center",
                      borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface1 : c.surface2,
                    })}
                  >
                    <ProjectAvatar
                      name={draftProjectName || editingGroup.name}
                      projectId={editingGroup.id}
                      avatarUri={previewAvatar.uri}
                      emoji={previewAvatar.emoji}
                      bg={previewAvatar.bg}
                      size={32}
                    />
                  </Pressable>
                  <View style={{
                    flex: 1, minWidth: 0, height: 44, flexDirection: "row", alignItems: "center",
                    paddingHorizontal: 12, borderRadius: 9, borderWidth: 1, backgroundColor: c.surface2,
                    borderColor: projectNameFocused ? c.accent : c.border,
                  }}>
                    <TextInput
                      ref={projectNameInput}
                      accessibilityLabel="Название проекта"
                      value={draftProjectName}
                      onChangeText={(value) => {
                        savedProjectName.current = null;
                        setDraftProjectName(value);
                      }}
                      onFocus={() => setProjectNameFocused(true)}
                      onBlur={() => {
                        setProjectNameFocused(false);
                        commitProjectName();
                      }}
                      onSubmitEditing={acceptProjectName}
                      placeholder={editingGroup.rootPath.split("/").pop() || "Проект"}
                      placeholderTextColor={c.foregroundMuted}
                      maxLength={200}
                      style={{ flex: 1, minWidth: 0, padding: 0, outlineWidth: 0, color: c.foreground, fontSize: 15 }}
                    />
                  </View>
                  {projectNameFocused ? (
                    <ChatActionButton
                      label="Принять название"
                      icon="Check"
                      color={c.accent}
                      onPressIn={acceptProjectName}
                      onPress={acceptProjectName}
                      theme={theme}
                    />
                  ) : null}
                </View>
                <SessionInformation theme={theme} path={editingGroup.rootPath} project />
                <View style={{ marginTop: 10, padding: 12, gap: 8, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 }}>
                  <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 4 }}>
                    {([{ key: "areas", label: "Области" }, { key: "pools", label: "Пулы" }] as const).map(tab => (
                      <Pressable key={tab.key} accessibilityRole="tab" accessibilityState={{ selected: projectSettingsTab === tab.key }}
                        onPress={() => setProjectSettingsTab(tab.key)}
                        style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 7, backgroundColor: projectSettingsTab === tab.key ? c.surface1 : "transparent" }}>
                        <Text style={{ color: projectSettingsTab === tab.key ? c.foreground : c.foregroundMuted, fontSize: 12, fontWeight: projectSettingsTab === tab.key ? "600" : "400" }}>{tab.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <SettingsSwitch
                    label="Показывать в сайдбаре"
                    value={!editingGroup.meta.hiddenSections.includes(projectSettingsTab)}
                    onValueChange={(visible) => {
                      if (savingProject) return;
                      void saveProjectPatch({ hiddenSections: visible
                        ? editingGroup.meta.hiddenSections.filter(key => key !== projectSettingsTab)
                        : [...editingGroup.meta.hiddenSections, projectSettingsTab] });
                    }}
                  />
                </View>
              </View>

              {confirmRemoveProject ? (
                <Text style={{ color: c.statusDanger, fontSize: 13 }}>
                  Нажмите корзину еще раз, чтобы убрать проект из Paseo (файлы останутся).
                </Text>
              ) : null}
            </View>
          ) : null}
        </HqModal.Content>
      </HqModal>

      {/* Иконка или картинка проекта */}
      <HqModal theme={theme}
        narrow
        title="Иконка проекта"
        open={projectIconOpen && Boolean(editingGroup)}
        onOpenChange={(open) => {
          if (open) return;
          setProjectIconOpen(false);
          setDraftAvatarUrl("");
          setDraftAvatarUpdate({ kind: "keep" });
        }}
      >
        <HqModal.Content>
          {editingGroup ? (
            <View style={{ gap: 16 }}>
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
                            accessibilityLabel={`Выбрать ${em}`}
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

              <Pressable
                accessibilityRole="button"
                disabled={savingProject}
                onPress={() => void applyProjectIcon()}
                style={({ pressed }) => ({
                  paddingVertical: 13, borderRadius: 10, alignItems: "center", justifyContent: "center",
                  backgroundColor: c.accent, opacity: savingProject ? 0.5 : pressed ? 0.85 : 1,
                })}
              >
                <Text style={{ color: "#FFFFFF", fontSize: 15, fontWeight: "700" }}>
                  {savingProject ? "Сохранение..." : "Применить"}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </HqModal.Content>
      </HqModal>

      {newArea ? (
        <NewSessionWindow
          theme={theme}
          key={newAreaTarget?.id ?? newArea.projectId}
          title="Новая область"
          naming={creationNaming(newArea.firstTab === "session" ? "agent" : "terminal")}
          open
          onClose={() => setNewArea(null)}
          kind={newArea.firstTab === "session" ? "agent" : "terminal"}
          onKindChange={changeCreationKind}
          kindLocked={Boolean(newArea.workspaceId)}
          target={{
            value: newArea.targetWorkspaceId ?? null,
            options: (newAreaGroup?.chats ?? []).map((chat) => ({
              value: chat.id,
              label: chatTitle(chat, latestAgentByWorkspace[chat.id]),
              branch: areaBranches[chat.id] ?? serverState.areaWorktrees[chat.id]?.branch,
            })),
            onChange: (value) => setNewArea({ ...newArea, targetWorkspaceId: value ?? undefined }),
            locked: Boolean(newArea.workspaceId),
          }}
          extra={!newAreaTarget && worktreeOptions?.isGit && worktreeOptions.projectId === newArea.projectId ? (
            <View style={{ gap: 12 }}>
              <View style={{ gap: 6 }}>
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Ветка</Text>
                <ChoiceList
                  theme={theme}
                  disabled={Boolean(creatingId || newArea.workspaceId)}
                  value={newAreaPlace}
                  onChange={(place) => setNewArea({ ...newArea, place, worktreePath: undefined })}
                  options={[
                    { value: "project" as const, label: "В папке проекта", icon: "Folder",
                      detail: worktreeOptions.currentBranch ? `Текущая ветка ${worktreeOptions.currentBranch}` : undefined },
                    { value: "existing" as const, label: "Существующая ветка", icon: "GitBranch", detail: "Отдельная папка worktree" },
                    { value: "new" as const, label: "Новая ветка", icon: "GitBranchPlus", detail: "Отдельная папка worktree" },
                  ]}
                />
              </View>
              {newAreaPlace === "existing" ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View style={{ flex: 1, minWidth: 0, height: 44, justifyContent: "center", paddingHorizontal: 12,
                    borderRadius: 9, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 }}>
                    <Text numberOfLines={1} style={{ color: newAreaBranch ? c.foreground : c.foregroundMuted, fontSize: 15 }}>
                      {newAreaBranch || "Все ветки уже открыты"}
                    </Text>
                  </View>
                  <TitleModelPicker plain theme={theme} value={newAreaBranch}
                    options={freeBranches.map((branch) => ({ label: branch, value: branch, provider: "", providerLabel: "", name: branch }))}
                    disabled={!freeBranches.length || Boolean(creatingId)}
                    label="Выбрать ветку" icon="ChevronDown" menuLabel="Ветки проекта"
                    onValueChange={(branch) => setNewArea({ ...newArea, branch, worktreePath: undefined })} />
                </View>
              ) : null}
              {newAreaPlace === "new" ? (
                <View style={{ gap: 6 }}>
                  <View style={{ height: 44, justifyContent: "center", paddingHorizontal: 12,
                    borderRadius: 9, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 }}>
                    <TextInput
                      accessibilityLabel="Имя новой ветки"
                      placeholder="Имя новой ветки"
                      placeholderTextColor={c.foregroundMuted}
                      autoCapitalize="none"
                      autoCorrect={false}
                      value={newArea.newBranch ?? ""}
                      editable={!creatingId}
                      onChangeText={(newBranch) => setNewArea({ ...newArea, newBranch, worktreePath: undefined })}
                      style={{ padding: 0, outlineWidth: 0, color: c.foreground, fontSize: 15 }}
                    />
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text numberOfLines={1} style={{ flex: 1, color: c.foregroundMuted, fontSize: 12 }}>
                      От ветки {newAreaBaseBranch}
                    </Text>
                    <TitleModelPicker plain theme={theme} value={newAreaBaseBranch}
                      options={worktreeOptions.branches.map((branch) => ({ label: branch, value: branch, provider: "", providerLabel: "", name: branch }))}
                      disabled={Boolean(creatingId)}
                      label="Выбрать базовую ветку" icon="ChevronDown" menuLabel="Ветки проекта"
                      onValueChange={(baseBranch) => setNewArea({ ...newArea, baseBranch })} />
                  </View>
                </View>
              ) : null}
              {newAreaPlace !== "project" ? (
                <View style={{ gap: 6 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Папка worktree</Text>
                  <View style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 8,
                    borderRadius: 9, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 }}>
                    <TextInput
                      accessibilityLabel="Папка worktree"
                      autoCapitalize="none"
                      autoCorrect={false}
                      value={newAreaWorktreePath}
                      editable={!creatingId && !newArea.workspaceId}
                      onChangeText={(worktreePath) => setNewArea({ ...newArea, worktreePath })}
                      style={{ padding: 0, outlineWidth: 0, color: c.foreground, fontSize: 12, fontFamily: "monospace" }}
                    />
                  </View>
                </View>
              ) : null}
            </View>
          ) : undefined}
          name={newAreaTarget ? undefined : newArea.name}
          onNameChange={(name) => setNewArea({ ...newArea, name })}
          nameEditable={!newArea.workspaceId}
          model={newAgentModel}
          modelsError={newAgentModelsError}
          modelOptions={titleModelOptions(newAgentModels, "first_line").filter(option => option.provider)}
          onModelChange={changeAgentModel}
          agentOptions={{ ...creationOptions, onModeChange: setModeId, onThinkingChange: setThinkingOptionId, loading: !newAgentModels.length }}
          folder={newAreaTarget ? newAreaTarget.workspaceDirectory : newAreaFolder}
          busy={Boolean(creatingId) || Object.values(creatingAreaIds).some(Boolean) || Boolean(creatingTerminalId)}
          submitLabel={newAreaTarget
            ? newArea.firstTab === "session" ? "Создать агента" : "Создать терминал"
            : newArea.workspaceId ? "Создать терминал" : "Создать область"}
          submitAgentLabel={newAreaTarget ? "Создать агента с выбранной моделью" : undefined}
          onSubmit={() => {
            if (!newAreaTarget) void createNewArea();
            else if (newArea.firstTab === "session") void handleCreateAreaSession(newAreaTarget.id);
            else void handleCreateAreaTerminal(newAreaTarget.id);
          }}
        />
      ) : null}

      <ActionSheet
        title="Действия области"
        fixedHeight
        open={Boolean(editingChat)}
        onClose={() => {
          handleRenameChat();
          setEditingChatId(null);
          updateDraftChatTitle(null);
        }}
        theme={theme}
        disabled={false}
        actions={editingChat ? [
          {
            label: editingChatPinned ? "Открепить область" : "Закрепить область",
            icon: editingChatPinned ? "PinOff" : "Pin",
            color: editingChatPinned ? c.accent : undefined,
            disabled: chatMutationPending,
            onPress: () => void handleTogglePinChat(),
          },
          {
            label: "Архивировать область", icon: "Archive", danger: true,
            disabled: chatMutationPending,
            onPress: () => void handleArchiveChat(editingChat),
          },
        ] : []}
      >
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
                        setAreaTitleFocused(true);
                        if (draftChatTitle === null) updateDraftChatTitle(editingAreaTitle);
                      }}
                      selection={draftTitleSelection}
                      onSelectionChange={({ nativeEvent: { selection } }) => {
                        if (selection.start === draftTitleSelection?.start && selection.end === draftTitleSelection.end) {
                          setDraftTitleSelection(undefined);
                        }
                      }}
                      onBlur={() => {
                        setAreaTitleFocused(false);
                        handleRenameChat();
                      }}
                      placeholder="Новая область"
                      placeholderTextColor={c.foregroundMuted}
                      editable={!chatMutationPending}
                      style={{ flex: 1, minWidth: 0, padding: 0, outlineWidth: 0, color: c.foreground, fontSize: 15 }}
                    />
                  </View>
                  {areaTitleFocused ? (
                    <ChatActionButton
                      label="Принять название"
                      icon="Check"
                      color={c.accent}
                      disabled={chatMutationPending}
                      onPressIn={acceptAreaTitle}
                      onPress={acceptAreaTitle}
                      theme={theme}
                    />
                  ) : (
                    <ChatActionButton theme={theme} label="Сгенерировать название" icon="Sparkles" disabled={!canSuggestTitle || suggestingTitle} onPress={() => void handleSuggestTitle(titleModel)} />
                  )}
                </View>
                {editingChat.projectKind === "git" ? (
                  <View style={{ marginTop: 8, padding: 12, borderRadius: 9, borderWidth: 1, borderColor: c.border }}>
                    <BranchInformation
                      branch={areaBranches[editingChat.id] ?? areaSettings?.currentBranch ?? "Ветка не определена"}
                      path={editingChat.workspaceDirectory}
                      kind={areaCheckoutKinds[editingChat.id]}
                      theme={theme}
                    />
                  </View>
                ) : null}
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
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>Сессии</Text>
                  <ChatActionButton
                    label="Новая сессия"
                    icon="Plus"
                    background={c.surface1}
                    disabled={chatMutationPending || Boolean(creatingAreaIds[editingChat.id]) || Boolean(creatingTerminalId)}
                    onPress={() => openNewAreaAgent(editingChat.id)}
                    theme={theme}
                  />
                </View>
                <View style={{ flexWrap: "wrap", flexDirection: "row", gap: 6, marginBottom: 8 }}>
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
                          {value === "closed" && closedAgents.data?.length ? `${label} ${closedAgents.data.length}` : label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {visibleAreaSessions.map((session) => {
                  if (session.kind === "terminal") {
                    return (
                      <TerminalRow key={session.id} terminal={session.terminal} label={terminalLabel(session.terminal)} theme={theme}
                        selected={activeSession === `terminal_${session.id}`}
                        pinned={Boolean(serverState.pinnedSessions[session.id])}
                        disabled={chatMutationPending}
                        onMenu={() => openTerminalMenu(session.id)}
                        onOpen={() => {
                          setEditingChatId(null);
                          openAreaTerminal(session.terminal);
                        }} />
                    );
                  }
                  const ag = session.entry.agent;
                  const agTitle = agentTitle(ag);
                  const isCurrent = activeSession === `agent_${ag.id}`;
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
                        accessibilityState={{ selected: isCurrent }}
                        aria-selected={isCurrent}
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
                      </Pressable>
                      {serverState.pinnedSessions[ag.id] ? <Icon name="Pin" size={12} color={c.accent} /> : null}
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
                {closedFilter ? (
                  <>
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
                      </Pressable>
                    ))}
                    {closedAgents.isError ? (
                      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Не удалось загрузить историю агентов</Text>
                    ) : closedAgents.isPending ? (
                      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Загружаю…</Text>
                    ) : !closedAgents.data?.length ? (
                      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Нет закрытых сессий</Text>
                    ) : null}
                  </>
                ) : terminalListFailed && areaSessionFilter !== "agents" ? (
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Не удалось загрузить терминалы</Text>
                ) : !visibleAreaAgents.length && !visibleAreaTerminals.length ? (
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                    {areaSessionFilter === "agents" ? "Нет агентов" : areaSessionFilter === "terminals" ? "Нет терминалов" : "Нет открытых сессий"}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : null}
      </ActionSheet>

      {newAgentWorkspaceId ? (
        <NewSessionWindow
          theme={theme}
          narrow
          title="Новая сессия"
          naming={creationNaming(newSessionKind)}
          open
          onClose={() => setNewAgentWorkspaceId(null)}
          kind={newSessionKind}
          onKindChange={changeCreationKind}
          model={newAgentModel}
          modelsError={newAgentModelsError}
          modelOptions={titleModelOptions(newAgentModels, "first_line").filter(option => option.provider)}
          onModelChange={changeAgentModel}
          agentOptions={{ ...creationOptions, onModeChange: setModeId, onThinkingChange: setThinkingOptionId, loading: !newAgentModels.length }}
          folder={newSessionWorkspace?.workspaceDirectory ?? "Папка области недоступна"}
          busy={Object.values(creatingAreaIds).some(Boolean) || Boolean(creatingTerminalId)}
          submitLabel={newSessionKind === "agent" ? "Создать агента" : "Создать терминал"}
          submitAgentLabel="Создать агента с выбранной моделью"
          onSubmit={() => {
            if (!newAgentWorkspaceId) return;
            if (newSessionKind === "agent") void handleCreateAreaSession(newAgentWorkspaceId);
            else void handleCreateAreaTerminal(newAgentWorkspaceId);
          }}
        />
      ) : null}

      <ActionSheet
        narrow
        title={confirmClosingSession
          ? "Закрыть работающего агента"
          : "Действия с агентом"}
        open={Boolean(agentMenuChat)}
        onClose={() => {
          void handleRenameAgent();
          setAgentMenuId(null);
        }}
        theme={theme}
        disabled={chatMutationPending}
        actions={agentMenuChat ? confirmClosingSession ? [
                { label: "Отмена", icon: "ArrowLeft", onPress: () => setConfirmClosingSession(false) },
                { label: "Остановить и закрыть", icon: "Archive", danger: true, onPress: () => void handleAgentMenuAction("close") },
              ] : [
                {
                  label: serverState.pinnedSessions[agentMenuChat.id] ? "Открепить агента" : "Закрепить агента",
                  icon: serverState.pinnedSessions[agentMenuChat.id] ? "PinOff" : "Pin",
                  onPress: () => void handleTogglePinAgent(agentMenuChat.id),
                },
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
              ] : []}
      >
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
                          setAgentTitleFocused(true);
                          savedAgentTitle.current = null;
                          if (draftAgentTitle === null) setDraftAgentTitle(agentMenuChat.title ?? "");
                        }}
                        onBlur={() => {
                          setAgentTitleFocused(false);
                          void handleRenameAgent();
                        }}
                        onSubmitEditing={() => void handleRenameAgent()}
                        maxLength={200}
                        editable={!chatMutationPending}
                        style={{ flex: 1, minWidth: 0, padding: 0, outlineWidth: 0, color: c.foreground, fontSize: 15 }}
                      />
                    </View>
                    {agentTitleFocused ? (
                      <ChatActionButton
                        label="Принять название"
                        icon="Check"
                        color={c.accent}
                        disabled={chatMutationPending}
                        onPressIn={acceptAgentTitle}
                        onPress={acceptAgentTitle}
                        theme={theme}
                      />
                    ) : (
                      <ChatActionButton theme={theme} label="Сгенерировать название" icon="Sparkles" disabled={suggestingAgentTitle || chatMutationPending} onPress={() => void handleSuggestAgentTitle(agentTitleModel)} />
                    )}
                  </View>
                </View>
              )}
              {!confirmClosingSession ? <SessionInformation theme={theme} agent={agentMenuChat} workspace={agentMenuWorkspace}
                agentLink={`paseo:///h/${host.id || "local"}/agent/${agentMenuChat.id}`}
                path={agentMenuChat.cwd || agentMenuWorkspace?.workspaceDirectory || "Папка недоступна"}
                branch={agentMenuChat.workspaceId ? areaBranches[agentMenuChat.workspaceId] : undefined} /> : null}
              {!confirmClosingSession ? (
                <Pressable accessibilityRole="button" accessibilityLabel="Открыть чат"
                  disabled={chatMutationPending}
                  onPress={async () => {
                    const agentId = agentMenuChat.id;
                    await handleRenameAgent();
                    setAgentMenuId(null);
                    setEditingChatId(null);
                    jumpToAgent(agentId);
                  }}
                  style={({ pressed }) => ({ marginTop: 4, minHeight: 42, paddingHorizontal: 14, borderRadius: 9,
                    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
                    backgroundColor: c.accent, opacity: chatMutationPending ? 0.5 : pressed ? 0.8 : 1 })}>
                  <Icon name="MessageSquare" size={16} color={c.accentForeground} />
                  <Text style={{ color: c.accentForeground, fontSize: 13, fontWeight: "600" }}>Открыть чат</Text>
                  <Icon name="ArrowUpRight" size={15} color={c.accentForeground} />
                </Pressable>
              ) : null}
            </View>
          )}
      </ActionSheet>

      <ActionSheet
        narrow
        title={confirmClosingTerminal ? "Закрыть терминал" : "Настройки терминала"}
        open={Boolean(terminalMenuItem)}
        onClose={() => {
          void handleRenameTerminal();
          if (!chatMutationPending) setTerminalMenuId(null);
        }}
        theme={theme}
        disabled={chatMutationPending}
        actions={terminalMenuItem ? confirmClosingTerminal ? [
                { label: "Отмена", icon: "ArrowLeft", onPress: () => setConfirmClosingTerminal(false) },
                { label: "Завершить терминал", icon: "X", danger: true, onPress: () => void handleCloseTerminal(terminalMenuItem) },
              ] : [
                {
                  label: serverState.pinnedSessions[terminalMenuItem.id] ? "Открепить терминал" : "Закрепить терминал",
                  icon: serverState.pinnedSessions[terminalMenuItem.id] ? "PinOff" : "Pin",
                  onPress: () => void handleTogglePinTerminal(terminalMenuItem.id),
                },
                { label: "Скопировать путь терминала", icon: "Copy", onPress: () => void handleCopyTerminalPath(terminalMenuItem) },
                { label: "Закрыть терминал", icon: "X", danger: true, onPress: () => setConfirmClosingTerminal(true) },
              ] : []}
      >
          {terminalMenuItem ? (
            <View style={{ gap: 10 }}>
              {confirmClosingTerminal ? (
                <Text style={{ color: c.foreground, fontSize: 14 }}>
                  Терминал и запущенные в нем процессы завершатся.
                </Text>
              ) : (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{
                  flex: 1, minWidth: 0, height: 44, flexDirection: "row", alignItems: "center", paddingHorizontal: 12,
                  borderRadius: 9, borderWidth: 1, backgroundColor: c.surface2,
                  borderColor: draftTerminalName === null ? c.border : c.accent,
                }}>
                  <TextInput
                    ref={terminalNameInput}
                    accessibilityLabel="Название терминала"
                    placeholder="Название терминала"
                    placeholderTextColor={c.foregroundMuted}
                    value={draftTerminalName ?? terminalLabel(terminalMenuItem)}
                    onChangeText={setDraftTerminalName}
                    onFocus={() => {
                      setTerminalNameFocused(true);
                      savedTerminalName.current = null;
                      if (draftTerminalName === null) setDraftTerminalName(terminalLabel(terminalMenuItem));
                    }}
                    onBlur={() => {
                      setTerminalNameFocused(false);
                      void handleRenameTerminal();
                    }}
                    onSubmitEditing={() => void handleRenameTerminal()}
                    maxLength={200}
                    editable={!chatMutationPending}
                    style={{ flex: 1, minWidth: 0, padding: 0, outlineWidth: 0, color: c.foreground, fontSize: 15 }}
                  />
                </View>
                {terminalNameFocused ? (
                  <ChatActionButton
                    label="Принять название"
                    icon="Check"
                    color={c.accent}
                    disabled={chatMutationPending}
                    onPressIn={acceptTerminalName}
                    onPress={acceptTerminalName}
                    theme={theme}
                  />
                ) : null}
                </View>
              )}
              {!confirmClosingTerminal ? <SessionInformation theme={theme} workspace={terminalMenuWorkspace}
                path={terminalMenuItem.cwd} branch={areaBranches[terminalMenuItem.workspaceId]} /> : null}
            </View>
          ) : null}
      </ActionSheet>

      <HqModal theme={theme}
        narrow
        title="Архивировать область"
        open={Boolean(worktreeArchive)}
        onOpenChange={(open) => { if (!open && !chatMutationPending) setWorktreeArchive(null); }}
      >
        {worktreeArchive ? (
          <View style={{ gap: 14 }}>
            <Text style={{ color: c.foreground, fontSize: 14 }}>
              Область работает в своей папке worktree на ветке {worktreeArchive.branch}. Paseo эту папку сам не удалит.
            </Text>
            <Text selectable style={{ color: c.foregroundMuted, fontSize: 12, fontFamily: "monospace" }}>{worktreeArchive.path}</Text>
            {worktreeArchive.changes.length ? (
              <View style={{ gap: 4, padding: 10, borderRadius: 9, borderWidth: 1, borderColor: c.statusDanger }}>
                <Text style={{ color: c.statusDanger, fontSize: 13, fontWeight: "600" }}>
                  Незакоммиченные изменения: {worktreeArchive.changes.length}
                </Text>
                {worktreeArchive.changes.slice(0, 8).map((line) => (
                  <Text key={line} numberOfLines={1} style={{ color: c.foreground, fontSize: 12, fontFamily: "monospace" }}>{line}</Text>
                ))}
                {worktreeArchive.changes.length > 8 ? (
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>и еще {worktreeArchive.changes.length - 8}</Text>
                ) : null}
              </View>
            ) : null}
            {!worktreeArchive.exists ? (
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Папки уже нет, Штаб уберет запись о ней из git.</Text>
            ) : null}
            {[
              worktreeArchive.changes.length
                ? { key: "force" as const, label: "Архивировать и удалить папку вместе с изменениями", danger: true }
                : { key: "remove" as const, label: worktreeArchive.exists ? "Архивировать и удалить папку" : "Архивировать", danger: false },
              ...(worktreeArchive.exists ? [{ key: "keep" as const, label: "Архивировать, папку оставить", danger: false }] : []),
            ].map(({ key, label, danger }) => (
              <Pressable
                key={key}
                accessibilityRole="button"
                disabled={chatMutationPending}
                onPress={() => void handleArchiveChat(worktreeArchive.chat, key)}
                style={({ pressed }) => ({
                  padding: 12, alignItems: "center", borderRadius: 9,
                  backgroundColor: danger ? c.statusDanger : key === "keep" ? c.surface2 : c.accent,
                  borderWidth: key === "keep" ? 1 : 0, borderColor: c.border,
                  opacity: chatMutationPending || pressed ? 0.7 : 1,
                })}
              >
                <Text style={{ color: key === "keep" ? c.foreground : danger ? "#FFFFFF" : c.accentForeground, fontSize: 14, fontWeight: "600" }}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </HqModal>

      <HqModal theme={theme}
        narrow
        title="Перенос области в проект"
        open={Boolean(editingChat && chatTransferOpen)}
        onOpenChange={setChatTransferOpen}
      >
        <HqModal.Content>
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
        </HqModal.Content>
      </HqModal>

      <HqModal theme={theme} title="Настройки панели" open={panelSettingsOpen}
        onOpenChange={(open) => { if (!open) setPanelSettingsOpen(false); }}
        actions={[{ label: syncingPlugin ? "Обновление Штаба" : "Обновить Штаб", icon: "RefreshCw", disabled: syncingPlugin, onPress: () => void handleSyncPlugin() }]}>
        <HqModal.Content>
          <View style={{ gap: 16 }}>
            <EditableName theme={theme} value={draftHeaderTitle} onChange={setDraftHeaderTitle}
              onBlur={() => void handleSaveHeaderTitle()} disabled={savingPanelSettings}
              label="Название панели" caption="Название панели" editLabel="Редактировать название панели" placeholder="Штаб" />
            <View style={{ padding: 12, gap: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 }}>
              <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>Автогенерация названий</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Icon name="Sparkles" size={16} color={c.foregroundMuted} />
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                  <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>Модель генерации названий</Text>
                  <Text style={{ color: c.foreground, fontSize: 13 }}>
                    {titleModelOptions(titleProviders, serverState.titleModel).find(option => option.value === serverState.titleModel)?.label}
                  </Text>
                </View>
                <TitleModelPicker theme={theme} label="Выбрать модель названий" menuLabel="Модель генерации названий" icon="ChevronDown"
                  value={serverState.titleModel} options={titleModelOptions(titleProviders, serverState.titleModel)}
                  onValueChange={(titleModel) => {
                    void updatePanelSettings({ titleModel, projectIds: projects.map(project => project.projectId) })
                      .then(setServerState).catch(error => toast.error(error instanceof Error ? error.message : "Не удалось сохранить модель"));
                  }} />
              </View>
              <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Для всех проектов, областей и агентов.</Text>
              {titleModelsError ? <Text style={{ color: c.statusDanger, fontSize: 12 }}>{titleModelsError}</Text> : null}
            </View>
            <View style={{ padding: 12, gap: 10, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 }}>
              <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>Мониторинг сервера</Text>
              <Pressable accessibilityRole="switch" accessibilityLabel="Показывать состояние сервера"
                aria-checked={serverState.showHostMetrics}
                accessibilityState={{ checked: serverState.showHostMetrics, disabled: savingPanelSettings }}
                disabled={savingPanelSettings} onPress={() => void handleToggleHostMetrics(!serverState.showHostMetrics)}
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 36, opacity: pressed ? 0.7 : 1 })}>
                <Icon name="Activity" size={16} color={c.foregroundMuted} />
                <Text style={{ flex: 1, color: c.foreground, fontSize: 13 }}>Показывать состояние сервера</Text>
                <View style={{ width: 36, height: 22, borderRadius: 11, padding: 3, backgroundColor: serverState.showHostMetrics ? c.accent : c.border, alignItems: serverState.showHostMetrics ? "flex-end" : "flex-start" }}>
                  <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: c.foreground }} />
                </View>
              </Pressable>
              <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Процессор, память, сеть и диск над списком проектов.</Text>
            </View>
            {syncResult ? <View style={{ padding: 12, borderRadius: 9, borderWidth: 1, borderColor: c.border }}>
              <Text style={{ color: syncResult.success ? c.statusSuccess : c.statusDanger, fontSize: 12, lineHeight: 17 }}>{syncResult.message}</Text>
            </View> : null}
          </View>
        </HqModal.Content>
      </HqModal>
      </HqModalLayer>
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
