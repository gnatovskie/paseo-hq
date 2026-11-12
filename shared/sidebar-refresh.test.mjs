import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshScheduler, shouldFetchAgents, SIDEBAR_AGENT_RESYNC_MS } from './sidebar-refresh.ts';

function fakeTimers() {
  let now = 0;
  const timers = [];
  return {
    setTimeout: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        await due.fn();
        await Promise.resolve();
      }
    },
  };
}

test('a burst of workspace events produces one reload, not one per event', async () => {
  const timers = fakeTimers();
  let runs = 0;
  const scheduler = createRefreshScheduler({ run: async () => { runs += 1; }, coalesceMs: 1500, ...timers });
  for (let i = 0; i < 20; i += 1) scheduler.request();
  await timers.advance(1500);
  assert.equal(runs, 1);
});

test('requests during a running reload trigger exactly one follow-up reload', async () => {
  const timers = fakeTimers();
  let runs = 0;
  let release;
  const scheduler = createRefreshScheduler({
    run: () => { runs += 1; return runs === 1 ? new Promise(r => { release = r; }) : Promise.resolve(); },
    coalesceMs: 1000,
    ...timers,
  });
  scheduler.request();
  await timers.advance(1000);
  assert.equal(runs, 1);
  scheduler.request();
  scheduler.request();
  release();
  await Promise.resolve();
  await Promise.resolve();
  await timers.advance(1000);
  assert.equal(runs, 2);
});

test('a stopped scheduler never reloads again', async () => {
  const timers = fakeTimers();
  let runs = 0;
  const scheduler = createRefreshScheduler({ run: async () => { runs += 1; }, coalesceMs: 500, ...timers });
  scheduler.request();
  scheduler.stop();
  await timers.advance(5000);
  assert.equal(runs, 0);
});

test('the full agent list is fetched on first load and then only for a periodic resync', () => {
  assert.equal(shouldFetchAgents(null, 0), true);
  assert.equal(shouldFetchAgents(1000, 1000 + 5000), false);
  assert.equal(shouldFetchAgents(1000, 1000 + SIDEBAR_AGENT_RESYNC_MS), true);
  assert.equal(shouldFetchAgents(1000, 1000 + 5000, true), true);
});
