import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../../zotero-plugin/infolens.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({captureError=null,holdSubmit=false,holdTranslated=false,incremental=false,paragraphs=false,auto=false,total=1,onSubmit=null,ready=true,secondTab=false}={}) {
  class Element {
    constructor(){this.style={};this.children=[];this.attrs={};this.listeners=new Map();this.isConnected=true;}
    append(...nodes){for(const n of nodes){n.parentElement=this;this.children.push(n);}}
    remove(){this.isConnected=false;this.parentElement.children=this.parentElement.children.filter(n=>n!==this);}
    setAttribute(key,value){this.attrs[key]=value;}
    addEventListener(type,fn){this.listeners.set(type,fn);}
    click(){if(!this.disabled)this.listeners.get('click')?.();}
  }
  const root=new Element(),page=new Element(),pages=Array.from({length:total},()=>new Element());pages[0]=page;
  const doc={defaultView:{},createElement:()=>new Element(),querySelector:sel=>sel==='.infolens-toolbar'?root.children.find(n=>n.className==='infolens-toolbar'):root,querySelectorAll:()=>root.children.filter(n=>n.className==='infolens-toolbar')};
  const events=new Map(),timers=[],intervals=[];let appearance={revision:0,clients:{zotero:{effective:{style:"underline",hue:0,intensity:1}}}};let appearanceHold=false,releaseAppearance;let readerError=false,readerAccesses=0;let cleared=0,painted=0;const translationPaints=[];
  const app={pdfDocument:{numPages:total,...(total>1?{getPage:async n=>({getTextContent:async()=>({items:[{str:'Source '+n}]})})}:{})},eventBus:{on(name,fn){events.set(name,fn);},off(name){events.delete(name);}},pdfViewer:{currentPageNumber:1,getPageView:n=>({div:pages[n],viewport:{rotation:0}})}};
  const reader={type:'pdf',itemID:1,tabID:'first',_iframeWindow:{document:doc},_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:app}}}};
  const initialDocument=app.pdfDocument;if(!ready)app.pdfDocument=null;
  const secondRoot=new Element(),secondPage=new Element(),secondEvents=new Map();
  const secondDoc={...doc,defaultView:{},querySelector:sel=>sel==='.infolens-toolbar'?secondRoot.children.find(n=>n.className==='infolens-toolbar'):secondRoot,querySelectorAll:()=>secondRoot.children.filter(n=>n.className==='infolens-toolbar')};
  const secondApp={...app,pdfDocument:{numPages:1},eventBus:{on:(name,fn)=>secondEvents.set(name,fn),off:name=>secondEvents.delete(name)},pdfViewer:{currentPageNumber:1,getPageView:()=>({div:secondPage,viewport:{rotation:0}})}};
  const secondReader={...reader,tabID:'second',_iframeWindow:{document:secondDoc},_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:secondApp}}}};
  const tabs={selectedID:'first'},readers=secondTab?[reader,secondReader]:[reader];
  const calls=[],errors=[];let handler,observer,release,posted,exports=0,reads=0,viewport=0;
  const id='a'.repeat(24),job=body=>({jobId:id,status:'completed',revision:body.document.revision,contentHash:'hash',result:{revision:body.document.revision,contentHash:'hash',source:'local_models',analysis:{blocks:[{id:body.blocks[0].id,text:body.blocks[0].text,candidates:[]}]}}});
  const context=vm.createContext({
    Zotero:{getMainWindow:()=>({Zotero_Tabs:tabs}),Notifier:{registerObserver:o=>{observer=o;return 1;},unregisterObserver:()=>{observer=null;}},Reader:{_readers:readers,registerEventListener:(type,fn)=>{handler=fn;},_unregisterEventListenerByPluginID(){}},Prefs:{get:()=>43187},Promise:{delay:()=>Promise.resolve()},Utilities:{randomString:()=> 'revision'},logError:e=>errors.push(String(e)),
      HTTP:{async request(method,url,options){const body=options.body?JSON.parse(options.body):null;calls.push({method,url,body});
        if(url.endsWith('/reading'))return {status:200,response:{revision:0,clients:{zotero:{autoAnalyze:true,effective:{distribution:'continuous',budget:.15,categories:[],classify:false,mode:'hybrid'}}}}};
        if(url.endsWith('/session'))return {status:200,response:{token:'test-only',source:'local_models'}};
        if(url.endsWith('/appearance')){const snapshot=structuredClone(appearance);if(appearanceHold)await new Promise(r=>releaseAppearance=r);return {status:200,response:snapshot};}
        if(method==='DELETE')return {status:200,response:{status:'cancelled'}};
        if(method==='POST'){posted=body;onSubmit?.(body,app);if(holdSubmit||(holdTranslated&&body.blocks[0].id.startsWith("translated-")))await new Promise(resolve=>release=resolve);if(paragraphs&&url.endsWith('/translation-jobs'))return {status:200,response:{...job(body),result:{...job(body).result,analysis:{kind:'translation',targetLanguage:'zh',blocks:[{id:body.blocks[0].id,source:'Source',translated:'译文',status:'ready'}]}}}};if(incremental)return {status:200,response:{...job(body),status:'running',result:undefined,partial:{sequence:1,revision:'revision',contentHash:'hash',source:'local_models',analysis:job(body).result.analysis}}};return {status:200,response:job(body)};}
        if(incremental&&reads++===0){await new Promise(resolve=>release=resolve);}
        return {status:200,response:job(posted)};
      }}},
    InfoLensCore:{selectAnalysis:value=>value,capture:(p,text)=>{if(captureError)throw Error(captureError);return {page:p,text:text??(total>1?'Source '+(pages.indexOf(p)+1):'Source')};},textContentSource:c=>c.items.map(i=>i.str).join(' '),appearance:()=>{},clear:()=>{cleared++;},clearTranslation:()=>{},paint:()=>{painted++;return {painted:2,skipped:0};},translationBlocks:()=>{if(paragraphs)return [0,1,2].map(i=>({id:'p'+i,text:'Source',kind:'paragraph'}));throw Error('PDF 段落定位不支持。');},translationPlan:()=>[0,1,2].map(i=>({id:'p'+i})),prioritize:(plan,pending)=>plan.filter(b=>pending.has(b.id)).sort((a,b)=>viewport?b.id.localeCompare(a.id):a.id.localeCompare(b.id)),paintTranslation:(snapshot,blocks,n,rotation,heat)=>{translationPaints.push({...heat.settings});viewport=1;return {painted:1,skipped:0};}},
    Components:{utils:{exportFunction:(fn,target)=>{assert.ok(target===doc.defaultView||target===secondDoc.defaultView);exports++;return fn;}}},
    structuredClone,setInterval:fn=>{intervals.push(fn);return intervals.length;},clearInterval(){intervals.length=0;},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},Intl,
  });
  Object.defineProperty(context.Zotero.Reader,"_readers",{get(){readerAccesses++;if(readerError)throw Error("阅读器刷新异常");return readers;}});vm.runInContext(source,context);context.InfoLensPlugin.start({id:'test-plugin'});
  const group=root.children.find(n=>n.className==='infolens-toolbar');
  if(!auto)context.InfoLensPlugin.clear(reader);
  if(!auto&&secondTab)context.InfoLensPlugin.clear(secondReader);
  const secondGroup=secondRoot.children.find(n=>n.className==='infolens-toolbar');
  return {readerAccesses:()=>readerAccesses,pollReaders:()=>intervals[1]?.(),translationPaints,poll:()=>intervals[0]?.(),setAppearance:value=>{appearance={revision:appearance.revision+1,clients:{zotero:{effective:value}}};},holdAppearance:()=>{appearanceHold=true;},releaseAppearance:()=>{appearanceHold=false;releaseAppearance?.();},failReaderRefresh:()=>{readerError=true;},plugin:context.InfoLensPlugin,reader,secondReader,calls,errors,root,group,buttons:group.children.slice(1,5),secondButtons:secondGroup?.children.slice(1,5),notice:group.children[5],secondNotice:secondGroup?.children[5],exports:()=>exports,release:()=>release?.(),emit:(name,event)=>events.get(name)?.(event),changePage:n=>{app.pdfViewer.currentPageNumber=n;events.get('pagechanging')?.({pageNumber:n});},changeTab:id=>{tabs.selectedID=id;observer?.notify('select','tab',[id]);},makeReady:()=>{app.pdfDocument=initialDocument;observer?.notify('load','tab',['first']);},paintCounts:()=>({cleared,painted}),flushTimers:()=>{for(const fn of timers.splice(0))fn();},render:()=>handler({reader,doc,append:n=>root.append(n)})};
}
test('real toolbar handler acknowledges click, submits analysis and shows completion through its live controls',async()=>{
  const f=fixture();assert.equal(f.exports(),4);f.buttons[0].click();assert.equal(f.notice.hidden,false);assert.match(f.notice.textContent,/已收到点击/);
  await tick();assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(f.plugin.diagnostic(f.reader).hasAnalysis,true);assert.match(f.notice.textContent,/2 片段/);assert.equal(f.buttons[0].textContent,'暂停高亮');
  f.buttons[1].click();await tick();assert.match(f.notice.textContent,/已清除/);assert.equal(f.plugin.diagnostic(f.reader).hasAnalysis,false);
});
test('toolbar exposes text-layer and paragraph preflight errors without a model job',async()=>{
  const f=fixture({captureError:'文字层尚未就绪'});f.buttons[0].click();await tick();assert.match(f.notice.textContent,/文字层尚未就绪/);assert.equal(f.plugin.diagnostic(f.reader).ui.analysisBusy,false);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(f.errors.length,1);
  const g=fixture();g.buttons[2].click();await tick();assert.match(g.notice.textContent,/段落定位不支持/);assert.equal(g.plugin.diagnostic(g.reader).ui.translationBusy,false);assert.equal(g.calls.filter(c=>c.method==='POST').length,0);
});

