import { decodeAbsMap, absMapJson } from './abs-map-json';
import { AbsSyncError, type AbsProjection, type AbsIdentityMap } from './abs-state';
import { absJson, hashAbsText, validateAbsProjection } from './abs-identity-map';
import type { AbsProjectAttachment, AbsSyncStoragePort } from './abs-baseline-store';
import type { AbsSourceEdit, AbsSourceEdits } from './abs-edit-provenance';
import { composeBlocklyPage } from '../../../editors/blockly-editor/services/blockly-project-model';

export interface WorkingCandidateRef { version: 1; id: string; revisionHash: string }
interface ObjectRef { hash: string; bytes: number }
interface CandidateRecord {
  version: 1; kind: 'agent'; id: string;
  owner: { sessionId: string; intentAnchorId: string };
  project: { logicalId: string; attachment: AbsProjectAttachment };
  scope: { kind: 'project' } | { kind: 'pages'; pageIds: string[] };
  base: { document: ObjectRef; abs: ObjectRef; map: ObjectRef; contracts: ObjectRef; published: unknown };
  source: ObjectRef; parent?: WorkingCandidateRef;
  derivation: { kind: 'capture' } | { kind: 'fork' } | { kind: 'splices'; edits: ObjectRef } | { kind: 'replace'; mapping: 'unresolved' };
  intent: { anchorId: string };
}
const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const rawHash = (v: any): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const fail = (message: string): never => { throw new AbsSyncError('ABS_CANDIDATE_OBJECT_INVALID', message); };
export function assertWorkingCandidateRef(value: any): asserts value is WorkingCandidateRef {
  if (!object(value) || value['version'] !== 1 || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value['id'])
    || !rawHash(value['revisionHash']) || Object.keys(value).some(key => !['version', 'id', 'revisionHash'].includes(key)))
    throw new AbsSyncError('ABS_CANDIDATE_REF_INVALID', 'An exact immutable candidate reference is required.');
}
export async function workingCandidateKey(ref: WorkingCandidateRef) {
  assertWorkingCandidateRef(ref); return hashAbsText(absJson(ref));
}
export async function workingCandidateBinding(baseline: AbsProjection) {
  return { generation: baseline.map.generation, scope: baseline.map.scope, abiHash: baseline.map.baseAbiHash,
    absHash: baseline.map.baseAbsHash, mapHash: await hashAbsText(absMapJson(baseline.map)) };
}
export async function readCandidateObject(ref: ObjectRef, read: (hash: string) => Promise<string | null>): Promise<string> {
  if (!object(ref) || !rawHash(ref.hash) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) fail('Invalid History object reference.');
  const text = await read(ref.hash);
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength !== ref.bytes
    || await hashAbsText(text) !== `sha256:${ref.hash}`) fail('The retained candidate object differs from its exact bytes.');
  return text;
}

/** A piece retains its original UTF-16 interval or new text. This composes the
 * actual edit operations, including equal-text replacements, without a diff. */
export function composeCandidateSplices(base: string, batches: AbsSourceEdits, expected: string): AbsSourceEdits | undefined {
  type Piece = { start: number; end: number } | { text: string };
  let pieces: Piece[] = [{ start: 0, end: base.length }];
  const length = (p: Piece) => 'text' in p ? p.text.length : p.end - p.start;
  const slice = (from: number, to: number): Piece[] => {
    const result: Piece[] = []; let offset = 0;
    for (const p of pieces) {
      const size = length(p), left = Math.max(from - offset, 0), right = Math.min(to - offset, size);
      if (right > left) result.push('text' in p ? { text: p.text.slice(left, right) } : { start: p.start + left, end: p.start + right });
      offset += size; if (offset >= to) break;
    }
    return result;
  };
  for (const batch of batches) {
    const size = pieces.reduce((total, p) => total + length(p), 0);
    let end = -1;
    for (const edit of batch) {
      if (!object(edit) || !Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < 0
        || edit.start <= end || edit.end < edit.start || edit.end > size || typeof edit.text !== 'string') fail('Invalid candidate splice relationship.');
      end = edit.end;
    }
    // All offsets in a batch refer to the same original parent. Build against
    // that snapshot once; applying reverse edits with an old end truncates tails.
    const nextPieces: Piece[] = []; let cursor = 0;
    for (const edit of batch) {
      nextPieces.push(...slice(cursor, edit.start));
      if (edit.text) nextPieces.push({ text: edit.text });
      cursor = edit.end;
    }
    nextPieces.push(...slice(cursor, size)); pieces = nextPieces;
  }
  if (pieces.map(p => 'text' in p ? p.text : base.slice(p.start, p.end)).join('') !== expected) fail('Candidate edits do not produce their exact source.');
  const edits: AbsSourceEdit[] = []; let cursor = 0, inserted = '';
  for (const p of pieces) {
    if ('text' in p) { inserted += p.text; continue; }
    if (p.start !== cursor || inserted) edits.push({ start: cursor, end: p.start, text: inserted });
    cursor = p.end; inserted = '';
  }
  if (cursor !== base.length || inserted) edits.push({ start: cursor, end: base.length, text: inserted });
  return edits.length ? [edits] : undefined;
}

/** Exact refs only. Workspace heads, paths, and matching bodies never select a
 * revision here. Session/branch admission belongs to the SDK before dispatch. */
