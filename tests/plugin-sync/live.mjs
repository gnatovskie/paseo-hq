// Run on the daemon host with an installed plugin and PASEO_PASSWORD_FILE.
// This intentionally updates paseo-hq to the remote main revision.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const { DaemonClient } = await import(process.env.PASEO_CLIENT_MODULE || '@getpaseo/client/internal/daemon-client');
const daemon = new DaemonClient({
  url: process.env.PASEO_DAEMON_URL || 'ws://127.0.0.1:6767/ws',
  password: (await readFile(process.env.PASEO_PASSWORD_FILE, 'utf8')).trim(),
  clientId: 'hq-self-update-smoke', clientType: 'cli', appVersion: '0.15.2', reconnect: { enabled: false },
});
const results = [];
try {
  await daemon.connect();
  const before = (await daemon.listPlugins()).find(p => p.id === 'paseo-hq');
  assert.equal(before.status, 'running');
  const { syncPlugin } = await import(pathToFileURL(before.path + '/client/plugin-sync.ts'));
  const result = await syncPlugin(input => daemon.invokePluginRpc('paseo-hq', 'sidebar.plugin-sync', input), randomUUID());
  assert.equal(result.state, 'complete', JSON.stringify(result));
  assert.equal(result.success, true, JSON.stringify(result));
  const after = (await daemon.listPlugins()).find(p => p.id === 'paseo-hq');
  assert.equal(after.status, 'running');
  if (process.env.EXPECT_REVISION) assert.equal(after.installation.currentRevision, process.env.EXPECT_REVISION);
  results.push({name: 'Installed plugin: update RPC completes and plugin remains running', status: 'passed', message: `${before.installation.currentRevision} -> ${after.installation.currentRevision}`});
} catch (error) {
  results.push({name: 'Installed plugin: self-update', status: 'failed', message: String(error.stack || error)});
  process.exitCode = 1;
} finally {
  await daemon.close();
  await writeFile(process.env.HQ_LIVE_REPORT || '/tmp/hq-update-live.json', JSON.stringify(results, null, 2));
}
