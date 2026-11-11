import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const resultSchema = z.object({
  state: z.enum(['running', 'complete', 'failed']),
  success: z.boolean(), updated: z.boolean(), message: z.string(), details: z.string().optional(),
});
export type PluginSyncResult = z.infer<typeof resultSchema>;

// This worker must survive plugin cleanup and removal of the old managed checkout.
// Keep its entire program in the spawned Node process, with no checkout imports.
const worker = String.raw`
const { execFile } = require('node:child_process');
const { writeFileSync, renameSync } = require('node:fs');
const [file, bin] = process.argv.slice(1);
execFile(bin, ['plugin', 'update', 'paseo-hq', '--yes'], { timeout: 180000 }, (error, stdout, stderr) => {
  const details = [stdout, stderr, error?.message].filter(Boolean).join('\n').trim();
  const result = {
    state: error ? 'failed' : 'complete', success: !error, updated: !error && /updated|→/i.test(details),
    message: error ? 'Не удалось обновить Штаб: ' + error.message : 'Проверка обновлений Штаба завершена', details,
  };
  writeFileSync(file + '.tmp', JSON.stringify(result), { mode: 0o600 });
  renameSync(file + '.tmp', file);
});
`;

export class PluginSyncService {
  private directory: string;
  private binary: string;
  constructor(directory: string, binary: string) { this.directory = directory; this.binary = binary; }

  private file(id: string) {
    return join(this.directory, `${z.string().uuid().parse(id)}.json`);
  }

  async status(id: string): Promise<PluginSyncResult> {
    return resultSchema.parse(JSON.parse(await readFile(this.file(id), 'utf8')));
  }

  async start(id: string): Promise<PluginSyncResult> {
    const file = this.file(id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const running: PluginSyncResult = { state: 'running', success: true, updated: false, message: 'Обновление Штаба запущено' };
    // Exclusive creation also makes repeated starts of the same request safe.
    try { await writeFile(file, JSON.stringify(running), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return this.status(id);
      throw error;
    }
    const child = spawn(process.execPath, ['-e', worker, file, this.binary], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } catch (error) {
      const failed: PluginSyncResult = { state: 'failed', success: false, updated: false, message: `Не удалось запустить обновление: ${String(error)}` };
      await writeFile(file, JSON.stringify(failed), { mode: 0o600 });
      return failed;
    }
    return running;
  }
}
