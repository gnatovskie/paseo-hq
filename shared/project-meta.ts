import { z } from "zod";

export const projectMetaSchema = z.object({
  avatarUri: z.string().nullable().default(null),
  avatarEmoji: z.string().nullable().default(null),
  avatarBg: z.string().nullable().default(null),
  hidden: z.boolean().default(false),
  pinned: z.boolean().default(false),
  sessionTitleModel: z.string().nullable().default(null),
  sessionsSortMode: z.enum(["auto", "manual"]).default("auto"),
  sessionOrder: z.array(z.string()).default([]),
});

export type ProjectMeta = z.infer<typeof projectMetaSchema>;
