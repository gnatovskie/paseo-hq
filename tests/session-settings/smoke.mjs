import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      features: { webUi: { enabled: true } },
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
        const areaSettings = button(`Настройки области ${title}`);
        const openSettings = () => areaSettings.click();
        const areaToggle = button(`Сессии области ${title}`);
        const sidebar = button("Новая область в проекте source").locator("../..");
        const sidebarSession = sidebar.getByRole("button", { name: "Открыть сессию Fixture chat", exact: true });
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
        const history = page.getByRole("switch", { name: "Перенести историю последней сессии", exact: true });
        const draft = page.getByPlaceholder("Новая область", { exact: true });
        const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
        const capture = (name) => output && page.screenshot({ path: join(output, `${name}-${width}.png`) });

        try {
          await enterSidebar();
          await sidebar.getByText(/^1 область(?: · .+)?$/).waitFor();
          await button("Новая область в проекте source").click();
          await newAreaName.waitFor();
          assert.equal(await newAreaName.inputValue(), "Новая сессия");
          await button("Открыть в новой области: Сессия").waitFor();
          assert.equal((await client.workspaces.list({})).entries.length, 1, "opening the form creates nothing");
          await button("Close").last().click();
          await newAreaName.waitFor({ state: "hidden" });

          const areaTitle = areaToggle.getByText(title, { exact: true });
          assert.equal(await areaToggle.getAttribute("aria-expanded"), "false");
          assert.equal(await sidebarSession.count(), 0);
          await areaToggle.click();
          assert.equal(await areaToggle.getAttribute("aria-expanded"), "true");
          await sidebarSession.waitFor();
          await sidebarTerminal.waitFor();
          await sidebarTerminal.getByText(workspace.workspaceDirectory, { exact: true }).waitFor();
          assert.equal(await sidebar.getByText(/^\d+ сесси[ийя]$/).count(), 0);
          assert.equal(await button(`Новая сессия в области ${title}`).count(), 0, "creation belongs in area settings");
          const [areaTitleBox, areaBox, sessionTitleBox, statusBox, modelBox, settingsBox] = await Promise.all([
            areaTitle.boundingBox(),
            areaToggle.boundingBox(),
            sidebarSession.getByText("Fixture chat", { exact: true }).boundingBox(),
            sidebarSession.getByLabel(/^Статус сессии: /).boundingBox(),
            sidebarSession.getByText("Codex", { exact: true }).locator("..").boundingBox(),
            areaSettings.boundingBox(),
          ]);
          assert(areaTitleBox && areaBox && sessionTitleBox && statusBox && modelBox && settingsBox);
          assert(sessionTitleBox.x > areaTitleBox.x, "nested session is indented");
          assert.equal(statusBox.width, 14);
          assert.equal(statusBox.x + statusBox.width / 2, areaBox.x + 20, "the status occupies the former tree line");
          assert.equal(statusBox.x + statusBox.width + 12, sessionTitleBox.x);
          assert.equal(modelBox.x, sessionTitleBox.x);
          const statusCenterY = statusBox.y + statusBox.height / 2;
          assert(statusCenterY > sessionTitleBox.y + sessionTitleBox.height / 2);
          assert(statusCenterY < modelBox.y + modelBox.height / 2);
          if (output) await sidebar.screenshot({ path: join(output, `hq-nested-sidebar-${width}.png`) });

          if (width === 1280) {
            await sidebarTerminal.click();
            await page.locator(".xterm").first().waitFor({ state: "visible" });
            assert.equal(new URL(page.url()).pathname.split("/").at(-1), workspace.id);
            await enterSidebar();
            await areaToggle.click();
          }
          const copySessionLink = button("Скопировать ссылку на сессию");
          const sessionActions = [
            copySessionLink, button("Переименовать сессию"), button("Перезагрузить сессию"), button("Закрыть сессию"),
          ];
          const expectSessionActions = () => Promise.all(sessionActions.map((action) => action.waitFor()));
          await sidebar.getByRole("button", { name: "Меню сессии Fixture chat", exact: true }).click();
          await expectSessionActions();
          await capture("sidebar-session-menu");
          await copySessionLink.click();
          await copySessionLink.waitFor({ state: "hidden" });
          const link = await clipboard();
          assert.match(link, /^paseo:\/\/\/h\/[^/]+\/agent\//);
          assert.equal(link.split("/").at(-1), chat.id);
          assert(await sidebarSession.isVisible(), "copy leaves the sidebar area expanded");
          await Promise.all([
            daemonSocket.waitForEvent("framesent", {
              predicate: ({ payload }) => {
                const message = JSON.parse(String(payload)).message;
                return message?.type === "fetch_agent_timeline_request" && message.agentId === chat.id;
              },
            }),
            sidebarSession.click(),
          ]);
          await page.getByText("Start chatting with this agent...", { exact: true }).filter({ visible: true }).first().waitFor();
          if (width === 390 && !await areaToggle.isVisible()) await button("Open menu").click();
          if (await areaToggle.getAttribute("aria-expanded") === "true") await areaToggle.click();
          await sidebarSession.waitFor({ state: "hidden" });
          await sidebarTerminal.waitFor({ state: "hidden" });
          await openSettings();
          await draft.waitFor();
          assert.equal(await archive.count(), 0, "transfer options should open only after pressing the icon");
          const actions = ["Закрепить область", "Скопировать путь к папке проекта",
            "Перенести в проект", "Архивировать область"].map(button);
          const createSession = button("Новая сессия");
          const createTerminal = button("Новый терминал");
          await actions[0].click({ trial: true });
          const boxes = await Promise.all([createSession, createTerminal, ...actions].map(async (action) => {
            assert.equal((await action.textContent()).trim(), "");
            assert.equal(await action.locator("svg").count(), 1);
            return action.boundingBox();
          }));
          assert(boxes.every((box, index) => box && box.y === boxes[0].y && (!index || box.x > boxes[index - 1].x)));
          const lastAction = boxes.at(-1);
          assert(lastAction.x + lastAction.width <= width);
          assert(boxes[0].y + boxes[0].height < (await draft.boundingBox()).y);
          await page.getByText("Сессии и терминалы", { exact: true }).waitFor();
          const chatRows = page.getByRole("button", { name: /^Открыть сессию / });
          assert.equal(await chatRows.count(), 2);
          await button("Ветка по умолчанию: Текущая ветка · hq-next").waitFor();
          await button("Открыть сессию Fixture chat").getByLabel(`Ветка при запуске: ${firstBranch}`).waitFor();
          await button("Открыть сессию Second fixture chat").getByLabel("Ветка при запуске: hq-next").waitFor();
          await button("Открыть терминал Fixture terminal").waitFor();
          assert.equal(await page.getByRole("button", { name: /^(ID|Скопировать ID.*)$/ }).count(), 0);
          assert.equal(await page.getByText(/^ID: [a-f\d]{8}/).count(), 0);
          await capture("session-settings");

          const generate = button("Сгенерировать название");
          const fieldBox = await draft.boundingBox();
          const generateBox = await generate.boundingBox();
          assert(generateBox.x >= fieldBox.x + fieldBox.width);
          assert(Math.abs(generateBox.y + generateBox.height / 2 - fieldBox.y - fieldBox.height / 2) < 2);
          const firstChatLabel = await chatRows.first().getAttribute("aria-label");
          const firstChat = firstChatLabel === "Открыть сессию Fixture chat" ? chat : secondChat;
          assert(daemonSocket);
          const [generationFrame] = await Promise.all([
            daemonSocket.waitForEvent("framesent", {
              predicate: ({ payload }) => JSON.parse(String(payload)).message?.method === "sidebar.title-suggest",
            }),
            generate.click(),
          ]);
          assert.equal(JSON.parse(String(generationFrame.payload)).message.input.agentId, firstChat.id);
          await generate.click({ trial: true });

          assert.equal(await copySessionLink.count(), 0, "copy belongs in the session menu");
          await actions[1].click();
          await page.getByText("Путь скопирован", { exact: true }).waitFor();
          assert.equal(await clipboard(), source);

          await draft.fill("Unsaved title");
          await transfer.click();
          await page.getByText("Перенос области в проект", { exact: true }).waitFor();
          await button("Целевой проект: target").waitFor();
          assert.equal(await archive.getAttribute("aria-checked"), "true");
          assert.equal(await history.getAttribute("aria-checked"), "true");
          await history.click();
          assert.equal(await history.getAttribute("aria-checked"), "false");
          await capture("session-transfer");
          await button("Close").last().click();
          await archive.waitFor({ state: "hidden" });
          assert.equal(await draft.inputValue(), "Unsaved title");

          const selectedChat = link.endsWith(`/${chat.id}`) ? secondChat : chat;
          let selectedTitle = selectedChat.id === chat.id ? "Fixture chat" : "Second fixture chat";
          await button(`Меню сессии ${selectedTitle}`).click();
          await expectSessionActions();
          if (width === 1280) {
            await button("Переименовать сессию").click();
            selectedTitle = "Renamed fixture chat";
            await page.getByPlaceholder("Название сессии", { exact: true }).fill(selectedTitle);
            await button("Переименовать").click();
            await page.getByText("Сессия переименована", { exact: true }).waitFor();
            assert.equal((await client.agents.ref(selectedChat.id).refresh()).agent.title, selectedTitle);
          } else {
            const reloadChat = button("Перезагрузить сессию");
            const [reloadFrame] = await Promise.all([
              daemonSocket.waitForEvent("framesent", {
                predicate: ({ payload }) => JSON.parse(String(payload)).message?.type === "refresh_agent_request",
              }),
              reloadChat.click(),
            ]);
            assert.equal(JSON.parse(String(reloadFrame.payload)).message.agentId, selectedChat.id);
            const reloadResult = page.getByText(/Сессия перезагружена|thread\/items\/list is not supported yet/);
            await reloadResult.waitFor();
            if (await reloadChat.isVisible()) {
              await button("Close").last().click();
              await reloadChat.waitFor({ state: "hidden" });
            }
          }
          const openChat = button(`Открыть сессию ${selectedTitle}`);
          assert.equal(await openChat.count(), 1, "each listed session should be openable");
          await button(`Меню сессии ${selectedTitle}`).click();
          await expectSessionActions();
          await copySessionLink.click();
          await page.waitForFunction(
            async (expected) => await navigator.clipboard.readText() === expected,
            link.replace(/[^/]+$/, selectedChat.id),
          );
          assert(await draft.isVisible(), "copying a session link should keep area settings open");
          assert(daemonSocket);
          await Promise.all([
            daemonSocket.waitForEvent("framesent", {
              predicate: ({ payload }) => {
                const message = JSON.parse(String(payload)).message;
                return message?.type === "fetch_agent_timeline_request" && message.agentId === selectedChat.id;
              },
            }),
            openChat.click(),
          ]);
          await draft.waitFor({ state: "hidden" });
          await page.getByText("Start chatting with this agent...", { exact: true }).filter({ visible: true }).first().waitFor();

          if (width === 1280) {
            await openSettings();
            await choose("Иконка области: Без иконки", "📦");
            await button("Иконка области: 📦").waitFor();
            await button("Close").last().click();
            await areaToggle.getByText("📦", { exact: true }).waitFor();
            await openSettings();
            await choose("Иконка области: 📦", "Без иконки");
            await button("Иконка области: Без иконки").waitFor();
            await button("Close").last().click();
            await areaToggle.getByText("📦", { exact: true }).waitFor({ state: "hidden" });
            await openSettings();
            await choose("Ветка по умолчанию: Текущая ветка · hq-next", firstBranch);
            await button(`Ветка по умолчанию: ${firstBranch}`).waitFor();
            await createSession.click();
            await page.getByText(`Переключите область на ветку «${firstBranch}», чтобы создать сессию`).waitFor();
            assert.equal(git("branch", "--show-current"), "hq-next");
            assert.equal((await client.agents.list({})).entries.filter(({ agent }) => agent.workspaceId === workspace.id).length, 2);
            await choose(`Ветка по умолчанию: ${firstBranch}`, "hq-next");
            await button("Ветка по умолчанию: hq-next").waitFor();
            await createSession.click();
            await draft.waitFor({ state: "hidden" });
            const created = (await client.agents.list({})).entries
              .find(({ agent }) => agent.workspaceId === workspace.id && agent.id !== chat.id && agent.id !== secondChat.id);
            assert(created, "the settings plus creates a session in the same area");
            assert.equal(created.agent.cwd, workspace.workspaceDirectory);
            await openSettings();
            await button("Ветка по умолчанию: hq-next").waitFor();
            const closedTitle = created.agent.title || "Сессия без названия";
            const areaDialog = page.getByRole("dialog").filter({ has: draft });
            await areaDialog.getByRole("button", { name: `Меню сессии ${closedTitle}`, exact: true }).click();
            await button("Закрыть сессию").click();
            await page.getByText("Сессия закрыта", { exact: true }).waitFor();
            await areaDialog.getByRole("button", { name: `Открыть сессию ${closedTitle}`, exact: true }).waitFor({ state: "hidden" });
            await assertInHistory(created.agent.id, workspace.id, created.agent.title);
            await Promise.all([page.waitForEvent("load"), createTerminal.click()]);
            await page.locator(".xterm").first().waitFor({ state: "visible" });
            const { entries: activeTerminals } = await workspaceHandle.terminals.list();
            assert.equal(activeTerminals.length, 2);
            const newTerminal = activeTerminals.find((terminal) => terminal.id !== fixtureTerminal.id);
            assert(newTerminal);

            await enterSidebar();
            await openSettings();
            const fixtureMenu = areaDialog.getByRole("button", { name: "Меню терминала Fixture terminal", exact: true });
            await fixtureMenu.click();
            const copyTerminalPath = button("Скопировать путь терминала");
            await copyTerminalPath.click();
            await copyTerminalPath.waitFor({ state: "hidden" });
            assert.equal(await clipboard(), workspace.workspaceDirectory);
            await fixtureMenu.click();
            await button("Закрыть терминал").click();
            const finishTerminal = button("Завершить терминал");
            await finishTerminal.click();
            await finishTerminal.waitFor({ state: "hidden" });
            await fixtureMenu.waitFor({ state: "hidden" });
            assert.deepEqual((await workspaceHandle.terminals.list()).entries.map((terminal) => terminal.id), [newTerminal.id]);
            await areaDialog.getByRole("button", { name: "Close", exact: true }).click();
            await draft.waitFor({ state: "hidden" });

            if (await areaToggle.getAttribute("aria-expanded") !== "true") await areaToggle.click();
            const newTerminalMenu = sidebar.getByRole("button", { name: `Меню терминала ${newTerminal.name}`, exact: true });
            await newTerminalMenu.click();
            await button("Закрыть терминал").click();
            await button("Отмена").click();
            assert.equal((await workspaceHandle.terminals.list()).entries.length, 1);
            await button("Закрыть терминал").click();
            await finishTerminal.click();
            await finishTerminal.waitFor({ state: "hidden" });
            await newTerminalMenu.waitFor({ state: "hidden" });
            assert.equal((await workspaceHandle.terminals.list()).entries.length, 0);
            await areaToggle.click();
            await openSettings();
            await actions[0].click();
            await draft.waitFor({ state: "hidden" });
            await openSettings();
            await button("Открепить область").waitFor();
            await transfer.click();
            await history.click();
            await transfer.last().click();
            await page.getByText('Область перенесена в проект "target"', { exact: true }).waitFor();
            const { entries } = await client.workspaces.list({});
            const moved = entries.find((entry) => entry.projectId === targetProject.projectId && entry.title === title);
            assert.equal(moved?.workspaceDirectory, target);
            assert(!entries.some((entry) => entry.id === workspace.id));
            await assertInHistory(chat.id, workspace.id, "Fixture chat");
            await assertInHistory(created.agent.id, workspace.id, created.agent.title);
            await page.waitForURL((url) => url.pathname.endsWith(`/workspace/${moved.id}`));
            await openSettings();
            await page.getByText("Сессии и терминалы", { exact: true }).waitFor();
            assert.equal(await page.getByRole("button", { name: /^Открыть сессию / }).count(), 1);
            assert(daemonSocket);
            const [archiveFrame] = await Promise.all([
              daemonSocket.waitForEvent("framereceived", {
                predicate: ({ payload }) => String(payload).includes('"archive_workspace_response"'),
                timeout: 30_000,
              }),
              actions[3].click(),
            ]);
            const result = JSON.parse(String(archiveFrame.payload)).message.payload;
            assert.equal(result.workspaceId, moved.id);
            assert.equal(result.error, null);
            await draft.waitFor({ state: "hidden" });
            const remaining = await client.workspaces.list({});
            assert(!remaining.entries.some((entry) => entry.id === moved.id));
            await button("Новая область в проекте target").click();
            await newAreaName.fill("Project modal session fixture");
            await button("Открыть в новой области: Сессия").waitFor();
            await button("Создать область").click();
            await newAreaName.waitFor({ state: "hidden" });
            const sessionArea = (await client.workspaces.list({})).entries.find((entry) => entry.title === "Project modal session fixture");
            assert(sessionArea);
            const firstSession = (await client.agents.list({})).entries.find(({ agent }) => agent.workspaceId === sessionArea.id)?.agent;
            assert(firstSession);
            const sidebarNewArea = button("Новая область в проекте target").locator("../..");
            const newAreaToggle = button("Сессии области Project modal session fixture");
            if (await newAreaToggle.getAttribute("aria-expanded") !== "true") await newAreaToggle.click();
            const firstSessionTitle = firstSession.title || "Сессия без названия";
            await sidebarNewArea.getByRole("button", { name: `Меню сессии ${firstSessionTitle}`, exact: true }).click();
            await button("Закрыть сессию").click();
            await page.getByText("Сессия закрыта", { exact: true }).waitFor();
            await sidebarNewArea.getByRole("button", { name: `Открыть сессию ${firstSessionTitle}`, exact: true }).waitFor({ state: "hidden" });
            await assertInHistory(firstSession.id, sessionArea.id, firstSession.title);
            await button("Новая область в проекте target").click();
            await newAreaName.fill("Project modal terminal fixture");
            await choose("Открыть в новой области: Сессия", "Терминал");
            await button("Открыть в новой области: Терминал").waitFor();
            await button("Создать область").click();
            await page.locator(".xterm").first().waitFor({ state: "visible" });
            const terminalArea = (await client.workspaces.list({})).entries.find((entry) => entry.title === "Project modal terminal fixture");
            assert(terminalArea);
            assert.equal((await client.workspaces.ref(terminalArea.id).terminals.list()).entries.length, 1);
            assert(!(await client.agents.list({})).entries.some(({ agent }) => agent.workspaceId === terminalArea.id));
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
    await client?.dispose();
    await daemon?.close();
    if (started) paseo("daemon", "stop");
    await rm(home, { recursive: true, force: true });
  }
});
