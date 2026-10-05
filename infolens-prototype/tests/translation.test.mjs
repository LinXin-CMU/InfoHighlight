import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from '../server.mjs';

async function fixture(provider){
 const server=createServer({provider,stageDelayMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 const token=(await(await fetch(base+'/v1/session',{headers:{'X-InfoLens-Client':'test'}})).json()).token;
 const api=async(path,method='GET',body)=>{const r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
 return {api,close:()=>new Promise(r=>server.close(r))};
}
const input=targetLanguage=>({document:{id:'pdf-1',revision:'1',offsetEncoding:'utf16'},blocks:[{id:'run-0',text:'Do not omit the condition: ≤ 10 μg. 👩🏽‍💻',kind:'paragraph'}],translation:{targetLanguage}});
async function complete(f,id){for(let i=0;i<100;i++){const r=await f.api('/v1/jobs/'+id);if(['completed','failed','cancelled'].includes(r.body.status))return r.body;await new Promise(r=>setTimeout(r,5));}throw Error('Timed out');}
test('translation shares authenticated queue, binds snapshot and caches by target separately from analysis',async()=>{
 let count=0;const provider={source:'local_models',semanticConfigured:true,status:()=>({state:'ready'}),close(){},async translate(blocks,targetLanguage){count++;return {kind:'translation',targetLanguage,status:'ready',blocks:blocks.map(b=>({id:b.id,source:b.text,translated:'保留条件：≤ 10 μg。',status:'ready'}))};},async analyze(){throw Error('Analysis not requested');}};
 const f=await fixture(provider);try{
  const a=await f.api('/v1/translation-jobs','POST',input('zh'));assert.equal(a.status,202);assert.equal(a.body.kind,'translation');
  const done=await complete(f,a.body.jobId);assert.equal(done.result.analysis.kind,'translation');assert.equal(done.result.analysis.blocks[0].source,input('zh').blocks[0].text);assert.equal(done.revision,'1');
  const b=await f.api('/v1/translation-jobs','POST',{...input('zh'),document:{...input('zh').document,revision:'2'}});assert.equal((await complete(f,b.body.jobId)).result.cacheHit,true);assert.equal(count,1);
  const c=await f.api('/v1/translation-jobs','POST',input('en'));await complete(f,c.body.jobId);assert.equal(count,2);
  assert.equal((await f.api('/v1/translation-jobs','POST',input('xx'))).status,400);
  assert.equal((await f.api('/v1/translation-jobs','POST',{...input('zh'),translation:{targetLanguage:'zh',url:'https://invalid'}})).status,400);
  assert.equal((await f.api('/v1/capabilities')).body.translation.available,true);
 }finally{await f.close();}
});
test('unavailable or cancelled translation never paints a fabricated demo result or fills the cache',async()=>{
 let release;const provider={source:'local_models',status:()=>({state:'ready'}),close(){},translate:()=>new Promise(r=>{release=r;})};
 const f=await fixture(provider);try{
  const a=await f.api('/v1/translation-jobs','POST',input('zh'));
  while(!release)await new Promise(r=>setTimeout(r,5));
  await f.api('/v1/jobs/'+a.body.jobId,'DELETE');release({kind:'translation',status:'ready',blocks:[]});
  const done=await complete(f,a.body.jobId);assert.equal(done.status,'cancelled');assert.equal(done.result,undefined);assert.equal((await f.api('/v1/status')).body.cacheEntries,0);
 }finally{await f.close();}
 const absent=await fixture();try{assert.equal((await absent.api('/v1/translation-jobs','POST',input('zh'))).status,503);}finally{await absent.close();}
});
