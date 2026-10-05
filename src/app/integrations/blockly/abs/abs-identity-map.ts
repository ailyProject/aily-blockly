import { assertNoOversizedInlineValues } from '@domain/project/public-api';
import { absJson } from './abs-json';
export { absJson } from './abs-json';
import { parseAbsSyntax } from './abs-syntax';
import {
  ABS_PROJECTION_VERSION, AbsAbiWorkspace,
  AbsIdentityMap, AbsProjection, AbsSyntaxNode, AbsSyncError, absInputPath,
  AbsProjectionContracts, absFieldPath,
} from './abs-state';
import { AbsSymbols } from './abs-symbols';
import { getAbsProcedureReferences } from './abs-procedures';
import { indexAbsAbi } from './abs-abi-index';
import { renderAbs } from './abs-renderer';
import { absSyntaxOptions } from './abs-syntax-contracts';
export { indexAbsAbi } from './abs-abi-index';

export interface AbsProjectionContext {
  generation: string;
  baselineRef: string;
  scope: AbsIdentityMap['scope'];
  savedAbiHash: string | null;
  document: unknown;
  contracts?: AbsProjectionContracts;
}

/** Captured by the host, never reconstructed from the edited sidecar. */
export interface AbsBaselineContext {
  generation: string;
  scope: AbsIdentityMap['scope'];
  currentAbiHash: string;
  currentPageAbiHash: string;
  savedAbiHash: string | null;
}

export function assertAbsBaselineContext(map: AbsIdentityMap, current: AbsBaselineContext): void {
  if (map.scope.projectKey !== current.scope.projectKey || map.scope.pageId !== current.scope.pageId) {
    throw new AbsSyncError('ABS_SCOPE_INVALID', 'ABS belongs to a different project or page.');
  }
  if (map.generation !== current.generation || map.baseAbiHash !== current.currentAbiHash
    || map.pageAbiHash !== current.currentPageAbiHash || map.savedAbiHash !== current.savedAbiHash) {
    const changed = [map.generation !== current.generation && 'generation', map.baseAbiHash !== current.currentAbiHash && 'workspace',
      map.pageAbiHash !== current.currentPageAbiHash && 'page', map.savedAbiHash !== current.savedAbiHash && 'saved-abi'].filter(Boolean);
    throw new AbsSyncError('ABS_BASELINE_STALE', 'Project state changed since this ABS projection was prepared.', undefined, [], {
      reason: changed.join(','), hint: 'Use the generation returned by the latest library/board operation. Otherwise refresh the current projection once and preserve any draft; do not reinstall libraries or infer that the user changed blocks.' });
  }
}

export async function hashAbsText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}


export interface AbsSyntaxEntry { path: string; node: AbsSyntaxNode; parent: string | null; slot: string }
export function indexAbsSyntax(roots: AbsSyntaxNode[]): AbsSyntaxEntry[] {
  const entries: AbsSyntaxEntry[] = [];
  const visit = (node: AbsSyntaxNode, path: string, parent: string | null, slot: string) => {
    entries.push({ node, path, parent, slot });
    for (const [name, child] of Object.entries(node.inputs)) {
      if (child) visit(child, absInputPath(path, name), path, name);
    }
    if (node.next) visit(node.next, `${path}/next`, path, '@next');
  };
  roots.forEach((node, index) => visit(node, `/blocks/${index}`, null, '@root'));
  return entries;
}


export async function fingerprintAbsNodes(entries: AbsSyntaxEntry[]): Promise<Map<string, string>> {
  return (await fingerprintAbsNodeGroups([entries]))[0];
}

/** Reuse exact canonical hash inputs only within this pure calculation. Each
 * tree still has its own path index; no persisted fingerprint is trusted here. */
export async function fingerprintAbsNodeGroups(groups: readonly (readonly AbsSyntaxEntry[])[]): Promise<Map<string, string>[]> {
  return fingerprintNodeGroups(groups);
}

/** Owned by one exact baseline/runtime analysis, never shared process-wide.
 * Only complete canonical hash inputs and successful digests are retained.
 * Child fingerprints form the dependency key, so edits invalidate ancestors,
 * not unrelated branches. This is not cached native or validation evidence. */
