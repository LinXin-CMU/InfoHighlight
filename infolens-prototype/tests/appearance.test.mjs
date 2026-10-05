import test from 'node:test';
import assert from 'node:assert/strict';
import { heatAppearance, hueRgb, fadeVisibility,scoreCurve,displayLevel } from '../appearance.mjs';
import { heatAppearance as edgeAppearance } from '../../edge-extension/appearance.mjs';
import { heatAppearance as vscodeAppearance } from '../../vscode-extension/appearance.mjs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const pdf=createRequire(import.meta.url)('../../zotero-plugin/core.js');

test('every heat style preserves monotonic score strength across the full intensity range',()=>{
  for(const intensity of [0,.25,1,1.5]){
    let previous=heatAppearance(0,intensity);
    for(let score=.01;score<=1;score+=.01){
      const current=heatAppearance(score,intensity);
      for(const field of ['backgroundOpacity','tintPercent','underlineOpacity','fadePercent'])assert.ok(current[field]>=previous[field]-1e-10,`${field} inverted at ${score}`);
      previous=current;
    }
  }
});
test('zero intensity restores original paint and extreme inputs remain bounded',()=>{
  for(const score of [0,.4,1])assert.ok(Object.entries(heatAppearance(score,0)).every(([key,value])=>value===(key==='fadePercent'?100:0)));
  for(const [score,intensity] of [[-1,-1],[2,8],[NaN,NaN]]){
    const p=heatAppearance(score,intensity);assert.ok(Object.values(p).every(Number.isFinite));assert.ok(p.backgroundOpacity>=0&&p.backgroundOpacity<=.75);assert.ok(p.fadePercent>=3-1e-10&&p.fadePercent<=100);
  }
});
test('paint retains sixteen display levels after the curve and saturates its right tail',()=>{
  const levels=new Set(Array.from({length:1001},(_,i)=>displayLevel(i/1000)));
  assert.equal(levels.size,16);assert.equal(Math.min(...levels),0);assert.equal(Math.max(...levels),15);
  assert.equal(heatAppearance(19/18).backgroundOpacity,.5);
  assert.equal(heatAppearance(.11/18).backgroundOpacity,0);
  assert.ok(Math.abs(heatAppearance(0).fadePercent-8)<1e-10);
  assert.equal(heatAppearance(1).fadePercent,100);
  for(const score of [.8,.9,1])assert.deepEqual(heatAppearance(score),heatAppearance(1));
  assert.ok(heatAppearance(.5).tintPercent>=75,'mid-score words should now be visibly colored');
});

test('cubic-bezier transfer has flat endpoint tangents, a smooth saturation join, and no score inversions',()=>{
  const h=.00001;
  assert.equal(scoreCurve(0),0);assert.equal(scoreCurve(.8),1);
  assert.ok(scoreCurve(h)/h<.001);assert.ok((1-scoreCurve(.8-h))/h<.001);
  assert.equal(scoreCurve(.8+h),1);
  let previous=0;for(let i=0;i<=1000;i++){const current=scoreCurve(i/1000);assert.ok(current>=previous&&current<=1);previous=current;}
  assert.ok(scoreCurve(.02)<.01,'low scores retain a gentle start');
  assert.ok(scoreCurve(.5)>.75,'middle scores receive more emphasis');
  // A known Bezier point at t=.5 has x=.325 (after the .8 cap), y=.5.
  assert.ok(Math.abs(scoreCurve(.325)-.5)<1e-8);
});
test('hue wraps and returns finite displayable RGB components',()=>{
  assert.deepEqual(hueRgb(0),hueRgb(360));assert.deepEqual(hueRgb(-30),hueRgb(330));
  for(let h=0;h<=360;h++)assert.ok(hueRgb(h).every(c=>Number.isInteger(c)&&c>=0&&c<=255));
});

