import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../../edge-extension/page.js',import.meta.url),'utf8');
function fixture(){
  let observer,revision=0,disconnects=0,nextTimer=0;const timers=new Map(),messages=[];
  function element(tag='P',ignored=false){return {tagName:tag,nodeType:1,isConnected:true,nodes:[],getClientRects:()=>[{}],closest(selector){return selector.startsWith('script')?(ignored?this:null):(tag==='P'?this:null);}};}
  const root=element('ARTICLE'),parent=element(),node={nodeType:3,data:'Original text.',isConnected:true,parentElement:parent};root.nodes=[node];
  const highlights=new Map(),document={body:root,querySelector:()=>root,createTreeWalker:node=>{let i=0;return {nextNode:()=>node.nodes?.[i++]||null};},createRange:()=>({setStart(node,offset){this.start={node,offset};},setEnd(node,offset){this.end={node,offset};}})};
  const context=vm.createContext({setTimeout:f=>{timers.set(++nextTimer,f);return nextTimer;},clearTimeout:id=>timers.delete(id),chrome:{runtime:{sendMessage:m=>{messages.push(m);return Promise.resolve();}}},document,NodeFilter:{SHOW_TEXT:4},crypto:{randomUUID:()=>`revision-${++revision}`},CSS:{highlights},Highlight:class{constructor(...ranges){this.ranges=ranges;}},MutationObserver:class{constructor(callback){observer=callback;}observe(){}disconnect(){disconnects++;}},getComputedStyle:()=>({visibility:'visible',display:'block',color:'rgb(0, 0, 0)'})});
  vm.runInContext(source,context);
  const capture=()=>context.InfoLensPage.capture();
  const paint=s=>context.InfoLensPage.paint({revision:s.revision,spans:[{blockId:'b1',start:0,end:s.blocks[0].text.length,text:s.blocks[0].text,surprisalBits:5,finalScore:.5}]},{style:'foreground'});
  return {timers,messages,flush(){const pending=[...timers.values()];timers.clear();pending.forEach(f=>f());},context,root,parent,node,highlights,element,capture,paint,mutate:records=>observer(records),disconnects:()=>disconnects};
}

test('dynamic article controls, images and harmless wrappers do not erase text highlights',()=>{
  const f=fixture(),snap=f.capture();f.paint(snap);
  const control=f.element('BUTTON',true),counter={nodeType:3,data:'10 likes',parentElement:control};
  f.mutate([{type:'characterData',target:counter}]);
  f.mutate([{type:'childList',target:f.root,addedNodes:[control,f.element('IMG')]}]);
  const wrapper=f.element('SPAN');wrapper.nodes=[f.node];f.node.parentElement=wrapper;
  f.mutate([{type:'childList',target:f.root,addedNodes:[wrapper]}]);
  f.flush();assert.equal(f.context.InfoLensPage.valid(),true);assert.ok(f.highlights.size);assert.equal(f.paint(snap).spanCount,1);
});

function rootAppend(f,nodes){f.root.nodes.push(...nodes);}
for(const change of ['new paragraph','changed text','removed text','detached article']){
  test('real article change refreshes only affected ranges: '+change,()=>{
    const f=fixture(),snap=f.capture();f.paint(snap);let addedNodes=[];
    if(change==='new paragraph'){const paragraph=f.element();paragraph.nodes=[{nodeType:3,data:'New readable text.',parentElement:paragraph,isConnected:true}];addedNodes=[paragraph];rootAppend(f,paragraph.nodes);}
    if(change==='changed text')f.node.data+=' edit';
    if(change==='removed text')f.node.isConnected=false;
    if(change==='detached article')f.root.isConnected=false;
    f.mutate([{type:'childList',target:f.root,addedNodes}]);
    f.flush();assert.equal(f.context.InfoLensPage.valid(),false);
    assert.equal(f.highlights.size,change==='new paragraph'?1:0);
    assert.equal(f.paint(snap).spanCount,change==='new paragraph'?1:0);
    assert.equal(f.messages.at(-1).kind,'changed');
  });
}

test('old revision cleanup cannot clear a new capture and same-version reinjection retains ownership',()=>{
  const f=fixture(),old=f.capture();f.paint(old);const current=f.capture();f.paint(current);
  const api=f.context.InfoLensPage;assert.equal(api.clear(old.revision),false);assert.ok(f.highlights.size);
  vm.runInContext(source,f.context);assert.equal(f.context.InfoLensPage,api);assert.equal(api.valid(),true);
  api.dispose();assert.equal(api.valid(),false);assert.equal(f.highlights.size,0);assert.ok(f.disconnects()>=2);
});

test('browser heat preserves raw LaTeX ranges and keeps surrounding text highlighted',()=>{
 const f=fixture();f.node.data=String.raw`Before $G_j$ after.`;const snap=f.capture();
 const result=f.context.InfoLensPage.paint({revision:snap.revision,spans:[
  {blockId:'b1',start:0,end:6,text:'Before',surprisalBits:5,finalScore:.5},
  {blockId:'b1',start:8,end:11,text:'G_j',surprisalBits:5,finalScore:0}
 ]},{style:'fade'});
 assert.equal(result.spanCount,1);assert.equal(f.node.data,String.raw`Before $G_j$ after.`);
});

test('missing page body, missing native API and malformed results produce actionable errors',()=>{
  const f=fixture(),snap=f.capture();
  assert.throws(()=>f.context.InfoLensPage.paint(null),/分析结果为空/);
  f.context.CSS=null;assert.throws(()=>f.paint(snap),/请更新 Edge/);
  f.context.document.querySelector=()=>null;f.context.document.body=null;
  assert.throws(()=>f.capture(),/正文尚未加载/);
});


