import {segmentSentences,nonspaceLength,CATEGORIES} from './engine.mjs';
import {calibrateSentenceDisplay} from './signals.mjs';
import {normalizeParagraphSentences,SEMANTIC_NORMALIZATION_POLICY} from './semantic-normalization.mjs';
export const SEMANTIC_POLICY='sentence-importance-v2-incremental/bounded-excerpt-and-neighbor-v1/greedy/2048/512/1/512';
export const TRANSLATION_POLICY='pdf-paragraph-translation-v3/viewport-priority/greedy/2048/1024/bounded-json-repair';
export function semanticTargets(blocks){
  return blocks.flatMap(block=>segmentSentences(block.text).filter(s=>s.text.trim()).map((sentence,index)=>({id:`${block.id}:s${index}`,blockId:block.id,kind:block.kind,...sentence})));
}
export function validateSemanticRows(rows,targets,source='local_instruct'){
  if(!['local_instruct','local_mica'].includes(source))throw new Error('Unknown semantic source');
  if(!Array.isArray(rows))throw new Error('Semantic rows must be an array');
  const allowed=new Map(targets.map(t=>[t.id,t])),seen=new Set();
  for(const row of rows){if(!row||Object.keys(row).sort().join(',')!=='id,importance,type'||typeof row.id!=='string'||!allowed.has(row.id)||seen.has(row.id)||!Number.isInteger(row.importance)||row.importance<0||row.importance>100||!CATEGORIES.includes(row.type))throw new Error('Invalid semantic result');seen.add(row.id);}
  return new Map(rows.map(row=>[row.id,{semantic:row.importance/100,category:row.type,semanticSource:source}]));
}
export function projectSemantic(analysis,targets,report){
  const source=report.source||'local_instruct';
  const values=validateSemanticRows(report.rows||[],targets,source);const coverage={evaluatedSentences:values.size,totalSentences:targets.length,evaluatedChars:0,totalChars:0};
  const blocks=analysis.blocks.map(block=>{
    const rawSentences=targets.filter(t=>t.blockId===block.id).map(t=>{const value=values.get(t.id);coverage.totalChars+=nonspaceLength(t.text);if(value)coverage.evaluatedChars+=nonspaceLength(t.text);return {...t,...(value||{semantic:null,category:'general',semanticSource:'unavailable'})};});
    const {sentences,metadata:semanticNormalization}=normalizeParagraphSentences(rawSentences);
    const candidates=block.candidates.map(c=>{
      let weight=0,total=0,normalizedTotal=0,missing=false,dominant=null;const sentenceIds=[];
      for(const s of sentences){const lo=Math.max(c.start,s.start),hi=Math.min(c.end,s.end);if(hi<=lo)continue;const length=nonspaceLength(block.text.slice(lo,hi));if(!length)continue;sentenceIds.push(s.id);if(s.semantic===null){missing=true;continue;}weight+=length;total+=s.semantic*length;normalizedTotal+=s.semanticNormalized*length;if(!dominant||s.semantic>dominant.semantic)dominant=s;}
      const semantic=!missing&&weight?total/weight:null;
      return {...c,semantic,semanticRaw:semantic,semanticNormalized:semantic===null?null:normalizedTotal/weight,semanticNormalization,category:semantic===null?'general':dominant.category,semanticSource:semantic===null?'unavailable':source,sentenceIds,availableSignals:semantic===null?['surprisal']:['surprisal','semantic']};
    });return {...block,sentences,candidates,semanticNormalization};
  });
  const status=values.size===targets.length?'ready':values.size?'partial':'unavailable';const failedIds=targets.filter(t=>!values.has(t.id)).map(t=>t.id);
  const display=calibrateSentenceDisplay(blocks);
  return {...analysis,source:'local_models',engineVersion:'local-dual-v1',blocks:display.blocks,semanticConnected:values.size>0,availableSignals:values.size?['surprisal','semantic']:['surprisal'],semantic:{...report,source,rows:undefined,status,failedIds,coverage,policy:report.policy||SEMANTIC_POLICY,normalizationPolicy:SEMANTIC_NORMALIZATION_POLICY,displayCalibration:display.metadata},models:{surprisal:analysis.model,semantic:report.model||null},disclaimer:'真实 Base 概率 + 本地句子语义重要度；显示使用段内归一化，原始语义分数保留；语义值不是准确率，缺失信号保持 null。'};
}
