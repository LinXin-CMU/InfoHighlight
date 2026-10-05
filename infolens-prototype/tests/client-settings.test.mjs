import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createAppearanceStore,openAppearanceStore} from '../client-settings.mjs';
import {createServer} from '../server.mjs';
async function cleanup(folder){assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));assert.ok(path.basename(folder).startsWith('infolens-'));await rm(folder,{recursive:true,force:true});}

test('unified appearance reaches inheriting clients while per-app override stays isolated',async()=>{
  const store=createAppearanceStore();let s=store.snapshot();
  s=await store.update('vscode',{revision:s.revision,inherit:false,settings:{style:'underline',hue:210,intensity:.65}});
  s=await store.update('defaults',{revision:s.revision,settings:{style:'fade',hue:30,intensity:1.2}});
  assert.equal(s.clients.edge.effective.style,'fade');assert.equal(s.clients.workbench.effective.intensity,1.2);
  assert.deepEqual(s.clients.vscode.effective,{style:'underline',hue:210,intensity:.65});
  s=await store.update('vscode',{revision:s.revision,inherit:true,settings:s.clients.vscode.settings});assert.equal(s.clients.vscode.effective.style,'fade');assert.equal(s.clients.vscode.settings.style,'underline');
});
test('concurrent saves reject stale revisions and invalid settings without changing state',async()=>{
  const store=createAppearanceStore(),settings={style:'foreground',hue:180,intensity:.8};
  const results=await Promise.allSettled(['edge','vscode'].map(id=>store.update(id,{revision:0,inherit:false,settings})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
  const before=store.snapshot();
  for(const body of [{revision:1,inherit:false,settings:{...settings,body:'private text'}},{revision:1,inherit:'yes',settings},{revision:1,inherit:false,settings:{...settings,hue:999}},{revision:1,inherit:false,settings:{...settings,intensity:null}}])await assert.rejects(store.update('edge',body));
  await assert.rejects(store.update('../../outside',{revision:1,settings}),{status:404});assert.deepEqual(store.snapshot(),before);
});
test('preferences survive restart and contain only display settings',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'infolens-settings-'));const file=path.join(folder,'profile.json');
  try{let store=await openAppearanceStore(file);await store.update('codex',{revision:0,inherit:false,settings:{style:'foreground',hue:275,intensity:.75}});
    store=await openAppearanceStore(file);assert.deepEqual(store.snapshot().clients.codex.effective,{style:'foreground',hue:275,intensity:.75});
    const disk=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(Object.keys(disk).sort(),['clients','defaults','revision','schemaVersion','updatedAt']);assert.equal(disk.clients.codex.effective,undefined);
    await writeFile(file,'malformed');await assert.rejects(openAppearanceStore(file));assert.equal(await readFile(file,'utf8'),'malformed');
  }finally{await cleanup(folder);}
});
test('failed disk writes do not acknowledge or change in-memory settings',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'infolens-writefail-'));const file=path.join(folder,'blocked');await mkdir(file);
  try{const store=createAppearanceStore({file});await assert.rejects(store.update('edge',{revision:0,inherit:false,settings:{style:'fade',hue:0,intensity:.5}}),{status:503});assert.equal(store.snapshot().revision,0);}
  finally{await cleanup(folder);}
});
test('appearance API requires pairing, validates payload and never submits analysis',async()=>{
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
  try{assert.equal((await fetch(url+'/v1/appearance')).status,401);const token=(await(await fetch(url+'/v1/session',{headers:{'X-InfoLens-Client':'settings-test'}})).json()).token;
    const request=(route,method='GET',body)=>fetch(url+route,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const settings={style:'underline',hue:210,intensity:.9};assert.equal((await request('/v1/appearance/edge','PUT',{revision:0,inherit:false,settings})).status,200);
    assert.equal((await request('/v1/appearance/vscode','PUT',{revision:0,inherit:false,settings})).status,409);
    assert.equal((await request('/v1/appearance/edge','PUT',{revision:1,inherit:false,settings:{...settings,text:'document'}})).status,400);
    const state=await(await request('/v1/appearance')).json();assert.equal(state.clients.edge.effective.style,'underline');assert.equal(state.clients.vscode.effective.style,'background');assert.equal((await(await request('/v1/status')).json()).submittedJobs,0);
  }finally{await new Promise(r=>server.close(r));}
});
