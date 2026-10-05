import {readFile} from 'node:fs/promises';
import {createServer} from './server.mjs';
import {createLocalProvider} from './local-provider.mjs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import {openAppearanceStore} from './client-settings.mjs';
import {openReadingStore} from './reading-store.mjs';
import {openPersistentCache} from './persistent-cache.mjs';
const settings=JSON.parse(await readFile(new URL('./local-config.json',import.meta.url),'utf8'));
const port=Number(process.env.INFOLENS_PORT||settings.port||43187);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('本机端口无效。');
const url=`http://127.0.0.1:${port}`;
const provider=await createLocalProvider();
const appearanceStore=await openAppearanceStore(path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.config'),'InfoLens','client-appearance.json'));
const userDirectory=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.config'),'InfoLens');
const readingStore=await openReadingStore(path.join(userDirectory,'client-reading.json'));
const diskCache=await openPersistentCache(path.join(userDirectory,'score-cache'));
const server=createServer({provider,stageDelayMs:0,appearanceStore,readingStore,diskCache});
server.once('error',async error=>{
  if(error.code==='EADDRINUSE'){
    try{const r=await fetch(url+'/v1/health',{signal:AbortSignal.timeout(2000)});const h=await r.json();if(h.source===provider.source){console.log('真实本地服务已经运行，可以关闭本窗口。');console.log(url);return;}}catch{}
    console.error('端口被其他服务占用，请先关闭演示服务或核对运行程序。');
  }else console.error(error.message);
  provider.close();process.exitCode=1;
});
server.listen(port,'127.0.0.1',()=>{console.log('InfoLens 真实本地阅读服务已启动；正在预加载本地模型。');console.log('阅读工作台：'+url);provider.warmup().then(()=>console.log('本地模型已预加载并驻留，可开始阅读。')).catch(()=>console.error('模型预加载失败，请在工作台检查状态并重试。'));});
let ending=false;
async function shutdown(){if(ending)return;ending=true;await diskCache.flush();await provider.close();server.close(()=>process.exit(0));server.closeIdleConnections();setTimeout(()=>process.exit(0),5000).unref();}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,shutdown);
// Only the parent Host receives this inherited stdin pipe. No HTTP shutdown route.
if(process.env.INFOLENS_HOST_MANAGED==='1'){
  const input=createInterface({input:process.stdin});
  input.on('line',line=>{if(line.length>256)return;try{const cmd=JSON.parse(line);if(cmd.action==='shutdown'&&Object.keys(cmd).length===1)shutdown();}catch{}});
  input.on('close',shutdown);
}
