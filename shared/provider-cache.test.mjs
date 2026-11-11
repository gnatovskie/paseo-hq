import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
const { text } = buildSync({entryPoints:[new URL('./provider-cache.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'cjs'}).outputFiles[0];
function load(){const module={exports:{}};new Function('module','exports',text)(module,module.exports);return module.exports;}
test('ready provider options arrive before an unrelated provider finishes discovery', async()=>{
 const {providersSnapshot}=load(); let finish; const partial={entries:[{provider:'codex',status:'ready',modes:[{id:'full'}]},{provider:'other',status:'loading'}]}; const final={entries:[partial.entries[0]]}; const updates=[];
 const api={providers:{snapshot:async()=>partial,subscribe:()=>()=>{},waitForReady:()=>new Promise(r=>finish=r)}};
 const pending=providersSnapshot(api,'/project',{onUpdate:s=>updates.push(s)});
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(updates,[partial]); finish(final); assert.equal(await pending,final);
});
