/* PDF text alignment and temporary rendering. No Zotero item/annotation writes.
 * Paint calibration follows InfoLens appearance.mjs; see UPSTREAM-NOTICE.txt. */
var InfoLensCore = (() => {
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

  const heatLayers=new WeakMap(),translationLayers=new WeakMap();
  const clamp = (v, min, max) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
  // DOMRect coordinates are prototype getters, so object spread drops them.
  const rectValue=r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height});
  function rgb(hue) {
    const h = ((hue || 0) % 360 + 360) % 360;
    if (!h) return [255,71,64];
    const c=1-Math.abs(2*(319/510)-1),x=c*(1-Math.abs((h/60)%2-1)),m=319/510-c/2;
    return [[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][Math.floor(h/60)].map(v=>Math.round((v+m)*255));
  }
  function appearance(options={}) {
    if (!['background','foreground','underline','fade'].includes(options.style) || !Number.isFinite(options.hue) || options.hue<0 || options.hue>360 || !Number.isFinite(options.intensity) || options.intensity<0 || options.intensity>1.5) throw new Error('显示偏好格式无效。');
    return {...options, requestedStyle:options.style, fallback:false};
  }
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
  // Blend the existing PDF ink toward its own background. This preserves the
  // PDF fonts and selection layer instead of replacing glyphs or drawing lines.
  function canvasPixel(record,canvas,context,x,y){
    if(x<0||y<0||x>=canvas.width||y>=canvas.height)throw Error('超出画布');
    if(record.pixels===undefined){
      if(canvas.width*canvas.height>16000000)throw Error('画布过大，保留原文墨色');
      record.pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
    }
    const index=(y*canvas.width+x)*4;return record.pixels.subarray(index,index+4);
  }
  function fadeBackground(snapshot,range,record,canvas,context){
    if(!canvas||!context)return null;
    const s=record.segments.get(range.startContainer);if(!s?.rect)return null;
    const b=record.canvasBox||canvas.getBoundingClientRect(),origin=snapshot.box||record.pageBox,dx=record.pageBox.left-origin.left,dy=record.pageBox.top-origin.top;
    const r={...s.rect,left:s.rect.left+dx,right:s.rect.right+dx,top:s.rect.top+dy,bottom:s.rect.bottom+dy};
    if(!b.width||!b.height)return null;
    const signature=JSON.stringify([canvas.width,canvas.height,b.width,b.height,r.left-b.left,r.top-b.top,r.width,r.height]);
    const cached=record.backgrounds.get(s.node);if(cached?.signature===signature)return cached.color;
    let color=null;
    try{
      const pixels=[[r.left+.2,r.top+.1],[r.right-.2,r.top+.1],[r.left+.2,r.bottom-.1],[r.right-.2,r.bottom-.1]].map(([x,y])=>{
        const px=Math.floor((x-b.left)*canvas.width/b.width),py=Math.floor((y-b.top)*canvas.height/b.height);
        if(px<0||py<0||px>=canvas.width||py>=canvas.height)throw Error('超出画布');
        return canvasPixel(record,canvas,context,px,py);
      });
      const safe=pixels.every(p=>p[3]>=250&&Math.min(...p.slice(0,3))>=225&&Math.max(...p.slice(0,3))-Math.min(...p.slice(0,3))<=25)
        &&[0,1,2].every(i=>Math.max(...pixels.map(p=>p[i]))-Math.min(...pixels.map(p=>p[i]))<=18);
      if(safe)color=[0,1,2].map(i=>Math.round(pixels.reduce((n,p)=>n+p[i],0)/pixels.length)).join(',');
    }catch{}
    record.backgrounds.set(s.node,{signature,color});return color;
  }
  function normalizedText(raw) {
    let text='',map=[0];
    for(let i=0;i<raw.length;i++) {
      if(raw[i]==='\r') {if(raw[i+1]==='\n')i++;text+='\n';map.push(i+1);}
      else {text+=raw[i];map.push(i+1);}
    }
    return {text,map};
  }
  // PDF.js text content exists independently of its recycled DOM text layers.
  // This source is stable across zoom, scrolling and page eviction.
  function textContentSource(content) {
    let text='',previous=null;
    for(const item of content.items||[]) {
      if(typeof item.str!=='string'||!item.str.trim())continue;
      const value=normalizedText(item.str).text,t=item.transform;
      const rect=t?{left:t[4],top:-t[5],height:Math.abs(item.height)||Math.hypot(t[2],t[3]),right:t[4]+Math.abs(item.width)}:null;
      if(previous){const a=previous,b=rect;
        const same=a&&b&&Math.abs(a.top-b.top)<Math.min(a.height,b.height)*.5&&b.left>=a.left&&b.left-a.right<Math.max(a.height,b.height)*3;
        const wrap=a&&b&&b.top>a.top&&b.top-a.top<Math.max(a.height,b.height)*1.65&&Math.abs(a.left-b.left)<Math.max(a.height,b.height)*2;
        text+=same||wrap?' ':'\n\n';
      }else if(text)text+='\n\n';
      text+=value;previous=rect;
    }
    if(!text.trim())throw new Error('当前 PDF 页没有可映射文字；扫描页暂不支持。');
    if(text.length>30000)throw new Error('当前页超过 30,000 字符；未截断正文。');
    return text;
  }
  function capture(page,sourceText=null,content=null) {
    const layer=page.querySelector('.textLayer');
    if(!layer)throw new Error('当前页的文字层尚未就绪，请稍后重试。');
    const walker=page.ownerDocument.createTreeWalker(layer,4),segments=[];
    let node,text='';
    while((node=walker.nextNode())) {
      const parent=node.parentElement;
      if(!node.data || !node.data.trim() || parent?.closest('.endOfContent,[aria-hidden="true"]'))continue;
      const normalized=normalizedText(node.data);
      let rect=null;
      try{const r=page.ownerDocument.createRange();r.selectNodeContents(node);const measured=[...r.getClientRects()].find(r=>r.width>0&&r.height>0);rect=measured?rectValue(measured):null;}catch{}
      const previous=segments[segments.length-1];
      if(previous){
        const a=previous.rect,b=rect;
        const sameLine=a&&b&&Math.abs(a.top-b.top)<Math.min(a.height,b.height)*.5&&b.left>=a.left&&b.left-a.right<Math.max(a.height,b.height)*3;
        const wrapped=a&&b&&b.top>a.top&&b.top-a.top<Math.max(a.height,b.height)*1.65&&Math.abs(a.left-b.left)<Math.max(a.height,b.height)*2;
        text+=sameLine||wrapped?' ':'\n\n';
      }
      const start=text.length;text+=normalized.text;
      let layoutRect=rect;
      // PDF text spans have explicit glyph size; browser fallback-font Range
      // heights can differ, especially for symbols and subscripts.
      if(parent?.childNodes?.length===1&&parent.getBoundingClientRect){const r=parent.getBoundingClientRect();if(r.width>0&&r.height>0)layoutRect=rectValue(r);}
      segments.push({node,raw:node.data,text:normalized.text,map:normalized.map,start,end:text.length,rect,layoutRect,domLayoutRect:layoutRect});
    }
    if(!text.trim())throw new Error('当前 PDF 页没有可映射的文字层；扫描页暂不支持。');
    if(text.length>30000)throw new Error('当前页超过 30,000 字符，请使用文本导入；未截断正文。');
    if(sourceText!==null){
      let cursor=0;
      for(const s of segments){
        let start=sourceText.indexOf(s.text,cursor);
        // PDF.js normalizes ligatures (ﬁ -> fi), while Zotero's text layer may
        // keep glyphs. Map equivalent graphemes back to the original DOM; an
        // interior offset of an expanded glyph is deliberately not paintable.
        if(start<0||sourceText.slice(cursor,start).trim()){
          const original=normalizedText(s.raw),map=[0];let value='';
          for(const unit of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(original.text)){
            const converted=unit.segment.normalize('NFKC'),end=unit.index+unit.segment.length;
            value+=converted;for(let i=1;i<=converted.length;i++)map.push(i===converted.length?original.map[end]:converted===unit.segment?original.map[unit.index+i]:null);
          }
          start=sourceText.indexOf(value,cursor);
          if(start>=0&&!sourceText.slice(cursor,start).trim()){s.text=value;s.map=map;}
        }
        if(start<0||sourceText.slice(cursor,start).trim())throw new Error('PDF 文字层与分析源不匹配；等待完整重建。');
        s.start=start;s.end=start+s.text.length;cursor=s.end;
      }
      if(sourceText.slice(cursor).trim())throw new Error('PDF 文字层尚未完整重建。');
      text=sourceText;
    }
    const boundaries=new Set([text.length]);
    for(const s of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text))boundaries.add(s.index);
    for(const s of segments)for(let i=0;i<s.map.length;i++)if(s.map[i]===null)boundaries.delete(s.start+i);
    const box=page.getBoundingClientRect?.();
    const snapshot={page,layer,text,segments,boundaries,box:box&&{left:box.left,top:box.top,width:box.width,height:box.height}};
    protectPdfMath(snapshot,content);return snapshot;
  }
  function captureCached(page,sourceText=null,previous=null,content=null){
    const box=page.getBoundingClientRect?.(),old=previous?.box;
    if(previous?.page===page&&unchanged(previous)&&page.querySelector('.textLayer')===previous.layer&&(sourceText===null||sourceText===previous.text)&&(!box||old&&box.width===old.width&&box.height===old.height)){protectPdfMath(previous,content);return previous;}
    return capture(page,sourceText,content);
  }
  function protectPdfMath(snapshot,content){
    if(snapshot.mathContent===content&&snapshot.mathRanges)return;
    const items=(content?.items||[]).filter(i=>typeof i.str==='string'&&i.str.trim()),profiles=new Map();
    for(const item of items){const p=profiles.get(item.fontName)||{prose:0,math:0};
      if(/[\p{L}]{4,}/u.test(item.str))p.prose++;
      if(/^[A-Za-z\d\p{Script=Greek}\s.,;()[\]¼þðÞ=+−∑∫√∞≤≥<>_^]+$/u.test(item.str)&&item.str.trim().length<12)p.math++;
      profiles.set(item.fontName,p);
    }
    let cursor=0;
    for(const s of snapshot.segments){s.math=false;s.layoutRect=s.domLayoutRect||s.layoutRect;s.glyphScaleX=1;const value=s.raw.trim().normalize('NFKC');let index=-1;
      for(let i=cursor;i<Math.min(items.length,cursor+16);i++)if(items[i].str.trim().normalize('NFKC')===value){index=i;break;}
      if(index>=0){cursor=index+1;const item=items[index],p=profiles.get(item.fontName);s.fontName=item.fontName;s.math=!!(p?.math&&!p.prose);
        // With embedded PDF fonts disabled, Zotero uses a fallback font in its
        // selection layer. Its DOM width can differ from the actual canvas ink.
        // The PDF advance width is authoritative; never fit to fallback ink.
        const r=s.layoutRect,height=Math.abs(item.height)||Math.hypot(item.transform?.[2]||0,item.transform?.[3]||0);
        if(r&&height>0&&item.width>0&&item.dir!=='ttb'){
          const width=Math.abs(item.width)*r.height/height,ratio=width/(s.rect?.width||r.width);
          if(Number.isFinite(ratio)&&ratio>=.5&&ratio<=2){s.layoutRect={...r,width,right:r.left+width};s.glyphScaleX=ratio;}
        }
      }
      // These isolated legacy bytes are PDF symbol-font encodings, not prose.
      if(value.length<=10&&/^[¼þðÞ=+−∑∫√∞≤≥≠≈∂∇\p{Script=Greek}]+$/u.test(value))s.math=true;
    }
    // Keep detached small super/subscripts with their mathematical neighbour.
    for(let i=0;i<snapshot.segments.length;i++){const s=snapshot.segments[i],r=s.layoutRect;if(!r||s.math)continue;
      const a=snapshot.segments[i-1],b=snapshot.segments[i+1];
      if(s.text.trim().length<=3&&/^[\dA-Za-z,;()[\].]+$/u.test(s.text.trim())&&[a,b].some(n=>n?.math&&n.layoutRect&&(r.height<n.layoutRect.height*.85||/^[,;()[\].]+$/u.test(s.text.trim()))&&Math.abs(r.left-n.layoutRect.right)<Math.max(r.height,n.layoutRect.height)*1.4&&r.bottom>n.layoutRect.top&&r.top<n.layoutRect.bottom))s.math=true;
    }
    for(const s of snapshot.segments)if(/^\(\d+[a-z]?\)$/iu.test(s.text.trim())&&snapshot.segments.some(n=>n.math&&n.layoutRect&&s.layoutRect&&Math.abs(n.layoutRect.top-s.layoutRect.top)<Math.max(n.layoutRect.height,s.layoutRect.height)*.6))s.math=true;
    const ranges=snapshot.segments.filter(s=>s.math).map(s=>({start:s.start,end:s.end}));
    snapshot.mathRanges=[...ranges,...mathTextRanges(snapshot.text)];snapshot.mathContent=content;delete snapshot.translationPlan;
  }
  function unchanged(snapshot) {
    return snapshot.page.isConnected && snapshot.layer.isConnected && snapshot.segments.every(s=>s.node.isConnected&&s.node.data===s.raw);
  }
  function ranges(snapshot,candidate,verified=false) {
    const {start,end,text}=candidate;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>snapshot.text.length||snapshot.text.slice(start,end)!==text||!snapshot.boundaries.has(start)||!snapshot.boundaries.has(end)||!verified&&!unchanged(snapshot))return [];
    const ranges=[];
    let low=0,high=snapshot.segments.length;
    while(low<high){const mid=(low+high)>>1;if(snapshot.segments[mid].end<=start)low=mid+1;else high=mid;}
    for(let i=low;i<snapshot.segments.length&&snapshot.segments[i].start<end;i++) {const s=snapshot.segments[i];
      const a=Math.max(start,s.start),b=Math.min(end,s.end);
      if(a>=b)continue;
      const range=s.node.ownerDocument.createRange();
      range.setStart(s.node,s.map[a-s.start]);range.setEnd(s.node,s.map[b-s.start]);ranges.push(range);
    }
    return ranges;
  }
