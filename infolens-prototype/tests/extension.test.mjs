import {readingSettings,selectReadingCandidates} from '../reading-policy.mjs';
import {signalScore} from '../signals.mjs';
import {hueRgb} from '../appearance.mjs';
import * as rpc from '../../edge-extension/page-rpc.mjs';
import {createReadingStore} from '../reading-store.mjs';
import {createAppearanceStore} from '../client-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../../edge-extension/background.js',import.meta.url),'utf8');
function deferred(){let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};}
async function until(condition){for(let n=0;n<200;n++){if(condition())return;await new Promise(r=>setTimeout(r,2));}throw new Error('Extension fixture timeout');}
function browserFixture({firstCapture,incremental=false,scriptReply,insert,remove,nativeReply,fastTimers=false,reading=null,automaticOrigins=[]}={}){
  let messageHandler,nativeHandler,updated,removed,captures=0,jobs=0,reads=0;const trace=[],store=createAppearanceStore();
  let documentId='document-1';
  const frame=result=>[{frameId:0,documentId,result}];
  const chrome={runtime:{id:'fixture',lastError:null,getURL:name=>'chrome-extension://fixture/'+name,onMessage:{addListener:f=>messageHandler=f},connectNative:()=>({
    onMessage:{addListener:f=>nativeHandler=f},onDisconnect:{addListener(){}},postMessage:request=>{(async()=>{
      trace.push({native:request});let data;
      if(request.action==='reading'&&reading){data=reading.snapshot();}
      else if(request.action==='appearance')data=store.snapshot();
      if(request.action==='setAppearance')data=await store.update('edge',{revision:request.revision,inherit:false,settings:request.settings});
      if(request.action==='health')data={source:'local_base'};
      if(request.action==='submit')data={jobId:'job-'+(++jobs),contentHash:'fixture-hash'};
      if(request.action==='job')data=incremental&&reads++===0?{status:'running',partialSequence:1}:{status:'completed'};
      if(request.action==='partial')data={revision:'revision-'+captures,contentHash:'fixture-hash',sequence:1,spans:[{blockId:'b1',start:0,end:4,surprisalBits:8,surprisalNormalized:.8,semantic:null}],nextCursor:null};
      if(request.action==='cancel')data={status:'cancelled'};
      if(request.action==='result')data={revision:'revision-'+captures,contentHash:'fixture-hash',spans:[{blockId:'b1',start:0,end:4,surprisalBits:8,surprisalNormalized:.8,semantic:.25}],nextCursor:null,tokenCount:1,gpu:{peakAllocatedMiB:1}};
      if(nativeReply)data=nativeReply(request,data);
      queueMicrotask(()=>nativeHandler({id:request.id,ok:true,data}));
    })().catch(error=>nativeHandler({id:request.id,ok:false,error:error.message,status:error.status}));}
  })},storage:{local:{get:async()=>({automaticOrigins})}},permissions:{contains:async()=>true},tabs:{get:async id=>({id,url:'https://article.example/read',status:'complete'}),query:async()=>[{id:7}],onRemoved:{addListener:f=>removed=f},onUpdated:{addListener:f=>updated=f}},scripting:{
    executeScript:async input=>{
      if(input.files){trace.push({inject:true});return frame(null);}
      const [action,payload,prefs]=input.args;trace.push({script:action,target:input.target});
      let result;
      if(action==='capture'){
        captures++;const revision='revision-'+captures;
        if(captures===1&&firstCapture)await firstCapture.promise;
        result={revision,blocks:[{id:'b1',text:'test'}]};
      }else if(action==='paint'){trace.push({paint:[payload,prefs]});result={cssRules:['::highlight(infolens){color:'+prefs.rgb+'}'],spanCount:1,rangeCount:1};}
      else{trace.push({clear:true,revision:payload?.revision});result=true;}
      const response=frame({ok:true,data:result});return scriptReply?scriptReply(action,response,input):response;
    },
    insertCSS:async input=>{trace.push({insert:input.css,target:input.target});if(insert)await insert(input);},
    removeCSS:async input=>{trace.push({remove:input.css,target:input.target});if(remove)await remove(input);}
  }};
  vm.runInNewContext(source.replace(/^import[^\n]+\n/gm,''),{...rpc,URL,readingSettings,selectReadingCandidates,signalScore,hueRgb,chrome,Map,Promise,Error,Number,String,Math,JSON,setTimeout:(f,ms)=>setTimeout(f,fastTimers&&ms===600?5:ms),clearTimeout,setInterval:()=>0,queueMicrotask});
  const sender={id:'fixture',url:chrome.runtime.getURL('popup.html')};
  const send=(action,extra={})=>new Promise(resolve=>messageHandler({action,...extra},sender,resolve));
  return {trace,send,messageHandler,store,waitPaint:()=>until(()=>trace.some(t=>t.insert)),navigate(){documentId='document-2';updated(7,{status:'loading'});},updated,close(){removed(7);}};
}
async function waitStatus(f,pattern){for(let i=0;i<100;i++){const r=await f.send('status');if(pattern.test(r.status))return r;await new Promise(r=>setTimeout(r,2));}throw new Error('Expected visible status '+pattern);}
test('extension uses appearance selected before analysis and changes rendering without resubmitting text',async()=>{
  const f=browserFixture();await f.send('appearance',{style:'underline',intensity:65,rgb:'64 255 255',hue:180});await f.send('analyze');await f.waitPaint();
  assert.equal(f.trace.find(t=>t.paint).paint[1].rgb,'64 255 255');assert.equal(f.trace.find(t=>t.paint).paint[1].style,'underline');
  await f.send('appearance',{style:'foreground',intensity:100,rgb:'255 71 64',hue:0});assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,1);assert.equal((await f.send('status')).prefs.style,'foreground');
});
test('a newer analysis wins if an older document capture returns late',async()=>{
  const barrier=deferred(),f=browserFixture({firstCapture:barrier});await f.send('analyze');await until(()=>f.trace.some(t=>t.script==='capture'));await new Promise(r=>setTimeout(r,10));await f.send('analyze');await f.waitPaint();barrier.resolve();await new Promise(r=>setTimeout(r,10));assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,1);assert.equal(f.trace.filter(t=>t.insert).length,1);
});
test('pause cancels ownership and clears native ranges and styles after a completed result',async()=>{
  const f=browserFixture();await f.send('analyze');await f.waitPaint();const response=await f.send('pause');assert.match(response.status,/已暂停/);assert.ok(f.trace.some(t=>t.remove));assert.ok(f.trace.at(-1).native?.action==='cancel');const before=f.trace.filter(t=>t.insert).length;await f.send('appearance',{style:'fade',intensity:100,rgb:'255 71 64'});assert.equal(f.trace.filter(t=>t.insert).length,before);
});

