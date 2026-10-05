import net from 'node:net';
import os from 'node:os';
import {createHash} from 'node:crypto';
export const pipeName='InfoLens.LocalReader.'+createHash('sha256').update(os.homedir().toLowerCase()).digest('hex').slice(0,16);
export function control(action='status',extra={}){
  return new Promise((resolve,reject)=>{
    const client=net.createConnection('\\\\.\\pipe\\'+pipeName);let input='';
    client.setTimeout(35000,()=>client.destroy(new Error('Host operation timed out')));
    client.on('connect',()=>client.write(JSON.stringify({action,...extra})+'\n'));
    client.on('error',reject);client.on('data',bytes=>{input+=bytes.toString('utf8');if(input.length>256000)client.destroy(new Error('Host reply exceeded limit'));if(input.includes('\n')){try{const value=JSON.parse(input.slice(0,input.indexOf('\n')));client.end();value.ok?resolve(value):reject(new Error(value.error));}catch(error){reject(error);client.destroy();}}});
    client.on('end',()=>{if(!input.includes('\n'))reject(new Error('Host closed without a reply'));});
  });
}
if(process.argv[1]&&process.argv[1].endsWith('host-control.mjs')){
  try{const action=process.argv[2]||'status';if(action==='autostart'&&!['on','off'].includes(process.argv[3]))throw new Error('Use autostart on or autostart off');console.log(JSON.stringify(await control(action,action==='autostart'?{enabled:process.argv[3]==='on'}:{}),null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
