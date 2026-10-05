// This function is serialized into the isolated page world. Keep it self-contained.
export function invokePage(operation, payload, prefs) {
  try {
    const renderer = globalThis.InfoLensPage;
    if (operation === 'clear') return {ok:true,data:renderer?.clear(payload?.revision) ?? false};
    if (operation === 'stop') return {ok:true,data:renderer?.stop(payload?.revision) ?? renderer?.clear(payload?.revision) ?? false};
    if (!renderer || typeof renderer[operation] !== 'function') throw new Error('网页高亮组件未就绪，请重新点击分析。');
    const data = operation === 'capture' ? renderer.capture() : renderer.paint(payload, prefs);
    return {ok:true,data};
  } catch (error) {
    return {ok:false,error:{message:typeof error?.message === 'string' ? error.message : '网页高亮执行失败，请重新分析。',code:error?.code==='document_changed'?'document_changed':undefined}};
  }
}

export function injectionFrame(results, expectedDocumentId) {
  const frame = Array.isArray(results) ? results.find(row => row?.frameId === 0) : null;
  if (!frame || typeof frame.documentId !== 'string' || !frame.documentId) throw new Error('网页脚本未返回有效结果；页面可能已刷新或关闭，请重新分析。');
  if (expectedDocumentId && frame.documentId !== expectedDocumentId) throw new Error('页面已切换，旧网页结果已丢弃，请重新分析。');
  return frame;
}

export function pageReply(results, documentId) {
  const {result} = injectionFrame(results, documentId);
  if (!result || typeof result.ok !== 'boolean') throw new Error('网页脚本未返回有效结果；页面可能已刷新，请重新分析。');
  if (!result.ok) throw Object.assign(new Error(typeof result.error?.message === 'string' ? result.error.message : '网页高亮执行失败，请重新分析。'),{code:result.error?.code});
  return result.data;
}

export function captureReply(data) {
  if (!data || typeof data.revision !== 'string' || !data.revision || !Array.isArray(data.blocks) || !data.blocks.length ||
      data.blocks.some(b => !b || typeof b.id !== 'string' || !b.id || typeof b.text !== 'string') ||
      new Set(data.blocks.map(b => b.id)).size !== data.blocks.length) throw new Error('网页正文快照无效，请等待正文加载后重新分析。');
  return data;
}

export function paintReply(data) {
  if (!data || !Array.isArray(data.cssRules) || data.cssRules.some(rule => typeof rule !== 'string') ||
      !Number.isInteger(data.spanCount) || data.spanCount < 0 || !Number.isInteger(data.rangeCount) || data.rangeCount < 0) throw new Error('网页高亮结果不完整，请重新分析。');
  return data;
}

export function resultPage(page, snapshot, contentHash, cursor, partial = false) {
  if (!page || !Array.isArray(page.spans) || page.spans.some(s => !s || typeof s.blockId !== 'string' || !Number.isInteger(s.start) || !Number.isInteger(s.end)) ||
      page.revision !== snapshot.revision || page.contentHash !== contentHash ||
      !(page.nextCursor === null || Number.isInteger(page.nextCursor) && page.nextCursor > cursor) ||
      partial && !(page.completed===true&&page.sequence===null) && (!Number.isInteger(page.sequence) || page.sequence < 1)) throw new Error('分析结果与当前正文不匹配或分页无效，请重新分析。');
  return page;
}
