import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createReadingStore,openReadingStore} from '../reading-store.mjs';
import {selectReadingCandidates} from '../reading-policy.mjs';
import {openPersistentCache,compactAnalysis} from '../persistent-cache.mjs';
import {createServer} from '../server.mjs';

const blocks=[{id:'b1',kind:'paragraph',text:'私密原文 Alpha beta gamma delta.'}];
const analysis=()=>({source:'local_models',semantic:{status:'ready'},blocks:[{...blocks[0],candidates:[{start:0,end:4,text:'私密原文',surprisalNormalized:.1,category:'definition'},{start:5,end:10,text:'Alpha',surprisalNormalized:.9,category:'key_finding',densityDisplay:{wordStart:5,wordEnd:10,wordText:'Alpha',bits:5}},{start:11,end:15,text:'beta',surprisalNormalized:.8,category:'risk'}]}]});
const fakeProtect=async bytes=>bytes;
async function temporary(fn){const dir=await mkdtemp(path.join(os.tmpdir(),'infolens-reading-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}

test('reading preferences persist, reject stale writers, and keep app inheritance separate from auto enable',()=>temporary(async dir=>{
 const file=path.join(dir,'reading.json'),store=createReadingStore({file});await store.update('defaults',{revision:0,settings:{distribution:'sparse',budget:.2,categories:['risk'],mode:'hybrid',classify:false}});
 const data=store.snapshot();assert.equal(data.clients.edge.effective.classify,true);assert.equal(data.clients.edge.autoAnalyze,false);await assert.rejects(store.update('defaults',{revision:0,settings:data.defaults}),/更新/);
 await store.update('vscode',{revision:data.revision,inherit:false,autoAnalyze:true,settings:{distribution:'continuous',budget:.15,categories:[],mode:'information_density',classify:false}});
 const restored=await openReadingStore(file);assert.equal(restored.snapshot().clients.vscode.effective.mode,'information_density');assert.equal(restored.snapshot().clients.edge.effective.distribution,'sparse');
}));
test('sparse budget counts Unicode points, handles overlapping candidates, and never splits a lexical word',()=>{
 const text='🙂 中文 ABC xyz.',b=[{id:'x',text}],word={wordStart:6,wordEnd:9};const candidates=[{blockId:'x',start:6,end:7,score:.9,densityDisplay:word},{blockId:'x',start:7,end:9,score:.9,densityDisplay:word},{blockId:'x',start:3,end:5,score:.8},{blockId:'x',start:10,end:13,score:.6}];
 const selected=selectReadingCandidates(candidates,b,{distribution:'sparse',budget:.35},c=>c.score);assert.equal(selected.length,2);assert.deepEqual(selected.map(c=>[c.start,c.end]),[[6,7],[7,9]]);
 const tooSmall=selectReadingCandidates(candidates.slice(0,2),b,{distribution:'sparse',budget:.15},c=>c.score);assert.equal(tooSmall.length,0);
});
test('continuous masks filter categories without fabricating classifications or changing scores',()=>{
 const a=analysis(),rows=a.blocks[0].candidates.map(c=>({...c,blockId:'b1'}));const selected=selectReadingCandidates(rows,blocks,{categories:['risk']},c=>c.surprisalNormalized);assert.equal(selected.length,1);assert.equal(selected[0].text,'beta');assert.equal(selected[0].surprisalNormalized,.8);
});
test('persistent cache stores encrypted derived scores and restores source only from the matching current snapshot',()=>temporary(async dir=>{
 const cache=await openPersistentCache(dir,{protect:fakeProtect});await cache.configure({enabled:true,maxMiB:16,ttlDays:7});const value=analysis();value.blocks[0].candidates[0].source='local_base';assert(!JSON.stringify(compactAnalysis(value)).includes('私密原文'));assert(!JSON.stringify(compactAnalysis(value)).includes('wordText'));
 await cache.put('identity-a',value);const file=(await readdir(dir)).find(f=>f.endsWith('.ilc')),bytes=await readFile(path.join(dir,file));assert(!bytes.includes(Buffer.from('私密原文')));assert(!bytes.includes(Buffer.from('Alpha')));
 const restarted=await openPersistentCache(dir,{protect:fakeProtect}),hit=await restarted.get('identity-a',blocks);assert.equal(hit.blocks[0].candidates[0].source,'local_base');assert.equal(hit.blocks[0].candidates[1].densityDisplay.wordText,'Alpha');assert.equal(hit.blocks[0].text,blocks[0].text);assert.equal(await restarted.get('different-context',blocks),null);
 bytes[bytes.length-1]^=1;await writeFile(path.join(dir,file),bytes);assert.equal(await restarted.get('identity-a',blocks),null);
}));
test('persistent clear blocks queued writes, default stays off, and TTL expiry prevents reuse',()=>temporary(async dir=>{
 let now=1000;const cache=await openPersistentCache(dir,{protect:fakeProtect,now:()=>now});await cache.put('off',analysis());assert.equal((await readdir(dir).catch(()=>[])).length,0);
 await cache.configure({enabled:true,maxMiB:16,ttlDays:1});const pending=cache.put('late',analysis()),clear=cache.clear();await Promise.all([pending,clear]);assert.equal(await cache.get('late',blocks),null);
 await cache.put('old',analysis());now=Date.now()+2*86400000;assert.equal(await cache.get('old',blocks),null);
}));
test('reading and cache API require authentication; cached classification and density are different jobs',async()=>{
 let calls=0;const provider={source:'local_models',fingerprint:'reading-api',close(){},semanticConfigured:true,status:()=>({state:'ready'}),async analyze(b,p,options){calls++;return {...analysis(),semantic:{status:'ready',classification:{enabled:options.classify}}};}};
 const server=createServer({provider,stageDelayMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try{assert.equal((await fetch(base+'/v1/reading')).status,401);const {token}=await(await fetch(base+'/v1/session',{headers:{'X-InfoLens-Client':'test'}})).json();const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
 const submit=async classify=>{const accepted=await(await fetch(base+'/v1/jobs',{method:'POST',headers,body:JSON.stringify({document:{id:'test',revision:'1'},blocks,analysis:{classify}})})).json();for(let i=0;i<100;i++){const job=await(await fetch(base+'/v1/jobs/'+accepted.jobId,{headers})).json();if(job.status==='completed')return job;await new Promise(r=>setTimeout(r,5));}throw new Error('timeout');};
 await submit(false);await submit(true);const cached=await submit(true);assert.equal(calls,2);assert.equal(cached.result.cacheHit,true);assert.equal(cached.result.analysis.semantic.classification.enabled,true);
 }finally{await new Promise(r=>server.close(r));}
});

test('ephemeral snapshots bypass disk reads and writes even when persistent caching is enabled',async()=>{
 let reads=0,writes=0;const diskCache={snapshot:()=>({enabled:true}),get(){reads++;return null;},put(){writes++;},clear(){}};
 const provider={source:'local_models',fingerprint:'ephemeral',close(){},status:()=>({state:'ready'}),analyze:async()=>analysis()};
 const server=createServer({provider,diskCache,stageDelayMs:0,cacheSize:0});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try{const {token}=await(await fetch(base+'/v1/session',{headers:{'X-InfoLens-Client':'test'}})).json();const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
 const accepted=await(await fetch(base+'/v1/jobs',{method:'POST',headers,body:JSON.stringify({document:{id:'private',revision:'1',ephemeral:true},blocks,analysis:{mode:'information_density'}})})).json();
 for(let i=0;i<100;i++){const job=await(await fetch(base+'/v1/jobs/'+accepted.jobId,{headers})).json();if(job.status==='completed'){assert.equal(reads,0);assert.equal(writes,0);return;}await new Promise(r=>setTimeout(r,5));}throw Error('timeout');
 }finally{await new Promise(r=>server.close(r));}
});
