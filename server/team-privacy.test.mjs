import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const moduleUrl = new URL("./team.server.ts", import.meta.url);
const git = async (...args) => (await exec("git", args, { timeout: 20_000 })).stdout.trim();
const fresh = () => import(`${moduleUrl.href}?test=${crypto.randomUUID()}`);
const task = (id, title, personal = false, updatedAt = "2026-01-01T00:00:00.000Z") => ({
  id, title, personal, ownerId: personal ? "local-owner" : undefined, updatedAt,
});
const board = (tasks) => ({ version: 1, name: "Test team", members: [], tasks, updatedAt: "" });

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "hq-team-safety-"));
  const oldDir = process.env.PASEO_HQ_TEAM_DIR;
  const oldConfig = process.env.PASEO_HQ_TEAM_CONFIG;
  process.env.PASEO_HQ_TEAM_DIR = join(root, "local");
  process.env.PASEO_HQ_TEAM_CONFIG = join(root, "local", "team.json");
  try {
    const remote = join(root, "remote.git");
    await git("init", "--bare", "--initial-branch=main", remote);
    const api = await fresh();
    const connected = await api.connectBoard(remote, "main");
    const cfg = { ...connected };
    await git("-C", cfg.dir, "config", "user.name", "HQ regression");
    await git("-C", cfg.dir, "config", "user.email", "hq-test@example.invalid");
    await run({ root, remote, api, cfg });
  } finally {
    if (oldDir === undefined) delete process.env.PASEO_HQ_TEAM_DIR;
    else process.env.PASEO_HQ_TEAM_DIR = oldDir;
    if (oldConfig === undefined) delete process.env.PASEO_HQ_TEAM_CONFIG;
    else process.env.PASEO_HQ_TEAM_CONFIG = oldConfig;
    await rm(root, { recursive: true, force: true });
  }
}

async function remoteBoard(remote, revision = "HEAD") {
  return JSON.parse(await git("--git-dir", remote, "show", `${revision}:hq.json`));
}

async function otherHostView(root, remote, incoming) {
  const dir = join(root, "other-host", "repo");
  await git("clone", "--branch", "main", remote, dir);
  const cfg = { id: "another-host", url: remote, branch: "main", dir };
  const code = `import { readBoard, saveBoard } from ${JSON.stringify(moduleUrl.href)};
    ${incoming ? `await saveBoard(${JSON.stringify(cfg)}, ${JSON.stringify(incoming)});` : ""}
    console.log(JSON.stringify(await readBoard(${JSON.stringify(cfg)})));`;
  const result = await exec(process.execPath, ["--input-type=module", "-e", code], {
    timeout: 20_000,
    env: {
      ...process.env,
      PASEO_HQ_TEAM_DIR: join(root, "other-host", "state"),
      PASEO_HQ_TEAM_CONFIG: join(root, "other-host", "team.json"),
    },
  });
  return JSON.parse(result.stdout);
}

// Install the watcher before checking existence: do not miss the hook's notification.
async function waitForFile(path, parent) {
  let finish;
  const ready = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  const check = () => access(path).then(finish.resolve, () => {});
  const watcher = watch(parent, check);
  const timer = setTimeout(() => finish.reject(new Error("push hook did not start")), 10_000);
  try {
    await check();
    await ready;
  } finally {
    clearTimeout(timer);
    watcher.close();
  }
}

