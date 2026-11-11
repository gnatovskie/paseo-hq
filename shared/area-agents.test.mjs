import { test } from "node:test";
import assert from "node:assert/strict";
import { groupAreaAgents } from "./area-agents.ts";
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
