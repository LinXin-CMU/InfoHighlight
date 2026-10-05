import { canonicalize, contentHash, selectSpans, selectHeatmap } from './engine.mjs';
import { heatAppearance, hueRgb, displayLevel, appearanceAtLevel } from './appearance.mjs';
import { referenceTokens } from './reference-sample.mjs';
import {createClientAppearanceUI} from './client-appearance-ui.mjs';
import {createReadingUI} from './reading-ui.mjs';
import {selectReadingCandidates} from './reading-policy.mjs';
import {mathTextRanges,overlapsMath} from './math-protection.mjs';

const $ = id => document.getElementById(id);
const labels = { key_finding:'关键结论',definition:'定义',method:'方法',constraint:'约束',risk:'风险',core_logic:'核心逻辑',boundary_condition:'边界条件',assumption:'假设',action_item:'行动项',background:'背景',general:'其他重点',other:'其他' };
const examples = [
  { id:'demo-highlight',title:'让信息浮现出来',subtitle:'参考效果 · 连续词级热力演示',type:'效果示例',profile:'general',eyebrow:'INFO HIGHLIGHT / VISUAL STUDY',text:`Try Info Highlight. It uses large language models to analyze text information density and visualizes where the important parts are.
The color intensity of each token indicates how much information it carries. Try it yourself!

## 让注意力自然落在重要的词上

整段文字保留原来的内容，用同一种颜色的深浅表现信息强弱。背景色、文字色、下划线和弱化低分文字，适合不同的阅读习惯。

你可以直接调整颜色与强度。它们只改变阅读外观，不需要重新分析。切换信息密度、语义重点或融合模式，可以比较两种信号的贡献。

## 当前原型的边界

当前分数来自演示规则，并非真实语言模型的 token 概率。正式版本需要接入本地模型，并验证中文、英文、代码与 PDF 的范围对齐。PDF 计划优先使用下划线；此原型尚未接入 PDF 阅读器。` },
  { id:'demo-architecture', title:'InfoLens 的本地阅读架构', subtitle:'架构决策记录 · 中文 Markdown', type:'Markdown', profile:'markdown', eyebrow:'DESIGN NOTE / 001', text:`一个主程序，多种阅读场景。InfoLens 让阅读内容留在本机，将注意力引导到结论、定义、约束和风险。

## 核心决策

我们采用 Windows Host App 与应用内部适配器的结构。主程序负责本地双模型、任务调度与缓存；适配器负责文本提取、范围对齐和高亮绘制。

Surprisal 是模型对原文 token 的意外程度。Semantic 则判断一个句子是否包含关键结论、约束或边界条件。两种信号保留独立分数，再按阅读偏好进行融合。

## 不能忽略的约束

本地服务仅监听 127.0.0.1。阅读正文不上传，模型失败也不会自动切换云端 API。模型是否真的能共存，必须在 RTX 4070 Super 12GB 上测量，纯权重估算不能替代实际显存峰值。

客户端必须核对 revision 与内容摘要。源文档一旦变化，旧高亮立即失效。缓存也不能只看当前段落：前文上下文变化，概率和语义判断都可能改变。

## 下一步

先完成 Edge 和 VSCode 的阅读闭环，再验证 Zotero 当前页文本与几何锚点。Codex Desktop 暂时通过显式复制或保存 Markdown 导入。全局悬浮窗只负责控制，不直接覆盖正文。` },
  { id:'demo-paper',title:'从结果到限制：一次阅读练习',subtitle:'学术论文阅读 · 人工编写示例，非真实研究',type:'论文文本',profile:'paper',eyebrow:'READING SAMPLE / 002',text:`这是一段用于演示阅读高亮的虚构论文摘要，不代表实际实验结论。

## 方法

研究者比较了两种段落筛选策略：局部信息密度与语义重要度。实验中，所有策略使用相同的高亮预算，并在中文与英文文档中分别评估阅读效果。

## 结果

关键结论：融合策略更容易保留措辞平常但重要的约束句。语义重要度提供句子级选择，信息密度帮助进一步定位句内值得关注的表达。

The definition of surprisal is model-dependent unexpectedness. It does not measure factual correctness. A high score must not be interpreted as evidence that a statement is true.

## 限制

风险在于样本规模较小，人工标注也存在分歧。结果仅适用于本次给定材料，不能推断所有学科或所有读者都会受益。专业术语、新缩写和罕见名称可能导致误亮。

后续必须在独立验收集上比较单信号与融合策略，并记录正确率、任务时间和视觉疲劳。未经验证的结论不会作为产品准确率承诺。` },
  { id:'demo-code',title:'缓存与过期结果的边界',subtitle:'代码阅读 · 任务状态与副作用示例',type:'源代码',profile:'code',eyebrow:'CODE WALKTHROUGH / 003',text:`核心逻辑：返回结果之前，先验证当前快照是否仍然匹配。暂停高亮必须立刻清除显示，后台任务的迟到结果不能重新绘制。

\`\`\`js
async function applyResult(job, document) {
  if (job.status === "cancelled") return;
  if (job.revision !== document.revision) return;
  if (job.contentHash !== document.contentHash) return;

  // 状态改变：只有当前快照才能进入绘制阶段
  renderHighlights(job.result.spans);
}
\`\`\`

## 缓存规则

缓存键必须包含完整上下文、模型版本与阅读场景。修改融合权重只需要重新选择高亮，不必重复分析。修改阅读场景则会使语义结果失效。

\`\`\`js
function clearCache() {
  cacheEpoch += 1;
  cache.clear();
}

if (task.cacheEpoch === cacheEpoch) {
  cache.set(task.key, result);
}
\`\`\`

边界条件：缓存清空时，在途任务可能仍在计算。增加 epoch 可以避免任务结束后把旧结果写回。风险是只调用 cache.clear()，忽略了之后发生的写入副作用。` }
];
const state = {docs:[...examples],doc:examples[0],revision:1,generation:0,token:null,jobId:null,analysis:null,result:null,selection:null,spans:[],paused:false,original:false,mode:'hybrid',alpha:.4,beta:.35,budget:.15,fusion:'semantic_floor',profile:'general',category:'all',service:false,editing:false,distribution:'continuous',style:'background',hue:0,intensity:1};
const colorPresets=[['红色',0],['橙色',30],['黄色',56],['黄绿',85],['绿色',120],['薄荷',153],['青色',180],['蓝色',210],['靛蓝',240],['紫色',275],['品红',300],['玫红',330]];
const styleDescriptions={background:'整段文字按词显示背景色，分数越高颜色越明显。',foreground:'用文字颜色的深浅表现分数，正文背景保持干净。',underline:'用下划线的深浅表现分数；PDF 适配计划默认采用此样式。',fade:'让低分文字淡一些，使高分词语自然浮现。'};
let noticeTimer;

