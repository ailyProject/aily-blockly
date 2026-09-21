import { BlocklyProjectDocument, composeBlocklyPage } from '../../../editors/blockly-editor/services/blockly-project-model';
import { AbsProjectionContracts, AbsSyncError, getAbsFieldDefinition } from './abs-state';
import { absJson, indexAbsAbi } from './abs-identity-map';
import { AbsSymbols } from './abs-symbols';
import { getAbsProcedureReferences } from './abs-procedures';

/** Host assertion of complete model-reference coverage, never inferred from {id,name} payloads. */
export interface AbsPageReferenceContract {
  complete: true;
  blockTypes: Readonly<Record<string, string>>;
  /** Instance-derived contracts may only be reused for this exact serialized block state. */
  blockStates?: Readonly<Record<string, string>>;
  /** Host-verified opaque serializers with no model references; referenced serializers need an adapter. */
  serializers: readonly string[];
  contracts: AbsProjectionContracts;
}

/** Validate unchanged pages before a shared-model edit can reach library callbacks. */
export function assertAbsProjectSharedChange(
  before: BlocklyProjectDocument, after: BlocklyProjectDocument, targetPageId: string,
  pages: Readonly<Record<string, AbsPageReferenceContract>> = {},
): void {
  const shared = (document: BlocklyProjectDocument) => ({
    ...document.sharedModel,
    variables: (document.sharedModel.variables ?? []).map(model => ({ ...model, type: model.type ?? '' }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  if (absJson(shared(before)) === absJson(shared(after))) return;
  for (const page of before.pages) {
    if (page.id === targetPageId) continue;
    const current = after.pages.find(candidate => candidate.id === page.id);
    if (!current || absJson(current.content) !== absJson(page.content)) {
      throw new AbsSyncError('ABS_PAGE_SCOPE_CHANGED', 'A target-page edit cannot rewrite another page.');
    }
    // Even an empty page may contain custom model references in a workspace serializer.
    const payloadKeys = Object.keys(page.content).filter(key => key !== 'blocks');
    if (!page.content.blocks?.blocks?.length && !payloadKeys.length) continue;
    const coverage = Object.hasOwn(pages, page.id) ? pages[page.id] : undefined;
    if (!coverage?.complete) throw new AbsSyncError('ABS_SHARED_CONTRACT_REQUIRED',
      `Shared state changed, but page ${page.id} has no complete reference contract. Existing project was retained.`);
    const references = (document: BlocklyProjectDocument) => {
      const workspace = composeBlocklyPage(document, page.id);
      const blocks = indexAbsAbi(workspace);
      const symbols = new AbsSymbols(workspace, document, coverage.contracts);
      for (const key of Object.keys(workspace)) {
        if (key !== 'blocks' && key !== 'variables' && !coverage.serializers.includes(key)) {
          throw new AbsSyncError('ABS_SHARED_CONTRACT_REQUIRED', `Uncovered workspace serializer ${key} on page ${page.id}.`);
        }
      }
      const refs = new Map<string, string>();
      for (const [id, block] of blocks) {
        if (!Object.hasOwn(coverage.blockTypes, id) || coverage.blockTypes[id] !== block.type) {
          throw new AbsSyncError('ABS_SHARED_CONTRACT_REQUIRED', 'A shared or page block has no matching reference contract.', undefined, [id]);
        }
        if (coverage.blockStates && coverage.blockStates[id] !== absJson(block)) {
          throw new AbsSyncError('ABS_SHARED_CONTRACT_REQUIRED', 'A changed block requires a fresh instance reference contract.', undefined, [id]);
        }
        for (const [name, value] of Object.entries(block.fields ?? {})) {
          const field = getAbsFieldDefinition(coverage.contracts, id, name);
          if (!field) throw new AbsSyncError('ABS_SHARED_CONTRACT_REQUIRED', 'A field has no reference contract.', undefined, [id]);
          if (field.symbol) refs.set(JSON.stringify([id, 'field', name]), symbols.project(value, field.symbol).modelId);
        }
      }
      for (const ref of getAbsProcedureReferences(workspace, coverage.contracts.procedures)) {
        refs.set(JSON.stringify([ref.blockId, ref.kind, ref.statePath]), ref.modelId);
      }
      return refs;
    };
    const original = references(before);
    const next = references(after);
    const localIds = indexAbsAbi(page.content);
    for (const [key, modelId] of original) {
      if (localIds.has(JSON.parse(key)[0]) && next.get(key) !== modelId) {
        throw new AbsSyncError('ABS_SHARED_REFERENCE_CHANGED', 'An unchanged page reference would silently target a different model.');
      }
    }
  }
}
