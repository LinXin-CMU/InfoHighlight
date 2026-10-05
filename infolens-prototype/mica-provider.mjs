import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {projectSemantic} from './semantic.mjs';

export const MICA_POLICY='mica-sentence-paragraph-v3/categories-choice-v1/identity-neutral/5-level-expectation/native-score/isolated-v1';
export const MICA_MODEL=Object.freeze({repo:'sky7350/Mica-v0.1-4B',revision:'ca36594cc2067c7252704f9f304cc10ef11c7c5c',quantization:'Q5_K_M',sdkRevision:'302785ee3143b2a156c8b09a5b9236d88863857d',decoding:'native_score_logits_no_generation',contextPolicy:'natural_paragraph_sentence_chunks',granularity:'sentence',calibratedForReadingImportance:false});

// Base output is visible before Mica scoring; a failed refinement preserves both
// density and already completed sentence scores. Cancellation never publishes.
export async function refineWithMica(mica,base,blocks,targets,profile,{signal,onProgress,onPartial,classify=false}={}){
  const started=performance.now();
  let report={rows:[],source:'local_mica',policy:MICA_POLICY,model:MICA_MODEL,status:'pending'};
  const project=()=>({...projectSemantic(base,targets,report),semanticModelLoaded:mica.status().loaded,gpu:base.gpu?{...base.gpu,scope:'pytorch_worker_only',excludes:['mica_llama_cpp']}:null});
  const publish=()=>{if(!signal?.aborted)onPartial?.(project());};
  if(signal?.aborted)throw new Error('Cancelled');publish();
  try{report=await mica.score(blocks,targets,profile,{signal,onProgress,classify,onPartial:value=>{report={...value,source:'local_mica',policy:MICA_POLICY};publish();}});}
  catch(error){if(signal?.aborted)throw error;report={...report,status:'unavailable',errors:['mica_unavailable'],message:'Mica 评分未完成；已完成的句子与信息密度保留。'};}
  if(signal?.aborted)throw new Error('Cancelled');
  const semanticMs=Math.round(performance.now()-started),processingMs=(base.processingMs||0)+semanticMs;
  return {...project(),processingMs,timings:{...base.timings,semanticMs,micaScoringMs:report.processingMs??null,totalScoringMs:processingMs}};
}
export function createMicaWorker(configFile,config){
  let worker=null,ready=null,stopping=null,model=null,nextId=0;
  const pending=new Map();
  async function stop(reason='Mica stopped'){
    if(stopping)return stopping;
    const child=worker;worker=null;ready=null;model=null;
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(reason));}pending.clear();
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    stopping=new Promise(resolve=>{child.once('exit',resolve);child.kill();});
    try{await stopping;}finally{stopping=null;}
  }
  async function ensure(){
    if(stopping)await stopping;if(ready)return ready;
    const child=spawn(config.python,[fileURLToPath(new URL('./mica_worker.py',import.meta.url)),configFile],{
      windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',PYTHONUTF8:'1',TOKENIZERS_PARALLELISM:'false'}
    });worker=child;
    ready=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{reject(new Error('Mica 加载超时，请检查可用显存。'));stop().catch(()=>{});},60000);
      child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
      createInterface({input:child.stdout}).on('line',line=>{
        if(child!==worker)return;let message;try{message=JSON.parse(line);}catch{return;}
        if(message.type==='ready'){clearTimeout(timer);model=message.model;resolve(model);return;}
        if(message.type==='fatal'){clearTimeout(timer);reject(new Error(message.error));stop().catch(()=>{});return;}
        const p=pending.get(message.id);if(!p)return;
        if(message.type==='progress'){p.onProgress?.(message);return;}
        if(message.type==='partial'){p.onPartial?.(message.result);return;}
        pending.delete(message.id);clearTimeout(p.timer);
        if(message.error)p.reject(Object.assign(new Error(message.error.message),{code:message.error.code}));else p.resolve(message.result);
      });
      child.on('error',()=>{clearTimeout(timer);reject(new Error('Mica 运行环境不可用，请检查本机配置。'));if(worker===child)stop().catch(()=>{});});
      child.on('exit',()=>{clearTimeout(timer);reject(new Error('Mica 进程已退出。'));if(worker===child)stop().catch(()=>{});});
    });return ready;
  }
  return {
    status:()=>({loaded:Boolean(model),model,pid:worker?.pid||null}),close:stop,warmup:ensure,
    async score(blocks,sentences,profile,{signal,onProgress,onPartial,classify=false}={}){
      if(signal?.aborted)throw new Error('Cancelled');
      let id;
      const abort=()=>{if(id&&worker)worker.stdin.write(JSON.stringify({action:'cancel',id})+'\n',()=>{});};signal?.addEventListener('abort',abort,{once:true});
      try{
        onProgress?.({stage:model?'semantic':'semantic_loading'});await ensure();if(signal?.aborted)throw new Error('Cancelled');
        id=++nextId;
        return await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{stop('Mica 评分超时。').catch(()=>{});},240000);
          pending.set(id,{resolve,reject,timer,onProgress,onPartial});
          worker.stdin.write(JSON.stringify({id,blocks,sentences,profile,classify})+'\n',error=>{if(error){pending.delete(id);clearTimeout(timer);reject(new Error('Mica 进程写入失败。'));}});
        });
      }finally{signal?.removeEventListener('abort',abort);}
    }
  };
}
