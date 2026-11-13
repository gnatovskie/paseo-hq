import assert from "node:assert/strict";
import { test } from "node:test";
import { agentActivity, matchesSearch, orderFlatSessions, searchArea, searchTerms } from "./sidebar-search.ts";

test("search ignores case, ё and extra spaces", () => {
  assert.deepEqual(searchTerms("  Ёлка   HQ "), ["елка", "hq"]);
  assert.equal(matchesSearch(searchTerms("елка"), "Новая ЁЛКА"), true);
  assert.equal(matchesSearch([], "что угодно"), true);
});

test("every word must appear somewhere in project, area and session", () => {
  const terms = searchTerms("hq сайдбар");
  assert.equal(matchesSearch(terms, "Paseo HQ", "Главная", "Сайдбар компактный"), true);
  assert.equal(matchesSearch(terms, "Paseo HQ", "Главная", "Логотипы"), false);
});

test("an area match keeps all sessions, a session match keeps only matching sessions", () => {
  const area = { title: "Компактный режим", sessions: ["Поиск", "Иконки"] };
  assert.deepEqual(searchArea(searchTerms("компактный"), "HQ", area, s => s), { areaMatched: true, sessions: ["Поиск", "Иконки"] });
  assert.deepEqual(searchArea(searchTerms("hq иконки"), "HQ", area, s => s), { areaMatched: false, sessions: ["Иконки"] });
  assert.equal(searchArea(searchTerms("деплой"), "HQ", area, s => s), null);
});

test("flat sessions: pins first, then agents by activity, then terminals in tree order", () => {
  const items = [
    { id: "t1", kind: "terminal", activity: 0, index: 0 },
    { id: "old", kind: "agent", activity: 100, index: 1 },
    { id: "new", kind: "agent", activity: 300, index: 2 },
    { id: "pinnedEarly", kind: "agent", activity: 50, index: 3 },
    { id: "t2", kind: "terminal", activity: 0, index: 4 },
    { id: "pinnedLate", kind: "terminal", activity: 0, index: 5 },
  ];
  const order = orderFlatSessions(items, { pinnedEarly: 1, pinnedLate: 2 }).map(item => item.id);
  assert.deepEqual(order, ["pinnedLate", "pinnedEarly", "new", "old", "t1", "t2"]);
});

test("agent activity takes the latest prompt or finished turn", () => {
  assert.equal(agentActivity({ createdAt: "2026-11-01T00:00:00Z", lastUserMessageAt: "2026-11-02T00:00:00Z", attentionTimestamp: "2026-11-03T00:00:00Z" }), Date.parse("2026-11-03T00:00:00Z"));
  assert.equal(agentActivity({ createdAt: "2026-11-01T00:00:00Z" }), Date.parse("2026-11-01T00:00:00Z"));
});