test('identical DOM replacement rebinds native ranges without invalidating or reanalyzing',()=>{
  const f=fixture(),snap=f.capture();f.paint(snap);
  const replacement={...f.node};f.node.isConnected=false;f.root.nodes=[replacement];
  f.mutate([{type:'childList',target:f.root,addedNodes:[replacement]}]);
  assert.equal(f.context.InfoLensPage.valid(),true);f.flush();
  assert.equal([...f.highlights.values()][0].ranges[0].start.node,replacement);
  assert.equal(f.messages[0].kind,'rebound');assert.equal(f.messages[0].revision,snap.revision);
});

test('equivalent normalized CRLF text can move to fresh LF nodes safely',()=>{
  const f=fixture();f.node.data='First.\r\nSecond.';const snap=f.capture();
  const replacement={...f.node,data:'First.\nSecond.'};f.node.isConnected=false;f.root.nodes=[replacement];
  f.mutate([{type:'childList',target:f.root,addedNodes:[replacement]}]);
  assert.equal(f.context.InfoLensPage.valid(),true);
  const drawn=f.context.InfoLensPage.paint({revision:snap.revision,spans:[{blockId:'b1',start:7,end:14,text:'Second.',surprisalBits:8}]});
  assert.equal(drawn.rangeCount,1);assert.equal([...f.highlights.values()][0].ranges[0].start.offset,7);
});

test('moving existing paragraphs schedules new context analysis while retaining exact-text ranges',()=>{
  const f=fixture(),parent=f.element(),second={nodeType:3,data:'Second paragraph.',parentElement:parent,isConnected:true};f.root.nodes.push(second);
  const snap=f.capture();f.paint(snap);f.root.nodes.reverse();
  f.mutate([{type:'childList',target:f.root,addedNodes:[second]}]);
  f.flush();assert.equal(f.context.InfoLensPage.valid(),false);assert.ok(f.highlights.size);
  assert.equal(f.messages[0].kind,'changed');
});

test('real edits debounce one refresh notification and pause stops future repaints',()=>{
  const f=fixture(),snap=f.capture();f.paint(snap);
  for(let i=0;i<5;i++){f.node.data+='!';f.mutate([{type:'characterData',target:f.node}]);}
  assert.equal(f.timers.size,1);assert.equal(f.highlights.size,0);f.flush();
  assert.equal(f.messages.length,1);assert.equal(f.messages[0].kind,'changed');
  assert.equal(f.paint(snap).spanCount,0);
  const next=f.capture();f.paint(next);f.node.data+='!';f.mutate([{type:'characterData',target:f.node}]);
  f.context.InfoLensPage.stop(next.revision);f.flush();assert.equal(f.messages.length,1);assert.equal(f.highlights.size,0);
});

test('scroll-time loose article text is ignored and does not trigger a model restart',()=>{
  const f=fixture(),snap=f.capture();f.paint(snap);
  const widget=f.element('DIV');widget.nodes=[{nodeType:3,data:'Read count 100',parentElement:widget,isConnected:true}];f.root.nodes.push(...widget.nodes);
  f.mutate([{type:'childList',target:f.root,addedNodes:[widget]}]);f.flush();
  assert.equal(f.context.InfoLensPage.valid(),true);assert.ok(f.highlights.size);
  assert.equal(f.messages.filter(m=>m.kind==='changed').length,0);
});

test('transient scroll-time paragraphs disappearing before debounce do not invalidate a document',()=>{
  const f=fixture(),snap=f.capture();f.paint(snap);
  const parent=f.element(),node={nodeType:3,data:'Transient.',parentElement:parent,isConnected:true};parent.nodes=[node];f.root.nodes.push(node);
  f.mutate([{type:'childList',target:f.root,addedNodes:[parent]}]);f.root.nodes.pop();node.isConnected=false;
  f.mutate([{type:'childList',target:f.root,addedNodes:[]}]);f.flush();
  assert.equal(f.context.InfoLensPage.valid(),true);assert.ok(f.highlights.size);
  assert.equal(f.messages.filter(m=>m.kind==='changed').length,0);
});

test('recapture retains exact-text styles until partial and complete results replace them',()=>{
  const f=fixture(),snap=f.capture();f.paint(snap);const current=f.capture();
  assert.ok(f.highlights.size,'capture keeps existing paint');
  const result={revision:current.revision,spans:[{blockId:'b1',start:0,end:8,text:'Original',surprisalBits:3,finalScore:.2}]};
  assert.equal(f.context.InfoLensPage.paint(result,{style:'foreground'}).spanCount,2,'unprocessed tail remains painted');
  assert.equal(f.context.InfoLensPage.paint({...result,complete:true},{style:'foreground'}).spanCount,1);
  assert.throws(()=>f.paint(snap),error=>error.code==='document_changed');
  assert.ok(f.highlights.size,'late revision cannot clear new paint');
});

test('changing one paragraph keeps unaffected paragraphs painted and does not carry stale scores into capture',()=>{
  const f=fixture(),parent=f.element(),second={nodeType:3,data:'Second.',parentElement:parent,isConnected:true};f.root.nodes.push(second);
  const snap=f.capture();f.context.InfoLensPage.paint({revision:snap.revision,spans:[{blockId:'b1',start:0,end:14,text:'Original text.',surprisalBits:5},{blockId:'b2',start:0,end:7,text:'Second.',surprisalBits:9}]});
  second.data='Edited.';f.mutate([{type:'characterData',target:second}]);f.flush();
  assert.equal([...f.highlights.values()].flatMap(h=>h.ranges).length,1);
  const next=f.capture();const drawn=f.context.InfoLensPage.paint({revision:next.revision,spans:[]});
  assert.equal(drawn.spanCount,1);assert.ok(f.highlights.size);
});
