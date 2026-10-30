import { isDeferredProjectDataNormalization, type DeferredProjectDataNormalization } from '@domain/project/public-api';
import { AbsBaselineStore, type AbsDiskSnapshot, type AbsSyncStoragePort } from './abs-baseline-store';
import { absJson, hashAbsText } from './abs-identity-map';
import type { AbsProjection } from './abs-state';

export interface AbsLoadNormalizationInput {
  readonly projectPath: string;
  readonly originalContent: string;
  readonly persistedText: string;
  readonly expected: {
    readonly disk: AbsDiskSnapshot;
    readonly pointerHash: string;
    readonly generation: string;
  };
  readonly assertCurrent: () => void;
}
export interface AbsLoadNormalizationDeferred {
  status: 'DEFERRED';
  code: string;
  recovery: {
    tool: 'project_recover';
    arguments: { action: 'inspect'; project: string };
    guidance: string;
  };
}
export type AbsLoadNormalizationOutcome = AbsLoadNormalizationDeferred | {
  status: 'COMMITTED'; abiText: string; generation: string;
};

const preparedLoads = new WeakSet<object>();
const acceptedReadbacks = new WeakMap<object, { revision: number; document: string }>();

/** One native-load acknowledgement, under the loader's original edit lease.
 * Never overwrite it with a later user edit while waiting for the save FIFO. */
export function bindAbsLoadNormalizationReadback(
  input: AbsLoadNormalizationInput, snapshot: { revision: number; document: unknown },
): boolean {
  input.assertCurrent();
  if (!preparedLoads.has(input) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) return false;
  if (acceptedReadbacks.has(input)) return matchesAbsLoadNormalizationReadback(input, snapshot);
  acceptedReadbacks.set(input, { revision: snapshot.revision, document: absJson(snapshot.document) });
  return true;
}

export function matchesAbsLoadNormalizationReadback(
  input: AbsLoadNormalizationInput, snapshot: { revision: number; document: unknown },
): boolean {
  input.assertCurrent();
  const accepted = acceptedReadbacks.get(input);
  return !!accepted && preparedLoads.has(input) && accepted.revision === snapshot.revision
    && accepted.document === absJson(snapshot.document);
}

export function deferredAbsLoadNormalization(project: string, code: string): AbsLoadNormalizationDeferred {
  return { status: 'DEFERRED', code, recovery: { tool: 'project_recover', arguments: { action: 'inspect', project },
    guidance: 'The original ABI, ABS, map and any unapplied draft were retained. Inspect this exact project once; '
      + 'use the current preserving repair or independent fork offered by the tool. Do not delete locks/maps, '
      + 'apply the old draft implicitly or retry unchanged writes.' } };
}

/** Host-only preparation. Neither domain output nor caller-supplied hashes are
 * authority: read the actual three mirrors, pointer and verified save recipe. */
export async function prepareAbsLoadNormalization(
  projectPath: string, normalization: DeferredProjectDataNormalization,
  port: AbsSyncStoragePort, assertCurrent: () => void,
): Promise<{ input?: AbsLoadNormalizationInput; outcome?: AbsLoadNormalizationDeferred }> {
  assertCurrent();
  if (!isDeferredProjectDataNormalization(normalization) || normalization.mode !== 'load'
    || normalization.projectPath !== projectPath) {
    return { outcome: deferredAbsLoadNormalization(projectPath, 'ABS_LOAD_NORMALIZATION_UNVERIFIED') };
  }
  try {
    const store = new AbsBaselineStore(port, { projectKey: projectPath, pageId: '' });
    const disk = await store.captureDisk(); assertCurrent();
    const committed = await store.inspectCommitted(); assertCurrent();
    if (!committed) return { outcome: deferredAbsLoadNormalization(projectPath, 'ABS_LOAD_NORMALIZATION_UNVERIFIED') };
    const input: AbsLoadNormalizationInput = Object.freeze({ projectPath,
      originalContent: normalization.originalContent, persistedText: normalization.persistedText,
      expected: Object.freeze({ disk: Object.freeze({ ...disk }), pointerHash: committed.pointerHash,
        generation: committed.projection.map.generation }), assertCurrent });
    preparedLoads.add(input);
    const proof = await verifyAbsLoadNormalization(store, input, committed.projection.map.scope);
    assertCurrent();
    if (!proof) {
      preparedLoads.delete(input);
      return { outcome: deferredAbsLoadNormalization(projectPath, 'ABS_LOAD_NORMALIZATION_DEFERRED') };
    }
    return { input };
  } catch {
    assertCurrent(); // Cancellation must not be reported as a ready replacement project.
    return { outcome: deferredAbsLoadNormalization(projectPath, 'ABS_LOAD_NORMALIZATION_UNAVAILABLE') };
  }
}

/** Repeat inside the save/ABS FIFO lease immediately before preparing a new
 * journal. Stage/commit still enforce raw three-file and pointer CAS afterwards. */
export async function verifyAbsLoadNormalization(
  store: AbsBaselineStore, input: AbsLoadNormalizationInput,
  scope: AbsProjection['map']['scope'],
): Promise<{ baseline: AbsProjection } | null> {
  input.assertCurrent();
  if (!preparedLoads.has(input) || input.projectPath !== scope.projectKey) return null;
  try {
    if (await store.inspectPending()) return null;
    input.assertCurrent();
    if (absJson(await store.captureDisk()) !== absJson(input.expected.disk)) return null;
    const committed = await store.inspectCommitted(); input.assertCurrent();
    if (!committed || committed.pointerHash !== input.expected.pointerHash
      || committed.projection.map.generation !== input.expected.generation
      || absJson(committed.projection.map.scope) !== absJson(scope)) return null;
    const baseline = committed.projection, expected = input.expected.disk;
    const recipe = await store.readDerivedAbi(baseline.map.generation); input.assertCurrent();
    if (recipe === null || recipe !== input.originalContent || expected.abi !== recipe
      || expected.abs !== baseline.abs || expected.map !== absJson(baseline.map)
      || await hashAbsText(absJson(JSON.parse(recipe))) !== baseline.map.savedAbiHash) return null;
    input.assertCurrent();
    if (absJson(await store.captureDisk()) !== absJson(expected)) return null;
    return { baseline };
  } catch {
    input.assertCurrent();
    return null;
  }
}
