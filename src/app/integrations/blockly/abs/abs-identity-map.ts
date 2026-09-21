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
    throw new AbsSyncError('ABS_BASELINE_STALE', 'Project state changed since this ABS projection was prepared.');
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
  const result = new Map<string, string>();
  for (const { path, node } of [...entries].reverse()) {
    const fields = Object.fromEntries(Object.entries(node.fields).map(([key, token]) => [key, token.value]));
    const inputs = Object.fromEntries(Object.keys(node.inputs).sort().map(name => [name, result.get(absInputPath(path, name)) ?? null]));
    result.set(path, await hashAbsText(absJson({
      type: node.type, fields, inputs, disabled: node.disabled,
      ...(Object.hasOwn(node, 'extraState') ? { extraState: node.extraState } : {}),
      next: result.get(`${path}/next`) ?? null,
    })));
  }
  return result;
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
