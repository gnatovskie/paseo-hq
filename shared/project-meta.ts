import { z } from "zod";

export const projectMetaSchema = z.object({
  avatarUri: z.string().nullable().default(null),
  avatarEmoji: z.string().nullable().default(null),
  avatarBg: z.string().nullable().default(null),
  hidden: z.boolean().default(false),
  hiddenSections: z.array(z.enum(["areas", "pools"])).default([]),
  // Терминалы в режиме «Сессии» сайдбара.
  showTerminalsInSessions: z.boolean().default(true),
  pinned: z.boolean().default(false),
  pinnedAt: z.number().default(0),
  priority: z.number().finite().default(10),
  sessionTitleModel: z.string().nullable().default(null),
  sessionsSortMode: z.enum(["auto", "manual"]).default("auto"),
  areasSortBy: z.enum(["prompt", "reply", "created"]).default("prompt"),
  sessionOrder: z.array(z.string()).default([]),
});

export type ProjectMeta = z.infer<typeof projectMetaSchema>;