test('weak text is much fainter, maximum strength keeps improving contrast, and highest scores stay fully clear',()=>{
  assert.ok(Math.abs(fadeVisibility(0,1)-.08)<1e-10);
  assert.ok(Math.abs(fadeVisibility(0,1.5)-.03)<1e-10);
  assert.ok(fadeVisibility(.5,1)>.7);assert.ok(fadeVisibility(.5,1.5)>.7);
  for(let i=0;i<16;i++){
    const score=i/16;let previous=1;
    for(let step=0;step<=150;step++){
      const visibility=fadeVisibility(score,step/100);
      assert.ok(visibility<=previous+1e-10);assert.ok(visibility>=.03-1e-10&&visibility<=1);
      for(const client of [edgeAppearance,vscodeAppearance,pdf.heatAppearance])assert.deepEqual(client(score,step/100),heatAppearance(score,step/100));
      assert.equal(pdf.fadeVisibility(score,step/100),visibility);
      if(i===15)assert.equal(visibility,1);
      previous=visibility;
    }
  }
});

test('injected Edge renderer applies the same strong fade curve to native highlight ranges without rewriting text',async()=>{
  const text='abcdefghijklmnop',node={data:text,isConnected:true,parentElement:{closest:()=>null,getClientRects:()=>[{}]}};
  const root={tagName:'MAIN'},highlights=new Map();
  const document={body:root,querySelector:()=>root,createTreeWalker:()=>{let used=false;return {nextNode:()=>used?null:(used=true,node)};},createRange:()=>({setStart(){},setEnd(){}})};
  const context=vm.createContext({setTimeout,clearTimeout,document,NodeFilter:{SHOW_TEXT:4},crypto:{randomUUID:()=> 'revision'},CSS:{highlights},Highlight:class{constructor(...ranges){this.ranges=ranges;}},MutationObserver:class{observe(){}disconnect(){}},getComputedStyle:()=>({visibility:'visible',display:'block',color:'rgb(0, 0, 0)'})});
  vm.runInContext(await readFile(new URL('../../edge-extension/page.js',import.meta.url),'utf8'),context);
  const snap=context.InfoLensPage.capture(),spans=Array.from({length:16},(_,i)=>({blockId:'b1',start:i,end:i+1,surprisalBits:1,finalScore:i/16}));
  for(const intensity of [0,100,150]){
    const result=context.InfoLensPage.paint({revision:snap.revision,spans},{style:'fade',intensity});
    assert.equal(result.rangeCount,16);
    for(let i=0;i<16;i++){
      const rule=result.cssRules.find(r=>r.startsWith(`::highlight(infolens-${displayLevel(i/16)}-0)`));
      const percent=Number(rule.match(/\) ([\d.eE+-]+)%,transparent/)[1]);assert.ok(Math.abs(percent-heatAppearance(i/16,intensity/100).fadePercent)<1e-10);
    }
    assert.equal(node.data,text);
    for(const style of ['background','foreground','underline']){
      const rendered=context.InfoLensPage.paint({revision:snap.revision,spans},{style,intensity});
      for(let i=1;i<16;i++){
        const rule=rendered.cssRules.find(r=>r.startsWith(`::highlight(infolens-${displayLevel(i/16)}-0)`)),a=heatAppearance(i/16,intensity/100);
        if(displayLevel(i/16)===0){assert.equal(rule,undefined);continue;}
        assert.ok(rule,`${style} range missing at ${i/16}`);
        assert.ok(rule.includes(style==='foreground'?`${a.tintPercent}%`:`/ ${style==='background'?a.backgroundOpacity:a.underlineOpacity})`));
      }
    }
  }
});

test('classic Edge and Zotero bundles embed the canonical curve implementation exactly',async()=>{
  const pattern=/\/\/ BEGIN SHARED PAINT[\s\S]*?\/\/ END SHARED PAINT/;
  const canonical=(await readFile(new URL('../appearance.mjs',import.meta.url),'utf8')).match(pattern)[0].replace(/^export /gm,'');
  for(const path of ['../../edge-extension/page.js','../../zotero-plugin/core.js'])assert.equal((await readFile(new URL(path,import.meta.url),'utf8')).match(pattern)[0],canonical);
});
