import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticTargets,validateSemanticRows,projectSemantic} from '../semantic.mjs';
import {signalScore} from '../signals.mjs';
import {selectHeatmap,selectSpans} from '../engine.mjs';
const block={id:'b1',kind:'paragraph',text:'不得沿用旧结果。\n😀 新结果也有范围限制。'};
const targets=semanticTargets([block]);
const row=(id,importance=90)=>({id,importance,type:'constraint'});
function base(){return {source:'local_base',model:{repo:'test-fixture'},blocks:[{...block,candidates:targets.map(s=>({start:s.start,end:s.end,text:s.text,surprisalRaw:2,surprisalBits:2/Math.log(2),surprisalNormalized:.2,semantic:null,tokenIndices:[s.start],category:'general'}))}]};}
test('semantic IDs and UTF-16 ranges preserve complete sentences including negation and emoji',()=>{
  assert.deepEqual(targets.map(s=>s.id),['b1:s0','b1:s1']);
  assert.equal(targets.map(s=>s.text).join(''),block.text);
  for(const s of targets)assert.equal(block.text.slice(s.start,s.end),s.text);
  assert.match(targets[0].text,/不得/);assert.match(targets[1].text,/😀/);
});
test('semantic schema rejects unknown or duplicate IDs, extra prose, fractional scores and unknown categories',()=>{
  for(const rows of [[row('unknown')],[row(targets[0].id),row(targets[0].id)],[{...row(targets[0].id),text:'injected'}],[row(targets[0].id,.9)],[{...row(targets[0].id),type:'command'}]])assert.throws(()=>validateSemanticRows(rows,targets));
  assert.equal(validateSemanticRows([row(targets[0].id,0)],targets).get(targets[0].id).semantic,0);
});
test('sentence projection preserves raw probability and offsets while reporting partial coverage and missing M',()=>{
  const a=base(),result=projectSemantic(a,targets,{rows:[row(targets[0].id)],model:{repo:'test-semantic'},status:'ready'});
  assert.equal(result.source,'local_models');assert.equal(result.semantic.status,'partial');
  assert.equal(result.semantic.coverage.evaluatedSentences,1);assert.equal(result.semantic.coverage.totalSentences,2);
  assert.deepEqual(result.semantic.failedIds,[targets[1].id]);
  for(let i=0;i<2;i++){const c=result.blocks[0].candidates[i],old=a.blocks[0].candidates[i];for(const field of ['start','end','text','surprisalRaw','surprisalBits'])assert.equal(c[field],old[field]);assert.deepEqual(c.tokenIndices,old.tokenIndices);}
  assert.equal(result.blocks[0].candidates[0].semantic,.9);assert.equal(result.blocks[0].candidates[1].semantic,null);
});
test('a candidate spanning scored and unscored sentence content keeps M missing rather than averaging known text alone',()=>{
  const a=base();a.blocks[0].candidates=[{start:0,end:block.text.length,text:block.text,surprisalNormalized:.5,semantic:null}];
  const c=projectSemantic(a,targets,{rows:[row(targets[0].id)]}).blocks[0].candidates[0];
  assert.equal(c.semantic,null);assert.deepEqual(c.availableSignals,['surprisal']);
});
test('real weighted and gated fusion keep S and M independent and match their declared formulas',()=>{
  const c={surprisalNormalized:.8,semantic:.25};
  assert.equal(signalScore(c,{mode:'information_density'}).score,.8);assert.equal(signalScore(c,{mode:'semantic_importance'}).score,.25);
  assert.ok(Math.abs(signalScore(c,{fusion:'weighted',alpha:.4}).score-.47)<1e-12);
  assert.ok(Math.abs(signalScore(c,{fusion:'gated',beta:.35}).score-.41)<1e-12);
});
test('missing semantic degrades hybrid to available S and remains absent in semantic-only display',()=>{
  const a=projectSemantic(base(),targets,{rows:[row(targets[0].id)]});
  const hybrid=selectHeatmap(a),semantic=selectHeatmap(a,{mode:'semantic_importance'});
  assert.equal(hybrid.spans.length,2);assert.equal(hybrid.spans[1].finalScore,.2);assert.equal(hybrid.spans[1].M,null);assert.equal(hybrid.spans[1].degraded,true);
  assert.equal(semantic.spans.length,1);assert.equal(semantic.spans[0].finalScore,.5);assert.equal(semantic.spans[0].MRaw,.9);
  assert.equal(selectSpans(a,{mode:'semantic_importance',budget:1,minScore:0}).spans.length,1);
  assert.equal(signalScore({surprisalNormalized:null,semantic:null}).score,null);
  assert.equal(signalScore({surprisalNormalized:NaN,semantic:.7}).score,.7);
});
test('an explicitly scored zero is evaluated, while unavailable semantic has zero coverage and no semantic paint',()=>{
  const zero=projectSemantic(base(),targets,{rows:targets.map(s=>row(s.id,0))});assert.equal(zero.semantic.status,'ready');assert.equal(selectHeatmap(zero,{mode:'semantic_importance'}).spans.length,2);
  const unavailable=projectSemantic(base(),targets,{rows:[],errors:['model_unavailable']});assert.equal(unavailable.semantic.status,'unavailable');assert.equal(unavailable.semantic.coverage.evaluatedSentences,0);assert.equal(selectHeatmap(unavailable,{mode:'semantic_importance'}).spans.length,0);
});
