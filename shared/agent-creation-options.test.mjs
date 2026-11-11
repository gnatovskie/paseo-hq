import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentCreationOptions } from './agent-creation-options.ts';
const entries = [
  { provider: 'codex', modes: [{ id: 'default', label: 'Default' }, { id: 'full', label: 'Full access' }], defaultModeId: 'default', models: [
    { id: 'a', thinkingOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultThinkingOptionId: 'high' },
    { id: 'b', thinkingOptions: [{ id: 'medium', label: 'Medium', isDefault: true }] },
  ] },
  { provider: 'other', modes: [{ id: 'ask', label: 'Ask' }], defaultModeId: 'ask', models: [{ id: 'vendor/model' }] },
];
test('inherits supported permissions and effort, with choices from the selected model', () => {
  const result = agentCreationOptions(entries, 'codex/a', { modeId: 'full', thinkingOptionId: 'low' });
  assert.equal(result.modeId, 'full');
  assert.equal(result.thinkingOptionId, 'low');
  assert.deepEqual(result.modes.map(x => x.id), ['default', 'full']);
  assert.deepEqual(result.thinkingOptions.map(x => x.id), ['low', 'high']);
});
test('model changes keep valid permissions and replace incompatible effort with its default', () => {
  const result = agentCreationOptions(entries, 'codex/b', { modeId: 'full', thinkingOptionId: 'low' });
  assert.equal(result.modeId, 'full');
  assert.equal(result.thinkingOptionId, 'medium');
});
test('provider changes reset incompatible options and support slash-containing model ids', () => {
  const result = agentCreationOptions(entries, 'other/vendor/model', { modeId: 'full', thinkingOptionId: 'high' });
  assert.equal(result.modeId, 'ask');
  assert.equal(result.thinkingOptionId, undefined);
  assert.deepEqual(result.thinkingOptions, []);
});
test('missing selection or loading catalog does not invent options', () => {
  assert.deepEqual(agentCreationOptions([], 'codex/a', {}), { modes: [], thinkingOptions: [], modeId: undefined, thinkingOptionId: undefined });
});
test('pending catalog preserves inherited settings for immediate creation', () => {
  const result = agentCreationOptions([], 'codex/a', { modeId: 'full', thinkingOptionId: 'low' });
  assert.equal(result.modeId, 'full');
  assert.equal(result.thinkingOptionId, 'low');
});
test('partial catalog preserves selected provider settings until it arrives',()=>{
 const result=agentCreationOptions([entries[1]],'codex/a',{modeId:'full',thinkingOptionId:'high'});
 assert.equal(result.modeId,'full');assert.equal(result.thinkingOptionId,'high');
});
