import {readingSettings,selectReadingCandidates} from './reading-policy.mjs';
import {signalScore} from './signals.mjs';
import {hueRgb} from './appearance.mjs';
import {invokePage,injectionFrame,pageReply,captureReply,paintReply,resultPage} from './page-rpc.mjs';
const HOST='com.infolens.local_reader';
let port=null,nextId=0;const epochs=new Map(),tabPrefs=new Map();const replies=new Map(),tabs=new Map();
const mutedTabs=new Set();let centralReading=null;
let sharedAppearance=null,appearanceFlight=null,appearanceWrites=Promise.resolve();
const restarts=new Map(),restartHistory=new Map();
function cancelRestart(tabId){clearTimeout(restarts.get(tabId));restarts.delete(tabId);}
function launch(tabId,manual=false){
  cancelRestart(tabId);if(manual)restartHistory.delete(tabId);
  const epoch=(epochs.get(tabId)||0)+1;epochs.set(tabId,epoch);
  run(tabId,epoch).catch(error=>{const current=tabs.get(tabId);if(owns(tabId,current)&&current.epoch===epoch)failure(tabId,current,error);});
}
function restart(tabId,state){
  if(!owns(tabId,state))return;
  const now=Date.now(),recent=(restartHistory.get(tabId)||[]).filter(t=>now-t<30000);
  state.cancelled=true;state.active=false;if(state.jobId)native('cancel',{jobId:state.jobId}).catch(()=>{});
  if(recent.length>=3){state.status='正文持续变化，已暂停自动重试；页面稳定后点击分析。';return;}
  recent.push(now);restartHistory.set(tabId,recent);state.status='正文已变化 · 等待页面稳定后自动分析…';
  cancelRestart(tabId);restarts.set(tabId,setTimeout(()=>{restarts.delete(tabId);if(tabs.get(tabId)===state&&epochs.get(tabId)===state.epoch)launch(tabId);},600));
}
function sharedPrefs(data){const p=data?.clients?.edge?.effective;if(!Number.isInteger(data?.revision)||!p||!['background','foreground','underline','fade'].includes(p.style)||!Number.isFinite(p.hue)||!Number.isFinite(p.intensity))throw new Error('本机外观设置无效，请检查 InfoLens 服务。');return {style:p.style,hue:p.hue,intensity:p.intensity*100,rgb:hueRgb(p.hue).join(' ')};}
const owns=(tabId,state)=>state&&!state.cancelled&&tabs.get(tabId)===state&&epochs.get(tabId)===state.epoch;
function failure(tabId,state,error){if(owns(tabId,state)){if(error?.code==='document_changed'){restart(tabId,state);return;}state.active=false;state.displayError=error?.message||'网页处理失败，请重新分析。';state.status=state.displayError;if(state.jobId)native('cancel',{jobId:state.jobId}).catch(()=>{});}}
async function acceptAppearance(data){
  const p=sharedPrefs(data);
  if(sharedAppearance&&data.revision<sharedAppearance.revision)return;
  const changed=JSON.stringify(data.clients.edge.effective)!==JSON.stringify(sharedAppearance?.clients.edge.effective);sharedAppearance=data;if(!changed)return;
  for(const [tabId,prefs] of tabPrefs)tabPrefs.set(tabId,{...prefs,...p});
  await Promise.all([...tabs].map(async([tabId,state])=>{state.prefs={...state.prefs,...p};if(state.result&&!state.cancelled)await paint(tabId,state).catch(error=>failure(tabId,state,error));}));
}
async function syncAppearance(){if(appearanceFlight)return appearanceFlight;const task=native('appearance').then(async data=>{await acceptAppearance(data);return data;});appearanceFlight=task;try{return await task;}finally{if(appearanceFlight===task)appearanceFlight=null;}}
function native(action,payload={}){
  if(!port){const connection=chrome.runtime.connectNative(HOST);port=connection;
    connection.onMessage.addListener(message=>{if(port!==connection||!message||!Number.isInteger(message.id))return;const p=replies.get(message.id);if(!p)return;replies.delete(message.id);clearTimeout(p.timer);message.ok===true?p.resolve(message.data):p.reject(Object.assign(new Error(typeof message.error==='string'?message.error:'本机服务返回无效消息。'),{status:message.status}));});
    connection.onDisconnect.addListener(()=>{if(port!==connection)return;const error=chrome.runtime.lastError?.message||'本机桥接断开';port=null;for(const p of replies.values()){clearTimeout(p.timer);p.reject(new Error(error));}replies.clear();});
  }
  const id=++nextId;return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{replies.delete(id);reject(new Error('本机服务响应超时，请检查 InfoLens 是否运行。'));},15000);
    replies.set(id,{resolve,reject,timer});try{port.postMessage({id,action,...payload});}catch(error){clearTimeout(timer);replies.delete(id);reject(error);}
  });
}
const target=(tabId,state)=>({tabId,documentIds:[state.documentId]});
async function pageCall(tabId,state,operation,payload,prefs){
  const rows=await chrome.scripting.executeScript({target:target(tabId,state),func:invokePage,args:[operation,payload??null,prefs??null]});
  return pageReply(rows,state.documentId);
}
async function capture(tabId){
  const {documentId}=injectionFrame(await chrome.scripting.executeScript({target:{tabId},files:['page.js']}));
  const snapshot=captureReply(await pageCall(tabId,{documentId},'capture'));
  return {...snapshot,documentId};
}
async function clear(tabId,state=tabs.get(tabId)){
  await state?.painting?.catch(()=>{});if(!state?.documentId)return;
  for(const css of state.styles||[])await chrome.scripting.removeCSS({target:target(tabId,state),css}).then(()=>state.styles.delete(css)).catch(()=>{});
  await pageCall(tabId,state,'clear',{revision:state.revision}).catch(()=>{});state.css=null;
}
function paint(tabId,state){
  state.painting=(state.painting||Promise.resolve()).catch(()=>{}).then(async()=>{
    if(!owns(tabId,state))return;
    try{
      const prefs={...state.prefs},payload={...state.result,spans:selectReadingCandidates(state.result.spans.map(c=>({...c,finalScore:signalScore(c,prefs).score})),state.blocks||[],prefs,c=>c.finalScore)};
      const drawn=paintReply(await pageCall(tabId,state,'paint',payload,prefs));
      if(!owns(tabId,state))return;
      const css=drawn.cssRules.join('\n');
      if(state.css!==css){
        if(css){await chrome.scripting.insertCSS({target:target(tabId,state),css});state.styles.add(css);}
        if(!owns(tabId,state)){
          const successor=tabs.get(tabId);
          if(successor&&!successor.cancelled&&successor.documentId===state.documentId&&successor.styles===state.styles){successor.css=css;return;}
          if(css)await chrome.scripting.removeCSS({target:target(tabId,state),css}).catch(()=>{});
          state.styles.delete(css);
          await pageCall(tabId,state,'clear',{revision:state.revision}).catch(()=>{});return;
        }
        for(const previous of state.styles)if(previous!==css){await chrome.scripting.removeCSS({target:target(tabId,state),css:previous});state.styles.delete(previous);}
        state.css=css;
      }
      if(state.displayError){state.status=state.lastStatus||'高亮已更新';state.displayError=null;}
      return drawn;
    }catch(error){
      if(error?.code!=='document_changed')await pageCall(tabId,state,'clear',{revision:state.revision}).catch(()=>{});
      throw error;
    }
  });return state.painting;
}
async function run(tabId,epoch){
  const previous=tabs.get(tabId);if(previous)previous.cancelled=true;
  const state={epoch,prefs:{mode:'hybrid',fusion:'semantic_floor',alpha:.4,...(previous?.prefs||tabPrefs.get(tabId))},status:'正在连接本机服务…',active:true,startedAt:Date.now(),cancelled:false,styles:previous?.styles||new Set(),css:previous?.css,documentId:previous?.documentId,revision:previous?.revision};tabs.set(tabId,state);
  await previous?.painting?.catch(()=>{});if(previous?.jobId)native('cancel',{jobId:previous.jobId}).catch(()=>{});
  if(!owns(tabId,state))return;
  await syncAppearance();await syncReading().catch(()=>{});if(!owns(tabId,state))return;
  state.status='正在读取网页正文…';
  const snapshot=await capture(tabId);if(!owns(tabId,state))return;
  Object.assign(state,snapshot,{prefs:{...state.prefs,...sharedPrefs(sharedAppearance),...(centralReading?.effective||{}),mode:state.prefs.mode},status:'分析中'});
  if(snapshot.retainedPaint){
    const css=paintReply(snapshot.retainedPaint).cssRules.join('\n');
    if(css!==state.css){
      if(css){await chrome.scripting.insertCSS({target:target(tabId,state),css});state.styles.add(css);}
      if(!owns(tabId,state))return;
      for(const old of state.styles)if(old!==css){await chrome.scripting.removeCSS({target:target(tabId,state),css:old});state.styles.delete(old);}
      state.css=css;
    }
  }
  const browserTab=await chrome.tabs.get(tabId);if(!owns(tabId,state))return;
  state.analysisMode=state.prefs.mode;
  const accepted=await native('submit',{document:{id:`edge-${tabId}`,revision:snapshot.revision,offsetEncoding:'utf16',normalizationVersion:'lf-v1',ephemeral:browserTab.incognito===true},blocks:snapshot.blocks,analysis:{profile:'general',mode:state.analysisMode,classify:state.prefs.classify===true}});if(!accepted||typeof accepted.jobId!=='string'||!accepted.jobId||typeof accepted.contentHash!=='string'||!accepted.contentHash)throw new Error('本机任务返回无效，请检查服务后重试。');state.jobId=accepted.jobId;
  if(state.cancelled||epochs.get(tabId)!==epoch){await native('cancel',{jobId:state.jobId});return;}
  let done;
  for(let count=0;count<600;count++){if(!owns(tabId,state))return;const job=await native('job',{jobId:state.jobId});if(!job||!['queued','running','completed','failed','cancelled'].includes(job.status))throw new Error('本机任务状态无效，请重新分析。');if(job.status==='completed'){done=job;break;}if(['failed','cancelled'].includes(job.status))throw new Error(job.error?.message||'任务取消');
    const stage=job.status==='queued'?'排队中':({model_loading:'首次加载本地模型',density:'信息密度分析中',semantic_loading:'加载可选语义模型',semantic:'语义分析中',fusion:'整理结果'})[job.stage]||'分析中';
    const progress=Number.isFinite(job.details?.done)&&Number.isFinite(job.details?.total)?` ${job.details.done}/${job.details.total}`:'';
    state.lastStatus=state.status=stage+progress+(state.result?` · 已显示 ${state.result.spans.length} 片段`:'');
    if(job.partialSequence>(state.partialSequence||0)){
      const spans=[];let cursor=0,version=null,metadata,consistent=true;
      do{const page=resultPage(await native('partial',{jobId:state.jobId,cursor}),snapshot,accepted.contentHash,cursor,true);if(cursor&&page.sequence!==version){consistent=false;break;}version=page.sequence;metadata=page;spans.push(...page.spans);cursor=page.nextCursor;}while(cursor!==null&&owns(tabId,state));
      if(consistent&&owns(tabId,state)){state.partialSequence=version;state.result={revision:metadata.revision,spans};await paint(tabId,state);if(owns(tabId,state))state.lastStatus=state.status='逐句更新 · 已显示 '+spans.length+' 片段';}
      if(consistent&&metadata.completed){done={status:'completed'};break;}
    }
    await new Promise(resolve=>setTimeout(resolve,400));}
  if(!done)throw new Error('任务超时，请重试。');const spans=[];let cursor=0,metadata;
  do{const page=resultPage(await native('result',{jobId:state.jobId,cursor}),snapshot,accepted.contentHash,cursor);spans.push(...page.spans);metadata=page;cursor=page.nextCursor;}while(cursor!==null&&owns(tabId,state));
  if(!owns(tabId,state))return;
  state.result={revision:metadata.revision,spans,complete:true};state.semantic=metadata.semantic;state.source=metadata.source;await paint(tabId,state);if(!owns(tabId,state))return;
  state.active=false;const coverage=metadata.semantic?.coverage;state.lastStatus=state.status=`已完成 · ${state.analysisMode==='information_density'?'快速模式 · ':''}${((Date.now()-state.startedAt)/1000).toFixed(1)} 秒${coverage&&Number.isInteger(coverage.evaluatedSentences)&&Number.isInteger(coverage.totalSentences)?' · 语义 '+coverage.evaluatedSentences+'/'+coverage.totalSentences+' 句':''} · ${metadata.tokenCount??'—'} tokens`;
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.action==='pageChanged'){
    const tabId=sender.tab?.id,state=tabs.get(tabId);
    if(sender.id!==chrome.runtime.id||sender.frameId!==0||sender.documentId!==state?.documentId||message.revision!==state?.revision||!owns(tabId,state))return;
    if(message.kind==='changed')restart(tabId,state);
    else if(message.kind==='rebound'&&state.result)paint(tabId,state).catch(error=>failure(tabId,state,error));
    reply({ok:true});return;
  }
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html'))return;
  (async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id)throw new Error('没有当前网页。');const state=tabs.get(tab.id);
    if(message.action==='analyze'){mutedTabs.delete(tab.id);if(message.mode){if(!['information_density','hybrid','semantic_importance'].includes(message.mode))throw new Error('模式无效');const prefs={...(state?.prefs||tabPrefs.get(tab.id)),mode:message.mode,manualMode:true};tabPrefs.set(tab.id,prefs);if(state)state.prefs=prefs;}launch(tab.id,true);return {status:'正在读取网页 · 完成一部分即显示一部分',busy:true};}
    if(message.action==='pause'){mutedTabs.add(tab.id);cancelRestart(tab.id);epochs.set(tab.id,(epochs.get(tab.id)||0)+1);if(state){state.cancelled=true;state.active=false;state.status='已暂停';}await clear(tab.id);if(state?.documentId)await pageCall(tab.id,state,'stop',{revision:state.revision}).catch(()=>{});if(state?.jobId)native('cancel',{jobId:state.jobId}).catch(()=>{});return {status:'已暂停 · 高亮已清除',busy:false};}
    if(message.action==='appearance'){
      if(!['background','foreground','underline','fade'].includes(message.style))throw new Error('样式无效');
      const channels=String(message.rgb||'255 71 64').split(' ').map(Number);if(channels.length!==3||channels.some(c=>!Number.isInteger(c)||c<0||c>255))throw new Error('颜色无效');
      if(message.mode&&!['hybrid','information_density','semantic_importance'].includes(message.mode))throw new Error('模式无效');
      if(message.fusion&&!['semantic_floor','weighted','gated'].includes(message.fusion))throw new Error('融合方式无效');
      const prefs={...(state?.prefs||tabPrefs.get(tab.id)),fusion:message.fusion||state?.prefs?.fusion||tabPrefs.get(tab.id)?.fusion||'semantic_floor',mode:message.mode||state?.prefs?.mode||tabPrefs.get(tab.id)?.mode||'hybrid',alpha:message.alpha===undefined?(state?.prefs?.alpha??.4):Math.max(0,Math.min(1,Number(message.alpha)||0)),style:message.style,intensity:Math.max(0,Math.min(150,Number(message.intensity)||0)),hue:Number(message.hue)||0,rgb:channels.join(' ')};
      const previousMode=state?.prefs?.mode;
      const write=appearanceWrites.catch(()=>{}).then(async()=>{
        let saved;for(let attempt=0;attempt<2;attempt++){const latest=await native('appearance');try{saved=await native('setAppearance',{revision:latest.revision,settings:{style:prefs.style,hue:prefs.hue,intensity:prefs.intensity/100}});break;}catch(error){if(error.status!==409||attempt===1)throw error;}}
        tabPrefs.set(tab.id,prefs);if(state&&tabs.get(tab.id)===state)state.prefs=prefs;
        await acceptAppearance(saved);if(state?.result&&!state.cancelled&&tabs.get(tab.id)===state)await paint(tab.id,state);
        if(owns(tab.id,state)&&previousMode!==prefs.mode&&((prefs.mode!=='information_density'&&state.analysisMode==='information_density'&&!state.result?.spans.some(s=>Number.isFinite(s.semantic)))||(prefs.mode==='information_density'&&state.analysisMode!=='information_density'&&state.active)))launch(tab.id,true);
      });appearanceWrites=write;await write;return {status:state?.status||'先分析当前网页'};
    }
    if(message.action==='siteAuto'){if(!message.enabled){mutedTabs.add(tab.id);cancelRestart(tab.id);}if(message.enabled){const doc=await native('reading'),p=doc.clients.edge;await native('setReading',{revision:doc.revision,inherit:p.inherit,autoAnalyze:true,settings:p.settings});await syncReading();}return {status:message.enabled?'本站自动分析已开启':'本站自动分析已关闭',siteAuto:message.enabled};}
    if(message.action==='status'){await syncAppearance();await syncReading().catch(()=>{});const current=tabs.get(tab.id);return {status:current?.status||'点击分析当前网页',busy:Boolean(current?.active&&!current.cancelled),connected:['local_base','local_models'].includes((await native('health'))?.source),prefs:current?.prefs||{mode:'hybrid',fusion:'semantic_floor',alpha:.4,...tabPrefs.get(tab.id),...sharedPrefs(sharedAppearance),...(centralReading?.effective||{})}};}
    throw new Error('操作不受支持。');})().then(data=>reply({ok:true,...data}),error=>reply({ok:false,status:error.message}));return true;
});
chrome.tabs.onRemoved.addListener(tabId=>{cancelRestart(tabId);restartHistory.delete(tabId);const state=tabs.get(tabId);if(state?.jobId)native('cancel',{jobId:state.jobId}).catch(()=>{});tabs.delete(tabId);tabPrefs.delete(tabId);epochs.delete(tabId);});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==='complete')autoTab(tabId).catch(()=>{});if(change.status==='loading'){mutedTabs.delete(tabId);cancelRestart(tabId);restartHistory.delete(tabId);epochs.set(tabId,(epochs.get(tabId)||0)+1);const state=tabs.get(tabId);if(state){state.cancelled=true;if(state.jobId)native('cancel',{jobId:state.jobId}).catch(()=>{});tabs.delete(tabId);}}});
setInterval(()=>{if(port){syncAppearance().catch(()=>{});syncReading().catch(()=>{});}},3000);

