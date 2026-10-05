import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from '../server.mjs';
test('pause cancels active/queued jobs, unload gates concurrent submit, resume preserves completed cache',async()=>{
  let loaded=true, resolveUnload, started;
  const begun=new Promise(r=>started=r);
  const provider={source:'local_base',fingerprint:'control-test',status:()=>({state:loaded?'ready':'not_loaded',modelConnected:loaded}),close(){},unload:()=>new Promise(r=>{resolveUnload=()=>{loaded=false;r();};}),
    async analyze(blocks,profile,{signal}){if(blocks[0].text==='slow'){started();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}return {source:'local_base',blocks};}};
  const server=createServer({provider,stageDelayMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
  const token=(await(await fetch(url+'/v1/session',{headers:{'X-InfoLens-Client':'test'}})).json()).token;
  const request=async(route,method='GET',body)=>{const r=await fetch(url+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
  const submit=text=>request('/v1/jobs','POST',{document:{id:'test',revision:'1'},blocks:[{id:'b1',text}]});
  try{
    const saved=await submit('cached');let result;for(let i=0;i<100;i++){result=await request('/v1/jobs/'+saved.body.jobId);if(result.body.status==='completed')break;await new Promise(r=>setTimeout(r,5));}assert.equal(result.body.status,'completed');
    const active=await submit('slow');await begun;const queued=await submit('later');
    assert.equal((await request('/v1/control','POST',{action:'pause'})).body.paused,true);
    for(const job of [active,queued])assert.equal((await request('/v1/jobs/'+job.body.jobId)).body.status,'cancelled');
    assert.equal((await submit('blocked')).status,423);
    const unloading=request('/v1/control','POST',{action:'unload'});while(!resolveUnload)await new Promise(r=>setTimeout(r,5));
    assert.equal((await request('/v1/control','POST',{action:'resume'})).status,409);resolveUnload();await unloading;
    await request('/v1/control','POST',{action:'resume'});assert.equal((await request('/v1/status')).body.modelConnected,false);
    const reused=await submit('cached');for(let i=0;i<100;i++){result=await request('/v1/jobs/'+reused.body.jobId);if(result.body.status==='completed')break;await new Promise(r=>setTimeout(r,5));}assert.equal(result.body.result.cacheHit,true);
    assert.equal((await request('/v1/control','POST',{action:'shutdown'})).status,400);
    assert.equal((await fetch(url+'/v1/control',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"pause"}'})).status,401);
  }finally{await new Promise(r=>server.close(r));}
});
