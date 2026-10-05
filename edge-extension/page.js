/* Shared Edge content renderer. Source text is never wrapped or rewritten. */
(()=>{
// BEGIN SHARED MATH
const mathDomSelector='math,mjx-container,.katex,.MathJax,.MathJax_Display,.MathJax_SVG,.MathJax_CHTML,.ztext-math,[data-math],[data-tex],[role="math"]';
// Protect source delimiters; offsets always refer to the unchanged UTF-16 text.
// Code spans/fences and escaped dollars are not treated as mathematics.
function mathTextRanges(text){
  const ranges=[];const escaped=i=>{let n=0;while(i>0&&text[--i]==='\\')n++;return n%2===1;};
  for(let i=0;i<text.length;){
    if(text[i]==='`'&&!escaped(i)){let n=1;while(text[i+n]==='`')n++;const marker='`'.repeat(n),end=text.indexOf(marker,i+n);i=end<0?text.length:end+n;continue;}
    let open=null,close=null;
    if(text.startsWith('\\(',i)&&!escaped(i)){open='\\(';close='\\)';}
    else if(text.startsWith('\\[',i)&&!escaped(i)){open='\\[';close='\\]';}
    else if(text[i]==='$'&&!escaped(i)){open=text[i+1]==='$'?'$$':'$';close=open;if(open==='$'&&/\s/u.test(text[i+1]||'')){i++;continue;}}
    else if(text.startsWith('\\begin{',i)&&!escaped(i)){const m=/^\\begin\{(equation\*?|align\*?|gather\*?|math|displaymath)\}/u.exec(text.slice(i));if(m){open=m[0];close='\\end{'+m[1]+'}';}}
    if(!open){i++;continue;}
    let end=text.indexOf(close,i+open.length);
    while(end>=0&&escaped(end))end=text.indexOf(close,end+close.length);
    if(end<0||open==='$'&&(/\s/u.test(text[end-1]||'')||text[end+1]==='$'||/[\n`]/u.test(text.slice(i+1,end)))){i+=open.length;continue;}
    ranges.push({start:i,end:end+close.length});i=end+close.length;
  }
  return ranges;
}
function overlapsMath(start,end,ranges){return ranges.some(r=>start<r.end&&end>r.start);}
// END SHARED MATH

  const version='0.8.19';
  if(globalThis.InfoLensPage?.version===version)return;
  if(globalThis.InfoLensPage?.dispose)globalThis.InfoLensPage.dispose();else globalThis.InfoLensPage?.clear();
  let snapshot=null,paintNames=[],observer=null,changeTimer=null,lastPaint=null,carrySpans=[];
  const skip='script,style,noscript,nav,header,footer,aside,button,input,textarea,select,form,[contenteditable],[aria-live],[role=button],[role=dialog],[role=tooltip],[role=status],[role=toolbar],[role=menu],[role=navigation],[data-infolens-ui],'+mathDomSelector;
  function clear(revision){if(revision&&snapshot?.revision!==revision)return false;for(const name of paintNames)globalThis.CSS?.highlights?.delete(name);paintNames=[];return true;}
  function readable(node){const parent=node.parentElement;if(!parent||parent.closest(skip)||!node.data?.trim()||!parent.getClientRects().length)return false;const s=getComputedStyle(parent);return s.visibility!=='hidden'&&s.display!=='none';}
  function addedText(node,known){
    if(node.nodeType===3)return !known.has(node)&&readable(node);
    if(node.nodeType!==1||node.closest(skip))return false;
    const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text;
    while(text=walker.nextNode())if(!known.has(text)&&readable(text))return true;
    return false;
  }
  function normalize(raw){let text='',boundaries=[0];for(let i=0;i<raw.length;i++){if(raw[i]==='\r'){text+='\n';if(raw[i+1]==='\n')i++;}else text+=raw[i];boundaries.push(i+1);}return {text,boundaries};}
  function collect(){
    const root=document.querySelector('[data-infolens-document]')||document.querySelector('[itemprop="articleBody"]')||document.querySelector('.Post-RichTextContainer .RichText')||document.querySelector('article .RichText.ztext')||document.querySelector('article')||document.querySelector('main')||document.body;
    if(!root||root.isConnected===false)throw new Error('网页正文尚未加载，请稍后点击分析。');
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const groups=new Map();let node;
    while(node=walker.nextNode()){
      const parent=node.parentElement;if(!parent||node.isConnected===false||parent.closest(skip)||!node.data||!parent.getClientRects().length)continue;
      const style=getComputedStyle(parent);if(style.visibility==='hidden'||style.display==='none')continue;
      const block=parent.closest('p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,td')||root;
      if(block===root&&!node.data.trim())continue;
      if(!groups.has(block))groups.set(block,[]);groups.get(block).push(node);
    }
    const entries=[];let total=0;const structured=[...groups.keys()].some(element=>element!==root);
    for(const [element,nodes] of groups){let text='';const pieces=[];
      // Loose article controls/counters are not part of a structured document.
      if(structured&&element===root)continue;
      for(const n of nodes){const norm=normalize(n.data);pieces.push({node:n,raw:n.data,start:text.length,end:text.length+norm.text.length,boundaries:norm.boundaries,color:getComputedStyle(n.parentElement).color});text+=norm.text;}
      if(!text.trim())continue;total+=text.length;
      entries.push({id:`b${entries.length+1}`,kind:/^H[1-6]$/.test(element.tagName)?'heading':element.tagName==='PRE'?'code':'paragraph',text,pieces,element});
    }
    if(!entries.length)throw new Error('没有可分析的正文。');if(total>30000||entries.length>128)throw new Error('正文超过当前 30,000 字符 / 128 块限制，请打开较短文章。未截断正文。');
    return {entries,root};
  }
  function notify(kind){
    try{globalThis.chrome?.runtime?.sendMessage({action:'pageChanged',kind,revision:snapshot?.revision})?.catch(()=>{});}catch{}
  }
  // Match whole blocks, including repeated paragraphs, before reusing any range.
  function matches(oldEntries,current){
    const used=new Set();return oldEntries.map(old=>{
      let index=current.findIndex((b,i)=>!used.has(i)&&b.element===old.element&&b.kind===old.kind&&b.text===old.text);
      if(index<0)index=current.findIndex((b,i)=>!used.has(i)&&b.kind===old.kind&&b.text===old.text);
      if(index>=0)used.add(index);return index;
    });
  }
  function reconcile(){
    if(!snapshot)return false;
    let current;try{current=collect();}catch{snapshot.invalidated=true;for(const b of snapshot.entries)b.stale=true;return false;}
    const indices=matches(snapshot.entries,current.entries);
    snapshot.invalidated=current.entries.length!==snapshot.entries.length||indices.some((index,i)=>index!==i);
    snapshot.root=current.root;
    snapshot.entries.forEach((b,i)=>{const next=current.entries[indices[i]];if(next)Object.assign(b,{pieces:next.pieces,element:next.element,stale:false});else b.stale=true;});
    return !snapshot.invalidated;
  }
  function refresh(){
    changeTimer=null;if(!snapshot)return;
    const intact=reconcile();
    if(lastPaint){try{paint(...lastPaint);}catch{}}
    // A transient node inserted and removed in the same burst needs no GPU work.
    if(!intact){if(!snapshot.notified){snapshot.notified=true;notify('changed');}}
    else{snapshot.notified=false;notify('rebound');}
  }
  function capture(){
    const current=collect(),previous=snapshot,oldPaint=lastPaint;
    clearTimeout(changeTimer);observer?.disconnect();
    carrySpans=[];
    if(previous&&oldPaint){
      const indices=matches(previous.entries,current.entries),ids=new Map(previous.entries.flatMap((b,i)=>indices[i]<0?[]:[[b.id,current.entries[indices[i]].id]]));
      carrySpans=oldPaint[0].spans.filter(s=>ids.has(s.blockId)).map(s=>({...s,blockId:ids.get(s.blockId)}));
    }
    snapshot={revision:crypto.randomUUID(),...current};lastPaint=null;
    const retainedPaint=oldPaint?paint({revision:snapshot.revision,spans:[]},oldPaint[1]):null;
    const {entries,root}=snapshot;
    observer=new MutationObserver(records=>{
      if(!snapshot)return;
      const relevant=records.filter(r=>!(r.target.nodeType===1?r.target:r.target.parentElement)?.closest(skip));
      if(!relevant.length)return;
      if(!relevant.some(r=>r.target===snapshot.root||snapshot.root.contains?.(r.target)||snapshot.entries.some(b=>b.pieces.some(p=>p.node===r.target))||!snapshot.root.isConnected))return;
      if(valid()&&!relevant.some(r=>r.type==='childList'&&[...r.addedNodes].some(n=>addedText(n,new Set()))))return;
      // Drop only changed/disconnected blocks; keep every exact-text block visible.
      if(!snapshot.invalidated&&!valid()){reconcile();if(lastPaint){try{paint(...lastPaint);}catch{}}}
      clearTimeout(changeTimer);changeTimer=setTimeout(refresh,300);
    });observer.observe(document.body||root,{subtree:true,childList:true,characterData:true});
    return {revision:snapshot.revision,blocks:entries.map(({pieces,element,stale,...block})=>block),retainedPaint};
  }
  function valid(){return !!snapshot&&!snapshot.invalidated&&snapshot.root.isConnected!==false&&snapshot.entries.every(b=>!b.stale&&b.pieces.every(p=>p.node.isConnected&&p.node.data===p.raw&&snapshot.root.contains?.(p.node)!==false&&!p.node.parentElement?.closest(skip)));}
  // BEGIN SHARED PAINT
const paintClamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
const appearanceCurve = Object.freeze({x1:.25,y1:0,x2:.5,y2:1,saturation:.8,levels:16});
// Solve x(t)=score/cap, then read y(t). Using score directly as t is not a
// cubic-bezier transfer. Horizontal endpoint tangents also smooth the cap join.
function scoreCurve(score) {
  const x=paintClamp(score,0,1)/appearanceCurve.saturation;
  if(x<=0)return 0;if(x>=1)return 1;
  const axis=(t,a,b)=>3*(1-t)*(1-t)*t*a+3*(1-t)*t*t*b+t*t*t;
  let low=0,high=1;
  for(let i=0;i<30;i++){const t=(low+high)/2;if(axis(t,appearanceCurve.x1,appearanceCurve.x2)<x)low=t;else high=t;}
  return axis((low+high)/2,appearanceCurve.y1,appearanceCurve.y2);
}
// Quantize AFTER the curve, so every client shares the same 16 paint levels.
function displayLevel(score){return Math.round(scoreCurve(score)*(appearanceCurve.levels-1));}
function appearanceAtLevel(level,intensity=1){
  const amount=paintClamp(level,0,15)/15,strength=paintClamp(intensity,0,1.5);
  const floor=.08-.05*Math.max(0,strength-1)*2;
  const normal=floor+(1-floor)*amount,visibility=normal+(1-normal)*(1-Math.min(1,strength));
  return {amount:amount*strength,backgroundOpacity:amount*Math.min(1,strength*.5),
    tintPercent:amount*Math.min(1,strength)*100,underlineOpacity:amount*Math.min(1,strength),fadePercent:visibility*100};
}
function heatAppearance(score,intensity=1){return appearanceAtLevel(displayLevel(score),intensity);}
function fadeVisibility(score,intensity=1){return heatAppearance(score,intensity).fadePercent/100;}
// END SHARED PAINT
  function paint(result,{style='background',intensity=100,rgb='255 71 64'}={}){
    if(!globalThis.CSS?.highlights||typeof Highlight==='undefined')throw new Error('浏览器缺少原生高亮接口，请更新 Edge。');
    if(!result||!Array.isArray(result.spans))throw new Error('分析结果为空或格式无效，请重新分析。');
    if(!snapshot||result.revision!==snapshot.revision)throw Object.assign(new Error('网页快照已更新，旧任务结果已丢弃。'),{code:'document_changed'});
    if(!valid())reconcile();
    if(!['background','foreground','underline','fade'].includes(style)||!Number.isFinite(intensity)||intensity<0||intensity>150||!/^\d{1,3} \d{1,3} \d{1,3}$/.test(rgb)||rgb.split(' ').some(n=>Number(n)>255))throw new Error('非法外观配置。');
    const incoming=result.spans,retained=[];
    if(!result.complete)for(const old of carrySpans){
      const block=snapshot.entries.find(b=>b.id===old.blockId);let cursor=old.start;
      const replacements=incoming.filter(s=>s.blockId===old.blockId&&s.start<old.end&&s.end>old.start).sort((a,b)=>a.start-b.start);
      const keep=end=>{if(end>cursor)retained.push({...old,start:cursor,end,text:block.text.slice(cursor,end)});};
      for(const span of replacements){keep(Math.min(span.start,old.end));cursor=Math.max(cursor,span.end);}
      keep(old.end);
    }
    const spans=[...retained,...incoming];
    const buckets=new Map(),colors=[];let spanCount=0;
    for(const span of spans){if(!span)throw new Error('返回文字范围无效，请重新分析。');const block=snapshot.entries.find(b=>b.id===span.blockId);if(!block||!Number.isInteger(span.start)||!Number.isInteger(span.end)||span.start<0||span.end>block.text.length||span.end<=span.start||typeof span.text==='string'&&span.text!==block.text.slice(span.start,span.end))throw new Error('返回范围无效。');
      if(block.stale||block.kind!=='code'&&overlapsMath(span.start,span.end,block.mathRegions??=mathTextRanges(block.text)))continue;
      const bits=Number(span.surprisalBits);if(!Number.isFinite(bits))throw new Error('返回分数无效。');const score=span.finalScore===undefined?Math.max(0,bits/18):span.finalScore;if(typeof score!=='number'||!Number.isFinite(score))throw new Error('返回显示分数无效。');const level=displayLevel(score);if(style!=='fade'&&level===0)continue;
      for(const piece of block.pieces){const lo=Math.max(span.start,piece.start),hi=Math.min(span.end,piece.end);if(hi<=lo)continue;
        let colorIndex=colors.indexOf(piece.color);if(colorIndex<0){colorIndex=colors.length;colors.push(piece.color);}
        const key=`infolens-${level}-${colorIndex}`;if(!buckets.has(key))buckets.set(key,{level,color:piece.color,ranges:[]});
        const range=document.createRange();range.setStart(piece.node,piece.boundaries[lo-piece.start]);range.setEnd(piece.node,piece.boundaries[hi-piece.start]);buckets.get(key).ranges.push(range);
      }spanCount++;
    }
    const rules=[];const depth=Math.max(0,Math.min(150,Number(intensity)||0))/100;
    for(const [name,{level,color,ranges}] of buckets){CSS.highlights.set(name,new Highlight(...ranges));const appearance=appearanceAtLevel(level,depth),alpha=style==='background'?appearance.backgroundOpacity:appearance.underlineOpacity;let declarations;
      if(style==='background')declarations=`background-color:rgb(${rgb} / ${alpha});`;
      else if(style==='underline')declarations=`text-decoration-line:underline;text-decoration-color:rgb(${rgb} / ${alpha});text-decoration-thickness:.125em;text-underline-offset:.1875em;text-decoration-skip-ink:none;`;
      else if(style==='foreground')declarations=`color:color-mix(in srgb-linear,rgb(${rgb}) ${alpha*100}%,${color});`;
      else declarations=`color:color-mix(in srgb,${color} ${appearance.fadePercent}%,transparent);`;
      rules.push(`::highlight(${name}){${declarations}}`);
    }
    for(const name of paintNames)if(!buckets.has(name))CSS.highlights.delete(name);paintNames=[...buckets.keys()];
    if(result.complete)carrySpans=[];
    lastPaint=[{...result,spans},{style,intensity,rgb}];
    return {cssRules:rules,spanCount,rangeCount:[...buckets.values()].reduce((n,b)=>n+b.ranges.length,0)};
  }
  function stop(revision){if(revision&&snapshot?.revision!==revision)return false;clearTimeout(changeTimer);lastPaint=null;carrySpans=[];observer?.disconnect();return clear(revision);}
  globalThis.InfoLensPage={version,capture,paint,clear,stop,valid,dispose(){stop();snapshot=null;}};
})();
