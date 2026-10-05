/** Display-only fusion. Missing signals remain missing and are explicitly degraded. */
import {scoreCurve} from './appearance.mjs';
// BEGIN SHARED SIGNALS
const normalized=value=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(1,value)):null;
const semanticValue=c=>normalized(Object.hasOwn(c,'semanticNormalized')?c.semanticNormalized:c.semantic);
const smoothUnit=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
export const fusionDisplayPolicy=Object.freeze({version:'sentence-selective-density-v1',minimumImportance:.75,sentenceBudget:.5,importantFloor:.36,brightLevel:14,brightMultiplier:2,maxImportantBrightFraction:.85});
let brightThreshold;
function brightScore(){
  if(brightThreshold!==undefined)return brightThreshold;
  let low=0,high=1;for(let i=0;i<40;i++){const mid=(low+high)/2;if(scoreCurve(mid)<(fusionDisplayPolicy.brightLevel-.5)/15)low=mid;else high=mid;}
  return brightThreshold=high+1e-8;
}
// Old cached results without calibration receive a conservative smooth gate.
export function sentenceFloor(semantic){return fusionDisplayPolicy.importantFloor*smoothUnit(((normalized(semantic)??0)-.75)/.2);}
export function calibrateSentenceDisplay(blocks){
  const policy=fusionDisplayPolicy,H=brightScore(),sentences=blocks.flatMap(b=>b.sentences||[]),known=sentences.filter(s=>normalized(s.semantic)!==null);
  const ranked=[...known].sort((a,b)=>semanticValue(b)-semanticValue(a)),limit=Math.max(1,Math.floor(sentences.length*policy.sentenceBudget));
  const boundary=semanticValue(ranked[Math.min(limit,ranked.length)-1]||{});
  // A tied boundary is left to density; never invent a semantic ranking by ID/position.
  const tiedBoundary=ranked.length>limit&&semanticValue(ranked[limit])===boundary;
  const important=new Set(ranked.filter(s=>s.semantic>=policy.minimumImportance&&semanticValue(s)>=policy.minimumImportance&&(semanticValue(s)>boundary||semanticValue(s)===boundary&&!tiedBoundary)).slice(0,limit).map(s=>s.id));
  const all=blocks.flatMap(b=>b.candidates),eligible=c=>normalized(c.surprisalNormalized)!==null&&normalized(c.semantic)!==null&&c.sentenceIds?.length&&c.sentenceIds.every(id=>important.has(id));
  const pool=all.filter(eligible),baseline=all.filter(c=>normalized(c.surprisalNormalized)!==null&&c.surprisalNormalized>=H).length,inside=pool.filter(c=>c.surprisalNormalized>=H).length;
  const desired=inside+baseline*(policy.brightMultiplier-1),cap=Math.max(inside,Math.floor(pool.length*policy.maxImportantBrightFraction)),target=Math.min(desired,cap);
  const sorted=pool.map(c=>c.surprisalNormalized).sort((a,b)=>b-a);
  let cutoff=1;
  if(target>0){
    if(target>=sorted.length)cutoff=0;
    else if(sorted[target-1]===sorted[target])cutoff=Math.min(H,sorted[target]+1e-8);
    else cutoff=Math.min(H,(sorted[target-1]+sorted[target])/2);
  }
  const calibrated=blocks.map(b=>({...b,candidates:b.candidates.map(c=>({...c,semanticDisplay:{policy:policy.version,important:Boolean(eligible(c)),brightCutoff:cutoff}}))}));
  const brightAfter=calibrated.flatMap(b=>b.candidates).filter(c=>signalScore(c).score>=H).length;
  const raw=known.map(s=>s.semantic).sort((a,b)=>a-b);
  return {blocks:calibrated,metadata:{policy:policy.version,importantSentences:important.size,totalSentences:sentences.length,evaluatedSentences:known.length,eligibleTokens:pool.length,baselineImportantBright:inside,baselineBright:baseline,targetBright:baseline*policy.brightMultiplier,actualBright:brightAfter,brightRatio:baseline?brightAfter/baseline:null,limited:brightAfter<baseline*policy.brightMultiplier,brightLevel:policy.brightLevel,scope:'current_analysis_snapshot',rawImportance:{min:raw[0]??null,max:raw.at(-1)??null,median:raw[Math.floor(raw.length/2)]??null,atLeast75:raw.filter(s=>s>=.75).length,tiedBoundary}}};
}
export function signalScore(candidate,{mode='hybrid',alpha=.4,beta=.35,fusion='semantic_floor'}={}){
  mode=({density:'information_density',semantic:'semantic_importance'})[mode]||mode;
  if(!['information_density','semantic_importance','hybrid'].includes(mode))throw new RangeError('Unknown signal mode');
  if(!['semantic_floor','weighted','gated'].includes(fusion))throw new RangeError('Unknown fusion');
  const S=normalized(candidate.surprisalNormalized),M=semanticValue(candidate),MRaw=normalized(candidate.semantic),weight=normalized(alpha)??.4,gate=normalized(beta)??.35;
  let score,missingSignals=[];
  if(mode==='information_density'){score=S;if(S===null)missingSignals=['surprisal'];}
  else if(mode==='semantic_importance'){score=M;if(M===null)missingSignals=['semantic'];}
  else if(S===null||M===null){score=S??M;missingSignals=[...(S===null?['surprisal']:[]),...(M===null?['semantic']:[])];}
  else if(fusion==='semantic_floor'){
    const plan=candidate.semanticDisplay;
    if(plan?.policy===fusionDisplayPolicy.version){
      if(!plan.important)score=S;
      else{
        const H=brightScore(),cutoff=normalized(plan.brightCutoff)??1,B=fusionDisplayPolicy.importantFloor;
        const mapped=S<cutoff?B+(H-B)*smoothUnit(S/cutoff):H+(1-H)*smoothUnit((S-cutoff)/Math.max(1e-9,1-cutoff));
        score=Math.max(S,mapped);
      }
    }else{const floor=sentenceFloor(M);score=floor+(1-floor)*S;}
  }
  else score=fusion==='gated'?S*(gate+(1-gate)*M):weight*S+(1-weight)*M;
  return {score,S,M,MRaw,degraded:missingSignals.length>0,missingSignals};
}
// END SHARED SIGNALS