test('neighbour page rendering does not clear current highlights and current text-layer refresh retains them until repaint',async()=>{
 const f=fixture();f.buttons[0].click();await tick();const before=f.paintCounts();
 f.emit('textlayerrendered',{pageNumber:2});f.flushTimers();assert.deepEqual(f.paintCounts(),before);
 f.emit('textlayerrendered',{pageNumber:1});assert.deepEqual(f.paintCounts(),before);f.flushTimers();assert.equal(f.paintCounts().cleared,before.cleared);assert.equal(f.paintCounts().painted,before.painted+1);
 f.emit('scalechanging',{});assert.equal(f.paintCounts().cleared,before.cleared+1);f.flushTimers();assert.equal(f.paintCounts().painted,before.painted+2);
});
test('toolbar displays a partial highlight before terminal result and retains it when cancelled',async()=>{
 const f=fixture({incremental:true});f.buttons[0].click();await tick();const state=f.plugin.diagnostic(f.reader);assert.equal(state.ui.analysisBusy,true);assert.equal(state.hasAnalysis,true);assert.equal(state.incremental.updates,1);assert.equal(state.paint.painted,2);
 f.buttons[0].click();await tick();assert.equal(f.plugin.diagnostic(f.reader).hasAnalysis,true);assert.equal(f.plugin.diagnostic(f.reader).ui.analysisBusy,false);f.release();await tick();assert.match(f.notice.textContent,/保留已完成高亮/);assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
});
test('paragraph translation replans after each completion, keeps completed rows and enables immediate original toggle',async()=>{
 const f=fixture({paragraphs:true});f.buttons[2].click();await tick();const state=f.plugin.diagnostic(f.reader);assert.deepEqual([...state.translation.order],['p0','p2','p1']);assert.equal(state.translation.done,3);assert.equal(state.translation.visible,true);assert.equal(state.ui.translationBusy,false);assert.equal(f.buttons[3].disabled,false);assert.equal(f.calls.filter(c=>c.method==='POST').length,3);
});
test('toolbar cancellation while submission is pending remains terminal and restart replaces its own old callbacks',async()=>{
  const f=fixture({holdSubmit:true});f.buttons[0].click();await tick();assert.equal(f.buttons[0].textContent,'暂停高亮');f.buttons[0].click();await tick();assert.match(f.notice.textContent,/已暂停/);f.release();await tick();assert.equal(f.plugin.diagnostic(f.reader).hasAnalysis,false);assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
  const previous=f.group;f.plugin.stop();f.plugin.start({id:'test-plugin'});assert.equal(previous.isConnected,false);assert.equal(f.root.children.length,1);assert.equal(f.exports(),8);
});

