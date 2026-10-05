import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {signalScore} from '../signals.mjs';
import {displayLevel} from '../appearance.mjs';
const {snapshot,plan}=createRequire(import.meta.url)('../../vscode-extension/snapshot.cjs');
test('VSCode LF to raw UTF16 boundaries preserve CRLF, lone CR, emoji and combining clusters',()=>{
  const raw='a\r\n中文\r👩🏽‍💻 é\n';const s=snapshot(raw);assert.equal(s.text,'a\n中文\n👩🏽‍💻 é\n');assert.equal(s.boundaries.length,s.text.length+1);
  const start=s.text.indexOf('👩');const end=s.text.indexOf('\n',start);assert.equal(raw.slice(s.boundaries[start],s.boundaries[end]),'👩🏽‍💻 é');
  assert.equal(snapshot(raw).contentHash,snapshot(s.text).contentHash);
});
test('VSCode renderer rejects mismatched snapshots and invalid ranges, preserves missing semantic',()=>{
  const s=snapshot('中文 👩🏽‍💻');const candidate={start:3,end:s.text.length,text:s.text.slice(3),surprisalNormalized:.4,surprisalBits:7.2,semantic:null};
  const a={blocks:[{id:'b1',text:s.text,candidates:[candidate]}]};
  const painted=plan(a,s,{mode:'hybrid'},{signalScore,displayLevel})[0];
  assert.equal(painted.degraded,true);assert.equal(painted.score,.4);assert.equal(painted.level,displayLevel(.4));assert.equal(plan(a,s,{mode:'semantic_importance'},{signalScore,displayLevel}).length,0);
  assert.throws(()=>plan({...a,blocks:[{...a.blocks[0],text:'stale'}]},s,{}, {signalScore,displayLevel}));assert.throws(()=>plan({...a,blocks:[{...a.blocks[0],candidates:[{...candidate,start:-1}]}]},s,{}, {signalScore,displayLevel}));
});
