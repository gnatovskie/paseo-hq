import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export * from "./stats";

import { projectMetaSchema } from "./project-meta";
export { projectMetaSchema } from "./project-meta";
export type { ProjectMeta } from "./project-meta";

export const sidebarStateSchema = z.object({
  projects: z.record(z.string(), projectMetaSchema),
  nativeIcons: z.record(z.string(), z.string()),
  areaIcons: z.record(z.string(), z.string()).default({}),
  areaIconBgs: z.record(z.string(), z.string()).default({}),
  /** Области в worktree, созданных Штабом: id области -> папка и ветка. */
  areaWorktrees: z.record(z.string(), z.object({ path: z.string(), branch: z.string() })).default({}),
  lastRunningAt: z.record(z.string(), z.number()),
  pinnedSessions: z.record(z.string(), z.number()),
  terminalNames: z.record(z.string(), z.string()).default({}),
  showHostMetrics: z.boolean().default(true),
  headerTitle: z.string().default("Штаб"),
  projectsSortMode: z.enum(["auto", "manual"]).default("auto"),
  projectOrder: z.array(z.string()).default([]),
});

export type SidebarState = z.infer<typeof sidebarStateSchema>;

export const avatarUpdateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("keep") }),
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("emoji"),
    emoji: z.string().min(1).max(16),
    bg: z.string().nullable().default(null),
  }),
  z.object({
    kind: z.literal("dataUri"),
    dataUri: z.string().min(16),
  }),
  z.object({
    kind: z.literal("urlOrPath"),
    value: z.string().min(1),
  }),
]);

export type AvatarUpdate = z.infer<typeof avatarUpdateSchema>;

export const candidateDirSchema = z.object({
  name: z.string(),
  path: z.string(),
  isGit: z.boolean(),
});

export type CandidateDir = z.infer<typeof candidateDirSchema>;

export const sidebarReadRpc = defineRpc({
  name: "sidebar.read",
  input: z.object({
    projectIds: z.array(z.string()).default([]),
  }),
  output: sidebarStateSchema,
});

export const panelSettingsRpc = defineRpc({
  name: "sidebar.settings",
  input: z.object({
    headerTitle: z.string().optional(),
    showHostMetrics: z.boolean().optional(),
    projectsSortMode: z.enum(["auto", "manual"]).optional(),
    projectOrder: z.array(z.string()).optional(),
    projectIds: z.array(z.string()).default([]),
  }),
  output: sidebarStateSchema,
});

export const zorStatsRpc = defineRpc({
  name: "zor.resources",
  input: z.object({}),
  output: z.object({
    available: z.boolean(),
    cpu: z.number().nullable(),
    cpuLimit: z.number().nullable(),
    memory: z.number().nullable(),
    memoryLimit: z.number().nullable(),
    processes: z.number().nullable(),
  }),
});

export const zorActivityRpc = defineRpc({
  name: "zor.activity",
  input: z.object({}),
  output: z.object({
    available: z.boolean(),
    lastSsh: z.number().nullable(),
    lastMessage: z.number().nullable(),
    agentLast: z.number().nullable(),
    agentMs: z.number().nullable(),
    coverageComplete: z.boolean(),
  }),
});

export type ZorStats = z.infer<typeof zorStatsRpc.output>;
export type ZorActivity = z.infer<typeof zorActivityRpc.output>;

export const workerStatsSchema = z.object({
  available: z.boolean(),
  cpu: z.number().nullable(),
  cpuLimit: z.number().nullable(),
  memory: z.number().nullable(),
  memoryLimit: z.number().nullable(),
  processes: z.number().nullable(),
});

export const workerActivitySchema = z.object({
  available: z.boolean(),
  lastSsh: z.number().nullable(),
  lastMessage: z.number().nullable(),
  agentLast: z.number().nullable(),
  agentMs: z.number().nullable(),
  coverageComplete: z.boolean(),
});

export const workerInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string(),
  role: z.string(),
  container: z.string(),
  user: z.string(),
  status: z.enum(["active", "idle", "offline"]),
  stats: workerStatsSchema,
  activity: workerActivitySchema,
});

export type WorkerStats = z.infer<typeof workerStatsSchema>;
export type WorkerActivity = z.infer<typeof workerActivitySchema>;
export type WorkerInfo = z.infer<typeof workerInfoSchema>;

export const workersListRpc = defineRpc({
  name: "workers.list",
  input: z.object({}),
  output: z.object({
    workers: z.array(workerInfoSchema),
  }),
});

export const projectSaveRpc = defineRpc({
  name: "sidebar.save",
  input: z.object({
    projectId: z.string().min(1),
    customName: z.string().nullable().optional(),
    avatar: avatarUpdateSchema.default({ kind: "keep" }),
    newSessionMode: z.enum(["directory", "worktree"]).optional(),
    hidden: z.boolean().optional(),
    pinned: z.boolean().optional(),
    sessionTitleModel: z.string().nullable().optional(),
    sessionsSortMode: z.enum(["auto", "manual"]).optional(),
    sessionOrder: z.array(z.string()).optional(),
  }),
  output: sidebarStateSchema,
});

export const sessionTitleSuggestRpc = defineRpc({
  name: "sidebar.title-suggest",
  input: z.object({
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
    projectId: z.string().min(1),
    model: z.string().trim().min(1).optional(),
  }),
  output: z.object({ title: z.string() }),
});

export const chatRenameRpc = defineRpc({
  name: "sidebar.chat-rename",
  input: z.object({
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
    title: z.string().trim().min(1).max(200),
  }),
  output: z.object({}),
});

