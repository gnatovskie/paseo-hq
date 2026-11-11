/**
 * Статусы агентов и областей в боковой панели Штаба.
 *
 * Правило Руслана: ошибка одного агента не должна заслонять область, в котором
 * есть другой рабочий агент. Поэтому `failed` - самый слабый статус при сборке
 * сводки по области: он виден, только если все агенты области упали.
 */
export type UiSessionBucket = "needs_input" | "failed" | "running" | "attention" | "done";

export const BUCKET_PRIORITY: Record<UiSessionBucket, number> = {
  needs_input: 0,
  failed: 1,
  running: 2,
  attention: 3,
  done: 4,
};

export interface BucketAgent {
  status?: string | null;
  attentionReason?: string | null;
  requiresAttention?: boolean | null;
  pendingPermissions?: readonly unknown[] | null;
}

export interface BucketWorkspace {
  id: string;
  status?: string | null;
}

export function deriveAgentBucket(a: BucketAgent): UiSessionBucket {
  if ((a.pendingPermissions?.length ?? 0) > 0 || a.attentionReason === "permission") {
    return "needs_input";
  }
  if (a.status === "error" || a.attentionReason === "error") {
    return "failed";
  }
  if (a.status === "running") {
    return "running";
  }
  if (a.requiresAttention) {
    return "attention";
  }
  return "done";
}

/**
 * Сводка по агентам одной области: рабочий агент важнее упавшего.
 * `failed` остаётся, только если других агентов нет или они тоже упали.
 */
export function pickWorkspaceBucket(
  prev: UiSessionBucket | undefined,
  next: UiSessionBucket,
): UiSessionBucket {
  if (!prev) return next;
  const prevHealthy = prev !== "failed";
  const nextHealthy = next !== "failed";
  if (nextHealthy && !prevHealthy) return next;
  if (!nextHealthy && prevHealthy) return prev;
  return BUCKET_PRIORITY[next] < BUCKET_PRIORITY[prev] ? next : prev;
}

export function resolveChatBucket(
  w: BucketWorkspace,
  agentBucketByWorkspace: Record<string, UiSessionBucket>,
): UiSessionBucket {
  const fromWs: UiSessionBucket =
    w.status === "needs_input"
      ? "needs_input"
      : w.status === "failed"
        ? "failed"
        : w.status === "running"
          ? "running"
          : "done";
  const fromAgent = agentBucketByWorkspace[w.id];
  if (!fromAgent) return fromWs;
  // Paseo может держать статус области failed из-за одного упавшего агента,
  // хотя другой агент области уже работает. Рабочий агент важнее.
  if (fromWs === "failed" && fromAgent !== "failed") return fromAgent;
  return BUCKET_PRIORITY[fromAgent] < BUCKET_PRIORITY[fromWs] ? fromAgent : fromWs;
}
