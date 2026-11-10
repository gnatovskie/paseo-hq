import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createPaseoClient } from "@getpaseo/client";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const title = "HQ session settings fixture";
const output = process.env.BB_THREAD_STORAGE;

async function localPort() {
  const socket = createServer();
  await new Promise((ready, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", ready);
  });
  const { port } = socket.address();
  await new Promise((ready) => socket.close(ready));
  return port;
}

test("HQ session settings in compact and desktop Paseo", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hq-session-settings-"));
  const port = await localPort();
  const endpoint = `127.0.0.1:${port}`;
  const source = join(home, "source");
  const target = join(home, "target");
  const env = { ...process.env, PASEO_HOME: home };
  const paseo = (...args) => execFileSync("paseo", [...args, "--home", home], { env, encoding: "utf8" });
  let client;
  let browser;
  let started = false;

  try {
    await Promise.all([mkdir(source), mkdir(target)]);
    execFileSync("git", ["init", "-q", "-b", "main", source]);
    execFileSync("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "--allow-empty", "-qm", "Test fixture"]);
    await writeFile(join(home, "config.json"), JSON.stringify({
      pluginsEnabled: true,
      daemon: { listen: endpoint, relay: { enabled: false } },
      features: { webUi: { enabled: true } },
    }));
    paseo("daemon", "start", "--timeout", "25");
    started = true;
    paseo("plugin", "add", root);
    paseo("project", "create", source);
    paseo("project", "create", target);
    paseo("workspace", "create", "--path", source, "--isolation", "worktree", "--title", title);

    client = createPaseoClient({ url: `ws://${endpoint}/ws`, reconnect: { enabled: false } });
    await client.connect();
    const { entries: [workspace] } = await client.workspaces.list({});
    assert.notEqual(workspace.workspaceDirectory, source, "fixture must use a separate worktree");
    const workspaceHandle = client.workspaces.ref(workspace.id);
    const chat = await workspaceHandle.agents.create({ title: "Fixture chat", config: { provider: "codex/gpt-5.4" } });
    const secondChat = await workspaceHandle.agents.create({ title: "Second fixture chat", config: { provider: "codex/gpt-5.4" } });
    const { projects } = await client.projects.list({});
    const targetProject = projects.find((project) => project.projectRootPath === target);
    assert(targetProject);

    browser = await chromium.launch({ executablePath: process.env.PASEO_CHROMIUM_EXECUTABLE });
    for (const width of [390, 1280]) {
      await t.test(`${width}px`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 844 },
          permissions: ["clipboard-read", "clipboard-write"],
          colorScheme: width === 390 ? "dark" : "light",
        });
        page.setDefaultTimeout(12_000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        let daemonSocket;
        page.on("websocket", (socket) => {
          if (new URL(socket.url()).pathname === "/ws") daemonSocket = socket;
        });
        const button = (name) => page.getByRole("button", { name, exact: true });
        const openSettings = () => button(`Настройки сессии ${title}`).click();
        const transfer = button("Перенести в проект");
        const archive = page.getByRole("switch", { name: "Архивировать исходную сессию", exact: true });
        const history = page.getByRole("switch", { name: "Перенести историю диалога (fork)", exact: true });
        const draft = page.getByPlaceholder("Новая сессия", { exact: true });
        const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
        const capture = (name) => output && page.screenshot({ path: join(output, `${name}-${width}.png`) });

        try {
          await page.goto(`http://${endpoint}/`);
          if (width === 390) await button("Open menu").click();
          await openSettings();
          await draft.waitFor();
          assert.equal(await archive.count(), 0, "transfer options should open only after pressing the icon");
          const actions = ["Закрепить сессию", "Скопировать ссылку на чат", "Скопировать путь к папке проекта",
            "Перенести в проект", "Архивировать сессию"].map(button);
          await actions[0].click({ trial: true });
          const boxes = await Promise.all(actions.map(async (action) => {
            assert.equal((await action.textContent()).trim(), "");
            assert.equal(await action.locator("svg").count(), 1);
            return action.boundingBox();
          }));
          assert(boxes.every((box, index) => box && box.y === boxes[0].y && (!index || box.x > boxes[index - 1].x)));
          assert(boxes[0].y + boxes[0].height < (await draft.boundingBox()).y);
          await page.getByText("Все чаты в этом воркспейсе (2)", { exact: true }).waitFor();
          assert.equal(await page.getByRole("button", { name: /^(ID|Скопировать ID.*)$/ }).count(), 0);
          await capture("session-settings");

          await actions[1].click();
          await page.getByText("Ссылка на чат скопирована", { exact: true }).waitFor();
          const link = await clipboard();
          assert.match(link, /^paseo:\/\/\/h\/[^/]+\/agent\//);
          assert([chat.id, secondChat.id].includes(link.split("/").at(-1)));
          await actions[2].click();
          await page.getByText("Путь скопирован", { exact: true }).waitFor();
          assert.equal(await clipboard(), source);

          await draft.fill("Unsaved title");
          await transfer.click();
          await page.getByText("Перенос в проект", { exact: true }).waitFor();
          await button("Целевой проект: target").waitFor();
          assert.equal(await archive.getAttribute("aria-checked"), "true");
          assert.equal(await history.getAttribute("aria-checked"), "true");
          await history.click();
          assert.equal(await history.getAttribute("aria-checked"), "false");
          await capture("session-transfer");
          await button("Close").last().click();
          await archive.waitFor({ state: "hidden" });
          assert.equal(await draft.inputValue(), "Unsaved title");

          if (width === 1280) {
            await actions[0].click();
            await draft.waitFor({ state: "hidden" });
            await openSettings();
            await button("Открепить сессию").waitFor();
            await transfer.click();
            await history.click();
            await transfer.last().click();
            await page.getByText('Сессия перенесена в проект "target"', { exact: true }).waitFor();
            const { entries } = await client.workspaces.list({});
            const moved = entries.find((entry) => entry.projectId === targetProject.projectId && entry.title === title);
            assert.equal(moved?.workspaceDirectory, target);
            assert(!entries.some((entry) => entry.id === workspace.id));
            await page.waitForURL((url) => url.pathname.endsWith(`/workspace/${moved.id}`));
            await openSettings();
            assert(daemonSocket);
            const [archiveFrame] = await Promise.all([
              daemonSocket.waitForEvent("framereceived", {
                predicate: ({ payload }) => String(payload).includes('"archive_workspace_response"'),
                timeout: 30_000,
              }),
              actions[4].click(),
            ]);
            const result = JSON.parse(String(archiveFrame.payload)).message.payload;
            assert.equal(result.workspaceId, moved.id);
            assert.equal(result.error, null);
            await draft.waitFor({ state: "hidden" });
            const remaining = await client.workspaces.list({});
            assert(!remaining.entries.some((entry) => entry.id === moved.id));
          }
          assert.deepEqual(errors, []);
        } catch (error) {
          await capture("session-settings-failure");
          throw error;
        } finally {
          await page.close();
        }
      });
    }
  } finally {
    await browser?.close();
    await client?.close();
    if (started) paseo("daemon", "stop");
    await rm(home, { recursive: true, force: true });
  }
});
