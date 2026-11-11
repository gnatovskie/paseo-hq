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

test("Archive releases sidebar controls and opens the next chat", { timeout: 120_000 }, async (t) => {
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
    const { entries: [workspace] } = await client.workspaces.list({});
    const workspaceHandle = client.workspaces.ref(workspace.id);
    browser = await chromium.launch({ executablePath: process.env.PASEO_CHROMIUM_EXECUTABLE });
    for (const width of [390, 1280]) {
      await t.test(`${width}px`, async () => {
        const first = await workspaceHandle.agents.create({ title: `Close ${width}`, config: { provider: "codex/gpt-6-luna" } });
        const next = await workspaceHandle.agents.create({ title: `Next ${width}`, config: { provider: "codex/gpt-6-luna" } });
        const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 390 });
        page.setDefaultTimeout(15_000);
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        let holdLists = false;
        let rejectArchive = true;
        let archiveSeen;
        const archived = new Promise(resolve => { archiveSeen = resolve; });
        await page.routeWebSocket('**/ws', socket => {
          const server = socket.connectToServer();
          socket.onMessage(message => {
            const parsed = JSON.parse(String(message));
            const frame = parsed.message ?? parsed;
            if (rejectArchive && frame.type === "archive_agent_request") {
              // Ask the real daemon to reject a missing ID without touching the fixture.
              rejectArchive = false;
              frame.agentId = "missing-archive-fixture";
              server.send(JSON.stringify(parsed));
            } else server.send(message);
          });
          server.onMessage(message => {
            const parsed = JSON.parse(String(message));
            const frame = parsed.message ?? parsed;
            if (frame.type === "agent_archived") {
              holdLists = true;
              archiveSeen();
            }
            // Keep the unrelated directory refresh pending deterministically.
            if (holdLists && frame.type === "project.list.response") return;
            socket.send(message);
          });
        });
        const button = name => page.getByRole('button', { name, exact: true });
        try {
          await page.goto(`http://${endpoint}/`);
          if (width === 390) await button('Open menu').click();
          const project = button('Новая область в проекте source').locator('../..');
          await project.waitFor();
          const area = button(`Сессии области ${title}`);
          if (!await area.isVisible()) await project.getByText('source', { exact: true }).click();
          if (await area.getAttribute('aria-expanded') !== 'true') await area.click();
          await button(`Меню агента Close ${width}`).click();
          await button('Закрыть агента').click();
          await page.getByText(/Agent not found: missing-archive-fixture/).waitFor();
          await button(`Открыть агента Close ${width}`).waitFor();
          assert(!(await first.refresh()).archivedAt, 'failed archive preserves the agent');
          await button(`Меню агента Close ${width}`).click();
          await button('Закрыть агента').click();
          await archived;
          await button(`Открыть агента Close ${width}`).waitFor({ state: 'hidden' });
          const menu = button(`Меню агента Next ${width}`);
          await menu.click({ timeout: 2500 });
          await button('Перезагрузить агента').waitFor();
          assert.equal(await page.getByText('Агент закрыт', { exact: true }).count(), 0);
          await button('Закрыть').last().click();
          await button(`Открыть агента Next ${width}`).click();
          await page.waitForURL(url => url.pathname.includes('/workspace/'));
          await page.locator('textarea:visible').first().waitFor();
          await page.getByTestId('agent-loading').waitFor({ state: 'hidden' });
          if (width === 390) {
            await page.getByTestId('workspace-tab-switcher-trigger').click();
            await page.getByRole('slider', { name: 'Bottom Sheet', exact: true }).getByText(`Next ${width}`, { exact: true }).click();
          } else {
            await page.locator('[data-testid^="workspace-tab-agent_"][aria-selected="true"]').filter({ hasText: `Next ${width}` }).waitFor();
          }
          // Reopening the same already-selected agent must reveal the chat again.
          if (width === 390) await button('Open menu').click();
          await button(`Открыть агента Next ${width}`).click();
          const composer = page.locator('textarea:visible').first();
          await composer.click();
          await composer.fill('Unsent navigation fixture');
          assert.equal(await composer.inputValue(), 'Unsent navigation fixture');
          await composer.fill('');
          const stored = (await daemon.fetchAgentHistory({})).entries.find(({agent}) => agent.id === first.id)?.agent;
          assert(stored?.archivedAt, 'archived chat remains in history');
          await page.screenshot({ path: join(output, `archive-navigation-${width}.png`) });
          assert.deepEqual(errors, []);
        } catch (error) {
          console.error(error);
          await page.screenshot({ path: join(output, `archive-navigation-failed-${width}.png`) });
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
