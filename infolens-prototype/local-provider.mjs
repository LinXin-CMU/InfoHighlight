import {spawn,execFile} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {semanticTargets,projectSemantic,SEMANTIC_POLICY,TRANSLATION_POLICY} from './semantic.mjs';
import {SEMANTIC_NORMALIZATION_POLICY} from './semantic-normalization.mjs';
import {createMicaWorker,refineWithMica,MICA_POLICY,MICA_MODEL} from './mica-provider.mjs';
import {projectWordDisplay,WORD_DISPLAY_POLICY} from './word-display.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
export async function createLocalProvider(configFile=path.join(root,'local-config.json'),{spawnWorker=spawn,createMica=createMicaWorker}={}){
  const config=JSON.parse(await readFile(configFile,'utf8'));
  const manifest=JSON.parse(await readFile(path.join(config.modelPath,'model-manifest.json'),'utf8'));
  const semanticManifest=config.semanticModelPath?JSON.parse(await readFile(path.join(config.semanticModelPath,'model-manifest.json'),'utf8')):null;
  const translationManifest=config.translationModelPath?JSON.parse(await readFile(path.join(config.translationModelPath,'model-manifest.json'),'utf8')):null;
  const translationPolicy=translationManifest?'hy-mt-math-paragraph-v3/nf4/greedy/2048/1024/formatted-retry/eos-math-required':TRANSLATION_POLICY;
  const mica=config.mica?createMica(configFile,config.mica):null;
  const hasSemantic=Boolean(mica||semanticManifest),semanticPolicy=(mica?MICA_POLICY:semanticManifest?SEMANTIC_POLICY:'none')+'/'+SEMANTIC_NORMALIZATION_POLICY;
  let micaConnected=false;
  let worker=null,ready=null,nextId=0,pending=new Map(),state='not_loaded',last=null,stopping=null;
  let warming=null,warmEpoch=0;
  let residency={policy:'startup_resident',state:'not_loaded',startedAt:null,completedAt:null,error:null};
  function stop(reason='Worker stopped'){
    if(stopping)return stopping;
    const child=worker;worker=null;ready=null;state='not_loaded';last=null;
    for(const p of pending.values())p.reject(new Error(reason));pending.clear();
    if(!child||child.exitCode!==null||child.signalCode!==null)return Promise.resolve();
    state='unloading';
    stopping=new Promise(resolve=>{
      child.stdin.end();
      const finish=()=>{stopping=null;state='not_loaded';resolve();};
      if(process.platform==='win32'&&child.pid)execFile(path.join(process.env.SystemRoot||'C:\\Windows','System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true},finish);
      else{child.once('exit',finish);child.kill();}
    });return stopping;
  }
  async function ensure(){
    if(stopping)await stopping;
    if(ready)return ready;state='loading';
    ready=new Promise((resolve,reject)=>{
      const child=spawnWorker(config.python,[path.join(root,'model-worker.py'),config.modelPath,mica?'':config.semanticModelPath||'',config.translationModelPath||''],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',PYTHONUTF8:'1'}});worker=child;
      const timer=setTimeout(()=>{reject(new Error('Model startup timed out'));stop();},120000);
      child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
      createInterface({input:child.stdout}).on('line',line=>{
        if(child!==worker)return;
        let msg;try{msg=JSON.parse(line);}catch{return;}
        if(msg.type==='ready'){clearTimeout(timer);state='ready';last={model:msg.model};resolve(msg.model);return;}
        if(msg.type==='fatal'){clearTimeout(timer);state='error';reject(new Error(msg.error));stop('Model startup failed');return;}
        const p=pending.get(msg.id);if(!p)return;
        if(msg.type==='progress'){p.onProgress?.(msg);return;}
        if(msg.type==='partial'){p.onPartial?.(msg.result);return;}pending.delete(msg.id);
        if(msg.error)p.reject(Object.assign(new Error(msg.error.message),{code:msg.error.code}));else{last={...last,...msg.result};p.resolve(msg.result);}
      });
      child.on('error',error=>{clearTimeout(timer);reject(error);if(worker===child)stop(error.message);});
      child.on('exit',()=>{clearTimeout(timer);reject(new Error('Model worker exited'));if(worker===child)stop('Model worker exited');});
    });return ready;
  }
  const close=async reason=>{warmEpoch++;warming=null;residency={...residency,state:'not_loaded',error:null};micaConnected=false;await Promise.all([stop(reason),mica?.close(reason)]);};
  function request(action,body={}){
    const id=++nextId;
    const result=new Promise((resolve,reject)=>{pending.set(id,{resolve,reject,...body.callbacks});worker.stdin.write(JSON.stringify({id,action,...body.payload})+'\n',error=>{if(error){pending.delete(id);reject(error);}});});
    return {id,result};
  }
  function warmup(){
    if(warming)return warming;
    if(residency.state==='ready'&&state==='ready'&&(!mica||mica.status().loaded))return Promise.resolve();
    const epoch=++warmEpoch;
    residency={policy:'startup_resident',state:'loading',startedAt:Date.now(),completedAt:null,error:null};
    const loading=(async()=>{
      await ensure();
      if(epoch!==warmEpoch)throw new Error('Warmup cancelled');
      await request('warmup',{payload:{semantic:hasSemantic&&!mica}}).result;
      if(epoch!==warmEpoch)throw new Error('Warmup cancelled');
      await mica?.warmup();
      if(epoch!==warmEpoch)throw new Error('Warmup cancelled');
      residency={...residency,state:'ready',completedAt:Date.now(),workerPids:{pytorch:worker?.pid||null,mica:mica?.status().pid||null}};
    })().catch(error=>{if(epoch===warmEpoch)residency={...residency,state:'error',error:{code:error.code||'model_preload_failed',message:'模型预加载失败，请检查显存和本机配置，点击预加载模型重试。'}};throw error;}).finally(()=>{if(warming===loading)warming=null;});
    warming=loading;return loading;
  }
  async function resident(signal,onProgress){
    if(warming){onProgress?.({stage:'model_loading'});await warming;}
    if(signal?.aborted)throw new Error('Cancelled');
    if(residency.state!=='ready'||state!=='ready'||mica&&!mica.status().loaded)throw Object.assign(new Error('模型尚未就绪，请在托盘或工作台预加载模型。'),{code:'models_not_ready'});
  }
  return {source:hasSemantic?'local_models':'local_base',semanticConfigured:hasSemantic,translationConfigured:Boolean(translationManifest||semanticManifest),policies:{displayPolicyVersion:WORD_DISPLAY_POLICY,contextPolicyVersion:'lf-blocks-double-newline-eos-prefix-sliding-v1',promptPolicyVersion:semanticPolicy,translationPolicyVersion:translationPolicy,normalizationVersion:'lf-v1'},fingerprint:JSON.stringify([manifest.repo,manifest.revision,WORD_DISPLAY_POLICY,'bf16',1024,256,'lf-blocks-double-newline-eos-prefix-sliding-v1',mica?MICA_MODEL:semanticManifest,semanticPolicy,mica?{contextTokens:config.mica.contextTokens??4096,paragraphTokens:config.mica.paragraphTokens??768,prefixCache:config.mica.prefixCache===true}:null,translationManifest?.repo,translationManifest?.revision,translationPolicy]),
    status:()=>({state:residency.state==='loading'?'loading':residency.state==='error'?'error':state,modelConnected:state==='ready',modelsReady:residency.state==='ready'&&state==='ready'&&(!mica||mica.status().loaded),residency:{...residency},model:last?.model||{repo:manifest.repo,revision:manifest.revision},gpu:last?.gpu?{...last.gpu,scope:'pytorch_worker_only',...(mica?{excludes:['mica_llama_cpp']}:{} )}:null,semanticConfigured:hasSemantic,semanticModelLoaded:mica?mica.status().loaded:last?.semanticModelLoaded||false,semanticConnected:mica?mica.status().loaded&&micaConnected:last?.semanticReport?.rows?.length>0,semanticModel:mica?mica.status().model||{...MICA_MODEL,paragraphTokens:config.mica.paragraphTokens??768}:last?.semanticReport?.model||semanticManifest&&{repo:semanticManifest.repo,revision:semanticManifest.revision},translationModelLoaded:last?.translationModelLoaded||false,translationModel:last?.translationModel||translationManifest&&{repo:translationManifest.repo,revision:translationManifest.revision,dedicated:true,quantization:'nf4-double'}}),
    async analyze(blocks,profile,{signal,onProgress,onPartial,mode='hybrid',classify=false}={}){
      const useSemantic=hasSemantic&&(mode!=='information_density'||classify);
      let id;if(signal?.aborted)throw new Error('Cancelled');const onAbort=()=>{if(id&&worker)worker.stdin.write(JSON.stringify({id,action:'cancel'})+'\n',()=>{});};signal?.addEventListener('abort',onAbort,{once:true});
      try{
        await resident(signal,onProgress);
        const sentences=semanticTargets(blocks);
        const context=[...blocks.filter(b=>b.kind==='heading').slice(0,4).map(b=>b.text.slice(0,128)),blocks[0]?.text.slice(0,256)||''];
        const publish=rawBase=>{
          const base=projectWordDisplay(rawBase);
          let partial=useSemantic?projectSemantic(base,sentences,base.semanticReport||{rows:[],status:'pending',...(mica?{source:'local_mica',model:MICA_MODEL,policy:MICA_POLICY}:{})}):base;
          partial={...partial,incremental:true,blocks:partial.blocks.map(b=>{
            const ready=sentences.filter(s=>s.blockId===b.id&&s.end<=(b.scoredThrough??b.text.length));
            return {...b,candidates:b.candidates.filter(c=>ready.some(s=>c.start>=s.start&&c.end<=s.end)),completedSentences:ready.length};
          })};
          onPartial?.(partial);
        };
        const submitted=request('score',{payload:{blocks,profile,sentences,context,semantic:useSemantic&&!mica,incremental:true},callbacks:{onProgress,onPartial:publish}});id=submitted.id;const result=projectWordDisplay(await submitted.result);
        if(signal?.aborted)throw new Error('Cancelled');
        if(!useSemantic)return result;
        if(mica){const refined=await refineWithMica(mica,result,blocks,sentences,profile,{signal,onProgress,onPartial,classify});micaConnected=refined.semanticConnected;return refined;}
        return projectSemantic(result,sentences,result.semanticReport||{rows:[],status:'unavailable',errors:['missing_semantic_report']});
      }finally{signal?.removeEventListener('abort',onAbort);}
    },
    async translate(blocks,targetLanguage,{signal,onProgress}={}){
      if(!translationManifest&&!semanticManifest)throw new Error('Local translation model is not configured');
      let id;if(signal?.aborted)throw new Error('Cancelled');const onAbort=()=>{if(id&&worker)worker.stdin.write(JSON.stringify({id,action:'cancel'})+'\n',()=>{});};signal?.addEventListener('abort',onAbort,{once:true});
      try{
        await resident(signal,onProgress);
        const submitted=request('translate',{payload:{blocks,targetLanguage},callbacks:{onProgress}});id=submitted.id;const result=await submitted.result;
        if(signal?.aborted)throw new Error('Cancelled');return result;
      }finally{signal?.removeEventListener('abort',onAbort);}
    },close:()=>close(),unload:()=>close('Models unloaded'),warmup};
}
