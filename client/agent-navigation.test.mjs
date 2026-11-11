import test from 'node:test';
import assert from 'node:assert/strict';
import { openAgentTab } from './agent-navigation.ts';

test('opening and reopening a chat always uses host navigation, including same-millisecond taps', async t => {
  t.mock.method(Date, 'now', () => 1000);
  const screens = [];
  const navigation = {
    openURL: async () => assert.fail('A workspace deep link skips revealing the mobile chat panel'),
    openScreen: screen => screens.push(screen),
  };
  await openAgentTab({ agentId: 'a' }, navigation);
  await openAgentTab({ agentId: 'a' }, navigation);
  assert.equal(screens.length, 2);
  assert(screens.every(screen => screen.screenId === 'jump' && screen.params.agentId === 'a'));
  assert.notEqual(screens[0].params.t, screens[1].params.t);
});

test('navigation failures reach the caller', async () => {
  await assert.rejects(openAgentTab({ agentId: 'a' }, {
    openScreen: () => { throw Error('navigation failed'); },
  }), /navigation failed/);
});
