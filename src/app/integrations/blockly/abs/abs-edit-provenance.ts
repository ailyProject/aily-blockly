import { AbsSyncError, type AbsSyntaxNode } from './abs-state';
import { indexAbsSyntax } from './abs-identity-map';

/** UTF-16 text splices captured by the edit tool, never block IDs or ABS metadata. */
export interface AbsSourceEdit { start: number; end: number; text: string }
export type AbsSourceEdits = AbsSourceEdit[][];
/** Host-only coordinate origin for an exact accepted author input. */
export interface AbsSourceEditOrigin {
  source: string;
  anchors: Array<{ originalStart: number; start: number; end: number }>;
}

function assertAbsSourceEditRanges(value: unknown): asserts value is AbsSourceEdits | undefined {
  if (value === undefined) return;
  const invalid = () => { throw new AbsSyncError('ABS_SOURCE_EDITS_INVALID', 'Invalid ABS edit relationship.'); };
  if (!Array.isArray(value) || !value.length) return invalid();
  for (const batch of value) {
    if (!Array.isArray(batch) || !batch.length) return invalid();
    let previousEnd = -1;
    for (const edit of batch) {
      if (!edit || !Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end)
        || edit.start < 0 || edit.end < edit.start || edit.start <= previousEnd || typeof edit.text !== 'string') return invalid();
      previousEnd = edit.end;
    }
  }
}

/** Legacy transport admission, before any candidate/file/runtime work. These
 * payload limits are not identity rules for a verified immutable History chain. */
export function assertAbsSourceEdits(value: unknown): asserts value is AbsSourceEdits | undefined {
  assertAbsSourceEditRanges(value);
  if (value === undefined) return;
  const invalid = () => { throw new AbsSyncError('ABS_SOURCE_EDITS_INVALID', 'Invalid or excessive ABS edit history.'); };
  if (value.length > 128) return invalid();
  let count = 0, bytes = 0;
  for (const batch of value) for (const edit of batch) {
    bytes += new TextEncoder().encode(edit.text).byteLength;
    if (++count > 1024 || bytes > 512 * 1024) return invalid();
  }
}

function removesStandaloneCall(source: string, edit: AbsSourceEdit, start: number, end: number): boolean {
  if (edit.text || edit.start > start || edit.end < end) return false;
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const newline = source.indexOf('\n', start);
  const lineEnd = newline < 0 ? source.length : newline + 1;
  return edit.start >= lineStart && edit.end <= lineEnd && /^[ \t]*$/.test(source.slice(lineStart, start));
}

/** Only unchanged call tokens (or verified literal tokens) carry identity. Diagnostics share the same
 * exact replay used for matching, not a second heuristic. */
export function inspectAbsSourceEdits(before: string, after: string, original: AbsSyntaxNode[], edited: AbsSyntaxNode[],
  batches?: AbsSourceEdits, origin?: AbsSourceEditOrigin) {
  // Fixed CandidateRefs are checksum/byte-bound and replayed by the Host reader;
  // old external proofs already passed bounded wire admission. Both use these
  // same range, token-identity and complete replay checks.
  assertAbsSourceEditRanges(batches);
  const matches = new Map<AbsSyntaxNode, AbsSyntaxNode>();
  const replaced = new Set<AbsSyntaxNode>();
  const deleted = new Set<AbsSyntaxNode>();
  if (!batches && !origin) return { matches, replaced, deleted };
  let source = origin?.source ?? before;
  const authored = origin && new Map(origin.anchors.map(anchor => [anchor.originalStart, anchor]));
  const anchors = indexAbsSyntax(original).flatMap(({ node }) => {
    const end = node.start + node.type.length;
    const range = authored ? authored.get(node.start)
      : before.slice(node.start, end) === node.type ? { start: node.start, end } : undefined;
    if (!range) return [];
    // Alias and shorthand origins only prove the old token. A complete call
    // range is usable when it is unchanged from the canonical source.
    const callEnd = !origin || source.startsWith(before.slice(node.start, node.end), range.start)
      ? range.start + node.end - node.start : undefined;
    return [{ node, start: range.start, end: range.end, callEnd, alive: true }];
  });
  for (const batch of batches ?? []) {
    if (batch.some(edit => edit.end > source.length)) throw new AbsSyncError('ABS_SOURCE_EDITS_INVALID', 'ABS edit range exceeds its source.');
    for (const anchor of anchors) {
      if (!anchor.alive) continue;
      let shift = 0;
      let callShift = 0;
      for (const edit of batch) {
        const delta = edit.text.length - (edit.end - edit.start);
        if (edit.end <= anchor.start) shift += delta;
        else if (edit.start < anchor.end) {
          anchor.alive = false;
          replaced.add(anchor.node);
          if (anchor.callEnd !== undefined && removesStandaloneCall(source, edit, anchor.start, anchor.callEnd)) {
            deleted.add(anchor.node);
          }
          break;
        } else if (anchor.callEnd !== undefined && edit.start < anchor.callEnd) {
          if (edit.end > anchor.callEnd) anchor.callEnd = undefined;
          else callShift += delta;
        }
      }
      anchor.start += shift; anchor.end += shift;
      if (anchor.callEnd !== undefined) anchor.callEnd += shift + callShift;
    }
    for (const edit of [...batch].reverse()) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  if (source !== after) throw new AbsSyncError('ABS_SOURCE_EDITS_STALE', 'Recorded ABS edits do not produce the exact candidate from its generation.');
  const byStart = new Map(indexAbsSyntax(edited).map(({ node }) => [node.start, node]));
  for (const anchor of anchors) {
    const node = anchor.alive && byStart.get(anchor.start);
    if (node && node.type === anchor.node.type) matches.set(node, anchor.node);
  }
  return { matches, replaced, deleted };
}