export function createAbsNodeFingerprinter(): typeof fingerprintAbsNodeGroups {
  const completed = new Map<string, string>();
  const maxEntries = 4096, maxBytes = 4 * 1024 * 1024;
  let bytes = 0;
  return groups => fingerprintNodeGroups(groups, completed, entries => {
    for (const [text, hash] of entries) {
      const size = 2 * (text.length + hash.length);
      if (size > maxBytes || completed.has(text)) continue;
      while (completed.size && (completed.size >= maxEntries || bytes + size > maxBytes)) {
        const key = completed.keys().next().value!;
        bytes -= 2 * (key.length + completed.get(key)!.length); completed.delete(key);
      }
      completed.set(text, hash); bytes += size;
    }
  });
}

async function fingerprintNodeGroups(groups: readonly (readonly AbsSyntaxEntry[])[],
  completed?: ReadonlyMap<string, string>, publish?: (entries: Array<[string, string]>) => void): Promise<Map<string, string>[]> {
  type Work = { entry: AbsSyntaxEntry; inputs: Array<[string, Work | undefined]>; next?: Work; level: number; hash?: string };
  const waves: Work[][] = [], trees: Work[][] = [];
  // Capture traversal/dependencies synchronously. Children and next links must
  // finish before their parent; unrelated subtrees do not need serial awaits.
  for (const entries of groups.map(entries => [...entries])) {
    const paths = new Map<string, Work>(), tree: Work[] = [];
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index], { path, node } = entry;
      const inputs: Work['inputs'] = Object.keys(node.inputs).sort().map(name => [name, paths.get(absInputPath(path, name))]);
      const next = paths.get(`${path}/next`);
      const level = 1 + inputs.reduce((depth, [, child]) => Math.max(depth, child?.level ?? -1), next?.level ?? -1);
      const work: Work = { entry, inputs, next, level };
      paths.set(path, work); tree.push(work); (waves[level] ??= []).push(work);
    }
    trees.push(tree);
  }
  // Invocation-local promises coalesce equal inputs even inside the same wave.
  // Bound outstanding digests; a failed invocation never seeds another cache.
  const hashes = new Map<string, Promise<string>>();
  for (const wave of waves) for (let start = 0; start < wave.length; start += 64) {
    await Promise.all(wave.slice(start, start + 64).map(async work => {
      const { node } = work.entry;
      const text = absJson({ type: node.type,
        fields: Object.fromEntries(Object.entries(node.fields).map(([name, token]) => [name, token.value])),
        inputs: Object.fromEntries(work.inputs.map(([name, child]) => [name, child?.hash ?? null])),
        disabled: node.disabled,
        ...(Object.hasOwn(node, 'extraState') ? { extraState: node.extraState } : {}),
        next: work.next?.hash ?? null,
      });
      const cached = completed?.get(text);
      if (cached !== undefined) { work.hash = cached; return; }
      let hash = hashes.get(text);
      if (!hash) { hash = hashAbsText(text); hashes.set(text, hash); }
      work.hash = await hash;
    }));
  }
  // A failed traversal cannot publish partially computed or pending results.
  if (publish) publish(await Promise.all([...hashes].map(async ([text, hash]): Promise<[string, string]> => [text, await hash])));
  // Preserve the previous reverse-traversal insertion order, not completion order.
  return trees.map(tree => new Map(tree.map(({ entry, hash }) => [entry.path, hash!])));
}

/** Resource preparation and full-project page composition belong to the caller. */
export async function createAbsProjection(workspace: AbsAbiWorkspace, context: AbsProjectionContext): Promise<AbsProjection> {
  return buildAbsProjection(workspace, context, ABS_PROJECTION_VERSION);
}