test('automatic full-document scheduler reads offscreen text and reorders remaining pages after navigation without resubmission',async()=>{
 const f=fixture({auto:true,total:4,onSubmit:(body,app)=>{if(body.blocks[0].id==='pdf-page-1')app.pdfViewer.currentPageNumber=4;}});
 f.flushTimers();await tick();
 assert.deepEqual(f.calls.filter(c=>c.method==='POST').map(c=>c.body.blocks[0].id),['pdf-page-1','pdf-page-4','pdf-page-3','pdf-page-2']);
 assert.equal(f.plugin.diagnostic(f.reader).document.done,4);
 const posts=f.calls.filter(c=>c.method==='POST').length,before=f.paintCounts().cleared;
 f.changePage(2);f.emit('textlayerrendered',{pageNumber:2});f.flushTimers();await tick();f.changePage(1);f.flushTimers();await tick();
 assert.equal(f.plugin.diagnostic(f.reader).hasAnalysis,true);assert.equal(f.plugin.diagnostic(f.reader).paint.painted,2);assert.equal(f.paintCounts().cleared,before);assert.equal(f.calls.filter(c=>c.method==='POST').length,posts);
 f.buttons[1].click();await tick();f.flushTimers();await tick();assert.equal(f.plugin.diagnostic(f.reader).document.enabled,false);assert.equal(f.plugin.diagnostic(f.reader).document.pages.length,0);assert.equal(f.calls.filter(c=>c.method==='POST').length,posts);
});

