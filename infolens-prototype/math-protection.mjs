// BEGIN SHARED MATH
export const mathDomSelector='math,mjx-container,.katex,.MathJax,.MathJax_Display,.MathJax_SVG,.MathJax_CHTML,.ztext-math,[data-math],[data-tex],[role="math"]';
// Protect source delimiters; offsets always refer to the unchanged UTF-16 text.
// Code spans/fences and escaped dollars are not treated as mathematics.
export function mathTextRanges(text){
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
export function overlapsMath(start,end,ranges){return ranges.some(r=>start<r.end&&end>r.start);}
// END SHARED MATH
