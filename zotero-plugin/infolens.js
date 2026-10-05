var InfoLensPlugin = (() => {
  const states=new Map();let pluginID,timer,readerTimer,tabObserver,token=null,tokenPort=null,central=null,polling=false,stopped=true,lifecycle=0,appearanceFlight=null;
  let centralReading=null;
  let appearanceSync={revision:null,checks:0,changedAt:null,error:null,readerError:null};
  const delay=ms=>Zotero.Promise.delay(ms);
  function port() {const n=Zotero.Prefs.get('extensions.infolens.port',true) ?? 43187;if(!Number.isInteger(n)||n<1||n>65535)throw new Error('InfoLens 本机端口无效。');return n;}
  async function request(method,path,body,retry=true) {
    if(!['GET','POST','DELETE'].includes(method)||!/^\/v1\/(session|appearance|reading|status|translation-jobs|jobs(?:\/[a-f\d]{24})?)$/.test(path))throw new Error('不支持的本机请求。');
    const p=port();if(tokenPort!==p){token=null;tokenPort=p;}
    if(path!=='/v1/session'&&!token) {
      const session=await request('GET','/v1/session');
      if(!['local_base','local_models'].includes(session.source))throw new Error('请启动 InfoLens 本地模型服务；演示结果不能作为 PDF 模型高亮。');
      token=session.token;
    }
    const headers={'X-InfoLens-Client':'zotero-plugin'};
    if(token)headers.Authorization='Bearer '+token;
    if(body)headers['Content-Type']='application/json';
    const xhr=await Zotero.HTTP.request(method,`http://127.0.0.1:${p}${path}`,{headers,body:body?JSON.stringify(body):undefined,responseType:'json',successCodes:false,timeout:10000,debug:false,logBodyLength:0,anon:true,followRedirects:false,errorDelayMax:0});
    if(xhr.status===401&&retry&&path!=='/v1/session'){token=null;return request(method,path,body,false);}
    if(xhr.status<200||xhr.status>=300)throw new Error(xhr.response?.error?.message||`本机服务返回 ${xhr.status}`);
    return xhr.response;
  }
  const defaults={style:'underline',hue:0,intensity:1};
  function pdf(reader,number=null){
    if(reader.type!=='pdf')throw new Error('首版仅支持带文字层的 PDF。');
    const view=reader._internalReader?._primaryView,win=view?._iframeWindow?.wrappedJSObject||view?._iframeWindow,app=win?.PDFViewerApplication;
    if(!app?.pdfViewer||!app.pdfDocument||!Number.isInteger(app.pdfDocument.numPages)||app.pdfDocument.numPages<1)throw new Error('PDF 阅读器尚未就绪。');
    number=number??app.pdfViewer.currentPageNumber;const pageView=app.pdfViewer.getPageView(number-1);
    return {win,app,number,page:pageView?.div,rotation:pageView?.viewport?.rotation||0,total:app.pdfDocument.numPages};
  }
  function active(s){
    try{const selected=Zotero.getMainWindow?.()?.Zotero_Tabs?.selectedID,id=s.reader.tabID??s.reader._tabID;
      if(selected&&id)return selected===id;
      if(s.reader._window)return s.reader._window.document?.hasFocus?.()??false;
      return Zotero.Reader._readers.find(r=>r.type==='pdf')===s.reader;
    }catch{return false;}
  }
  function record(s,n){let r=s.pages.get(n);if(!r){r={number:n,status:'pending',analysis:null,sourceText:null,snapshot:null,paint:null,sequence:0,updates:0,translation:null};s.pages.set(n,r);}return r;}
  function viewed(s){try{return s.pages.get(pdf(s.reader).number);}catch{return null;}}
  function counts(s){const rows=[...s.pages.values()];return {done:rows.filter(r=>r.status==='completed').length,skipped:rows.filter(r=>r.status==='skipped').length,failed:rows.filter(r=>r.status==='failed').length};}
  function totalLabel(s){return Number.isInteger(s.total)&&s.total>0?s.total:'页数加载中';}
  function viewLabel(s){const c=counts(s);let n;try{n=pdf(s.reader).number;}catch{return '正在等待 PDF 阅读器就绪';}const r=s.pages.get(n);
    return `当前第 ${n} 页${r?.paint?' · 已显示 '+r.paint.painted+' 片段':r?.status==='completed'?' · 已分析':' · 等待分析'} · 全文 ${c.done}/${totalLabel(s)} 页${s.analysisBusy&&s.activePage!==n?' · 后台分析第 '+s.activePage+' 页':''}${!s.autoEnabled?' · 高亮已暂停':''}`;
  }
  function feedback(s,text,error=false){s.lastFeedback=text;s.lastError=error?text:null;if(s.notice){s.notice.hidden=false;if(s.notice.textContent!==text)s.notice.textContent=text;const background=error?'#fff0ee':'#edf6fa',border=error?'#ca645d':'#8faab7';if(s.notice.style.backgroundColor!==background)s.notice.style.backgroundColor=background;if(s.notice.style.borderColor!==border)s.notice.style.borderColor=border;}}
  function controls(s){
    if(s.button){s.button.textContent=s.autoEnabled?'暂停高亮':'继续高亮';s.button.setAttribute('aria-busy',String(!!s.analysisBusy));}
    if(s.translateButton){s.translateButton.textContent=s.translationBusy?'取消翻译':'翻译本页';s.translateButton.setAttribute('aria-busy',String(!!s.translationBusy));}
    const t=viewed(s)?.translation;if(s.toggle){s.toggle.disabled=!t?.blocks.some(b=>b.status==='ready');s.toggle.textContent=t?.show?'显示原文':'显示译文';}
  }
  function label(s,text){s.message=text;controls(s);const c=counts(s);
    if(s.translationBusy||s.translationError||viewed(s)?.translation?.show)feedback(s,(s.translationMessage||'已显示译文')+` · 高亮 ${c.done}/${totalLabel(s)} 页`,!!s.translationError);
    else feedback(s,text,!!s.analysisError);
  }
  function current(s,g){return !stopped&&!s.disposed&&s.generation===g&&states.get(s.reader)===s;}
  function cancel(s,pause=true){s.generation++;if(pause)s.autoEnabled=false;s.analysisBusy=false;const job=s.jobId;s.jobId=null;cancelTranslatedAnalysis(s);
    if(s.activePage){const r=s.pages.get(s.activePage);if(r?.status==='running')r.status='pending';}s.activePage=null;controls(s);
    if(job)request('DELETE','/v1/jobs/'+job).catch(()=>{});
  }
  function removeLayer(s){for(const r of s.pages.values()){if(r.snapshot)InfoLensCore.clear(r.snapshot.page);if(r.translation?.snapshot)InfoLensCore.clearTranslation(r.translation.snapshot.page);r.snapshot=null;r.paint=null;if(r.translation){r.translation.snapshot=null;r.translation.paint=null;}}}
  function clear(reader){const s=states.get(reader);if(!s)return;cancel(s);cancelTranslation(s,false);removeLayer(s);s.pages.clear();s.analysisError=s.translationError=null;label(s,'已清除全文临时高亮和译文 · 点击继续高亮可重新分析');}
  function visiblePages(s){const p=pdf(s.reader),visible=new Set([p.number]);try{for(const v of p.app.pdfViewer._getVisiblePages?.().views||[])visible.add(v.id);}catch{}return visible;}
  function visibleRecords(s,number){if(!active(s))return [];const visible=visiblePages(s);return (number===null?[...visible].map(n=>s.pages.get(n)):[s.pages.get(number)]).filter(r=>r&&visible.has(r.number));}
  const captured=(page,text,previous,content=null)=>InfoLensCore.captureCached?InfoLensCore.captureCached(page,text,previous,content):InfoLensCore.capture(page,text,content);
  function repaint(s,number=null){
    const rows=visibleRecords(s,number);
    for(const r of rows){if(!r.analysis)continue;try{
      const p=pdf(s.reader,r.number);if(p.page?.isConnected===false||!p.page)continue;
      // Source and translation have separate scoring and geometry ownership.
      // Hidden source layers must not be reused after a translated render.
      if(r.translation?.show){InfoLensCore.clear(p.page);r.paint=null;continue;}
      const next=captured(p.page,r.sourceText,r.snapshot,r.textContent);r.snapshot=next;r.paint=InfoLensCore.paint(next,InfoLensCore.selectAnalysis(r.analysis,centralReading?.effective).blocks?.[0]?.candidates||[],central||defaults,p.rotation);
    }catch{if(r.snapshot)InfoLensCore.clear(r.snapshot.page);r.snapshot=null;r.paint=null;}}
    repaintTranslation(s,number);controls(s);
  }
  function syncAppearance(){
    if(appearanceFlight)return appearanceFlight;
    const epoch=lifecycle,requestPort=port();
    const task=(async()=>{try{
      const doc=await request('GET','/v1/appearance');if(stopped||epoch!==lifecycle||requestPort!==port())return null;
      const next=doc.clients?.zotero?.effective;InfoLensCore.appearance(next);
      const reading=(await request('GET','/v1/reading')).clients?.zotero;if(stopped||epoch!==lifecycle||requestPort!==port())return null;const readingChanged=JSON.stringify(reading)!==JSON.stringify(centralReading),previousReading=centralReading;centralReading=reading;
      if(readingChanged){for(const s of states.values()){if(previousReading&&reading.autoAnalyze!==previousReading.autoAnalyze||!previousReading&&reading.autoAnalyze===false){if(reading.autoAnalyze){s.autoEnabled=true;s.analysisError=null;schedule(s);}else cancel(s);}if((reading.effective.classify&&!previousReading?.effective.classify)||(previousReading?.effective.mode==='information_density'&&reading.effective.mode!=='information_density')){cancel(s,false);for(const r of s.pages.values()){if(r.analysis)r.status='pending';for(const row of r.translation?.blocks||[])if(row.analysis){row.analysisStatus='pending';row.analysisError=null;}}schedule(s);}repaint(s);}}
      appearanceSync.checks++;appearanceSync.revision=doc.revision??null;appearanceSync.error=null;
      if(JSON.stringify(next)!==JSON.stringify(central)){
        central={...next};appearanceSync.changedAt=Date.now();
        for(const s of states.values())try{repaint(s);}catch(e){appearanceSync.readerError=e.message;}
      }
      return {...central};
    }catch(e){if(!stopped&&epoch===lifecycle)appearanceSync.error=e.message;throw e;}})();
    appearanceFlight=task;task.finally(()=>{if(appearanceFlight===task)appearanceFlight=null;}).catch(()=>{});return task;
  }
  function schedule(s){if(stopped||s.disposed||!s.autoEnabled||s.runner||s.translationBusy||s.analysisError||s.autoTimer)return;
    s.autoTimer=setTimeout(()=>{s.autoTimer=null;if(active(s))pump(s).catch(e=>Zotero.logError('InfoLens: '+e.message));},250);
  }
  function attach(reader,button){
    let s=states.get(reader);if(!s){s={reader,generation:0,disposed:false,pages:new Map(),total:null,ready:false,autoEnabled:centralReading?.autoAnalyze!==false,analysisBusy:false,jobId:null,listeners:[],message:'InfoLens · 自动渐进分析全文',translationGeneration:0};states.set(reader,s);}
    if(button)s.button=button;
    try{const {app,total}=pdf(reader);s.total=total;s.ready=true;s.readinessError=null;
      if(s.document&&s.document!==app.pdfDocument){clear(reader);s.autoEnabled=true;}s.document=app.pdfDocument;
      if(s.eventBus!==app.eventBus){for(const [name,fn]of s.listeners)s.eventBus?.off(name,fn);s.listeners=[];s.eventBus=app.eventBus;
        const redraw=(number=null)=>{s.dirtyPages??=new Set();if(number!==null)s.dirtyPages.add(number);clearTimeout(s.redrawTimer);s.redrawTimer=setTimeout(()=>{const pages=[...s.dirtyPages];s.dirtyPages.clear();if(pages.length)for(const n of pages)repaint(s,n);else repaint(s);schedule(s);},150);};
        const textLayer=e=>{if(e?.pageNumber&&!s.pages.has(e.pageNumber))return;const r=s.pages.get(e?.pageNumber);if(r){r.snapshot=null;if(r.translation)r.translation.snapshot=null;}redraw(e?.pageNumber??null);};
        const geometry=()=>{removeLayer(s);redraw();};
        const page=()=>{try{if(s.translationBusy&&s.translationPage!==pdf(reader).number){cancelTranslation(s);translationLabel(s,'翻页已暂停翻译 · 已完成译文按页保留');}repaint(s);label(s,viewLabel(s));schedule(s);}catch{}};
        for(const [name,fn]of [['textlayerrendered',textLayer],['scalechanging',geometry],['rotationchanging',geometry],['pagechanging',page]]){app.eventBus.on(name,fn);s.listeners.push([name,fn]);}
      }
    }catch(e){s.ready=false;s.readinessError=e.message;}
    if(!s.ready&&!s.initWaiting&&!s.initComplete&&reader._initPromise?.then){s.initWaiting=true;reader._initPromise.then(()=>{s.initWaiting=false;s.initComplete=true;if(!stopped&&!s.disposed){attach(reader);refreshSelection();}},()=>{s.initWaiting=false;s.initComplete=true;});}
    controls(s);schedule(s);return s;
  }
  function nextPage(s){const p=pdf(s.reader),visible=new Set();s.total=p.total;try{for(const v of p.app.pdfViewer._getVisiblePages?.().views||[])visible.add(v.id);}catch{}
    const pending=[];for(let n=1;n<=p.total;n++){const r=s.pages.get(n);if(!r||r.status==='pending')pending.push(n);}
    return pending.sort((a,b)=>(a===p.number?0:visible.has(a)?1:2)-(b===p.number?0:visible.has(b)?1:2)||Math.abs(a-p.number)-Math.abs(b-p.number)||a-b)[0];
  }
  async function pageSource(s,n){const p=pdf(s.reader,n),unwrap=v=>Components.utils.waiveXrays?Components.utils.waiveXrays(v):(v?.wrappedJSObject||v);
    if(p.app.pdfDocument.getPage){const page=unwrap(await unwrap(p.app.pdfDocument.getPage(n))),content=unwrap(await unwrap(page.getTextContent({disableNormalization:true})));record(s,n).textContent=content;return InfoLensCore.textContentSource(content);}return InfoLensCore.capture(p.page).text;}
  async function analyzePage(s,n,g){
    const r=record(s,n);r.status='running';s.activePage=n;s.analysisBusy=true;r.sequence=0;label(s,`读取第 ${n} 页 · 可见区域优先`);
    let text;try{text=r.sourceText||await pageSource(s,n);}catch(e){if(current(s,g)&&/扫描页|30,000|没有可映射/.test(e.message)){r.status='skipped';r.reason=e.message;return;}throw e;}
    if(!current(s,g))return;r.sourceText=text;
    const revision=Zotero.Utilities.randomString(16),blockID='pdf-page-'+n;
    let job=await request('POST','/v1/jobs',{schemaVersion:1,document:{id:'zotero-'+s.reader.itemID+'-page-'+n,revision,offsetEncoding:'utf16',normalizationVersion:'lf-v1'},blocks:[{id:blockID,kind:'paragraph',text}],analysis:{profile:'paper',mode:centralReading?.effective.mode||'hybrid',classify:centralReading?.effective.classify===true}});
    if(!current(s,g)){request('DELETE','/v1/jobs/'+job.jobId).catch(()=>{});return;}s.jobId=job.jobId;const hash=job.contentHash,deadline=Date.now()+600000;
    const accept=result=>{const b=result?.analysis?.blocks?.[0];if(result?.revision!==revision||result.contentHash!==hash||b?.id!==blockID||b.text!==text)throw new Error('本机返回的 PDF 快照不匹配。');r.analysis=result.analysis;r.source=result.source;repaint(s,n);};
    while(current(s,g)){
      if(job.status==='completed'){if(job.revision!==revision)throw new Error('PDF 任务版本不匹配。');accept(job.result);r.status='completed';s.jobId=null;return;}
      if(['failed','cancelled'].includes(job.status))throw new Error(job.error?.message||'分析已取消。');
      if(job.partial?.sequence>r.sequence){accept(job.partial);r.sequence=job.partial.sequence;r.updates++;}
      if(Date.now()>deadline)throw new Error('分析超时，请点击继续高亮重试。');
      const stage=({queued:'排队中',model_loading:'加载 Base',semantic_loading:'加载语义模型',density:'信息密度',semantic:'逐句语义'})[job.stage]||'本地分析中',c=counts(s);
      let viewedNumber;try{viewedNumber=pdf(s.reader).number;}catch{}
      label(s,viewedNumber&&viewedNumber!==n?viewLabel(s)+` · ${stage}${job.details?.total?' '+job.details.done+'/'+job.details.total:''}`:`第 ${n} 页 · ${stage}${job.details?.total?' '+job.details.done+'/'+job.details.total:''} · 全文 ${c.done}/${totalLabel(s)} 页${r.paint?' · 已显示 '+r.paint.painted+' 片段':''}`);
      await delay(400);if(!current(s,g))return;job=await request('GET','/v1/jobs/'+s.jobId);
    }
  }
  async function pump(s){
    if(s.runner||!s.autoEnabled||s.translationBusy||!active(s)||s.analysisError)return s.runner;
    attach(s.reader);if(!s.ready){label(s,'正在等待 PDF 阅读器就绪 · 加载完成后自动分析');return;}const g=s.generation;
    const run=(async()=>{try{label(s,'InfoLens · 连接本机');await syncAppearance();
      while(current(s,g)&&s.autoEnabled&&!s.translationBusy&&active(s)){
        const page=viewed(s),row=page?.translation?.blocks.find(b=>b.status==='ready'&&b.analysisStatus!=='completed'&&!b.analysisError);
        if(page?.translation?.show&&row){await analyzeTranslated(s,page,row,()=>current(s,g)&&active(s)&&!s.translationBusy);continue;}
        const n=nextPage(s);if(!n)break;await analyzePage(s,n,g);
      }
      if(current(s,g)){s.analysisBusy=false;s.activePage=null;const c=counts(s),r=viewed(s);label(s,`全文高亮 ${c.done}/${s.total} 页${c.skipped?' · '+c.skipped+' 页无可分析文字':''}${r?.paint?' · 当前 '+r.paint.painted+' 片段':''}${c.done+c.skipped===s.total?' · 已完成':' · 等待当前阅读窗口'}`);}
    }catch(e){if(current(s,g)){const r=s.pages.get(s.activePage);cancel(s);if(r){r.status='failed';r.reason=e.message;}s.analysisError=e.message;label(s,'高亮暂停 · '+e.message+' · 已完成部分保留');}throw e;}
    })();s.runner=run;
    try{await run;return diagnostic(s.reader);}finally{if(s.runner===run)s.runner=null;if(current(s,g)||s.translationBusy===false)schedule(s);}
  }
  async function analyze(reader){const s=attach(reader);s.autoEnabled=true;s.analysisError=null;for(const r of s.pages.values()){if(r.status==='failed')r.status='pending';for(const b of r.translation?.blocks||[])b.analysisError=null;}controls(s);
    if(s.translationBusy){label(s,'全文高亮已排队 · 翻译完成后自动继续');return diagnostic(reader);}return pump(s);}
  function translationLabel(s,text,error=false){s.translationMessage=text;s.translationError=error?text:null;controls(s);feedback(s,text,error);}
  function cancelTranslation(s,resume=true){s.translationGeneration++;s.translationBusy=false;const job=s.translationJob;s.translationJob=null;s.translationCurrent=null;cancelTranslatedAnalysis(s);if(job)request('DELETE','/v1/jobs/'+job).catch(()=>{});controls(s);if(resume)schedule(s);}
  function clearTranslation(reader){const s=states.get(reader);if(!s)return;cancelTranslation(s);for(const r of s.pages.values()){if(r.translation?.snapshot)InfoLensCore.clearTranslation(r.translation.snapshot.page);r.translation=null;r.snapshot=null;}repaint(s);translationLabel(s,'已清除译文 · 原文高亮已恢复');}
  function repaintTranslation(s,number=null){
    const rows=visibleRecords(s,number);
    for(const r of rows){const t=r.translation;if(!t)continue;try{const p=pdf(s.reader,r.number);if(p.page?.isConnected===false||!p.page)continue;const snapshot=captured(p.page,null,t.snapshot,r.textContent);
      if(snapshot.text!==t.text)throw new Error('等待完整文字层重建');t.snapshot=snapshot;
      if(t.show){InfoLensCore.clear(p.page);r.paint=null;t.paint=InfoLensCore.paintTranslation(snapshot,t.blocks.map(row=>({...row,analysis:InfoLensCore.selectAnalysis(row.analysis,centralReading?.effective)})),r.number,p.rotation,{settings:central||defaults,reading:centralReading?.effective});}
      else{InfoLensCore.clearTranslation(p.page);t.paint=null;}
    }catch{if(t.snapshot)InfoLensCore.clearTranslation(t.snapshot.page);t.paint=null;t.snapshot=null;}}controls(s);
  }
  function cancelTranslatedAnalysis(s){s.translationHeatGeneration=(s.translationHeatGeneration||0)+1;s.translatedAnalysisBusy=false;const job=s.translationHeatJob;s.translationHeatJob=null;if(job)request('DELETE','/v1/jobs/'+job).catch(()=>{});}
  async function analyzeTranslated(s,r,row,ownerLive){
    const generation=s.translationHeatGeneration||0;
    const live=()=>!stopped&&!s.disposed&&s.autoEnabled&&(s.translationHeatGeneration||0)===generation&&ownerLive();
    if(!live()||row.status!=='ready'||row.analysisStatus==='completed')return;
    const text=InfoLensCore.translationText?InfoLensCore.translationText(row.translated):row.translated.replace(/\s+/gu,' ').trim(),blockID='translated-'+row.id;
    if(!text)return;let ownedJob=null;row.analysisStatus='running';s.translatedAnalysisBusy=true;
    try{
      const revision=Zotero.Utilities.randomString(16);let job=await request('POST','/v1/jobs',{schemaVersion:1,document:{id:'zotero-'+s.reader.itemID+'-translated-'+r.number+'-'+row.id,revision,offsetEncoding:'utf16',normalizationVersion:'lf-v1'},blocks:[{id:blockID,kind:'paragraph',text}],analysis:{profile:'paper',mode:centralReading?.effective.mode||'hybrid',classify:centralReading?.effective.classify===true}});
      ownedJob=job.jobId;if(!live()){request('DELETE','/v1/jobs/'+ownedJob).catch(()=>{});row.analysisStatus='pending';return;}s.translationHeatJob=ownedJob;
      const hash=job.contentHash,deadline=Date.now()+180000;let sequence=0;
      const accept=result=>{const block=result?.analysis?.blocks?.[0];if(result?.revision!==revision||result.contentHash!==hash||block?.id!==blockID||block.text!==text)throw Error('译文高亮结果与当前译文不匹配。');row.analysis=result.analysis;row.analysisVersion=(row.analysisVersion||0)+1;repaintTranslation(s,r.number);};
      while(live()){
        if(job.status==='completed'){accept(job.result);row.analysisStatus='completed';return;}
        if(['failed','cancelled'].includes(job.status))throw Error(job.error?.message||'译文高亮已取消。');
        if(job.partial?.sequence>sequence){accept(job.partial);sequence=job.partial.sequence;}
        if(Date.now()>deadline)throw Error('译文高亮超时；已完成译文保留。');
        if(s.translationBusy)translationLabel(s,`翻译 ${r.translation.done}/${r.translation.total} 段 · 已显示译文 · 逐词高亮中`);
        await delay(400);if(!live())break;job=await request('GET','/v1/jobs/'+ownedJob);
      }
      row.analysisStatus='pending';
    }catch(e){if(live()){row.analysisStatus='failed';row.analysisError=e.message;Zotero.logError('InfoLens translated highlight: '+e.message);}else row.analysisStatus='pending';}
    finally{if(s.translationHeatJob===ownedJob)s.translationHeatJob=null;if((s.translationHeatGeneration||0)===generation)s.translatedAnalysisBusy=false;if(!live()&&ownedJob)request('DELETE','/v1/jobs/'+ownedJob).catch(()=>{});}
  }
  function toggleTranslation(reader){const s=states.get(reader),r=s&&viewed(s),t=r?.translation;if(!t)return;t.show=!t.show;
    if(!t.show){const p=pdf(reader,r.number);InfoLensCore.clearTranslation(p.page);InfoLensCore.clear(p.page);r.snapshot=null;r.paint=null;}
    repaint(s,r.number);translationLabel(s,t.show?'已显示原位译文 · 高亮来自译文本身的评分':'已恢复原文 · 已按原文重新定位高亮');schedule(s);}
  async function translate(reader,targetLanguage='zh'){
    const s=attach(reader);cancel(s,false);cancelTranslation(s,false);s.translationBusy=true;s.translationError=null;translationLabel(s,'已开始翻译 · 正在读取段落');const g=s.translationGeneration;
    const live=()=>!stopped&&!s.disposed&&s.translationGeneration===g&&states.get(reader)===s;
    try{const p=pdf(reader),r=record(s,p.number);let snapshot;
      if(!r.textContent&&p.app.pdfDocument.getPage)await pageSource(s,p.number);
      for(let i=0;i<8&&live();i++){try{snapshot=captured(p.page,null,r.translation?.snapshot,r.textContent);break;}catch(e){if(i===7)throw e;translationLabel(s,'正在等待当前页文字层 · 仍在处理中');await delay(250);}}
      if(!live())return;const blocks=InfoLensCore.translationBlocks(snapshot,p.number);if(!blocks.length)throw new Error('当前页没有可翻译段落。');
      let t=r.translation;
      if(!t||t.text!==snapshot.text||t.targetLanguage!==targetLanguage){if(t?.snapshot)InfoLensCore.clearTranslation(t.snapshot.page);t=r.translation={text:snapshot.text,targetLanguage,blocks:[],show:false,order:[],total:blocks.length,done:0,status:'pending'};}
      t.snapshot=snapshot;s.translationPage=p.number;if(t.blocks.some(b=>b.status==='ready')){t.show=true;repaint(s,p.number);}
      const complete=new Set(t.blocks.filter(b=>b.status==='ready').map(b=>b.id)),pending=new Set(blocks.filter(b=>!complete.has(b.id)).map(b=>b.id)),lookup=new Map(blocks.map(b=>[b.id,b]));
      while(live()&&pending.size){const view=pdf(reader);if(view.number!==p.number){cancelTranslation(s);translationLabel(s,'翻页已暂停翻译 · 已完成部分保留');return;}
        const fresh=captured(view.page,null,t.snapshot,r.textContent);if(fresh.text!==snapshot.text)throw new Error('翻译期间文字层发生变化，请重试。');t.snapshot=fresh;
        const prioritized=InfoLensCore.prioritize(InfoLensCore.translationPlan(fresh,p.number),pending,view.app.pdfViewer.container?.getBoundingClientRect()),block=lookup.get(prioritized[0]?.id);if(!block)throw new Error('PDF 段落定位失效。');
        s.translationCurrent=block.id;t.order.push(block.id);translationLabel(s,`翻译 ${t.done}/${t.total} 段 · 优先可见区域 · 等待本地模型`);
        const revision=Zotero.Utilities.randomString(16);let job=await request('POST','/v1/translation-jobs',{schemaVersion:1,document:{id:'zotero-'+reader.itemID+'-page-'+p.number+'-'+block.id,revision,offsetEncoding:'utf16',normalizationVersion:'lf-v1'},blocks:[block],translation:{targetLanguage}});
        if(!live()){request('DELETE','/v1/jobs/'+job.jobId).catch(()=>{});return;}s.translationJob=job.jobId;const hash=job.contentHash,deadline=Date.now()+180000;
        while(live()){
          if(job.status==='completed'){const result=job.result?.analysis,row=result?.blocks?.[0];
            if(job.revision!==revision||job.result?.revision!==revision||job.result?.contentHash!==hash||result?.kind!=='translation'||result.targetLanguage!==targetLanguage||result.blocks?.length!==1||row.id!==block.id||row.source!==block.text)throw new Error('译文与 PDF 段落不匹配。');
            s.translationJob=null;pending.delete(block.id);t.blocks=t.blocks.filter(b=>b.id!==row.id);t.blocks.push(row);t.done=t.blocks.length;
            if(row.status==='ready'){if(t.blocks.filter(b=>b.status==='ready').length===1)t.show=true;repaintTranslation(s,p.number);if(s.autoEnabled)await analyzeTranslated(s,r,row,live);if(!live())return;}
            translationLabel(s,`翻译 ${t.done}/${t.total} 段 · 已显示 ${t.paint?.painted||0} 段${t.paint?.skipped?' · '+t.paint.skipped+' 段空间不足保留原文':''}`);break;
          }
          if(['failed','cancelled'].includes(job.status))throw new Error(job.error?.message||'翻译已取消。');if(Date.now()>deadline)throw new Error('翻译超时，请重试。');
          const stage=({queued:'排队中',model_loading:'加载本地模型',translation_loading:'加载专用翻译模型',semantic_loading:'加载本地模型',translating:'本地翻译中'})[job.stage]||'处理中';
          translationLabel(s,`翻译 ${t.done}/${t.total} 段 · ${stage} · 已完成部分保留`);await delay(300);if(!live())return;job=await request('GET','/v1/jobs/'+s.translationJob);
        }
      }
      if(!live())return;s.translationBusy=false;s.translationCurrent=null;t.status=t.blocks.every(b=>b.status==='ready')?'ready':'partial';repaintTranslation(s,p.number);
      const ready=t.blocks.filter(b=>b.status==='ready').length,scored=t.blocks.filter(b=>b.analysisStatus==='completed').length,failed=t.blocks.filter(b=>b.analysisError).length;
      translationLabel(s,ready?`翻译完成 · ${ready}/${t.total} 段有效译文 · 译文高亮 ${scored}/${ready} 段${failed?' · '+failed+' 段评分失败，继续高亮可重试':''}${t.paint?.skipped?' · 部分空间不足保留原文':''}`:'翻译未产生有效结果 · 原文保留，请重试或检查本地模型',!ready);return diagnostic(reader);
    }catch(e){if(live()){cancelTranslation(s,false);translationLabel(s,'翻译中断 · '+e.message+' · 已完成部分保留',true);}throw e;}
    finally{if(live()){s.translationBusy=false;controls(s);}schedule(s);}
  }
  function diagnostic(reader){const s=states.get(reader);if(!s)return null;const r=viewed(s),t=r?.translation,c=counts(s);let page=null;try{page=pdf(reader).number;}catch{}return {page,jobId:s.jobId,source:r?.source||null,hasAnalysis:!!r?.analysis,message:s.message,paint:r?.paint?{...r.paint}:null,settings:central?{...central}:null,appearanceSync:{...appearanceSync},incremental:{updates:r?.updates||0,sequence:r?.sequence||0},document:{enabled:s.autoEnabled,ready:s.ready,readinessError:s.readinessError||null,total:s.total,...c,activePage:s.activePage,pages:[...s.pages.values()].map(p=>({number:p.number,status:p.status,hasAnalysis:!!p.analysis,updates:p.updates,paint:p.paint?{...p.paint}:null,translationRows:p.translation?.blocks.length||0,reason:p.reason||null}))},ui:{clicks:s.clicks||0,analysisBusy:!!s.analysisBusy,translationBusy:!!s.translationBusy,lastFeedback:s.lastFeedback||'',lastError:s.lastError||null},translation:{analysisCompleted:t?.blocks.filter(b=>b.analysisStatus==='completed').length||0,analysisJobId:s.translationHeatJob||null,analysisBusy:!!s.translatedAnalysisBusy,analysisErrors:t?.blocks.filter(b=>b.analysisError).map(b=>({id:b.id,error:b.analysisError}))||[],done:t?.done||0,total:t?.total||0,current:s.translationCurrent||null,order:[...(t?.order||[])],pendingJob:s.translationJob||null,available:!!t,visible:!!t?.show,message:s.translationMessage||'',paint:t?.paint?{...t.paint}:null}};}
  function toolbar({reader,doc,append}) {
    if(reader.type!=='pdf')return;
    if(doc.querySelector('.infolens-toolbar'))return;
    // Zotero's Windows toolbar is a native window-drag region. Custom controls
    // must opt out, or trusted mouse clicks never reach DOM event listeners.
    const group=doc.createElement('span');group.className='infolens-toolbar';group.style.cssText='display:inline-flex;gap:4px;align-items:center;font-size:11px;white-space:nowrap;flex-shrink:0;-moz-window-dragging:no-drag;';
    const button=doc.createElement('button'),reset=doc.createElement('button'),translateButton=doc.createElement('button'),toggle=doc.createElement('button');button.type=reset.type=translateButton.type=toggle.type='button';
    const brand=doc.createElement('span');brand.textContent='InfoLens';brand.style.cssText='font-weight:600;white-space:nowrap;';
    for(const node of [button,reset,translateButton,toggle]){node.className='toolbar-button infolens-action';node.setAttribute('data-tabstop','1');node.style.cssText='padding:3px 6px;border:1px solid #aebbc2;border-radius:4px;white-space:nowrap;min-height:26px;width:auto;-moz-window-dragging:no-drag;';}
    const notice=doc.createElement('div');notice.className='infolens-status';notice.hidden=true;notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
    notice.style.cssText='position:fixed;right:12px;bottom:14px;max-width:calc(100vw - 32px);padding:9px 12px;border:1px solid #8faab7;border-radius:6px;background:#edf6fa;color:#172b34;font:13px/1.45 system-ui;z-index:99999;pointer-events:none;white-space:normal;';
    // A PDF can be opened twice. Bind controls to this reader/tab, not the first
    // reader with the same attachment item ID.
    const resolveReader=()=>Zotero.Reader._readers.includes(reader)?reader:Zotero.Reader._readers.find(r=>(reader.tabID&&r.tabID===reader.tabID)||r._iframeWindow?.document===doc)||reader;
    const bind=(node,action)=>{
      const listener=()=>{
        const active=resolveReader(),s=attach(active,button);s.translateButton=translateButton;s.toggle=toggle;s.notice=notice;s.clicks=(s.clicks||0)+1;
        feedback(s,'InfoLens · 已收到点击');
        Promise.resolve().then(()=>action(active,s)).catch(error=>{feedback(s,'InfoLens · '+error.message,true);Zotero.logError('InfoLens: '+error.message);});
      };
      // Export the callback into the reader's realm explicitly; retain it in the
      // addon scope and accept Zotero's keyboard/programmatic activation events.
      const exported=Components.utils.exportFunction(listener,doc.defaultView);
      node.addEventListener('click',exported,false,true);
    };
    button.title='自动逐句更新、逐页分析全文；可暂停并保留结果。内容只发送到本机。';
    reset.textContent='清除';reset.title='清除临时高亮并取消分析';
    bind(button,(r,s)=>{if(s.autoEnabled){cancel(s);repaint(s);label(s,'高亮已暂停 · 保留已完成高亮');}else return analyze(r);});
    bind(reset,(r,s)=>{clear(r);feedback(s,'已清除全文临时高亮和译文');});
    translateButton.textContent='翻译本页';translateButton.title='逐段本地翻译，优先可见区域；完成后继续全文高亮。';
    toggle.textContent='显示原文';toggle.title='切换原文与译文。PDF 文件保留原文；复制仍使用原文。';toggle.disabled=true;
    bind(translateButton,(r,s)=>{if(s.translationBusy){cancelTranslation(s);translationLabel(s,'翻译已取消 · 保留已完成译文');}else return translate(r);});
    bind(toggle,(r,s)=>{toggleTranslation(r);});
    group.append(brand,button,reset,translateButton,toggle,notice);append(group);const state=attach(reader,button);state.translateButton=translateButton;state.toggle=toggle;state.notice=notice;
    controls(state);if(state.lastFeedback)feedback(state,state.lastFeedback,!!state.lastError);
  }
  function mount(reader){if(reader.type!=='pdf')return;try{const doc=reader._iframeWindow?.document,container=doc?.querySelector('.toolbar .end')||doc?.querySelector('.toolbar');if(container)toolbar({reader,doc,append:n=>container.append(n)});}catch{}}
  function refreshSelection(){if(stopped)return;
    for(const reader of Zotero.Reader._readers)if(!states.has(reader))mount(reader);
    for(const s of [...states.values()]){if(!Zotero.Reader._readers.includes(s.reader)){dispose(s);continue;}attach(s.reader);
      const selected=active(s);if(!selected&&(s.analysisBusy||s.translationBusy||s.translatedAnalysisBusy)){cancel(s,false);if(s.translationBusy){cancelTranslation(s,false);s.translationMessage='切换标签已暂停翻译 · 已完成部分保留';}label(s,'此标签已暂停处理 · 返回后继续');}
      if(selected&&(s.wasActive!==true||s.lastViewedPage!==pdfNumber(s))){repaint(s);label(s,s.analysisError?'高亮暂停 · '+s.analysisError:viewLabel(s));}
      s.wasActive=selected;s.lastViewedPage=pdfNumber(s);if(selected)schedule(s);
    }
  }
  function pdfNumber(s){try{return pdf(s.reader).number;}catch{return null;}}
  function dispose(state) {clear(state.reader);state.disposed=true;clearTimeout(state.redrawTimer);clearTimeout(state.autoTimer);for(const [name,fn]of state.listeners)state.eventBus?.off(name,fn);state.button?.parentElement?.remove();states.delete(state.reader);}
  async function poll() {
    if(polling||stopped)return;polling=true;
    const epoch=lifecycle;
    try{if(states.size)await syncAppearance();
    }catch{}finally{if(epoch===lifecycle)polling=false;}
  }
  function refreshReaders(){if(stopped)return;try{refreshSelection();appearanceSync.readerError=null;}catch(e){appearanceSync.readerError=e.message;}}
  function start({id}) {
    pluginID=id;stopped=false;lifecycle++;polling=false;appearanceFlight=null;appearanceSync={revision:null,checks:0,changedAt:null,error:null,readerError:null};Zotero.Reader.registerEventListener('renderToolbar',toolbar,id);
    // Plugin enable/install can occur after a PDF toolbar was already rendered.
    for(const reader of Zotero.Reader._readers)try {
      const doc=reader._iframeWindow?.document,container=doc?.querySelector('.toolbar .end')||doc?.querySelector('.toolbar');
      if(container){doc.querySelectorAll('.infolens-toolbar').forEach(n=>n.remove());toolbar({reader,doc,append:n=>container.append(n)});}
    }catch{}
    tabObserver=Zotero.Notifier?.registerObserver({notify(event,type){if(type==='tab'&&['select','load','add','close'].includes(event))refreshReaders();}},['tab'],'infolens-reader-tabs');
    refreshReaders();timer=setInterval(poll,500);readerTimer=setInterval(refreshReaders,2500);poll();
  }
  function stop() {clearInterval(timer);clearInterval(readerTimer);stopped=true;lifecycle++;appearanceFlight=null;polling=false;if(tabObserver!==undefined)Zotero.Notifier?.unregisterObserver(tabObserver);tabObserver=undefined;Zotero.Reader._unregisterEventListenerByPluginID(pluginID);for(const s of [...states.values()])try{dispose(s);}catch{}for(const reader of Zotero.Reader._readers)try{reader._iframeWindow.document.querySelectorAll('.infolens-toolbar').forEach(n=>n.remove());}catch{}states.clear();token=null;central=null;}
  return {start,stop,analyze,clear,syncAppearance,diagnostic,translate,toggleTranslation,clearTranslation};
})();