test('translation keeps source analysis, hides source paint and rebuilds original heat on every roundtrip',async()=>{
 const f=fixture({paragraphs:true});f.buttons[0].click();await tick();const before=f.paintCounts().cleared;
 f.buttons[2].click();assert.match(f.notice.textContent,/已收到点击/);await tick();assert.equal(f.plugin.diagnostic(f.reader).hasAnalysis,true);assert.equal(f.plugin.diagnostic(f.reader).translation.visible,true);assert.ok(f.paintCounts().cleared>before);
 const sourcePaints=f.paintCounts().painted,sourcePosts=f.calls.filter(c=>c.method==='POST').length;
 f.buttons[3].click();await tick();assert.equal(f.plugin.diagnostic(f.reader).translation.visible,false);assert.equal(f.plugin.diagnostic(f.reader).hasAnalysis,true);assert.equal(f.paintCounts().painted,sourcePaints+1);assert.equal(f.calls.filter(c=>c.method==='POST').length,sourcePosts);
 const beforeReuse=f.calls.filter(c=>c.method==='POST').length;f.buttons[2].click();await tick();assert.equal(f.plugin.diagnostic(f.reader).translation.visible,true);assert.equal(f.calls.filter(c=>c.method==='POST').length,beforeReuse);
 const posts=f.calls.filter(c=>c.method==='POST').length;f.flushTimers();await tick();assert.equal(f.calls.filter(c=>c.method==='POST').length,posts);
 f.buttons[0].click();await tick();assert.equal(f.plugin.diagnostic(f.reader).document.enabled,false);f.buttons[2].click();await tick();f.flushTimers();await tick();assert.equal(f.plugin.diagnostic(f.reader).document.enabled,false);
});

test('a tab whose PDF initializes after its toolbar waits without errors and then reports the actual total',async()=>{
 const f=fixture({auto:true,ready:false,total:3});f.flushTimers();await tick();
 assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(f.plugin.diagnostic(f.reader).document.total,null);
 assert.match(f.notice.textContent,/等待 PDF/);assert.doesNotMatch(f.notice.textContent,/undefined/);assert.equal(f.plugin.diagnostic(f.reader).document.enabled,true);
 f.makeReady();f.flushTimers();await tick();assert.equal(f.plugin.diagnostic(f.reader).document.total,3);assert.equal(f.plugin.diagnostic(f.reader).document.done,3);assert.doesNotMatch(f.notice.textContent,/undefined/);assert.equal(f.errors.length,0);
});

