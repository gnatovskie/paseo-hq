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
        const areaContents = page.getByText("Сессии", { exact: true });
        const settingsHeading = page.getByText("Настройки области", { exact: true });
        const iconPicker = page.getByText("Иконка области", { exact: true });
        const closeSettings = async () => {
          await button("Close").last().click();
          await settingsHeading.waitFor({ state: "hidden" });
        };
        const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
        const capture = (name) => output && page.screenshot({ path: join(output, `${name}-${width}.png`) });

        try {
          await enterSidebar();
          await sidebar.getByText(/^1 область(?: · .+)?$/).waitFor();
          await button("Новая область в проекте source").click();
          await newAreaName.waitFor();
          assert.equal(await newAreaName.inputValue(), "Новая область");
          await button("Открыть в новой области: Агент").waitFor();
          assert.equal((await client.workspaces.list({})).entries.length, 1, "opening the form creates nothing");
          await button("Close").last().click();
          await newAreaName.waitFor({ state: "hidden" });

          const modelsMenu = page.getByRole("menu", { name: "Модели для названий областей", exact: true });
          await button("Настройки проекта source").click();
          assert.equal(await page.getByText("Модель для названий областей", { exact: true }).count(), 0);
          await button("Close").last().click();
          await page.getByText("Настройки проекта", { exact: true }).waitFor({ state: "hidden" });

          const areaTitle = areaToggle.getByText(title, { exact: true });
          assert.equal(await areaToggle.getAttribute("aria-expanded"), "false");
          assert.equal(await sidebarSession.count(), 0);
          const idleSessions = sidebar.getByLabel("Неактивных сессий: 3", { exact: true });
          await idleSessions.waitFor();
          assert.equal(await sidebar.getByLabel(/^(Запущенных сессий|Готовых сессий|Сессий с ошибкой): /).count(), 0);
          const [areaNameBox, counterBox] = await Promise.all([areaTitle.boundingBox(), idleSessions.boundingBox()]);
          assert(counterBox.y > areaNameBox.y + areaNameBox.height);
          await capture("collapsed-area-progress");
          await areaToggle.click();
          await idleSessions.waitFor({ state: "hidden" });
          assert.equal(await areaToggle.getAttribute("aria-expanded"), "true");
          await sidebarSession.waitFor();
          await sidebarTerminal.waitFor();
          await sidebarTerminal.getByText(workspace.workspaceDirectory, { exact: true }).waitFor();
          const areaGlyph = await areaActions.locator("svg").innerHTML();
          for (const menu of ["Меню агента Fixture chat", "Меню терминала Fixture terminal"]) {
            const menuGlyph = await sidebar.getByRole("button", { name: menu, exact: true }).locator("svg").innerHTML();
            assert.notEqual(areaGlyph, menuGlyph, "area actions use a different icon from row menus");
          }
          assert.equal(await sidebar.getByText(/^\d+ сесси[ийя]$/).count(), 0);
          assert.equal(await button(`Новый агент в области ${title}`).count(), 0, "creation belongs in area settings");
          const [areaTitleBox, areaBox, sessionTitleBox, statusBox, modelBox, settingsBox] = await Promise.all([
            areaTitle.boundingBox(),
            areaToggle.boundingBox(),
            sidebarSession.getByText("Fixture chat", { exact: true }).boundingBox(),
            sidebarSession.getByLabel(/^Статус агента: /).boundingBox(),
            sidebarSession.getByText("Codex", { exact: true }).locator("..").boundingBox(),
            areaActions.boundingBox(),
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
          const copySessionLink = button("Скопировать ссылку на агента");
          const sessionActions = [
            copySessionLink, button("Перезагрузить агента"), button("Закрыть агента"),
          ];
          const expectSessionActions = () => Promise.all(sessionActions.map((action) => action.waitFor()));
          await sidebar.getByRole("button", { name: "Меню агента Fixture chat", exact: true }).click();
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
          await openArea();
          await areaContents.waitFor();
          await page.getByText("Функционал области", { exact: true }).waitFor();
          assert.equal(await areaIcon.count(), 1, "the icon picker opens from the title row");
          assert.equal((await areaIcon.textContent()).trim(), "");
          await editTitle.locator("..").getByText(title, { exact: true }).waitFor();
          assert.equal(await draft.count(), 0, "the title is read-only until the edit button is pressed");
          assert.equal(await page.getByText("Иконка области", { exact: true }).count(), 0);
          assert.equal(await archive.count(), 0, "transfer options should open only after pressing the icon");
          const actions = ["Закрепить область", "Скопировать путь к папке проекта",
            "Перенести в проект", "Архивировать область"].map(button);
          const createSession = button("Новый агент");
          const createTerminal = button("Новый терминал");
          await actions[0].click({ trial: true });
          const boxes = await Promise.all([createSession, createTerminal, ...actions.slice(0, 2), settings, ...actions.slice(2)].map(async (action) => {
            assert.equal((await action.textContent()).trim(), "");
            assert.equal(await action.locator("svg").count(), 1);
            return action.boundingBox();
          }));
          assert(boxes.every((box, index) => box && box.y === boxes[0].y && (!index || box.x > boxes[index - 1].x)));
          const lastAction = boxes.at(-1);
          assert(lastAction.x + lastAction.width <= width);
          const editBox = await editTitle.boundingBox();
          assert(editBox.y + editBox.height < boxes[0].y);
          const [nameBox, iconBox, generatorBox] = await Promise.all([
            editTitle.locator("..").boundingBox(), areaIcon.boundingBox(), generate.boundingBox(),
          ]);
          assert.equal(iconBox.width, iconBox.height);
          assert.equal(generatorBox.width, generatorBox.height);
          assert(iconBox.x + iconBox.width < nameBox.x && nameBox.x + nameBox.width < generatorBox.x);
          assert.equal(nameBox.y, iconBox.y);
          assert.equal(iconBox.y, generatorBox.y);
          assert(boxes[0].y + boxes[0].height < (await areaContents.boundingBox()).y);
          const chatRows = page.getByRole("button", { name: /^Открыть агента / });
          assert.equal(await chatRows.count(), 2);
          await button("Открыть агента Fixture chat").getByLabel(`Ветка при запуске: ${firstBranch}`).waitFor();
          await button("Открыть агента Second fixture chat").getByLabel("Ветка при запуске: hq-next").waitFor();
          await button("Открыть терминал Fixture terminal").waitFor();
          assert.equal(await page.getByRole("button", { name: /^(ID|Скопировать ID.*)$/ }).count(), 0);
          assert.equal(await page.getByText(/^ID: [a-f\d]{8}/).count(), 0);
          await capture("area-actions");
          await generate.click();
          await modelsMenu.waitFor();
          const availableModel = modelsMenu.getByRole("menuitem", { name: /^Выбрать модель codex\// }).first();
          await availableModel.waitFor();
          await availableModel.scrollIntoViewIfNeeded();
          const [triggerBox, popupBox] = await Promise.all([generate.boundingBox(), modelsMenu.boundingBox()]);
          assert(popupBox.x >= 10 && popupBox.x + popupBox.width <= width - 10);
          assert(popupBox.y >= 10 && popupBox.y + popupBox.height <= 834);
          assert(Math.min(Math.abs(popupBox.y - triggerBox.y - triggerBox.height),
            Math.abs(popupBox.y + popupBox.height - triggerBox.y)) < 20, "the menu opens next to the generation button");
          await capture("title-model-dropdown");
          await modelsMenu.getByPlaceholder("Поиск модели по всем провайдерам").fill("missing-fixture-model");
          await modelsMenu.getByText("Ничего не найдено", { exact: true }).waitFor();
          await button("Закрыть список моделей").click();
          await modelsMenu.waitFor({ state: "hidden" });
          assert(await areaContents.isVisible());

          const openTerminal = button("Открыть терминал Fixture terminal");
          await button("Агенты").click();
          await openTerminal.waitFor({ state: "hidden" });
          assert.equal(await chatRows.count(), 2);
          await button("Терминалы").click();
          await openTerminal.waitFor();
          assert.equal(await chatRows.count(), 0);
          await button("Все").click();
          await openTerminal.waitFor();
          assert.equal(await chatRows.count(), 2);
          const firstChatLabel = await chatRows.first().getAttribute("aria-label");
          const firstChat = firstChatLabel === "Открыть агента Fixture chat" ? chat : secondChat;

          await openSettings();
          await settingsHeading.waitFor();
          assert.equal(await draft.count(), 0, "the title editor belongs in the area panel");
          assert.equal(await iconPicker.count(), 0, "the settings sheet only contains the branch selector");
          await button("Ветка по умолчанию: Текущая ветка · hq-next").waitFor();
          await capture("area-details");
          await closeSettings();

          await areaIcon.click();
          await iconPicker.waitFor();
          await button("Фон иконки: Фиолетовый").click();
          await button("Выбрать 🧠").click();
          await iconPicker.waitFor({ state: "hidden" });
          const background = (locator) => locator.evaluate((node) => getComputedStyle(node).backgroundColor);
          assert.equal(await background(areaIcon), "rgb(139, 92, 246)");
          assert.equal(await background(areaToggle.getByText("🧠", { exact: true }).locator("..")), "rgb(139, 92, 246)");
          assert.equal(JSON.parse(await readFile(stateFile, "utf8")).areaPreferences[workspace.id].iconBg, "#8B5CF6");
          await button("Close").last().click();
          await areaContents.waitFor({ state: "hidden" });
          await openArea();
          await areaIcon.getByText("🧠", { exact: true }).waitFor();
          assert.equal(await background(areaIcon), "rgb(139, 92, 246)");
          await areaIcon.click({ trial: true });
          await capture("area-icon-background");
          await areaIcon.click();
          await button("Фон иконки: Автоматический").click();
          await button("Выбрать 📦").click({ trial: true });
          await capture("area-emoji-picker");
          await button("Выбрать 📦").click();
          await iconPicker.waitFor({ state: "hidden" });
          await areaIcon.getByText("📦", { exact: true }).waitFor();
          await areaToggle.getByText("📦", { exact: true }).waitFor();
          await areaIcon.click({ trial: true });
          await capture("area-with-emoji");
          await areaIcon.click();
          await button("Убрать иконку").click();
          await iconPicker.waitFor({ state: "hidden" });
          await areaToggle.getByText("📦", { exact: true }).waitFor({ state: "hidden" });
          assert.equal((await areaIcon.textContent()).trim(), "");

          await editTitle.click();
          await draft.waitFor();
          assert.equal(await draft.inputValue(), title);
          assert.deepEqual(await draft.evaluate((input) => [document.activeElement === input, input.selectionStart, input.selectionEnd]),
            [true, title.length, title.length]);
          await draft.press("Backspace");
          assert.equal(await draft.inputValue(), title.slice(0, -1));
          assert.equal(await editTitle.count(), 0);
          await button("Сохранить название").waitFor();
          await draft.fill(title);
          await generate.click({ trial: true });
          await capture("area-title-edit");
          const fieldBox = await draft.boundingBox();
          const generateBox = await generate.boundingBox();
          assert(generateBox.x >= fieldBox.x + fieldBox.width);
          assert(Math.abs(generateBox.y + generateBox.height / 2 - fieldBox.y - fieldBox.height / 2) < 2);
          await button("Сохранить название").click();
          await draft.waitFor({ state: "hidden" });
          assert(daemonSocket);
          await generate.click();
          await modelsMenu.waitFor();
          const [generationFrame] = await Promise.all([
            daemonSocket.waitForEvent("framesent", {
              predicate: ({ payload }) => JSON.parse(String(payload)).message?.method === "sidebar.title-suggest",
            }),
            modelsMenu.getByRole("menuitem", { name: "По первой строке промпта (без ИИ)", exact: true }).click(),
          ]);
          const generationInput = JSON.parse(String(generationFrame.payload)).message.input;
          assert.equal(generationInput.agentId, firstChat.id);
          assert.equal(generationInput.model, "first_line");
          assert.equal(JSON.parse(await readFile(stateFile, "utf8")).areaPreferences[workspace.id].titleModel, "first_line");
          await modelsMenu.waitFor({ state: "hidden" });
          await draft.waitFor();
          await generate.click({ trial: true });
          await draft.fill("Unsaved title");

          assert.equal(await copySessionLink.count(), 0, "copy belongs in the session menu");
          await actions[1].click();
          await page.getByText("Путь скопирован", { exact: true }).waitFor();
          assert.equal(await clipboard(), source);

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
          await page.getByText("Перенос области в проект", { exact: true }).waitFor({ state: "hidden" });
          assert.equal(await draft.inputValue(), "Unsaved title");
          await button("Close").last().click();
          await areaContents.waitFor({ state: "hidden" });
          await openArea();
          await draft.waitFor({ state: "hidden" });
          await editTitle.locator("..").getByText(title, { exact: true }).waitFor();

          const selectedChat = link.endsWith(`/${chat.id}`) ? secondChat : chat;
          let selectedTitle = selectedChat.id === chat.id ? "Fixture chat" : "Second fixture chat";
          await button(`Меню агента ${selectedTitle}`).click();
          await expectSessionActions();
          if (width === 1280) {
            selectedTitle = "Renamed fixture chat";
            const agentTitle = page.getByRole("textbox", { name: "Название агента", exact: true });
            await agentTitle.fill(selectedTitle);
            await agentTitle.blur();
            await page.getByText("Агент переименован", { exact: true }).waitFor();
            assert.equal((await client.agents.ref(selectedChat.id).refresh()).agent.title, selectedTitle);
          } else {
            const reloadChat = button("Перезагрузить агента");
            const [reloadFrame] = await Promise.all([
              daemonSocket.waitForEvent("framesent", {
                predicate: ({ payload }) => JSON.parse(String(payload)).message?.type === "refresh_agent_request",
              }),
              reloadChat.click(),
            ]);
            assert.equal(JSON.parse(String(reloadFrame.payload)).message.agentId, selectedChat.id);
            const reloadResult = page.getByText(/Агент перезагружен|thread\/items\/list is not supported yet/);
            await reloadResult.waitFor();
            if (await reloadChat.isVisible()) {
              await button("Закрыть").last().click();
              await reloadChat.waitFor({ state: "hidden" });
            }
          }
          const openChat = button(`Открыть агента ${selectedTitle}`);
          assert.equal(await openChat.count(), 1, "each listed session should be openable");
          await button(`Меню агента ${selectedTitle}`).click();
          await expectSessionActions();
          await copySessionLink.click();
          await page.waitForFunction(
            async (expected) => await navigator.clipboard.readText() === expected,
            link.replace(/[^/]+$/, selectedChat.id),
          );
          assert(await areaContents.isVisible(), "copying a session link should keep area actions open");
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
          await areaContents.waitFor({ state: "hidden" });
          await page.getByText("Start chatting with this agent...", { exact: true }).filter({ visible: true }).first().waitFor();

          if (width === 1280) {
            await openArea();
            await editTitle.click();
            await draft.fill("  Renamed area fixture  ");
            await button("Сохранить название").click();
            await draft.waitFor({ state: "hidden" });
            assert(await areaContents.isVisible(), "saving closes the inline editor and keeps the area open");
            await editTitle.locator("..").getByText("Renamed area fixture", { exact: true }).waitFor();
            assert.equal((await workspaceHandle.refresh()).title, "Renamed area fixture");
            await editTitle.click();
            assert.equal(await draft.inputValue(), "Renamed area fixture");
            await draft.fill(title);
            await button("Сохранить название").click();
            await draft.waitFor({ state: "hidden" });
            await openSettings();
            await choose("Ветка по умолчанию: Текущая ветка · hq-next", firstBranch);
            await button(`Ветка по умолчанию: ${firstBranch}`).waitFor();
            await closeSettings();
            await createSession.click();
            await page.getByText(`Переключите область на ветку «${firstBranch}», чтобы создать агента`).waitFor();
            assert.equal(git("branch", "--show-current"), "hq-next");
            assert.equal((await client.agents.list({})).entries.filter(({ agent }) => agent.workspaceId === workspace.id).length, 2);
            await openSettings();
            await choose(`Ветка по умолчанию: ${firstBranch}`, "hq-next");
            await button("Ветка по умолчанию: hq-next").waitFor();
            await closeSettings();
            await createSession.click();
            await areaContents.waitFor({ state: "hidden" });
            const created = (await client.agents.list({})).entries
              .find(({ agent }) => agent.workspaceId === workspace.id && agent.id !== chat.id && agent.id !== secondChat.id);
            assert(created, "the settings plus creates a session in the same area");
            assert.equal(created.agent.cwd, workspace.workspaceDirectory);
            await openArea();
            const closedTitle = created.agent.title || "Агент без названия";
            const areaDialog = page.getByRole("dialog").filter({ has: areaContents });
            await areaDialog.getByRole("button", { name: `Меню агента ${closedTitle}`, exact: true }).click();
            await button("Закрыть агента").click();
            await page.getByText("Агент закрыт", { exact: true }).waitFor();
            await areaDialog.getByRole("button", { name: `Открыть агента ${closedTitle}`, exact: true }).waitFor({ state: "hidden" });
            await assertInHistory(created.agent.id, workspace.id, created.agent.title);
            const closedAgent = button(`Открыть закрытого агента ${closedTitle}`);
            await closedAgent.waitFor();
            await areaDialog.getByRole("button", { name: "Close", exact: true }).click();
            await areaContents.waitFor({ state: "hidden" });
            await openArea();
            await closedAgent.scrollIntoViewIfNeeded();
            await capture("area-closed-sessions");
            await closedAgent.click();
            await page.getByText("This agent is archived", { exact: true }).filter({ visible: true }).first().waitFor();
            await assertInHistory(created.agent.id, workspace.id, created.agent.title);
            await openArea();
            await Promise.all([page.waitForEvent("load"), createTerminal.click()]);
            await page.locator(".xterm").first().waitFor({ state: "visible" });
            const { entries: activeTerminals } = await workspaceHandle.terminals.list();
            assert.equal(activeTerminals.length, 2);
            const newTerminal = activeTerminals.find((terminal) => terminal.id !== fixtureTerminal.id);
            assert(newTerminal);

            await enterSidebar();
            await openArea();
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
            await areaContents.waitFor({ state: "hidden" });

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
            await openArea();
            await actions[0].click();
            await areaContents.waitFor({ state: "hidden" });
            await openArea();
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
            await openArea();
            await areaContents.waitFor();
            assert.equal(await page.getByRole("button", { name: /^Открыть агента / }).count(), 1);
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
            await areaContents.waitFor({ state: "hidden" });
            const remaining = await client.workspaces.list({});
            assert(!remaining.entries.some((entry) => entry.id === moved.id));
            await button("Новая область в проекте target").click();
            await newAreaName.fill("Project modal session fixture");
            await button("Открыть в новой области: Агент").waitFor();
            await button("Создать область").click();
            await newAreaName.waitFor({ state: "hidden" });
            const sessionArea = (await client.workspaces.list({})).entries.find((entry) => entry.title === "Project modal session fixture");
            assert(sessionArea);
            const firstSession = (await client.agents.list({})).entries.find(({ agent }) => agent.workspaceId === sessionArea.id)?.agent;
            assert(firstSession);
            const sidebarNewArea = button("Новая область в проекте target").locator("../..");
            const newAreaToggle = button("Сессии области Project modal session fixture");
            if (await newAreaToggle.getAttribute("aria-expanded") !== "true") await newAreaToggle.click();
            const firstSessionTitle = firstSession.title || "Агент без названия";
            await sidebarNewArea.getByRole("button", { name: `Меню агента ${firstSessionTitle}`, exact: true }).click();
            await button("Закрыть агента").click();
            await page.getByText("Агент закрыт", { exact: true }).waitFor();
            await sidebarNewArea.getByRole("button", { name: `Открыть агента ${firstSessionTitle}`, exact: true }).waitFor({ state: "hidden" });
            await assertInHistory(firstSession.id, sessionArea.id, firstSession.title);
            await button("Новая область в проекте target").click();
            await newAreaName.fill("Project modal terminal fixture");
            await choose("Открыть в новой области: Агент", "Терминал");
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
