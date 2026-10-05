import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {createServer} from '../server.mjs';
const core=createRequire(import.meta.url)('../../zotero-plugin/core.js');
const pause=()=>new Promise(r=>setTimeout(r,5));
test('running jobs publish revision-bound cumulative results before completion; cancellation rejects late partials and cache writes',async()=>{
 let publish,finish;
 const provider={source:'local_models',status:()=>({state:'ready'}),close(){},async analyze(blocks,profile,{onPartial}){publish=onPartial;onPartial({blocks:[{...blocks[0],candidates:[{start:0,end:4,text:'One.'}]}]});return await new Promise(r=>finish=r);}};
 const server=createServer({provider,stageDelayMs:0});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const token=(await(await fetch(base+'/v1/session',{headers:{'X-InfoLens-Client':'test'}})).json()).token;
 const api=async(url,method='GET',body)=>await(await fetch(base+url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})).json();
 try{
  const job=await api('/v1/jobs','POST',{document:{id:'test',revision:'r1'},blocks:[{id:'b1',text:'One. Two.'}]});while(!publish)await pause();
  const first=await api('/v1/jobs/'+job.jobId);assert.equal(first.status,'running');assert.equal(first.result,undefined);assert.equal(first.partial.sequence,1);assert.equal(first.partial.revision,'r1');assert.equal(first.partial.contentHash,job.contentHash);assert.equal(first.partial.analysis.blocks[0].candidates.length,1);
  publish({blocks:[{id:'b1',text:'One. Two.',candidates:[{start:0,end:4,text:'One.'},{start:5,end:9,text:'Two.'}]}]});assert.equal((await api('/v1/jobs/'+job.jobId)).partial.sequence,2);
  await api('/v1/jobs/'+job.jobId,'DELETE');publish({blocks:[]});finish({blocks:[]});await pause();
  const cancelled=await api('/v1/jobs/'+job.jobId);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.partial,undefined);assert.equal(cancelled.result,undefined);assert.equal((await api('/v1/status')).cacheEntries,0);
 }finally{await new Promise(r=>server.close(r));}
});