async function syncReading(){
  const doc=await native('reading'),next=doc.clients?.edge;if(!next)throw new Error('阅读设置未连接。');next.effective=readingSettings(next.effective);
  if(JSON.stringify(next)===JSON.stringify(centralReading))return;const prior=centralReading;centralReading=next;
  for(const [id,state]of tabs){const before=state.prefs.classify,previousMode=state.prefs.mode;const keepMode=!prior&&state.prefs.manualMode||prior?.effective.mode===next.effective.mode;state.prefs={...state.prefs,...next.effective,...(keepMode?{mode:state.prefs.mode}:{})};if(state.result&&!state.cancelled)await paint(id,state);if(!state.cancelled&&((next.effective.classify&&!before)||(prior&&previousMode==='information_density'&&state.prefs.mode!=='information_density')))launch(id);}
  if(next.autoAnalyze&&!prior?.autoAnalyze){for(const tab of await chrome.tabs.query({active:true,currentWindow:true}))await autoTab(tab.id);}
  return doc;
}
async function autoTab(tabId){
  if(!centralReading)await syncReading();if(!centralReading?.autoAnalyze||mutedTabs.has(tabId)||owns(tabId,tabs.get(tabId)))return;
  const tab=await chrome.tabs.get(tabId);if(!/^https?:\/\//u.test(tab.url||'')||tab.status!=='complete')return;
  const pattern=new URL(tab.url).origin+'/*',saved=await chrome.storage.local.get('automaticOrigins');
  if(!saved.automaticOrigins?.includes(pattern)||!await chrome.permissions.contains({origins:[pattern]}))return;
  if(mutedTabs.has(tabId)||owns(tabId,tabs.get(tabId)))return;launch(tabId);
}
chrome.tabs.onActivated?.addListener(({tabId})=>autoTab(tabId).catch(()=>{}));
