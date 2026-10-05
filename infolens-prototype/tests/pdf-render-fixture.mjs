export function pdfFixture(strings=['Source paragraph.','Another paragraph.'],nativeRects=false){
  const metrics={rects:0,pixels:0,measure:0,walks:0,appends:0,crops:0};
  let pageTop=0;
  const rect=value=>nativeRects?Object.defineProperties({},Object.fromEntries(Object.entries(value).map(([k,v])=>[k,{get:()=>v}]))):value;
  class Element{
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.style={cssText:''};this.children=[];this.dataset={};this.attrs={};this.parentElement=null;this.root=false;this.ownerDocument=doc;this.offsetWidth=600;this.clientWidth=600;this.offsetHeight=800;this.clientHeight=800;this.clientLeft=0;this.clientTop=0;}
    get isConnected(){return this.root||!!this.parentElement?.isConnected;}
    append(...nodes){metrics.appends++;for(const n of nodes){n.parentElement=this;this.children.push(n);}}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;}
    setAttribute(k,v){this.attrs[k]=v;}
    closest(){return null;}
    getBoundingClientRect(){return {left:0,top:pageTop,width:600,height:800,right:600,bottom:pageTop+800};}
    querySelector(selector){if(selector==='.textLayer')return textLayer;if(selector==='canvas')return canvas;return this.children.find(n=>n.className===selector.slice(1))||null;}
    querySelectorAll(selector){return this.children.filter(n=>selector.includes(n.className)&&!!n.className);}
  }
  const measurement={font:'',measureText(text){metrics.measure++;return {width:[...text].length*6};},drawImage(){metrics.crops++;}};
  const pixels=new Uint8ClampedArray(600*800*4).fill(255);
  const backdrop={getImageData(){metrics.pixels++;return {data:pixels};}};
  const doc={createElement:tag=>{const e=new Element(tag);if(tag==='canvas')e.getContext=()=>measurement;return e;},createTreeWalker(){metrics.walks++;let cursor=0;return {nextNode:()=>nodes[cursor++]||null};},createRange(){let node,start=0,end=0;return {selectNodeContents(n){node=n;start=0;end=n.data.length;},setStart(n,offset){node=n;start=offset;},setEnd(n,offset){end=offset;},get startContainer(){return node;},getClientRects(){metrics.rects++;const source=node.rect||{left:20,top:20+node.index*50,width:node.data.length*6,height:20},unit=source.width/node.data.length,left=source.left+start*unit,top=pageTop+source.top,width=(end-start)*unit,height=source.height;return [rect({left,top,width,height,right:left+width,bottom:top+height})];},toString(){return node.data.slice(start,end);}};}};
  const page=new Element();page.root=true;const textLayer=new Element();page.append(textLayer);
  const nodes=strings.map((data,index)=>({data,index,isConnected:true,parentElement:textLayer,ownerDocument:doc}));
  const canvas=new Element('canvas');canvas.width=600;canvas.height=800;canvas.getContext=()=>backdrop;page.append(canvas);
  return {page,nodes,metrics,move:y=>{pageTop=y;},all:()=>{const visit=n=>[n,...(n.children||[]).flatMap(visit)];return visit(page);}};
}
