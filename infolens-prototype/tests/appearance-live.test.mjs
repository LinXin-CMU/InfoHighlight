import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveAppearanceWriter} from '../client-appearance-ui.mjs';
import {createAppearanceStore} from '../client-settings.mjs';
const settings=(hue,style='background')=>({style,hue,intensity:1});
const override=hue=>({inherit:false,settings:settings(hue)});
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){
  const store=createAppearanceStore(),states=[],writes=[];let timer,hold=null,release;
  const writer=createLiveAppearanceWriter({delayMs:180,setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>{timer=null;},onSnapshot:()=>{},onState:(...s)=>states.push(s),api:async(route,options)=>{
    if(!options)return store.snapshot();const body=JSON.parse(options.body);writes.push({route,body});
    if(hold){await new Promise(r=>release=r);hold=null;}return store.update(route.split('/').at(-1),body);
  }});writer.accept(store.snapshot());
  return {store,writer,states,writes,fire:()=>timer?.(),hold:()=>{hold=true;},release:()=>release?.()};
}
test('slider edits autosave only their latest value and independent cards share one revision queue',async()=>{
  const f=fixture();for(const hue of [20,50,210])f.writer.queue('zotero',override(hue));f.writer.queue('vscode',override(180));
  await f.fire();assert.equal(f.writes.length,2);assert.equal(f.store.snapshot().clients.zotero.effective.hue,210);assert.equal(f.store.snapshot().clients.vscode.effective.hue,180);assert.equal(f.store.snapshot().revision,2);
});
test('input received during a save survives its acknowledgement and still respects debounce',async()=>{
  const f=fixture();f.hold();const first=f.writer.queue('zotero',override(30));const flight=f.writer.flush();await tick();const second=f.writer.queue('zotero',override(275));
  f.release();await flight;await tick();assert.equal(f.store.snapshot().clients.zotero.effective.hue,30);assert.ok(f.states.some(s=>s[1]==='saved'&&s[2]===first));
  await f.fire();assert.equal(f.store.snapshot().clients.zotero.effective.hue,275);assert.ok(f.states.some(s=>s[1]==='saved'&&s[2]===second));assert.equal(f.states.filter(s=>s[1]==='error').length,0);
});
test('an unrelated external change rebases safely while a same-client conflict preserves the external preference',async()=>{
  const f=fixture();f.writer.queue('zotero',override(210));await f.store.update('edge',{revision:0,...override(120)});await f.writer.flush();
  assert.equal(f.store.snapshot().clients.edge.effective.hue,120);assert.equal(f.store.snapshot().clients.zotero.effective.hue,210);
  f.writer.queue('zotero',override(30));await f.store.update('zotero',{revision:2,...override(330)});await f.writer.flush();assert.equal(f.store.snapshot().clients.zotero.effective.hue,330);assert.equal(f.states.at(-1)[1],'error');assert.equal(f.states.at(-1)[3].status,409);
  f.writer.queue('zotero',override(30));await f.writer.flush();assert.equal(f.store.snapshot().clients.zotero.effective.hue,30);
});
test('a disk or connection failure never reports a saved preference and explicit retry can recover',async()=>{
  const snapshots=[],states=[];let failed=true,timer;const store=createAppearanceStore();
  const writer=createLiveAppearanceWriter({setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>{},onSnapshot:s=>snapshots.push(s),onState:(...s)=>states.push(s),api:async(route,options)=>{if(failed)throw Error('服务未连接');return store.update('zotero',JSON.parse(options.body));}});
  writer.accept(store.snapshot());writer.queue('zotero',override(210));await timer();assert.equal(states.at(-1)[1],'error');assert.equal(snapshots.length,1);assert.equal(store.snapshot().revision,0);
  failed=false;writer.queue('zotero',override(210));await writer.flush();assert.equal(store.snapshot().clients.zotero.effective.hue,210);assert.equal(states.at(-1)[1],'saved');
});
test('unified live edits affect only inheriting clients and stale poll snapshots are ignored',async()=>{
  const f=fixture(),old=f.store.snapshot();f.writer.queue('defaults',{settings:settings(180,'fade')});await f.writer.flush();f.writer.accept(old);
  f.writer.queue('workbench',override(275));await f.writer.flush();assert.equal(f.store.snapshot().clients.edge.effective.style,'fade');assert.equal(f.store.snapshot().clients.zotero.effective.style,'underline');assert.equal(f.store.snapshot().clients.workbench.effective.hue,275);assert.equal(f.states.filter(s=>s[1]==='error').length,0);
});
