const vscode=require('vscode');
const http=require('node:http');
const {createHash}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const {snapshot,plan}=require('./snapshot.cjs');
let helpers,bar,output,disposed=false,token=null,tokenPort=null;
let centralAppearance=null,centralPort=null,appearanceFlight=null,appearanceTimer;
let centralReading=null,workspaceContext=null;
const pausedDocuments=new Set();const docs=new Map();
function settings(){const c=vscode.workspace.getConfiguration('infolens');return Object.fromEntries(['port','mode','style','hue','intensity','alpha','beta','fusion','reanalyzeOnEdit'].map(k=>[k,c.get(k)]));}
function rawRequest(route,method='GET',body,authorization,port=settings().port){if(!Number.isInteger(port)||port<1||port>65535)return Promise.reject(new Error('本机服务端口无效。'));
  return new Promise((resolve,reject)=>{
    const data=body===undefined?null:Buffer.from(JSON.stringify(body));
    const req=http.request({hostname:'127.0.0.1',port,path:route,method,headers:{'X-InfoLens-Client':'vscode-local-reader',...(authorization?{Authorization:'Bearer '+authorization}:{}),...(data?{'Content-Type':'application/json','Content-Length':data.length}:{})}},res=>{
      const bytes=[];let length=0;res.on('data',chunk=>{length+=chunk.length;if(length>16*1024*1024){req.destroy(new Error('服务响应过大。'));return;}bytes.push(chunk);});
      res.on('error',reject);res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(bytes).toString('utf8'));if(res.statusCode>=400)reject(Object.assign(new Error(value.error?.message||'本机服务请求失败。'),{status:res.statusCode}));else resolve(value);}catch(error){reject(error);}});
    });req.setTimeout(20000,()=>req.destroy(new Error('本机服务请求超时。')));req.on('error',reject);if(data)req.write(data);req.end();
  });
}
async function api(route,method='GET',body,retry=true){const port=settings().port;if(!token||tokenPort!==port){token=(await rawRequest('/v1/session')).token;tokenPort=port;}
  try{return await rawRequest(route,method,body,token);}catch(error){if(error.status===401&&retry){token=null;return api(route,method,body,false);}throw error;}}
