import {readFile,writeFile} from 'node:fs/promises';
const source=await readFile(new URL('./math-protection.mjs',import.meta.url),'utf8');
const pattern=/\/\/ BEGIN SHARED MATH[\s\S]*?\/\/ END SHARED MATH/;
const shared=source.match(pattern)[0].replace(/^export /gm,'');
for(const name of ['edge-extension/page.js','zotero-plugin/core.js','vscode-extension/snapshot.cjs']){
 const path=new URL('../'+name,import.meta.url),text=await readFile(path,'utf8');
 const marker=name.endsWith('snapshot.cjs')?'const {createHash}':name.endsWith('page.js')?'  const version=':'  const heatLayers=';
 const result=pattern.test(text)?text.replace(pattern,()=>shared):text.replace(marker,()=>shared+'\n'+marker);
 await writeFile(path,result.replace(/\r\n/g,'\n'));
}
