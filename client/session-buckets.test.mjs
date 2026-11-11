import test from "node:test";
import assert from "node:assert/strict";
import {
  countSessionBuckets,
  deriveAgentBucket,
  pickWorkspaceBucket,
  resolveChatBucket,
} from "./session-buckets.ts";

test("рабочий чат важнее упавшего, в любом порядке", () => {
  assert.equal(pickWorkspaceBucket(pickWorkspaceBucket(undefined, "failed"), "running"), "running");
  assert.equal(pickWorkspaceBucket(pickWorkspaceBucket(undefined, "running"), "failed"), "running");
});

test("failed остаётся, только если все чаты упали", () => {
  assert.equal(pickWorkspaceBucket(pickWorkspaceBucket(undefined, "failed"), "failed"), "failed");
});

test("failed уступает done, attention и needs_input", () => {
  assert.equal(pickWorkspaceBucket("failed", "done"), "done");
  assert.equal(pickWorkspaceBucket("failed", "attention"), "attention");
  assert.equal(pickWorkspaceBucket("failed", "needs_input"), "needs_input");
});

test("среди рабочих чатов берётся самый важный", () => {
  assert.equal(pickWorkspaceBucket("done", "running"), "running");
  assert.equal(pickWorkspaceBucket("attention", "needs_input"), "needs_input");
  let b;
  for (const status of ["done", "failed", "running"]) b = pickWorkspaceBucket(b, status);
  assert.equal(b, "running");
});

test("статус воркспейса failed не заслоняет рабочий чат", () => {
  assert.equal(resolveChatBucket({ id: "w1", status: "failed" }, { w1: "running" }), "running");
  assert.equal(resolveChatBucket({ id: "w1", status: "failed" }, { w1: "done" }), "done");
});

test("воркспейс остаётся failed, если упали все его чаты", () => {
  assert.equal(resolveChatBucket({ id: "w1", status: "failed" }, { w1: "failed" }), "failed");
});

test("ошибка агента распознаётся как failed", () => {
  assert.equal(deriveAgentBucket({ status: "error" }), "failed");
  assert.equal(deriveAgentBucket({ status: "idle", attentionReason: "error" }), "failed");
  assert.equal(deriveAgentBucket({ status: "running" }), "running");
  assert.equal(deriveAgentBucket({ status: "idle" }), "done");
  assert.equal(deriveAgentBucket({ status: "idle", pendingPermissions: [{}] }), "needs_input");
});

test("счетчики сохраняют все статусы агентов и учитывают неактивные терминалы", () => {
  assert.deepEqual(countSessionBuckets([
    { status: "running" },
    { status: "running" },
    { status: "idle", requiresAttention: true, attentionReason: "finished" },
    { status: "idle" },
    { status: "error" },
  ], 4), {
    running: 2,
    attention: 1,
    done: 5,
    needs_input: 0,
    failed: 1,
  });
});

test("ожидание разрешения имеет отдельный счетчик и не считается готовностью", () => {
  assert.deepEqual(countSessionBuckets([
    { status: "running", pendingPermissions: [{}], requiresAttention: true },
    { status: "idle", attentionReason: "permission" },
    { status: "idle", attentionReason: "error", requiresAttention: true },
  ], 0), {
    running: 0,
    attention: 0,
    done: 0,
    needs_input: 2,
    failed: 1,
  });
});

test("в пустой области счетчики нулевые", () => {
  assert.deepEqual(countSessionBuckets([], 0), {
    running: 0,
    attention: 0,
    done: 0,
    needs_input: 0,
    failed: 0,
  });
});