function acceptAppearance(data,port){
  if(disposed||port!==settings().port)return;
  const p=data.clients.vscode.effective;if(!['background','foreground','underline','fade'].includes(p.style)||!Number.isFinite(p.hue)||!Number.isFinite(p.intensity))throw new Error('后台外观设置无效。');
  const changed=JSON.stringify(p)!==JSON.stringify(centralAppearance);centralAppearance={...p};centralPort=port;
  if(changed){for(const state of docs.values())for(const key of ['style','hue','intensity'])delete state.overrides[key];for(const editor of vscode.window.visibleTextEditors)repaint(editor.document);}
}
async function syncAppearance(){if(appearanceFlight)return appearanceFlight;const port=settings().port;const task=api('/v1/appearance').then(data=>{acceptAppearance(data,port);return data;});appearanceFlight=task;try{return await task;}finally{if(appearanceFlight===task)appearanceFlight=null;}}
async function saveAppearance(style){
  for(let attempt=0;attempt<2;attempt++){const latest=await api('/v1/appearance');const p=latest.clients.vscode.effective;
    try{const saved=await api('/v1/appearance/vscode','PUT',{revision:latest.revision,inherit:false,settings:{...p,style}});acceptAppearance(saved,settings().port);return;}catch(error){if(error.status!==409||attempt===1)throw error;}
  }
}
function isCurrent(state,generation,doc){return !disposed&&docs.get(state.key)===state&&state.generation===generation&&!doc.isClosed&&doc.version===state.version;}
function clear(state){for(const type of state.types.values())type.dispose();state.types.clear();state.painted=[];state.paintKey=null;}
function cancel(state){state.generation++;clearTimeout(state.timer);const job=state.jobId;state.jobId=null;if(job)rawRequest('/v1/jobs/'+job,'DELETE',undefined,state.jobToken,state.jobPort).catch(()=>{});}
function label(text){if(!disposed){bar.text='$(eye) InfoLens · '+text;bar.tooltip='点击分析当前文档；停止高亮使用 InfoLens: 停止当前文档高亮。';}}
function repaint(doc,overrides={}){
  const state=docs.get(doc.uri.toString());if(!state?.analysis||state.version!==doc.version)return [];
  const options={...settings(),...(centralPort===settings().port?centralAppearance:{}),...(centralReading?.effective||{}),...state.overrides,...overrides};
  if(!['background','foreground','underline','fade'].includes(options.style)||!['information_density','semantic_importance','hybrid'].includes(options.mode)||!['semantic_floor','weighted','gated'].includes(options.fusion))throw new Error('高亮外观选项无效。');
  for(const [k,max] of [['alpha',1],['beta',1],['hue',360],['intensity',1.5]])if(!Number.isFinite(options[k])||options[k]<0||options[k]>max)throw new Error('高亮参数超出范围。');
  state.overrides={...(centralReading?.effective||{}),...state.overrides,...overrides};const paintKey=JSON.stringify([options.style,options.hue,options.intensity,vscode.window.activeColorTheme.kind]);if(state.paintKey!==paintKey){clear(state);state.paintKey=paintKey;}
  const entries=plan(state.analysis,state.snap,options,helpers);const rgb=helpers.hueRgb(options.hue);
  const buckets=new Map();for(const entry of entries){if(!buckets.has(entry.level))buckets.set(entry.level,[]);buckets.get(entry.level).push(entry);}
  const visible=vscode.window.visibleTextEditors.filter(editor=>editor.document===doc);
  for(const [level,list] of buckets){const a=helpers.appearanceAtLevel(level,options.intensity);const style={rangeBehavior:vscode.DecorationRangeBehavior.ClosedClosed};
    if(options.intensity>0){
      if(options.style==='background')style.backgroundColor=`rgba(${rgb.join(',')},${a.backgroundOpacity})`;
      if(options.style==='underline')style.textDecoration=`underline solid rgba(${rgb.join(',')},${a.underlineOpacity})`;
      if(options.style==='foreground'&&level>0){const blend=base=>'#'+base.map((v,i)=>Math.round(v+(rgb[i]-v)*a.tintPercent/100).toString(16).padStart(2,'0')).join('');style.light={color:blend([51,51,51])};style.dark={color:blend(vscode.window.activeColorTheme.kind===vscode.ColorThemeKind.HighContrast?[255,255,255]:[212,212,212])};}
      if(options.style==='fade')style.opacity=String(a.fadePercent/100);
    }
    const type=state.types.get(level)||vscode.window.createTextEditorDecorationType(style);state.types.set(level,type);
    const ranges=list.map(entry=>({range:new vscode.Range(doc.positionAt(entry.start),doc.positionAt(entry.end)),hoverMessage:new vscode.MarkdownString(`InfoLens · ${state.analysis.source}\n\nSurprisal: ${Number.isFinite(entry.bits)?entry.bits.toFixed(3)+' bit':'未评估'} · S=${entry.S?.toFixed(3)??'未评估'}\n\nSemantic: ${entry.M?.toFixed(3)??'未评估'} · F=${entry.score.toFixed(3)}${entry.degraded?' · 单信号回退':''}`)}));
    for(const editor of visible)editor.setDecorations(type,ranges);
  }
  for(const [level,type]of state.types)if(!buckets.has(level)){type.dispose();state.types.delete(level);}
  state.painted=entries;state.lastOptions=options;state.appliedEditors=visible.length;
  const cov=state.analysis.semantic?.coverage;label((options.mode==='hybrid'?'融合':options.mode==='information_density'?'信息密度':'语义重点')+' · '+entries.length+' 片段'+(cov?' · 语义 '+cov.evaluatedSentences+'/'+cov.totalSentences:' '));return entries;
}
async function analyze(doc=vscode.window.activeTextEditor?.document){
  if(!doc)throw new Error('请先打开 Markdown 或代码文档。');
  pausedDocuments.delete(doc.uri.toString());
  if(vscode.env.remoteName||!['file','untitled'].includes(doc.uri.scheme))throw new Error('首版仅支持本机文件与未命名文档。');
  const raw=doc.getText();if(raw.length>30000)throw new Error('文档超过 30,000 UTF-16 长度，请先分段；内容未被截断。');if(!raw.trim())throw new Error('文档为空。');
  const capturedVersion=doc.version;await syncAppearance().catch(()=>{});await syncReading().catch(()=>{});if(doc.isClosed||doc.version!==capturedVersion)throw new Error('文档在读取设置时已更改，请重新分析。');
  const key=doc.uri.toString();let state=docs.get(key);if(!state){state={key,generation:0,types:new Map(),painted:[],overrides:{}};docs.set(key,state);}
  cancel(state);clear(state);state.analysis=null;state.version=doc.version;const generation=state.generation;
  const kind=doc.languageId==='markdown'?'paragraph':'code';state.snap=snapshot(raw,kind);label('提交当前文档');
  try{
    const accepted=await api('/v1/jobs','POST',{document:{id:createHash('sha256').update(key).digest('hex'),revision:String(state.version),contentHash:state.snap.contentHash,offsetEncoding:'utf16',normalizationVersion:'lf-v1'},blocks:state.snap.blocks,analysis:{profile:kind==='code'?'code':'markdown',mode:centralReading?.effective.mode||settings().mode||'hybrid',classify:centralReading?.effective.classify===true}});
    if(!isCurrent(state,generation,doc)){await api('/v1/jobs/'+accepted.jobId,'DELETE').catch(()=>{});return;}
    state.jobId=accepted.jobId;state.jobToken=token;state.jobPort=tokenPort;state.partialSequence=0;const deadline=Date.now()+8*60*1000;
    while(isCurrent(state,generation,doc)){
      const job=await api('/v1/jobs/'+accepted.jobId);if(!isCurrent(state,generation,doc))return;
      if(job.status==='completed'){
        if(job.result.contentHash!==state.snap.contentHash||job.result.revision!==String(state.version)||!['local_models','local_base'].includes(job.result.source))throw new Error('结果版本或来源不匹配。');
        state.jobId=null;state.analysis=job.result.analysis;state.cacheHit=job.result.cacheHit;repaint(doc);return {source:state.analysis.source,painted:state.painted.length,cacheHit:state.cacheHit};
      }
      if(job.status==='failed')throw new Error(job.error?.message||'本机模型分析失败。');
      if(job.status==='cancelled'){state.jobId=null;label('任务已取消');return;}
      if(job.partial?.sequence>state.partialSequence){const p=job.partial;if(p.contentHash!==state.snap.contentHash||p.revision!==String(state.version)||!['local_models','local_base'].includes(p.source))throw new Error('增量结果版本或来源不匹配。');state.partialSequence=p.sequence;state.analysis=p.analysis;repaint(doc);}
      if(Date.now()>deadline){cancel(state);throw new Error('分析超时；任务已取消。');}
      label(({model_loading:'加载 Base',semantic_loading:'加载语义模型',density:'计算信息密度',semantic:'判断句子重点'})[job.stage]||'本地分析中');await new Promise(r=>setTimeout(r,400));
    }
  }catch(error){if(isCurrent(state,generation,doc)){cancel(state);state.analysis=null;clear(state);label('分析未完成');}throw error;}
}
function pause(doc=vscode.window.activeTextEditor?.document,muted=true){if(!doc)return;if(muted)pausedDocuments.add(doc.uri.toString());else pausedDocuments.delete(doc.uri.toString());const state=docs.get(doc.uri.toString());if(state){cancel(state);clear(state);docs.delete(state.key);}label('已停止高亮');}
function diagnostic(uri=vscode.window.activeTextEditor?.document.uri.toString()){const s=docs.get(uri);return s?{version:s.version,generation:s.generation,pendingJob:s.jobId||null,source:s.analysis?.source||null,cacheHit:s.cacheHit,painted:s.painted.map(e=>({...e})),options:s.lastOptions,appliedEditors:s.appliedEditors||0}:null;}
async function activate(context){workspaceContext=context;disposed=false;helpers=Object.assign({},...await Promise.all(['signals.mjs','appearance.mjs'].map(name=>import(pathToFileURL(path.join(__dirname,name)).href))));
  helpers.selectReadingCandidates=(await import(pathToFileURL(path.join(__dirname,'reading-policy.mjs')).href)).selectReadingCandidates;
  bar=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,30);bar.command='infolens.analyze';bar.show();label('分析当前文档');
  output=vscode.window.createOutputChannel('InfoLens');context.subscriptions.push(bar,output);
  const safe=fn=>async(...args)=>{try{return await fn(...args);}catch(error){vscode.window.showErrorMessage('InfoLens: '+error.message);return {error:error.message};}};
  context.subscriptions.push(vscode.commands.registerCommand('infolens.analyze',safe(()=>analyze())));
  context.subscriptions.push(vscode.commands.registerCommand('infolens.pause',()=>pause()));
  context.subscriptions.push(vscode.commands.registerCommand('infolens.repaint',safe(overrides=>{const doc=vscode.window.activeTextEditor?.document;return doc?repaint(doc,overrides):[];})));
  context.subscriptions.push(vscode.commands.registerCommand('infolens.configure',safe(async()=>{
    const style=await vscode.window.showQuickPick([{label:'连续背景高亮',value:'background'},{label:'文字着色',value:'foreground'},{label:'连续下划线',value:'underline'},{label:'低分文字淡化',value:'fade'}],{title:'InfoLens 高亮样式'});if(!style)return;
    const mode=await vscode.window.showQuickPick([{label:'双信号融合',value:'hybrid'},{label:'信息密度',value:'information_density'},{label:'语义重点',value:'semantic_importance'}],{title:'InfoLens 阅读信号'});if(!mode)return;
    await saveAppearance(style.value);const doc=vscode.window.activeTextEditor?.document;if(doc)repaint(doc,{mode:mode.value});
  })));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event=>{if(!event.contentChanges.length)return;const state=docs.get(event.document.uri.toString());if(!state)return;cancel(state);clear(state);state.analysis=null;label('文档已更改 · 重新分析');
    if(settings().reanalyzeOnEdit||workspaceAutomatic())state.timer=setTimeout(()=>analyze(event.document).catch(error=>{output.appendLine('重新分析未完成：'+error.message);}),700);
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc=>pause(doc,false)));
  // VSCode may retain a TextDocument after its last tab closes. Release ownership at tab close too.
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(event=>{for(const tab of event.closed){if(!(tab.input instanceof vscode.TabInputText))continue;const uri=tab.input.uri;const stillOpen=vscode.window.tabGroups.all.some(group=>group.tabs.some(t=>t.input instanceof vscode.TabInputText&&t.input.uri.toString()===uri.toString()));if(!stillOpen)pause({uri},false);}}));
  context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(()=>{for(const editor of vscode.window.visibleTextEditors)repaint(editor.document);}));
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(editors=>{for(const editor of editors)if(docs.get(editor.document.uri.toString())?.analysis)repaint(editor.document);}));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event=>{if(!event.affectsConfiguration('infolens'))return;if(event.affectsConfiguration('infolens.port')){token=null;for(const state of docs.values()){cancel(state);clear(state);state.analysis=null;}}
    else for(const editor of vscode.window.visibleTextEditors)repaint(editor.document);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('infolens.workspaceAuto',async()=>{if(!vscode.workspace.workspaceFolders?.length)throw new Error('请先打开本机工作区。');const enabled=workspaceContext.workspaceState.get('automaticReading',false)!==true;await workspaceContext.workspaceState.update('automaticReading',enabled);if(enabled){const data=await api('/v1/reading'),p=data.clients.vscode;await api('/v1/reading/vscode','PUT',{revision:data.revision,inherit:p.inherit,autoAnalyze:true,settings:p.settings});await syncReading();}label(enabled?'当前工作区自动分析已开启':'当前工作区自动分析已关闭');if(enabled)autoAnalyze();}));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor?.(()=>autoAnalyze())||{dispose(){}});
  appearanceTimer=setInterval(()=>{syncAppearance().catch(()=>{});syncReading().catch(()=>{});},2500);context.subscriptions.push({dispose(){clearInterval(appearanceTimer);}});syncAppearance().catch(()=>{});
  syncReading().then(()=>autoAnalyze()).catch(()=>{});return {diagnostic,syncAppearance,syncReading};
}
function deactivate(){clearInterval(appearanceTimer);for(const state of docs.values()){cancel(state);clear(state);}docs.clear();pausedDocuments.clear();disposed=true;token=null;centralAppearance=null;centralPort=null;}
module.exports={activate,deactivate};

