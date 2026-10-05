import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import { analyze, canonicalize, contentHash, segmentSentences, selectSpans, selectHeatmap, nonspaceLength } from '../engine.mjs';
import { createServer } from '../server.mjs';

const blocks = [
  { id: 'b1', kind: 'heading', text: 'InfoLens 本地双模型' },
  { id: 'b2', kind: 'paragraph', text: '结论：必须仅监听 127.0.0.1，不上传阅读文本。4070 Super 的 12GB 显存采用量化模型。' },
  { id: 'b3', kind: 'paragraph', text: '边界条件：revision 改变后，旧的高亮结果必须失效。风险：取消任务不能晚到完成。' },
];
const snapshot = (revision = '1', sourceBlocks = blocks, profile = 'markdown') => ({
  schemaVersion: 1, document: { id: 'document-1', revision }, blocks: sourceBlocks, analysis: { profile },
});

const rawRequest = (url, headers) => new Promise((resolve, reject) => {
  const req = http.get(url, { headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject);
});

async function service(t, options = {}) {
  const server = createServer({ stageDelayMs: 5, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const session = await fetch(`${url}/v1/session`, { headers: { 'X-InfoLens-Client': 'prototype-test' } }).then(res => res.json());
  const call = async (route, init = {}) => {
    const res = await fetch(`${url}${route}`, {
      ...init, headers: { Authorization: `Bearer ${session.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const submit = input => call('/v1/jobs', { method: 'POST', body: JSON.stringify(input) });
  const wait = async id => {
    for (let attempt = 0; attempt < 250; attempt++) {
      const result = await call(`/v1/jobs/${id}`);
      if (['completed', 'failed', 'cancelled'].includes(result.body.status)) return result.body;
      await delay(5);
    }
    throw new Error(`Job ${id} did not reach a terminal state`);
  };
  return { server, url, token: session.token, call, submit, wait };
}

test('LF normalization preserves emoji, combining forms and every other source character', () => {
  assert.equal(canonicalize('😀\r\ne\u0301\r\t \u200b'), '😀\ne\u0301\n\t \u200b');
  assert.equal(canonicalize('é'), 'é');
  assert.throws(() => canonicalize(null), TypeError);
});

test('snapshot hash binds order, block kind, IDs and surrounding context; CRLF and LF agree', async () => {
  const hash = await contentHash(blocks);
  assert.match(hash, /^[a-f\d]{64}$/u);
  assert.notEqual(hash, await contentHash([...blocks].reverse()));
  assert.notEqual(hash, await contentHash(blocks.map((b, i) => i ? b : { ...b, id: 'other' })));
  assert.notEqual(hash, await contentHash(blocks.map((b, i) => i ? b : { ...b, kind: 'paragraph' })));
  assert.notEqual(hash, await contentHash([...blocks, { id: 'context', text: 'new context' }]));
  assert.equal(await contentHash([{ id: 'a', text: 'A\r\nB' }]), await contentHash([{ id: 'a', text: 'A\nB' }]));
});

test('sentences exactly partition the source; decimals do not split and surrogate pairs stay intact', () => {
  const text = '😀方法值为 3.14GB。\n  下一句 e\u0301！ End.\n最后';
  const sentences = segmentSentences(text);
  assert.equal(sentences.map(s => s.text).join(''), text);
  assert.ok(sentences[0].text.includes('3.14GB'));
  let end = 0;
  for (const sentence of sentences) {
    assert.equal(sentence.start, end);
    assert.equal(sentence.text, text.slice(sentence.start, sentence.end));
    assert.ok(!/[\uDC00-\uDFFF]/u.test(text[sentence.start] || ''));
    assert.ok(!/[\uD800-\uDBFF]/u.test(text[sentence.end - 1] || ''));
    end = sentence.end;
  }
  assert.equal(end, text.length);
});

test('analysis is deterministic, source-labelled, finite and contains no invented raw NLL', () => {
  const a = analyze(blocks), b = analyze(blocks);
  assert.deepEqual(a, b); assert.equal(a.source, 'demo_heuristic'); assert.equal(a.modelConnected, false);
  assert.ok(a.blocks.flatMap(b => b.candidates).length > 10);
  for (const block of a.blocks) for (const span of block.candidates) {
    assert.equal(span.text, block.text.slice(span.start, span.end));
    assert.equal(span.surprisalRaw, null);
    for (const score of [span.surprisalNormalized, span.semantic]) assert.ok(Number.isFinite(score) && score >= 0 && score <= 1);
    assert.deepEqual(span.availableSignals, ['demo_information_density', 'demo_semantic_importance']);
    assert.ok(!/[\uDC00-\uDFFF]/u.test(block.text[span.start] || ''));
    assert.ok(!/[\uD800-\uDBFF]/u.test(block.text[span.end - 1] || ''));
  }
  const terms = a.blocks.flatMap(b => b.candidates.map(c => c.text));
  assert.ok(terms.includes('127.0.0.1')); assert.ok(terms.includes('4070 Super')); assert.ok(terms.includes('12GB'));
  assert.throws(() => analyze(blocks, 'unsupported'), RangeError);
});

test('weighted and gated formulas preserve the two independent signal scores', () => {
  const analysis = { source: 'demo_heuristic', blocks: [{ id: 'a', text: 'test', candidates: [{ start: 0, end: 4, text: 'test', surprisalNormalized: 0.8, semantic: 0.25, category: 'general' }] }] };
  const opts = { fusion:'weighted', budget: 1, minScore: 0, alpha: 0.4, beta: 0.35 };
  assert.equal(selectSpans(analysis, opts).spans[0].finalScore, 0.47);
  assert.equal(selectSpans(analysis, { ...opts, fusion: 'gated' }).spans[0].finalScore, 0.41);
  assert.equal(selectSpans(analysis, { ...opts, mode: 'information_density' }).spans[0].finalScore, 0.8);
  assert.equal(selectSpans(analysis, { ...opts, mode: 'semantic_importance' }).spans[0].finalScore, 0.25);
  assert.equal(selectSpans(analysis, { ...opts, categories: [] }).spans.length, 0);
  assert.equal(selectSpans(analysis, { ...opts, categories: ['risk'] }).spans.length, 0);
});

test('acronym candidates never fragment a mixed-case ASCII word such as VSCode', () => {
  const text = '先完成 Edge 和 VSCode 的阅读闭环。JSON 输出必须有效。';
  const analysis = analyze([{ id: 'latin', text }]);
  assert.ok(analysis.blocks[0].candidates.some(candidate => candidate.text === 'VSCode'));
  for (const candidate of analysis.blocks[0].candidates) {
    assert.notEqual(candidate.text, 'VSC');
    assert.ok(!( /[A-Za-z\d_]/u.test(text[candidate.start - 1] || '') && /[A-Za-z\d_]/u.test(candidate.text[0] || '') ));
    assert.ok(!( /[A-Za-z\d_]/u.test(text[candidate.end] || '') && /[A-Za-z\d_]/u.test(candidate.text.at(-1) || '') ));
  }
  const spans = selectSpans(analysis, { mode: 'information_density', budget: 1, minScore: 0 }).spans;
  assert.ok(spans.some(span => span.text === 'VSCode'));
  assert.ok(spans.every(span => span.text !== 'VSC'));
});

test('selection enforces a nonspace codepoint budget, exact spans, categories and non-overlap', () => {
  const input = [...blocks, { id: 'emoji', text: '😀😀  必须保留边界条件！ e\u0301 不上传原文。' }, { id: 'blank', text: ' \n\t' }];
  const analysis = analyze(input);
  for (const budget of [0, 0.07, 0.15, 0.4, 1]) {
    const selection = selectSpans(analysis, { budget, categories: ['constraint', 'boundary_condition', 'risk'] });
    const total = input.reduce((n, b) => n + nonspaceLength(b.text), 0);
    assert.equal(selection.totalChars, total);
    assert.ok(selection.coverageChars <= Math.floor(total * budget));
    assert.equal(selection.coverageChars, selection.spans.reduce((n, s) => n + nonspaceLength(s.text), 0));
    assert.equal(selection.coverageRatio, total ? selection.coverageChars / total : 0);
    for (const span of selection.spans) {
      const text = input.find(b => b.id === span.blockId).text;
      assert.equal(text.slice(span.start, span.end), span.text);
      for (const other of selection.spans) if (other !== span && other.blockId === span.blockId) assert.ok(span.end <= other.start || other.end <= span.start);
      assert.ok(['constraint', 'boundary_condition', 'risk'].includes(span.category));
    }
  }
  assert.equal(selectSpans(analyze([{ id: 'a', text: ' \n\t' }])).coverageRatio, 0);
});

test('loopback service rejects hostile Host/Origin, unpaired sessions and unauthorized requests', async t => {
  const { url, call } = await service(t);
  assert.equal((await fetch(`${url}/v1/health`)).status, 200);
  assert.equal((await fetch(`${url}/v1/session`)).status, 403);
  assert.equal((await fetch(`${url}/v1/status`)).status, 401);
  // Native fetch controls Host and Sec-Fetch-Site; use a real HTTP client for hostile header tests.
  assert.equal(await rawRequest(`${url}/v1/health`, { Host: 'evil.example' }), 403);
  assert.equal((await fetch(`${url}/v1/session`, { headers: { Origin: 'https://evil.example', 'X-InfoLens-Client': 'browser' } })).status, 403);
  assert.equal(await rawRequest(`${url}/v1/session`, { 'Sec-Fetch-Site': 'cross-site', 'X-InfoLens-Client': 'browser' }), 403);
  assert.equal((await fetch(`${url}/v1/session`, { method: 'OPTIONS', headers: { Origin: url } })).status, 403);
  const result = await call('/v1/capabilities');
  assert.equal(result.status, 200); assert.equal(result.headers.get('access-control-allow-origin'), null);
  assert.equal(result.body.rawNll, false); assert.equal(result.body.gpuMetrics, false);
  assert.equal(result.body.adapters.codex, 'not_connected');
});

test('jobs complete with matching revision/hash and cache reuses analysis across display revisions', async t => {
  const { submit, wait, call } = await service(t);
  const request = snapshot('17'); request.document.contentHash = await contentHash(blocks);
  const created = await submit(request); assert.equal(created.status, 202);
  const completed = await wait(created.body.jobId);
  assert.equal(completed.status, 'completed'); assert.equal(completed.result.revision, '17');
  assert.equal(completed.result.contentHash, request.document.contentHash);
  assert.equal(completed.result.source, 'demo_heuristic'); assert.equal(completed.result.cacheHit, false);
  const again = await submit(snapshot('18'));
  const second = await wait(again.body.jobId);
  assert.equal(second.result.cacheHit, true); assert.equal(second.result.revision, '18');
  const status = await call('/v1/status'); assert.equal(status.body.cache.entries, 1); assert.equal(status.body.gpu, null);
  const profile = await submit(snapshot('19', blocks, 'paper'));
  assert.equal((await wait(profile.body.jobId)).result.cacheHit, false);
  const context = await submit(snapshot('20', [...blocks, { id: 'c', text: '上下文已更新。' }]));
  assert.equal((await wait(context.body.jobId)).result.cacheHit, false);
});

test('the ordinary-article profile is accepted and retains explicit generic-demo provenance', async t => {
  const { submit, wait, call } = await service(t);
  assert.ok((await call('/v1/capabilities')).body.profiles.includes('general'));
  const generic = [{ id: 'general', text: '必须核对结果。普通文章也有边界条件。' }];
  const ordinary = analyze(generic, 'general');
  assert.equal(ordinary.profile, 'general'); assert.equal(ordinary.modelConnected, false);
  assert.deepEqual(ordinary.blocks, analyze(generic, 'markdown').blocks);
  const created = await submit(snapshot('ordinary-1', generic, 'general'));
  assert.equal(created.status, 202);
  const completed = await wait(created.body.jobId);
  assert.equal(completed.result.analysis.profile, 'general');
  assert.equal(completed.result.source, 'demo_heuristic');
});

test('validation rejects stale hashes, unsupported config, duplicates and oversized content without cropping', async t => {
  const { submit, call } = await service(t);
  const mismatch = snapshot(); mismatch.document.contentHash = '0'.repeat(64);
  assert.equal((await submit(mismatch)).status, 409);
  assert.equal((await submit(snapshot('1', [blocks[0], blocks[0]]))).body.error.code, 'duplicate_block');
  assert.equal((await submit(snapshot('1', blocks, 'bad'))).status, 400);
  assert.equal((await submit({ ...snapshot(), inventedSetting: true })).body.error.code, 'unknown_field');
  assert.equal((await submit(snapshot('1', [{ id: 'large', text: 'x'.repeat(30001) }]))).status, 413);
  assert.equal((await submit(snapshot('1', Array.from({ length: 129 }, (_, i) => ({ id: `${i}`, text: 'a' }))))).status, 400);
  assert.equal((await call('/v1/jobs', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await submit(snapshot('1', [{ id: 'large', text: 'x'.repeat(1024 * 1024) }]))).status, 413);
  assert.equal((await call('/v1/status')).body.submittedJobs, 0);
});

test('queued and running cancellation are terminal and never cache or complete later', async t => {
  const { submit, wait, call } = await service(t, { stageDelayMs: 25, maxQueue: 2 });
  const first = await submit(snapshot('1'));
  const second = await submit(snapshot('2', [{ id: 'other', text: '风险：必须取消任务。' }]));
  const third = await submit(snapshot('3'));
  assert.equal(third.status, 429);
  assert.equal((await call(`/v1/jobs/${second.body.jobId}`, { method: 'DELETE' })).body.status, 'cancelled');
  assert.equal((await call(`/v1/jobs/${first.body.jobId}`, { method: 'DELETE' })).body.status, 'cancelled');
  await delay(140);
  assert.equal((await wait(first.body.jobId)).status, 'cancelled');
  assert.equal((await wait(second.body.jobId)).status, 'cancelled');
  const status = await call('/v1/status'); assert.equal(status.body.cache.entries, 0); assert.equal(status.body.activeJobs, 0);
});

test('clearing cache advances epoch and an in-flight job cannot repopulate it', async t => {
  const { submit, wait, call } = await service(t, { stageDelayMs: 20 });
  const pending = await submit(snapshot());
  await delay(10);
  const cleared = await call('/v1/cache', { method: 'DELETE' }); assert.equal(cleared.body.epoch, 1);
  assert.equal((await wait(pending.body.jobId)).status, 'completed');
  assert.equal((await call('/v1/status')).body.cache.entries, 0);
  const again = await submit(snapshot('2'));
  assert.equal((await wait(again.body.jobId)).result.cacheHit, false);
  assert.equal((await call('/v1/status')).body.cache.entries, 1);
});

test('clearing session data deletes retained payloads, cancels active work and keeps authentication valid', async t => {
  const { submit, wait, call } = await service(t, { stageDelayMs: 15 });
  const completed = await submit(snapshot('1')); await wait(completed.body.jobId);
  const running = await submit(snapshot('2', [{ id: 'private', text: '风险：私有阅读内容不得上传。' }]));
  const queued = await submit(snapshot('3', [{ id: 'queued-private', text: '必须取消所有队列任务。' }]));
  await delay(5);
  assert.equal((await call('/v1/session-data', { method: 'DELETE' })).body.cleared, true);
  for (const id of [completed.body.jobId, running.body.jobId, queued.body.jobId]) assert.equal((await call(`/v1/jobs/${id}`)).status, 404);
  await delay(90);
  const status = await call('/v1/status');
  assert.equal(status.status, 200); assert.equal(status.body.retainedJobs, 0);
  assert.equal(status.body.cacheEntries, 0); assert.equal(status.body.queueLength, 0); assert.equal(status.body.activeJobs, 0);
  const replacement = await submit(snapshot('4'));
  assert.equal(replacement.status, 202); assert.equal((await wait(replacement.body.jobId)).result.cacheHit, false);
});

test('analysis cache is bounded LRU and completed job payloads expire', async t => {
  const { submit, wait, call } = await service(t, { cacheSize: 1, jobTtlMs: 80, stageDelayMs: 1 });
  const a = await submit(snapshot('1'));
  await wait(a.body.jobId);
  const b = await submit(snapshot('2', [{ id: 'b', text: '定义：本地模型不上传文本。' }])); await wait(b.body.jobId);
  assert.equal((await call('/v1/status')).body.cache.entries, 1);
  const repeat = await submit(snapshot('3')); assert.equal((await wait(repeat.body.jobId)).result.cacheHit, false);
  await delay(120);
  assert.equal((await call(`/v1/jobs/${repeat.body.jobId}`)).status, 404);
});

test('full word heatmap preserves exact Unicode ranges, complete words and grapheme clusters', () => {
  const text = '你好 InfoLens VSCode e\u0301 👨‍👩‍👧‍👦 😀 👍🏽️ 🇨🇳 1️⃣ #️⃣ 。,!\n';
  const heatmap = selectHeatmap(analyze([{ id: 'unicode', text }]));
  assert.ok(heatmap.spans.some(span => span.text === 'VSCode'));
  assert.ok(heatmap.spans.some(span => span.text === 'e\u0301'));
  for (const cluster of ['👨‍👩‍👧‍👦', '😀', '👍🏽️', '🇨🇳', '1️⃣', '#️⃣']) assert.ok(heatmap.spans.some(span => span.text === cluster));
  const graphemeBoundaries = new Set([0, text.length]);
  for (const segment of new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)) graphemeBoundaries.add(segment.index);
  let end = 0;
  for (const span of heatmap.spans) {
    assert.ok(span.start >= end); assert.ok(span.end > span.start);
    assert.equal(span.text, text.slice(span.start, span.end));
    assert.ok(graphemeBoundaries.has(span.start) && graphemeBoundaries.has(span.end));
    assert.ok(!/^[\s\p{P}]+$/u.test(span.text));
    end = span.end;
  }
  assert.equal(heatmap.spans.map(span => span.text).join(''), '你好InfoLensVSCodee\u0301👨‍👩‍👧‍👦😀👍🏽️🇨🇳1️⃣#️⃣');
  assert.equal(heatmap.totalChars, nonspaceLength(text));
  assert.equal(heatmap.coverageChars, heatmap.spans.reduce((sum, span) => sum + nonspaceLength(span.text), 0));
  assert.equal(heatmap.coverageRatio, heatmap.coverageChars / heatmap.totalChars);
});

test('full word heatmap covers all readable words and ignores sparse budgets and hard thresholds', () => {
  const text = '先完成 Edge 和 VSCode 的阅读闭环。every readable word';
  const analysis = analyze([{ id: 'whole', text }]);
  const ordinary = selectHeatmap(analysis);
  assert.deepEqual(selectHeatmap(analysis, { budget: 0, minScore: 1 }), ordinary);
  const expected = [...new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(text)].filter(segment => segment.isWordLike).map(segment => segment.segment);
  assert.deepEqual(ordinary.spans.map(span => span.text), expected);
  assert.ok(ordinary.spans.every(span => span.text !== 'VSC'));
  assert.equal(selectSpans(analysis, { budget: 0 }).spans.length, 0);
  assert.equal(selectHeatmap(analyze([{ id: 'blank', text: ' \n\t' }])).coverageRatio, 0);
});

test('word heatmap projection obeys single-signal, weighted and gated formulas', () => {
  const analysis = { source: 'demo_heuristic', blocks: [{ id: 'a', text: 'test word', candidates: [
    { start: 0, end: 4, text: 'test', surprisalNormalized: 0.8, semantic: 0.25, category: 'general' },
    { start: 5, end: 9, text: 'word', surprisalNormalized: 0.4, semantic: 0.9, category: 'constraint' },
  ] }] };
  const opts = { fusion:'weighted', alpha: 0.4, beta: 0.35 };
  assert.equal(selectHeatmap(analysis, opts).spans[0].F, 0.47);
  assert.equal(selectHeatmap(analysis, { ...opts, fusion: 'gated' }).spans[0].F, 0.41);
  assert.equal(selectHeatmap(analysis, { ...opts, mode: 'information_density' }).spans[0].F, 0.8);
  assert.equal(selectHeatmap(analysis, { ...opts, mode: 'semantic_importance' }).spans[0].F, 0.25);
  assert.equal(selectHeatmap(analysis, opts).spans[1].F, 0.7);
  for (const span of selectHeatmap(analysis, opts).spans) {
    assert.equal(span.S, span.surprisalNormalized); assert.equal(span.M, span.semantic); assert.equal(span.F, span.finalScore);
    assert.equal(span.surprisalRaw, null); assert.equal(span.source, 'demo_heuristic');
    assert.deepEqual(span.availableSignals, ['demo_information_density', 'demo_semantic_importance']);
  }
});

test('word heatmap category masks keep matching units and unmatched words retain labelled low scores', () => {
  const analysis = { blocks: [{ id: 'a', text: 'ordinary important mystery', candidates: [
    { start: 9, end: 18, text: 'important', surprisalNormalized: 0.7, semantic: 0.95, category: 'risk' },
  ] }] };
  const full = selectHeatmap(analysis);
  assert.deepEqual(full.spans.map(span => span.text), ['ordinary', 'important', 'mystery']);
  assert.deepEqual(selectHeatmap(analysis, { categories: ['risk'] }).spans.map(span => span.text), ['important']);
  assert.equal(selectHeatmap(analysis, { categories: [] }).spans.length, 0);
  const fallback = full.spans.find(span => span.text === 'mystery');
  assert.equal(fallback.category, 'general'); assert.equal(fallback.scoreSource, 'demo_low_score_fallback');
  assert.ok(fallback.S < 0.3 && fallback.M < 0.3 && fallback.F < 0.3);
  assert.deepEqual(full, selectHeatmap(analysis));
  for (const span of full.spans) for (const score of [span.S, span.M, span.F]) assert.ok(Number.isFinite(score) && score >= 0 && score <= 1);
});
