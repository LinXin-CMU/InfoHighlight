import {mkdir,readFile,writeFile,rename,readdir,stat,unlink} from 'node:fs/promises';
import {randomBytes,createHmac,createCipheriv,createDecipheriv} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';

// DPAPI binds the encryption key to the current Windows account. Test runners
// can supply a protector without launching PowerShell or touching user data.
export async function windowsProtect(bytes,decrypt=false){
  if(process.platform!=='win32')throw new Error('持久缓存当前只支持 Windows 用户密钥保护。');
  const operation=decrypt?'Unprotect':'Protect';
  const script=`Add-Type -AssemblyName System.Security; $cacheInput=[Console]::In.ReadToEnd(); $cacheBytes=[Convert]::FromBase64String($cacheInput); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${operation}($cacheBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  return new Promise((resolve,reject)=>{const child=spawn(path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',()=>{});child.once('error',reject);child.once('exit',code=>code===0?resolve(Buffer.from(output.trim(),'base64')):reject(new Error('Windows 用户密钥保护失败。')));child.stdin.end(bytes.toString('base64'));});
}
const defaults={enabled:false,maxMiB:512,ttlDays:7};
const pick=(v,keys)=>Object.fromEntries(keys.filter(k=>v?.[k]!==undefined).map(k=>[k,v[k]]));
const fields=['start','end','source','tokenIndices','surprisalBits','surprisalRaw','surprisalNormalized','tokenSurprisalNormalized','semantic','semanticRaw','semanticNormalized','semanticSource','semanticNormalization','semanticDisplay','sentenceIds','category','availableSignals','densityDisplay','sourceTokenRange','id','blockId','kind'];
function withoutText(v){if(Array.isArray(v))return v.map(withoutText);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!['text','wordText','raw','sourceText','prompt','question','message'].includes(k)).map(([k,x])=>[k,withoutText(x)]));return v;}
export function compactAnalysis(analysis){
  const root=withoutText(pick(analysis,['source','engineVersion','model','models','tokenCount','availableSignals','disclaimer','processingMs','timings','gpu','densityDisplay','semantic','semanticConnected','semanticModelLoaded']));
  root.blocks=analysis.blocks.map(b=>({...pick(b,['id','kind','scoredThrough','wordDisplayApplied','completedSentences','semanticNormalization']),candidates:b.candidates.map(c=>withoutText(pick(c,fields))),sentences:(b.sentences||[]).map(s=>withoutText(pick(s,fields))),rawCandidates:(b.rawCandidates||[]).map(c=>withoutText(pick(c,fields))),wordUnits:(b.wordUnits||[]).map(c=>pick(c,['start','end']))}));return root;
}
export function restoreAnalysis(value,blocks){
  if(!Array.isArray(value?.blocks)||value.blocks.length!==blocks.length)throw new Error('缓存快照不匹配。');
  const result=structuredClone(value);
  result.blocks=result.blocks.map((b,i)=>{const source=blocks[i];if(b.id!==source.id||b.kind!==source.kind)throw new Error('缓存块不匹配。');
    const hydrate=c=>{if(!Number.isInteger(c.start)||!Number.isInteger(c.end)||c.start<0||c.end<=c.start||c.end>source.text.length)throw new Error('缓存范围无效。');const row={...c,text:source.text.slice(c.start,c.end)};
      if(row.densityDisplay){const w=row.densityDisplay;if(!Number.isInteger(w.wordStart)||!Number.isInteger(w.wordEnd)||w.wordStart<0||w.wordEnd>source.text.length||w.wordEnd<=w.wordStart)throw new Error('缓存词范围无效。');w.wordText=source.text.slice(w.wordStart,w.wordEnd);}if(row.sourceTokenRange)row.sourceTokenRange.text=source.text.slice(row.sourceTokenRange.start,row.sourceTokenRange.end);return row;};
    return {...b,text:source.text,candidates:b.candidates.map(hydrate),sentences:b.sentences.map(hydrate),rawCandidates:b.rawCandidates.map(hydrate),wordUnits:b.wordUnits.map(hydrate)};});return result;
}
export async function openPersistentCache(directory,{protect=windowsProtect,now=Date.now}={}){
  const settingsFile=path.join(directory,'settings.json'),keyFile=path.join(directory,'key.dpapi');let settings={...defaults},secret,chain=Promise.resolve(),epoch=0,hits=0,error=null;
  try{const saved=JSON.parse(await readFile(settingsFile,'utf8'));if(typeof saved.enabled==='boolean'&&Number.isInteger(saved.maxMiB)&&saved.maxMiB>=16&&saved.maxMiB<=2048&&Number.isInteger(saved.ttlDays)&&saved.ttlDays>=1&&saved.ttlDays<=30)settings=saved;else error='缓存设置无效，已关闭。';}catch(e){if(e.code!=='ENOENT')error='缓存设置无法读取，已关闭。';}
  const serial=task=>{const pending=chain.catch(()=>{}).then(task);chain=pending;return pending;};
  async function key(){if(secret)return secret;await mkdir(directory,{recursive:true});try{secret=await protect(await readFile(keyFile),true);}catch(e){if(e.code!=='ENOENT')throw e;const candidate=randomBytes(32);await writeFile(keyFile,await protect(candidate),{flag:'wx',mode:0o600});secret=candidate;}if(secret.length!==32)throw new Error('缓存密钥无效。');return secret;}
  async function files(){try{return (await readdir(directory)).filter(n=>/^[a-f\d]{64}\.ilc$/u.test(n));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
  async function trim(){const rows=await Promise.all((await files()).map(async name=>({name,...await stat(path.join(directory,name))})));rows.sort((a,b)=>b.mtimeMs-a.mtimeMs);let size=0;for(const r of rows){size+=r.size;if(now()-r.mtimeMs>settings.ttlDays*86400000||size>settings.maxMiB*1024*1024)await unlink(path.join(directory,r.name)).catch(()=>{});}}
  const snapshot=()=>({...settings,storage:'encrypted_derived_scores',keyProtection:'Windows DPAPI CurrentUser',translationPersisted:false,hits,error});
  return {snapshot,async configure(value){return serial(async()=>{if(!value||Object.keys(value).sort().join(',')!=='enabled,maxMiB,ttlDays'||typeof value.enabled!=='boolean'||!Number.isInteger(value.maxMiB)||value.maxMiB<16||value.maxMiB>2048||!Number.isInteger(value.ttlDays)||value.ttlDays<1||value.ttlDays>30)throw new Error('请选择 16–2048 MiB 和 1–30 天的缓存设置。');
    if(value.enabled)await key();await mkdir(directory,{recursive:true});const temp=settingsFile+'.tmp';await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,settingsFile);epoch++;settings={...value};error=null;await trim();return snapshot();});},
    async get(identity,blocks){if(!settings.enabled)return null;try{const k=await key(),name=createHmac('sha256',k).update(identity).digest('hex')+'.ilc',file=path.join(directory,name),metadata=await stat(file);if(now()-metadata.mtimeMs>settings.ttlDays*86400000){await unlink(file);return null;}const bytes=await readFile(file);if(bytes.length<29||bytes.length>settings.maxMiB*1024*1024)return null;
      const decipher=createDecipheriv('aes-256-gcm',k,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));decipher.setAAD(Buffer.from(identity));const payload=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));const analysis=restoreAnalysis(payload,blocks);hits++;return analysis;
    }catch(e){if(e.code!=='ENOENT')error='一项持久缓存不可用，已重新计算。';return null;}},
    put(identity,analysis){const startedEpoch=epoch;if(!settings.enabled)return Promise.resolve();const payload=compactAnalysis(analysis);return serial(async()=>{if(!settings.enabled||startedEpoch!==epoch)return;try{const k=await key(),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',k,nonce);cipher.setAAD(Buffer.from(identity));const encrypted=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);const bytes=Buffer.concat([nonce,cipher.getAuthTag(),encrypted]);if(bytes.length>settings.maxMiB*1024*1024)return;const file=path.join(directory,createHmac('sha256',k).update(identity).digest('hex')+'.ilc'),temp=file+'.'+randomBytes(4).toString('hex')+'.tmp';await writeFile(temp,bytes,{flag:'wx',mode:0o600});await rename(temp,file);await trim();}catch{error='持久缓存写入失败，分析结果仍可用。';}});},
    clear(){epoch++;return serial(async()=>{for(const name of await files())await unlink(path.join(directory,name)).catch(()=>{});return snapshot();});},flush:()=>chain.catch(()=>{})};
}
