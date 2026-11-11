import { test } from "node:test";
import assert from "node:assert/strict";
import { compareProjectOrder } from "./project-order.ts";
const project = (id, priority, createdAt, meta = {}) => ({ id, name: id, createdAt, lastPromptAt: 0, lastReplyAt: 0, meta: { priority, ...meta } });
test("creation project order ignores priority and activity, pins always first", () => {
 const projects = [project("a", 10, 1), project("b", 10, 2), project("c", -5, 3), project("high", 900, 0), project("pin", 0, 0, { pinned: true, pinnedAt: 1 })];
 assert.deepEqual(projects.sort((a,b) => compareProjectOrder(a,b,"auto","created")).map(p=>p.id), ["pin","c","b","a","high"]);
});
test("automatic project order follows selected activity and keeps pin order", () => {
 const a = { ...project("a", 100, 0), lastPromptAt: 10, lastReplyAt: 30 };
 const b = { ...project("b", 1, 0), lastPromptAt: 20, lastReplyAt: 5 };
 assert(compareProjectOrder(a,b,"auto","prompt") > 0);
 assert(compareProjectOrder(a,b,"auto","reply") < 0);
 a.meta.pinned = b.meta.pinned = true; a.meta.pinnedAt = 1; b.meta.pinnedAt = 2;
 assert(compareProjectOrder(a,b,"auto","reply") > 0);
});

test("legacy manual project sorting now follows creation dates", () => {
 assert(compareProjectOrder(project("old",999,1),project("new",-999,2),"manual") > 0);
});
