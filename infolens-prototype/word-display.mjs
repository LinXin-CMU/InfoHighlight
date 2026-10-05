/** Joint information per display word. Original LM scores and tokenizer stay intact. */
import {nonspaceLength} from './engine.mjs';
export const WORD_DISPLAY_POLICY='lexical-joint-bits-v1/jieba-0.42.1/hmm-off';
export function projectWordDisplay(analysis){
  let words=0;
  const blocks=analysis.blocks.map(block=>{
    if(block.wordDisplayApplied||!block.wordUnits?.length)return block;
    const raw=block.candidates,units=[];let cursor=0,previous=0;
    for(const unit of block.wordUnits){
      if(!Number.isInteger(unit.start)||!Number.isInteger(unit.end)||unit.start<previous||unit.end<=unit.start||unit.end>block.text.length||block.text.slice(unit.start,unit.end)!==unit.text)throw Error('Invalid display word boundary');
      previous=unit.end;if(unit.end>(block.scoredThrough??block.text.length))continue;
      while(cursor<raw.length&&raw[cursor].end<=unit.start)cursor++;
      let bits=0,through=unit.start,valid=true,apportioned=false;
      const tokenIndices=new Set();
      for(let i=cursor;i<raw.length&&raw[i].start<unit.end;i++){
        const c=raw[i],lo=Math.max(c.start,unit.start),hi=Math.min(c.end,unit.end);
        if(hi<=lo)continue;
        const length=nonspaceLength(block.text.slice(lo,hi)),total=nonspaceLength(c.text);
        if(lo>through||!total||!Number.isFinite(c.surprisalBits)){valid=false;break;}
        bits+=c.surprisalBits*length/total;through=Math.max(through,hi);
        if(length<total)apportioned=true;
        for(const id of c.tokenIndices||[])tokenIndices.add(id);
      }
      if(!valid||through<unit.end)continue;
      units.push({...unit,score:Math.min(1,Math.max(0,bits/18)),bits,tokenIndices:[...tokenIndices],apportioned});
    }
    let wordCursor=0;const candidates=[];
    for(const c of raw){
      let start=c.start;
      while(start<c.end){
        while(wordCursor<units.length&&units[wordCursor].end<=start)wordCursor++;
        const word=units[wordCursor],inside=word&&word.start<=start&&word.end>start;
        const end=inside?Math.min(c.end,word.end):Math.min(c.end,word?.start>start?word.start:c.end);
        candidates.push({...c,start,end,text:block.text.slice(start,end),tokenSurprisalNormalized:c.surprisalNormalized,sourceTokenRange:{start:c.start,end:c.end,text:c.text},...(inside?{surprisalNormalized:word.score,densityDisplay:{policy:WORD_DISPLAY_POLICY,wordStart:word.start,wordEnd:word.end,wordText:word.text,bits:word.bits,tokenIndices:word.tokenIndices,apportioned:word.apportioned}}:{})});
        start=end;
      }
    }
    words+=units.length;
    return {...block,candidates,rawCandidates:raw,wordDisplayApplied:true};
  });
  return {...analysis,blocks,densityDisplay:{policy:WORD_DISPLAY_POLICY,unit:'lexical_word',wordCount:words,normalization:'joint-word-bits/18',rawTokenScoresPreserved:true}};
}
