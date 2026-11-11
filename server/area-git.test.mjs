import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitCheckoutKind } from './area-git.server.ts';

test('identifies the main checkout and linked worktree, including their subdirectories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hq-git-kind-'));
  try {
    const project = join(dir, 'project');
    const worktree = join(dir, 'worktree');
    await mkdir(project);
    execFileSync('git', ['init', '-q', '-b', 'main', project]);
    execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'initial']);
    execFileSync('git', ['-C', project, 'worktree', 'add', '-qb', 'feature', worktree]);
    await mkdir(join(project, 'sub'));
    await mkdir(join(worktree, 'sub'));
    assert.equal(await gitCheckoutKind(project), 'project');
    assert.equal(await gitCheckoutKind(join(project, 'sub')), 'project');
    assert.equal(await gitCheckoutKind(worktree), 'worktree');
    assert.equal(await gitCheckoutKind(join(worktree, 'sub')), 'worktree');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
