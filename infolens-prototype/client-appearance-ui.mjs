import {heatAppearance,hueRgb,appearancePreviewSamples,appearanceCurve} from './appearance.mjs';
const APPS=[['defaults','统一样式','跟随统一样式的应用会使用这里的设置。'],['edge','Edge','扩展运行时自动同步；已有网页高亮会直接重绘。'],['vscode','VS Code','扩展运行时自动同步；已分析文档会直接重绘。'],['workbench','阅读工作台','当前工作台即时重绘。'],['zotero','Zotero','修改后自动同步 PDF，无需重启。此端默认独立设置；勾选跟随统一样式后才会采用统一设置。支持背景、文字色、下划线和弱化。弱化使低分文字变淡，文字色只给字着色；不再替换成下划线。'],['codex','Codex','原生适配器尚未接入，可先保存偏好。当前导入内容使用工作台样式。']];
const STYLES=[['background','背景色'],['foreground','文字色'],['underline','下划线'],['fade','弱化低分文字']];
const COLORS=[['红',0],['橙',30],['黄',56],['绿',120],['青',180],['蓝',210],['紫',275],['粉',330]];
export function createClientAppearanceUI({api,notify,applyWorkbench}){
  const grid=document.getElementById('appearance-grid'),status=document.getElementById('appearance-status');
  const chart=document.getElementById('appearance-curve-chart'),c=appearanceCurve,end=24+240*c.saturation;
  chart.innerHTML=`<path class="curve-axis" d="M24 10V110H264"/><path class="curve-linear" d="M24 110L264 10"/><path class="curve-cap" d="M${end} 10V110"/><path class="curve-line" d="M24 110C${24+240*c.saturation*c.x1} ${110-100*c.y1},${24+240*c.saturation*c.x2} ${110-100*c.y2},${end} 10H264"/><text x="24" y="132">0</text><text x="${end}" y="132" text-anchor="middle">${c.saturation*100}%</text><text x="264" y="132" text-anchor="end">100%</text>`;
  const cards=new Map();let current=null,flight=null,unifying=false;
  const writer=createLiveAppearanceWriter({api,onSnapshot:accept,onState(id,state,sequence,error){
    const card=cards.get(id);if(!card)return;
    if(state==='queued'){card.sequence=sequence;card.dirty=true;}
    if(card.sequence!==sequence)return;
    card.state=state;if(state==='saved')card.dirty=false;
    card.message.textContent=({queued:'正在应用…',saving:'正在保存并同步…',saved:'已自动保存 · 已接入客户端实时更新',error:'应用失败 · 草稿已保留：'+(error?.message||'连接中断')})[state];
    if(state==='error')notify(card.message.textContent,true);preview(card);
  }});
  function effective(card){return card.id!=='defaults'&&card.inherit.checked?current?.defaults||{style:'background',hue:0,intensity:1}:{style:card.style.value,hue:Number(card.hue.value),intensity:Number(card.intensity.value)/100};}
  function preview(card){
    const p=effective(card),rgb=hueRgb(p.hue).join(' ');for(const surface of card.previews){surface.dataset.style=p.style;surface.style.setProperty('--heat-rgb',rgb);}
    card.hueValue.textContent=p.hue+'°';card.strength.textContent=Math.round(p.intensity*100)+'%';
    const inherited=card.id!=='defaults'&&card.inherit.checked;
    if(card.inherit)card.inherit.disabled=!current;
    if(inherited){card.style.value=p.style;card.hue.value=p.hue;card.intensity.value=Math.round(p.intensity*100);}
    for(const field of [card.style,card.hue,card.intensity,...card.colors.querySelectorAll('button')])field.disabled=inherited||!current;
    card.samples.forEach(mark=>{const a=heatAppearance(Number(mark.dataset.score),p.intensity);mark.style.setProperty('--heat-bg-alpha',a.backgroundOpacity);mark.style.setProperty('--heat-tint',a.tintPercent+'%');mark.style.setProperty('--heat-line-alpha',a.underlineOpacity);mark.style.setProperty('--fade-visibility',a.fadePercent+'%');});
    card.badge.textContent=card.dirty?(card.state==='error'?'应用失败':'正在应用'):inherited?'跟随统一样式':card.id==='defaults'?'统一设置':'独立样式';
  }
  function accept(data,force=false){
    if(current&&data.revision<current.revision)return;
    current=data;status.textContent=data.storage==='local_preferences'?'已连接 · 偏好保存在本机 · 修改即自动保存 · 无需重启':'演示服务 · 外观仅保留到服务退出';
    for(const card of cards.values()){
      const row=card.id==='defaults'?{settings:data.defaults}:{inherit:data.clients[card.id].inherit,settings:data.clients[card.id].settings};
      if(card.dirty&&card.baseline===JSON.stringify(row))card.revision=data.revision;
      if(!card.dirty||force){const changed=card.baseline!==JSON.stringify(row);card.independent={...row.settings};card.style.value=row.settings.style;card.hue.value=row.settings.hue;card.intensity.value=Math.round(row.settings.intensity*100);if(card.id!=='defaults')card.inherit.checked=row.inherit;card.revision=data.revision;card.baseline=JSON.stringify(row);card.dirty=false;if(force||changed&&card.state!=='saved')card.message.textContent='';}
      card.save.disabled=false;preview(card);
    }
    if(!cards.get('workbench').dirty&&!(data.clients.workbench.inherit&&cards.get('defaults').dirty))applyWorkbench(data.clients.workbench.effective);
    const unified=document.getElementById('appearance-unify');if(unified)unified.disabled=unifying;
  }
  async function load(force=false){
    if(flight&&!force)return flight;
    const task=api('/v1/appearance').then(data=>writer.accept(data));flight=task;
    try{await task;}catch(error){status.textContent='服务未连接 · 设置未保存，客户端保留上次外观';throw error;}finally{if(flight===task)flight=null;}
  }
  function save(card,immediate=false){
    const value={settings:card.id!=='defaults'&&card.inherit.checked?card.independent:{style:card.style.value,hue:Number(card.hue.value),intensity:Number(card.intensity.value)/100}};
    if(card.id!=='defaults')value.inherit=card.inherit.checked;
    writer.queue(card.id,value);if(immediate)return writer.flush();
  }
  for(const [id,title,description] of APPS){
    const node=document.createElement('section');node.className='appearance-card';node.dataset.client=id;
    node.innerHTML=`<div class="appearance-card-title"><h2>${title}</h2><span class="state-pill"></span></div><p class="control-note">${description}</p>${id==='defaults'?'<div class="appearance-inherit" aria-hidden="true"></div>':'<label class="appearance-inherit"><input type="checkbox">跟随统一样式</label>'}<label class="field-label">高亮样式<select></select></label><label class="field-label">颜色 <output class="hue-value"></output><input class="appearance-hue" type="range" min="0" max="360" step="1"></label><div class="appearance-colors"></div><label class="field-label">强度 <output class="strength-value"></output><input class="appearance-intensity" type="range" min="0" max="150" step="5"></label><div class="appearance-preview reading-content"><mark class="heat-unit">普通文字</mark> <mark class="heat-unit">重点词语</mark> <mark class="heat-unit">关键信息</mark></div><small class="preview-caption">外观预览</small><button class="quiet-button appearance-save" disabled></button><p class="appearance-message" role="status"></p>`;
    const oldPreview=node.querySelector('.appearance-preview'),box=document.createElement('div');box.className='appearance-preview-pair';
    for(const [surface,label] of [['light','浅色页面'],['dark','深色页面']]){
      const group=document.createElement('div'),caption=document.createElement('small'),sample=document.createElement('div');
      caption.className='preview-surface-label';caption.textContent=label;sample.className='appearance-preview reading-content';sample.dataset.surface=surface;
      for(const row of appearancePreviewSamples){const mark=document.createElement('mark');mark.className='heat-unit';mark.dataset.score=String(row.score);mark.textContent=row.text;sample.append(mark);}
      group.append(caption,sample);box.append(group);
    }
    oldPreview.replaceWith(box);node.querySelector('.preview-caption').textContent='同一条平滑曲线 · 分值 0% → 50% → 100%';
    const card={id,node,dirty:false,revision:0,inherit:node.querySelector('input[type=checkbox]'),style:node.querySelector('select'),hue:node.querySelector('.appearance-hue'),hueValue:node.querySelector('.hue-value'),intensity:node.querySelector('.appearance-intensity'),strength:node.querySelector('.strength-value'),previews:[...node.querySelectorAll('.appearance-preview')],colors:node.querySelector('.appearance-colors'),samples:[...node.querySelectorAll('mark')],badge:node.querySelector('.state-pill'),save:node.querySelector('.appearance-save'),message:node.querySelector('.appearance-message')};
    card.style.setAttribute('aria-label',title+' 高亮样式');card.hue.setAttribute('aria-label',title+' 高亮色相');card.intensity.setAttribute('aria-label',title+' 高亮强度');card.inherit?.setAttribute('aria-label',title+' 跟随统一样式');card.save.textContent='立即应用';
    for(const [value,label] of STYLES){const option=document.createElement('option');option.value=value;option.textContent=label;card.style.append(option);}
    const dirty=()=>{if(!card.inherit?.checked)card.independent={style:card.style.value,hue:Number(card.hue.value),intensity:Number(card.intensity.value)/100};card.dirty=true;preview(card);save(card);};
    for(const field of [card.style,card.hue,card.intensity])field.addEventListener('input',dirty);
    card.inherit?.addEventListener('input',()=>{if(!card.inherit.checked&&card.independent){card.style.value=card.independent.style;card.hue.value=card.independent.hue;card.intensity.value=card.independent.intensity*100;}dirty();});
    for(const [name,hue] of COLORS){const button=document.createElement('button');button.type='button';button.style.backgroundColor=`rgb(${hueRgb(hue).join(' ')})`;button.setAttribute('aria-label',title+' '+name+'色');button.onclick=()=>{card.hue.value=hue;dirty();};card.colors.append(button);}
    card.save.onclick=()=>save(card,true);cards.set(id,card);grid.append(node);
  }
  document.getElementById('appearance-reload').onclick=()=>load(true).catch(error=>notify(error.message,true));
  document.getElementById('appearance-unify').onclick=async()=>{
    if(!current||unifying)return;const button=document.getElementById('appearance-unify');button.disabled=true;unifying=true;
    for(const card of cards.values())if(card.id!=='defaults'){card.inherit.checked=true;card.dirty=true;preview(card);save(card);}
    try{await writer.flush();}finally{unifying=false;button.disabled=false;}
  };
  return {load,saveWorkbench(settings){
    const local=cards.get('workbench'),card=local.inherit.checked?cards.get('defaults'):local;card.independent={...settings};
    card.style.value=settings.style;card.hue.value=settings.hue;card.intensity.value=Math.round(settings.intensity*100);save(card);
  },refresh(){return load().catch(()=>{});}};
}

