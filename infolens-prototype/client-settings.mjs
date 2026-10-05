import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

export const CLIENTS=['workbench','edge','vscode','zotero','codex'];
const STYLES=['background','foreground','underline','fade'];
export class SettingsError extends Error{
  constructor(status,code,message){super(message);this.status=status;this.code=code;}
}
const fail=(code,message)=>{throw new SettingsError(400,code,message);};
function object(value,keys){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('invalid_settings','外观设置包含无效字段。');
}
function appearance(value){
  object(value,['style','hue','intensity']);
  if(!STYLES.includes(value.style)||!Number.isFinite(value.hue)||value.hue<0||value.hue>360||!Number.isFinite(value.intensity)||value.intensity<0||value.intensity>1.5)fail('invalid_settings','请选择有效样式、0–360° 色相和 0–150% 强度。');
  return {style:value.style,hue:value.hue,intensity:value.intensity};
}
function initial(){const defaults={style:'background',hue:0,intensity:1};return {schemaVersion:1,revision:0,updatedAt:null,defaults,clients:Object.fromEntries(CLIENTS.map(id=>[id,{inherit:id!=='zotero',settings:{...defaults,style:id==='zotero'?'underline':'background'}}]))};}
function validateSaved(data){
  object(data,['schemaVersion','revision','updatedAt','defaults','clients']);
  if(data.schemaVersion!==1||!Number.isSafeInteger(data.revision)||data.revision<0||!(data.updatedAt===null||typeof data.updatedAt==='string'))fail('invalid_settings_file','本地外观文件格式无效。');
  appearance(data.defaults);object(data.clients,CLIENTS);
  for(const id of CLIENTS){object(data.clients[id],['inherit','settings']);if(typeof data.clients[id].inherit!=='boolean')fail('invalid_settings_file','缺少客户端继承设置。');appearance(data.clients[id].settings);}
  return data;
}
export function createAppearanceStore({file=null,data=initial()}={}){
  let current=structuredClone(validateSaved(data)),chain=Promise.resolve();
  const snapshot=()=>({...structuredClone(current),storage:file?'local_preferences':'memory',clients:Object.fromEntries(CLIENTS.map(id=>[id,{...structuredClone(current.clients[id]),effective:{...(current.clients[id].inherit?current.defaults:current.clients[id].settings)}}]))});
  return {
    snapshot,
    async update(id,body){
      const task=chain.catch(()=>{}).then(async()=>{
        if(id!=='defaults'&&!CLIENTS.includes(id))throw new SettingsError(404,'unknown_client','未知应用端。');
        object(body,id==='defaults'?['revision','settings']:['revision','inherit','settings']);
        if(!Number.isSafeInteger(body.revision)||body.revision<0)fail('invalid_revision','保存外观需要当前配置版本。');
        if(body.revision!==current.revision)throw new SettingsError(409,'settings_conflict','设置已在其他窗口更新，请刷新后保存。');
        const value=appearance(body.settings);
        if(id!=='defaults'&&typeof body.inherit!=='boolean')fail('invalid_settings','请选择跟随统一样式或独立设置。');
        const next=structuredClone(current);
        if(id==='defaults')next.defaults=value;else next.clients[id]={inherit:body.inherit,settings:value};
        if(JSON.stringify(next)===JSON.stringify(current))return snapshot();
        next.revision++;next.updatedAt=new Date().toISOString();
        if(file){
          const temp=file+'.'+process.pid+'.'+randomBytes(6).toString('hex')+'.tmp';
          try{await mkdir(path.dirname(file),{recursive:true});await writeFile(temp,JSON.stringify(next,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});await rename(temp,file);}
          catch{throw new SettingsError(503,'settings_not_saved','外观设置未能写入本机，请检查文件可写后重试。');}
          finally{await unlink(temp).catch(()=>{});}
        }
        current=next;return snapshot();
      });
      chain=task;return task;
    }
  };
}
export async function openAppearanceStore(file){
  try{return createAppearanceStore({file,data:JSON.parse(await readFile(file,'utf8'))});}
  catch(error){if(error.code==='ENOENT')return createAppearanceStore({file});throw new Error('无法读取本地外观配置；原文件保留。'+error.message);}
}
