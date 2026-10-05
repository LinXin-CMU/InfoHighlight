import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pdfFixture} from './pdf-render-fixture.mjs';
const core=createRequire(import.meta.url)('../../zotero-plugin/core.js');
const settings=style=>({style,hue:0,intensity:1.5});

test('unchanged PDF capture and repaint perform no glyph layout or canvas reads, including scrolling',()=>{
  const f=pdfFixture(Array.from({length:100},(_,i)=>'Line '+i)),snapshot=core.capture(f.page);
  const candidates=snapshot.segments.map(s=>({start:s.start,end:s.end,text:s.text,surprisalNormalized:.2,semantic:null}));
  core.paint(snapshot,candidates,settings('fade'));assert.equal(f.metrics.pixels,1,'one canvas read instead of a readback per sampled glyph');
  const before={...f.metrics};f.move(-200);
  assert.equal(core.captureCached(f.page,null,snapshot),snapshot);
  assert.equal(core.paint(snapshot,candidates,settings('fade')).cached,true);
  assert.deepEqual(f.metrics,before);
  core.paint(snapshot,candidates.map(c=>({...c,surprisalNormalized:.5})),settings('fade'));
  assert.equal(f.metrics.rects,before.rects,'partial scores reuse cached Range geometry');assert.equal(f.metrics.pixels,1);
});

test('translated words carry their own scores and support every appearance style',()=>{
  const f=pdfFixture(['Source paragraph.']),snapshot=core.capture(f.page),plan=core.translationPlan(snapshot,1);
  const text='递归模型保留上下文。',pieces=[['递归',.15],['模型',.8],['保留',.3],['上下文',.7],['。',.1]];let offset=0;
  const candidates=pieces.map(([part,value])=>{const start=offset;offset+=part.length;return {start,end:offset,text:part,surprisalNormalized:value,semantic:null};});
  const row={id:plan[0].id,source:plan[0].text,translated:text,status:'ready',analysis:{blocks:[{text,candidates}]},analysisVersion:1,analysisStatus:'completed'};
  for(const style of ['fade','foreground','underline','background']){
    const result=core.paintTranslation(snapshot,[row],1,0,{settings:settings(style)});
    assert.equal(result.painted,1);assert.equal(result.highlightedWords,5);assert.equal(result.translatedAnalysisParagraphs,1);
    const words=f.all().filter(n=>n.dataset?.infolensScore!==undefined);
    assert.equal(words.map(n=>n.textContent).join(''),text);assert.ok(new Set(words.map(n=>n.dataset.infolensLevel)).size>=3);
    assert.ok(words.every(n=>n.dataset.infolensStyle===style));
  }
  const before={...f.metrics};f.move(-100);
  assert.equal(core.paintTranslation(snapshot,[row],1,0,{settings:settings('background')}).cached,true);assert.deepEqual(f.metrics,before);
});

test('translation analysis is bound to rendered text and pending output stays readable',()=>{
  const f=pdfFixture(['Source paragraph.']),snapshot=core.capture(f.page),block=core.translationPlan(snapshot,1)[0];
  const row={id:block.id,source:block.text,translated:'真实译文',status:'ready',analysis:{blocks:[{text:'过期译文',candidates:[]}]},analysisVersion:1};
  const result=core.paintTranslation(snapshot,[row],1,0,{settings:settings('fade')});
  assert.equal(result.painted,1);assert.equal(result.highlightedWords,0);assert.equal(result.translatedAnalysisParagraphs,0);
  assert.equal(f.all().find(n=>n.dataset.infolensParagraph).dataset.infolensAnalysis,'pending');
});

test('translation fitting keeps exact UTF16 offsets and complete graphemes across lines',()=>{
  const context={font:'',measureText:text=>({width:[...text].length*6})},text='递归 é 👩🏽‍💻 LSTM 保留上下文';
  const layout=core.fitTranslationLayout(text,Array(10).fill({width:72}),context,12);
  assert.ok(layout);for(const line of layout)assert.equal(text.slice(line.start,line.end),line.text);
  assert.equal(layout.map(l=>l.text).join(' ').replace(/\s+/gu,''),text.replace(/\s+/gu,''));
});

test('cached PDF paragraph geometry retains non-enumerable DOMRect dimensions after scrolling',()=>{
 const f=pdfFixture(['Source paragraph.'],true),snapshot=core.capture(f.page),first=core.translationPlan(snapshot,1)[0];
 f.move(-200);const again=core.translationPlan(snapshot,1)[0];
 assert.equal(again.lines[0].rect.width,first.lines[0].rect.width);
 assert.equal(again.lines[0].rect.height,20);assert.equal(again.lines[0].rect.top,first.lines[0].rect.top-200);
 const result=core.paintTranslation(snapshot,[{id:first.id,source:first.text,translated:'中文译文',status:'ready'}],1,0,{settings:settings('fade')});
 assert.equal(result.painted,1);assert.equal(result.skipped,0);
});

test('PDF advance widths calibrate fallback-font source heat and translated line geometry',()=>{
 const f=pdfFixture(['Normal source prose.']),content={items:[{str:f.nodes[0].data,fontName:'prose',height:10,width:90,transform:[10,0,0,10,0,0]}]};
 const snapshot=core.capture(f.page,null,content),segment=snapshot.segments[0];
 assert.equal(segment.layoutRect.width,180);assert.equal(core.translationPlan(snapshot,1)[0].lines[0].rect.width,180);
 const candidate={start:0,end:6,text:'Normal',surprisalNormalized:0,semantic:null};core.paint(snapshot,[candidate],settings('fade'));
 const mark=f.all().find(n=>n.dataset.infolensSource==='original');
 const width=Number(/width:([\d.]+)px/.exec(mark.style.cssText)[1]);assert.ok(Math.abs(width-180*6/f.nodes[0].data.length)<1e-8);
 const before={...f.metrics};f.move(-200);assert.equal(core.captureCached(f.page,null,snapshot,content),snapshot);assert.equal(core.paint(snapshot,[candidate],settings('fade')).painted,1);assert.equal(f.metrics.rects,before.rects);
});
