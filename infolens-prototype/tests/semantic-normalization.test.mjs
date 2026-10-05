import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeParagraphSentences} from '../semantic-normalization.mjs';
import {semanticTargets,projectSemantic} from '../semantic.mjs';
import {signalScore} from '../signals.mjs';
import {signalScore as edge} from '../../edge-extension/signals.mjs';
import {signalScore as editor} from '../../vscode-extension/signals.mjs';
import {createRequire} from 'node:module';
const pdf=createRequire(import.meta.url)('../../zotero-plugin/core.js');

test('paragraph minmax preserves raw scores and does not depend on other paragraphs',()=>{
  const result=normalizeParagraphSentences([.88,.78,.94,.76].map(semantic=>({semantic})));
  assert.deepEqual(result.sentences.map(s=>s.semanticRaw),[.88,.78,.94,.76]);
  const expected=[2/3,1/9,1,0];for(let i=0;i<4;i++)assert.ok(Math.abs(result.sentences[i].semanticNormalized-expected[i])<1e-12);
  assert.equal(result.metadata.informative,true);
});

test('single, tied, barely different and incomplete paragraphs do not manufacture a ranking',()=>{
  for(const values of [[.9],[.9,.9],[.9,.91],[.9,null]]){
    const result=normalizeParagraphSentences(values.map(semantic=>({semantic})));
    assert.equal(result.metadata.informative,false);
    assert.deepEqual(result.sentences.map(s=>s.semanticNormalized),values.map(v=>v===null?null:.5));
  }
});

test('normalized semantics drive every client while raw values and Base remain intact',()=>{
  const blocks=[{id:'p1',kind:'paragraph',text:'定义说明。补充例子。核心结论。背景信息。'},{id:'p2',kind:'paragraph',text:'另一个段落。'}];
  const targets=semanticTargets(blocks),raw=[88,78,94,76,90];
  const base={model:{repo:'fixture'},blocks:blocks.map(b=>({...b,candidates:targets.filter(s=>s.blockId===b.id).map(s=>({...s,surprisalNormalized:.2,surprisalBits:3}))}))};
  const result=projectSemantic(base,targets,{rows:targets.map((s,i)=>({id:s.id,importance:raw[i],type:'general'}))});
  assert.equal(result.semantic.displayCalibration.importantSentences,1);
  for(const b of result.blocks)for(const c of b.candidates){
    assert.equal(c.surprisalNormalized,.2);assert.equal(c.surprisalBits,3);
    assert.equal(signalScore(c,{mode:'semantic_importance'}).score,c.semanticNormalized);
    assert.equal(signalScore(c,{mode:'information_density'}).score,.2);
    assert.equal(edge(c).score,signalScore(c).score);assert.equal(editor(c).score,signalScore(c).score);assert.equal(pdf.score(c),signalScore(c).score);
  }
  assert.ok(Math.abs(result.blocks[0].candidates[2].semantic-.94)<1e-12);
  assert.ok(signalScore(result.blocks[0].candidates[2]).score>.2);
  for(const i of [0,1,3])assert.equal(signalScore(result.blocks[0].candidates[i]).score,.2);
});
