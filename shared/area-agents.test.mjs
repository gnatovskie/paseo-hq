import { test } from "node:test";
import assert from "node:assert/strict";
import { groupAreaAgents, compareAreaOrder } from "./area-agents.ts";
const at = n => `2026-11-11T12:${String(n).padStart(2, "0")}:00Z`;
const entry = (id, prompt, extra = {}) => ({ agent: { id, workspaceId: "w", createdAt: at(0), lastUserMessageAt: prompt && at(prompt), updatedAt: at(55), ...extra } });
const ids = entries => groupAreaAgents(entries).get("w").map(({ agent }) => agent.id);

test("area sessions follow human prompts despite SDK activity ordering", () => {
  const old = entry("old", 10, { status: "running", updatedAt: at(59), attentionTimestamp: at(59) });
  const recent = entry("recent", 20, { updatedAt: at(20) });
  assert.deepEqual(ids([old, recent]), ["recent", "old"]);
  assert.deepEqual(ids([recent, old]), ["recent", "old"]);
  old.agent.lastUserMessageAt = at(30);
  assert.deepEqual(ids([recent, old]), ["old", "recent"]);
});

test("agents without prompts use creation time, ties stay stable across SDK snapshots", () => {
  const a = entry("a", null, { createdAt: at(1) });
  const b = entry("b", null, { createdAt: at(2) });
  assert.deepEqual(ids([a, b]), ["b", "a"]);
  a.agent.createdAt = at(2);
  assert.deepEqual(ids([b, a]), ["a", "b"]);
  assert.deepEqual(ids([a, b]), ["a", "b"]);
});

test("archived, internal and workspace-less agents stay out of visible groups", () => {
  const entries = [entry("visible", 10), entry("archived", 59, { archivedAt: at(59) }), entry("internal", 59, { internal: true }), entry("detached", 59, { workspaceId: null })];
  assert.deepEqual(ids(entries), ["visible"]);
  assert.equal(entries.length, 4);
});

test("reply sorting uses final reply times, not prompts or runtime activity", () => {
  const entries = [entry("prompt", 50), entry("reply", 10)];
  const replies = { prompt: Date.parse(at(20)), reply: Date.parse(at(40)) };
  assert.deepEqual(groupAreaAgents(entries, { w: "reply" }, replies).get("w").map(e => e.agent.id), ["reply", "prompt"]);
  assert.deepEqual(ids(entries), ["prompt", "reply"]);
});

test("pins override activity newest first, manual priorities ignore activity", () => {
  const entries = [{ id: "oldpin" }, { id: "newpin" }, { id: "a" }, { id: "b" }];
  const pins = { oldpin: 1, newpin: 2 };
  const activity = id => ({ oldpin: 900, newpin: 1, a: 10, b: 20 })[id];
  assert.deepEqual([...entries].sort((a,b) => compareAreaOrder(a,b,pins,"auto",{},activity)).map(e=>e.id), ["newpin","oldpin","b","a"]);
  assert.deepEqual([...entries].sort((a,b) => compareAreaOrder(a,b,pins,"manual",{a:20,b:10},activity)).map(e=>e.id), ["newpin","oldpin","a","b"]);
});

test("manual area priorities allow arbitrary finite numbers, ties use newest creation", () => {
 const entries = [{ id: "old", createdAt: at(1) }, { id: "new", createdAt: at(2) }, { id: "high", createdAt: at(0) }, { id: "low", createdAt: at(59) }];
 const priorities = { high: 10.5, low: -100 };
 const order = entries.sort((a,b) => compareAreaOrder(a,b,{},"manual",priorities,()=>999)).map(e=>e.id);
 assert.deepEqual(order, ["high","new","old","low"]);
});

test("creation sorting ignores priority and activity but respects pinned order", () => {
 const entries = [{ id: "old", createdAt: at(1) }, { id: "new", createdAt: at(2) }, { id: "pin", createdAt: at(0) }];
 const order = entries.sort((a,b) => compareAreaOrder(a,b,{pin:1},"created",{old:9999},()=>999)).map(e=>e.id);
 assert.deepEqual(order, ["pin","new","old"]);
});