function pdfFixture(runs){
 let pixels=[255,255,255,255],reads=0;
 class Element{constructor(){this.children=[];this.style={};this.dataset={};this.isConnected=false;}append(...nodes){nodes.forEach(n=>{n.parent=this;n.isConnected=true;this.children.push(n);});}remove(){this.isConnected=false;if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}setAttribute(){}getContext(){return {font:'',measureText:t=>({width:t.length*7}),getImageData:()=>({data:[255,255,255,255]})};}}
 const page=new Element();page.isConnected=true;page.clientWidth=600;page.clientHeight=900;page.clientLeft=page.clientTop=0;page.getBoundingClientRect=()=>({left:0,top:0,width:600,height:900});
 const nodes=runs.map(([text,left,top,width=200,height=16])=>({data:text,isConnected:true,parentElement:{closest:()=>null},rect:{left,top,width,height,right:left+width,bottom:top+height}}));
 const layer={isConnected:true};const canvas=new Element();canvas.width=600;canvas.height=900;canvas.getBoundingClientRect=page.getBoundingClientRect;
 const original=canvas.getContext();original.getImageData=()=>{reads++;const data=new Uint8ClampedArray(canvas.width*canvas.height*4);for(let i=0;i<data.length;i+=4)data.set(pixels,i);return {data};};canvas.getContext=()=>original;
 const doc={createElement:()=>new Element(),createTreeWalker:()=>{let i=0;return {nextNode:()=>nodes[i++]};},createRange:()=>({selectNodeContents(n){this.node=n;},setStart(n){this.node=this.startContainer=n;},setEnd(){},getClientRects(){return [this.node.rect];}})};nodes.forEach(n=>n.ownerDocument=doc);page.ownerDocument=doc;
 page.querySelector=s=>s==='.textLayer'?layer:s==='canvas'?canvas:null;page.querySelectorAll=s=>page.children.filter(n=>s.includes(n.className));
 return {page,nodes,setPixels:value=>{pixels=value;},reads:()=>reads,snapshot:core.capture(page)};
}
test('PDF line fragments merge into paragraphs, columns stay separate, and scrolling reorders only pending paragraphs',()=>{
 const {snapshot}=pdfFixture([['Left first',40,100,100],['line end.',145,100,100],['Wrapped line.',40,120,210],['Next paragraph.',60,160,190],['Right column.',340,100,210]]);
 const plan=core.translationPlan(snapshot,1);assert.equal(plan.length,3);assert.equal(plan[0].text,'Left first line end. Wrapped line.');assert.equal(plan[0].lines.length,2);
 const pending=new Set(plan.map(b=>b.id));const view=(top,bottom)=>({left:0,right:600,top,bottom});
 const first=core.prioritize(plan,pending,view(150,190))[0];assert.equal(first.id,plan[1].id);pending.delete(first.id);
 const next=core.prioritize(plan,pending,{left:330,right:600,top:90,bottom:130})[0];assert.equal(next.id,plan[2].id);assert.equal(core.prioritize(plan,pending,view(150,190)).some(b=>b.id===first.id),false);
});
test('incremental heat and paragraph translation preserve completed DOM nodes; too-long translations leave original text visible',()=>{
 const {page,snapshot}=pdfFixture([['First.',40,100],['Second.',40,160]]);
 const settings={style:'background',hue:0,intensity:1};const a={start:0,end:6,text:'First.',surprisalNormalized:.6};const b={start:8,end:15,text:'Second.',surprisalNormalized:.8};
 core.paint(snapshot,[a],settings);const layer=page.children[0],mark=layer.children[0];const update=core.paint(snapshot,[a,b],settings);assert.equal(page.children[0],layer);assert.equal(layer.children[0],mark);assert.equal(update.updated,1);assert.equal(update.painted,2);
 const blocks=core.translationBlocks(snapshot,1),row=i=>({id:blocks[i].id,source:blocks[i].text,translated:'中文译文',status:'ready'});
 core.paintTranslation(snapshot,[row(0)],1);const translations=page.children.find(n=>n.className==='infolens-translation-layer'),existing=translations.children[0];core.paintTranslation(snapshot,[row(0),row(1)],1);assert.equal(translations.children[0],existing);assert.equal(translations.children.length,4);
 const tooLong=core.paintTranslation(snapshot,[{...row(0),translated:'长'.repeat(300)}],1);assert.equal(tooLong.painted,0);assert.equal(tooLong.skipped,1);assert.equal(translations.children.length,0);
});

test('canonical PDF source aligns across changed DOM separators and rejects any missing source words',()=>{
 const {page}=pdfFixture([['First.',40,100],['Second.',40,160]]);
 const source=core.textContentSource({items:[{str:'First.',transform:[1,0,0,16,40,700],height:16,width:200},{str:'Second.',transform:[1,0,0,16,40,680],height:16,width:200}]});
 assert.equal(source,'First. Second.');const aligned=core.capture(page,source);assert.equal(aligned.segments[1].start,7);assert.equal(core.ranges(aligned,{start:7,end:14,text:'Second.'}).length,1);
 assert.throws(()=>core.capture(page,'First. Missing. Second.'),/不匹配/);assert.throws(()=>core.capture(page,'First. Second. Missing.'),/尚未完整/);
});

test('PDF.js ligature normalization maps complete equivalent glyphs and rejects their interior offsets',()=>{
 const {page}=pdfFixture([['The ﬁrst.',40,100]]),snapshot=core.capture(page,'The first.');
 assert.equal(snapshot.text,'The first.');assert.equal(core.ranges(snapshot,{start:4,end:6,text:'fi'}).length,1);
 assert.equal(core.ranges(snapshot,{start:4,end:5,text:'f'}).length,0);assert.equal(core.ranges(snapshot,{start:5,end:6,text:'i'}).length,0);
 assert.throws(()=>core.capture(page,'The final.'),/不匹配/);
});

