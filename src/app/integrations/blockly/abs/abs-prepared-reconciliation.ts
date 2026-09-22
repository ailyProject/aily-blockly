import { createAilyProjectDataValue } from '@domain/project/public-api';
import { AbsProjection } from './abs-state';
import { AbsReconcileDraft, AbsReconcileOptions, reconcileAbsDraft } from './abs-reconciler';
import { AbsProjectDataPort, prepareAbsProjectData } from './abs-project-data';
import { replaceAbsBoundValues } from './abs-source-edits';
import { assertAbsResourceContracts } from './abs-resource-contracts';

/** v2 preparation, not a commit. No Blockly instance, ABI/ABS/map write or clean revision. */
export async function prepareAbsReconciliation(
  baseline: AbsProjection, source: string, assertCurrent: () => void,
  options: AbsReconcileOptions = {}, runtime?: AbsProjectDataPort,
) {
  assertCurrent();
  const draft = await reconcileAbsDraft(baseline, source, options);
  return prepareAbsReconciledResources(source, draft, assertCurrent, runtime);
}

/** Static and native paths converge before resource externalization and publication. */
export async function prepareAbsReconciledResources(source: string, draft: AbsReconcileDraft,
  assertCurrent: () => void, runtime?: AbsProjectDataPort) {
  assertCurrent();
  const resources = await prepareAbsProjectData(draft.workspace, assertCurrent, runtime);
  assertAbsResourceContracts(draft.workspace, resources.document, draft.contracts);
  // Native defaults have no source literal to replace. Reuse payload traversal's
  // block identity; only newly admitted trees are exempt, never user call values.
  const implicit = new Set(draft.implicitBlockIds ?? []);
  const abs = replaceAbsBoundValues(source, draft.workspace, draft.literals,
    resources.externalized.filter(entry => !entry.blockId || !implicit.has(entry.blockId))
      .map(entry => ({ jsonPointer: entry.jsonPointer, value: createAilyProjectDataValue(entry.ref) })));
  assertCurrent();
  return {
    workspace: resources.document, abs, inputAbs: source, retained: draft.retained, added: draft.added, removed: draft.removed,
    contracts: draft.contracts, identities: draft.identities, retiredModels: draft.retiredModels ?? [],
    externalized: resources.externalized,
    materialize: resources.materialize,
  };
}