const areaIconBackgroundSchema = z.string().regex(/^#[0-9a-f]{6}$/i).nullable();

export const areaPreferencesSchema = z.object({
  icon: z.string().nullable().default(null),
  iconBg: areaIconBackgroundSchema.default(null),
  titleModel: z.string().nullable().default(null),
  defaultBranch: z.string().nullable().default(null),
  launchBranches: z.record(z.string(), z.string()).default({}),
  /** Worktree, созданный Штабом; rootPath нужен для уборки, когда область уже в архиве. */
  worktree: z.object({ path: z.string(), branch: z.string(), rootPath: z.string().optional() }).nullable().default(null),
});

// Текущая ветка каждой области: у родных worktree Paseo и у области в папке проекта ее знает только git.
export const areaBranchesRpc = defineRpc({
  name: "sidebar.area-branches",
  input: z.object({ workspaceIds: z.array(z.string()).max(500) }),
  output: z.object({ branches: z.record(z.string(), z.string()) }),
});

export const areaWorktreeOptionsRpc = defineRpc({
  name: "sidebar.area-worktree-options",
  input: z.object({ projectId: z.string().min(1) }),
  output: z.object({
    isGit: z.boolean(),
    rootPath: z.string(),
    branches: z.array(z.string()),
    /** Ветки, уже открытые в каком-то worktree, включая корень проекта. */
    checkedOut: z.array(z.string()),
    currentBranch: z.string().nullable(),
  }),
});

export const areaWorktreeCreateRpc = defineRpc({
  name: "sidebar.area-worktree-create",
  input: z.object({
    projectId: z.string().min(1),
    title: z.string(),
    path: z.string().min(1),
    branch: z.string().min(1),
    newBranch: z.boolean(),
    baseBranch: z.string().optional(),
    /** Модель первого агента; без нее область создается пустой. */
    agentModel: z.string().optional(),
  }),
  output: z.object({ workspaceId: z.string(), path: z.string() }),
});

export const areaWorktreeInfoRpc = defineRpc({
  name: "sidebar.area-worktree-info",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({
    worktree: z.object({ path: z.string(), branch: z.string() }).nullable(),
    exists: z.boolean(),
    changes: z.array(z.string()),
  }),
});

export const areaWorktreeRemoveRpc = defineRpc({
  name: "sidebar.area-worktree-remove",
  input: z.object({ workspaceId: z.string().min(1), force: z.boolean().default(false) }),
  output: z.object({}),
});

export const areaSettingsRpc = defineRpc({
  name: "sidebar.area-settings",
  input: z.object({
    workspaceId: z.string().min(1),
    defaultBranch: z.string().min(1).nullable().optional(),
    icon: z.string().trim().min(1).max(16).nullable().optional(),
    iconBg: areaIconBackgroundSchema.optional(),
    titleModel: z.string().trim().min(1).nullable().optional(),
  }),
  output: areaPreferencesSchema.extend({
    currentBranch: z.string().nullable(),
    branches: z.array(z.string()),
  }),
});

export const areaSessionCreateRpc = defineRpc({
  name: "sidebar.area-session-create",
  input: z.object({ workspaceId: z.string().min(1), model: z.string().min(1) }),
  output: z.object({ agentId: z.string() }),
});

export const sessionPinRpc = defineRpc({
  name: "sidebar.pin",
  input: z.object({
    workspaceId: z.string().min(1),
    pinned: z.boolean(),
    projectIds: z.array(z.string()).default([]),
  }),
  output: sidebarStateSchema,
});

// Имя терминала хранится в Штабе: SDK плагина не умеет переименовывать терминалы Paseo.
export const terminalRenameRpc = defineRpc({
  name: "sidebar.terminal-rename",
  input: z.object({
    terminalId: z.string().min(1),
    title: z.string().max(200).nullable(),
    projectIds: z.array(z.string()).default([]),
  }),
  output: sidebarStateSchema,
});

export const projectCandidatesRpc = defineRpc({
  name: "sidebar.candidates",
  input: z.object({
    existingPaths: z.array(z.string()).default([]),
  }),
  output: z.object({
    defaultParent: z.string(),
    items: z.array(candidateDirSchema),
  }),
});

export const projectAddRpc = defineRpc({
  name: "sidebar.add",
  input: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("existing"),
      path: z.string().min(1),
      customName: z.string().optional(),
    }),
    z.object({
      mode: z.literal("create"),
      parentPath: z.string().min(1),
      folderName: z.string().min(1),
      customName: z.string().optional(),
      initGit: z.boolean().default(true),
    }),
    z.object({
      mode: z.literal("clone"),
      repoUrl: z.string().min(1),
      parentPath: z.string().min(1),
      folderName: z.string().optional(),
      customName: z.string().optional(),
    }),
  ]),
  output: z.object({
    projectId: z.string(),
    rootPath: z.string(),
  }),
});

export const projectRemoveRpc = defineRpc({
  name: "sidebar.remove",
  input: z.object({
    projectId: z.string().min(1),
  }),
  output: z.object({
    ok: z.boolean(),
  }),
});

export const sessionTransferRpc = defineRpc({
  name: "sidebar.session-transfer",
  input: z.object({
    workspaceId: z.string().min(1),
    targetProjectId: z.string().min(1),
    archiveOriginal: z.boolean().default(true),
    includeHistory: z.boolean().default(true),
  }),
  output: z.object({
    newWorkspaceId: z.string(),
    targetProjectId: z.string(),
  }),
});

export const pluginSyncRpc = defineRpc({
  name: "sidebar.plugin-sync",
  input: z.object({ action: z.enum(["start", "status"]), jobId: z.string().uuid() }),
  output: z.object({
    state: z.enum(["running", "complete", "failed"]),
    success: z.boolean(),
    updated: z.boolean(),
    message: z.string(),
    details: z.string().optional(),
  }),
});

export * from "./artifacts-contracts";