// BEGIN SHARED SIGNALS
const normalized=value=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(1,value)):null;
const semanticValue=c=>normalized(Object.hasOwn(c,'semanticNormalized')?c.semanticNormalized:c.semantic);
const smoothUnit=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
const fusionDisplayPolicy=Object.freeze({version:'sentence-selective-density-v1',minimumImportance:.75,sentenceBudget:.5,importantFloor:.36,brightLevel:14,brightMultiplier:2,maxImportantBrightFraction:.85});
let brightThreshold;
function brightScore(){
  if(brightThreshold!==undefined)return brightThreshold;
  let low=0,high=1;for(let i=0;i<40;i++){const mid=(low+high)/2;if(scoreCurve(mid)<(fusionDisplayPolicy.brightLevel-.5)/15)low=mid;else high=mid;}
  return brightThreshold=high+1e-8;
}
// Old cached results without calibration receive a conservative smooth gate.
function sentenceFloor(semantic){return fusionDisplayPolicy.importantFloor*smoothUnit(((normalized(semantic)??0)-.75)/.2);}
function calibrateSentenceDisplay(blocks){
  const policy=fusionDisplayPolicy,H=brightScore(),sentences=blocks.flatMap(b=>b.sentences||[]),known=sentences.filter(s=>normalized(s.semantic)!==null);
  const ranked=[...known].sort((a,b)=>semanticValue(b)-semanticValue(a)),limit=Math.max(1,Math.floor(sentences.length*policy.sentenceBudget));
  const boundary=semanticValue(ranked[Math.min(limit,ranked.length)-1]||{});
  // A tied boundary is left to density; never invent a semantic ranking by ID/position.
  const tiedBoundary=ranked.length>limit&&semanticValue(ranked[limit])===boundary;
  const important=new Set(ranked.filter(s=>s.semantic>=policy.minimumImportance&&semanticValue(s)>=policy.minimumImportance&&(semanticValue(s)>boundary||semanticValue(s)===boundary&&!tiedBoundary)).slice(0,limit).map(s=>s.id));
  const all=blocks.flatMap(b=>b.candidates),eligible=c=>normalized(c.surprisalNormalized)!==null&&normalized(c.semantic)!==null&&c.sentenceIds?.length&&c.sentenceIds.every(id=>important.has(id));
  const pool=all.filter(eligible),baseline=all.filter(c=>normalized(c.surprisalNormalized)!==null&&c.surprisalNormalized>=H).length,inside=pool.filter(c=>c.surprisalNormalized>=H).length;
  const desired=inside+baseline*(policy.brightMultiplier-1),cap=Math.max(inside,Math.floor(pool.length*policy.maxImportantBrightFraction)),target=Math.min(desired,cap);
  const sorted=pool.map(c=>c.surprisalNormalized).sort((a,b)=>b-a);
  let cutoff=1;
  if(target>0){
    if(target>=sorted.length)cutoff=0;
    else if(sorted[target-1]===sorted[target])cutoff=Math.min(H,sorted[target]+1e-8);
    else cutoff=Math.min(H,(sorted[target-1]+sorted[target])/2);
  }
  const calibrated=blocks.map(b=>({...b,candidates:b.candidates.map(c=>({...c,semanticDisplay:{policy:policy.version,important:Boolean(eligible(c)),brightCutoff:cutoff}}))}));
  const brightAfter=calibrated.flatMap(b=>b.candidates).filter(c=>signalScore(c).score>=H).length;
  const raw=known.map(s=>s.semantic).sort((a,b)=>a-b);
  return {blocks:calibrated,metadata:{policy:policy.version,importantSentences:important.size,totalSentences:sentences.length,evaluatedSentences:known.length,eligibleTokens:pool.length,baselineImportantBright:inside,baselineBright:baseline,targetBright:baseline*policy.brightMultiplier,actualBright:brightAfter,brightRatio:baseline?brightAfter/baseline:null,limited:brightAfter<baseline*policy.brightMultiplier,brightLevel:policy.brightLevel,scope:'current_analysis_snapshot',rawImportance:{min:raw[0]??null,max:raw.at(-1)??null,median:raw[Math.floor(raw.length/2)]??null,atLeast75:raw.filter(s=>s>=.75).length,tiedBoundary}}};
}
function signalScore(candidate,{mode='hybrid',alpha=.4,beta=.35,fusion='semantic_floor'}={}){
  mode=({density:'information_density',semantic:'semantic_importance'})[mode]||mode;
  if(!['information_density','semantic_importance','hybrid'].includes(mode))throw new RangeError('Unknown signal mode');
  if(!['semantic_floor','weighted','gated'].includes(fusion))throw new RangeError('Unknown fusion');
  const S=normalized(candidate.surprisalNormalized),M=semanticValue(candidate),MRaw=normalized(candidate.semantic),weight=normalized(alpha)??.4,gate=normalized(beta)??.35;
  let score,missingSignals=[];
  if(mode==='information_density'){score=S;if(S===null)missingSignals=['surprisal'];}
  else if(mode==='semantic_importance'){score=M;if(M===null)missingSignals=['semantic'];}
  else if(S===null||M===null){score=S??M;missingSignals=[...(S===null?['surprisal']:[]),...(M===null?['semantic']:[])];}
  else if(fusion==='semantic_floor'){
    const plan=candidate.semanticDisplay;
    if(plan?.policy===fusionDisplayPolicy.version){
      if(!plan.important)score=S;
      else{
        const H=brightScore(),cutoff=normalized(plan.brightCutoff)??1,B=fusionDisplayPolicy.importantFloor;
        const mapped=S<cutoff?B+(H-B)*smoothUnit(S/cutoff):H+(1-H)*smoothUnit((S-cutoff)/Math.max(1e-9,1-cutoff));
        score=Math.max(S,mapped);
      }
    }else{const floor=sentenceFloor(M);score=floor+(1-floor)*S;}
  }
  else score=fusion==='gated'?S*(gate+(1-gate)*M):weight*S+(1-weight)*M;
  return {score,S,M,MRaw,degraded:missingSignals.length>0,missingSignals};
}
// END SHARED SIGNALS
// BEGIN SHARED READING
const READING_CATEGORIES=['key_finding','definition','constraint','risk','core_logic','boundary_condition','general'];
const READING_DEFAULTS=Object.freeze({distribution:'continuous',budget:.15,categories:[],mode:'hybrid',classify:false});
function readingSettings(value={}){
  const p={...READING_DEFAULTS,...value};
  if(!['continuous','sparse'].includes(p.distribution)||!['information_density','hybrid','semantic_importance'].includes(p.mode)||!Number.isFinite(p.budget)||p.budget<.05||p.budget>.35||typeof p.classify!=='boolean'||!Array.isArray(p.categories)||p.categories.length>READING_CATEGORIES.length||p.categories.some(c=>!READING_CATEGORIES.includes(c))||new Set(p.categories).size!==p.categories.length)throw new Error('阅读设置无效。');
  return {...p,categories:[...p.categories],classify:p.classify||p.categories.length>0};
}
// One selection rule across adapters. Budget counts the union of non-space
// Unicode points; UTF-16 ranges and whole lexical words remain unchanged.
function selectReadingCandidates(candidates,blocks,settings={},score=c=>c.finalScore){
  const p=readingSettings(settings),texts=new Map(blocks.map(b=>[b.id,b.text]));
  const count=text=>Array.from(text).filter(c=>!/^\s$/u.test(c)).length;
  const pool=candidates.filter(c=>{const text=texts.get(c.blockId),s=score(c);return typeof text==='string'&&Number.isInteger(c.start)&&Number.isInteger(c.end)&&c.start>=0&&c.end>c.start&&c.end<=text.length&&Number.isFinite(s)&&(!p.categories.length||p.categories.includes(c.category));});
  if(p.distribution==='continuous')return pool;
  const groups=new Map();
  for(const c of pool){const word=c.densityDisplay,key=JSON.stringify([c.blockId,word?.wordStart??c.start,word?.wordEnd??c.end]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}
  const ranked=[...groups.values()].map(list=>({list,score:Math.max(...list.map(score)),start:Math.min(...list.map(c=>c.start))})).sort((a,b)=>b.score-a.score||a.start-b.start);
  const limit=Math.floor(blocks.reduce((n,b)=>n+count(b.text),0)*p.budget),used=new Map(),chosen=new Set();let covered=0;
  for(const {list} of ranked){const fresh=[];for(const c of list){const seen=used.get(c.blockId)||new Set(),text=texts.get(c.blockId);for(let i=c.start;i<c.end;){const char=String.fromCodePoint(text.codePointAt(i));if(!/^\s$/u.test(char)&&!seen.has(i))fresh.push([c.blockId,i]);i+=char.length;}}
    const unique=new Map(fresh.map(pair=>[JSON.stringify(pair),pair]));if(covered+unique.size>limit)continue;
    for(const [id,i] of unique.values()){if(!used.has(id))used.set(id,new Set());used.get(id).add(i);}covered+=unique.size;for(const c of list)chosen.add(c);
  }
  return pool.filter(c=>chosen.has(c));
}
// END SHARED READING


  const selectedAnalyses=new WeakMap();
  function selectAnalysis(analysis,settings={}){
    if(!analysis)return analysis;const key=JSON.stringify(readingSettings(settings)),old=selectedAnalyses.get(analysis);if(old?.key===key)return old.value;
    const scored=analysis.blocks.flatMap(b=>b.candidates.map(c=>({...c,blockId:b.id,finalScore:signalScore(c,settings).score}))),selected=selectReadingCandidates(scored,analysis.blocks,settings,c=>c.finalScore);
    const value={...analysis,blocks:analysis.blocks.map(b=>({...b,candidates:selected.filter(c=>c.blockId===b.id)}))};selectedAnalyses.set(analysis,{key,value});return value;
  }

  function score(c,options) {return c.finalScore??signalScore(c,options).score;}
  function clear(page) {if(page)heatLayers.delete(page);page?.querySelectorAll(':scope > .infolens-local-layer').forEach(n=>n.remove());}
  function paint(snapshot,candidates,settings,rotation=0) {
    if(!unchanged(snapshot))return {painted:0,skipped:candidates.length,stale:true};
    const options=appearance(settings),doc=snapshot.page.ownerDocument;
    let record=heatLayers.get(snapshot.page);
    if(!record||!record.layer.isConnected){record={layer:doc.createElement('div'),marks:new Map(),backgrounds:new WeakMap(),ranges:new Map()};heatLayers.set(snapshot.page,record);}
    const layer=record.layer;
    const base=snapshot.page.getBoundingClientRect(),sx=(snapshot.page.offsetWidth||snapshot.page.clientWidth)/base.width,sy=(snapshot.page.offsetHeight||snapshot.page.clientHeight)/base.height,color=rgb(options.hue).join(',');
    const geometry=JSON.stringify([base.width,base.height,rotation]),paintKey=JSON.stringify([geometry,options.style,options.hue,options.intensity]);
    if(record.snapshot===snapshot&&record.mathRanges===snapshot.mathRanges&&record.candidates===candidates&&record.paintKey===paintKey&&layer.isConnected)return {...record.result,updated:0,cached:true};
    if(record.snapshot!==snapshot||record.mathRanges!==snapshot.mathRanges||record.geometry!==geometry){record.ranges.clear();record.backgrounds=new WeakMap();}
    layer.className='infolens-local-layer';layer.setAttribute('aria-hidden','true');
    const layerStyle='position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden;user-select:none;'+(options.style==='foreground'?'mix-blend-mode:screen;':'');
    if(layer.style.cssText!==layerStyle)layer.style.cssText=layerStyle;
    const canvas=['fade','foreground'].includes(options.style)?snapshot.page.querySelector('canvas'):null;
    let backdrop=null;try{backdrop=canvas?.getContext('2d');}catch{}
    if(record.canvas!==canvas){record.canvas=canvas;record.backgrounds=new WeakMap();}
    record.pageBox=base;record.canvasBox=canvas?.getBoundingClientRect();
    record.pixels=undefined;
    record.segments=new Map(snapshot.segments.map(s=>[s.node,s]));
    let painted=0,skipped=0,updated=0;const keep=new Set(),add=[],remove=[];
    for(const c of candidates) {
      const value=score(c),rangeKey=c.start+':'+c.end+':'+c.text;
      if(value===null||overlapsMath(c.start,c.end,snapshot.mathRanges||[])){skipped++;continue;}
      let cached=record.ranges.get(rangeKey);
      if(!cached){const list=value===null?[]:ranges(snapshot,c,true);cached={list,rects:list.map(range=>{const segment=record.segments.get(range.startContainer),factor=segment?.glyphScaleX||1,origin=segment?.rect?(segment.rect.left+base.left-(snapshot.box?.left??base.left)):base.left;return [...range.getClientRects()].map(rect=>({left:(origin+(rect.left-origin)*factor-base.left)*sx-snapshot.page.clientLeft,top:(rect.top-base.top)*sy-snapshot.page.clientTop,width:rect.width*factor*sx,height:rect.height*sy}));})};record.ranges.set(rangeKey,cached);}
      const {list}=cached;
      if(!list.length){skipped++;continue;}
      const amount=heatAppearance(value).underlineOpacity;
      const opacity=options.style==='fade'?1-fadeVisibility(value,options.intensity):amount*(options.style==='background'?Math.min(1,options.intensity*.5):Math.min(1,options.intensity));
      if(!opacity)continue;
      const colors=['fade','foreground'].includes(options.style)?list.map(range=>{
        const background=fadeBackground(snapshot,range,record,canvas,backdrop);
        if(background===null)return null;
        // Screen compositing changes dark glyph ink while white paper remains
        // exactly white. Do not tint non-white or uncertain canvas backgrounds.
        return options.style==='fade'?background:Math.min(...background.split(',').map(Number))>=250?color:null;
      }):list.map(()=>color);
      if(colors.every(c=>c===null)){skipped++;continue;}
      const key=c.start+':'+c.end,signature=JSON.stringify([c.text,opacity,colors,options.style,rotation,base.width,base.height]);keep.add(key);
      const old=record.marks.get(key);
      if(old?.signature===signature&&old.nodes.every(n=>n.isConnected)){painted++;continue;}
      const nodes=[];
      let count=0;
      for(const [index,rects]of cached.rects.entries())for(const rect of rects) {
        if(colors[index]===null)continue;
        if(rect.width<=0||rect.height<=0)continue;
        const mark=doc.createElement('div');
        let {left,top,width,height}=rect;
        if(options.style==='underline') {
          const r=((rotation%360)+360)%360;
          if(r===90)width=2;else if(r===180)height=2;else if(r===270){left+=width-2;width=2;}else{top+=height-2;height=2;}
        }
        mark.dataset.infolensStyle=options.style;mark.dataset.infolensSource='original';mark.dataset.infolensStart=String(c.start);mark.dataset.infolensEnd=String(c.end);mark.dataset.infolensText=c.text;
        mark.style.cssText=`position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;background:rgba(${colors[index]},${opacity});pointer-events:none;`;
        nodes.push(mark);count++;
      }
      if(count){add.push(...nodes);remove.push(...old?.nodes||[]);record.marks.set(key,{signature,nodes});painted++;updated++;}else skipped++;
    }
    for(const [key,mark]of record.marks)if(!keep.has(key)){remove.push(...mark.nodes);record.marks.delete(key);}
    if(add.length)layer.append(...add);remove.forEach(n=>n.remove());
    if(!layer.isConnected)snapshot.page.append(layer);
    record.snapshot=snapshot;record.mathRanges=snapshot.mathRanges;record.candidates=candidates;record.paintKey=paintKey;record.geometry=geometry;
    record.pixels=undefined;
    return record.result={painted,skipped,updated,style:options.style,requestedStyle:options.requestedStyle,fallback:options.fallback,stale:false};
  }
  function clearTranslation(page) {if(page)translationLayers.delete(page);page?.querySelectorAll(':scope > .infolens-translation-layer').forEach(n=>n.remove());}
  function segmentRect(s){try{const range=s.node.ownerDocument.createRange();range.selectNodeContents(s.node);return [...range.getClientRects()].filter(r=>r.width>0&&r.height>0).map(rectValue);}catch{return [];}}
  function unionRects(rects){const list=rects.filter(Boolean);if(!list.length)return null;const left=Math.min(...list.map(r=>r.left)),right=Math.max(...list.map(r=>r.right)),top=Math.min(...list.map(r=>r.top)),bottom=Math.max(...list.map(r=>r.bottom));return {left,right,top,bottom,width:right-left,height:bottom-top};}
  function pdfMathToken(segments,key){
    // Layout identifies superscripts/subscripts. Missing PDF ToUnicode mappings
    // cannot be reconstructed as LaTeX: use a reversible opaque formula atom,
    // rather than tell the model that onequarter/eth/thorn are true operators.
    const raw=segments.map(s=>s.text.trim()).join('');
    if(/[¼þðÞ]/u.test(raw)||/\$/u.test(raw))return '$ILM'+key+'$';
    const main=segments.reduce((a,b)=>(a.layoutRect||a.rect)?.height>=(b.layoutRect||b.rect)?.height?a:b),base=main.layoutRect||main.rect;
    let value='';for(const s of segments){const r=s.layoutRect||s.rect,small=base&&r&&r.height<base.height*.85&&/^[A-Za-z0-9]+$/u.test(s.text.trim());
      value+=(small&&value?(r.top>base.top+base.height*.2?'_':r.top<base.top-base.height*.1?'^':''):'')+s.text.trim();}
    return '$'+value+'$';
  }
  function mathParagraph(line){
    const ordered=[...line.segments].sort((a,b)=>(a.layoutRect||a.rect)?.left-(b.layoutRect||b.rect)?.left),math=[];let text='',pending=[];
    const flush=()=>{if(!pending.length)return;const trailing=[];while(pending.length&&/^[,;:.]+$/u.test(pending.at(-1).text.trim()))trailing.unshift(pending.pop());
      const value=pending.map(s=>s.text.trim()).join(' ').trim(),rect=unionRects(pending.map(s=>s.layoutRect||s.rect));
      if(value){const token=pdfMathToken(pending,line.first+'a'+math.length);math.push({token,text:value,rect,segments:pending});text+=(text?' ':'')+token;}
      if(trailing.length)text+=trailing.map(s=>s.text.trim()).join('');pending=[];};
    for(const s of ordered){
      if(s.math){if(pending.length){const a=pending.at(-1).layoutRect||pending.at(-1).rect,b=s.layoutRect||s.rect;if(a&&b&&b.left-a.right>Math.max(a.height,b.height)*.8)flush();}pending.push(s);}
      else {flush();text+=(text?' ':'')+s.text.trim();}
    }
    flush();return {...line,text:text.trim(),math};
  }
  function translationPlan(snapshot,pageNumber) {
    if(snapshot.translationPlan?.pageNumber===pageNumber){
      const box=snapshot.page.getBoundingClientRect?.()||snapshot.box||{left:0,top:0},origin=snapshot.box||box,dx=box.left-origin.left,dy=box.top-origin.top;
      return snapshot.translationPlan.blocks.map(b=>({...b,lines:b.lines.map(l=>({...l,rect:l.rect&&{...l.rect,left:l.rect.left+dx,right:l.rect.right+dx,top:l.rect.top+dy,bottom:l.rect.bottom+dy}}))}));
    }
    const lines=[];
    for(const [index,s]of snapshot.segments.entries()) {
      const rect=s.layoutRect||s.rect||(()=>{const rects=segmentRect(s);return rects.length===1?rects[0]:null;})(),last=lines[lines.length-1];
      const overlap=rect&&last?.rect?Math.min(rect.bottom,last.rect.bottom)-Math.max(rect.top,last.rect.top):0;
      if(rect&&last?.rect&&overlap>=Math.min(rect.height,last.rect.height)*.4&&rect.left-last.rect.right<Math.max(rect.height,last.rect.height)*3&&last.rect.left-rect.right<Math.max(rect.height,last.rect.height)*3){
        last.segments.push(s);last.text+=' '+s.text;last.rect={left:Math.min(last.rect.left,rect.left),right:Math.max(last.rect.right,rect.right),top:Math.min(last.rect.top,rect.top),bottom:Math.max(last.rect.bottom,rect.bottom),width:Math.max(last.rect.right,rect.right)-Math.min(last.rect.left,rect.left),height:Math.max(last.rect.bottom,rect.bottom)-Math.min(last.rect.top,rect.top)};
      }else lines.push({segments:[s],text:s.text,first:index,rect});
    }
    // A translation unit is a complete paragraph, not a rectangle between two
    // variables. Inline formula atoms carry their original PDF glyphs; display
    // equations remain on the source canvas and split adjacent prose groups.
    const prose=[];
    for(const line of lines){
      if(line.segments.some(s=>s.math)&&!line.segments.some(s=>!s.math&&/[\p{L}]{3,}/u.test(s.text))){prose.push({equation:true});continue;}
      prose.push(mathParagraph(line));
    }
    const groups=[];
    let barrier=false;
    for(const line of prose){
      if(line.equation){barrier=true;continue;}
      const last=groups[groups.length-1],prev=last?.lines[last.lines.length-1],a=prev?.rect,b=line.rect;
      const overlap=a&&b?Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left)):0;
      const newItem=/^(?:IV\d+\s*:|\d+[.)]\s|[•●▪]\s)/u.test(line.text),shortHeading=prev&&prev.text.length<35&&!/[.!?:;。；：]$/u.test(prev.text)&&a&&b&&a.width<b.width*.45;
      const indent=a&&b&&b.left-a.left>Math.max(a.height,b.height)*.5&&/[.!?;。；]$/u.test(prev.text);
      const joins=!barrier&&!newItem&&!shortHeading&&!indent&&a&&b&&b.top>a.top&&b.top-a.top<=Math.max(a.height,b.height)*1.7&&Math.abs(a.height-b.height)<=Math.max(a.height,b.height)*.25&&overlap>=Math.min(a.width,b.width)*.55&&Math.abs(b.left-a.left)<Math.max(a.height,b.height)*2&&last.text.length+line.text.length<1800;
      if(joins){last.lines.push(line);last.text=/[A-Za-z]-$/u.test(last.text)&&/^[a-z]/u.test(line.text)?last.text.slice(0,-1)+line.text:last.text+' '+line.text;last.math.push(...line.math);}
      else groups.push({lines:[line],text:line.text,math:[...line.math],first:line.first});
      barrier=false;
    }
    const blocks=groups.map(g=>({...g,id:`pdf-${pageNumber}-paragraph-${g.first}`,kind:'paragraph'}));snapshot.translationPlan={pageNumber,blocks};return blocks;
  }
  function translationBlocks(snapshot,pageNumber) {
    return translationPlan(snapshot,pageNumber).map(({id,kind,text})=>({id,kind,text}));
  }
  function prioritize(plan,pending,viewport) {
    const rank=block=>{
      const rects=block.lines.map(l=>l.rect).filter(Boolean);
      if(!viewport||!rects.length)return [1,block.first];
      const visible=rects.some(r=>r.bottom>viewport.top&&r.top<viewport.bottom&&r.right>viewport.left&&r.left<viewport.right);
      const center=(viewport.top+viewport.bottom)/2,distance=Math.min(...rects.map(r=>Math.abs((r.top+r.bottom)/2-center)));
      return [visible?0:1,distance];
    };
    return plan.filter(b=>pending.has(b.id)).sort((a,b)=>{const x=rank(a),y=rank(b);return x[0]-y[0]||x[1]-y[1]||a.first-b.first;});
  }
  function translationText(text){return text.replace(/\s+/gu,' ').trim();}
  function mixedTranslationParts(text,math){
    if(!math?.length)return [{type:'text',text,start:0,end:text.length}];
    const available=new Map();for(const atom of math){const list=available.get(atom.token)||[];list.push(atom);available.set(atom.token,list);}
    const parts=[];let cursor=0;
    for(const range of mathTextRanges(text)){
      if(range.start>cursor)parts.push({type:'text',text:text.slice(cursor,range.start),start:cursor,end:range.start});
      const token=text.slice(range.start,range.end),atom=available.get(token)?.shift();if(!atom)return null;
      parts.push({type:'math',text:token,start:range.start,end:range.end,atom});cursor=range.end;
    }
    if([...available.values()].some(list=>list.length))return null;
    if(cursor<text.length)parts.push({type:'text',text:text.slice(cursor),start:cursor,end:text.length});return parts;
  }
  function fitMixedTranslationLayout(text,lines,context,size,math){
    if(!math?.length)return fitTranslationLayout(text,lines,context,size);
    const parts=mixedTranslationParts(text,math);if(!parts)return null;
    const units=parts.flatMap(p=>p.type==='math'?[p]:[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(p.text)].map(s=>({type:'text',text:s.segment,start:p.start+s.index,end:p.start+s.index+s.segment.length})));
    context.font=`${size}px "Microsoft YaHei",sans-serif`;
    const geometry=p=>{const scale=size/Math.max(1,p.atom.rect?.height||size);return {width:(p.atom.rect?.width||size)*scale,height:size};};
    const width=items=>{let value=0,plain='';for(const p of items){if(p.type==='math'){value+=context.measureText(plain).width+geometry(p).width;plain='';}else plain+=p.text;}return value+context.measureText(plain).width;};
    let cursor=0;const output=[];
    for(const line of lines){const start=cursor;let low=start,high=units.length;while(low<high){const mid=Math.ceil((low+high)/2);if(width(units.slice(start,mid))<=line.width)low=mid;else high=mid-1;}cursor=low;
      if(cursor<units.length&&units[cursor]?.type==='text'&&units[cursor-1]?.type==='text'&&/[A-Za-z0-9]/u.test(units[cursor].text)&&/[A-Za-z0-9]/u.test(units[cursor-1].text)){let boundary=cursor;while(boundary>start&&units[boundary-1].type==='text'&&/^[A-Za-z0-9]$/u.test(units[boundary-1].text))boundary--;if(boundary>start)cursor=boundary;}
      const runs=[];for(const p of units.slice(start,cursor)){const prev=runs.at(-1);if(p.type==='text'&&prev?.type==='text'){prev.text+=p.text;prev.end=p.end;}else runs.push({...p,...(p.type==='math'?geometry(p):{})});}
      output.push({text:text.slice(units[start]?.start??text.length,units[cursor]?.start??text.length),start:units[start]?.start??text.length,end:units[cursor]?.start??text.length,parts:runs});
    }
    return cursor===units.length?output:null;
  }
  function mathGlyphCanvas(doc,source,canvasBox,snapshot,part){
    if(!source||!canvasBox||!part.atom.rect)throw new Error('PDF formula glyphs unavailable');
    const now=snapshot.page.getBoundingClientRect(),origin=snapshot.box||now,r=part.atom.rect;
    const left=r.left+now.left-origin.left,top=r.top+now.top-origin.top;
    const x=(left-canvasBox.left)*source.width/canvasBox.width,y=(top-canvasBox.top)*source.height/canvasBox.height,w=r.width*source.width/canvasBox.width,h=r.height*source.height/canvasBox.height;
    if(x<-.5||y<-.5||x+w>source.width+.5||y+h>source.height+.5||w<=0||h<=0)throw new Error('PDF formula crop outside page');
    const glyph=doc.createElement('canvas');glyph.width=Math.max(1,Math.ceil(w));glyph.height=Math.max(1,Math.ceil(h));
    glyph.getContext('2d').drawImage(source,x,y,w,h,0,0,glyph.width,glyph.height);
    // PDF.js positions page canvases absolutely. Formula crops must participate
    // in the translated line's inline flow instead of landing at its origin.
    glyph.dataset.infolensMath=part.atom.token;glyph.style.cssText=`position:static !important;left:auto !important;top:auto !important;transform:none !important;margin:0 !important;padding:0 !important;border:0 !important;float:none !important;width:${part.width}px !important;height:${part.height}px !important;vertical-align:middle;display:inline-block !important;`;return glyph;
  }
  function fitTranslationLayout(text,lines,context,size) {
    const value=translationText(text),segments=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value)],units=segments.map(s=>s.segment);let cursor=0;const output=[];
    context.font=`${size}px "Microsoft YaHei",sans-serif`;
    for(const line of lines){const start=cursor;let low=start,high=units.length;
      while(low<high){const mid=Math.ceil((low+high)/2);if(context.measureText(units.slice(start,mid).join('')).width<=line.width)low=mid;else high=mid-1;}
      cursor=low;let part=units.slice(start,cursor).join('');
      if(cursor<units.length&&/[A-Za-z0-9]/u.test(units[cursor])&&/[A-Za-z0-9]/u.test(units[cursor-1]||'')){
        let boundary=cursor;while(boundary>start&&/[A-Za-z0-9]/u.test(units[boundary-1]))boundary--;
        if(boundary>start){cursor=boundary;part=units.slice(start,cursor).join('');}
      }
      const rawStart=segments[start]?.index??value.length,rawEnd=segments[cursor]?.index??value.length,trimmed=part.trim();
      const offset=part.indexOf(trimmed);output.push({text:trimmed,start:rawStart+Math.max(0,offset),end:rawEnd-(part.length-part.trimEnd().length)});
    }
    return cursor===units.length?output:null;
  }
  function fitTranslation(text,lines,context,size){return fitTranslationLayout(text,lines,context,size)?.map(l=>l.text)||null;}
  function translatedRuns(text,line,analysis){
    const block=analysis?.blocks?.[0];if(block?.text!==text)return [{start:line.start,end:line.end,text:line.text,value:null}];
    const candidates=block.candidates||[],runs=[];let cursor=line.start;
    let low=0,high=candidates.length;while(low<high){const mid=(low+high)>>1;if(candidates[mid].end<=line.start)low=mid+1;else high=mid;}
    for(let i=low;i<candidates.length&&candidates[i].start<line.end;i++){const c=candidates[i],lo=Math.max(line.start,c.start),hi=Math.min(line.end,c.end);
      if(hi<=lo||lo<cursor||c.text!==text.slice(c.start,c.end))continue;
      if(lo>cursor)runs.push({start:cursor,end:lo,text:text.slice(cursor,lo),value:null});
      runs.push({start:lo,end:hi,text:text.slice(lo,hi),value:score(c)});cursor=hi;
    }
    if(cursor<line.end)runs.push({start:cursor,end:line.end,text:text.slice(cursor,line.end),value:null});
    return runs;
  }
  function paragraphSignal(block,heat) {
    if(!heat?.snapshot||!unchanged(heat.snapshot))return null;
    const segments=new Map(heat.snapshot.segments.map(s=>[s.node,s]));let weighted=0,total=0;
    for(const line of block.lines)for(const original of line.segments){
      const s=segments.get(original.node);if(!s)continue;
      for(const c of heat.candidates||[]){
        const value=score(c),overlap=Math.max(0,Math.min(s.end,c.end)-Math.max(s.start,c.start));
        if(value!==null&&overlap&&heat.snapshot.text.slice(c.start,c.end)===c.text){weighted+=value*overlap;total+=overlap;}
      }
    }
    return total?weighted/total:null;
  }
  function paintTranslation(snapshot,rows,pageNumber,rotation=0,heat=null) {
    if(!unchanged(snapshot))return {painted:0,skipped:rows.length,stale:true};
    if(rotation%360!==0){clearTranslation(snapshot.page);return {painted:0,skipped:rows.length,reason:'旋转页暂时显示原文；恢复 0° 后重新显示译文。'};}
    const doc=snapshot.page.ownerDocument,base=snapshot.page.getBoundingClientRect(),sx=(snapshot.page.offsetWidth||snapshot.page.clientWidth)/base.width,sy=(snapshot.page.offsetHeight||snapshot.page.clientHeight)/base.height;
    let record=translationLayers.get(snapshot.page);
    if(!record||!record.layer.isConnected){record={layer:doc.createElement('div'),marks:new Map(),layout:new Map(),backgrounds:new Map(),context:doc.createElement('canvas').getContext('2d')};translationLayers.set(snapshot.page,record);}
    const options=heat?.settings?appearance(heat.settings):null,optionsKey=JSON.stringify([rotation,base.width,base.height,options?.style,options?.hue,options?.intensity,heat?.reading]);
    const rowKey=JSON.stringify(rows.map(r=>[r.id,r.status,r.translated,r.analysisVersion||0,r.analysisStatus||null]));
    if(record.snapshot===snapshot&&record.rowKey===rowKey&&record.optionsKey===optionsKey)return {...record.result,updated:0,cached:true};
    if(record.snapshot!==snapshot){record.layout.clear();record.backgrounds.clear();}
    const layer=record.layer;layer.className='infolens-translation-layer';layer.setAttribute('aria-hidden','true');
    layer.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:5;overflow:hidden;user-select:none;';
    const context=record.context,canvas=snapshot.page.querySelector('canvas');let backdrop=null;try{backdrop=canvas?.getContext('2d');}catch{}
    const canvasBox=canvas?.getBoundingClientRect(),lookup=new Map(rows.map(r=>[r.id,r])),keep=new Set(),add=[],remove=[];
    record.pixels=undefined;
    let painted=0,skipped=0,updated=0,highlighted=0,highlightedWords=0,translatedAnalysisParagraphs=0;
    for(const block of translationPlan(snapshot,pageNumber)) {
      const row=lookup.get(block.id);
      if(row?.status!=='ready'||row.source!==block.text||typeof row.translated!=='string'||!row.translated.trim())continue;
      const rects=block.lines.map(l=>l.rect);if(rects.some(r=>!r)){skipped++;continue;}
      const text=translationText(row.translated),hasAnalysis=row.analysis?.blocks?.[0]?.text===text;
      if(!mixedTranslationParts(text,block.math)){skipped++;continue;}
      const signature=JSON.stringify([text,optionsKey,row.analysisVersion||0,hasAnalysis]),old=record.marks.get(block.id);keep.add(block.id);
      if(old?.signature===signature&&old.nodes.every(n=>n.isConnected)){painted++;highlighted+=old.highlighted;highlightedWords+=old.highlightedWords;translatedAnalysisParagraphs+=old.analyzed;continue;}
      const lines=rects.map(r=>({left:(r.left-base.left)*sx-snapshot.page.clientLeft,top:(r.top-base.top)*sy-snapshot.page.clientTop,width:r.width*sx,height:r.height*sy}));
      const layoutKey=JSON.stringify([block.id,text,lines]);let fitted=record.layout.get(layoutKey);
      if(!fitted){const height=Math.min(...lines.map(r=>r.height));let size=height*.82,values=null;
        for(;size>=height*.55;size-=height*.04){values=fitMixedTranslationLayout(text,lines,context,size,block.math);if(values)break;}
        fitted={size,values};record.layout.set(layoutKey,fitted);
      }
      const {size,values}=fitted;if(!values){remove.push(...old?.nodes||[]);record.marks.delete(block.id);skipped++;continue;}
      let background=record.backgrounds.get(block.id);
      if(background===undefined){let color='rgb(255,255,255)',safe=!!backdrop;
        if(backdrop)try{for(const rect of rects){const x=Math.floor((rect.left-canvasBox.left+.2)*canvas.width/canvasBox.width),y=Math.floor((rect.top-canvasBox.top+.1)*canvas.height/canvasBox.height),pixel=canvasPixel(record,canvas,backdrop,Math.max(0,x),Math.max(0,y));
          if(Math.max(pixel[0],pixel[1],pixel[2])-Math.min(pixel[0],pixel[1],pixel[2])>25||Math.min(pixel[0],pixel[1],pixel[2])<225){safe=false;break;}color=`rgb(${pixel[0]},${pixel[1]},${pixel[2]})`;}
        }catch{safe=false;}background=safe?color:null;record.backgrounds.set(block.id,background);
      }
      if(background===null){remove.push(...old?.nodes||[]);record.marks.delete(block.id);skipped++;continue;}
      let wordCount=0;
      let nodes;
      try{nodes=lines.flatMap((line,i)=>{
        const cover=doc.createElement('div'),padX=Math.min(1.5,line.height*.06),padY=Math.min(3,line.height*.18);
        cover.style.cssText=`position:absolute;left:${line.left-padX}px;top:${line.top-padY}px;width:${line.width+padX*2}px;height:${line.height+padY*2}px;background:${background};pointer-events:none;z-index:0;`;
        const translated=doc.createElement('div');translated.dataset.infolensParagraph=block.id;translated.dataset.infolensAnalysis=hasAnalysis?'translated-text':'pending';
        translated.title=hasAnalysis?'本机对译文本身计算信息密度与句子重要度。':'译文高亮信息正在处理中。';
        translated.style.cssText=`position:absolute;left:${line.left}px;top:${line.top}px;width:${line.width}px;height:${line.height}px;background:${background};color:rgb(23,43,52);font-family:"Microsoft YaHei",sans-serif;font-size:${size}px;line-height:${line.height}px;white-space:pre;overflow:hidden;pointer-events:none;z-index:1;`;
        for(const part of values[i].parts||[{type:'text',...values[i]}]){
          if(part.type==='math'){translated.append(mathGlyphCanvas(doc,canvas,canvasBox,snapshot,part));continue;}
          for(const run of translatedRuns(text,part,hasAnalysis?row.analysis:null)){
          const span=doc.createElement('span');span.textContent=run.text;span.dataset.infolensStart=String(run.start);span.dataset.infolensEnd=String(run.end);
          if(options&&run.value!==null){const a=heatAppearance(run.value,options.intensity),color=rgb(options.hue),opacity=a.underlineOpacity;
            span.dataset.infolensScore=String(run.value);span.dataset.infolensStyle=options.style;span.dataset.infolensLevel=String(displayLevel(run.value));wordCount++;
            if(options.style==='fade')span.style.color=`rgba(23,43,52,${a.fadePercent/100})`;
            else if(options.style==='foreground')span.style.color=`rgb(${color.map((v,k)=>Math.round([23,43,52][k]*(1-opacity)+v*opacity)).join(',')})`;
            else if(options.style==='background')span.style.backgroundColor=`rgba(${color.join(',')},${a.backgroundOpacity})`;
            else span.style.cssText=`text-decoration:underline;text-decoration-color:rgba(${color.join(',')},${opacity});text-decoration-thickness:2px;text-underline-offset:2px;`;
          }
          translated.append(span);
          }
        }
        return [cover,translated];
      });}catch{remove.push(...old?.nodes||[]);record.marks.delete(block.id);skipped++;continue;}
      const marked=wordCount>0?1:0;add.push(...nodes);remove.push(...old?.nodes||[]);record.marks.set(block.id,{signature,nodes,highlighted:marked,highlightedWords:wordCount,analyzed:hasAnalysis?1:0});
      painted++;updated++;highlighted+=marked;highlightedWords+=wordCount;translatedAnalysisParagraphs+=hasAnalysis?1:0;
    }
    for(const [id,mark]of record.marks)if(!keep.has(id)){remove.push(...mark.nodes);record.marks.delete(id);}
    if(add.length)layer.append(...add);remove.forEach(n=>n.remove());if(!layer.isConnected)snapshot.page.append(layer);
    record.snapshot=snapshot;record.rowKey=rowKey;record.optionsKey=optionsKey;record.sourceAnalysis=heat?.candidates;
    record.pixels=undefined;
    return record.result={painted,skipped,updated,highlighted,highlightedWords,translatedAnalysisParagraphs,protectedMath:snapshot.mathRanges?.length||0,stale:false};
  }
  return {selectAnalysis,capture,captureCached,protectPdfMath,textContentSource,unchanged,ranges,paint,clear,appearance,heatAppearance,fadeVisibility,score,normalizedText,rgb,translationBlocks,translationPlan,prioritize,fitTranslation,fitTranslationLayout,fitMixedTranslationLayout,mixedTranslationParts,translationText,translatedRuns,clearTranslation,paragraphSignal,paintTranslation};
})();
if(typeof module!=='undefined')module.exports=InfoLensCore;
