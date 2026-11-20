import { decodeAbsMap, absMapJson } from './abs-map-json';
import { AbsSyncError, type AbsProjection, type AbsIdentityMap } from './abs-state';
import { absJson, hashAbsText, validateAbsProjection } from './abs-identity-map';
import type { AbsBaselineStore, AbsProjectAttachment, AbsSyncStoragePort } from './abs-baseline-store';
import type { AbsSourceEdit, AbsSourceEdits } from './abs-edit-provenance';
import { composeBlocklyPage } from '../../../editors/blockly-editor/services/blockly-project-model';
import { splitAbsState } from './abs-full-state';
import { assertAbsContractsCompatible } from './abs-contract-compatibility';
import { acceptedInputFormattingEdits } from './abs-accepted-input-edits';

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
export async function readWorkingCandidate(ref: WorkingCandidateRef, port: AbsSyncStoragePort, scope: AbsIdentityMap['scope'], source: string,
  originStore?: Pick<AbsBaselineStore, 'loadIntent' | 'readDerivedAbi' | 'inspectCommittedAncestor' | 'readAcceptedAuthorInput'>,
  proveAcceptedInput: typeof acceptedInputFormattingEdits = acceptedInputFormattingEdits) {
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
  let document: any, map: any, contracts: any;
  try { document = JSON.parse(documentText); map = decodeAbsMap(JSON.parse(mapText)); contracts = JSON.parse(contractsText); }
  catch { return fail('Frozen candidate projection is not JSON.'); }
  if (map.scope?.projectKey !== scope.projectKey || typeof map.scope?.pageId !== 'string'
    || record.scope.kind === 'pages' && !record.scope.pageIds.includes(map.scope.pageId)) fail('Frozen candidate projection belongs to another project/page.');
  const baseline: AbsProjection = { document, workspace: composeBlocklyPage(document, map.scope.pageId), abs: baseAbs, map, contracts };
  await validateAbsProjection(baseline);
  const sourceState = splitAbsState(source).state, baseState = splitAbsState(baseAbs).state;
  const needsOrigin = sourceState !== null && sourceState !== baseState || chain.some(item => item.derivation.kind === 'replace');
  const stateOrigin = needsOrigin ? await readPublishedStateOrigin(record.base.published, baseline, source, originStore) : undefined;
  const readonlyStateOrigin = stateOrigin?.source;
  const allowedStates = [splitAbsState(baseAbs).state,
    ...(readonlyStateOrigin === undefined ? [] : [splitAbsState(readonlyStateOrigin).state])];
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
      else if (item.derivation?.kind === 'replace' && item.derivation.mapping === 'unresolved') {
        const bridge = exact ? readonlyStateReplacement(previous, body, allowedStates)
          ?? (previous === baseAbs && body === stateOrigin?.acceptedInput ? proveAcceptedInput(baseline, body) : undefined) : undefined;
        if (bridge) { composeCandidateSplices(previous, [bridge], body); batches.push(bridge); }
        else if (body !== previous) exact = false;
      }
      else {
        if (item.derivation?.kind !== 'splices') return fail('Invalid candidate ancestry derivation.');
        const edits = JSON.parse(await readCandidateObject(item.derivation.edits, read));
        composeCandidateSplices(previous, [edits], body); batches.push(edits);
      }
      previous = body;
    }
  }
  if (previous !== source) fail('Submitted source differs from its exact revision.');
  return { ref, record, baseline, sourceHashes: new Set(chain.map(item => `sha256:${item.source.hash}`)),
    sourceEdits: exact ? composeCandidateSplices(baseAbs, batches, source) : undefined,
    ...(readonlyStateOrigin !== undefined ? { readonlyStateOrigin } : {}) };
}

/** A verified state reserialization changes no readable program bytes. Preserve
 * its exact edit interval before composing subsequent genuine Pi edits; a
 * replacement with any program change remains unresolved. */
function readonlyStateReplacement(before: string, after: string, allowed: Array<string | null>): AbsSourceEdit[] | undefined {
  const next = splitAbsState(after);
  if (next.state === null || !allowed.includes(next.state) || splitAbsState(before).program !== next.program) return undefined;
  const marker = '\n# @project-state:', at = before.indexOf(marker);
  if (at < 0 || after.indexOf(marker) !== at) return undefined;
  const start = at + marker.length, previousEnd = before.indexOf('\n', start), nextEnd = after.indexOf('\n', start);
  return [{ start, end: previousEnd < 0 ? before.length : previousEnd,
    text: after.slice(start, nextEnd < 0 ? after.length : nextEnd) }];
}

/** A previous host snapshot can explain an untouched state section after a
 * fresh export changes compatible runtime contracts. It never replaces the
 * frozen Working document or grants authority to arbitrary parent sources. */
async function readPublishedStateOrigin(published: unknown, baseline: AbsProjection, source: string,
  store?: Pick<AbsBaselineStore, 'loadIntent' | 'readDerivedAbi' | 'inspectCommittedAncestor' | 'readAcceptedAuthorInput'>): Promise<{ source?: string; acceptedInput?: string } | undefined> {
  const state = splitAbsState(source).state, fresh = splitAbsState(baseline.abs).state;
  if (!store || !object(published)
    || typeof published['generation'] !== 'string' || absJson(published['scope']) !== absJson(baseline.map.scope)) return undefined;
  let original: AbsProjection, abi: string | null;
  try {
    original = await store.loadIntent(published['generation']);
    abi = await store.readDerivedAbi(published['generation']);
  } catch (error) {
    if (error instanceof AbsSyncError && ['ABS_BASELINE_MISSING', 'ABS_SCOPE_INVALID'].includes(error.code)) return undefined;
    throw error;
  }
  const binding = { generation: original.map.generation, scope: original.map.scope,
    abiHash: abi === null ? null : await hashAbsText(abi), absHash: original.map.baseAbsHash,
    mapHash: await hashAbsText(absMapJson(original.map)) };
  if (absJson(binding) !== absJson(published)) return undefined;
  const accepted = await store.inspectCommittedAncestor(published['generation']);
  if (!accepted || accepted.projection.abs !== original.abs || accepted.abi !== abi) return undefined;
  const input = await store.readAcceptedAuthorInput(published['generation']);
  const provenance = input === null ? undefined : { acceptedInput: input };
  // Formatting provenance is independent of whether the candidate needs a
  // readonly-state exception (including a valid source with no state section).
  if (state === null || state === fresh || fresh === null) return provenance;
  if (state !== splitAbsState(original.abs).state) {
    // A successful prior apply may retain raw B while publishing normalized C.
    // Only C's own verified accepted input can explain B's unchanged state;
    // neither a parent replacement nor another historical input is authority.
    return input !== null && state === splitAbsState(input).state ? { source: input, ...provenance } : provenance;
  }
  const { contracts: _oldContracts, ...oldState } = JSON.parse(state);
  const { contracts: _freshContracts, ...freshState } = JSON.parse(fresh);
  if (absJson(oldState) !== absJson(freshState)) return provenance;
  assertAbsContractsCompatible(original.contracts, baseline.contracts, baseline.workspace);
  return { source: original.abs, ...provenance };
}
