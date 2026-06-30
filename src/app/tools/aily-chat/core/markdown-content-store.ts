/**
 * Markdown Content Store - externalizes large live markdown blocks.
 *
 * The canonical transcript still stores full markdown text. This store is only
 * for the visible streaming projection so Angular and markdown rendering do not
 * receive a growing multi-hundred-KB string on every delta.
 */

interface StoredContent {
  chunks: string[];
  length: number;
}

const store = new Map<string, StoredContent>();

export function storeMarkdownContent(key: string, content: string): void {
  store.set(key, {
    chunks: content ? [content] : [],
    length: content.length,
  });
}

export function appendMarkdownContent(key: string, delta: string): void {
  if (!delta) {
    return;
  }

  const existing = store.get(key);
  if (!existing) {
    storeMarkdownContent(key, delta);
    return;
  }

  existing.chunks.push(delta);
  existing.length += delta.length;
}

export function getMarkdownContent(key: string): string {
  const existing = store.get(key);
  return existing ? existing.chunks.join('') : '';
}

export function getMarkdownContentLength(key: string): number {
  return store.get(key)?.length ?? 0;
}

export function getMarkdownContentWindow(key: string, maxChars: number, omittedMarker = ''): string {
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

export function deleteMarkdownContent(key: string): void {
  store.delete(key);
}
