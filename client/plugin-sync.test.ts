import { it, expect, vi } from 'vitest';
import { syncPlugin } from './plugin-sync';
const complete = { state: 'complete' as const, success: true, updated: true, message: 'done' };
it.each(['Plugin stopped: paseo-hq', 'Plugin is not available: paseo-hq'])('recovers after replacement: %s', async (message) => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const rpc = async ({ action }: { action: string }) => {
    calls.push(action);
    if (calls.length <= 2) throw new Error(message);
    return complete;
  };
  try {
    const result = syncPlugin(rpc, 'job');
    await vi.runAllTimersAsync();
    expect(await result).toEqual(complete);
    expect(calls).toEqual(['start', 'status', 'status']);
  } finally { vi.useRealTimers(); }
});
it('returns a real update failure after restart', async () => {
  vi.useFakeTimers();
  const failed = { state: 'failed' as const, success: false, updated: false, message: 'Git refused' };
  try {
    const result = syncPlugin(async ({ action }) => action === 'start' ? { ...complete, state: 'running' } : failed, 'job');
    await vi.runAllTimersAsync();
    expect(await result).toEqual(failed);
  } finally { vi.useRealTimers(); }
});
it('does not hide unrelated RPC errors', async () => {
  await expect(syncPlugin(async () => { throw new Error('Permission denied'); }, 'job')).rejects.toThrow('Permission denied');
});