test('extension switches real signals and weights locally without submitting a new analysis',async()=>{
  const f=browserFixture();await f.send('analyze');await f.waitPaint();
  await f.send('appearance',{mode:'semantic_importance',alpha:.4,style:'fade',intensity:100,rgb:'255 71 64'});
  assert.equal(f.trace.filter(t=>t.paint).at(-1).paint[0].spans[0].finalScore,.25);
  await f.send('appearance',{mode:'hybrid',alpha:1,style:'background',intensity:100,rgb:'255 71 64'});
  assert.equal(f.trace.filter(t=>t.paint).at(-1).paint[0].spans[0].finalScore,.8);
  assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,1);
});

test('workbench per-app settings repaint existing Edge results and preserve reading signals without resubmission',async()=>{
  const f=browserFixture();await f.send('analyze');await f.waitPaint();
  await f.send('appearance',{mode:'semantic_importance',alpha:.25,style:'background',intensity:100,hue:0,rgb:'255 71 64'});
  const before=f.trace.filter(t=>t.native?.action==='submit').length,revision=f.store.snapshot().revision;
  await f.store.update('edge',{revision,inherit:false,settings:{style:'underline',hue:210,intensity:.7}});
  const response=await f.send('status');assert.equal(response.prefs.style,'underline');assert.equal(response.prefs.mode,'semantic_importance');assert.equal(response.prefs.intensity,70);
  assert.equal(f.trace.filter(t=>t.paint).at(-1).paint[0].spans[0].finalScore,.25);assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,before);
});

