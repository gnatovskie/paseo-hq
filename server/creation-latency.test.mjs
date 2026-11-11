import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
const source=readFileSync(new URL('../index.server.ts',import.meta.url),'utf8');
const body=source.slice(source.indexOf('  server.handle(areaSessionCreateRpc,'),source.indexOf('  server.handle(chatRenameRpc,'));
test('creating selected agent does not wait for unrelated provider catalogs',async()=>{
 let handler;const server={handle:(_,h)=>handler=h};const area={id:'w',projectRootPath:'/repo'};
 new Function('server','areaSessionCreateRpc','requireArea','providersSnapshot',transformSync(body,{loader:'ts'}).code)(server,{},async()=>area,()=>assert.fail('creation waited for all providers'));
 const result=await handler({workspaceId:'w',model:'codex/example',modeId:'full',thinkingOptionId:'high'},{paseo:{workspaces:{ref:()=>({agents:{create:async opts=>{assert.equal(opts.config.modeId,'full');assert.equal(opts.config.thinkingOptionId,'high');return {id:'new'};}}})}}});
 assert.deepEqual(result,{agentId:'new'});
});
