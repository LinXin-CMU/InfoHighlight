import {signalScore} from './signals.mjs';
/** Shared deterministic demo engine. Scores are heuristics, never model log probabilities. */
export const ENGINE_VERSION = 'demo-heuristic-v1';
export const SOURCE = 'demo_heuristic';
export const PROFILES = ['markdown', 'general', 'paper', 'code'];
export const CATEGORIES = ['key_finding', 'definition', 'constraint', 'risk', 'core_logic', 'boundary_condition', 'general'];

export function canonicalize(input) {
  if (typeof input !== 'string') throw new TypeError('Text must be a string');
  return input.replace(/\r\n?/g, '\n');
}

/** IDs, kind, order and the full surrounding text are part of this snapshot identity. */
export async function contentHash(blocks) {
  const snapshot = blocks.map(block => ({ id: String(block.id), kind: block.kind || 'paragraph', text: canonicalize(block.text) }));
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const nonspaceLength = text => Array.from(text).filter(char => !/\s/u.test(char)).length;
const clamp = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const round = value => Math.round(clamp(value) * 10000) / 10000;
const safeNumber = (value, fallback) => value === undefined ? fallback : (Number.isFinite(Number(value)) ? Number(value) : fallback);

const HINTS = [
  { category: 'boundary_condition', re: /仅当|只有|除非|例外|边界|条件|当.{0,16}时|\b(?:unless|only if|edge case|boundary|otherwise)\b/iu, score: 0.88 },
  { category: 'risk', re: /风险|失败|错误|泄露|攻击|超时|溢出|OOM|\b(?:risk|failure|leak|attack|timeout|overflow)\b/iu, score: 0.91 },
  { category: 'constraint', re: /必须|不得|禁止|不能|不可|不允许|不自动|禁止|限制|\b(?:must|shall|never|cannot|required|do not)\b/iu, score: 0.94 },
  { category: 'definition', re: /定义|是指|表示|称为|含义|\b(?:defined as|means|definition|refers to)\b/iu, score: 0.82 },
  { category: 'key_finding', re: /结论|结果|发现|提升|降低|优先|推荐|\b(?:conclusion|result|finding|improve|reduce|recommend)\b/iu, score: 0.86 },
  { category: 'core_logic', re: /核心|控制流|状态|队列|取消|缓存|融合|算法|\b(?:return|await|if|cache|queue|cancel|algorithm)\b/iu, score: 0.78 },
];
const PHRASES = [
  '本地双模型', '本地模型', '语义层', '语义模型', '语义', '双信号', '双模型', '信息密度', '条件概率', '负对数概率', '原文评分',
  '全文上下文', '完整上下文', '上下文策略', '上下文', '融合', '加权', '乘法', '显存', '量化', '本地推理',
  '开机自启', '系统托盘', '悬浮控制器', '悬浮窗', '客户端适配器', '适配器', '高亮预算', '高亮',
  '必须', '不得', '不能', '不可', '不允许', '禁止', '不自动', '不上传', '不会', '仅监听', '约束', '仅当', '只有', '除非', '边界条件', '边界', '例外',
  '风险', '失败', '错误', '泄露', '超时', '关键结论', '结论', '结果', '发现', '定义', '核心逻辑', '控制流', '状态改变',
  '缓存失效', '缓存', '失效', '内容摘要', '取消任务', '取消', '任务队列', '队列', '版本绑定', '修订号',
  '隐私', '不出本机', '本机', '未连接', '禁用云端', '默认关闭', '性能', '预算', '同源', '鉴权',
];

/** Segments cover every UTF-16 code unit, including separators, without changing source text. */
export function segmentSentences(text) {
  const sentences = [];
  let start = 0;
  for (let cursor = 0; cursor < text.length; cursor++) {
    const char = text[cursor];
    const decimal = char === '.' && /\d/u.test(text[cursor - 1] || '') && /\d/u.test(text[cursor + 1] || '');
    const englishEnd = char === '.' && !decimal && (cursor + 1 === text.length || /\s/u.test(text[cursor + 1]));
    if (/[。！？!?；;\n]/u.test(char) || englishEnd) {
      let end = cursor + 1;
      while (end < text.length && /[\s。！？!?；;”’"']/u.test(text[end])) end++;
      sentences.push({ start, end, text: text.slice(start, end) });
      start = end;
      cursor = end - 1;
    }
  }
  if (start < text.length) sentences.push({ start, end: text.length, text: text.slice(start) });
  return sentences;
}

function semantics(text, kind, profile) {
  // This dictionary/structure score is intentionally independent of the lexical-density score.
  const matched = HINTS.filter(hint => hint.re.test(text));
  let winner = matched.sort((a, b) => b.score - a.score)[0];
  let score = winner?.score ?? (kind === 'heading' ? 0.58 : 0.29);
  let category = winner?.category ?? 'general';
  if ((kind === 'code' || profile === 'code') && /\b(?:if|return|throw|await|catch)\b|=>|[=!]=/u.test(text)) {
    if (score < 0.84) { score = 0.84; category = 'core_logic'; }
  }
  if (profile === 'paper' && /实验|样本|显著|置信区间|\b(?:experiment|sample|significant|confidence)\b/iu.test(text)) {
    if (score < 0.87) { score = 0.87; category = 'key_finding'; }
  }
  return { semantic: round(score), category };
}

function occurrences(text) {
  const ranges = [];
  const add = (start, end, type) => {
    if (end > start && nonspaceLength(text.slice(start, end)) >= 2) ranges.push({ start, end, text: text.slice(start, end), type });
  };
  for (const phrase of PHRASES) {
    let start = 0;
    while ((start = text.indexOf(phrase, start)) !== -1) { add(start, start + phrase.length, 'phrase'); start += phrase.length; }
  }
  const patterns = [
    [/(?:\d+(?:\.\d+)?(?:\s?(?:GB|MB|ms|秒|分钟|%|B|个|GB\/s)))|\b\d+(?:\.\d+)?\b/giu, 'number'],
    [/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, 'number'],
    [/\b\d{3,5}\s+Super\b/giu, 'term'],
    [/\b[A-Za-z_][\w-]*(?:(?:\.[A-Za-z_][\w-]*)|(?:\/[A-Za-z_][\w-]*))+\b/gu, 'code'],
    [/(?<![A-Za-z\d_-])[A-Z][A-Z\d_-]{1,}(?![A-Za-z\d_-])|\b[A-Z][a-z]+(?:[A-Z][a-z\d]+)+\b/gu, 'term'],
    [/\b[A-Za-z][A-Za-z\d_-]{3,}\b/gu, 'word'],
    [/\b(?:if|return|throw|await|catch)\b[^;\n{}]{1,44}/gu, 'logic'],
    [/\p{Script=Han}{4,16}/gu, 'chinese'],
  ];
  for (const [pattern, type] of patterns) for (const match of text.matchAll(pattern)) add(match.index, match.index + match[0].length, type);
  const unique = new Map();
  // Specific dictionary/number/code phrases precede the fallback lexical runs.
  for (const range of ranges) {
    const key = `${range.start}:${range.end}`;
    if (!unique.has(key)) unique.set(key, range);
  }
  return [...unique.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

export function analyze(blocks, profile = 'markdown') {
  if (!PROFILES.includes(profile)) throw new RangeError(`Unknown profile: ${profile}`);
  const normalized = blocks.map(block => ({ id: String(block.id), kind: block.kind || 'paragraph', text: canonicalize(block.text) }));
  const frequency = new Map();
  const allRanges = normalized.map(block => occurrences(block.text));
  for (const ranges of allRanges) for (const range of ranges) {
    const key = range.text.toLowerCase(); frequency.set(key, (frequency.get(key) || 0) + 1);
  }
  return {
    schemaVersion: 1, engineVersion: ENGINE_VERSION, source: SOURCE, profile,
    modelConnected: false, offsetEncoding: 'utf16', normalizationVersion: 'lf-v1',
    disclaimer: '演示启发式分数；未执行语言模型推理，surprisalRaw 为 null。',
    blocks: normalized.map((block, index) => {
      const sentences = segmentSentences(block.text).map(sentence => ({ ...sentence, ...semantics(sentence.text, block.kind, profile) }));
      const candidates = allRanges[index].map(range => {
        const sentence = sentences.find(item => item.start <= range.start && range.end <= item.end);
        const local = semantics(range.text, block.kind, profile);
        const repeats = frequency.get(range.text.toLowerCase()) || 1;
        const rarity = 1 / Math.sqrt(repeats);
        const typeScore = { number: 0.91, code: 0.86, term: 0.83, logic: 0.69, phrase: 0.59, word: 0.45, chinese: 0.39 }[range.type];
        const score = typeScore * 0.72 + rarity * 0.23 + Math.min(0.05, nonspaceLength(range.text) / 320);
        const semantic = round(Math.max(local.semantic, (sentence?.semantic || 0.29) * (range.type === 'chinese' ? 0.88 : 0.96)));
        return {
          start: range.start, end: range.end, text: range.text,
          surprisalRaw: null, surprisalNormalized: round(score), semantic,
          category: local.category === 'general' ? (sentence?.category || 'general') : local.category,
          availableSignals: ['demo_information_density', 'demo_semantic_importance'],
        };
      }).filter(candidate => sentences.some(sentence => sentence.start <= candidate.start && candidate.end <= sentence.end));
      return { ...block, sentences, candidates };
    }),
  };
}

/** Selection is display-only; all scores and model provenance remain attached to each span. */
export function selectSpans(analysis, options = {}) {
  const mode = ({ density: 'information_density', semantic: 'semantic_importance' })[options.mode] || options.mode || 'hybrid';
  if (!['information_density', 'semantic_importance', 'hybrid'].includes(mode)) throw new RangeError(`Unknown mode: ${mode}`);
  const fusion = options.fusion || 'semantic_floor';
  if (!['semantic_floor', 'weighted', 'gated'].includes(fusion)) throw new RangeError(`Unknown fusion: ${fusion}`);
  const alpha = clamp(safeNumber(options.alpha, 0.4));
  const beta = clamp(safeNumber(options.beta, 0.35));
  const budget = clamp(safeNumber(options.budget, 0.15));
  const threshold = clamp(safeNumber(options.minScore, 0.38));
  const categories = options.categories === undefined ? null : new Set(options.categories);
  const totalChars = analysis.blocks.reduce((sum, block) => sum + nonspaceLength(block.text), 0);
  const limit = Math.floor(totalChars * budget);
  const ranked = [];
  analysis.blocks.forEach((block, blockOrder) => {
    block.candidates.forEach(candidate => {
      const S = clamp(candidate.surprisalNormalized), M = clamp(candidate.semantic);
      const local=['local_base','local_models'].includes(analysis.source);const computed=local?signalScore(candidate,{mode,alpha,beta,fusion}):null;
      const value = local?computed.score:signalScore({surprisalNormalized:S,semantic:M},{mode,alpha,beta,fusion}).score;
      if (value===null || value < threshold || (categories && !categories.has(candidate.category))) return;
      ranked.push({ ...candidate,...(local?{...computed,F:value,source:analysis.source}:{}), blockId: block.id, blockOrder, finalScore: round(value), length: nonspaceLength(candidate.text) });
    });
  });
  ranked.sort((a, b) => b.finalScore - a.finalScore || a.length - b.length || a.blockOrder - b.blockOrder || a.start - b.start);
  let coverageChars = 0;
  const chosen = [];
  for (const candidate of ranked) {
    if (coverageChars + candidate.length > limit) continue;
    if (chosen.some(span => span.blockId === candidate.blockId && candidate.start < span.end && candidate.end > span.start)) continue;
    chosen.push(candidate); coverageChars += candidate.length;
  }
  chosen.sort((a, b) => a.blockOrder - b.blockOrder || a.start - b.start);
  const spans = chosen.map(({ blockOrder, length, ...span }) => ({ ...span, level: span.finalScore >= 0.78 ? 'strong' : span.finalScore >= 0.60 ? 'medium' : 'subtle' }));
  return { spans, coverageChars, totalChars, coverageRatio: totalChars ? coverageChars / totalChars : 0, source: analysis.source || SOURCE };
}

/**
 * A complete word heatmap for the demo UI, independent of the sparse highlight budget.
 * Intl word boundaries preserve whole Latin words and Chinese lexical units. Non-word
 * segments are inspected as grapheme clusters so emoji, ZWJ families and keycaps survive.
 * These projected scores are still demo heuristics, never token-level model probabilities.
 */
export function selectHeatmap(analysis, options = {}) {
  if(['local_base','local_models'].includes(analysis.source)){
    const categories=options.categories===undefined?null:new Set(options.categories);
    const spans=analysis.blocks.flatMap(block=>block.candidates.filter(c=>!categories||categories.has(c.category)).map(c=>{const computed=signalScore(c,options);return {...c,...computed,blockId:block.id,finalScore:computed.score,F:computed.score,source:analysis.source,scoreSource:['local_instruct','local_mica'].includes(c.semanticSource)?'causal_probability_and_sentence_importance':'causal_token_probability',level:computed.score>=.78?'strong':computed.score>=.6?'medium':'subtle'};}).filter(c=>c.finalScore!==null));
    const coverageChars=spans.reduce((n,c)=>n+nonspaceLength(c.text),0);const totalChars=analysis.blocks.reduce((n,b)=>n+nonspaceLength(b.text),0);
    return {spans,coverageChars,totalChars,coverageRatio:totalChars?coverageChars/totalChars:0,source:analysis.source};
  }
  const mode = ({ density: 'information_density', semantic: 'semantic_importance' })[options.mode] || options.mode || 'hybrid';
  if (!['information_density', 'semantic_importance', 'hybrid'].includes(mode)) throw new RangeError(`Unknown mode: ${mode}`);
  const fusion = options.fusion || 'semantic_floor';
  if (!['semantic_floor', 'weighted', 'gated'].includes(fusion)) throw new RangeError(`Unknown fusion: ${fusion}`);
  const alpha = clamp(safeNumber(options.alpha, 0.4));
  const beta = clamp(safeNumber(options.beta, 0.35));
  const categories = options.categories === undefined ? null : new Set(options.categories);
  const wordSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  const graphemeSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
  const readable = /[\p{L}\p{N}\p{Extended_Pictographic}\p{Emoji_Presentation}\u20e3]/u;
  const spans = [];
  let coverageChars = 0;
  const totalChars = analysis.blocks.reduce((sum, block) => sum + nonspaceLength(block.text), 0);

  for (const block of analysis.blocks) {
    const units = [];
    for (const part of wordSegmenter.segment(block.text)) {
      if (part.isWordLike) units.push({ start: part.index, end: part.index + part.segment.length, text: part.segment });
      else for (const cluster of graphemeSegmenter.segment(part.segment)) {
        if (!readable.test(cluster.segment)) continue;
        const start = part.index + cluster.index;
        units.push({ start, end: start + cluster.segment.length, text: cluster.segment });
      }
    }
    const candidates = [...(block.candidates || [])].sort((a, b) => a.start - b.start || a.end - b.end);
    const sentences = block.sentences || [];
    let candidateCursor = 0, sentenceCursor = 0, active = [];
    for (const unit of units) {
      while (candidateCursor < candidates.length && candidates[candidateCursor].start < unit.end) active.push(candidates[candidateCursor++]);
      active = active.filter(candidate => candidate.end > unit.start);
      while (sentenceCursor < sentences.length && sentences[sentenceCursor].end <= unit.start) sentenceCursor++;
      const sentence = sentences[sentenceCursor];
      let sumS = 0, sumM = 0, weight = 0, dominant = null;
      for (const candidate of active) {
        const overlapStart = Math.max(unit.start, candidate.start), overlapEnd = Math.min(unit.end, candidate.end);
        if (overlapStart >= overlapEnd) continue;
        const overlap = nonspaceLength(block.text.slice(overlapStart, overlapEnd));
        sumS += clamp(candidate.surprisalNormalized) * overlap;
        sumM += clamp(candidate.semantic) * overlap;
        weight += overlap;
        if (!dominant || clamp(candidate.semantic) > clamp(dominant.semantic)) dominant = candidate;
      }
      // Unmatched readable units receive a modest lexical baseline. Sentence hints can
      // still carry semantic importance, while density remains independently low.
      const S = round(weight ? sumS / weight : 0.14 + Math.min(0.1, nonspaceLength(unit.text) / 100));
      const M = round(weight ? sumM / weight : clamp(sentence?.semantic ?? 0.29) * 0.75);
      const category = dominant?.category || sentence?.category || 'general';
      if (categories && !categories.has(category)) continue;
      const F = round(signalScore({surprisalNormalized:S,semantic:M},{mode,alpha,beta,fusion}).score);
      spans.push({
        blockId: block.id, ...unit, surprisalRaw: null,
        surprisalNormalized: S, semantic: M, finalScore: F, S, M, F, category,
        level: F >= 0.78 ? 'strong' : F >= 0.60 ? 'medium' : 'subtle',
        source: SOURCE, scoreSource: weight ? 'demo_candidate_projection' : 'demo_low_score_fallback',
        availableSignals: ['demo_information_density', 'demo_semantic_importance'],
      });
      coverageChars += nonspaceLength(unit.text);
    }
  }
  return { spans, coverageChars, totalChars, coverageRatio: totalChars ? coverageChars / totalChars : 0, source: SOURCE };
}