test("personal tasks stay local across flush/restart and never enter Git history", { timeout: 30_000 }, async () => {
  await fixture(async ({ root, remote, api, cfg }) => {
    const privateTask = task("private", "PRIVATE_SENTINEL", true);
    await api.applyBoardChange(cfg.id, board([task("shared", "Shared"), privateTask]));
    await api.flushAll();

    const shared = await remoteBoard(remote);
    assert.deepEqual(shared.tasks.map((t) => t.id), ["shared"]);
    for (const revision of (await git("--git-dir", remote, "log", "--all", "--format=%H", "--", "hq.json")).split("\n")) {
      assert.equal(JSON.stringify(await remoteBoard(remote, revision)).includes("PRIVATE_SENTINEL"), false);
    }
    assert.equal((await api.boardView(cfg.id)).tasks.some((t) => t.id === "private"), true);
    assert.equal((await (await fresh()).boardView(cfg.id)).tasks.some((t) => t.id === "private"), true);
    assert.equal((await otherHostView(root, remote)).tasks.some((t) => t.id === "private"), false);
    const localDir = join(process.env.PASEO_HQ_TEAM_DIR, "local-boards");
    const [file] = await readdir(localDir);
    assert.equal((await stat(localDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(localDir, file))).mode & 0o777, 0o600);
    assert.equal((await readFile(join(localDir, file), "utf8")).includes("PRIVATE_SENTINEL"), true);
    await assert.rejects(access(join(cfg.dir, "hq.pending.json")), { code: "ENOENT" });

    // The standalone save path must use the same shared/private split.
    await api.saveBoard(cfg, board([task("standalone-private", "ANOTHER_PRIVATE_SENTINEL", true)]));
    assert.equal(JSON.stringify(await remoteBoard(remote)).includes("ANOTHER_PRIVATE_SENTINEL"), false);
    assert.equal((await api.boardView(cfg.id)).tasks.some((t) => t.id === "standalone-private"), true);
    await api.applyBoardChange(cfg.id, board([task("later-public", "UI change after saveBoard")]));
    await api.flushAll();
    assert.equal((await (await fresh()).boardView(cfg.id)).tasks.some((t) => t.id === "standalone-private"), true);
  });
});

for (const mode of ["flush", "saveBoard"]) {
test(`edits and deletions during ${mode} push survive acknowledgment, restart and the next flush`, { timeout: 30_000 }, async () => {
  await fixture(async ({ root, remote, api, cfg }) => {
    await api.applyBoardChange(cfg.id, board([task("edit", "Initial"), task("remove", "Delete later")]));
    await api.flushAll();

    const started = join(root, "push-started");
    const release = join(root, "push-release");
    const hook = `#!/bin/sh
touch "${started}"
while test ! -f "${release}"; do sleep 0.02; done
`;
    await writeFile(join(remote, "hooks", "pre-receive"), hook, { mode: 0o700 });
    const snapshot = board([task("edit", "Snapshot", false, "2026-01-02T00:00:00.000Z")]);
    let pushing;
    if (mode === "saveBoard") pushing = api.saveBoard(cfg, snapshot);
    else {
      await api.applyBoardChange(cfg.id, snapshot);
      pushing = api.flushAll();
    }
    try {
      await waitForFile(started, root);
      await assert.rejects(api.saveBoard(cfg, board([task("must-not-save", "Overlapping save")])), /синхронизация уже выполняется/);
      await api.applyBoardChange(
        cfg.id,
        board([task("edit", "Latest", false, "2026-01-03T00:00:00.000Z"), task("added", "New during push")]),
        ["remove"],
      );
    } finally {
      await writeFile(release, "release\n");
      await pushing;
    }

    const assertLatest = (view) => {
      assert.equal(view.tasks.find((t) => t.id === "edit")?.title, "Latest");
      assert.equal(view.tasks.some((t) => t.id === "added"), true);
      assert.equal(view.tasks.some((t) => t.id === "remove"), false);
      assert.equal(view.tasks.some((t) => t.id === "must-not-save"), false);
    };
    assertLatest(await api.boardView(cfg.id));
    const restarted = await fresh();
    assertLatest(await restarted.boardView(cfg.id));
    await restarted.flushAll();
    assertLatest(await remoteBoard(remote));
  });
});
}

test("personal/shared transitions, deletion and reconnect preserve the local boundary", { timeout: 30_000 }, async () => {
  await fixture(async ({ remote, api, cfg }) => {
    await api.applyBoardChange(cfg.id, board([task("flip", "Initially shared")]));
    await api.flushAll();
    await api.applyBoardChange(cfg.id, board([task("flip", "Now private", true, "2026-01-02T00:00:00.000Z")]));
    await api.flushAll();
    assert.equal((await remoteBoard(remote)).tasks.some((t) => t.id === "flip"), false);

    await api.disconnectBoard(cfg.id);
    const reconnected = await api.connectBoard(`file://${remote}`, "main");
    assert.equal((await api.boardView(reconnected.id)).tasks.find((t) => t.id === "flip")?.title, "Now private");
    await api.applyBoardChange(reconnected.id, board([task("flip", "Public again", false, "2026-01-03T00:00:00.000Z")]));
    await api.flushAll();
    assert.equal((await remoteBoard(remote)).tasks.find((t) => t.id === "flip")?.title, "Public again");
    assert.equal((await (await fresh()).boardView(reconnected.id)).tasks.find((t) => t.id === "flip")?.personal, false);

    await api.applyBoardChange(reconnected.id, board([task("delete-private", "Delete me", true)]));
    await api.flushAll();
    await api.applyBoardChange(reconnected.id, board([]), ["delete-private"]);
    await api.flushAll();
    assert.equal((await (await fresh()).boardView(reconnected.id)).tasks.some((t) => t.id === "delete-private"), false);
  });
});