function currentDisplay(){const options={mode:state.mode,alpha:state.alpha,beta:state.beta,budget:state.budget,fusion:state.fusion,categories:state.category==='all'?undefined:[state.category]};const full=selectHeatmap(state.analysis,{...options,categories:undefined});const spans=selectReadingCandidates(full.spans,state.analysis.blocks,{distribution:state.distribution,budget:state.budget,categories:state.category==='all'?(state.categories||[]):[state.category]},c=>c.finalScore);const coverageChars=spans.reduce((n,c)=>n+Array.from(c.text).filter(x=>!/^\s$/u.test(x)).length,0);return {...full,spans,coverageChars,coverageRatio:full.totalChars?coverageChars/full.totalChars:0};}
function updateAppearance(){
  const rgb=hueRgb(state.hue).join(' ');$('reading-content').style.setProperty('--heat-rgb',rgb);$('heat-legend-bar').style.setProperty('--heat-rgb',rgb);$('heat-legend-bar').style.setProperty('--legend-alpha',String(heatAppearance(1,state.intensity).backgroundOpacity));
  $('reading-content').style.setProperty('--live-intensity',String(state.intensity));$('reading-content').dataset.style=state.style;$('style-description').textContent=styleDescriptions[state.style];
  for(let i=0;i<16;i++){
    const a=appearanceAtLevel(i,state.intensity),style=$('reading-content').style;
    style.setProperty('--live-fade-'+i,a.fadePercent+'%');style.setProperty('--live-bg-'+i,String(a.backgroundOpacity));
    style.setProperty('--live-tint-'+i,a.tintPercent+'%');style.setProperty('--live-line-'+i,String(a.underlineOpacity));
  }
  $('color-value').textContent=colorPresets.find(([,hue])=>hue===state.hue)?.[0]||`${state.hue}°`;
  $('hue').style.setProperty('--thumb-color',`rgb(${rgb})`);$('intensity').style.setProperty('--thumb-color',`rgb(${rgb})`);
  document.querySelectorAll('[data-hue]').forEach(button=>{const selected=Number(button.dataset.hue)===state.hue;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));});
  $('reading-content').querySelectorAll('.heat-unit').forEach(mark=>applyPaint(mark,state.intensity));
  for(const sample of document.querySelectorAll('#reference-grid .reference-demo')){sample.style.setProperty('--heat-rgb',rgb);sample.querySelectorAll('.heat-unit').forEach(mark=>applyPaint(mark,state.intensity));}
}
function applyPaint(mark,intensity){const appearance=heatAppearance(Number(mark.dataset.score),intensity);mark.style.setProperty('--heat-bg-alpha',String(appearance.backgroundOpacity));mark.style.setProperty('--heat-tint',`${appearance.tintPercent}%`);mark.style.setProperty('--heat-line-alpha',String(appearance.underlineOpacity));mark.style.setProperty('--fade-visibility',`${appearance.fadePercent}%`);}
function createReference(){for(const [style,title] of [['fade','弱化低分文字'],['foreground','文字色'],['underline','下划线'],['background','背景色']]){const card=document.createElement('section');card.className='reference-card';const heading=document.createElement('h3');heading.textContent=title;const text=document.createElement('div');text.className='reading-content reference-demo';text.dataset.style=style;text.style.setProperty('--heat-rgb',style==='foreground'?'234 0 33':'255 71 64');for(const [raw,bits] of referenceTokens){const span=document.createElement('mark');span.className='heat-unit';span.textContent=raw;span.dataset.score=bits/18;span.title=`上游预计算 ${bits} bits`;applyPaint(span,1);text.append(span);}card.append(heading,text);$('reference-grid').append(card);}}
function createColors(){const container=$('color-presets');for(const [name,hue] of colorPresets){const button=document.createElement('button');button.className='color-swatch';button.dataset.hue=hue;button.style.setProperty('--swatch-color',`rgb(${hueRgb(hue).join(' ')})`);button.setAttribute('aria-label',`${name}高亮`);button.title=name;button.onclick=()=>{state.hue=hue;$('hue').value=hue;updateAppearance();saveWorkbenchAppearance();};container.append(button);}}

