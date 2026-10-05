// The browser, editor and PDF reader use one canonical fusion implementation.
import {readFile,writeFile} from 'node:fs/promises';
const source=await readFile(new URL('./signals.mjs',import.meta.url),'utf8');
const pattern=/\/\/ BEGIN SHARED SIGNALS[\s\S]*?\/\/ END SHARED SIGNALS/;
const shared=source.match(pattern)?.[0].replace(/^export /gm,'');
if(!shared)throw Error('Missing canonical signal implementation');
for(const name of ['edge-extension','vscode-extension'])await writeFile(new URL(`../${name}/signals.mjs`,import.meta.url),source);
const pdf=new URL('../zotero-plugin/core.js',import.meta.url),text=await readFile(pdf,'utf8');
if(!pattern.test(text))throw Error('Missing PDF signal marker');
await writeFile(pdf,text.replace(pattern,()=>shared));
