import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { analyze, canonicalize, contentHash, ENGINE_VERSION, SOURCE, PROFILES } from './engine.mjs';
import {createAppearanceStore,SettingsError} from './client-settings.mjs';
import {createReadingStore} from './reading-store.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 1024 * 1024;
const MAX_BLOCKS = 128;
const MAX_TEXT = 30000;
const TERMINAL = new Set(['completed', 'cancelled', 'failed']);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const STATIC = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/app.css', 'app.css'], ['/app.mjs', 'app.mjs'], ['/engine.mjs', 'engine.mjs'], ['/appearance.mjs', 'appearance.mjs'], ['/reference-sample.mjs', 'reference-sample.mjs']]);
STATIC.set('/zotero-updates.json','zotero-updates.json');MIME['.json']='application/json; charset=utf-8';
STATIC.set('/signals.mjs','signals.mjs');STATIC.set('/edge-demo.html','edge-demo.html');STATIC.set('/edge-demo.css','edge-demo.css');STATIC.set('/edge-demo.mjs','edge-demo.mjs');STATIC.set('/edge-page.js','../edge-extension/page.js');
STATIC.set('/assets/infolens.svg','assets/infolens.svg');STATIC.set('/favicon.ico','assets/infolens.ico');
STATIC.set('/client-appearance-ui.mjs','client-appearance-ui.mjs');
STATIC.set('/math-protection.mjs','math-protection.mjs');
for(const name of ['reading-policy.mjs','reading-ui.mjs'])STATIC.set('/'+name,name);
const POLICIES = { contextPolicyVersion: 'whole-snapshot-demo-v1', promptPolicyVersion: 'dictionary-demo-v1', normalizationVersion: 'lf-v1' };

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };

function response(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function checkObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request', `${label} must be an object.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(400, 'unknown_field', `Unknown ${label} field: ${key}`);
}
function identifier(value, label, optional = false) {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || !value.length || value.length > 128 || /[\u0000-\u001f]/u.test(value)) fail(400, 'invalid_request', `${label} must be a nonempty string up to 128 characters.`);
}

async function parseBody(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415, 'content_type', 'Use application/json.');
  if (Number(req.headers['content-length']) > MAX_BODY) fail(413, 'body_too_large', 'Body exceeds the 1 MiB prototype limit.');
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) fail(413, 'body_too_large', 'Body exceeds the 1 MiB prototype limit.');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'invalid_json', 'Request body is not valid JSON.'); }
  return body;
}

async function validateRequest(body) {
  checkObject(body, ['schemaVersion', 'document', 'blocks', 'analysis'], 'request');
  if (body.schemaVersion !== undefined && body.schemaVersion !== 1) fail(400, 'schema_version', 'Only schemaVersion 1 is supported.');
  checkObject(body.document, ['id', 'revision', 'contentHash', 'offsetEncoding', 'normalizationVersion','ephemeral'], 'document');
  if(body.document.ephemeral!==undefined&&typeof body.document.ephemeral!=='boolean')fail(400,'ephemeral','ephemeral must be boolean.');
  identifier(body.document.id, 'document.id');
  identifier(body.document.revision, 'document.revision');
  if (body.document.offsetEncoding !== undefined && body.document.offsetEncoding !== 'utf16') fail(400, 'offset_encoding', 'This prototype requires UTF-16 offsets.');
  if (body.document.normalizationVersion !== undefined && body.document.normalizationVersion !== 'lf-v1') fail(400, 'normalization_version', 'Only lf-v1 normalization is supported.');
  if (!Array.isArray(body.blocks) || body.blocks.length < 1 || body.blocks.length > MAX_BLOCKS) fail(400, 'block_limit', 'Submit between 1 and 128 blocks.');
  const ids = new Set(); let textLength = 0;
  const blocks = body.blocks.map(block => {
    checkObject(block, ['id', 'kind', 'text'], 'block');
    identifier(block.id, 'block.id');
    if (ids.has(block.id)) fail(400, 'duplicate_block', 'Block IDs must be unique within a snapshot.');
    ids.add(block.id);
    if (block.kind !== undefined && !['paragraph', 'heading', 'code', 'list'].includes(block.kind)) fail(400, 'block_kind', 'Unsupported block kind.');
    if (typeof block.text !== 'string') fail(400, 'block_text', 'Each block needs string text.');
    textLength += block.text.length;
    return { id: block.id, kind: block.kind || 'paragraph', text: canonicalize(block.text) };
  });
  if (textLength > MAX_TEXT) fail(413, 'text_limit', 'Text exceeds the 30,000 UTF-16 code-unit prototype limit. No text was truncated.');
  const config = body.analysis || {};
  checkObject(config, ['profile','mode','classify'], 'analysis');
  if(config.classify!==undefined&&typeof config.classify!=='boolean')fail(400,'classification','classify must be boolean.');
  const mode=config.mode??'hybrid';
  if(!['information_density','hybrid','semantic_importance'].includes(mode))fail(400,'analysis_mode','Unsupported analysis mode.');
  const profile = config.profile || 'markdown';
  if (!PROFILES.includes(profile)) fail(400, 'profile', `Profile must be one of: ${PROFILES.join(', ')}`);
  const hash = await contentHash(blocks);
  if (body.document.contentHash !== undefined && body.document.contentHash !== hash) fail(409, 'content_hash_mismatch', 'The supplied hash does not match the canonical ordered snapshot.');
  return { document: { id: body.document.id, revision: body.document.revision, contentHash: hash,ephemeral:body.document.ephemeral===true }, blocks, profile, mode, classify:config.classify===true };
}

