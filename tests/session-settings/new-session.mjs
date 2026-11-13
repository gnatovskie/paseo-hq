import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
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

// Без вызова моделей: проверяется путь с терминалом и добавление проекта без сессии.
test("new session window adds a project compactly", async () => {
  const home = await mkdtemp(join(tmpdir(), "hq-new-session-"));
  const port = await localPort();
  const endpoint = `127.0.0.1:${port}`;
  const source = join(home, "source");
  const repos = join(home, "repos");
  const alpha = join(repos, "alpha");
  const stateFile = join(home, "hq-state.json");
  const env = { ...process.env, PASEO_HOME: home, PASEO_HQ_STATE_FILE: stateFile, PASEO_REPOS_DIR: repos };
  const paseo = (...args) => execFileSync("paseo", [...args, "--home", home], { env, encoding: "utf8" });
  let client;
  let daemon;
  let browser;
  let started = false;

  try {
    await Promise.all([mkdir(source), mkdir(join(repos, "beta"), { recursive: true }), mkdir(output, { recursive: true })]);
    execFileSync("git", ["init", "-q", "-b", "main", alpha]);
    await writeFile(join(home, "config.json"), JSON.stringify({
      pluginsEnabled: true,
      daemon: { listen: endpoint, relay: { enabled: false } },
      features: { webUi: { enabled: true }, dictation: { enabled: false }, voiceMode: { enabled: false } },
    }));
    paseo("daemon", "start", "--timeout", "25");
    started = true;
    paseo("plugin", "add", root);
    paseo("project", "create", source);

    daemon = new DaemonClient({ url: `ws://${endpoint}/ws`, clientId: "hq-new-session", clientType: "cli", appVersion: "0.15.2", reconnect: { enabled: false } });
    await daemon.connect();
    client = createPaseoApi(daemon);

    browser = await chromium.launch({ executablePath: process.env.PASEO_CHROMIUM_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(40_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const button = (name) => page.getByRole("button", { name, exact: true });
    const textbox = (name) => page.getByRole("textbox", { name, exact: true });
    const capture = (name) => page.screenshot({ path: join(output, `${name}.png`) });
    const pickNewProject = async (current) => {
      await button("Новая сессия в любом проекте").click();
      await page.getByLabel(`Проект: ${current}`, { exact: true }).waitFor();
      await button("Выбрать проект").click();
      await page.getByRole("menuitem", { name: "Проект: Новый проект", exact: true }).click();
      await page.getByLabel("Проект: Новый проект", { exact: true }).waitFor();
    };

    try {
      await page.goto(`http://${endpoint}/`);
      await button("Новая сессия в любом проекте").waitFor();
      assert.equal(await button("Добавить проект").count(), 0, "the old add-project window is gone");

      await pickNewProject("source");
      assert.equal(await button("Выбрать папку alpha").count(), 0, "ready repositories open only on request");
      await capture("new-session-project");
      await button("Готовые репозитории").click();
      await button("Выбрать папку alpha").click();
      await button("Выбрать папку alpha").waitFor({ state: "hidden" });
      assert.equal(await textbox("Папка на сервере").inputValue(), alpha);
      assert.equal(await textbox("Название нового проекта").getAttribute("placeholder"), "alpha");
      await button("Редактировать название проекта").click();
      await page.keyboard.type("Альфа");
      await button("Терминал").click();
      await page.getByLabel(`Папка терминала: ${alpha}`, { exact: true }).waitFor();
      await capture("new-session-new-project");
      await button("Добавить проект и создать терминал").click();
      await textbox("Название новой области").waitFor({ state: "hidden" });
      await button("Настройки проекта Альфа").waitFor();
      const { entries } = await client.workspaces.list({});
      const created = entries.find((workspace) => workspace.projectRootPath === alpha);
      assert(created, "the area is created in the new project");
      assert.equal(created.title, "Новая область");
      const { entries: terminals } = await client.workspaces.ref(created.id).terminals.list();
      assert.equal(terminals.length, 1, "the first terminal is open in the new area");

      await page.goto(`http://${endpoint}/`);
      await pickNewProject("Альфа");
      await button("Новая папка").click();
      await textbox("Путь новой папки").fill(join(repos, "gamma"));
      await button("Только добавить проект").click();
      await button("Настройки проекта gamma").waitFor();
      assert(existsSync(join(repos, "gamma", ".git")), "git init runs by default");
      const after = await client.workspaces.list({});
      assert.equal(after.entries.filter((workspace) => workspace.projectRootPath === join(repos, "gamma")).length, 0, "no session for a project-only add");
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error(await page.locator("body").innerText());
      await capture("new-session-failure").catch(() => {});
      throw error;
    }
  } finally {
    await browser?.close();
    await client?.dispose();
    await daemon?.close();
    if (started) paseo("daemon", "stop");
    await rm(home, { recursive: true, force: true });
  }
});
