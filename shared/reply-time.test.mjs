import { test } from "node:test";
import assert from "node:assert/strict";
import { findFinalReply } from "./reply-time.ts";
const row = (turnId, type, timestamp) => ({ turnId, item: { type }, timestamp });
test("final replies exclude live turns, intermediate text, tools and failures", () => {
  const final = row("done", "assistant_message", "final");
  const rows = [final, row("failed", "assistant_message", "intermediate"), row("failed", "error", "error"), row("live", "assistant_message", "stream")];
  assert.equal(findFinalReply(rows, new Set(["live"]), false), final);
  assert.equal(findFinalReply([row("tools", "assistant_message", "text"), row("tools", "tool_call", "tool")], new Set(), true), undefined);
});
test("excluded turns survive page boundaries; tool use before final is allowed", () => {
  const excluded = new Set();
  assert.equal(findFinalReply([row("bad", "error", "e")], excluded, true), undefined);
  const final = row("good", "assistant_message", "final");
  assert.equal(findFinalReply([row("good", "tool_call", "t"), final, row("bad", "assistant_message", "partial")], excluded, true), final);
});
