/**
 * Think Content Store — 外部化思考块内容
 *
 * 核心优化：避免在 markdown 代码块中嵌入大量 base64 内容。
 *
 * 之前：filterThinkTags 将 think 内容 btoa(encodeURIComponent(raw))，
 * 嵌入到 aily-think 代码块（~40KB/block）→ x-markdown parser.parse() 逐字符处理全部内容。
 * 10 个 think 块 × 40KB = 400KB 给 marked.js 处理，每帧 300-800ms。
 *
 * 现在：think 内容存入此 Map（key → raw text），
 * aily-think 代码块仅嵌入 ~80 byte 的引用 JSON。
 * x-markdown 只需解析 <10KB 的 markdown，每帧 <50ms。
 */

interface StoredContent {
  chunks: string[];
  length: number;
}

const store = new Map<string, StoredContent>();

export function storeThinkContent(key: string, content: string): void {
  store.set(key, {
    chunks: content ? [content] : [],
    length: content.length,
  });
}

export function appendThinkContent(key: string, delta: string): void {
  if (!delta) {
    return;
  }

  const existing = store.get(key);
  if (!existing) {
    storeThinkContent(key, delta);
    return;
  }

  existing.chunks.push(delta);
  existing.length += delta.length;
}

export function getThinkContent(key: string): string {
  const existing = store.get(key);
  return existing ? existing.chunks.join('') : '';
}

export function getThinkContentLength(key: string): number {
  return store.get(key)?.length ?? 0;
}

export function getThinkContentWindow(key: string, maxChars: number, omittedMarker = ''): string {
  const existing = store.get(key);
  if (!existing) {
    return '';
  }

  if (!Number.isFinite(maxChars) || maxChars <= 0 || existing.length <= maxChars) {
    return existing.chunks.join('');
  }

  const tailLength = Math.max(0, Math.floor(maxChars) - omittedMarker.length);
  if (tailLength <= 0) {
    return omittedMarker;
  }

  const segments: string[] = [];
  let remaining = tailLength;
  for (let index = existing.chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = existing.chunks[index] || '';
    if (chunk.length <= remaining) {
      segments.push(chunk);
      remaining -= chunk.length;
    } else {
      segments.push(chunk.slice(chunk.length - remaining));
      remaining = 0;
    }
  }

  segments.reverse();
  return `${omittedMarker}${segments.join('')}`;
}

export function deleteThinkContent(key: string): void {
  store.delete(key);
}