test("legacy shared personal tasks are not adopted; old Git history is not rewritten", { timeout: 30_000 }, async () => {
  await fixture(async ({ remote, api, cfg }) => {
    await writeFile(join(cfg.dir, "hq.json"), JSON.stringify(board([
      task("shared", "Shared"),
      task("legacy", "PREVIOUSLY_LEAKED", true),
    ])));
    await git("-C", cfg.dir, "add", "hq.json");
    await git("-C", cfg.dir, "commit", "-m", "legacy fixture");
    await git("-C", cfg.dir, "push", "origin", "main");
    assert.equal((await api.readBoard(cfg)).tasks.some((t) => t.id === "legacy"), false);

    await api.applyBoardChange(cfg.id, board([task("new", "New public task")]));
    await api.flushAll();
    assert.equal(JSON.stringify(await remoteBoard(remote)).includes("PREVIOUSLY_LEAKED"), false);
    assert.equal(JSON.stringify(await remoteBoard(remote, "HEAD~1")).includes("PREVIOUSLY_LEAKED"), true);
  });
});

test("legacy local pending data migrates atomically outside the repository and survives flush", { timeout: 30_000 }, async () => {
  await fixture(async ({ remote, cfg }) => {
    const legacy = join(cfg.dir, "hq.pending.json");
    await writeFile(legacy, JSON.stringify({
      board: board([task("shared", "Pending public"), task("private", "Pending personal", true)]),
      removedTaskIds: [],
      removedMemberIds: [],
    }), { mode: 0o600 });
    const restarted = await fresh();
    assert.equal((await restarted.boardView(cfg.id)).tasks.length, 2);
    await assert.rejects(access(legacy), { code: "ENOENT" });
    await restarted.flushAll();
    assert.deepEqual((await remoteBoard(remote)).tasks.map((t) => t.id), ["shared"]);
    assert.equal((await (await fresh()).boardView(cfg.id)).tasks.some((t) => t.id === "private"), true);
  });
});

test("corrupt local data is surfaced without replacing the private file", { timeout: 30_000 }, async () => {
  await fixture(async ({ api, cfg }) => {
    await api.applyBoardChange(cfg.id, board([task("private", "Keep private", true)]));
    await api.flushAll();
    const dir = join(process.env.PASEO_HQ_TEAM_DIR, "local-boards");
    const [name] = await readdir(dir);
    const path = join(dir, name);
    const original = await readFile(path, "utf8");
    await writeFile(path, "{corrupt");
    const restarted = await fresh();
    await assert.rejects(restarted.boardView(cfg.id), SyntaxError);
    assert.equal(await readFile(path, "utf8"), "{corrupt");
    await writeFile(path, original);
    assert.equal((await restarted.boardView(cfg.id)).tasks.some((t) => t.id === "private"), true);
  });
});

test("concurrent first edits persist every task rather than replacing the first draft", { timeout: 30_000 }, async () => {
  await fixture(async ({ remote, api, cfg }) => {
    await Promise.all([
      api.applyBoardChange(cfg.id, board([task("first", "First")])),
      api.applyBoardChange(cfg.id, board([task("second", "Second")])),
      api.applyBoardChange(cfg.id, board([task("private", "Personal", true)])),
    ]);
    const restarted = await fresh();
    assert.deepEqual((await restarted.boardView(cfg.id)).tasks.map((t) => t.id).sort(), ["first", "private", "second"]);
    await restarted.flushAll();
    assert.deepEqual((await remoteBoard(remote)).tasks.map((t) => t.id).sort(), ["first", "second"]);
  });
});

