import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLocalProvider} from '../local-provider.mjs';
import {MICA_MODEL} from '../mica-provider.mjs';

async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'infolens-residency-'));
  await writeFile(path.join(root,'model-manifest.json'),JSON.stringify({repo:'fixture',revision:'fixture'}));
  const config=path.join(root,'config.json');
  await writeFile(config,JSON.stringify({python:'fixture',modelPath:root,semanticModelPath:root,translationModelPath:root,mica:{}}));
  const commands=[];let spawns=0,micaLoads=0,micaCloses=0,micaLoaded=false,slow;
  const model={repo:'fixture'};
  const spawnWorker=()=>{
    spawns++;const child=new EventEmitter();child.exitCode=null;child.signalCode=null;
    child.stdout=new PassThrough();child.stderr=new PassThrough();
    const emit=value=>child.stdout.write(JSON.stringify(value)+'\n');
    child.stdin=new Writable({write(bytes,encoding,done){
      const request=JSON.parse(bytes.toString());commands.push(request);
      if(request.action==='cancel'){if(slow===request.id){slow=null;queueMicrotask(()=>emit({id:request.id,error:{code:'cancelled',message:'Cancelled'}}));}}
      else if(request.blocks?.[0]?.text==='slow'){slow=request.id;}
      else queueMicrotask(()=>emit({id:request.id,result:{model,semanticModelLoaded:false,translationModelLoaded:true,translationModel:{dedicated:true},source:'local_base',status:'ready',blocks:request.blocks?.map(b=>({...b,candidates:[{start:0,end:b.text.length,text:b.text,surprisalNormalized:.2,semantic:null}]}))||[]}}));
      done();
    }});
    child.kill=()=>{child.exitCode=0;child.emit('exit');child.stdout.end();};
    queueMicrotask(()=>emit({type:'ready',model}));return child;
  };
  const mica={status:()=>({loaded:micaLoaded,model:MICA_MODEL}),warmup:async()=>{micaLoads++;micaLoaded=true;},close:async()=>{micaCloses++;micaLoaded=false;},score:async(b,s)=>({rows:s.map(t=>({id:t.id,importance:90,type:'general'})),status:'ready',model:MICA_MODEL})};
  const provider=await createLocalProvider(config,{spawnWorker,createMica:()=>mica});
  return {provider,commands,counts:()=>({spawns,micaLoads,micaCloses}),cleanup:async()=>{await provider.close();await rm(root,{recursive:true,force:true});}};
}
const blocks=[{id:'p1',text:'Important conditions remain visible.'}];

test('startup preloads all selected models once; analysis and translation retain both workers',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.provider.analyze(blocks,'general'),error=>error.code==='models_not_ready');
    assert.equal(f.counts().spawns,0,'first call must not load weights');
    await Promise.all([f.provider.warmup(),f.provider.warmup()]);
    assert.equal(f.provider.status().modelsReady,true);assert.equal(f.provider.status().translationModelLoaded,true);
    await f.provider.analyze(blocks,'general');await f.provider.translate(blocks,'zh');await f.provider.analyze(blocks,'general');
    assert.deepEqual(f.counts(),{spawns:1,micaLoads:1,micaCloses:0});
    assert.equal(f.commands.filter(c=>c.action==='warmup').length,1);
    assert.ok(f.commands.every(c=>!c.releaseTranslation));
    assert.equal(f.provider.status().semanticModelLoaded,true);assert.equal(f.provider.status().translationModelLoaded,true);
  }finally{await f.cleanup();}
});

test('cancellation stops a request without discarding resident weights; explicit unload stays unloaded',async()=>{
  const f=await fixture();try{
    await f.provider.warmup();const controller=new AbortController();
    const cancelled=f.provider.analyze([{id:'p1',text:'slow'}],'general',{signal:controller.signal});
    const rejected=assert.rejects(cancelled,/Cancelled/);
    while(!f.commands.some(c=>c.blocks?.[0]?.text==='slow'))await new Promise(r=>setTimeout(r,1));
    controller.abort();await rejected;
    assert.equal(f.provider.status().modelsReady,true);await f.provider.analyze(blocks,'general');
    assert.equal(f.counts().spawns,1);assert.equal(f.counts().micaCloses,0);
    await f.provider.unload();assert.equal(f.provider.status().modelsReady,false);
    await assert.rejects(f.provider.translate(blocks,'zh'),error=>error.code==='models_not_ready');
    assert.equal(f.counts().spawns,1,'manual unload cannot be reversed by a reading request');
    await f.provider.warmup();assert.equal(f.counts().spawns,2);assert.equal(f.provider.status().modelsReady,true);
  }finally{await f.cleanup();}
});
