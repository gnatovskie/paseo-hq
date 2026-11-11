import test from 'node:test';
import assert from 'node:assert/strict';
import {openAgentTab} from './agent-navigation.ts';
for(const platform of ['ios','android'])test(`${platform} opens the known workspace agent directly without a plugin screen`,async()=>{
 const urls=[];const screens=[];
 await openAgentTab({platform,hostId:'host/a',workspaceId:'workspace b',agentId:'agent:c'},{openURL:async url=>urls.push(url),openScreen:screen=>screens.push(screen)});
 assert.deepEqual(screens,[]);
 assert.deepEqual(urls,['paseo:///h/host%2Fa/workspace/workspace%20b?open=agent%3Aagent%3Ac']);
});
test('web keeps client navigation and does not reload the document',async()=>{
 const screens=[];
 await openAgentTab({platform:'web',hostId:'h',workspaceId:'w',agentId:'a'},{openURL:async()=>assert.fail('document reload'),openScreen:screen=>screens.push(screen)});
 assert.equal(screens[0].params.agentId,'a');
});
test('native link failure reaches the caller rather than silently opening another screen',async()=>{
 await assert.rejects(openAgentTab({platform:'ios',hostId:'h',workspaceId:'w',agentId:'a'},{openURL:async()=>{throw Error('link failed');},openScreen:()=>{}}),/link failed/);
});