test("a different branch does not inherit another branch's personal tasks", { timeout: 30_000 }, async () => {
  await fixture(async ({ remote, api, cfg }) => {
    await api.applyBoardChange(cfg.id, board([task("shared", "Public"), task("private", "Main only", true)]));
    await api.flushAll();
    await git("--git-dir", remote, "branch", "another", "main");
    const other = await api.connectBoard(remote, "another");
    assert.deepEqual((await api.boardView(other.id)).tasks.map((t) => t.id), ["shared"]);
    assert.equal((await api.boardView(cfg.id)).tasks.some((t) => t.id === "private"), true);
  });
});

test("saveBoard merges personal changes into a recovered pending draft and the next UI edit", { timeout: 30_000 }, async () => {
  await fixture(async ({ remote, api, cfg }) => {
    await api.applyBoardChange(cfg.id, board([task("pending-private", "Before restart", true)]));
    const restarted = await fresh();
    await restarted.saveBoard(cfg, board([task("saved-private", "Direct save with pending", true)]));
    const assertPrivate = (view) => {
      assert.equal(view.tasks.some((t) => t.id === "pending-private"), true);
      assert.equal(view.tasks.some((t) => t.id === "saved-private"), true);
    };
    assertPrivate(await restarted.boardView(cfg.id));
    await restarted.applyBoardChange(cfg.id, board([task("next-public", "Next UI edit")]));
    await restarted.flushAll();
    assertPrivate(await (await fresh()).boardView(cfg.id));
    assert.equal((await remoteBoard(remote)).tasks.some((t) => t.personal), false);
  });
});

for (const recover of [false, true]) {
  test(`saveBoard preserves accumulated task/member deletions (recovered=${recover})`, { timeout: 30_000 }, async () => {
    await fixture(async ({ remote, api, cfg }) => {
      const initial = board([task("keep-task", "Keep"), task("remove-task", "Remove")]);
      initial.members = [
        { id: "keep-member", name: "Keep member", updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "remove-member", name: "Remove member", updatedAt: "2026-01-01T00:00:00.000Z" },
      ];
      await api.applyBoardChange(cfg.id, initial);
      await api.flushAll();
      await api.applyBoardChange(cfg.id, board([]), ["remove-task"], ["remove-member"]);
      const client = recover ? await fresh() : api;
      await client.saveBoard(cfg, board([task("new-private", "Another change", true)]));
      const assertDeleted = (view) => {
        assert.equal(view.tasks.some((t) => t.id === "remove-task"), false);
        assert.equal(view.members.some((m) => m.id === "remove-member"), false);
        assert.equal(view.tasks.some((t) => t.id === "keep-task"), true);
        assert.equal(view.members.some((m) => m.id === "keep-member"), true);
      };
      assertDeleted(await client.boardView(cfg.id));
      assertDeleted(await remoteBoard(remote));
      assertDeleted(await (await fresh()).boardView(cfg.id));
      await client.applyBoardChange(cfg.id, board([task("later", "Later UI change")]));
      await client.flushAll();
      assertDeleted(await remoteBoard(remote));
    });
  });
}

test("unregistered standalone client persists personal tasks without publishing them", { timeout: 30_000 }, async () => {
  await fixture(async ({ root, remote, api, cfg }) => {
    await api.applyBoardChange(cfg.id, board([task("shared", "Public")]));
    await api.flushAll();
    const view = await otherHostView(root, remote, board([task("standalone-private", "Isolated personal", true)]));
    assert.equal(view.tasks.some((t) => t.id === "standalone-private"), true);
    assert.equal((await remoteBoard(remote)).tasks.some((t) => t.personal), false);
  });
});

test("failed push retains pending changes for restart and a later successful retry", { timeout: 30_000 }, async () => {
  await fixture(async ({ remote, api, cfg }) => {
    const hook = join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await api.applyBoardChange(cfg.id, board([task("shared", "Retry public"), task("private", "Retry private", true)]));
    await api.flushAll();
    const restarted = await fresh();
    assert.equal((await restarted.boardView(cfg.id)).tasks.length, 2);
    await unlink(hook);
    await restarted.flushAll();
    assert.deepEqual((await remoteBoard(remote)).tasks.map((t) => t.id), ["shared"]);
    assert.equal((await (await fresh()).boardView(cfg.id)).tasks.some((t) => t.id === "private"), true);
  });
});