/** Historical rendering is available for verification only, never as an export API. */
async function buildAbsProjection(workspace: AbsAbiWorkspace, context: AbsProjectionContext, projectionVersion: string): Promise<AbsProjection> {
  context = { ...context, scope: { ...context.scope } };
  indexAbsAbi(workspace);
  assertNoOversizedInlineValues(context.document);
  assertNoOversizedInlineValues(workspace);
  // Freeze the inputs logically before the first await; never hash a newer revision halfway through.
  const documentJson = absJson(context.document);
  const workspaceJson = absJson(workspace);
  const snapshot = JSON.parse(workspaceJson) as AbsAbiWorkspace;
  const document = JSON.parse(documentJson);
  const contractsJson = absJson(context.contracts ?? { fields: {} });
  const contracts: AbsProjectionContracts = JSON.parse(contractsJson);
  const symbols = new AbsSymbols(snapshot, document, contracts);
  const procedureReferences = new Map<string, ReturnType<typeof getAbsProcedureReferences>>();
  for (const reference of getAbsProcedureReferences(snapshot, contracts.procedures)) {
    const group = procedureReferences.get(reference.blockId);
    if (group) group.push(reference); else procedureReferences.set(reference.blockId, [reference]);
  }
  const previous = projectionVersion === 'abs-v2.preview.3';
  const { abs, blockAtPath, symbolAtPath } = renderAbs(snapshot, contracts, symbols, projectionVersion);
  const entries = indexAbsSyntax(parseAbsSyntax(abs, previous ? {} : absSyntaxOptions(snapshot, contracts)));
  const fingerprints = await fingerprintAbsNodes(entries);
  const [baseAbiHash, pageAbiHash, baseAbsHash, contractsHash] = await Promise.all([
    hashAbsText(documentJson), hashAbsText(workspaceJson), hashAbsText(abs), hashAbsText(contractsJson),
  ]);
  return {
    document, workspace: snapshot, abs, contracts,
    map: {
      schemaVersion: 1, absSchemaVersion: 2, projectionVersion,
      generation: context.generation, baselineRef: context.baselineRef, scope: { ...context.scope },
      savedAbiHash: context.savedAbiHash, baseAbiHash, pageAbiHash, baseAbsHash,
      contractsHash,
      symbols: entries.flatMap(({ node, path }, index) => [...Object.keys(node.fields).flatMap(name => {
        const astPath = absFieldPath(path, name);
        const binding = symbolAtPath.get(astPath);
        return binding ? [{ nodeKey: `n${index}`, astPath, ...binding }] : [];
      }), ...(procedureReferences.get(blockAtPath.get(path)!.id) ?? []).map(reference => ({
        nodeKey: `n${index}`, astPath: path + reference.statePath, kind: reference.kind, modelId: reference.modelId,
      }))]),
      nodes: entries.map(({ node, path }, index) => ({
        nodeKey: `n${index}`, blockId: blockAtPath.get(path)!.id, blockType: node.type,
        astPath: path, start: node.start, end: node.end, fingerprint: fingerprints.get(path)!,
      })),
    },
  };
}

/** A sidecar is only an index. Recompute its associations from the retained host snapshot. */
export function assertCurrentAbsProjection(baseline: AbsProjection): void {
  if (baseline.map.projectionVersion !== ABS_PROJECTION_VERSION) {
    throw new AbsSyncError('ABS_PROJECTION_UPGRADE_REQUIRED', 'Inspect and explicitly re-export this previous projection; never apply it with new syntax offsets.');
  }
}

export async function validateAbsProjection(baseline: AbsProjection, allowPreviousForRecovery = false): Promise<void> {
  const version = baseline.map.projectionVersion;
  if (![ABS_PROJECTION_VERSION, 'abs-v2.preview.3', 'abs-v2.preview.4'].includes(version)) {
    throw new AbsSyncError('ABS_PROJECTION_UNSUPPORTED', 'Unsupported immutable projection version.');
  }
  if (!allowPreviousForRecovery) assertCurrentAbsProjection(baseline);
  const expected = await buildAbsProjection(baseline.workspace, {
    ...baseline.map, document: baseline.document, contracts: baseline.contracts,
  }, version);
  if (expected.abs !== baseline.abs || absJson(expected.map) !== absJson(baseline.map)) {
    throw new AbsSyncError('ABS_MAP_INVALID', 'Identity map does not match its immutable baseline.');
  }
}