test('translated paragraphs use their own scores and keep the original heat layer present',()=>{
 const {page,snapshot}=pdfFixture([['First.',40,100],['Second.',40,160]]),settings={style:'underline',hue:210,intensity:1};
 const candidates=[{start:0,end:6,text:'First.',surprisalNormalized:.8,semantic:.9}];core.paint(snapshot,candidates,settings);
 const blocks=core.translationBlocks(snapshot,1),row={id:blocks[0].id,source:blocks[0].text,translated:'中文译文',status:'ready',analysisVersion:1,analysis:{blocks:[{text:'中文译文',candidates:[{start:0,end:4,text:'中文译文',surprisalNormalized:.8}]}]}};
 const painted=core.paintTranslation(snapshot,[row],1,0,{snapshot,candidates,settings});assert.equal(painted.highlighted,1);assert.equal(page.children.filter(n=>n.className==='infolens-local-layer').length,1);
 const translated=page.children.find(n=>n.className==='infolens-translation-layer').children[1];assert.match(translated.children[0].style.cssText,/text-decoration:underline/);
 const plain=core.paintTranslation(snapshot,[{...row,analysis:null,analysisVersion:2}],1,0,{snapshot,candidates:[],settings});assert.equal(plain.highlighted,0);assert.doesNotMatch(page.children.find(n=>n.className==='infolens-translation-layer').children[1].children[0].style.cssText||'',/text-decoration/);
});

test('short translations paint heat only on nonempty translated lines',()=>{
 const {page,snapshot}=pdfFixture([['First long line.',40,100],['Second long line.',40,120]]),settings={style:'underline',hue:0,intensity:1};
 const block=core.translationBlocks(snapshot,1)[0],candidates=[{start:0,end:snapshot.text.length,text:snapshot.text,surprisalNormalized:.8}];
 core.paintTranslation(snapshot,[{id:block.id,source:block.text,translated:'短译文',status:'ready',analysisVersion:1,analysis:{blocks:[{text:'短译文',candidates:[{start:0,end:3,text:'短译文',surprisalNormalized:.8}]}]}}],1,0,{snapshot,candidates,settings});
 const nodes=page.children.find(n=>n.className==='infolens-translation-layer').children;
 assert.match(nodes[1].children[0].style.cssText,/text-decoration:underline/);assert.equal(nodes[3].children.length,0);assert.doesNotMatch(nodes[3].style.cssText,/text-decoration/);
});


