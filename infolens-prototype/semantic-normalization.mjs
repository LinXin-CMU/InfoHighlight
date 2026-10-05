/** Relative sentence display scores, computed only after a whole block is scored. */
export const SEMANTIC_NORMALIZATION_POLICY='paragraph-minmax-v1/min-spread-0.05/complete-block/neutral-0.5';
export function normalizeParagraphSentences(sentences){
  const known=sentences.filter(s=>typeof s.semantic==='number'&&Number.isFinite(s.semantic));
  const scores=known.map(s=>s.semantic),min=scores.length?Math.min(...scores):null,max=scores.length?Math.max(...scores):null;
  const complete=known.length===sentences.length,spread=scores.length?max-min:0;
  const informative=complete&&known.length>=2&&spread>=.05-1e-12;
  const metadata={policy:SEMANTIC_NORMALIZATION_POLICY,scope:'paragraph',method:'minmax',min,max,spread,complete,informative,minimumSpread:.05,neutral:.5};
  return {metadata,sentences:sentences.map(s=>({...s,semanticRaw:s.semantic,semanticNormalized:s.semantic===null?null:informative?(s.semantic-min)/spread:.5,semanticNormalization:metadata}))};
}
