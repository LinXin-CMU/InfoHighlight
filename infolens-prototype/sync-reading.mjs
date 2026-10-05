// Keep every adapter on the same source ranges, categories and coverage budget.
import {readFile,writeFile} from 'node:fs/promises';
const source=await readFile(new URL('./reading-policy.mjs',import.meta.url),'utf8');
const pattern=/\/\/ BEGIN SHARED READING[\s\S]*?\/\/ END SHARED READING/;
const shared=source.match(pattern)?.[0].replace(/^export /gm,'');
if(!shared)throw Error('Missing canonical reading policy');
for(const name of ['edge-extension','vscode-extension'])await writeFile(new URL(`../${name}/reading-policy.mjs`,import.meta.url),source);
const pdf=new URL('../zotero-plugin/core.js',import.meta.url),text=await readFile(pdf,'utf8');
if(!pattern.test(text))throw Error('Missing PDF reading marker');
await writeFile(pdf,text.replace(pattern,()=>shared));