const row=(snapshot,id)=>id==='defaults'?{settings:snapshot.defaults}:{inherit:snapshot.clients[id].inherit,settings:snapshot.clients[id].settings};
const key=value=>JSON.stringify(value);

// All controls share one revisioned writer. Slider input replaces queued values;
// input received during a write remains pending until its own acknowledgement.
export function createLiveAppearanceWriter({api,onSnapshot,onState,delayMs=180,setTimer=setTimeout,clearTimer=clearTimeout}){
  let current=null,timer=null,running=null,inflight=null,sequence=0;
  const pending=new Map();
  function accept(data){if(current&&data.revision<current.revision)return;current=data;onSnapshot(data);}
  function queue(id,value){
    if(!current)throw Error('外观设置尚未连接。');
    const previous=pending.get(id)||(inflight?.id===id?inflight:null);
    const entry={id,value:structuredClone(value),baseline:previous?.baseline??key(row(current,id)),sequence:++sequence};
    pending.set(id,entry);onState(id,'queued',entry.sequence);
    clearTimer(timer);timer=setTimer(flush,delayMs);return entry.sequence;
  }
  async function write(entry){
    for(let attempt=0;attempt<3;attempt++){
      if(key(row(current,entry.id))!==entry.baseline&&key(row(current,entry.id))!==key(entry.value)){
        const error=Error('该应用设置已在其他窗口更新。草稿已保留，点击“立即应用”可采用当前选择。');error.status=409;throw error;
      }
      try{return await api('/v1/appearance/'+entry.id,{method:'PUT',body:JSON.stringify({revision:current.revision,...entry.value})});}
      catch(error){if(error.status!==409||attempt===2)throw error;accept(await api('/v1/appearance'));}
    }
  }
  function flush(){
    clearTimer(timer);timer=null;if(running)return running;
    const task=(async()=>{
      while(pending.size){
        const entry=pending.values().next().value;pending.delete(entry.id);inflight=entry;onState(entry.id,'saving',entry.sequence);
        try{
          const data=await write(entry),next=pending.get(entry.id);
          if(next?.baseline===entry.baseline)next.baseline=key(row(data,entry.id));
          // Clear only the acknowledged draft before the snapshot repaints controls.
          onState(entry.id,'saved',entry.sequence);accept(data);
        }catch(error){onState(entry.id,'error',entry.sequence,error);}
        finally{inflight=null;}
        if(timer!==null)break;
      }
    })();running=task;
    task.finally(()=>{if(running===task)running=null;if(pending.size&&timer===null)flush();});return task;
  }
  return {accept,queue,flush,get busy(){return !!running||pending.size>0;}};
}
