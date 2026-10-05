import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {CLIENTS,SettingsError} from './client-settings.mjs';
import {readingSettings,READING_DEFAULTS} from './reading-policy.mjs';
function initial(){return {schemaVersion:1,revision:0,defaults:{...READING_DEFAULTS},clients:Object.fromEntries(CLIENTS.map(id=>[id,{inherit:true,autoAnalyze:id==='zotero',settings:{...READING_DEFAULTS}}]))};}
const object=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new SettingsError(400,'invalid_reading_settings','阅读设置包含未知字段。');};
export function createReadingStore({file=null,data=initial()}={}){
  object(data,['schemaVersion','revision','defaults','clients']);if(data.schemaVersion!==1||!Number.isSafeInteger(data.revision)||data.revision<0)throw new Error('阅读设置版本无效。');
  readingSettings(data.defaults);for(const id of CLIENTS){const c=data.clients[id];object(c,['inherit','autoAnalyze','settings']);if(typeof c.inherit!=='boolean'||typeof c.autoAnalyze!=='boolean')throw new Error('阅读设置缺少应用端。');readingSettings(c.settings);}
  let current=structuredClone(data),chain=Promise.resolve();
  const snapshot=()=>({...structuredClone(current),storage:file?'local_preferences':'memory',clients:Object.fromEntries(CLIENTS.map(id=>[id,{...structuredClone(current.clients[id]),effective:readingSettings(current.clients[id].inherit?current.defaults:current.clients[id].settings)}]))});
  return {snapshot,async update(id,body){const task=chain.catch(()=>{}).then(async()=>{
    if(id!=='defaults'&&!CLIENTS.includes(id))throw new SettingsError(404,'unknown_client','未知应用端。');
    object(body,id==='defaults'?['revision','settings']:['revision','inherit','autoAnalyze','settings']);if(body.revision!==current.revision)throw new SettingsError(409,'settings_conflict','阅读设置已更新，请重试。');
    object(body.settings,['distribution','budget','categories','mode','classify']);const settings=readingSettings(body.settings),next=structuredClone(current);
    if(id==='defaults')next.defaults=settings;else{if(typeof body.inherit!=='boolean'||typeof body.autoAnalyze!=='boolean')throw new SettingsError(400,'invalid_reading_settings','请选择继承与自动分析。');next.clients[id]={inherit:body.inherit,autoAnalyze:body.autoAnalyze,settings};}
    if(JSON.stringify(next)===JSON.stringify(current))return snapshot();next.revision++;
    if(file){const temp=file+'.'+randomBytes(6).toString('hex')+'.tmp';try{await mkdir(path.dirname(file),{recursive:true});await writeFile(temp,JSON.stringify(next,null,2),{flag:'wx',mode:0o600});await rename(temp,file);}catch{throw new SettingsError(503,'settings_not_saved','阅读设置保存失败。');}finally{await unlink(temp).catch(()=>{});}}
    current=next;return snapshot();});chain=task;return task;}};
}
export async function openReadingStore(file){try{return createReadingStore({file,data:JSON.parse(await readFile(file,'utf8'))});}catch(e){if(e.code==='ENOENT')return createReadingStore({file});throw e;}}
