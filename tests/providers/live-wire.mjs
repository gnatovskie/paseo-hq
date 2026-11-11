// Read-only live contract check. No agent or model is started.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';
import { providersSnapshot } from '../../shared/provider-cache.ts';
const results=[];
for(const mode of ['wire','expanded']) {
 const daemon=new DaemonClient({url:process.env.PASEO_DAEMON_URL??'ws://127.0.0.1:6767/ws',clientId:`hq-catalog-contract-${mode}`,clientType:'cli',appVersion:'0.15.3',providerSnapshots:mode,localCredential:async()=>(await readFile(join(process.env.PASEO_HOME??join(homedir(),'.paseo'),'local-credential'),'utf8')).trim(),reconnect:{enabled:false}});
 let api;
 try {
  await daemon.connect();api=createPaseoApi(daemon);
  const raw=await api.providers.snapshot({cwd:process.cwd()});
  const start=performance.now();let optionsReadyMs;const catalog=await providersSnapshot(api,process.cwd(),{onUpdate:s=>{const p=s.entries.find(e=>e.provider==='codex');if(optionsReadyMs===undefined&&p?.modes?.length&&p.models?.some(m=>m.thinkingOptions?.length))optionsReadyMs=Math.round(performance.now()-start);}});
  const provider=catalog.entries.find(e=>e.provider==='codex');
  assert(provider?.models?.some(model=>model.thinkingOptions?.length),'Codex thinking choices must be available');
  assert(provider.modes?.length,'Codex permissions must be available');
  results.push({name:`Live ${mode}: permissions and thinking options`,status:'passed',message:`${raw.entries.length} raw entries, ${catalog.entries.length} decoded entries`,milliseconds:Math.round(performance.now()-start),optionsReadyMs});
 } finally {await api?.dispose();await daemon.close();}
}
await writeFile(process.env.HQ_CATALOG_REPORT??'/tmp/opencode/catalog-live.json',JSON.stringify(results,null,2));