function notify(text, error=false) { clearTimeout(noticeTimer); $('notice').textContent=text; $('notice').classList.toggle('error',error); $('notice').hidden=false; noticeTimer=setTimeout(()=>{$('notice').hidden=true;},5500); }
function switchPage(page) {
  state.page=page;history.replaceState(null,'','#'+page);
  document.querySelectorAll('.page').forEach(el=>{ const active=el.id===`page-${page}`;el.classList.toggle('active',active);el.hidden=!active;});
  document.querySelectorAll('.rail-button').forEach(el=>{const active=el.dataset.page===page;el.classList.toggle('active',active);el.setAttribute('aria-current',active?'page':'false');});
  if(page==='settings')refreshStatus();
  if(page==='appearance'&&state.token)clientAppearance.refresh();
  if(page==='reader'&&state.token&&state.service&&!state.analysis&&!state.jobId&&!state.paused&&!state.globalPaused)analyzeDocument();
}
async function api(path, options={}) {
  const headers={'Authorization':`Bearer ${state.token}`, ...options.headers};
  if(options.body)headers['Content-Type']='application/json';
  let response=await fetch(path,{...options,headers});
  if(response.status===401){const renewed=await fetch('/v1/session',{headers:{'X-InfoLens-Client':'prototype-ui'}});const session=await renewed.json();if(!renewed.ok||!session.token||(state.source&&session.source!==state.source))throw new Error('后台来源已变化，请刷新页面。');state.token=session.token;headers.Authorization=`Bearer ${state.token}`;response=await fetch(path,{...options,headers});}
  const data=await response.json();
  if(!response.ok) throw Object.assign(new Error(data.error?.message||data.message||data.error?.code||`本地服务返回 ${response.status}`),{status:response.status,code:data.error?.code});
  return data;
}
function splitBlocks(text) {
  const normalized=canonicalize(text);const blocks=[];
  // Preserve fenced code as one block; do not trim away offsets within each block.
  const parts=normalized.split(/(^```[^\n]*\n[\s\S]*?^```[^\n]*$)/m);
  for(const part of parts) {
    if(!part.trim())continue;
    if(/^```/m.test(part)){blocks.push({id:`b${blocks.length+1}`,kind:'code',text:part});continue;}
    for(const paragraph of part.split(/\n{2,}/))if(paragraph.trim())blocks.push({id:`b${blocks.length+1}`,kind:/^#{1,6}\s/.test(paragraph)?'heading':'paragraph',text:paragraph});
  }
  return blocks;
}
function renderLibrary(){const list=$('document-list');list.replaceChildren();for(const doc of state.docs){const btn=document.createElement('button');btn.className=`document-button ${doc.id===state.doc.id?'selected':''}`;const title=document.createElement('span');title.textContent=doc.title;const info=document.createElement('small');info.textContent=`${doc.type} · ${doc.imported?'会话导入':'示例文档'}`;btn.append(title,info);btn.onclick=()=>activateDocument(doc);list.append(btn);}}
function cancelPending(){state.generation++;const old=state.jobId;state.jobId=null;if(old&&state.token)api(`/v1/jobs/${old}`,{method:'DELETE'}).catch(()=>{});}
function activateDocument(doc){cancelPending();state.doc=doc;state.revision++;state.profile=doc.profile;state.analysis=null;state.result=null;state.selection=null;state.spans=[];$('profile').value=state.profile;renderLibrary();renderDocument();if(!state.paused)analyzeDocument();}
function renderDocument(){
  $('document-title').textContent=state.doc.title;$('document-subtitle').textContent=state.doc.subtitle;$('document-type').textContent=state.doc.type;$('paper-eyebrow').textContent=state.doc.eyebrow||'YOUR READING / LOCAL';$('revision-label').textContent=`快照 ${state.revision}`;
  let display={spans:[],coverageChars:0,totalChars:0,coverageRatio:0};
  if(state.analysis&&!state.paused&&!state.original)display=currentDisplay();
  const blocks=state.analysis?.blocks||splitBlocks(state.doc.text),protectedBlocks=new Map(blocks.map(b=>[b.id,b.kind==='code'?[]:mathTextRanges(b.text)]));
  display={...display,spans:display.spans.filter(s=>!overlapsMath(s.start,s.end,protectedBlocks.get(s.blockId)||[]))};state.spans=display.spans;
  const content=$('reading-content');content.dataset.reference=String(state.doc.id==='demo-highlight');
  const native=['local_base','local_models'].includes(state.source)&&!!globalThis.CSS?.highlights&&typeof Highlight!=='undefined';
  if(native){
    // Keep the source text nodes intact while inference changes highlight ranges.
    const same=content.children.length===blocks.length&&blocks.every((b,i)=>content.children[i]?.dataset.blockId===b.id&&content.children[i]?.textContent===b.text);
    if(!same){content.replaceChildren();for(const block of blocks){const el=document.createElement(block.kind==='code'?'pre':'div');el.className=`document-block ${block.kind==='heading'?'heading':block.kind==='code'?'code':''}`;el.dataset.blockId=block.id;el.textContent=block.text;el.onclick=e=>{const caret=document.caretPositionFromPoint?.(e.clientX,e.clientY);if(caret?.offsetNode!==el.firstChild)return;const span=state.spans.find(s=>s.blockId===block.id&&s.start<=caret.offset&&s.end>caret.offset);if(span)inspect(span);};content.append(el);}}
    const buckets=Array.from({length:16},()=>[]);
    for(const span of display.spans){const index=blocks.findIndex(b=>b.id===span.blockId),node=content.children[index]?.firstChild;if(!node||node.data.slice(span.start,span.end)!==span.text)continue;const range=document.createRange();range.setStart(node,span.start);range.setEnd(node,span.end);buckets[displayLevel(span.finalScore)].push(range);}
    buckets.forEach((ranges,i)=>CSS.highlights.set('infolens-preview-'+i,new Highlight(...ranges)));
  }else{
    content.replaceChildren();for(let i=0;i<16;i++)globalThis.CSS?.highlights?.delete('infolens-preview-'+i);
  for(const block of blocks){const element=document.createElement(block.kind==='code'?'pre':'div');element.className=`document-block ${block.kind==='heading'?'heading':block.kind==='code'?'code':''}`;let position=0;const spans=display.spans.filter(s=>s.blockId===block.id).sort((a,b)=>a.start-b.start);
    for(const span of spans){if(span.start<position||block.text.slice(span.start,span.end)!==span.text)continue;element.append(document.createTextNode(block.text.slice(position,span.start)));const mark=document.createElement('mark');mark.className='heat-unit';mark.textContent=span.text;mark.dataset.score=span.finalScore;mark.dataset.category=span.category;mark.dataset.span=`${span.blockId}:${span.start}:${span.end}`;mark.setAttribute('role','button');mark.tabIndex=0;mark.setAttribute('aria-label',`${span.text}，${['local_base','local_models'].includes(span.source)?'token':labels[span.category]||'词语'}，查看评分`);mark.title=['local_base','local_models'].includes(span.source)?`本机概率 ${span.surprisalBits.toFixed(2)} bit · 点击查看`:`演示分数 ${span.finalScore.toFixed(2)} · ${labels[span.category]||'词语'} · 点击查看`;mark.onclick=()=>inspect(span);mark.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inspect(span);}};element.append(mark);position=span.end;}
    element.append(document.createTextNode(block.text.slice(position)));content.append(element);
  }
  }
  $('coverage').textContent=state.paused?'已暂停 · 高亮已清除':state.original?'原文视图 · 分析结果保留':state.analysis?state.distribution==='continuous'?`连续热力 · ${display.spans.length} 个${['local_base','local_models'].includes(state.analysis.source)?'token 片段':'词级单元'}${state.category==='all'?'':' · 类别筛选中'}`:`${display.spans.length} 处重点 · 覆盖 ${(display.coverageRatio*100).toFixed(1)}% / 上限 ${Math.round(state.budget*100)}%`:'尚未高亮';
  $('export').disabled=!state.analysis;$('analyze').disabled=!state.service||state.paused||state.globalPaused;
  $('budget-settings').hidden=state.distribution!=='sparse';updateAppearance();
  $('hybrid-settings').hidden=state.mode!=='hybrid';
  updateRealResult();if(state.selection){const updated=display.spans.find(s=>s.blockId===state.selection.blockId&&s.start===state.selection.start&&s.end===state.selection.end);if(updated)inspect(updated);else clearInspector();}else clearInspector();
}
function clearInspector(){state.selection=null;$('selection-detail').hidden=true;$('selection-empty').hidden=false;}
function inspect(span){state.selection=span;$('selection-empty').hidden=true;$('selection-detail').hidden=false;const word=span.densityDisplay;$('selection-text').textContent=word?.wordText||span.text;$('selection-category').textContent=span.semantic===null?'语义类别未标注':labels[span.category]||span.category;
  const displayM=span.semanticNormalized??span.semantic;
  $('score-s').textContent=word?`${word.bits.toFixed(2)} bit /词`:span.surprisalBits===undefined?span.surprisalNormalized.toFixed(2):`${span.surprisalBits.toFixed(2)} bit`;$('score-m').textContent=span.semantic===null?'未评估':span.semanticNormalized===undefined?span.semantic.toFixed(2):`${displayM.toFixed(2)} / 原始 ${span.semantic.toFixed(2)}`;$('score-f').textContent=span.finalScore.toFixed(2);$('bar-s').style.width=`${span.surprisalNormalized*100}%`;$('bar-m').style.width=`${(displayM||0)*100}%`;
  const explanation=state.mode==='information_density'?'当前只按演示信息密度选择。真实 Surprisal 需要 Base 模型逐 token 概率。':state.mode==='semantic_importance'?'当前只按规则推定的语义类别与重要度选择。真实判断将由 Instruct 模型提供。':state.fusion==='semantic_floor'?'句子重要度平滑抬高可读性下限，信息密度保留句内差异。':state.fusion==='weighted'?`当前采用 ${Math.round(state.alpha*100)}% 信息密度 + ${Math.round((1-state.alpha)*100)}% 语义重要度。调权重仅重算显示，不提交新分析。`:`当前采用信息密度 × (0.35 + 0.65 × 语义重要度)，侧重语义重点中的信息表达。`;
  $('selection-explanation').textContent=['local_base','local_models'].includes(span.source)?`${word?`整词“${word.wordText}”显示信息量 ${word.bits.toFixed(2)} bit${word.apportioned?'（跨词 token 按文字长度分摊）':''}；原 token 保留 ${span.surprisalBits.toFixed(2)} bit。`:`本机 Base 原 token 信息量 ${span.surprisalBits.toFixed(2)} bit。`}S 使用 18 bit 参考刻度。${span.semantic===null?'此处语义未评估；融合模式仅使用现有 S。':`M 原始=${span.semantic.toFixed(2)}${span.semanticNormalized===undefined?'':`；段内显示=${displayM.toFixed(2)}（${span.semanticNormalization?.informative?'段内归一化':'区分不足或段落尚未完成，使用中性值'}）`}，非事实正确率。`}${state.mode==='hybrid'?(state.fusion==='semantic_floor'?'句子重要度平滑抬高可读性下限，信息密度保留句内差异。':state.fusion==='weighted'?`显示 F=${state.alpha.toFixed(2)}S + ${(1-state.alpha).toFixed(2)}M。`:'显示 F=S × (0.35 + 0.65M)。'):state.mode==='semantic_importance'?'当前显示仅使用 M。':'当前显示仅使用 S。'}调整外观不重新分析。`:explanation;$('selection-offset').textContent=`${span.blockId} · UTF-16 [${span.start}, ${span.end})`;
  document.querySelectorAll('mark[data-span]').forEach(mark=>mark.classList.toggle('selected',mark.dataset.span===`${span.blockId}:${span.start}:${span.end}`));
}
const stages={queued:'等待本地队列',segmenting:'建立文本快照',density:'计算演示信息密度',semantic:'匹配演示语义规则',fusion:'生成范围候选',running:'正在分析'};
async function analyzeDocument(){
  if(state.paused||state.globalPaused)return;if(!state.token){notify('本地服务尚未连接，请确认已启动原型。',true);return;}
  cancelPending();const generation=state.generation;const revision=String(state.revision);const profile=state.profile;const mode=state.mode;const doc=state.doc;const blocks=splitBlocks(doc.text);const hash=await contentHash(blocks);if(generation!==state.generation)return;
  state.analysis=null;state.result=null;state.selection=null;renderDocument();$('job-state').textContent='提交本地任务';$('runtime-state').textContent=['local_base','local_models'].includes(state.source)?'本机 GPU 正在计算':'演示规则正在运行';
  try{
    const submitted=await api('/v1/jobs',{method:'POST',body:JSON.stringify({document:{id:doc.id,revision,contentHash:hash},blocks,analysis:{profile,mode,classify:state.classify===true||state.category!=='all'||state.categories?.length>0}})});
    if(generation!==state.generation){api(`/v1/jobs/${submitted.jobId}`,{method:'DELETE'}).catch(()=>{});return;}
    state.jobId=submitted.jobId;state.analysisMode=mode;let partialSequence=0;const start=Date.now();
    while(generation===state.generation){
      const response=await api(`/v1/jobs/${submitted.jobId}`);const job=response.job||response;if(generation!==state.generation)return;
      $('job-state').textContent=(stages[job.stage]||stages[job.status]||'本地分析中')+(job.details?.total?' · '+job.details.done+'/'+job.details.total+' 句':'');
      if(job.status==='completed'){
        const result=job.result;if(!result||result.revision!==revision||result.contentHash!==hash||String(state.revision)!==revision||state.profile!==profile||state.doc.id!==doc.id){throw new Error('快照已变化，结果未应用。');}
        state.analysis=result.analysis;state.result=result;state.jobId=null;renderDocument();
        const real=['local_base','local_models'].includes(result.source);$('job-state').textContent=result.cacheHit?'已完成 · 本机缓存命中':`已完成 · ${real?'GPU 推理':'演示规则'} ${Math.round(result.processingMs||Date.now()-start)}ms`;
        $('runtime-state').textContent=real?`${state.analysis.semanticConnected?'本地双模型':'Qwen Base 快速模式'} · ${state.analysis.tokenCount} tokens · PyTorch 峰值 ${state.analysis.gpu.peakAllocatedMiB} MiB（不含 Mica）`:result.cacheHit?'缓存复用 · 无模型推理':'演示规则 · 无模型推理';updateRealResult();refreshStatus();return;
      }
      if(job.partial?.sequence>partialSequence){const part=job.partial;if(part.revision!==revision||part.contentHash!==hash||String(state.revision)!==revision||state.doc.id!==doc.id)throw new Error('增量快照已变化，结果未应用。');partialSequence=part.sequence;state.analysis=part.analysis;renderDocument();$('runtime-state').textContent='逐句更新 · 已显示 '+state.spans.length+' 片段';}
      if(job.status==='failed')throw new Error(job.error?.message||job.error?.code||'任务失败');
      if(job.status==='cancelled'){$('job-state').textContent='任务已取消';return;}
      if(Date.now()-start>300000){await api(`/v1/jobs/${submitted.jobId}`,{method:'DELETE'}).catch(()=>{});throw new Error('任务超时，已取消。');}
      await new Promise(resolve=>setTimeout(resolve,150));
    }
  }catch(error){if(generation!==state.generation)return;state.jobId=null;$('job-state').textContent='分析未完成';$('runtime-state').textContent='可恢复错误';notify(error.message,true);}
}
function togglePause(){state.paused=!state.paused;if(state.paused){cancelPending();$('job-state').textContent='已暂停';$('runtime-state').textContent='已暂停 · 无新任务';}else if(!state.analysis)analyzeDocument();else $('job-state').textContent='已恢复 · 当前快照有效';$('pause').textContent=state.paused?'恢复高亮':'暂停高亮';$('floating-pause').textContent=state.paused?'▶':'Ⅱ';updateFloating();renderDocument();}
function updateFloating(){$('floating-label').textContent=`${{hybrid:'融合',information_density:'信息密度',semantic_importance:'语义重点'}[state.mode]} · ${state.paused?'暂停':'开启'}`;}
function openImport(edit=false){state.editing=edit; $('dialog-title').textContent=edit?'编辑当前文档':'导入阅读内容';$('import-title').value=edit?state.doc.title:'';$('import-text').value=edit?state.doc.text:'';$('import-error').hidden=true;$('import-dialog').showModal();$('import-text').focus();}
function saveDocument(text,title){if(!text.trim())throw new Error('请先输入正文。');if(text.length>30000)throw new Error('正文超过 30,000 个 UTF-16 单位，请分段导入。');const blocks=splitBlocks(text);if(blocks.length>128)throw new Error('正文超过 128 块，请分段导入。');
  let doc;if(state.editing){doc={...state.doc,text,title:title.trim()||state.doc.title,profile:state.profile};state.docs=state.docs.map(d=>d.id===doc.id?doc:d);}else{doc={id:`import-${crypto.randomUUID()}`,title:title.trim()||'未命名阅读文档',text,subtitle:'显式导入 · 本地会话',type:'文本 / Markdown',profile:state.profile,eyebrow:'YOUR READING / LOCAL',imported:true};state.docs.push(doc);}activateDocument(doc);
}
function configureSemanticModel(model){
  if(model?.repo!=='sky7350/Mica-v0.1-4B'||state.semanticKind==='mica')return;
  state.semanticKind='mica';
  const card=document.querySelectorAll('#page-models .model-card')[1];
  card.querySelector('h3').textContent='Mica · v0.1 · 4B';
  card.querySelector('p').textContent='读取适中长度的自然段，给段内每句话独立评分。直接读取五档分值的概率，不生成 JSON。';
  const terms=card.querySelectorAll('dt'),values=card.querySelectorAll('dd');
  terms[0].textContent='段落 / 完整输入';values[0].textContent=`约 ${model.paragraphTokens||768} / ${model.inputLimit||4096} tokens`;
  terms[1].textContent='本地运行';values[1].textContent='Q5_K_M · llama.cpp · 无文本生成';
  terms[2].textContent='句子分数';values[2].textContent='0–100 重要度 · 尚未做阅读任务校准';
  document.querySelector('.engine-note strong').textContent='Qwen Base + Mica';
  $('category').value='all';$('category').disabled=true;
}
async function refreshStatus(){if(!state.token)return;try{const data=await api('/v1/status');state.service=true;$('connection').textContent='● 本地在线';$('connection').classList.add('online');state.globalPaused=data.paused;configureSemanticModel(data.semantic);const entries=data.cacheEntries??data.cache?.entries??0;const queue=data.queueLength??data.queue?.length??0;$('cache-status').textContent=`${entries} 个快照缓存 · ${queue} 个等待任务 · 仅内存，不持久保存`;$('service-state').textContent=data.paused?'后台暂停新分析':`本地核心在线 · ${queue} 个排队任务`;
  $('global-pause').textContent=data.paused?'恢复新分析':'暂停新分析';$('global-pause').disabled=data.unloading;
  $('analysis-control-status').textContent=data.paused?'后台已暂停；已显示的结果保留，可恢复后重新分析。':'后台接受当前文档分析；暂停会取消活动与排队任务。';
  $('host-status').textContent=data.hostManaged?'后台由 Windows 托盘管理。右键托盘图标可停止服务、退出程序或设置登录自启；自启默认关闭。':'后台通过命令行启动。可关闭命令行后双击 InfoLensHost.exe 改用托盘。';
  $('model-residency').textContent=data.unloading?'正在释放模型…':data.status==='loading'?'托盘启动预加载中；完成后模型保持驻留。':data.residency?.error?.message|| (data.modelConnected?`Base 已加载 · Semantic ${data.semanticModelLoaded?'已加载':'未加载'} · 翻译 ${data.translationModelLoaded?'已加载':'未加载'}${data.gpu?' · PyTorch '+data.gpu.allocatedMiB+' MiB（不含 Mica）':''}`:'模型已卸载；点击预加载模型后即可使用。');
  $('translation-model-card').querySelector('.state-pill').textContent=data.translation?.dedicated?(data.translationModelLoaded?'NF4 已加载':'专用模型已配置'):'未配置';
  if(data.translation?.dedicated){document.querySelector('#page-models .page-heading p').textContent='本机 CUDA：Base + Semantic + 混元专用翻译，启动预加载、串行推理。';document.querySelector('#page-models .strategy-strip strong').textContent='三个模型保持驻留 · 阅读任务串行处理';document.querySelector('#page-models .strategy-strip span').textContent='启动时加载权重；切换高亮与翻译不重载模型。PyTorch 指标不含 Mica。';}
  $('preload-models').disabled=data.unloading||data.status==='loading'||data.modelsReady===true;$('preload-models').textContent=data.status==='loading'?'预加载中…':data.modelsReady?'模型已就绪':'预加载模型';
  $('unload-models').disabled=data.unloading;document.querySelector('#page-models .model-card .state-pill').textContent=data.modelConnected?'BF16 已加载':'未加载';document.querySelectorAll('#page-models .model-card .state-pill')[1].textContent=data.semanticModelLoaded?(data.semantic?.quantization||'NF4')+' 已加载':'未加载';$('analyze').disabled=!state.service||state.paused||data.paused||data.unloading||data.modelsReady===false;
}catch{state.service=false;$('cache-status').textContent='本地服务未响应';$('connection').textContent='后台未连接';$('connection').classList.remove('online');$('service-state').textContent='本地服务未响应';$('analyze').disabled=true;}}
function exportResult(){if(!state.analysis)return;const selection=currentDisplay();const payload={schemaVersion:1,source:state.analysis.source,warning:['local_base','local_models'].includes(state.analysis.source)?'真实本地模型评分；Semantic 为句子阅读重要度，不代表事实正确率；缺失语义保持 null；GPU 指标来自本次分析':'词级演示规则评分；非真实 LM token surprisal / semantic；非 GPU 测量',models:state.analysis.models||{surprisal:state.analysis.model},gpu:state.analysis.gpu,semantic:state.analysis.semantic,availableSignals:state.analysis.availableSignals,title:state.doc.title,revision:String(state.revision),contentHash:state.result?.contentHash,profile:state.profile,display:{mode:state.mode,alpha:state.alpha,beta:state.beta,budget:state.distribution==='sparse'?state.budget:null,fusion:state.fusion,distribution:state.distribution,style:state.style,hue:state.hue,intensity:state.intensity,category:state.category},...selection};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=['local_base','local_models'].includes(state.analysis.source)?'infolens-local-analysis.json':'infolens-demo-analysis.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

document.querySelectorAll('[data-page]').forEach(button=>button.onclick=()=>switchPage(button.dataset.page));
document.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>{state.mode=button.dataset.mode;document.querySelectorAll('[data-mode]').forEach(b=>{const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});updateFloating();renderDocument();if(['local_base','local_models'].includes(state.source)&&((state.mode!=='information_density'&&!state.analysis?.semantic)||(state.mode==='information_density'&&state.jobId&&state.analysisMode!=='information_density')))analyzeDocument();});
document.querySelectorAll('[data-style]').forEach(button=>button.onclick=()=>{state.style=button.dataset.style;document.querySelectorAll('[data-style]').forEach(b=>{const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});updateAppearance();saveWorkbenchAppearance();});
$('hue').oninput=e=>{state.hue=Number(e.target.value);updateAppearance();saveWorkbenchAppearance();};
$('intensity').oninput=e=>{state.intensity=Number(e.target.value)/100;$('intensity-value').textContent=`${e.target.value}%`;updateAppearance();saveWorkbenchAppearance();};
$('distribution').onchange=e=>{state.distribution=e.target.value;renderDocument();};
$('budget').oninput=e=>{state.budget=Number(e.target.value)/100;$('budget-value').textContent=`${e.target.value}%`;renderDocument();};
$('alpha').oninput=e=>{state.alpha=Number(e.target.value)/100;$('alpha-value').textContent=`${e.target.value}%`;renderDocument();};
$('fusion').onchange=e=>{state.fusion=e.target.value;$('alpha').hidden=$('alpha-label').hidden=state.fusion!=='weighted';renderDocument();};
$('category').onchange=e=>{state.category=e.target.value;renderDocument();};
$('profile').onchange=e=>{state.profile=e.target.value;state.analysis=null;state.result=null;state.selection=null;renderDocument();if(!state.paused)analyzeDocument();};
$('original').onchange=e=>{state.original=e.target.checked;renderDocument();};
$('pause').onclick=togglePause;$('floating-pause').onclick=togglePause;
$('theme').onclick=()=>{document.body.dataset.theme=document.body.dataset.theme==='dark'?'light':'dark';};
$('source-preview').onclick=()=>{$('reference-dialog').showModal();};$('reference-close').onclick=()=>{$('reference-dialog').close();};
$('floating').onchange=e=>{$('floating-control').hidden=!e.target.checked;};
$('import-open').onclick=()=>openImport();$('codex-import').onclick=()=>{switchPage('reader');openImport();};$('edit').onclick=()=>openImport(true);
$('dialog-close').onclick=()=>{$('import-dialog').close();};
$('import-form').onsubmit=e=>{e.preventDefault();try{saveDocument($('import-text').value,$('import-title').value);$('import-dialog').close();}catch(error){$('import-error').textContent=error.message;$('import-error').hidden=false;}};
$('file-open').onclick=()=>{$('file-input').click();};
$('file-input').onchange=async e=>{const file=e.target.files[0];if(!file)return;const generation=state.generation;try{if(!/\.(md|txt)$/i.test(file.name))throw new Error('请选择 Markdown 或 TXT 文本文件。');if(file.size>120000)throw new Error('文件过大，请选择较短文本或分段粘贴。');const text=await file.text();if(generation!==state.generation)return;state.editing=false;saveDocument(text,file.name.replace(/\.(md|txt)$/i,''));}catch(error){notify(error.message,true);}finally{e.target.value='';}};
$('analyze').onclick=analyzeDocument;$('export').onclick=exportResult;
$('clear-cache').onclick=async()=>{try{await api('/v1/cache',{method:'DELETE'});await refreshStatus();notify('服务端内存缓存已清除。当前屏幕结果保留，可重新分析。');}catch(error){notify(error.message,true);}};
$('global-pause').onclick=async()=>{const button=$('global-pause');button.disabled=true;try{await api('/v1/control',{method:'POST',body:JSON.stringify({action:state.globalPaused?'resume':'pause'})});await refreshStatus();}catch(error){notify(error.message,true);button.disabled=false;}};
$('unload-models').onclick=async()=>{const button=$('unload-models');button.disabled=true;try{await api('/v1/control',{method:'POST',body:JSON.stringify({action:'unload'})});await refreshStatus();$('runtime-state').textContent='当前结果保留 · 模型已卸载';notify('模型已卸载，当前高亮与缓存保留。');}catch(error){notify(error.message,true);button.disabled=false;}};
$('preload-models').onclick=async()=>{const button=$('preload-models');button.disabled=true;try{await api('/v1/control',{method:'POST',body:JSON.stringify({action:'warmup'})});await refreshStatus();notify('正在预加载模型，完成后保持驻留。');}catch(error){notify(error.message,true);button.disabled=false;}};
$('clear-session').onclick=async()=>{cancelPending();const button=$('clear-session');button.disabled=true;try{await api('/v1/session-data',{method:'DELETE'});cancelPending();state.docs=[...examples];state.analysis=null;state.result=null;state.selection=null;state.editing=false;$('import-text').value='';$('import-title').value='';$('file-input').value='';if($('import-dialog').open)$('import-dialog').close();activateDocument(examples[0]);notify('已清除导入文档、服务任务及分析缓存，恢复示例文档。');}catch(error){notify(`会话清除失败：${error.message}`,true);}finally{button.disabled=false;}};
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!$('import-dialog').open){e.preventDefault();analyzeDocument();}});
const clientAppearance=createClientAppearanceUI({api,notify,applyWorkbench:p=>{
  state.style=p.style;state.hue=p.hue;state.intensity=p.intensity;$('hue').value=p.hue;$('intensity').value=p.intensity*100;$('intensity-value').textContent=Math.round(p.intensity*100)+'%';
  document.querySelectorAll('[data-style]').forEach(b=>{const active=b.dataset.style===p.style;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});updateAppearance();
}});
function saveWorkbenchAppearance(){clientAppearance.saveWorkbench({style:state.style,hue:state.hue,intensity:state.intensity});}
createColors();createReference();$('profile').value=state.profile;renderLibrary();renderDocument();
const initialPage=location.hash.slice(1);switchPage(['reader','adapters','appearance','models','settings'].includes(initialPage)?initialPage:'reader');
function configureRealUI(session){
  state.source=session.source;state.semanticEnabled=session.source==='local_models';state.mode=state.semanticEnabled?'hybrid':'information_density';$('runtime-state').textContent='本地模型启动预加载';
  examples[0].subtitle='参考文本 · 本机真实模型评分';examples[0].text=examples[0].text.replace('当前分数来自演示规则，并非真实语言模型的 token 概率。正式版本需要接入本地模型，并验证中文、英文、代码与 PDF 的范围对齐。',state.semanticEnabled?'先显示本机 Base 信息密度，再按自然段上下文逐句补充重要度。重要句子保持整句可读，分数不代表事实正确率。':'当前分数来自本机 Qwen2.5-1.5B Base 的原文概率。语义模型尚未接入。');
  if(!state.semanticEnabled)examples[0].text=examples[0].text.replace('切换信息密度、语义重点或融合模式，可以比较两种信号的贡献。','当前只开放真实信息密度模式。');
  stages.density='计算真实 Base 概率';stages.model_loading='加载本地 Base';stages.semantic_loading='加载本地语义模型';stages.semantic='判断句子阅读重要度';
  document.querySelectorAll('.score-label span')[0].textContent='Surprisal · 真实 bit';document.querySelectorAll('.score-label span')[1].textContent='Semantic · 句子重要度';
  document.querySelector('#page-models .page-heading p').textContent='本机 CUDA：Qwen2.5-1.5B BF16'+(state.semanticEnabled?' + Mica 4B Q5_K_M + HY-MT 1.8B NF4。托盘启动时预加载；精细类别分类默认关闭。':'。语义模型未配置。');
  document.querySelector('#page-models .model-card .state-pill').textContent='本地已配置';
  document.querySelectorAll('#page-models .model-card .state-pill')[1].textContent=state.semanticEnabled?'本地模型已配置':'未接入';
  document.querySelector('#page-models .strategy-strip span').textContent='显存指标来自实际任务；同时驻留能力见双模型验收报告。';
  document.querySelector('#page-models .strategy-strip strong').textContent=state.semanticEnabled?'本地双信号 · 逐句更新':'本地 Base 已接入';
  document.querySelector('#page-models .strategy-strip p').textContent='模型串行分析当前快照。语义不可用时保留信息密度；不自动切换到云端。';
  document.querySelectorAll('#page-adapters .adapter-card')[1].querySelector('.state-pill').textContent='Edge · 已构建 v0.8.19';
  document.querySelectorAll('#page-adapters .adapter-card')[1].querySelector('p').textContent='当前页授权 → 本机模型 → 原生 Range 高亮；安装状态须在 Edge 中验证。';
  document.querySelectorAll('#page-adapters .adapter-card')[2].querySelector('.state-pill').textContent='VS Code · 已构建 v0.8.19';
  document.querySelectorAll('#page-adapters .adapter-card')[2].querySelector('p').textContent='当前本机 Markdown 或代码 → 本地模型 → 编辑器 Decoration。编辑后清除旧结果，源文件保持原样。';
  document.querySelectorAll('[data-mode]').forEach(b=>{const active=b.dataset.mode===state.mode;b.disabled=!state.semanticEnabled&&!active;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  document.querySelector('.demo-badge').textContent='本地模型 · 真实评分';document.querySelector('.engine-note strong').textContent=state.semanticEnabled?'Base + 本地句子评分':'Qwen2.5-1.5B · CUDA';
  document.querySelector('.engine-note p').textContent=state.semanticEnabled?'先显示信息密度，再逐句补充语义保底；快速模式可跳过语义评分。':'真实原文概率；语义模型尚未接入。';
  document.querySelector('.paper-footer').textContent='本机模型处理原文。颜色表现阅读信号，分数不表示事实正确率。';$('category').disabled=!state.semanticEnabled;updateFloating();
}
function updateRealResult(){
  if(!state.analysis||!['local_base','local_models'].includes(state.analysis.source))return;
  document.querySelector('#page-models .model-card .state-pill').textContent='本次分析已加载 BF16';
  const report=state.analysis.semantic;if(report){const c=report.coverage;$('coverage').textContent=$('coverage').textContent.replace(/ · 语义 \d+\/\d+ 句$/,'')+' · 语义 '+c.evaluatedSentences+'/'+c.totalSentences+' 句';document.querySelector('.engine-note p').textContent=report.status==='ready'?(report.source==='local_mica'?'Mica 按自然段逐句评分，再做段内归一化；区分不足时保留信息密度。':'两种信号已评估；语义使用有限摘录和相邻句上下文。'):'部分或全部语义未评估；融合缺失部分退回信息密度。';document.querySelectorAll('#page-models .model-card .state-pill')[1].textContent=state.analysis.semanticModelLoaded?(report.model?.quantization||'NF4')+' 已加载':'语义不可用';}
  if(report?.displayCalibration){const d=report.displayCalibration;document.querySelector('.engine-note p').textContent=`重点 ${d.importantSentences}/${d.totalSentences} 句保留可读底色，句内按信息密度分层。醒目片段 ${d.actualBright} 个，纯密度 ${d.baselineBright} 个${d.brightRatio!==null?'（'+d.brightRatio.toFixed(2)+' 倍）':''}。${d.limited?'重点词不足或分数并列，保持弱化，不凑亮词。':''}`;}
}
setInterval(()=>{if(state.token&&!document.hidden){refreshStatus();clientAppearance.refresh();}},2500);
try{const response=await fetch('/v1/session',{headers:{'X-InfoLens-Client':'prototype-ui'}});const session=await response.json();if(!response.ok||!session.token)throw new Error('无法建立本地会话');state.token=session.token;state.service=true;if(['local_base','local_models'].includes(session.source))configureRealUI(session);$('connection').textContent='● 本地在线';$('connection').classList.add('online');$('service-state').textContent='本地核心在线';renderDocument();await refreshStatus();await clientAppearance.load().catch(error=>notify('无法读取各应用外观：'+error.message,true));}catch(error){$('connection').textContent='连接失败';$('job-state').textContent='本地服务未连接';$('service-state').textContent='本地核心未连接';notify('请启动本地阅读服务，再打开此页面。',true);}

const readingUI=createReadingUI({api,notify:(message,error)=>notify(message,error),apply(p){const prior={mode:state.mode,classify:state.classify};state.distribution=p.distribution;state.budget=p.budget;state.categories=p.categories;state.classify=p.classify;state.mode=p.mode;state.category='all';$('category').value='all';$('distribution').value=p.distribution;$('budget').value=p.budget*100;$('budget-value').textContent=Math.round(p.budget*100)+'%';document.querySelectorAll('[data-mode]').forEach(b=>{const active=b.dataset.mode===p.mode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});updateFloating();renderDocument();if(state.analysis&&((p.classify&&!prior.classify)||(prior.mode==='information_density'&&p.mode!=='information_density'&&!state.analysis.semantic)))analyzeDocument();}});
await readingUI.load().catch(error=>notify('无法读取阅读策略：'+error.message,true));
if(state.service&&!state.globalPaused&&state.page==='reader'&&!state.analysis)await analyzeDocument();
