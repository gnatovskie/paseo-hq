import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginSyncService } from './plugin-sync.server';

describe('plugin self update', () => {
  it.each([0, 7])('persists the real CLI result across service replacement (exit %s)', async (exitCode) => {
    const dir = await mkdtemp(join(tmpdir(), 'hq-update-'));
    try {
      const cli = join(dir, 'paseo');
      await writeFile(cli, `#!/bin/sh\necho update-output\nexit ${exitCode}\n`, { mode: 0o700 });
      const service = new PluginSyncService(dir, cli);
      const id = 'a9d311b0-f204-48f6-bfbe-f432915ec619';
      const started = await service.start(id);
      expect(started.state).toBe('running');
      const replacement = new PluginSyncService(dir, cli);
      await expect.poll(async () => (await replacement.status(id)).state).toBe(exitCode ? 'failed' : 'complete');
      const result = await replacement.status(id);
      expect(result.success).toBe(exitCode === 0);
      expect(result.details).toContain('update-output');
      expect(JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')).state).toBe(result.state);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('reports a missing executable instead of falling back to git pull', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hq-update-'));
    try {
      const service = new PluginSyncService(dir, join(dir, 'missing'));
      const id = 'a9d311b0-f204-48f6-bfbe-f432915ec619';
      await service.start(id);
      await expect.poll(async () => (await service.status(id)).state).toBe('failed');
      expect((await service.status(id)).details).toContain('ENOENT');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

it('finishes after the initiating plugin process exits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hq-update-exit-'));
  try {
    const cli = join(dir, 'paseo');
    await writeFile(cli, '#!/bin/sh\necho independent-update\n', { mode: 0o700 });
    const id = 'a9d311b0-f204-48f6-bfbe-f432915ec619';
    const moduleUrl = new URL('./plugin-sync.server.ts', import.meta.url).href;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { PluginSyncService } from ${JSON.stringify(moduleUrl)};
      await new PluginSyncService(${JSON.stringify(dir)}, ${JSON.stringify(cli)}).start(${JSON.stringify(id)});
      process.exit(0);
    `]);
    const replacement = new PluginSyncService(dir, cli);
    await expect.poll(async () => (await replacement.status(id)).state).toBe('complete');
    expect((await replacement.status(id)).details).toContain('independent-update');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
