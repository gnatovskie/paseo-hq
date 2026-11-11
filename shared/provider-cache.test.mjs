import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
const { text } = buildSync({entryPoints:[new URL('./provider-cache.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'cjs'}).outputFiles[0];
function load(){const module={exports:{}};new Function('module','exports',text)(module,module.exports);return module.exports;}
test('ready provider options arrive before an unrelated provider finishes discovery', async()=>{
 const {providersSnapshot}=load(); let finish; const partial={entries:[{provider:'codex',status:'ready',modes:[{id:'full'}]},{provider:'other',status:'loading'}]}; const final={entries:[partial.entries[0]]}; const updates=[];
 const api={providers:{snapshot:async()=>partial,subscribe:callback=>{finish=s=>callback({...s,cwd:'/project'});return ()=>{};}}};
 const pending=providersSnapshot(api,'/project',{onUpdate:s=>updates.push(s)});
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(updates,[partial]); finish(final); assert.deepEqual((await pending).entries,final.entries);
});
test('native wire catalog exposes permissions and thinking options instead of an empty catalog',async()=>{
 const {providersSnapshot}=load();
 const snapshot={entries:[],snapshotHash:'hash',compactSnapshot:{entries:[{provider:'codex',status:'ready',enabled:true,modes:[{id:'full'}],models:[{id:'model',thinkingSet:0}]}],thinkingSets:[{options:[{id:'high'}],defaultOptionId:'high'}]}};
 const result=await providersSnapshot({providers:{snapshot:async()=>snapshot,subscribe:()=>()=>{}}},'/repo');
 assert.equal(result.entries[0]?.modes[0].id,'full');
 assert.equal(result.entries[0]?.models[0].thinkingOptions[0].id,'high');
 assert.equal(result.entries[0]?.models[0].defaultThinkingOptionId,'high');
});
test('compact loading catalog waits for hash-only update and fetches its body',async()=>{
 const {providersSnapshot}=load();let update;let calls=0;let released=false;
 const compact=status=>({entries:[],cwd:'/repo',snapshotHash:status,compactSnapshot:{entries:[{provider:'codex',status}],thinkingSets:[]}});
 const api={providers:{subscribe:fn=>{update=fn;return()=>{released=true;}},snapshot:async()=>{calls++;return compact(calls===1?'loading':'ready');}}};
 let completed=false;const pending=providersSnapshot(api,'/repo').then(s=>{completed=true;return s;});
 await new Promise(r=>setImmediate(r));assert.equal(completed,false);
 update({cwd:'/repo',entries:[],snapshotHash:'ready'});
 assert.equal((await pending).entries[0].status,'ready');assert.equal(calls,2);assert.equal(released,true);
});
test('same directory on another host does not reuse cached permissions',async()=>{
 const {providersSnapshot}=load();
 const api=id=>({providers:{snapshot:async()=>({entries:[{provider:id,status:'ready'}]}),subscribe:()=>()=>{}}});
 assert.equal((await providersSnapshot(api('first'),'/repo')).entries[0].provider,'first');
 assert.equal((await providersSnapshot(api('second'),'/repo')).entries[0].provider,'second');
});
test('overlapping callers share a request and failed snapshots release subscription',async()=>{
 const {providersSnapshot}=load();let reject;let requests=0;let released=0;
 const api={providers:{snapshot:()=>{requests++;return new Promise((_,r)=>reject=r);},subscribe:()=>()=>released++}};
 const a=providersSnapshot(api,'/repo');const b=providersSnapshot(api,'/repo');assert.equal(a,b);assert.equal(requests,1);
 reject(Error('offline'));await assert.rejects(a,/offline/);assert.equal(released,1);
});
