import { test } from "node:test";
import assert from "node:assert/strict";
import { nameSession } from "./session-titles.server.ts";

test("project model generates the visible workspace title", async () => {
  let title = null;
  await nameSession({ prompt: "Почини вход в Штаб", model: "codex/gpt-6-luna", currentTitle: async () => title, setTitle: async t => { title = t; }, generate: async (model, prompt) => { assert.equal(model, "codex/gpt-6-luna"); assert.equal(prompt, "Почини вход в Штаб"); return "Починить вход Штаба"; }, warn: assert.fail });
  assert.equal(title, "Починить вход Штаба");
});
test("unavailable model uses first line and reports failure", async () => {
  let title = null;
  let warned = false;
  await nameSession({ prompt: "Первая строка\nОстальное", model: "missing/model", currentTitle: async () => title, setTitle: async t => { title = t; }, generate: async () => { throw Error("unavailable"); }, warn: () => { warned = true; } });
  assert.equal(title, "Первая строка"); assert.ok(warned);
});
test("manual rename during generation survives", async () => {
  let title = null;
  await nameSession({ prompt: "Задача", model: "codex/gpt-6-luna", currentTitle: async () => title, setTitle: async t => { title = t; }, generate: async () => { title = "Мое название"; return "Автоназвание"; }, warn: assert.fail });
  assert.equal(title, "Мое название");
});
test("explicit title never calls a model", async () => {
  await nameSession({ prompt: "Задача", model: "codex/gpt-6-luna", currentTitle: async () => "Мое название", setTitle: async () => assert.fail(), generate: async () => assert.fail(), warn: assert.fail });
});

test("first-turn hook uses project selection and updates workspace through SDK", { timeout: 3000 }, async () => {
  const { contributeSessionTitles, GENERATOR_TITLE } = await import("./session-titles.server.ts");
  const hooks = new Map();
  let title = null;
  let archived = false;
  let claimed = false;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const dispose = contributeSessionTitles({ addHook: (event, handler) => { hooks.set(event, handler); return () => hooks.delete(event); } }, async (workspaceId, projectId) => {
    assert.equal(workspaceId, "workspace-1"); assert.equal(projectId, "project-1");
    if (claimed) return null;
    claimed = true; return { model: "codex/gpt-6-luna" };
  });
  const workspace = { agents: { create: async options => paseo.agents.create(options) }, projectId: "project-1", refresh: async () => ({ title }), setTitle: async next => { title = next; if (next === "Исправить вход") resolveDone(); } };
  const paseo = { providers: { waitForReady: async () => ({ entries: [{ provider: "codex", models: [{ id: "gpt-6-luna", thinkingOptions: [{ id: "low" }, { id: "high" }] }] }] }) }, workspaces: { ref: () => workspace }, agents: {
    ref: () => ({ timeline: { refetch: async () => ({ error: null, hasOlder: false, entries: [{ item: { type: "user_message", text: "Почини вход" } }] }) } }),
    create: async options => {
      assert.equal(options.cwd, undefined);
      assert.equal(options.background, undefined);
      assert.equal(options.config.thinkingOptionId, "low");
      assert.equal(options.config.featureValues.service_tier, "default");
      assert.equal(options.config.provider, "codex/gpt-6-luna");
      const request = { config: { ...options.config, title: options.title } };
      const internal = await hooks.get("agent.create.before")({ request });
      assert.equal(internal.config.internal, true);
      assert.equal(options.title, GENERATOR_TITLE);
      return { run: async () => ({ status: "idle", lastMessage: "Исправить вход" }), archive: async () => { archived = true; } };
    }
  } };
  await hooks.get("agent.turn.before")({ agent: { id: "agent-1", workspaceId: "workspace-1", parentAgentId: null, title: null } }, { paseo });
  await done;
  assert.equal(title, "Исправить вход"); assert.ok(archived);
  dispose();
});

test("selected model reserves title against native generator", async () => {
  let title = "Почини вход";
  await nameSession({ prompt: "Почини вход", model: "codex/gpt-6-luna", currentTitle: async () => title, setTitle: async t => { title = t; }, generate: async () => {
    assert.equal(title, "Почини вход…");
    // Native Paseo only replaces an empty or first-line title.
    if (!title || title === "Почини вход") title = "Название другой модели";
    return "Исправить авторизацию";
  }, warn: assert.fail });
  assert.equal(title, "Исправить авторизацию");
});
test("invalid model response falls back to first line", async () => {
  let title = null;
  let warned = false;
  await nameSession({ prompt: "Почини вход", model: "codex/gpt-6-luna", currentTitle: async () => title, setTitle: async t => { title = t; }, generate: async () => "Заголовок\nОбъяснение", warn: () => { warned = true; } });
  assert.equal(title, "Почини вход"); assert.ok(warned);
});

