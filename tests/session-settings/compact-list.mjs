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
const title = "HQ compact fixture";
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

// Без вызова моделей: агенты создаются без промптов.
test("sidebar sessions view and search", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hq-compact-list-"));
  const port = await localPort();
  const endpoint = `127.0.0.1:${port}`;
  const source = join(home, "source");
  const stateFile = join(home, "hq-state.json");
  const env = { ...process.env, PASEO_HOME: home, PASEO_HQ_STATE_FILE: stateFile };
  const paseo = (...args) => execFileSync("paseo", [...args, "--home", home], { env, encoding: "utf8" });
  let client;
  let daemon;
  let browser;
  let started = false;

  try {
    await Promise.all([mkdir(source), mkdir(output, { recursive: true })]);
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
    paseo("workspace", "create", "--path", source, "--isolation", "worktree", "--title", title);

    daemon = new DaemonClient({
      url: `ws://${endpoint}/ws`,
      clientId: "hq-compact-list",
      clientType: "cli",
      appVersion: "0.15.2",
      reconnect: { enabled: false },
    });
    await daemon.connect();
    client = createPaseoApi(daemon);
    const { entries: [workspace] } = await client.workspaces.list({});
    const workspaceHandle = client.workspaces.ref(workspace.id);
    await writeFile(stateFile, JSON.stringify({ projects: { [workspace.projectId]: { sessionTitleModel: "first_line" } } }));
    await workspaceHandle.agents.create({ title: "Fixture chat", config: { provider: "codex/gpt-5.4" } });
    await new Promise((ready) => setTimeout(ready, 1100));
    await workspaceHandle.agents.create({ title: "Second fixture chat", config: { provider: "codex/gpt-5.4" } });
    await workspaceHandle.terminals.create({
      name: "Fixture terminal",
      command: "sh",
      args: ["-c", "exec sleep 300"],
    });

    browser = await chromium.launch({ executablePath: process.env.PASEO_CHROMIUM_EXECUTABLE });
    for (const width of [1280, 390]) {
      await t.test(`${width}px`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 390, colorScheme: width === 390 ? "dark" : "light" });
        page.setDefaultTimeout(40_000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const button = (name) => page.getByRole("button", { name, exact: true });
        const tab = (name) => page.getByRole("tab", { name, exact: true });
        const rowNames = async () => Promise.all((await page.getByRole("button", { name: /^Открыть (агента|терминал) / }).all())
          .map((row) => row.getAttribute("aria-label")));
        const capture = (name) => page.screenshot({ path: join(output, `${name}-${width}.png`) });
        const enterSidebar = async () => {
          await page.goto(`http://${endpoint}/`);
          if (width === 390) await button("Open menu").click();
          await tab("Вид Проекты").waitFor();
        };

        try {
          await enterSidebar();
          await tab("Вид Сессии").click();
          await button("Открыть терминал Fixture terminal").waitFor();
          assert.deepEqual(await rowNames(), ["Открыть агента Second fixture chat", "Открыть агента Fixture chat", "Открыть терминал Fixture terminal"],
            "agents by activity, terminals after them");
          assert.equal(await page.getByLabel(`Проект и область: source · ${title}`).count(), 3);
          await capture("compact-sessions");

          await button("Меню агента Second fixture chat").click();
          await page.getByRole("textbox", { name: "Название агента", exact: true }).waitFor();
          await button("Закрыть").last().click();
          await page.getByRole("textbox", { name: "Название агента", exact: true }).waitFor({ state: "hidden" });

          // Поиск: все слова в цепочке проект + область + сессия, регистр не важен.
          await button("Поиск по проектам, областям и сессиям").click();
          const search = page.getByRole("textbox", { name: "Поиск в сайдбаре", exact: true });
          await search.fill("SOURCE second");
          await button("Открыть агента Fixture chat").waitFor({ state: "hidden" });
          assert.deepEqual(await rowNames(), ["Открыть агента Second fixture chat"]);
          await search.fill("compact terminal");
          await button("Открыть агента Second fixture chat").waitFor({ state: "hidden" });
          assert.deepEqual(await rowNames(), ["Открыть терминал Fixture terminal"]);
          await search.fill("деплой");
          await page.getByText("Ничего не найдено", { exact: true }).waitFor();
          await capture("compact-search-empty");
          await button("Закрыть поиск").click();
          await search.waitFor({ state: "hidden" });
          assert.equal((await rowNames()).length, 3);

          // Терминалы в этом виде выключаются в настройках проекта.
          await tab("Вид Проекты").click();
          await button("Настройки проекта source").click();
          const terminalsSwitch = page.getByRole("switch", { name: "Показывать терминалы в виде «Сессии»" });
          const stored = async (expected) => {
            for (let attempt = 0; attempt < 50; attempt++) {
              const meta = Object.values(JSON.parse(await readFile(stateFile, "utf8")).projects)[0];
              if (meta.showTerminalsInSessions === expected) return;
              await new Promise((ready) => setTimeout(ready, 100));
            }
            assert.fail(`showTerminalsInSessions is not ${expected}`);
          };
          await terminalsSwitch.click();
          await stored(false);
          await button("Закрыть").last().click();
          await tab("Вид Сессии").click();
          await button("Открыть агента Fixture chat").waitFor();
          assert.deepEqual(await rowNames(), ["Открыть агента Second fixture chat", "Открыть агента Fixture chat"]);
          await tab("Вид Проекты").click();
          await button("Настройки проекта source").click();
          await terminalsSwitch.click();
          await stored(true);
          await button("Закрыть").last().click();

          // Поиск в дереве раскрывает только найденное, после поиска раскрытие прежнее.
          const areaToggle = button(`Сессии области ${title}`);
          if (await areaToggle.getAttribute("aria-expanded") === "true") await areaToggle.click();
          await button("Поиск по проектам, областям и сессиям").click();
          await search.fill("second");
          await button("Открыть агента Second fixture chat").waitFor();
          assert.deepEqual(await rowNames(), ["Открыть агента Second fixture chat"]);
          await capture("compact-tree-search");
          await search.press("Escape");
          await search.waitFor({ state: "hidden" });
          assert.equal(await areaToggle.getAttribute("aria-expanded"), "false");

          // Вид запоминается на устройстве.
          await tab("Вид Сессии").click();
          await enterSidebar();
          assert.equal(await tab("Вид Сессии").getAttribute("aria-selected"), "true");

          await button("Открыть агента Second fixture chat").click();
          await page.waitForURL((url) => url.pathname.includes("/workspace/"));
          await page.locator("textarea:visible").first().waitFor();
          assert.deepEqual(errors, []);
        } catch (error) {
          console.error(await page.locator("body").innerText());
          await capture("compact-failure").catch(() => {});
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
