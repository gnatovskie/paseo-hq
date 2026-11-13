import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { daemonListen } from "./daemon-endpoint.server.ts";

test("the plugin talks to the daemon of its own PASEO_HOME", async () => {
  const home = await mkdtemp(join(tmpdir(), "hq-endpoint-"));
  try {
    assert.equal(await daemonListen(home), "127.0.0.1:6767", "no config means the default daemon");
    await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: "127.0.0.1:41234" } }));
    assert.equal(await daemonListen(home), "127.0.0.1:41234");
    await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: "/run/paseo.sock" } }));
    await assert.rejects(daemonListen(home), /Unsupported daemon listen/);
    await writeFile(join(home, "config.json"), "{");
    await assert.rejects(daemonListen(home), SyntaxError);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
