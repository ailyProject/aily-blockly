/**
 * Markdown Content Store - externalizes large live markdown blocks.
 *
 * The canonical transcript still stores full markdown text. This store is only
 * for the visible streaming projection so Angular and markdown rendering do not
 * receive a growing multi-hundred-KB string on every delta.
 */

import {
  appendToContentBuffer,
  createAppendOnlyContentBuffer,
  materializeContentBuffer,
  readContentBufferWindow,
  type AppendOnlyContentBuffer,
} from './append-only-content-buffer';

const store = new Map<string, AppendOnlyContentBuffer>();

export function storeMarkdownContent(key: string, content: string): void {
  store.set(key, createAppendOnlyContentBuffer(content));
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

  appendToContentBuffer(existing, delta);
}

export function getMarkdownContent(key: string): string {
  const existing = store.get(key);
  return existing ? materializeContentBuffer(existing) : '';
}

export function getMarkdownContentLength(key: string): number {
  return store.get(key)?.length ?? 0;
}

export function getMarkdownContentWindow(key: string, maxChars: number, omittedMarker = ''): string {
  const existing = store.get(key);
  if (!existing) {
    return '';
  }

  return readContentBufferWindow(existing, maxChars, omittedMarker);
}

export function deleteMarkdownContent(key: string): void {
  store.delete(key);
}
