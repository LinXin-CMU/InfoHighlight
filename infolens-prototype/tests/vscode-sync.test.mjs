import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createServer} from '../server.mjs';
import {createAppearanceStore} from '../client-settings.mjs';

test('VSCode extension polls central appearance into existing decoration ranges without submitting a new job',async()=>{
  const appearanceStore=createAppearanceStore();
  const provider={source:'local_base',fingerprint:'vscode-render-fixture',status:()=>({state:'ready'}),close(){},async analyze(blocks,profile,{onPartial}){const result={source:'local_base',blocks:blocks.map(b=>({...b,candidates:[{start:0,end:b.text.length,text:b.text,surprisalBits:8,surprisalNormalized:.8,semantic:null,category:'general'}]}))};onPartial(result);await new Promise(r=>setTimeout(r,450));return result;}};
  const server=createServer({provider,stageDelayMs:0,appearanceStore});server.listen(0,'127.0.0.1');await once(server,'listening');
  const text='中文 👩🏽‍💻 é\r\nLocal text stays intact.';
  const doc={uri:{scheme:'file',toString:()=> 'file:///fixture.md'},version:1,isClosed:false,languageId:'markdown',getText:()=>text,positionAt:offset=>({offset})};
  const painted=[];let created=0,removed=0;const editor={document:doc,setDecorations:(type,ranges)=>painted.push({options:type.options,ranges})},commands=new Map(),subscriptions=[];
  const event=()=>({dispose(){}}),config={port:server.address().port,mode:'information_density',style:'background',hue:0,intensity:1,alpha:.4,beta:.35,fusion:'weighted',reanalyzeOnEdit:false};
  const vscode={env:{remoteName:null},StatusBarAlignment:{Right:1},DecorationRangeBehavior:{ClosedClosed:0},ColorThemeKind:{HighContrast:3},Range:class{constructor(start,end){this.start=start;this.end=end;}},MarkdownString:class{constructor(value){this.value=value;}},TabInputText:class{},
    commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return event();}},workspace:{getConfiguration:()=>({get:key=>config[key]}),onDidChangeTextDocument:event,onDidCloseTextDocument:event,onDidChangeConfiguration:event},
    window:{activeTextEditor:editor,visibleTextEditors:[editor],activeColorTheme:{kind:2},createStatusBarItem:()=>({show(){},dispose(){}}),createOutputChannel:()=>({appendLine(){},dispose(){}}),createTextEditorDecorationType:options=>{created++;return {options,dispose(){removed++;}};},showErrorMessage:message=>{throw new Error(message);},onDidChangeActiveColorTheme:event,onDidChangeVisibleTextEditors:event,tabGroups:{onDidChangeTabs:event,all:[]}}};
  const sourcePath=fileURLToPath(new URL('../../vscode-extension/extension.cjs',import.meta.url)),require=createRequire(sourcePath),module={exports:{}};
  new Function('require','module','__dirname',await readFile(sourcePath,'utf8'))(name=>name==='vscode'?vscode:require(name),module,fileURLToPath(new URL('../../vscode-extension',import.meta.url)));
  try{
    const api=await module.exports.activate({subscriptions});const task=commands.get('infolens.analyze')();while(!painted.length)await new Promise(r=>setTimeout(r,10));assert.ok(api.diagnostic().pendingJob);assert.equal(created,1);assert.equal(removed,0);const result=await task;assert.equal(result.source,'local_base');assert(api.diagnostic().painted.length>0);assert.equal(created,1);assert.equal(removed,0);
    const before=api.diagnostic();const rows=appearanceStore.snapshot();await appearanceStore.update('vscode',{revision:rows.revision,inherit:false,settings:{style:'underline',hue:210,intensity:.7}});
    const deadline=Date.now()+5000;while(api.diagnostic().options.style!=='underline'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
    const after=api.diagnostic();assert.equal(after.options.style,'underline');assert.equal(after.options.intensity,.7);assert.equal(after.options.hue,210);assert.deepEqual(after.painted,before.painted);assert.equal(doc.getText(),text);assert.match(painted.at(-1).options.textDecoration,/underline/);
    const token=(await(await fetch(`http://127.0.0.1:${server.address().port}/v1/session`,{headers:{'X-InfoLens-Client':'test'}})).json()).token;const status=await(await fetch(`http://127.0.0.1:${server.address().port}/v1/status`,{headers:{Authorization:'Bearer '+token}})).json();assert.equal(status.submittedJobs,1);
  }finally{module.exports.deactivate();subscriptions.forEach(s=>s.dispose());await new Promise(r=>server.close(r));}
});
