// Functional stability runner: source is synthetic, logs contain only metadata.
// It never pauses, unloads, restarts or cancels another client's work.
import {writeFile,readFile,rename} from 'node:fs/promises';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const execute=promisify(execFile),base='http://127.0.0.1:43187';
const duration=Number(process.argv[2]||8)*3600000,output=process.argv[3];
const sampleInterval=Number(process.argv[4]||60)*1000,exerciseInterval=Number(process.argv[5]||600)*1000;
if(![sampleInterval,exerciseInterval].every(n=>Number.isFinite(n)&&n>=5000&&n<=3600000))throw Error('Intervals must be 5–3600 seconds');
if(!Number.isFinite(duration)||duration<=0||duration>24*3600000||!output)throw Error('Use node soak.mjs hours absolute-report-path');
let token,owned,stopping=false;
const started=Date.now(),deadline=started+duration,report={version:'0.8.19',state:'running',startedAt:new Date(started).toISOString(),deadline:new Date(deadline).toISOString(),plannedHours:duration/3600000,samples:0,exercises:0,skippedBusy:0,failures:[],maxRssMiB:0,maxGpuMiB:0,restarts:0,iterations:[]};
async function save(){report.elapsedSeconds=Math.floor((Date.now()-started)/1000);const temp=output+'.tmp';await writeFile(temp,JSON.stringify(report,null,2));await rename(temp,output);}
async function api(route,body,method=body?'POST':'GET',retry=true){if(!token){const s=await fetch(base+'/v1/session',{headers:{'X-InfoLens-Client':'stability-test'},signal:AbortSignal.timeout(5000)});token=(await s.json()).token;}const r=await fetch(base+route,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});if(r.status===401&&retry){token=null;return api(route,body,method,false);}const value=await r.json();if(!r.ok)throw Error(value.error?.code||'http_'+r.status);return value;}
async function gpu(){try{const {stdout}=await execute('nvidia-smi',['--query-gpu=memory.used,utilization.gpu','--format=csv,noheader,nounits'],{windowsHide:true,timeout:5000});const [m,u]=stdout.trim().split(',').map(Number);return {memoryMiB:m,utilization:u};}catch{return null;}}
async function exercise(){const status=await api('/v1/status'),device=await gpu();if(status.paused||status.activeJobs||status.queueLength||!status.modelsReady||device?.utilization>50){report.skippedBusy++;return;}
 const translated=report.exercises%4===3,mode=report.exercises%3===0?'information_density':'hybrid',classify=report.exercises%3===2;
 const blocks=[{id:'soak-'+crypto.randomUUID(),kind:'paragraph',text:translated?'The system processes text locally. Preserve conditions and negation. No content is uploaded.':'系统处理本地文本。关键结论是保持原文范围一致。必须保留否定条件与公式边界。背景信息可以弱化。'}];
 const start=Date.now(),accepted=await api(translated?'/v1/translation-jobs':'/v1/jobs',{document:{id:'stability-synthetic',revision:crypto.randomUUID(),...(translated?{}:{ephemeral:true})},blocks,...(translated?{translation:{targetLanguage:'zh'}}:{analysis:{profile:'paper',mode,classify}})});owned=accepted.jobId;
 try{for(let i=0;i<120;i++){const job=await api('/v1/jobs/'+owned);if(job.status==='completed'){if(translated){if(job.result.analysis.status!=='ready')throw Error('translation_not_ready');}else{const a=job.result.analysis;if(a.blocks[0].text!==blocks[0].text||!a.blocks[0].candidates.length)throw Error('snapshot_mismatch');}report.exercises++;report.iterations.push({at:new Date().toISOString(),kind:translated?'translation':'analysis',mode:translated?null:mode,classify:!translated&&classify,ms:Date.now()-start,cacheHit:job.result.cacheHit});return;}if(['failed','cancelled'].includes(job.status))throw Error(job.error?.code||job.status);if(stopping)break;await new Promise(r=>setTimeout(r,500));}throw Error('own_job_timeout');}
 finally{if(owned){await api('/v1/jobs/'+owned,null,'DELETE').catch(()=>{});owned=null;}}
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;});
let nextExercise=started,instance;
await save();
while(Date.now()<deadline&&!stopping){try{const s=await api('/v1/status'),g=await gpu();if(instance&&instance!==s.instanceId)report.restarts++;instance=s.instanceId;report.samples++;const rss=(s.process?.memory.rss||0)/1048576;if(!report.firstRssMiB)report.firstRssMiB=rss;report.lastRssMiB=rss;report.maxRssMiB=Math.max(report.maxRssMiB,rss);report.maxGpuMiB=Math.max(report.maxGpuMiB,g?.memoryMiB||0);report.lastStatus={modelsReady:s.modelsReady,queueLength:s.queueLength,retainedJobs:s.retainedJobs,cacheEntries:s.cacheEntries,at:new Date().toISOString()};if(Date.now()>=nextExercise){const before=report.exercises;await exercise();nextExercise=Date.now()+(report.exercises===before?sampleInterval:exerciseInterval);}}
 catch(e){report.failures.push({at:new Date().toISOString(),code:String(e.message).slice(0,80)});token=null;}
 await save();try{if((await readFile(output+'.stop','utf8')).trim()==='stop')stopping=true;}catch{}
 if(!stopping)await new Promise(r=>setTimeout(r,Math.min(sampleInterval,Math.max(0,deadline-Date.now()))));
}
report.state=stopping?'stopped':report.failures.length||report.restarts?'completed_with_failures':'completed';report.completedAt=new Date().toISOString();report.passed=!stopping&&report.failures.length===0&&report.restarts===0&&report.exercises>0;await save();
