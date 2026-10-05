import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {mathTextRanges,overlapsMath} from '../math-protection.mjs';
import {pdfFixture} from './pdf-render-fixture.mjs';
import {signalScore} from '../signals.mjs';
import {displayLevel} from '../appearance.mjs';
const require=createRequire(import.meta.url),core=require('../../zotero-plugin/core.js'),editor=require('../../vscode-extension/snapshot.cjs');

test('LaTeX ranges preserve delimiters and exclude currency, escaped dollars and code',()=>{
 const text=String.raw`Cost $5 and $10. Code \`$x$\`. Formula $Y=\beta_0+X$ and \(G_j\); $$\sum x_i$$. \$literal.`.replace(/\\`/g,'`');
 const ranges=mathTextRanges(text);assert.deepEqual(ranges.map(r=>text.slice(r.start,r.end)),[String.raw`$Y=\beta_0+X$`,String.raw`\(G_j\)`,String.raw`$$\sum x_i$$`]);
 const environment=String.raw`\begin{align}x&=y\end{align}`;assert.equal(mathTextRanges(environment)[0].end,environment.length);
 assert.equal(mathTextRanges('`$x$`\n```tex\n$x$\n```').length,0);
});

test('every client ships the exact same formula boundary policy',async()=>{
 const marker=/\/\/ BEGIN SHARED MATH[\s\S]*?\/\/ END SHARED MATH/;
 const canonical=(await readFile(new URL('../math-protection.mjs',import.meta.url),'utf8')).match(marker)[0].replace(/^export /gm,'');
 for(const name of ['edge-extension/page.js','zotero-plugin/core.js','vscode-extension/snapshot.cjs'])assert.equal((await readFile(new URL('../../'+name,import.meta.url),'utf8')).match(marker)[0],canonical,name);
});

test('VSCode preserves Markdown mathematics without treating source-code dollars as LaTeX',()=>{
 const raw=String.raw`Text $G_j$ remains visible.`,snap=editor.snapshot(raw);
 const candidates=[...raw].map((text,start)=>({text,start,end:start+1,surprisalNormalized:.1,semantic:null}));
 const analysis={blocks:[{id:'b1',text:raw,candidates}]};
 assert.ok(editor.plan(analysis,snap,{}, {signalScore,displayLevel}).every(r=>!overlapsMath(r.start,r.end,snap.mathRanges)));
 assert.equal(editor.plan(analysis,editor.snapshot(raw,'code'),{}, {signalScore,displayLevel}).length,candidates.length);
});

test('PDF inline math reaches the model in complete paragraphs and displays original glyphs; display math is untouched',()=>{
 const texts=['Before formula','G','¼','G','1','ð','Þ',', then traditional methods','Y','¼','b','0','þ','X','(1)'];
 const f=pdfFixture(texts,true);
 const rects=[ [20,20,90,20],[115,20,8,20],[125,20,8,20],[140,20,8,20],[149,28,5,12],[134,20,5,20],[160,20,5,20],[168,20,200,20], [200,80,8,20],[215,80,8,20],[230,80,8,20],[240,88,5,12],[250,80,8,20],[265,80,8,20],[400,80,25,20] ];
 f.nodes.forEach((n,i)=>{const [left,top,width,height]=rects[i];n.rect={left,top,width,height};});
 const content={items:texts.map((str,i)=>({str,fontName:[0,7,14].includes(i)?'prose':[4,11].includes(i)?'prose':'math'}))};
 const snapshot=core.capture(f.page,null,content),plan=core.translationPlan(snapshot,1);
 assert.equal(plan.length,1);assert.match(plan[0].text,/^Before formula \$.*\$ , then traditional methods$/u);assert.equal(plan[0].math.length,1);
 assert.ok(snapshot.segments[4].math&&snapshot.segments[11].math,'small scripts stay with their base glyph');
 const candidates=snapshot.segments.map(s=>({start:s.start,end:s.end,text:s.text,surprisalNormalized:0,semantic:null}));
 core.paint(snapshot,candidates,{style:'fade',hue:0,intensity:1.5});
 assert.ok(f.all().filter(n=>n.dataset.infolensSource==='original').every(n=>!overlapsMath(+n.dataset.infolensStart,+n.dataset.infolensEnd,snapshot.mathRanges)));
 const rows=plan.map(b=>({id:b.id,source:b.text,translated:'保留公式 '+b.math[0].token+' 传统方法',status:'ready'}));
 assert.equal(core.paintTranslation(snapshot,rows,1,0,{settings:{style:'fade',hue:0,intensity:1.5}}).painted,1);
 assert.equal(f.all().filter(n=>n.dataset.infolensMath).length,1);assert.equal(f.metrics.crops,1);
 assert.ok(f.all().filter(n=>n.dataset.infolensParagraph).every(n=>!n.style.cssText.includes('top:80px')),'display equation stays on original canvas');
});

test('complete IV sentence permits math reorder, exact multiset checks reject dropped, duplicate or changed variables',()=>{
 const math=['$Y$','$X$'].map(token=>({token,rect:{width:10,height:16}}));
 const text='在给定暴露 $X$ 时，与结局 $Y$ 独立。';
 assert.deepEqual(core.mixedTranslationParts(text,math).filter(p=>p.type==='math').map(p=>p.text),['$X$','$Y$']);
 for(const bad of ['只有 $Y$。','变成 $Z$ 和 $X$。','重复 $Y$、$Y$ 和 $X$。'])assert.equal(core.mixedTranslationParts(bad,math),null);
 const layout=core.fitMixedTranslationLayout(text,Array(5).fill({width:90}),{measureText:t=>({width:[...t].length*8})},14,math);
 assert.ok(layout);assert.equal(layout.flatMap(l=>l.parts).map(p=>p.text).join(''),text);
 assert.equal(layout.flatMap(l=>l.parts).filter(p=>p.type==='math').length,2);
});

test('paragraph grouping joins math-interrupted wraps, dehyphenates confounders and separates each IV assumption',()=>{
 const f=pdfFixture(['IV2: independent of the outcome','Y','given the exposure','X','(the exclusion restriction); and','IV3: independent of all con-','founders of','X','and','Y','(the exchangeability assumption);']);
 const geometry=[[30,20,180,16],[213,20,10,16],[226,20,110,16],[30,40,10,16],[43,40,270,16],[30,65,220,16],[30,85,75,16],[108,85,10,16],[121,85,24,16],[148,85,10,16],[30,105,250,16]];
 f.nodes.forEach((n,i)=>{const[left,top,width,height]=geometry[i];n.rect={left,top,width,height};});
 const content={items:f.nodes.map(n=>({str:n.data,fontName:/^[XY]$/.test(n.data)?'math':'prose'}))};
 const plan=core.translationPlan(core.capture(f.page,null,content),2);
 assert.equal(plan.length,2);assert.equal(plan[0].text,'IV2: independent of the outcome $Y$ given the exposure $X$ (the exclusion restriction); and');
 assert.match(plan[1].text,/confounders of \$X\$ and \$Y\$/u);assert.doesNotMatch(plan[1].text,/con- founders/);
});
