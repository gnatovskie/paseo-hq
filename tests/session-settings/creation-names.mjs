import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
const output = process.env.BB_THREAD_STORAGE ?? "/tmp/session-name-screens";

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
    await Promise.all([mkdir(source), mkdir(target), mkdir(output, { recursive: true })]);
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
    for (const width of (process.env.PASEO_TEST_WIDTHS ?? "390,1280").split(",").map(Number)) {
      await t.test(`${width}px`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 844 },
          hasTouch: width === 390,
          permissions: ["clipboard-read", "clipboard-write"],
          colorScheme: width === 390 ? "dark" : "light",
        });
        page.setDefaultTimeout(40_000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        let daemonSocket;
        page.on("websocket", (socket) => {
          if (new URL(socket.url()).pathname === "/ws") daemonSocket = socket;
        });
        const selectCodex = async () => {
          await page.getByRole("button", { name: "Выбрать модель нового агента", exact: true }).click();
          const menu = page.getByRole("menu", { name: "Модели нового агента", exact: true });
          await menu.getByPlaceholder("Поиск модели по всем провайдерам").fill("codex/gpt-6-luna");
          await menu.getByRole("menuitem", { name: /^Выбрать модель codex\// }).first().click();
        };
        const button = (name) => page.getByRole("button", { name, exact: true });
        const areaActions = button(`Действия области ${title}`);
        const openArea = async () => {
          if (!await areaActions.isVisible()) await sidebar.getByText("source", { exact: true }).click();
          await areaActions.click();
        };
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
          await button("Новая область в проекте source").waitFor();
        };
        const transfer = button("Перенести в проект");
        const archive = page.getByRole("switch", { name: "Архивировать исходную область", exact: true });
        const history = page.getByRole("switch", { name: "Перенести историю последнего агента", exact: true });
        const draft = page.getByPlaceholder("Новая область", { exact: true });
        const areaContents = page.getByText("Сессии", { exact: true });
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
          await sidebar.getByRole("tab", { name: "Пулы" }).click();
          await sidebar.getByText("Сервис готовится. Здесь появятся пулы генераций проекта.").waitFor();
          assert.equal(await button("Новая область в проекте source").count(), 0);
          await sidebar.getByRole("tab", { name: "Области" }).click();
          await openArea();
          await button("Закрыть").last().click();
          const quick = button(`Новая сессия в области ${title}`);
          if (await areaToggle.getAttribute("aria-expanded") === "true") await areaToggle.click();
          assert.equal(await quick.count(), 0);
          const statusBox = await areaToggle.getByLabel(/^Неактивных сессий:/).boundingBox();
          await areaToggle.click();
          await quick.waitFor();
          const [quickBox, branchBox] = await Promise.all([quick.boundingBox(), page.getByLabel("Ветка области hq-next", { exact: true }).boundingBox()]);
          assert(quickBox.x + quickBox.width <= branchBox.x, "quick creation precedes the Git badge");
          assert.equal(quickBox.height, branchBox.height, "action and branch badges share a height");
          assert.equal(quickBox.height, statusBox.height, "expanded action matches collapsed status badges");
          assert(quickBox.width <= 42, "paired icons stay compact");
          await capture("area-quick-session");
          await quick.click();
          await page.getByRole("textbox", { name: "Название нового агента", exact: true }).waitFor();
          assert.equal(await areaToggle.getAttribute("aria-expanded"), "true", "quick action does not collapse the area");
          await button("Закрыть").last().click();
          await openArea();
          const info = () => page.getByRole("dialog").last();
          await page.getByRole("dialog").last().getByRole("button", { name: "Меню агента Fixture chat", exact: true }).click();
          const snapshot = (await client.agents.list()).entries.find(({ agent }) => agent.id === chat.id).agent;
          await info().getByLabel(`Провайдер агента: ${snapshot.provider.split("/")[0]}`, { exact: true }).waitFor();
          await info().getByLabel(`Модель агента: ${snapshot.model || snapshot.provider.split("/").slice(1).join("/") || "Не указана"}`, { exact: true }).waitFor();
          await info().getByLabel("Текущая ветка: hq-next", { exact: true }).waitFor();
          await info().getByLabel(`Рабочая папка сессии: ${workspace.workspaceDirectory}`, { exact: true }).waitFor();
          await info().getByLabel(`Ссылка на агента: ID: ${chat.id}`, { exact: true }).waitFor();
          for (const label of ["Скопировать ссылку на агента", "Скопировать ветку", "Скопировать рабочую папку"]) await info().getByRole("button", { name: label, exact: true }).waitFor();
          await capture("agent-session-information");
          await button("Закрыть").last().click();
          await page.getByRole("dialog").last().getByRole("button", { name: "Меню терминала Fixture terminal", exact: true }).click();
          await info().getByLabel("Текущая ветка: hq-next", { exact: true }).waitFor();
          await info().getByLabel(`Рабочая папка сессии: ${workspace.workspaceDirectory}`, { exact: true }).waitFor();
          assert.equal(await info().getByText("Провайдер", { exact: true }).count(), 0);
          await capture("terminal-session-information");
          await button("Закрыть").last().click();
          await button("Новая сессия").click();
          const agentName = page.getByRole("textbox", { name: "Название нового агента", exact: true });
          const terminalName = page.getByRole("textbox", { name: "Название нового терминала", exact: true });
          await agentName.fill(`Проверка агента ${width}`);
          assert.equal(await button("Сгенерировать название сессии").count(), 0);
          const editAtEnd = async (field) => {
            await field.evaluate(input => { input.focus(); input.setSelectionRange(0, 0); });
            await button("Редактировать название сессии").click();
            await page.waitForFunction(label => {
              const input = document.querySelector(`input[aria-label="${label}"]`);
              return document.activeElement === input && input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
            }, await field.getAttribute("aria-label"));
          };
          await editAtEnd(agentName);
          await editAtEnd(agentName);
          await capture("session-name-agent");
          await selectCodex();
          await button("Создать агента с выбранной моделью").click();
          await agentName.waitFor({ state: "hidden" });
          const created = (await client.agents.list({})).entries.find(({ agent }) => agent.title === `Проверка агента ${width}`);
          assert(created);
          assert.equal(created.agent.workspaceId, workspace.id);
          assert.equal(created.agent.cwd, workspace.workspaceDirectory);
          await enterSidebar();
          await openArea();
          await button("Новая сессия").click();
          assert.equal(await agentName.inputValue(), "", "a new form has no stale draft");
          await button("Терминал").click();
          await terminalName.fill(`Терминал ${width}`);
          await editAtEnd(terminalName);
          await capture("session-name-terminal");
          await button("Создать терминал").click();
          await terminalName.waitFor({ state: "hidden" });
          assert((await workspaceHandle.terminals.list()).entries.some(item => item.name === `Терминал ${width}`));
          await enterSidebar();
          await button("Новая область в проекте target").click();
          await newAreaName.fill(`Новая ${width}`);
          await agentName.fill(`Первый ${width}`);
          await editAtEnd(agentName);
          await selectCodex();
          await button("Создать область").click();
          await agentName.waitFor({ state: "hidden" });
          const area = (await client.workspaces.list()).entries.find(item => item.title === `Новая ${width}`);
          assert(area);
          assert((await client.agents.list({})).entries.some(({ agent }) => agent.workspaceId === area.id && agent.title === `Первый ${width}`));
          await enterSidebar();
          await button("Новая область в проекте target").click();
          await newAreaName.fill(`Область терминала ${width}`);
          await button("Терминал").click();
          await terminalName.fill(`Первый терминал ${width}`);
          await editAtEnd(terminalName);
          await button("Создать область").click();
          await terminalName.waitFor({ state: "hidden" });
          const terminalArea = (await client.workspaces.list()).entries.find(item => item.title === `Область терминала ${width}`);
          assert(terminalArea);
          assert((await client.workspaces.ref(terminalArea.id).terminals.list()).entries.some(item => item.name === `Первый терминал ${width}`));
          await enterSidebar();
          const plainToggle = button(`Сессии области Область терминала ${width}`);
          if (await plainToggle.getAttribute("aria-expanded") !== "true") await plainToggle.click();
          assert.equal(await plainToggle.getByLabel(/^Ветка области /).count(), 0);
          await capture("area-without-git");
          await button(`Новая сессия в области Область терминала ${width}`).click();
          await button("Терминал").click();
          await page.getByLabel(`Папка терминала: ${terminalArea.workspaceDirectory}`, { exact: true }).waitFor();
          await button("Закрыть").last().click();
          assert.deepEqual(errors, []);
        } catch (error) {
          console.error(await page.locator("body").innerText());
          console.error(paseo("plugin", "logs", "paseo-hq"));
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
