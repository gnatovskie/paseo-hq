import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAgentUpdate} from './sidebar-agent-updates.ts';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
const entry={agent:{id:'a',title:'Before',archivedAt:null,internal:false},project:{projectId:'p'}};
test('sidebar consumes event contents without downloading all agents again',()=>{
 const source=readFileSync(new URL('../index.client.tsx',import.meta.url),'utf8');
 const start=source.indexOf('const unsubAg =');const statement=source.slice(start,source.indexOf('\n',start));
 let callback;let entries=[entry];let requests=0;
 new Function('paseo','reloadAll','setAgents','applyAgentUpdate',transformSync(statement,{loader:'ts'}).code)({agents:{subscribe:fn=>callback=fn}},()=>requests++,fn=>entries=fn(entries),applyAgentUpdate);
 for(let i=0;i<100;i++)callback({kind:'upsert',agent:{...entry.agent,title:`Update ${i}`}});
 assert.equal(requests,0);assert.equal(entries[0].agent.title,'Update 99');assert.deepEqual(entries[0].project,entry.project);
 callback({kind:'remove',agentId:'a'});assert.deepEqual(entries,[]);
});
test('new, archived and internal agents follow visible list membership',()=>{
 assert.equal(applyAgentUpdate([],{kind:'upsert',agent:entry.agent,project:entry.project}).length,1);
 for(const patch of [{archivedAt:'today'},{internal:true}])assert.deepEqual(applyAgentUpdate([entry],{kind:'upsert',agent:{...entry.agent,...patch}}),[]);
});