async function validateTranslation(body) {
  checkObject(body,['schemaVersion','document','blocks','translation'],'request');
  checkObject(body.translation,['targetLanguage'],'translation');
  if(!['zh','en'].includes(body.translation.targetLanguage))fail(400,'target_language','Use zh or en.');
  const input=await validateRequest({schemaVersion:body.schemaVersion,document:body.document,blocks:body.blocks,analysis:{profile:'paper'}});
  return {...input,kind:'translation',targetLanguage:body.translation.targetLanguage};
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Cancelled')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** An isolated loopback service. No models, outgoing requests, telemetry or disk document cache. */
export function createServer(options = {}) {
  const appearanceStore=options.appearanceStore||createAppearanceStore();
  const readingStore=options.readingStore||createReadingStore(),diskCache=options.diskCache;
  const provider=options.provider;
  const source=provider?.source||SOURCE;
  const policies=provider?.policies||POLICIES;
  const stageDelayMs = options.stageDelayMs ?? 300;
  const maxQueue = options.maxQueue ?? 8;
  const cacheSize = options.cacheSize ?? 16;
  const jobTtlMs = options.jobTtlMs ?? 10 * 60 * 1000;
  const token = randomBytes(32).toString('hex');
  const jobs = new Map(), cache = new Map(), queue = [];
  let activeJob = null, cacheEpoch = 0, sessionEpoch = 0, running = false, shuttingDown = false;
  let cacheHits = 0, submitted = 0;
  let paused = false, unloading = false, controlEpoch = 0;
  const instanceId = randomBytes(16).toString('hex');
  function cancelWork() {
    for (const job of jobs.values()) if (!TERMINAL.has(job.status)) {
      transition(job, 'cancelled'); job.abort.abort(); job.blocks = null; job.partial=null;
    }
    queue.length = 0;
  }

  function pruneJobs() {
    const now = Date.now();
    for (const [id, job] of jobs) if (TERMINAL.has(job.status) && now - job.updatedAt > jobTtlMs) jobs.delete(id);
    // Retained snapshots and results have a hard cap as well as an expiry.
    const terminal = [...jobs.values()].filter(job => TERMINAL.has(job.status));
    while (terminal.length > 64) jobs.delete(terminal.shift().jobId);
  }
  function cacheGet(key) {
    if (!cache.has(key)) return undefined;
    const value = cache.get(key); cache.delete(key); cache.set(key, value);
    return value;
  }
  function cachePut(key, value) {
    if (!cacheSize) return;
    cache.delete(key); cache.set(key, value);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
  }
  function publicJob(job) {
    return {
      schemaVersion: 1, jobId: job.jobId, status: job.status, stage: job.stage, details:job.progress||null,
      progress: ({ queued: 0, segmenting: 0.12, density: 0.35, semantic: 0.62, fusion: 0.88, cache_hit: 0.9, completed: 1 })[job.stage] ?? 0,
      source, kind:job.kind||'analysis', ...(job.kind==='translation'?{targetLanguage:job.targetLanguage}:{}), documentId: job.document.id, revision: job.document.revision,
      contentHash: job.document.contentHash, createdAt: job.createdAt, updatedAt: job.updatedAt,
      ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}),
      ...(!TERMINAL.has(job.status)&&job.partial?{partial:job.partial}:{}),
    };
  }
  function transition(job, status, stage = status) { job.status = status; job.stage = stage; job.updatedAt = Date.now(); }
  async function work() {
    if (running || shuttingDown) return;
    running = true;
    try {
      while (queue.length && !shuttingDown) {
        const job = queue.shift();
        if (job.status === 'cancelled') continue;
        activeJob = job; const started = performance.now();
        try {
          transition(job, 'running', 'segmenting');
          const key = JSON.stringify([provider?.fingerprint||ENGINE_VERSION, policies, job.kind||'analysis',job.targetLanguage||null,job.mode==='information_density'?'density':'semantic',job.profile,job.classify===true, job.document.contentHash]);
          const cached = cacheGet(key)||(job.kind!=='translation'&&!job.document.ephemeral?await diskCache?.get(key,job.blocks):null);
          let analysis;
          if (cached) {
            transition(job, 'running', 'cache_hit');
            await sleep(Math.min(stageDelayMs, 15), job.abort.signal);
            analysis = cached; cacheHits++;
          } else {
            for (const stage of job.kind==='translation'?['segmenting']:provider?['segmenting','density']:['segmenting', 'density', 'semantic', 'fusion']) {
              transition(job, 'running', stage);
              await sleep(stageDelayMs, job.abort.signal);
            }
            if (job.abort.signal.aborted || shuttingDown) continue;
            const callbacks={mode:job.mode,classify:job.classify===true,signal:job.abort.signal,onProgress:progress=>{if(job.abort.signal.aborted)return;job.progress={done:progress.done??null,total:progress.total??null};transition(job,'running',progress.stage);},onPartial:analysis=>{
              if(job.abort.signal.aborted||shuttingDown||TERMINAL.has(job.status))return;
              // Keep one bounded cumulative snapshot, never an unbounded event log.
              job.partial={sequence:(job.partial?.sequence||0)+1,revision:job.document.revision,contentHash:job.document.contentHash,source,analysis};
              job.updatedAt=Date.now();
            }};
            analysis = job.kind==='translation'?await provider.translate(job.blocks,job.targetLanguage,callbacks):provider?await provider.analyze(job.blocks,job.profile,callbacks):analyze(job.blocks, job.profile);
            if(provider&&!job.abort.signal.aborted&&job.kind!=='translation')transition(job,'running','fusion');
            if (job.epoch === cacheEpoch && !job.abort.signal.aborted && (job.kind==='translation'?analysis.status==='ready':job.mode==='information_density'||!provider?.semanticConfigured||analysis.semantic?.status==='ready')) {cachePut(key, analysis);if(job.kind!=='translation'&&!job.document.ephemeral)await diskCache?.put(key,analysis);}
          }
          if (job.abort.signal.aborted || shuttingDown) continue;
          job.result = {
            analysis, cacheHit: Boolean(cached), processingMs: Math.round(performance.now() - started),
            revision: job.document.revision, contentHash: job.document.contentHash, source,
          };
          transition(job, 'completed');
          job.partial=null;
          // Analysis results are retained until TTL; duplicate input buffers can be released now.
          job.blocks = null;
          job.partial=null;
        } catch (error) {
          if (job.abort.signal.aborted) transition(job, 'cancelled');
          else { job.error = { code: error.code||'analysis_failed', message: provider?'Local model scoring failed: '+error.message:'The demo analysis failed.' }; transition(job, 'failed'); }
          job.blocks = null;
        } finally { activeJob = null; pruneJobs(); }
      }
    } finally { running = false; }
  }

  function security(req, port) {
    const origin = `http://127.0.0.1:${port}`;
    if (req.headers.host !== `127.0.0.1:${port}`) fail(403, 'untrusted_host', 'This service only accepts its own loopback Host.');
    if (req.headers.origin !== undefined && req.headers.origin !== origin) fail(403, 'untrusted_origin', 'Cross-origin access is disabled.');
    if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) fail(403, 'untrusted_origin', 'Use the same-origin prototype page.');
  }
  function authenticated(req) {
    const received = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${token}`);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) fail(401, 'unauthorized', 'A current session bearer token is required.');
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      security(req, req.socket.localPort);
      const pathname = new URL(req.url, `http://127.0.0.1:${req.socket.localPort}`).pathname;
      if (req.method === 'OPTIONS') fail(403, 'cors_disabled', 'Cross-origin preflight is disabled.');
      if (req.method === 'GET' && pathname === '/v1/health') {
        response(res, 200, { status: 'ok', schemaVersion: 1, source, controlVersion:1, hostManaged:process.env.INFOLENS_HOST_MANAGED==='1', instanceId, modelConnected:provider?.status().modelConnected||false }); return;
      }
      if (req.method === 'GET' && pathname === '/v1/session') {
        const client = req.headers['x-infolens-client'];
        if (typeof client !== 'string' || !/^[\x21-\x7e]{1,64}$/u.test(client)) fail(403, 'client_header', 'Provide the same-origin X-InfoLens-Client header.');
        response(res, 200, { schemaVersion: 1, token, tokenType: 'Bearer', source, scope: 'local-reader', expires: 'process_restart' }); return;
      }
      if (pathname.startsWith('/v1/')) authenticated(req);
      pruneJobs();
      if(req.method==='GET'&&pathname==='/v1/reading'){response(res,200,readingStore.snapshot());return;}
      const readingMatch=/^\/v1\/reading\/(defaults|workbench|edge|vscode|zotero|codex)$/u.exec(pathname);
      if(req.method==='PUT'&&readingMatch){response(res,200,await readingStore.update(readingMatch[1],await parseBody(req)));return;}
      if(req.method==='GET'&&pathname==='/v1/cache-settings'){response(res,200,diskCache?.snapshot()||{enabled:false,available:false});return;}
      if(req.method==='PUT'&&pathname==='/v1/cache-settings'){if(!diskCache)fail(503,'cache_unavailable','持久缓存未配置。');try{response(res,200,await diskCache.configure(await parseBody(req)));}catch(e){fail(400,'cache_settings',e.message);}return;}
      if(req.method==='GET'&&pathname==='/v1/appearance'){
        response(res,200,appearanceStore.snapshot());return;
      }
      const appearanceMatch=/^\/v1\/appearance\/(defaults|workbench|edge|vscode|zotero|codex)$/u.exec(pathname);
      if(req.method==='PUT'&&appearanceMatch){
        response(res,200,await appearanceStore.update(appearanceMatch[1],await parseBody(req)));return;
      }
      if (req.method === 'GET' && pathname === '/v1/capabilities') {
        response(res, 200, {
          schemaVersion: 1, source, engineVersion: provider?.semanticConfigured?'local-dual-v1':provider?'causal-base-v1':ENGINE_VERSION, modelConnected:provider?.status().modelConnected||false,
          profiles: PROFILES, semanticConfigured:Boolean(provider?.semanticConfigured),modes:provider&&!provider.semanticConfigured?['information_density']:['information_density', 'semantic_importance', 'hybrid'],
          fusion: provider&&!provider.semanticConfigured?[]:['semantic_floor','weighted', 'gated'], limits: { maxBodyBytes: MAX_BODY, maxBlocks: MAX_BLOCKS, maxTextUtf16: MAX_TEXT, maxQueue },
          offsetEncoding: 'utf16', normalizationVersion: 'lf-v1', policies,
          adapters: { browser: provider?'same-origin-real-preview':'same-origin-demo', edge: provider?'installation_unverified':'not_connected', vscode: 'not_connected', zotero: 'plugin_available', codex: 'not_connected' },
          rawNll: Boolean(provider), gpuMetrics: Boolean(provider), diskCache: Boolean(diskCache), cloudFallback: false, sessionDataClear: true,
          translation:{available:!!provider?.translate,targets:['zh','en'],scope:'explicit-current-page/viewport-paragraphs',source:provider?.status().translationModel?.dedicated?'local_dedicated_translation':'local_instruct',model:provider?.status().translationModel||null,diskCache:false},
          appearanceSettings:{schemaVersion:1,storage:appearanceStore.snapshot().storage,clients:['workbench','edge','vscode','zotero','codex'],styles:['background','foreground','underline','fade']},
        }); return;
      }
      if (req.method === 'GET' && pathname === '/v1/status') {
        response(res, 200, {
          controlVersion:1, instanceId, paused, unloading, hostManaged:process.env.INFOLENS_HOST_MANAGED==='1',
          status:provider?.status().state||'ready',source,modelConnected:provider?.status().modelConnected||false,gpu:provider?.status().gpu||null,inference:provider?.status().model||'not_connected',semanticConfigured:Boolean(provider?.semanticConfigured),semantic:provider?.status().semanticModel||null,semanticModelLoaded:provider?.status().semanticModelLoaded||false,translation:provider?.status().translationModel||null,translationModelLoaded:provider?.status().translationModelLoaded||false,
          modelsReady:provider?.status().modelsReady??null,residency:provider?.status().residency||null,workerPids:provider?.status().residency?.workerPids||null,
          activeJob: activeJob?.jobId || null, queueLength: queue.filter(job => job.status === 'queued').length,
          cacheEntries: cache.size, activeJobs: activeJob ? 1 : 0,
          cache: { entries: cache.size, capacity: cacheSize, hits: cacheHits, epoch: cacheEpoch, storage: 'memory',persistent:diskCache?.snapshot()||null },
          submittedJobs: submitted, retainedJobs: jobs.size,process:{pid:process.pid,uptimeSeconds:Math.round(process.uptime()),memory:process.memoryUsage()},
        }); return;
      }
      if (req.method === 'POST' && pathname === '/v1/control') {
        const body = await parseBody(req); checkObject(body, ['action'], 'control');
        if (!['pause', 'resume', 'unload', 'warmup'].includes(body.action)) fail(400, 'control_action', 'Use pause, resume, unload or warmup.');
        if (unloading) fail(409, 'unloading', 'Model unload is already in progress.');
        controlEpoch++;
        if (body.action === 'pause') { paused = true; cancelWork(); }
        if (body.action === 'resume') paused = false;
        if (body.action === 'warmup' || body.action === 'resume' && provider?.status().modelsReady===false) provider?.warmup?.().catch(()=>{});
        if (body.action === 'unload') {
          unloading = true; cancelWork();
          try { await provider?.unload?.(); } finally { unloading = false; }
        }
        response(res, 200, { action:body.action, paused, unloading, modelConnected:provider?.status().modelConnected||false, resultsRetained:true }); return;
      }
      if (req.method === 'POST' && ['/v1/jobs','/v1/translation-jobs'].includes(pathname)) {
        const requestControlEpoch = controlEpoch;
        const requestEpoch = sessionEpoch;
        if(pathname==='/v1/translation-jobs'&&!provider?.translate)fail(503,'translation_unavailable','Local instruct translation is not configured.');
        const body=await parseBody(req);
        const input = pathname==='/v1/translation-jobs'?await validateTranslation(body):await validateRequest(body);
        if (paused) fail(423, 'analysis_paused', 'New analysis is paused. Resume from the tray or Settings.');
        if (unloading) fail(503, 'unloading', 'Wait for model unload to finish.');
        if (requestControlEpoch !== controlEpoch) fail(409, 'control_changed', 'Service control changed while receiving the snapshot. Resubmit.');
        if (requestEpoch !== sessionEpoch) fail(409, 'session_reset', 'The session was cleared while this request was being received. Resubmit the current snapshot.');
        if (queue.filter(job => job.status === 'queued').length + (activeJob ? 1 : 0) >= maxQueue) fail(429, 'queue_full', 'The prototype queue is full. Retry after a job finishes.');
        const jobId = randomBytes(12).toString('hex');
        const job = { ...input, jobId, status: 'queued', stage: 'queued', epoch: cacheEpoch, createdAt: Date.now(), updatedAt: Date.now(), abort: new AbortController() };
        submitted++; jobs.set(jobId, job); queue.push(job);
        response(res, 202, publicJob(job));
        setImmediate(work); return;
      }
      const jobMatch = /^\/v1\/jobs\/([a-f\d]{24})$/u.exec(pathname);
      if (jobMatch && ['GET', 'DELETE'].includes(req.method)) {
        const job = jobs.get(jobMatch[1]);
        if (!job) fail(404, 'job_not_found', 'This job is unknown or has expired.');
        if (req.method === 'DELETE' && !TERMINAL.has(job.status)) {
          transition(job, 'cancelled'); job.abort.abort(); job.blocks = null; job.partial=null;
          const index = queue.indexOf(job); if (index !== -1) queue.splice(index, 1);
        }
        response(res, 200, publicJob(job)); return;
      }
      if (req.method === 'DELETE' && pathname === '/v1/cache') {
        const clearedEntries = cache.size; cache.clear(); cacheEpoch++;await diskCache?.clear();
        response(res, 200, { clearedEntries, epoch: cacheEpoch, storage: 'memory', jobResultsRetainedUntilTtl: true }); return;
      }
      if (req.method === 'DELETE' && pathname === '/v1/session-data') {
        sessionEpoch++; cacheEpoch++;
        for (const job of jobs.values()) {
          if (!TERMINAL.has(job.status)) { transition(job, 'cancelled'); job.abort.abort(); }
          job.blocks = null; job.result = null; job.partial=null;
        }
        queue.length = 0; jobs.clear(); cache.clear(); activeJob = null;await diskCache?.clear();
        response(res, 200, { cleared: true, epoch: cacheEpoch, tokenStillValid: true }); return;
      }
      if (req.method === 'GET' && STATIC.has(pathname)) {
        const filename = STATIC.get(pathname), data = await readFile(path.join(ROOT, filename));
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filename)], 'Cache-Control': 'no-store' }); res.end(data); return;
      }
      fail(404, 'not_found', 'Route not found.');
    } catch (error) {
      if (error instanceof ApiError||error instanceof SettingsError) response(res, error.status, { error: { code: error.code, message: error.message } });
      else response(res, 500, { error: { code: 'internal_error', message: 'The local service could not complete this request.' } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const sweeper = setInterval(pruneJobs, Math.max(25, Math.min(jobTtlMs, 60000))); sweeper.unref();
  server.on('close', () => {
    provider?.close();
    shuttingDown = true; clearInterval(sweeper);
    for (const job of jobs.values()) if (!TERMINAL.has(job.status)) { transition(job, 'cancelled'); job.abort.abort(); }
    jobs.clear(); cache.clear(); queue.length = 0;
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.INFOLENS_PORT || 43187);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('INFOLENS_PORT must be between 1 and 65535.'); process.exitCode = 1; }
  else {
    const provider=process.env.INFOLENS_REAL==='1'?await (await import('./local-provider.mjs')).createLocalProvider():undefined;
    const server = createServer({provider,stageDelayMs:provider?0:300});
    server.on('error', error => { console.error(`InfoLens local service: ${error.message}`); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => {
      console.log(`InfoLens ${provider?'local Base':'demo'}: http://127.0.0.1:${port}`);
      console.log(provider?'Offline GPU scoring. Preloading configured models.':'Demo heuristics only.');
      provider?.warmup().catch(error=>console.error('InfoLens startup preload failed: '+error.message));
    });
    const close=()=>{provider?.close();server.close(()=>process.exit(0));};process.once('SIGINT',close);process.once('SIGTERM',close);
  }
}
