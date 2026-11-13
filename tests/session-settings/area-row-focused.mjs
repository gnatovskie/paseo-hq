import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const title = "HQ area settings fixture";
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

test("HQ area and session controls in compact and desktop Paseo", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hq-session-settings-"));
  const port = await localPort();
  const endpoint = `127.0.0.1:${port}`;
  const source = join(home, "source");
  const target = join(home, "target");
  const stateFile = join(home, "hq-state.json");
  const env = { ...process.env, PASEO_HOME: home, PASEO_HQ_STATE_FILE: stateFile };
  const paseo = (...args) => execFileSync("paseo", [...args, "--home", home], { env, encoding: "utf8" });
  let client;
  let daemon;
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
      features: { webUi: { enabled: true }, dictation: { enabled: false }, voiceMode: { enabled: false } },
    }));
    paseo("daemon", "start", "--timeout", "25");
    started = true;
    paseo("plugin", "add", root);
    paseo("project", "create", source);
    paseo("project", "create", target);
    paseo("workspace", "create", "--path", source, "--isolation", "worktree", "--title", title);

    daemon = new DaemonClient({
      url: `ws://${endpoint}/ws`,
      clientId: "hq-session-settings-smoke",
      clientType: "cli",
      appVersion: "0.15.2",
      reconnect: { enabled: false },
    });
    await daemon.connect();
    client = createPaseoApi(daemon);
    const assertInHistory = async (agentId, workspaceId, expectedTitle) => {
      const { entries } = await daemon.fetchAgentHistory({});
      const stored = entries.find(({ agent }) => agent.id === agentId)?.agent;
      assert(stored?.archivedAt, "the archived session is in History");
      assert.equal(stored.workspaceId, workspaceId);
      if (expectedTitle !== undefined) assert.equal(stored.title, expectedTitle);
    };
    const { entries: [workspace] } = await client.workspaces.list({});
    assert.notEqual(workspace.workspaceDirectory, source, "fixture must use a separate worktree");
    const workspaceHandle = client.workspaces.ref(workspace.id);
    const git = (...args) => execFileSync("git", ["-C", workspace.workspaceDirectory, ...args], { encoding: "utf8" }).trim();
    const firstBranch = git("branch", "--show-current");
    assert(firstBranch);
    await writeFile(stateFile, JSON.stringify({ projects: { [workspace.projectId]: { sessionTitleModel: "first_line" } } }));
    const chat = await workspaceHandle.agents.create({ title: "Fixture chat", config: { provider: "codex/gpt-5.4" } });
    git("switch", "-qc", "hq-next");
    const secondChat = await workspaceHandle.agents.create({ title: "Second fixture chat", config: { provider: "codex/gpt-5.4" } });
    const { projects } = await client.projects.list({});
    const targetProject = projects.find((project) => project.projectRootPath === target);
    assert(targetProject);
    const fixtureTerminal = await workspaceHandle.terminals.create({
      name: "Fixture terminal",
      command: "sh",
      args: ["-c", "printf 'HQ terminal fixture\n'; exec sleep 300"],
    });

    browser = await chromium.launch({ executablePath: process.env.PASEO_CHROMIUM_EXECUTABLE });
    for (const width of [390, 1280]) {
      await t.test(`${width}px`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 844 },
          hasTouch: width === 390,
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
        const areaActions = button(`Действия области ${title}`);
        const openArea = () => areaActions.click();
        const settings = button("Настройки области");
        const openSettings = () => settings.click();
        const editTitle = button("Редактировать название области");
        const areaIcon = button("Выбрать иконку области");
        const generate = button("Сгенерировать название");
        const areaToggle = button(`Сессии области ${title}`);
        const sidebar = button("Новая область в проекте source").locator("../..");
        const sidebarSession = sidebar.getByRole("button", { name: "Открыть агента Fixture chat", exact: true });
        const sidebarTerminal = sidebar.getByRole("button", { name: "Открыть терминал Fixture terminal", exact: true });
        const newAreaName = page.getByRole("textbox", { name: "Название новой области", exact: true });
        const choose = async (trigger, choice) => {
          await button(trigger).click();
          await page.getByRole("menuitem", { name: choice, exact: true }).click();
        };
        const enterSidebar = async () => {
          await page.goto(`http://${endpoint}/`);
          if (width === 390) await button("Open menu").click();
          await areaToggle.waitFor();
        };
        const transfer = button("Перенести в проект");
        const archive = page.getByRole("switch", { name: "Архивировать исходную область", exact: true });
        const history = page.getByRole("switch", { name: "Перенести историю последнего агента", exact: true });
        const draft = page.getByPlaceholder("Новая область", { exact: true });
        const areaContents = page.getByRole("dialog").getByText("Сессии", { exact: true });
        const settingsHeading = page.getByText("Настройки области", { exact: true });
        const iconPicker = page.getByText("Иконка области", { exact: true });
        const closeSettings = async () => {
          await button("Закрыть").last().click();
          await settingsHeading.waitFor({ state: "hidden" });
        };
        const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
        const capture = (name) => output && page.screenshot({ path: join(output, `${name}-${width}.png`) });

        try {
          await enterSidebar();
          await openArea();
          const previousAgents = (await client.agents.list({})).entries.map(({ agent }) => agent);
          const previousAgentIds = new Set(previousAgents.map(agent => agent.id));
          await button("Новая сессия").click();
          await page.getByText("Модель нового агента", { exact: true }).waitFor();
          assert.equal((await client.agents.list({})).entries.filter(({ agent }) => agent.workspaceId === workspace.id).length,
            previousAgents.filter(agent => agent.workspaceId === workspace.id).length);
          await button("Выбрать модель нового агента").click();
          const agentModels = page.getByRole("menu", { name: "Модели нового агента" });
          await agentModels.waitFor();
          const choices = agentModels.getByRole("menuitem", { name: /^Выбрать модель / });
          assert((await choices.count()) > 1, "fixture needs more than one available model");
          const chosenModel = (await choices.last().getAttribute("aria-label")).replace("Выбрать модель ", "");
          await choices.last().click();
          await button("Создать агента с выбранной моделью").click();
          await page.getByText("Модель нового агента", { exact: true }).waitFor({ state: "hidden" });
          const createdAgent = (await client.agents.list({})).entries.find(({ agent }) =>
            agent.workspaceId === workspace.id && !previousAgentIds.has(agent.id))?.agent;
          assert(createdAgent, "plus creates the selected agent");
          assert.equal(`${createdAgent.provider}/${createdAgent.model}`, chosenModel);
          await enterSidebar();
          await openArea();
          const input = page.getByRole("textbox", { name: "Название области", exact: true });
          await input.waitFor();
          assert.equal(await button("Выбрать иконку области").count(), 0);
          assert.equal(await button("Редактировать название области").count(), 0);
          const box = await input.boundingBox();
          await input.click({ position: { x: 2, y: box.height / 2 } });
          assert.equal(await input.evaluate(element => element.selectionStart), 0);
          const updated = "🧠 Area name";
          await input.fill(updated);
          await page.getByRole("dialog").getByText("Сессии", { exact: true }).click();
          await page.waitForFunction(async ({ id, expected }) => {
            const button = document.querySelector(`[aria-label="Сессии области ${expected}"]`);
            return Boolean(button);
          }, { id: workspace.id, expected: updated });
          assert.equal((await workspaceHandle.refresh()).title, updated);
          await input.click();
          await input.fill(title);
          await page.getByRole("dialog").getByText("Сессии", { exact: true }).click();
          await page.waitForFunction(expected => Boolean(document.querySelector(`[aria-label="Сессии области ${expected}"]`)), title);
          assert.equal((await workspaceHandle.refresh()).title, title);
          await button("Закрыть").last().click();
          await button("Новая область в проекте source").click();
          await page.getByText("Модель нового агента", { exact: true }).waitFor();
          const newAreaTitle = `Model choice area ${width}`;
          await newAreaName.fill(newAreaTitle);
          await button("Выбрать модель нового агента").click();
          const newAreaChoice = page.getByRole("menu", { name: "Модели нового агента" })
            .getByRole("menuitem", { name: /^Выбрать модель / }).last();
          const newAreaModel = (await newAreaChoice.getAttribute("aria-label")).replace("Выбрать модель ", "");
          await newAreaChoice.click();
          await button("Создать область").click();
          await page.getByRole("textbox", { name: "Название новой области" }).waitFor({ state: "hidden" });
          const createdArea = (await client.workspaces.list({})).entries.find(area => area.title === newAreaTitle);
          assert(createdArea, "project plus creates the new area");
          const firstAgent = (await client.agents.list({})).entries.find(({ agent }) => agent.workspaceId === createdArea.id)?.agent;
          assert(firstAgent, "new area starts with an agent");
          assert.equal(`${firstAgent.provider}/${firstAgent.model}`, newAreaModel);
          assert.deepEqual(errors, []);
        } catch (error) {
          try {
            await capture("session-settings-failure");
          } catch (captureError) {
            console.error("Could not capture the failing screen", captureError);
          }
          throw error;
        } finally {
          await page.close();
        }
      });
    }
  } finally {
    await browser?.close();
    await client?.dispose();
    await daemon?.close();
    if (started) paseo("daemon", "stop");
    await rm(home, { recursive: true, force: true });
  }
});
