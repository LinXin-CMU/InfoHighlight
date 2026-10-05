// BEGIN SHARED READING
export const READING_CATEGORIES=['key_finding','definition','constraint','risk','core_logic','boundary_condition','general'];
export const READING_DEFAULTS=Object.freeze({distribution:'continuous',budget:.15,categories:[],mode:'hybrid',classify:false});
export function readingSettings(value={}){
  const p={...READING_DEFAULTS,...value};
  if(!['continuous','sparse'].includes(p.distribution)||!['information_density','hybrid','semantic_importance'].includes(p.mode)||!Number.isFinite(p.budget)||p.budget<.05||p.budget>.35||typeof p.classify!=='boolean'||!Array.isArray(p.categories)||p.categories.length>READING_CATEGORIES.length||p.categories.some(c=>!READING_CATEGORIES.includes(c))||new Set(p.categories).size!==p.categories.length)throw new Error('阅读设置无效。');
  return {...p,categories:[...p.categories],classify:p.classify||p.categories.length>0};
}
// One selection rule across adapters. Budget counts the union of non-space
// Unicode points; UTF-16 ranges and whole lexical words remain unchanged.
export function selectReadingCandidates(candidates,blocks,settings={},score=c=>c.finalScore){
  const p=readingSettings(settings),texts=new Map(blocks.map(b=>[b.id,b.text]));
  const count=text=>Array.from(text).filter(c=>!/^\s$/u.test(c)).length;
  const pool=candidates.filter(c=>{const text=texts.get(c.blockId),s=score(c);return typeof text==='string'&&Number.isInteger(c.start)&&Number.isInteger(c.end)&&c.start>=0&&c.end>c.start&&c.end<=text.length&&Number.isFinite(s)&&(!p.categories.length||p.categories.includes(c.category));});
  if(p.distribution==='continuous')return pool;
  const groups=new Map();
  for(const c of pool){const word=c.densityDisplay,key=JSON.stringify([c.blockId,word?.wordStart??c.start,word?.wordEnd??c.end]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}
  const ranked=[...groups.values()].map(list=>({list,score:Math.max(...list.map(score)),start:Math.min(...list.map(c=>c.start))})).sort((a,b)=>b.score-a.score||a.start-b.start);
  const limit=Math.floor(blocks.reduce((n,b)=>n+count(b.text),0)*p.budget),used=new Map(),chosen=new Set();let covered=0;
  for(const {list} of ranked){const fresh=[];for(const c of list){const seen=used.get(c.blockId)||new Set(),text=texts.get(c.blockId);for(let i=c.start;i<c.end;){const char=String.fromCodePoint(text.codePointAt(i));if(!/^\s$/u.test(char)&&!seen.has(i))fresh.push([c.blockId,i]);i+=char.length;}}
    const unique=new Map(fresh.map(pair=>[JSON.stringify(pair),pair]));if(covered+unique.size>limit)continue;
    for(const [id,i] of unique.values()){if(!used.has(id))used.set(id,new Set());used.get(id).add(i);}covered+=unique.size;for(const c of list)chosen.add(c);
  }
  return pool.filter(c=>chosen.has(c));
}
// END SHARED READING
