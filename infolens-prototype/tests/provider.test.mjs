import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {createServer} from '../server.mjs';import {contentHash,selectHeatmap} from '../engine.mjs';

test('density jobs skip semantic inference and cache independently from optional semantic jobs',async()=>{
  const modes=[];
  const provider={source:'local_models',semanticConfigured:true,fingerprint:'mode-fixture',status:()=>({state:'ready'}),close(){},async analyze(blocks,profile,{mode}){modes.push(mode);return {source:mode==='information_density'?'local_base':'local_models',blocks,...(mode==='information_density'?{}:{semantic:{status:'ready'}})};}};
  const server=createServer({provider,stageDelayMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const session=await(await fetch(base+'/v1/session',{headers:{'X-InfoLens-Client':'test'}})).json();const headers={Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'};
    const request=mode=>({document:{id:'mode-check',revision:mode},blocks:[{id:'b1',text:'same document'}],analysis:{mode}});
    const invalid=await fetch(base+'/v1/jobs',{method:'POST',headers,body:JSON.stringify(request('unknown'))});assert.equal(invalid.status,400);
    for(const [mode,hit] of [['information_density',false],['information_density',true],['hybrid',false],['semantic_importance',true],['information_density',true]]){
      const accepted=await(await fetch(base+'/v1/jobs',{method:'POST',headers,body:JSON.stringify(request(mode))})).json();let job;
      for(let n=0;n<100;n++){job=await(await fetch(base+'/v1/jobs/'+accepted.jobId,{headers})).json();if(job.status==='completed')break;await new Promise(r=>setTimeout(r,5));}
      assert.equal(job.status,'completed');assert.equal(job.result.cacheHit,hit);
      assert.equal(job.result.analysis.source,mode==='information_density'?'local_base':'local_models');
    }
    assert.deepEqual(modes,['information_density','hybrid']);
  }finally{await new Promise(r=>server.close(r));}
});
test('partial semantic analyses are retried, complete dual analyses are cached, and policy metadata stays real',async()=>{
  let calls=0;
  const provider={source:'local_models',semanticConfigured:true,policies:{promptPolicyVersion:'fixture-prompt-v1'},fingerprint:'fixture-dual',status:()=>({state:'ready'}),close(){},async analyze(blocks){calls++;return {source:'local_models',blocks,semantic:{status:calls===1?'partial':'ready',coverage:{evaluatedSentences:calls===1?0:1,totalSentences:1}}};}};
  const server=createServer({provider,stageDelayMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
  try{const session=await(await fetch(url+'/v1/session',{headers:{'X-InfoLens-Client':'test'}})).json();const headers={Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'};
    const capabilities=await(await fetch(url+'/v1/capabilities',{headers})).json();assert.equal(capabilities.policies.promptPolicyVersion,'fixture-prompt-v1');assert.equal(capabilities.engineVersion,'local-dual-v1');
    for(let i=0;i<3;i++){const accepted=await(await fetch(url+'/v1/jobs',{method:'POST',headers,body:JSON.stringify({document:{id:'retry',revision:String(i)},blocks:[{id:'b1',text:'same source'}]})})).json();let job;for(let n=0;n<100;n++){job=await(await fetch(url+'/v1/jobs/'+accepted.jobId,{headers})).json();if(job.status==='completed')break;await new Promise(r=>setTimeout(r,5));}assert.equal(job.status,'completed');assert.equal(job.result.cacheHit,i===2);assert.equal(job.result.revision,String(i));}
    assert.equal(calls,2);
  }finally{await new Promise(r=>server.close(r));}
});
test('real provider results remain real, preserve missing semantic and cache without recomputation',async()=>{
  let calls=0,closed=false;
  const provider={source:'local_base',fingerprint:'fixture-real-provider-v1',status:()=>({state:'ready',modelConnected:true,gpu:{allocatedMiB:1},model:{repo:'test-only'}}),close:()=>{closed=true;},analyze:async(blocks)=>{calls++;return {source:'local_base',modelConnected:true,blocks:blocks.map(b=>({...b,candidates:[{start:0,end:b.text.length,text:b.text,surprisalRaw:2,surprisalBits:2/Math.log(2),surprisalNormalized:.16,semantic:null,source:'local_base',category:'general'}]}))};}};
  const server=createServer({provider,stageDelayMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  try{const session=await(await fetch(base+'/v1/session',{headers:{'X-InfoLens-Client':'test'}})).json();assert.equal(session.source,'local_base');const headers={Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'};
    const blocks=[{id:'b1',kind:'paragraph',text:'中文 👩🏽‍💻'}];const body={document:{id:'x',revision:'1',contentHash:await contentHash(blocks)},blocks};let last;
    for(let i=0;i<2;i++){const accepted=await(await fetch(base+'/v1/jobs',{method:'POST',headers,body:JSON.stringify(body)})).json();for(let n=0;n<100;n++){last=await(await fetch(base+'/v1/jobs/'+accepted.jobId,{headers})).json();if(last.status==='completed')break;await new Promise(r=>setTimeout(r,5));}assert.equal(last.status,'completed');assert.equal(last.result.source,'local_base');}
    assert.equal(calls,1);assert.equal(last.result.cacheHit,true);const display=selectHeatmap(last.result.analysis);assert.equal(display.spans[0].semantic,null);assert.equal(display.spans[0].source,'local_base');assert.equal(display.spans[0].text,blocks[0].text);
  }finally{await new Promise(r=>server.close(r));}assert.equal(closed,true);
});
test('provider failure is terminal and never becomes a demo fallback',async()=>{
  const provider={source:'local_base',fingerprint:'failure-test',status:()=>({state:'error'}),close(){},analyze:async()=>{throw Object.assign(new Error('CUDA unavailable'),{code:'gpu_unavailable'});}};
  const server=createServer({provider,stageDelayMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  try{const session=await(await fetch(base+'/v1/session',{headers:{'X-InfoLens-Client':'test'}})).json();const headers={Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'};const accepted=await(await fetch(base+'/v1/jobs',{method:'POST',headers,body:JSON.stringify({document:{id:'x',revision:'1'},blocks:[{id:'b1',text:'test'}]})})).json();let job;
    for(let n=0;n<100;n++){job=await(await fetch(base+'/v1/jobs/'+accepted.jobId,{headers})).json();if(job.status==='failed')break;await new Promise(r=>setTimeout(r,5));}assert.equal(job.status,'failed');assert.equal(job.source,'local_base');assert.equal(job.error.code,'gpu_unavailable');assert.equal(job.result,undefined);
  }finally{await new Promise(r=>server.close(r));}
});
