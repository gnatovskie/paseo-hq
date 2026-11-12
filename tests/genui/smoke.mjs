import { build } from "esbuild";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "../..");
const output = process.env.GENUI_SMOKE_OUTPUT || "/tmp/opencode/hq-genui";
await mkdir(output, { recursive: true });
await writeFile(join(output, "rows.json"), JSON.stringify([["Load", "HQ file loaded"]]));
// The browser fixture uses this fixed path so its source remains reusable.
await mkdir("/tmp/opencode/hq-genui", { recursive: true });
await writeFile("/tmp/opencode/hq-genui/rows.json", JSON.stringify([["Load", "HQ file loaded"]]));
await writeFile("/tmp/opencode/hq-genui/acceptance.json", JSON.stringify([{ name: "Multiple files stay separate", status: "passed" }]));
await writeFile("/tmp/opencode/hq-genui/draft.txt", "Provider message loaded as text");
const bundle = join(output, "browser.js");
await build({ absWorkingDir: root, entryPoints: ["tests/genui/browser.tsx"], outfile: bundle, bundle: true, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" }, alias: { "react-native": "react-native-web", "@getpaseo/plugin/client": resolve(root, "tests/genui/host.tsx"), "@getpaseo/plugin/client/react-native": resolve(root, "tests/genui/host.tsx"), "@getpaseo/plugin/client/ui": resolve(root, "tests/genui/host.tsx") } });
let daemon;
let rpc;
if (process.argv.includes("--live")) {
  assert(process.env.PASEO_SMOKE_AGENT_ID, "Set PASEO_SMOKE_AGENT_ID to an existing agent (read-only calls)");
  const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
  daemon = new DaemonClient({ url: process.env.PASEO_DAEMON_URL || "ws://127.0.0.1:6767/ws", password: process.env.PASEO_PASSWORD, clientId: "hq-genui-smoke", clientType: "cli", appVersion: "0.15.2", reconnect: { enabled: false } });
  await daemon.connect();
  rpc = (method, input) => daemon.invokePluginRpc("paseo-hq", method, { ...input, ...(input.agentId ? { agentId: process.env.PASEO_SMOKE_AGENT_ID } : {}) });
} else {
  const sourceBundle = join(output, "data-source.mjs");
  await build({ absWorkingDir: root, entryPoints: ["server/genui/data-source.ts"], outfile: sourceBundle, bundle: true, platform: "node", format: "esm", packages: "external" });
  const data = await import(pathToFileURL(sourceBundle));
  const paseo = { agents: { ref: () => ({ current: () => ({ cwd: root }) }) } };
  rpc = (method, input) => {
    if (method === "genui.load_data") return data.loadAgentFile(paseo, "smoke", input.path, input);
    if (method === "genui.gallery_list") return data.listGallery().then((names) => ({ names }));
    if (method === "genui.gallery_get") return data.readGallerySpec(input.name).then((source) => ({ source }));
    if (method === "genui.gallery_data") return data.loadGalleryFile(input.path, input);
    throw new Error(`Unexpected smoke RPC: ${method}`);
  };
}
const results = [];
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/rpc") {
      let body = "";
      for await (const part of request) body += part;
      const { method, input } = JSON.parse(body);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(await rpc(method, input)));
    } else if (request.url === "/browser.js") {
      response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(bundle));
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="root"></div><script src="/browser.js"></script></body></html>');
    }
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
let browser;
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const cache = join(homedir(), ".cache/ms-playwright");
  const dirs = await readdir(cache).catch(() => []);
  const local = dirs.filter((name) => name.startsWith("chromium_headless_shell-")).sort().at(-1);
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : local ? { executablePath: join(cache, local, "chrome-headless-shell-linux64/chrome-headless-shell") } : {});
  for (const [name, width, dark] of [["desktop-dark", 1280, true], ["phone-light", 390, false]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") console.error(message.text()); });
    page.on("pageerror", (error) => console.error(error.message));
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/${dark ? "?dark" : ""}`);
    await page.getByText("HQ file loaded", { exact: true }).waitFor();
    await page.getByText("Клиент схемы", { exact: true }).waitFor();
    await page.getByText("Демон схемы", { exact: true }).waitFor();
    await page.getByText("Исполнитель схемы", { exact: true }).waitFor();
    await page.getByText("Часть схемы не поддерживается. Пропущенные строки:", { exact: true }).waitFor();
    await page.getByText("unsupported syntax", { exact: true }).waitFor();
    const fragment = page.getByText("важный фрагмент", { exact: true });
    assert.equal(await fragment.evaluate(el => getComputedStyle(el).userSelect), "text", "formatted card text must allow selection even when the host disables it");
    const selected = await fragment.evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    });
    assert.equal(selected, "важный фрагмент");
    await page.getByRole("button", { name: "Выделить текст", exact: true }).first().click();
    const selectableBody = page.getByRole("textbox", { name: "Текст для выделения" }).first();
    assert.equal(await selectableBody.inputValue(), "Выделяем важный фрагмент и обычный текст");
    assert.equal(await selectableBody.getAttribute("readonly"), "");
    assert.equal(await selectableBody.evaluate(el => {
      el.focus();
      el.setSelectionRange(9, 24);
      return el.value.slice(el.selectionStart, el.selectionEnd);
    }), "важный фрагмент");
    await page.getByRole("button", { name: "Копировать текст блока", exact: true }).first().click();
    assert.equal(await page.locator("#copied").textContent(), "Выделяем важный фрагмент и обычный текст");
    await page.locator("#copied").evaluate(el => el.remove());
    await page.screenshot({ path: join(output, `${name}-selection.png`), fullPage: true });
    await page.getByRole("button", { name: "Вернуть оформление", exact: true }).first().click();
    assert.equal(await selectableBody.count(), 0);
    await page.getByRole("button", { name: "Проверки", exact: true }).click();
    await page.getByText("Multiple files stay separate", { exact: true }).waitFor();
    await page.getByText("Provider message loaded as text", { exact: true }).waitFor();
    assert.equal(await page.getByText(/Loading Acceptance|Draft markdown needs text/).count(), 0);
    const beforeFileUrl = page.url();
    await page.getByRole("button", { name: "/tmp/opencode/hq-genui/draft.txt", exact: true }).click();
    await page.getByRole("button", { name: "Закрыть файл", exact: true }).waitFor();
    assert.equal(page.url(), beforeFileUrl, "file preview must not navigate the workspace");
    await page.getByText("Provider message loaded as text", { exact: true }).nth(1).waitFor();
    await page.getByRole("button", { name: "Закрыть файл", exact: true }).click();
    await page.getByRole("button", { name: "/etc/passwd", exact: true }).click();
    await page.getByText(/outside|allowed|permitted|workspace/i).last().waitFor();
    assert.equal(page.url(), beforeFileUrl);
    await page.getByRole("button", { name: "Закрыть файл", exact: true }).click();
    await page.getByText("21", { exact: true }).waitFor();
    await page.getByText("Количество", { exact: true }).locator("..").getByRole("button", { name: "+", exact: true }).click();
    await page.getByText("28", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Применить", exact: true }).click();
    await page.locator("#sent").filter({ hasText: "Количество 4" }).waitFor();
    const app = page.frameLocator("iframe");
    await app.locator("#app").filter({ hasText: "App works" }).waitFor();
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, "horizontal overflow");
    const registrations = await page.evaluate(() => Object.fromEntries(Object.entries(globalThis.registrations).map(([key, value]) => [key, value.map((entry) => entry.name ?? entry.id ?? entry.kind)])));
    assert.deepEqual(registrations.addSlashCommand, ["genui", "genui-demo", "genui-gallery"]);
    assert(registrations.addTimelineRenderer.includes("genui-block"));
    assert(!registrations.addSidebarHeaderItem?.includes("gallery"));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
    results.push({ name: `${name}: text selection mode, fragment and block copy, formatting restored, Load, state, Send, sandbox, file preview, no overflow`, status: "passed" });
    await page.close();
  }
  const galleryPage = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const galleryErrors = [];
  galleryPage.on("pageerror", (error) => galleryErrors.push(error.message));
  await galleryPage.goto(`http://127.0.0.1:${server.address().port}/?gallery`);
  await galleryPage.getByText("gallery/Card.ui", { exact: true }).waitFor();
  assert.equal(await galleryPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(galleryErrors, []);
  await galleryPage.screenshot({ path: join(output, "gallery-phone.png"), fullPage: true });
  await galleryPage.close();
  results.push({ name: "phone gallery: HQ examples loaded and rendered", status: "passed" });
  if (daemon) {
    const gallery = await rpc("genui.gallery_list", {});
    assert(gallery.names.includes("Card.ui"));
    const refused = await rpc("genui.load_data", { agentId: "smoke", path: "/etc/passwd" });
    assert.equal(refused.ok, false);
    const valid = await rpc("genui.check_ui", { agentId: "smoke", spec: 'Card("Check", [Metric("N", 7)])' });
    assert.equal(valid.ok, true);
    const invalid = await rpc("genui.check_ui", { agentId: "smoke", spec: 'Card("Check", [NoSuchComponent()])' });
    assert.equal(invalid.ok, false);
    const font = await rpc("genui.sketch_font", {});
    assert(font.dataUrl.startsWith("data:font/woff2;base64,"));
    results.push({ name: "live HQ RPC: gallery, font, valid/invalid UI and file boundary", status: "passed" });
  }
} catch (error) {
  results.push({ name: "Genui smoke", status: "failed", message: String(error.stack || error) });
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await daemon?.close();
  await writeFile(join(output, "smoke.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
}