test('PDF fade dims evaluated low-score ink, preserves high and unknown ink, restores at zero intensity and caches background sampling',()=>{
 const f=pdfFixture([['First.',40,100],['Second.',40,160],['Unknown.',40,220]]),settings={style:'fade',hue:0,intensity:1};
 const candidates=[{start:0,end:6,text:'First.',surprisalNormalized:0},{start:8,end:15,text:'Second.',surprisalNormalized:1},{start:17,end:25,text:'Unknown.',surprisalNormalized:null,semantic:null}];
 const result=core.paint(f.snapshot,candidates,settings),layer=f.page.children[0];assert.equal(result.style,'fade');assert.equal(result.fallback,false);assert.equal(result.painted,1);assert.equal(layer.children.length,1);
 assert.match(layer.children[0].style.cssText,/height:16px/);assert.match(layer.children[0].style.cssText,/rgba\(255,255,255,0.92\)/);assert.doesNotMatch(layer.style.cssText,/mix-blend-mode/);
 const reads=f.reads(),node=layer.children[0];assert.equal(core.paint(f.snapshot,candidates,settings).updated,0);assert.equal(f.reads(),reads);assert.equal(layer.children[0],node);
 core.paint(f.snapshot,candidates,{...settings,intensity:0});assert.equal(layer.children.length,0);assert.deepEqual(f.nodes.map(n=>n.data),['First.','Second.','Unknown.']);
});
test('PDF foreground uses screen compositing for glyph ink and switching styles removes its old underline marks',()=>{
 const f=pdfFixture([['First.',40,100],['Second.',40,160]]),candidates=[{start:0,end:6,text:'First.',surprisalNormalized:.2},{start:8,end:15,text:'Second.',surprisalNormalized:.9}];
 core.paint(f.snapshot,candidates,{style:'underline',hue:0,intensity:1});const layer=f.page.children[0],old=[...layer.children];
 const result=core.paint(f.snapshot,candidates,{style:'foreground',hue:0,intensity:1});assert.equal(result.style,'foreground');assert.equal(result.fallback,false);assert.match(layer.style.cssText,/mix-blend-mode:screen/);assert.ok(old.every(n=>!n.isConnected));
 assert.ok(layer.children.every(n=>/height:16px/.test(n.style.cssText)));for(let i=0;i<2;i++)assert.ok(layer.children[i].style.cssText.includes(`rgba(255,71,64,${core.heatAppearance(candidates[i].surprisalNormalized).underlineOpacity})`));
 // Screen blend against white stays white; against black it yields the tint.
 for(const color of [255,71,64]){assert.equal(255-(255-color)*(255-255)/255,255);assert.equal(255-(255-color)*(255-0)/255,color);}
 core.paint(f.snapshot,candidates,{style:'fade',hue:0,intensity:1});assert.doesNotMatch(layer.style.cssText,/mix-blend-mode/);
});
test('uncertain PDF backgrounds preserve original glyphs and never fall back to underline',()=>{
 const f=pdfFixture([['First.',40,100]]),candidates=[{start:0,end:6,text:'First.',surprisalNormalized:.4}];f.setPixels([190,20,80,255]);
 core.paint(f.snapshot,candidates,{style:'underline',hue:0,intensity:1});const result=core.paint(f.snapshot,candidates,{style:'fade',hue:0,intensity:1});assert.equal(result.fallback,false);assert.equal(result.painted,0);assert.equal(result.skipped,1);assert.equal(f.page.children[0].children.length,0);
 assert.equal(core.paint(f.snapshot,candidates,{style:'foreground',hue:0,intensity:1}).painted,0);
});
test('translated text supports real fade and foreground color without underlines and preserves unknown signal readability',()=>{
 const f=pdfFixture([['First.',40,100]]),block=core.translationBlocks(f.snapshot,1)[0];
 const row={id:block.id,source:block.text,translated:'中文译文',status:'ready',analysisVersion:1,analysis:{blocks:[{text:'中文译文',candidates:[{start:0,end:4,text:'中文译文',surprisalNormalized:0}]}]}};
 const heat={settings:{style:'fade',hue:0,intensity:1}},word=()=>f.page.children.find(n=>n.className==='infolens-translation-layer').children[1].children[0];
 core.paintTranslation(f.snapshot,[row],1,0,heat);assert.match(word().style.color,/rgba\(23,43,52,0.0?8\d*\)/);assert.doesNotMatch(word().style.cssText||'',/text-decoration/);
 row.analysis.blocks[0].candidates[0].surprisalNormalized=1;row.analysisVersion++;heat.settings.style='foreground';core.paintTranslation(f.snapshot,[row],1,0,heat);assert.equal(word().style.color,'rgb(255,71,64)');assert.doesNotMatch(word().style.cssText||'',/text-decoration|linear-gradient/);
 row.analysis=null;row.analysisVersion++;heat.settings.style='fade';core.paintTranslation(f.snapshot,[row],1,0,heat);assert.equal(word().style.color,undefined);assert.equal(word().textContent,'中文译文');
});
