import { AbsSyncError, type AbsSyntaxNode } from './abs-state';
import { indexAbsSyntax } from './abs-identity-map';

/** UTF-16 text splices captured by the edit tool, never block IDs or ABS metadata. */
export interface AbsSourceEdit { start: number; end: number; text: string }
export type AbsSourceEdits = AbsSourceEdit[][];

export function assertAbsSourceEdits(value: unknown): asserts value is AbsSourceEdits | undefined {
  if (value === undefined) return;
  const invalid = () => { throw new AbsSyncError('ABS_SOURCE_EDITS_INVALID', 'Invalid or excessive ABS edit history.'); };
  if (!Array.isArray(value) || !value.length || value.length > 128) return invalid();
  let count = 0, bytes = 0;
  for (const batch of value) {
    if (!Array.isArray(batch) || !batch.length) return invalid();
    let previousEnd = -1;
    for (const edit of batch) {
      if (!edit || !Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end)
        || edit.start < 0 || edit.end < edit.start || edit.start <= previousEnd || typeof edit.text !== 'string') return invalid();
      previousEnd = edit.end;
      bytes += new TextEncoder().encode(edit.text).byteLength;
      if (++count > 1024 || bytes > 512 * 1024) return invalid();
    }
  }
}

/** Only unchanged call-name tokens carry identity. Diagnostics share the same
 * exact replay used for matching, not a second heuristic. */
export function inspectAbsSourceEdits(before: string, after: string, original: AbsSyntaxNode[], edited: AbsSyntaxNode[],
  batches?: AbsSourceEdits) {
  assertAbsSourceEdits(batches);
  const matches = new Map<AbsSyntaxNode, AbsSyntaxNode>();
  const replaced = new Set<AbsSyntaxNode>();
  if (!batches) return { matches, replaced };
  const anchors = indexAbsSyntax(original).filter(({ node }) => before.slice(node.start, node.start + node.type.length) === node.type)
    .map(({ node }) => ({ node, start: node.start, end: node.start + node.type.length, alive: true }));
  let source = before;
  for (const batch of batches) {
    if (batch.some(edit => edit.end > source.length)) throw new AbsSyncError('ABS_SOURCE_EDITS_INVALID', 'ABS edit range exceeds its source.');
    for (const anchor of anchors) {
      if (!anchor.alive) continue;
      let shift = 0;
      for (const edit of batch) {
        if (edit.end <= anchor.start) shift += edit.text.length - (edit.end - edit.start);
        else if (edit.start < anchor.end) { anchor.alive = false; replaced.add(anchor.node); break; }
      }
      anchor.start += shift; anchor.end += shift;
    }
    for (const edit of [...batch].reverse()) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  if (source !== after) throw new AbsSyncError('ABS_SOURCE_EDITS_STALE', 'Recorded ABS edits do not produce the exact candidate from its generation.');
  const byStart = new Map(indexAbsSyntax(edited).map(({ node }) => [node.start, node]));
  for (const anchor of anchors) {
    const node = anchor.alive && byStart.get(anchor.start);
    if (node && node.type === anchor.node.type) matches.set(node, anchor.node);
  }
  return { matches, replaced };
}
