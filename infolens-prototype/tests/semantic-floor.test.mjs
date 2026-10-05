import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {signalScore,sentenceFloor,calibrateSentenceDisplay,fusionDisplayPolicy} from '../signals.mjs';
import {signalScore as edge} from '../../edge-extension/signals.mjs';
import {signalScore as editor} from '../../vscode-extension/signals.mjs';
import {fadeVisibility} from '../appearance.mjs';
const pdf=createRequire(import.meta.url)('../../zotero-plugin/core.js');

test('important sentences retain a legible floor at strongest fade while preserving token contrast',()=>{
  for(const M of [.95,1]){
    let previous=-1;
    for(let i=0;i<=100;i++){
      const S=i/100,F=signalScore({surprisalNormalized:S,semantic:M}).score;
      assert.ok(F>=S&&F>=sentenceFloor(M)&&F<=1);assert.ok(F>=previous);previous=F;
      assert.ok(fadeVisibility(F,1.5)>=.6,'important sentence floor stays readable without becoming a fully bright sentence');
    }
    assert.ok(signalScore({surprisalNormalized:.3,semantic:M}).score<signalScore({surprisalNormalized:.7,semantic:M}).score);
  }
});

test('low-importance sentences keep density contrast, missing semantics never invent a floor',()=>{
  for(const M of [0,.1,.4,.75,null,NaN])for(const S of [0,.1,.5,1])assert.equal(signalScore({surprisalNormalized:S,semantic:M}).score,S);
  assert.ok(fadeVisibility(signalScore({surprisalNormalized:0,semantic:.2}).score,1.5)<.04);
  assert.equal(signalScore({surprisalNormalized:0,semantic:1},{mode:'information_density'}).score,0);
  assert.equal(signalScore({surprisalNormalized:1,semantic:.1},{mode:'semantic_importance'}).score,.1);
});

test('floor onset is smooth, monotonic, and all four clients have identical default fusion',()=>{
  let previous=0;
  for(let i=0;i<=100;i++){
    const M=i/100,b=sentenceFloor(M);assert.ok(b>=previous&&b<=.36);previous=b;
    for(const S of [null,0,.1,.5,1]){
      const c={surprisalNormalized:S,semantic:M},expected=signalScore(c).score;
      assert.equal(edge(c).score,expected);assert.equal(editor(c).score,expected);assert.equal(pdf.score(c),expected);
    }
  }
  assert.ok(sentenceFloor(.750001)<1e-8);assert.ok(.36-sentenceFloor(.949999)<1e-8);
});

function distributionFixture(uniform=false){
  return Array.from({length:10},(_,s)=>({id:'p'+s,sentences:[{id:'s'+s,semantic:uniform?.9:s<3?1-s*.04:.5}],candidates:Array.from({length:10},(_,t)=>({surprisalNormalized:(t===9?.8:.05+t*.05)+s*.001,semantic:uniform?.9:s<3?1-s*.04:.5,sentenceIds:['s'+s]}))}));
}

test('selective fusion doubles bright tokens from density while leaving ordinary sentences unchanged',()=>{
  const source=distributionFixture(),display=calibrateSentenceDisplay(source);
  assert.equal(display.metadata.importantSentences,3);assert.equal(display.metadata.brightRatio,2);
  assert.equal(display.metadata.baselineBright,10);assert.equal(display.metadata.actualBright,20);
  for(let b=0;b<source.length;b++){
    let previous=-1;
    for(let n=0;n<source[b].candidates.length;n++){
      const c=display.blocks[b].candidates[n],original=source[b].candidates[n],score=signalScore(c).score;
      assert.equal(c.semantic,original.semantic);assert.equal(c.surprisalNormalized,original.surprisalNormalized);
      assert.ok(score>=previous);previous=score;
      if(b>=3)assert.equal(score,c.surprisalNormalized);
      else assert.ok(fadeVisibility(score,1.5)>=.6);
      assert.equal(signalScore(c,{mode:'information_density'}).score,c.surprisalNormalized);
      assert.equal(edge(c).score,score);assert.equal(editor(c).score,score);assert.equal(pdf.score(c),score);
    }
  }
  assert.ok(display.blocks.slice(0,3).every(b=>b.candidates.some(c=>signalScore(c).score<.47)),'important sentences still have dimmer words');
});

test('uniformly inflated semantic scores cannot make every sentence bright or invent a ranking',()=>{
  const source=distributionFixture(true),display=calibrateSentenceDisplay(source);
  assert.equal(display.metadata.rawImportance.tiedBoundary,true);assert.equal(display.metadata.importantSentences,0);
  assert.equal(display.metadata.brightRatio,1);assert.equal(display.metadata.limited,true);
  for(const b of display.blocks)for(const c of b.candidates)assert.equal(signalScore(c).score,c.surprisalNormalized);
  assert.equal(fusionDisplayPolicy.brightMultiplier,2);
});
