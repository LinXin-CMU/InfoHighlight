import test from 'node:test';
import assert from 'node:assert/strict';
import {refineWithMica,MICA_MODEL,MICA_POLICY} from '../mica-provider.mjs';
import {semanticTargets} from '../semantic.mjs';
import {selectHeatmap} from '../engine.mjs';
const blocks=[{id:'p1',kind:'paragraph',text:'😀 这句不是结论。不得忽略失败条件。'}];
const targets=semanticTargets(blocks);
const base={model:{repo:'base-fixture'},gpu:{allocatedMiB:1},blocks:blocks.map(b=>({...b,candidates:targets.map(t=>({...t,surprisalNormalized:.2,surprisalBits:3,semantic:null}))}))};
const row=(i,importance)=>({id:targets[i].id,importance,type:'general'});
const report=rows=>({rows,source:'local_mica',policy:MICA_POLICY,model:MICA_MODEL});

test('Mica publishes Base first, then independent complete sentence scores with truthful source',async()=>{
  const updates=[];let loaded=false;
  const mica={status:()=>({loaded}),async score(b,t,p,{onPartial}){assert.equal(updates.length,1);assert.equal(updates[0].semantic.coverage.evaluatedSentences,0);loaded=true;onPartial(report([row(0,0)]));onPartial(report([row(0,0),row(1,95)]));return report([row(0,0),row(1,95)]);}};
  const result=await refineWithMica(mica,base,blocks,targets,'general',{onPartial:a=>updates.push(a)});
  assert.deepEqual(updates.map(a=>a.semantic.coverage.evaluatedSentences),[0,1,2]);
  assert.equal(result.semantic.policy,MICA_POLICY);assert.equal(result.semantic.status,'ready');
  assert.equal(result.semanticModelLoaded,true);assert.equal(result.gpu.scope,'pytorch_worker_only');
  assert.deepEqual(result.gpu.excludes,['mica_llama_cpp']);
  const spans=selectHeatmap(result).spans;
  assert.equal(spans[0].M,0);assert.equal(spans[1].M,1);assert.ok(Math.abs(spans[1].MRaw-.95)<1e-12);assert.equal(spans[1].semanticSource,'local_mica');
  assert.equal(spans[1].scoreSource,'causal_probability_and_sentence_importance');
  assert.ok(spans[1].F>=.36&&spans[1].F<.5,'selected important sentence retains a readable floor without becoming all bright');
  for(let i=0;i<targets.length;i++){assert.equal(spans[i].surprisalBits,3);assert.equal(blocks[0].text.slice(spans[i].start,spans[i].end),targets[i].text);}
});

test('failed Mica refinement retains completed sentences, raw Base scores and null missing values',async()=>{
  const mica={status:()=>({loaded:false}),async score(b,t,p,{onPartial}){onPartial(report([row(0,90)]));throw Error('failure');}};
  const result=await refineWithMica(mica,base,blocks,targets,'general');
  assert.equal(result.semantic.status,'partial');assert.deepEqual(result.semantic.errors,['mica_unavailable']);
  assert.deepEqual(result.blocks[0].candidates.map(c=>c.semantic),[.9,null]);
  assert.equal(selectHeatmap(result).spans[1].F,.2);
});

test('cancelled Mica work cannot publish a stale score or return a completed result',async()=>{
  const controller=new AbortController(),updates=[];
  const mica={status:()=>({loaded:true}),async score(b,t,p,{onPartial}){controller.abort();onPartial(report([row(0,100)]));return report([row(0,100)]);}};
  await assert.rejects(refineWithMica(mica,base,blocks,targets,'general',{signal:controller.signal,onPartial:a=>updates.push(a)}),/Cancelled/);
  assert.equal(updates.length,1);assert.equal(updates[0].semantic.coverage.evaluatedSentences,0);
});
