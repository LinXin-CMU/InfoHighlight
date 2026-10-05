import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const core=createRequire(import.meta.url)('../../zotero-plugin/core.js');
function snapshot(raw){
 const nodes=raw.map(data=>({data,isConnected:true,parentElement:{closest:()=>null}}));
 const doc={createTreeWalker:()=>{let i=0;return {nextNode:()=>nodes[i++]};},createRange:()=>({setStart(node,offset){this.start=offset;this.node=node;},setEnd(node,offset){this.end=offset;},toString(){return this.node.data.slice(this.start,this.end);}})};
 nodes.forEach(n=>n.ownerDocument=doc);const layer={isConnected:true};const page={ownerDocument:doc,isConnected:true,querySelector:()=>layer};return core.capture(page);
}
test('Zotero mapping preserves CRLF, emoji and combining clusters and rejects stale or invented spans',()=>{
 const s=snapshot(['中文\r\nA 👩🏽‍💻 é','Next run']);assert.equal(s.text,'中文\nA 👩🏽‍💻 é\n\nNext run');
 const end=s.text.indexOf('A');assert.equal(core.ranges(s,{start:0,end,text:s.text.slice(0,end)})[0].toString(),'中文\r\n');
 const start=s.text.indexOf('👩');assert.equal(core.ranges(s,{start,end:start+7,text:s.text.slice(start,start+7)}).length,1);
 assert.equal(core.ranges(s,{start,end:start+2,text:s.text.slice(start,start+2)}).length,0);
 assert.equal(core.ranges(s,{start:0,end:2,text:'伪造'}).length,0);s.segments[0].node.data+='changed';assert.equal(core.ranges(s,{start:0,end:2,text:'中文'}).length,0);
});
test('PDF styles preserve missing signals and translation plans no longer reject pages with 129 text runs',()=>{
 assert.equal(core.appearance({style:'foreground',hue:210,intensity:1}).fallback,false);assert.equal(core.appearance({style:'fade',hue:0,intensity:1}).style,'fade');
 assert.equal(core.appearance({style:'background',hue:0,intensity:0}).style,'background');
 assert.throws(()=>core.appearance({style:'underline',hue:NaN,intensity:1}));assert.equal(core.score({surprisalNormalized:null,semantic:null}),null);
 const s=snapshot(['A','B']);assert.deepEqual(core.translationBlocks(s,2).map(b=>b.id),['pdf-2-paragraph-0','pdf-2-paragraph-1']);
 assert.equal(core.translationBlocks(snapshot(Array(129).fill('a')),1).length,129);
 assert.throws(()=>snapshot(['a'.repeat(30001)]),/30,000/);
});

test('PDF fade matches workbench calibration: higher scores remain clearer, zero strength restores all ink',()=>{
 for(const intensity of [0,.3,1,1.5]){let previous=0;for(let i=0;i<=100;i++){const value=core.fadeVisibility(i/100,intensity);assert.ok(value>=previous);assert.ok(value>=.03-1e-10&&value<=1);previous=value;}}
 assert.ok(Math.abs(core.fadeVisibility(0,1)-.08)<1e-10);assert.equal(core.fadeVisibility(1,1),1);assert.equal(core.fadeVisibility(0,0),1);
});