test("generator already archived by autoArchive keeps the generated title", async () => {
  const { generate } = await import("./session-titles.server.ts");
  const handle = { run: async () => ({ status: "idle", lastMessage: "Исправить вход" }), archive: async () => { throw Error("Request failed: Unknown agent 'a1'"); } };
  const paseo = { providers: { waitForReady: async () => ({ entries: [] }) }, workspaces: { ref: () => ({ agents: { create: async () => handle } }) } };
  assert.equal(await generate(paseo, "workspace-1", "codex/gpt-6-luna", "Почини вход"), "Исправить вход");
});

test("title keeps at most three words", async () => {
  const { shortTitle } = await import("./session-titles.server.ts");
  assert.equal(shortTitle("Вход"), "Вход");
  assert.equal(shortTitle("Починить вход Штаба"), "Починить вход Штаба");
  assert.equal(shortTitle("Исправить автогенерацию названия через модель"), "Исправить автогенерацию названия");
  assert.equal(shortTitle("Вход в Штаб."), "Вход в Штаб");
  assert.equal(shortTitle("Настройка доступа для команды"), "Настройка доступа");
});
test("generator uses the weakest thinking level of any provider", async () => {
  const { generate } = await import("./session-titles.server.ts");
  const entries = [
    { provider: "claude", models: [{ id: "claude-haiku-5-5", thinkingOptions: [{ id: "off" }, { id: "low" }, { id: "max" }] }] },
    { provider: "kimi", models: [{ id: "kimi-code/kimi-for-coding-highspeed", thinkingOptions: [{ id: "on" }, { id: "max" }] }] },
    { provider: "gemini", models: [{ id: "auto" }] },
  ];
  const seen = [];
  const paseo = { providers: { waitForReady: async () => ({ entries }) }, workspaces: { ref: () => ({ agents: { create: async options => {
    seen.push(options.config.thinkingOptionId);
    assert.match(options.config.systemPrompt, /one to 3 words/);
    return { run: async () => ({ status: "idle", lastMessage: "Вход" }), archive: async () => {} };
  } } }) } };
  for (const model of ["claude/claude-haiku-5-5", "kimi/kimi-code/kimi-for-coding-highspeed", "gemini/auto"]) await generate(paseo, "w", model, "x");
  assert.deepEqual(seen, ["off", "on", undefined]);
});
test("client and server agree on the generator title", async () => {
  const server = await import("./session-titles.server.ts");
  const shared = await import("../shared/title-models.ts");
  assert.equal(server.GENERATOR_TITLE, shared.GENERATOR_TITLE);
});
test("regeneration context is the last prompt and last reply, cut short", async () => {
  const { titleContext } = await import("./session-titles.server.ts");
  const context = titleContext([
    { type: "user_message", text: "Первый промпт" },
    { type: "assistant_message", text: "Первый ответ" },
    { type: "reasoning", text: "размышления" },
    { type: "user_message", text: "Почини сортировку" },
    { type: "tool_call" },
    { type: "assistant_message", text: "x".repeat(5000) },
  ]);
  assert.match(context, /Last user message:\nПочини сортировку/);
  assert.doesNotMatch(context, /Первый|размышления/);
  assert.ok(context.length < 3100);
  assert.equal(titleContext([]), "");
});
test("regeneration uses project model on the session context", async () => {
  const { suggestTitle } = await import("./session-titles.server.ts");
  let material = "";
  const paseo = {
    providers: { waitForReady: async () => ({ entries: [] }) },
    agents: { ref: () => ({ timeline: { refetch: async () => ({ error: null, entries: [{ item: { type: "user_message", text: "Почини сортировку" } }, { item: { type: "assistant_message", text: "Готово" } }] }) } }) },
    workspaces: { ref: () => ({ agents: { create: async () => ({ run: async text => { material = text; return { status: "idle", lastMessage: "«Сортировка проектов в Штабе»" }; }, archive: async () => {} }) } }) },
  };
  assert.equal(await suggestTitle(paseo, "w", "a", "codex/gpt-6-luna"), "Сортировка проектов");
  assert.match(material, /Почини сортировку/); assert.match(material, /Готово/);
});
