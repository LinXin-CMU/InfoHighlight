import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {hueRgb} from '../appearance.mjs';
const source=await readFile(new URL('../../edge-extension/popup.js',import.meta.url),'utf8');
const html=await readFile(new URL('../../edge-extension/popup.html',import.meta.url),'utf8');
function fixture(){
  const elements=new Map(),requests=[],timers=new Map();let timer=0,poll;
  function element(id){if(!elements.has(id))elements.set(id,{value:({mode:'information_density',alpha:'40',style:'fade',intensity:'100',hue:'0'})[id]||'',dataset:{},style:{},textContent:'',setAttribute(name,value){this[name]=value;},append(){}});return elements.get(id);}
  const context={hueRgb,document:{getElementById:element,querySelectorAll:()=>[],createElement:()=>element('button-'+elements.size)},chrome:{tabs:{query:async()=>[]},runtime:{sendMessage:request=>new Promise(resolve=>requests.push({request,resolve}))}},setInterval:f=>{poll=f;},setTimeout:f=>{timers.set(++timer,f);return timer;},clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(source.replace(/^import[^\n]+\n/gm,''),context);
  return {element,requests,poll:()=>poll(),timeout:()=>[...timers.values()].forEach(f=>f())};
}
const settle=()=>new Promise(r=>setImmediate(r));
test('click feedback is synchronous and visible above the long appearance controls',async()=>{
  const f=fixture();f.element('analyze').onclick();
  assert.match(f.element('status').textContent,/已收到/);assert.equal(f.element('analyze').disabled,true);
  assert.ok(html.indexOf('id="status"')<html.indexOf('id="mode"'));
  assert.equal(f.requests[1].request.mode,'information_density');
  f.requests[1].resolve({ok:true,status:'正在读取网页',busy:true});await settle();
  f.requests[0].resolve({ok:true,status:'点击分析当前网页',busy:false});await settle();
  assert.equal(f.element('status').textContent,'正在读取网页');assert.equal(f.element('analyze').disabled,true);
});
test('failed or unresponsive connections show actionable feedback and allow retry',async()=>{
  const f=fixture();f.element('analyze').onclick();f.timeout();await settle();
  assert.match(f.element('status').textContent,/本机服务响应较慢/);assert.equal(f.element('analyze').disabled,false);
});
test('popup never overlaps status polling while the native bridge is slow',async()=>{
  const f=fixture();f.poll();f.poll();assert.equal(f.requests.length,1);
  f.requests[0].resolve({ok:true,status:'ready',busy:false});await settle();f.poll();assert.equal(f.requests.length,2);
});
