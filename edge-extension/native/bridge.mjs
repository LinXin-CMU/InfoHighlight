import {readFile} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(await readFile(path.join(root,'bridge-config.json'),'utf8'));
const origin=`chrome-extension://${config.extensionId}/`;
if((process.argv[2]||'').replace(/\/$/,'')!==origin.replace(/\/$/,'')){process.stderr.write('Unpaired native caller.\n');process.exit(1);}
const base=`http://127.0.0.1:${config.port}`;let token=null,buffer=Buffer.alloc(0),chain=Promise.resolve();const owned=new Set();
async function api(url,options={},retry=true){
  if(!token){const response=await fetch(base+'/v1/session',{headers:{'X-InfoLens-Client':'edge-native'},signal:AbortSignal.timeout(5000)});const session=await response.json();if(!response.ok||!['local_base','local_models'].includes(session.source))throw new Error('请先启动真实本地模型服务。');token=session.token;}
  const response=await fetch(base+url,{...options,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(10000)});const data=await response.json();
  if(response.status===401){token=null;if(retry)return api(url,options,false);throw new Error('本机服务已重启，请重新分析。');}if(!response.ok)throw Object.assign(new Error(data.error?.message||'本机请求失败'),{status:response.status});return data;
}
function jobId(message){if(!/^[a-f\d]{24}$/.test(message.jobId||'')||!owned.has(message.jobId))throw new Error('任务不属于此桥接会话。');return message.jobId;}
async function handle(message){
  if(!Number.isSafeInteger(message.id)||message.id<0)throw new Error('请求标识无效');
  if(message.action==='health')return api('/v1/health');
  if(message.action==='reading')return api('/v1/reading');
  if(message.action==='setReading')return api('/v1/reading/edge',{method:'PUT',body:JSON.stringify({revision:message.revision,inherit:message.inherit,autoAnalyze:message.autoAnalyze,settings:message.settings})});
  if(message.action==='appearance')return api('/v1/appearance');
  if(message.action==='setAppearance')return api('/v1/appearance/edge',{method:'PUT',body:JSON.stringify({revision:message.revision,inherit:false,settings:message.settings})});
  if(message.action==='submit'){const job=await api('/v1/jobs',{method:'POST',body:JSON.stringify({document:message.document,blocks:message.blocks,analysis:message.analysis})});owned.add(job.jobId);return {jobId:job.jobId,revision:job.revision,contentHash:job.contentHash,status:job.status};}
  if(message.action==='job'){const job=await api(`/v1/jobs/${jobId(message)}`);const {result,partial,...status}=job;return {...status,...(partial?{partialSequence:partial.sequence}:{})};}
  if(message.action==='cancel')return api(`/v1/jobs/${jobId(message)}`,{method:'DELETE'}).then(({result,partial,...status})=>status);
  if(['result','partial'].includes(message.action)){
    const job=await api(`/v1/jobs/${jobId(message)}`);const payload=message.action==='partial'?(job.partial||job.result):job.result;
    if(!payload||message.action==='result'&&job.status!=='completed')throw new Error('任务尚未完成');
    const cursor=message.cursor;if(!Number.isInteger(cursor)||cursor<0)throw new Error('分页位置无效');
    const analysis=payload.analysis;if(!['local_base','local_models'].includes(analysis.source))throw new Error('结果不是本地模型概率');
    const rows=analysis.blocks.flatMap(block=>block.candidates.map(c=>({blockId:block.id,start:c.start,end:c.end,surprisalBits:c.surprisalBits,surprisalRaw:c.surprisalRaw,surprisalNormalized:c.surprisalNormalized,semantic:c.semantic,semanticRaw:c.semanticRaw,semanticNormalized:c.semanticNormalized,semanticNormalization:c.semanticNormalization,category:c.category,semanticSource:c.semanticSource,semanticDisplay:c.semanticDisplay,densityDisplay:c.densityDisplay,tokenSurprisalNormalized:c.tokenSurprisalNormalized,sourceTokenRange:c.sourceTokenRange})));
    return {revision:job.revision,contentHash:job.contentHash,sequence:payload.sequence||null,completed:job.status==='completed',source:analysis.source,model:analysis.model,models:analysis.models,semantic:analysis.semantic,gpu:analysis.gpu,tokenCount:analysis.tokenCount,densityDisplay:analysis.densityDisplay,spans:rows.slice(cursor,cursor+256),nextCursor:cursor+256<rows.length?cursor+256:null};
  }
  throw new Error('操作不受支持');
}
function reply(value){const payload=Buffer.from(JSON.stringify(value),'utf8');if(payload.length>1024*1024)throw new Error('Native reply exceeds limit');const header=Buffer.alloc(4);header.writeUInt32LE(payload.length);process.stdout.write(Buffer.concat([header,payload]));}
process.stdin.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(buffer.length>=4){const length=buffer.readUInt32LE(0);if(length>1024*1024||length===0){process.exitCode=1;process.stdin.destroy();return;}if(buffer.length<4+length)break;const raw=buffer.subarray(4,4+length);buffer=buffer.subarray(4+length);chain=chain.then(async()=>{let message;try{message=JSON.parse(raw.toString('utf8'));reply({id:message.id,ok:true,data:await handle(message)});}catch(error){reply({id:message?.id||0,ok:false,error:error.message,status:error.status});}});
  }
});
process.stdin.on('end',()=>{chain.finally(async()=>{for(const id of owned)await api(`/v1/jobs/${id}`,{method:'DELETE'}).catch(()=>{});});});