test('appearance received during an old Edge capture cannot revive a paused document',async()=>{
  const barrier=deferred(),f=browserFixture({firstCapture:barrier});await f.send('analyze');await until(()=>f.trace.some(t=>t.native?.action==='appearance'));await new Promise(r=>setTimeout(r,10));
  await f.send('pause');await f.store.update('edge',{revision:0,inherit:false,settings:{style:'foreground',hue:120,intensity:.5}});await f.send('status');barrier.resolve();await new Promise(r=>setTimeout(r,10));
  assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,0);assert.equal(f.trace.filter(t=>t.insert).length,0);
});

test('Edge paints a running partial before fetching the terminal result, and keeps identical CSS installed',async()=>{
 const f=browserFixture({incremental:true});await f.send('analyze');await f.waitPaint();
 assert.equal(f.trace.filter(t=>t.native?.action==='result').length,0);assert.equal(f.trace.filter(t=>t.native?.action==='partial').length,1);
 await until(()=>f.trace.some(t=>t.native?.action==='result'));await new Promise(r=>setTimeout(r,10));
 assert.equal(f.trace.filter(t=>t.paint).length,2);assert.equal(f.trace.filter(t=>t.insert).length,1);assert.equal(f.trace.filter(t=>t.remove).length,0);
});

test('reanalyzing the same document retains installed styles until new results and still allows pause cleanup',async()=>{
  const f=browserFixture();await f.send('analyze');await waitStatus(f,/已完成/);
  const clears=f.trace.filter(t=>t.clear).length;
  await f.send('analyze');await until(()=>f.trace.filter(t=>t.native?.action==='submit').length===2);await waitStatus(f,/已完成/);
  assert.equal(f.trace.filter(t=>t.remove).length,0);
  assert.equal(f.trace.filter(t=>t.clear).length,clears);
  assert.equal(f.trace.filter(t=>t.insert).length,1);
  assert.equal(f.trace.filter(t=>t.paint).at(-1).paint[0].complete,true);
  await f.send('pause');assert.ok(f.trace.some(t=>t.remove));
});

