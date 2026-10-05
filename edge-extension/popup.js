import {hueRgb} from './appearance.mjs';
const $=id=>document.getElementById(id);let editingUntil=0,revision=0,polling=false;
function busy(value){$('analyze').disabled=value;$('analyze').textContent=value?'正在分析…':'分析当前网页';$('status').setAttribute('aria-busy',String(value));}
function reflect(prefs){if(!prefs)return;$('mode').value=prefs.mode||'hybrid';$('fusion').value=prefs.fusion||'semantic_floor';$('alpha').value=(prefs.alpha??.4)*100;$('style').value=prefs.style;$('intensity').value=prefs.intensity;$('hue').value=prefs.hue||0;controls();}
async function send(action,extra={}){
  if(action==='status'&&polling)return;
  if(action==='status')polling=true;else revision++;
  const current=revision;let timer;
  try{
    const response=await Promise.race([chrome.runtime.sendMessage({action,...extra}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('本机服务响应较慢，正在检查连接；请确认 InfoLens 托盘服务已启动。')),8000);})]);
    if(current!==revision)return;
    if(!response||typeof response.ok!=='boolean'||typeof response.status!=='string')throw new Error('扩展后台未就绪，请关闭并重新打开面板；更新扩展后请重新加载。');
    $('status').textContent=response.status;$('status').dataset.error=String(!response.ok);
    if(typeof response.busy==='boolean')busy(response.busy);else if(!response.ok)busy(false);
    if(action==='status'&&response.ok&&Date.now()>editingUntil)reflect(response.prefs);
    return response;
  }catch(error){if(current===revision){$('status').textContent=error?.message||'扩展连接中断，请重新打开面板。';$('status').dataset.error='true';busy(false);}}
  finally{clearTimeout(timer);if(action==='status')polling=false;}
}
$('analyze').onclick=()=>{busy(true);$('status').dataset.error='false';$('status').textContent='已收到 · 正在读取网页，首次使用会加载模型…';send('analyze',{mode:$('mode').value});};
$('pause').onclick=()=>{busy(false);$('status').textContent='正在暂停…';send('pause');};
function controls(){
  $('weight').textContent=$('alpha').value+'%';$('value').textContent=$('intensity').value+'%';
  $('weight-control').hidden=$('mode').value!=='hybrid'||$('fusion').value!=='weighted';$('fusion-control').hidden=$('mode').value!=='hybrid';
  $('mode-note').textContent=$('mode').value==='information_density'?'快速：仅计算原文概率，跳过句子评分。':'先显示信息密度，再逐句评分；语义保底让重要句子整句清晰。';
  const hue=Number($('hue').value);document.querySelectorAll('[data-hue]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.hue)===hue)));
}
function appearance(){editingUntil=Date.now()+800;controls();send('appearance',{mode:$('mode').value,fusion:$('fusion').value||'semantic_floor',alpha:Number($('alpha').value)/100,style:$('style').value,intensity:Number($('intensity').value),hue:Number($('hue').value),rgb:hueRgb(Number($('hue').value)).join(' ')});}
for(let hue=0;hue<360;hue+=30){const button=document.createElement('button');button.dataset.hue=hue;button.setAttribute('aria-label',hue+'° 高亮');button.style.backgroundColor='rgb('+hueRgb(hue).join(' ')+')';button.onclick=()=>{$('hue').value=hue;appearance();};$('colors').append(button);}
$('mode').onchange=appearance;$('fusion').onchange=appearance;$('alpha').oninput=appearance;$('style').onchange=appearance;$('intensity').oninput=appearance;$('hue').oninput=appearance;
controls();send('status');setInterval(()=>send('status'),1000);

let automaticPattern=null;
chrome.tabs.query({active:true,currentWindow:true}).then(async([tab])=>{if(!/^https?:\/\//u.test(tab?.url||'')){ $('site-auto').disabled=true;return;}automaticPattern=new URL(tab.url).origin+'/*';const saved=await chrome.storage.local.get('automaticOrigins');$('site-auto').checked=saved.automaticOrigins?.includes(automaticPattern)===true;$('site-note').textContent=new URL(tab.url).hostname;}).catch(()=>{});
$('site-auto').onchange=async()=>{const enabled=$('site-auto').checked;if(!automaticPattern)return;try{
  if(enabled&&!await chrome.permissions.request({origins:[automaticPattern]})){ $('site-auto').checked=false;$('site-note').textContent='未获得本站权限，保留手动分析';return;}
  const saved=await chrome.storage.local.get('automaticOrigins'),origins=new Set(saved.automaticOrigins||[]);if(enabled)origins.add(automaticPattern);else{origins.delete(automaticPattern);await chrome.permissions.remove({origins:[automaticPattern]});}await chrome.storage.local.set({automaticOrigins:[...origins]});
  await send('siteAuto',{enabled});$('site-note').textContent=enabled?'已授权本站；工作台 Edge 自动分析开关控制是否运行':'本站已关闭，权限已撤销';if(enabled)await send('analyze',{mode:$('mode').value});
}catch(e){$('site-note').textContent=e.message;$('site-auto').checked=!enabled;}};
