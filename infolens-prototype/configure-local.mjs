import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const app=path.dirname(fileURLToPath(import.meta.url)),extension=path.resolve(app,'../edge-extension'),native=path.join(extension,'native'),workspace=path.resolve(app,'../..');
const args=process.argv.slice(2);function option(name,fallback){const i=args.indexOf(name);if(i<0)return fallback;if(!args[i+1])throw new Error(name+' requires a value');return args[i+1];}
const python=path.resolve(option('--python',path.join(workspace,'work/infolens-runtime/Scripts/python.exe'))),modelPath=path.resolve(option('--model',path.join(workspace,'work/models/Qwen2.5-1.5B'))),port=Number(option('--port','43187'));
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid port');await stat(python);await stat(path.join(native,'InfoLensNative.exe'));
async function verifyModel(directory,manifestName){const model=JSON.parse(await readFile(path.join(app,manifestName),'utf8'));for(const item of model.files){const filename=path.join(directory,item.name);if((await stat(filename)).size!==item.bytes)throw new Error('Model size mismatch: '+item.name);const hash=createHash('sha256');for await(const bytes of createReadStream(filename))hash.update(bytes);if(hash.digest('hex')!==item.sha256)throw new Error('Model checksum mismatch: '+item.name);}await writeFile(path.join(directory,'model-manifest.json'),JSON.stringify(model,null,2));return model;}
const model=await verifyModel(modelPath,'model-manifest.json');
const semanticOption=option('--semantic-model',null),semanticModelPath=semanticOption?path.resolve(semanticOption):null;
if(semanticModelPath)await verifyModel(semanticModelPath,'semantic-model-manifest.json');
const translationOption=option('--translation-model',null),translationModelPath=translationOption?path.resolve(translationOption):null;
if(translationModelPath)await verifyModel(translationModelPath,'translation-model-manifest.json');
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));if(!manifest.key)throw new Error('Extension public key is missing');
const extensionId=[...createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
await writeFile(path.join(modelPath,'model-manifest.json'),JSON.stringify(model,null,2));
await writeFile(path.join(app,'local-config.json'),JSON.stringify({python,modelPath,...(semanticModelPath?{semanticModelPath}:{}),...(translationModelPath?{translationModelPath}:{}),port},null,2));
const host=path.resolve(app,'../windows-host');await mkdir(host,{recursive:true});
await writeFile(path.join(host,'host-config.json'),JSON.stringify({node:process.execPath,launcher:path.join(app,'real-launcher.mjs'),port},null,2));
await writeFile(path.join(native,'bridge-config.json'),JSON.stringify({port,extensionId},null,2));
await writeFile(path.join(native,'native-runtime.txt'),process.execPath+'\n'+path.join(native,'bridge.mjs')+'\n');
await writeFile(path.join(native,'host-manifest.json'),JSON.stringify({name:'com.infolens.local_reader',description:'InfoLens local-only bridge',path:path.join(native,'InfoLensNative.exe'),type:'stdio',allowed_origins:['chrome-extension://'+extensionId+'/']},null,2));
console.log('Verified model checksums and updated local paths. Extension ID: '+extensionId);console.log('Register the host with the supplied PowerShell installer, then load the extension in Edge.');
