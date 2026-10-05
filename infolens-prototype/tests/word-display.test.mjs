import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {projectWordDisplay} from '../word-display.mjs';
import {signalScore} from '../signals.mjs';
import {signalScore as edge} from '../../edge-extension/signals.mjs';
import {signalScore as vscode} from '../../vscode-extension/signals.mjs';
import {displayLevel} from '../appearance.mjs';
const pdf=createRequire(import.meta.url)('../../zotero-plugin/core.js');
const candidate=(text,start,bits,index)=>({start,end:start+text.length,text,surprisalRaw:bits*Math.log(2),surprisalBits:bits,surprisalNormalized:bits/18,tokenIndices:[index],semantic:null});
function example(){return {blocks:[{id:'p',text:'递归神经网络。',wordUnits:[{text:'递归',start:0,end:2},{text:'神经网络',start:2,end:6}],candidates:[candidate('递',0,5.69,0),candidate('归',1,.011,1),candidate('神经',2,.12,2),candidate('网络',4,.004,3),candidate('。',6,2,4)]}]};}
test('whole words share their joint density; raw token evidence and punctuation remain intact',()=>{
  const original=example(),result=projectWordDisplay(original),b=result.blocks[0];
  assert.deepEqual(b.rawCandidates,original.blocks[0].candidates);
  assert.equal(original.blocks[0].wordDisplayApplied,undefined);
  assert.equal(b.candidates.map(c=>c.text).join(''),b.text);
  assert.equal(b.candidates[0].surprisalNormalized,b.candidates[1].surprisalNormalized);
  assert.equal(b.candidates[0].surprisalNormalized,(5.69+.011)/18);
  assert.equal(displayLevel(b.candidates[0].surprisalNormalized),displayLevel(b.candidates[1].surprisalNormalized));
  assert.equal(b.candidates.at(-1).surprisalNormalized,2/18);
  for(let i=0;i<b.candidates.length;i++){
    const c=b.candidates[i],raw=original.blocks[0].candidates[i];
    assert.equal(c.surprisalBits,raw.surprisalBits);assert.equal(c.surprisalRaw,raw.surprisalRaw);
    assert.equal(c.tokenSurprisalNormalized,raw.surprisalNormalized);
    const score=signalScore(c).score;assert.equal(edge(c).score,score);assert.equal(vscode(c).score,score);assert.equal(pdf.score(c),score);
  }
  assert.deepEqual(projectWordDisplay(result).blocks,result.blocks,'projection is idempotent');
});
test('a token crossing word boundaries is apportioned without spreading its whole score to each word',()=>{
  const raw=candidate('特殊的递',0,8,0),source={blocks:[{id:'p',text:'特殊的递归',wordUnits:[{start:0,end:2,text:'特殊'},{start:3,end:5,text:'递归'}],candidates:[raw,candidate('归',4,.02,1)]}]};
  const b=projectWordDisplay(source).blocks[0];assert.deepEqual(b.candidates.map(c=>c.text),['特殊','的','递','归']);
  assert.equal(b.candidates[0].surprisalNormalized,4/18);assert.equal(b.candidates[2].surprisalNormalized,2.02/18);
  assert.equal(b.candidates[2].surprisalNormalized,b.candidates[3].surprisalNormalized);
  assert.equal(b.candidates[2].densityDisplay.apportioned,true);assert.deepEqual(b.candidates[2].sourceTokenRange,{start:0,end:4,text:'特殊的递'});
  assert.deepEqual(b.rawCandidates[0],raw);
});
test('unfinished words and missing density cannot publish a fabricated partial word score',()=>{
  const source=example();source.blocks[0].scoredThrough=1;source.blocks[0].candidates=source.blocks[0].candidates.slice(0,1);
  const b=projectWordDisplay(source).blocks[0];assert.equal(b.candidates[0].densityDisplay,undefined);assert.equal(b.candidates[0].surprisalNormalized,5.69/18);
  const unknown=example();delete unknown.blocks[0].candidates[1].surprisalBits;
  assert.equal(projectWordDisplay(unknown).blocks[0].candidates[0].densityDisplay,undefined);
  assert.deepEqual(projectWordDisplay({blocks:[{id:'p',text:'x',candidates:[]}]}).blocks,[{id:'p',text:'x',candidates:[]}]);
});