function workspaceAutomatic(){return centralReading?.autoAnalyze===true&&workspaceContext?.workspaceState?.get('automaticReading',false)===true&&!vscode.env.remoteName;}
function autoAnalyze(){const doc=vscode.window.activeTextEditor?.document;if(!workspaceAutomatic()||!doc||doc.uri.scheme!=='file'||!vscode.workspace.getWorkspaceFolder?.(doc.uri)||!['markdown','plaintext','python','javascript','typescript','javascriptreact','typescriptreact','c','cpp','csharp','java','rust','go','json'].includes(doc.languageId))return;const state=docs.get(doc.uri.toString());if(pausedDocuments.has(doc.uri.toString())||state?.version===doc.version||state?.jobId)return;analyze(doc).catch(e=>label(e.message));}
async function syncReading(){const doc=await api('/v1/reading'),next=doc.clients.vscode;if(disposed)return;if(JSON.stringify(next)===JSON.stringify(centralReading))return;const old=centralReading;centralReading=next;for(const editor of vscode.window.visibleTextEditors)repaint(editor.document);if((next.effective.classify&&!old?.effective.classify)||(old?.effective.mode==='information_density'&&next.effective.mode!=='information_density')){for(const editor of vscode.window.visibleTextEditors)if(docs.get(editor.document.uri.toString())?.analysis)analyze(editor.document).catch(()=>{});}autoAnalyze();}
