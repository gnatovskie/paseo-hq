import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import React from 'react';

const source = readFileSync(new URL('../index.client.tsx', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('function NewSessionWindow('), source.indexOf('\nfunction ItemMenuActions'));
const code = transformSync(component, { loader: 'tsx', jsx: 'transform' }).code;
const stub = () => null;
const HqModal = Object.assign(stub, { Content: stub });
const Window = new Function('React', 'View', 'Text', 'Pressable', 'HqModal', 'TitleModelPicker', 'ProviderLogo', 'NewAgentOption', 'ItemMenuActions', 'NewSessionName', `${code}; return NewSessionWindow;`)(React, stub, stub, 'button', HqModal, stub, stub, stub, stub, stub);
function submit(props) {
  const tree = Window({ theme: { colors: {} }, kind: 'agent', naming: {}, agentOptions: { loading: true }, model: 'codex/example', modelOptions: [], ...props });
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button' && node.props.onPress === props.onSubmit) return node;
    return React.Children.toArray(node.props?.children).map(visit).find(Boolean);
  };
  return visit(tree);
}
test('selected model can create immediately while catalog is still pending', () => {
  let created = false;
  const button = submit({ onSubmit: () => { created = true; } });
  assert.equal(button.props.disabled, false);
  button.props.onPress();
  assert.equal(created, true);
});
test('missing model and pending creation still block submission', () => {
  assert.equal(submit({ model: null, onSubmit() {} }).props.disabled, true);
  assert.equal(submit({ busy: true, onSubmit() {} }).props.disabled, true);
});
