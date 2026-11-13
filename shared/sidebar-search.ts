// Поиск и плоский список сессий сайдбара Штаба.

export type SidebarMode = "projects" | "sessions";

export function normalizeSearchText(text: string): string {
  return text.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

export function searchTerms(query: string): string[] {
  const normalized = normalizeSearchText(query);
  return normalized ? normalized.split(" ") : [];
}

/** Каждое слово запроса должно встретиться в цепочке «проект + область + сессия». */
export function matchesSearch(terms: readonly string[], ...parts: (string | null | undefined)[]): boolean {
  if (!terms.length) return true;
  const haystack = normalizeSearchText(parts.filter(Boolean).join(" "));
  return terms.every(term => haystack.includes(term));
}

export interface SearchArea<S> {
  title: string;
  sessions: readonly S[];
}

export interface AreaSearchResult<S> {
  /** Совпадение без сессий: область показывается со всеми сессиями. */
  areaMatched: boolean;
  sessions: S[];
}

/** Что из области видно при поиске; null, если область скрывается. */
export function searchArea<S>(terms: readonly string[], project: string, area: SearchArea<S>, sessionTitle: (session: S) => string): AreaSearchResult<S> | null {
  if (matchesSearch(terms, project, area.title)) return { areaMatched: true, sessions: [...area.sessions] };
  const sessions = area.sessions.filter(session => matchesSearch(terms, project, area.title, sessionTitle(session)));
  return sessions.length ? { areaMatched: false, sessions } : null;
}

export interface FlatSessionKey {
  id: string;
  kind: "agent" | "terminal";
  /** Последняя активность агента, мс. У терминалов не используется. */
  activity: number;
  /** Порядок в дереве проектов и областей, сохраняется для терминалов и равных значений. */
  index: number;
}

/**
 * Порядок как в сайдбарах ChatGPT и Claude Code: закрепленные сверху (последнее закрепление первым),
 * затем агенты по последней активности, затем терминалы в порядке дерева.
 */
export function orderFlatSessions<T extends FlatSessionKey>(items: readonly T[], pinned: Record<string, number>): T[] {
  return [...items].sort((a, b) => {
    const ap = pinned[a.id] || 0, bp = pinned[b.id] || 0;
    if (ap || bp) return bp - ap || a.index - b.index;
    if (a.kind !== b.kind) return a.kind === "agent" ? -1 : 1;
    if (a.kind === "agent") return b.activity - a.activity || a.index - b.index;
    return a.index - b.index;
  });
}

const parse = (value: string | null | undefined) => value ? Date.parse(value) || 0 : 0;

/** Активность агента: последний промпт или момент, когда агент закончил и ждет внимания. */
export function agentActivity(agent: { lastUserMessageAt?: string | null; attentionTimestamp?: string | null; createdAt?: string | null }): number {
  return Math.max(parse(agent.lastUserMessageAt), parse(agent.attentionTimestamp), parse(agent.createdAt));
}
