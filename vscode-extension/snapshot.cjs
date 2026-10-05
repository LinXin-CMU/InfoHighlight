// BEGIN SHARED MATH
const mathDomSelector='math,mjx-container,.katex,.MathJax,.MathJax_Display,.MathJax_SVG,.MathJax_CHTML,.ztext-math,[data-math],[data-tex],[role="math"]';
// Protect source delimiters; offsets always refer to the unchanged UTF-16 text.
// Code spans/fences and escaped dollars are not treated as mathematics.
function mathTextRanges(text){
  const ranges=[];const escaped=i=>{let n=0;while(i>0&&text[--i]==='\\')n++;return n%2===1;};
  for(let i=0;i<text.length;){
    if(text[i]==='`'&&!escaped(i)){let n=1;while(text[i+n]==='`')n++;const marker='`'.repeat(n),end=text.indexOf(marker,i+n);i=end<0?text.length:end+n;continue;}
    let open=null,close=null;
    if(text.startsWith('\\(',i)&&!escaped(i)){open='\\(';close='\\)';}
    else if(text.startsWith('\\[',i)&&!escaped(i)){open='\\[';close='\\]';}
    else if(text[i]==='$'&&!escaped(i)){open=text[i+1]==='$'?'$$':'$';close=open;if(open==='$'&&/\s/u.test(text[i+1]||'')){i++;continue;}}
    else if(text.startsWith('\\begin{',i)&&!escaped(i)){const m=/^\\begin\{(equation\*?|align\*?|gather\*?|math|displaymath)\}/u.exec(text.slice(i));if(m){open=m[0];close='\\end{'+m[1]+'}';}}
    if(!open){i++;continue;}
    let end=text.indexOf(close,i+open.length);
    while(end>=0&&escaped(end))end=text.indexOf(close,end+close.length);
    if(end<0||open==='$'&&(/\s/u.test(text[end-1]||'')||text[end+1]==='$'||/[\n`]/u.test(text.slice(i+1,end)))){i+=open.length;continue;}
    ranges.push({start:i,end:end+close.length});i=end+close.length;
  }
  return ranges;
}
function overlapsMath(start,end,ranges){return ranges.some(r=>start<r.end&&end>r.start);}
// END SHARED MATH

const {createHash}=require('node:crypto');
function snapshot(raw,kind='paragraph'){
  let text='',boundaries=[0];
  for(let i=0;i<raw.length;i++){
    if(raw[i]==='\r'){text+='\n';if(raw[i+1]==='\n')i++;}else text+=raw[i];
    boundaries.push(i+1);
  }
  const blocks=[{id:'b1',kind,text}];
  return {raw,text,boundaries,blocks,mathRanges:kind==='code'?[]:mathTextRanges(text),contentHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex')};
}
function plan(analysis,snap,options,helpers){
  if(analysis.blocks?.length!==1||analysis.blocks[0].id!=='b1'||analysis.blocks[0].text!==snap.text)throw new Error('服务结果与当前快照不匹配。');
  const result=[];let end=0;
  for(const c of analysis.blocks[0].candidates){
    if(!Number.isInteger(c.start)||!Number.isInteger(c.end)||c.start<end||c.end<=c.start||c.end>snap.text.length||snap.text.slice(c.start,c.end)!==c.text)throw new Error('服务返回了无效的文本范围。');
    end=c.end;
  }
  end=0;
  const candidates=helpers.selectReadingCandidates?helpers.selectReadingCandidates(analysis.blocks[0].candidates.map(c=>({...c,blockId:'b1'})),analysis.blocks,options,c=>helpers.signalScore(c,options).score):analysis.blocks[0].candidates;
  for(const c of candidates){
    if(!Number.isInteger(c.start)||!Number.isInteger(c.end)||c.start<end||c.end<=c.start||c.end>snap.text.length||snap.text.slice(c.start,c.end)!==c.text)throw new Error('服务返回了无效的文本范围。');
    end=c.end;const signal=helpers.signalScore(c,options);if(signal.score===null||overlapsMath(c.start,c.end,snap.mathRanges||[]))continue;
    result.push({start:snap.boundaries[c.start],end:snap.boundaries[c.end],text:c.text,level:helpers.displayLevel(signal.score),...signal,bits:c.surprisalBits});
  }return result;
}
module.exports={snapshot,plan};