for(const [name,bad] of [['null',null],['empty list',[]],['null frame',[null]],['missing result',[{frameId:0,documentId:'document-1'}]],['null result',[{frameId:0,documentId:'document-1',result:null}]],['null paint data',[{frameId:0,documentId:'document-1',result:{ok:true,data:null}}]],['invalid CSS array',[{frameId:0,documentId:'document-1',result:{ok:true,data:{cssRules:null}}}]]]){
  test('Edge reports '+name+' script output without dereferencing cssRules or claiming success',async()=>{
    const f=browserFixture({scriptReply:(op,rows)=>op==='paint'?bad:rows});await f.send('analyze');
    const r=await waitStatus(f,/请重新分析/);assert.doesNotMatch(r.status,/Cannot read|cssRules|已完成/);
    assert.equal(f.trace.filter(t=>t.insert).length,0);assert.ok(f.trace.some(t=>t.native?.action==='cancel'));
  });
}
test('the original page error survives the isolated-world boundary and capture failures are visible before submitting a model job',async()=>{
  const f=browserFixture({scriptReply:(op,rows)=>op==='capture'?[{frameId:0,documentId:'document-1',result:{ok:false,error:{message:'正文尚未加载，请稍后重试。'}}}]:rows});
  await f.send('analyze');assert.match((await waitStatus(f,/正文尚未加载/)).status,/稍后重试/);assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,0);
  const context=vm.createContext({InfoLensPage:{paint(){throw Error('正文已变化，请重新分析。');}}});
  assert.equal(vm.runInContext('('+rpc.invokePage.toString()+')',context)('paint',{},{}).error.message,'正文已变化，请重新分析。');
});
test('a document mismatch discards the renderer reply before CSS installation',async()=>{
  const f=browserFixture({scriptReply:(op,rows)=>op==='paint'?[{...rows[0],documentId:'document-2'}]:rows});await f.send('analyze');
  await waitStatus(f,/页面已切换/);assert.equal(f.trace.filter(t=>t.insert).length,0);
});
test('navigation during CSS insertion cleans up only the old document and cannot paint the next page',async()=>{
  const barrier=deferred(),f=browserFixture({insert:()=>barrier.promise});await f.send('analyze');await f.waitPaint();f.navigate();barrier.resolve();
  await until(()=>f.trace.some(t=>t.remove));assert.ok(f.trace.filter(t=>t.insert||t.remove).every(t=>t.target.documentIds[0]==='document-1'));
  assert.equal((await f.send('status')).status,'点击分析当前网页');
});
test('pause while CSS is in flight cannot be overwritten by a completed status',async()=>{
  const barrier=deferred(),f=browserFixture({insert:()=>barrier.promise});await f.send('analyze');await f.waitPaint();
  const pending=f.send('pause');await new Promise(r=>setImmediate(r));barrier.resolve();await pending;
  assert.match((await f.send('status')).status,/已暂停/);assert.ok(f.trace.some(t=>t.remove));
});
test('style refresh failures reach the popup and a later successful refresh recovers without another analysis',async()=>{
  let broken=false;const f=browserFixture({scriptReply:(op,rows)=>op==='paint'&&broken?[{frameId:0,documentId:'document-1',result:{ok:false,error:{message:'正文定位失败，请重新分析。'}}}]:rows});
  await f.send('analyze');await f.waitPaint();await waitStatus(f,/已完成/);broken=true;
  await f.store.update('edge',{revision:f.store.snapshot().revision,inherit:false,settings:{style:'fade',hue:0,intensity:1.5}});
  assert.match((await f.send('status')).status,/正文定位失败/);broken=false;
  await f.store.update('edge',{revision:f.store.snapshot().revision,inherit:false,settings:{style:'fade',hue:0,intensity:1}});
  assert.match((await f.send('status')).status,/已完成/);assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,1);
});
for(const [name,change] of [['null page',()=>null],['missing spans',p=>({...p,spans:null})],['wrong revision',p=>({...p,revision:'stale'})],['wrong hash',p=>({...p,contentHash:'stale'})],['repeating cursor',p=>({...p,nextCursor:0})]]){
  test('invalid model result '+name+' stops before painting and reports a recoverable error',async()=>{
    const f=browserFixture({nativeReply:(r,data)=>r.action==='result'?change(data):data});await f.send('analyze');
    await waitStatus(f,/分页无效/);assert.equal(f.trace.filter(t=>t.insert).length,0);
  });
}
test('missing optional semantic coverage does not break a valid result',async()=>{
  const f=browserFixture({nativeReply:(r,data)=>r.action==='result'?{...data,semantic:{}}:data});await f.send('analyze');
  await waitStatus(f,/已完成/);assert.equal(f.trace.filter(t=>t.insert).length,1);
});
test('CSS injection and removal failures remain visible and clear misleading native ranges',async()=>{
  const f=browserFixture({insert:async()=>{throw Error('Cannot access contents of url');}});await f.send('analyze');
  await waitStatus(f,/Cannot access/);assert.ok(f.trace.some(t=>t.clear));
  let fail=false;const g=browserFixture({remove:async()=>{if(fail)throw Error('样式清理失败');}});await g.send('analyze');await g.waitPaint();fail=true;
  const response=await g.send('appearance',{style:'foreground',hue:180,rgb:'64 255 255',intensity:100});assert.equal(response.ok,false);assert.match(response.status,/样式清理失败/);assert.ok(g.trace.some(t=>t.clear));
});


test('hybrid semantic floor is the default and reaches the inference request',async()=>{
  const f=browserFixture();await f.send('analyze');await waitStatus(f,/已完成/);
  assert.equal(f.trace.find(t=>t.native?.action==='submit').native.analysis.mode,'hybrid');
  assert.equal((await f.send('status')).prefs.fusion,'semantic_floor');
  assert.equal((await f.send('status')).busy,false);
});

test('explicit quick mode still skips semantic inference',async()=>{
  const f=browserFixture();await f.send('analyze',{mode:'information_density'});await waitStatus(f,/已完成/);
  assert.equal(f.trace.find(t=>t.native?.action==='submit').native.analysis.mode,'information_density');
});