export async function readWorkingCandidate(ref: WorkingCandidateRef, port: AbsSyncStoragePort, scope: AbsIdentityMap['scope'], source: string) {
  assertWorkingCandidateRef(ref);
  const read = (hash: string) => port.read(`history-objects/${hash}`);
  const seen = new Set<string>(), chain: CandidateRecord[] = [];
  let next: WorkingCandidateRef | undefined = ref;
  while (next) {
    if (seen.has(next.revisionHash)) fail('Candidate ancestry contains a cycle.');
    seen.add(next.revisionHash);
    const raw = await read(next.revisionHash);
    if (raw === null || await hashAbsText(raw) !== `sha256:${next.revisionHash}`) fail('Candidate revision is missing or corrupt.');
    let record: CandidateRecord;
    try { record = JSON.parse(raw); } catch { return fail('Candidate revision is not JSON.'); }
    if (record.version !== 1 || record.kind !== 'agent' || record.id !== next.id || !object(record.base)
      || !object(record.owner) || !record.owner.sessionId || !record.owner.intentAnchorId
      || record.intent?.anchorId !== record.owner.intentAnchorId || !object(record.project)
      || !record.project.logicalId || !object(record.scope) || !['pages', 'project'].includes(record.scope.kind)
      || record.scope.kind === 'pages' && (!Array.isArray(record.scope.pageIds) || !record.scope.pageIds.length)) fail('Invalid candidate identity or page scope.');
    if (!port.attachment || absJson(record.project.attachment) !== absJson(port.attachment))
      throw new AbsSyncError('ABS_CANDIDATE_ATTACHMENT_STALE', 'The candidate belongs to a different physical project.');
    if (record.project.logicalId !== (await hashAbsText(port.attachment.root)).slice(7)) fail('Candidate logical workspace does not match its physical project.');
    if (chain.length && ['base', 'project', 'scope', 'intent'].some(key => absJson((record as any)[key]) !== absJson((chain[0] as any)[key]))) fail('Candidate ancestry changed its frozen base or intent.');
    const child = chain[chain.length - 1];
    if (child && child.derivation.kind !== 'fork'
      && (record.id !== child.id || absJson(record.owner) !== absJson(child.owner))) fail('Candidate ancestry changed its owner without an explicit fork.');
    if (child?.derivation.kind === 'fork' && (child.id === record.id || absJson(child.source) !== absJson(record.source))) fail('Candidate fork must inherit the exact parent source under a new identity.');
    chain.push(record);
    if (record.parent) {
      assertWorkingCandidateRef(record.parent);
      if (record.derivation.kind !== 'fork' && record.parent.id !== record.id) fail('Candidate parent has a different identity.');
    }
    next = record.parent;
  }
  chain.reverse();
  const record = chain[chain.length - 1];
  const [documentText, baseAbs, mapText, contractsText] = await Promise.all([
    readCandidateObject(record.base.document, read), readCandidateObject(record.base.abs, read),
    readCandidateObject(record.base.map, read), readCandidateObject(record.base.contracts, read),
  ]);
  if (chain[0].derivation?.kind !== 'capture' || chain[0].parent) fail('Candidate capture differs from its exact revision.');
  let exact = true; const batches: AbsSourceEdits = [];
  let previous = baseAbs;
  // Bounded prefetch avoids retaining every full source body in a long chain.
  // The immutable records stay small; exact replay still checks every edge.
  for (let offset = 0; offset < chain.length; offset += 4) {
    const bodies = await Promise.all(chain.slice(offset, offset + 4).map(item => readCandidateObject(item.source, read)));
    for (let at = 0; at < bodies.length; at++) {
      const index = offset + at, item = chain[index], body = bodies[at];
      if (!index) { if (body !== baseAbs) fail('Candidate capture source differs from its frozen base.'); }
      else if (item.derivation?.kind === 'fork') { if (body !== previous) fail('Fork source differs from its original revision.'); }
      else if (item.derivation?.kind === 'replace' && item.derivation.mapping === 'unresolved') exact = false;
      else {
        if (item.derivation?.kind !== 'splices') return fail('Invalid candidate ancestry derivation.');
        const edits = JSON.parse(await readCandidateObject(item.derivation.edits, read));
        composeCandidateSplices(previous, [edits], body); batches.push(edits);
      }
      previous = body;
    }
  }
  if (previous !== source) fail('Submitted source differs from its exact revision.');
  let document: any, map: any, contracts: any;
  try { document = JSON.parse(documentText); map = decodeAbsMap(JSON.parse(mapText)); contracts = JSON.parse(contractsText); }
  catch { return fail('Frozen candidate projection is not JSON.'); }
  if (map.scope?.projectKey !== scope.projectKey || typeof map.scope?.pageId !== 'string'
    || record.scope.kind === 'pages' && !record.scope.pageIds.includes(map.scope.pageId)) fail('Frozen candidate projection belongs to another project/page.');
  const baseline: AbsProjection = { document, workspace: composeBlocklyPage(document, map.scope.pageId), abs: baseAbs, map, contracts };
  await validateAbsProjection(baseline);
  return { ref, record, baseline, sourceHashes: new Set(chain.map(item => `sha256:${item.source.hash}`)),
    sourceEdits: exact ? composeCandidateSplices(baseAbs, batches, source) : undefined };
}
