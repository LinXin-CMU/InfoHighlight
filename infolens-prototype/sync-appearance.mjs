// Run after changing appearance.mjs. Classic injected/PDF scripts cannot import
// ESM, so ship the identical marked implementation without runtime dependencies.
import {readFile,writeFile} from 'node:fs/promises';
const source=await readFile(new URL('./appearance.mjs',import.meta.url),'utf8');
const pattern=/\/\/ BEGIN SHARED PAINT[\s\S]*?\/\/ END SHARED PAINT/;
const shared=source.match(pattern)?.[0].replace(/^export /gm,'');
if(!shared)throw Error('Missing canonical paint implementation');
for(const name of ['edge-extension','vscode-extension'])await writeFile(new URL(`../${name}/appearance.mjs`,import.meta.url),source);
for(const name of ['edge-extension/page.js','zotero-plugin/core.js']){
  const url=new URL('../'+name,import.meta.url),text=await readFile(url,'utf8');
  if(!pattern.test(text))throw Error('Missing paint marker in '+name);
  await writeFile(url,text.replace(pattern,()=>shared));
}