test('a fast job finishing between the status poll and partial fetch does not report a paging error',async()=>{
  const f=browserFixture({incremental:true,nativeReply:(request,data)=>request.action==='partial'?{...data,completed:true,sequence:null}:data});
  await f.send('analyze');await waitStatus(f,/已完成/);
  assert.equal(f.trace.filter(t=>t.insert).length,1);
  assert.equal(f.trace.filter(t=>t.native?.action==='cancel').length,0);
});

test('expected stale snapshot errors automatically recapture and complete',async()=>{
  let stale=true;const f=browserFixture({fastTimers:true,scriptReply:(op,rows)=>{
    if(op==='paint'&&stale){stale=false;return [{...rows[0],result:{ok:false,error:{code:'document_changed',message:'正文已变化'}}}];}return rows;
  }});
  await f.send('analyze');await waitStatus(f,/已完成/);
  assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,2);
  assert.equal(f.trace.filter(t=>t.insert).length,1);
});

function pageMessage(f,extra={},sender={}){return f.messageHandler({action:'pageChanged',kind:'changed',revision:'revision-1',...extra},{id:'fixture',tab:{id:7},frameId:0,documentId:'document-1',...sender},()=>{});}

test('page notifications require matching document, frame and revision; repeated edits coalesce',async()=>{
  const f=browserFixture({fastTimers:true});await f.send('analyze');await waitStatus(f,/已完成/);
  pageMessage(f,{}, {documentId:'document-2'});pageMessage(f,{revision:'old'});pageMessage(f,{}, {frameId:1});
  await new Promise(r=>setTimeout(r,12));assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,1);
  for(let i=0;i<5;i++)pageMessage(f);
  await until(()=>f.trace.filter(t=>t.native?.action==='submit').length===2);await waitStatus(f,/已完成/);
  assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,2);
});

for(const action of ['pause','navigate','close'])test(action+' prevents pending automatic refresh from resurrecting highlights',async()=>{
  const f=browserFixture({fastTimers:true});await f.send('analyze');await waitStatus(f,/已完成/);pageMessage(f);
  if(action==='pause')await f.send('pause');else f[action]();
  await new Promise(r=>setTimeout(r,15));assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,1);
});

test('continuously changing pages stop after three automatic retries',async()=>{
  const f=browserFixture({fastTimers:true,scriptReply:(op,rows)=>op==='paint'?[{...rows[0],result:{ok:false,error:{code:'document_changed',message:'正文已变化'}}}]:rows});
  await f.send('analyze');await waitStatus(f,/持续变化/);
  assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,4);
  assert.equal(f.trace.filter(t=>t.insert).length,0);
});

test('selecting semantic mode after a density-only result actually starts semantic inference',async()=>{
  const f=browserFixture({nativeReply:(r,data)=>r.action==='result'?{...data,spans:data.spans.map(s=>({...s,semantic:null}))}:data});
  await f.send('analyze',{mode:'information_density'});await waitStatus(f,/已完成/);
  await f.send('appearance',{mode:'hybrid',style:'fade',intensity:100,rgb:'255 71 64'});
  await until(()=>f.trace.filter(t=>t.native?.action==='submit').length===2);
  assert.equal(f.trace.filter(t=>t.native?.action==='submit')[1].native.analysis.mode,'hybrid');
});


test('site auto analysis requires both remembered origin permission and workbench enable, and explicit pause stays paused',async()=>{
 const reading=createReadingStore();await reading.update('edge',{revision:0,inherit:true,autoAnalyze:true,settings:reading.snapshot().defaults});
 const f=browserFixture({reading,automaticOrigins:['https://article.example/*']});await f.send('status');await f.waitPaint();assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,1);await f.send('pause');f.updated(7,{status:'complete'});await new Promise(r=>setTimeout(r,25));assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,1);
});
test('auto analysis never submits an unapproved website',async()=>{
 const reading=createReadingStore();await reading.update('edge',{revision:0,inherit:true,autoAnalyze:true,settings:reading.snapshot().defaults});const f=browserFixture({reading});await f.send('status');await new Promise(r=>setTimeout(r,25));assert.equal(f.trace.filter(t=>t.native?.action==='submit').length,0);
});