test('switching tabs preempts the old job, keeps its partial heat and immediately starts the selected reader',async()=>{
 const f=fixture({auto:true,secondTab:true,incremental:true});f.flushTimers();await tick();
 assert.equal(f.plugin.diagnostic(f.reader).ui.analysisBusy,true);assert.equal(f.plugin.diagnostic(f.reader).hasAnalysis,true);
 const cleared=f.paintCounts().cleared;f.changeTab('second');
 assert.equal(f.plugin.diagnostic(f.reader).ui.analysisBusy,false);assert.equal(f.plugin.diagnostic(f.reader).hasAnalysis,true);assert.equal(f.paintCounts().cleared,cleared);
 f.flushTimers();await tick();assert.equal(f.plugin.diagnostic(f.secondReader).hasAnalysis,true);assert.equal(f.plugin.diagnostic(f.secondReader).document.total,1);
 assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
 f.release();await tick();assert.equal(f.plugin.diagnostic(f.reader).document.done,0);assert.equal(f.plugin.diagnostic(f.reader).document.enabled,true);
 f.changeTab('first');f.flushTimers();await tick();assert.equal(f.plugin.diagnostic(f.reader).document.done,1);assert.equal(f.errors.length,0);
});

test('controls stay bound to their tab when two readers share one attachment and a paused tab remains paused',async()=>{
 const f=fixture({secondTab:true});f.changeTab('second');f.secondButtons[0].click();await tick();
 assert.equal(f.plugin.diagnostic(f.secondReader).hasAnalysis,true);assert.equal(f.plugin.diagnostic(f.reader).hasAnalysis,false);
 f.secondButtons[0].click();await tick();f.changeTab('first');f.changeTab('second');f.flushTimers();await tick();
 assert.equal(f.plugin.diagnostic(f.secondReader).document.enabled,false);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 f.plugin.stop();f.changeTab('first');assert.equal(f.root.children.length,0);
});

test('page changes refresh the visible page immediately while a different page is still processing',async()=>{
 const f=fixture({auto:true,total:4,incremental:true});f.flushTimers();await tick();f.changePage(4);
 assert.equal(f.plugin.diagnostic(f.reader).page,4);assert.match(f.notice.textContent,/当前第 4 页/);assert.match(f.notice.textContent,/后台分析第 1 页/);
 f.release();await tick();assert.equal(f.plugin.diagnostic(f.reader).document.total,4);assert.doesNotMatch(f.notice.textContent,/undefined/);
});


test('live appearance poll repaints paused existing heat and translations without submitting another job',async()=>{
 const f=fixture({paragraphs:true});await tick();f.buttons[0].click();await tick();f.buttons[2].click();await tick();f.buttons[0].click();await tick();
 const before=f.paintCounts().painted,posts=f.calls.filter(c=>c.method==='POST').length;
 f.setAppearance({style:'background',hue:210,intensity:.75});await f.poll();
 assert.equal(f.plugin.diagnostic(f.reader).settings.hue,210);assert.equal(f.plugin.diagnostic(f.reader).document.enabled,false);assert.equal(f.plugin.diagnostic(f.reader).translation.visible,true);assert.equal(f.translationPaints.at(-1).hue,210);assert.equal(f.translationPaints.at(-1).style,'background');assert.equal(f.paintCounts().painted,before,'hidden source layer is not repainted with translation geometry');assert.equal(f.calls.filter(c=>c.method==='POST').length,posts);
 const painted=f.paintCounts().painted;await f.poll();assert.equal(f.paintCounts().painted,painted);assert.equal(f.plugin.diagnostic(f.reader).appearanceSync.error,null);
});
test('reader refresh failures cannot interrupt appearance synchronization',async()=>{
 const f=fixture();await tick();f.buttons[0].click();await tick();f.failReaderRefresh();f.pollReaders();f.setAppearance({style:'background',hue:275,intensity:1});await f.poll();
 assert.equal(f.plugin.diagnostic(f.reader).settings.hue,275);assert.match(f.plugin.diagnostic(f.reader).appearanceSync.readerError,/刷新异常/);
});
test('overlapping appearance polls coalesce and stopped generations cannot apply late responses',async()=>{
 const f=fixture();await tick();f.holdAppearance();const before=f.calls.filter(c=>c.url.endsWith('/appearance')).length;
 const one=f.plugin.syncAppearance(),two=f.plugin.syncAppearance();assert.equal(one,two);await tick();assert.equal(f.calls.filter(c=>c.url.endsWith('/appearance')).length,before+1);
 f.plugin.stop();f.releaseAppearance();assert.equal(await one,null);assert.equal(f.plugin.diagnostic(f.reader),null);
});

