import { createServer } from './server.mjs';
import { spawn } from 'node:child_process';

const port = Number(process.env.INFOLENS_PORT || 43187);
const url = `http://127.0.0.1:${port}`;
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('本地端口无效。');
if(process.platform !== 'win32') {
  console.log(`请运行 node server.mjs，然后打开 ${url}`);
  process.exit(0);
}
const server=createServer();
server.once('error', async error=>{
  if(error.code==='EADDRINUSE'){
    try{const response=await fetch(`${url}/v1/health`,{signal:AbortSignal.timeout(2000)});const health=await response.json();
      if(health.source==='demo_heuristic'&&health.modelConnected===false){openBrowser();console.log('已打开正在运行的 InfoLens 原型。可以关闭此窗口。');return;}
    }catch{}
    console.error(`端口 ${port} 已被其他服务占用。请在终端设置 INFOLENS_PORT 后重试。`);
  }else console.error(error.message);
  process.exitCode=1;
});
function openBrowser(){
  const browser=spawn('cmd.exe',['/d','/c','start','',url],{windowsHide:true,stdio:'ignore'});browser.on('error',()=>{console.log(`请手动打开 ${url}`);});browser.unref();
}
server.listen(port,'127.0.0.1',()=>{
  console.log('InfoLens 本地阅读原型已启动。');
  console.log('请保持此服务窗口开启。关闭窗口即可结束服务并清除内存会话。');
  console.log('当前使用演示规则，没有接入语言模型。');
  console.log(url);
  openBrowser();
});