test('unchanged fast appearance checks never scan readers or redraw PDF layers',async()=>{
 const f=fixture();await tick();f.buttons[0].click();await tick();f.buttons[0].click();await tick();
 const readers=f.readerAccesses(),paint=f.paintCounts().painted,posts=f.calls.filter(c=>c.method==='POST').length;
 for(let i=0;i<100;i++)await f.poll();
 assert.equal(f.readerAccesses(),readers);assert.equal(f.paintCounts().painted,paint);assert.equal(f.calls.filter(c=>c.method==='POST').length,posts);assert.ok(f.plugin.diagnostic(f.reader).appearanceSync.checks>=100);
});

test('full-document scoring stores offscreen results without painting every page',async()=>{
 const f=fixture({auto:true,total:40});f.flushTimers();await tick();
 assert.equal(f.plugin.diagnostic(f.reader).document.done,40);
 assert.equal(f.paintCounts().painted,1,'only current viewport is drawn');
 const before=f.paintCounts().painted;f.changePage(20);assert.equal(f.paintCounts().painted,before+1);
 f.setAppearance({style:'fade',hue:0,intensity:1.5});await f.poll();assert.equal(f.paintCounts().painted,before+2);
});

test('translation output receives its own model jobs before proceeding to the next paragraph',async()=>{
 const f=fixture({paragraphs:true});f.buttons[0].click();await tick();const before=f.paintCounts().painted;
 f.buttons[2].click();await tick();
 const jobs=f.calls.filter(c=>c.method==='POST').slice(1);
 assert.deepEqual(jobs.map(c=>c.url.endsWith('/translation-jobs')?'translation':'translated-analysis'),['translation','translated-analysis','translation','translated-analysis','translation','translated-analysis']);
 for(const c of jobs.filter(c=>c.url.endsWith('/jobs'))){assert.equal(c.body.blocks[0].text,'译文');assert.equal(c.body.analysis.mode,'hybrid');assert.match(c.body.blocks[0].id,/^translated-/);}
 const state=f.plugin.diagnostic(f.reader);assert.equal(state.translation.analysisCompleted,3);assert.equal(state.translation.analysisJobId,null);
 assert.equal(f.paintCounts().painted,before,'paragraph completions do not repaint source heat');
 const posts=f.calls.filter(c=>c.method==='POST').length;f.buttons[2].click();await tick();assert.equal(f.calls.filter(c=>c.method==='POST').length,posts,'both translation and translated scores are reused');
});

test('cancelling while translated scoring is submitting retains readable translation and rejects late scores',async()=>{
 const f=fixture({paragraphs:true,holdTranslated:true});f.buttons[0].click();await tick();
 f.buttons[2].click();await tick();assert.equal(f.plugin.diagnostic(f.reader).translation.analysisBusy,true);
 f.buttons[2].click();await tick();const before=f.translationPaints.length;
 f.release();await tick();const state=f.plugin.diagnostic(f.reader);
 assert.equal(state.translation.done,1);assert.equal(state.translation.visible,true);
 assert.equal(state.translation.analysisCompleted,0);assert.equal(state.translation.analysisBusy,false);
 assert.equal(state.ui.translationBusy,false);assert.equal(f.translationPaints.length,before);
 assert.ok(f.calls.some(c=>c.method==='DELETE'));
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/translation-jobs')).length,1);
});

test('switching tabs interrupts translated scoring and prevents stale results from painting the old tab',async()=>{
 const f=fixture({paragraphs:true,holdTranslated:true,secondTab:true});f.buttons[0].click();await tick();
 f.buttons[2].click();await tick();f.changeTab('second');const before=f.translationPaints.length;
 f.release();await tick();const state=f.plugin.diagnostic(f.reader);
 assert.equal(state.translation.analysisCompleted,0);assert.equal(state.translation.done,1);
 assert.equal(state.translation.analysisBusy,false);assert.equal(state.ui.translationBusy,false);
 assert.equal(f.translationPaints.length,before);assert.equal(state.document.enabled,true);
 assert.ok(f.calls.some(c=>c.method==='DELETE'));
});
