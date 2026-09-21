import { Injectable } from '@angular/core';
import { assertAbsProcedureModelIntents } from './abs-procedure-model-intents';
import { BlocklyService, BlocklyProjectDocument } from '../../../editors/blockly-editor/services/blockly.service';
import { _ProjectService } from '../../../editors/blockly-editor/services/project.service';
import { BlocklyWorkspaceEditLease } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';
import { composeBlocklyPage } from '../../../editors/blockly-editor/services/blockly-project-model';
import { getActiveProjectGenerator, getActiveProjectGeneratorRevision } from '../../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { projectDataRuntime } from '@domain/project/public-api';
import { assertAbsContractsCompatible } from './abs-contract-compatibility';
import { inspectAbsDraft, AbsDraftReadiness } from './abs-draft-readiness';
import { retainAbsRootLayout, sameAbsProgram } from './abs-program-state';
import { AbsBaselineStore, AbsDiskSnapshot, AbsPublishResult, absBaselineKey } from './abs-baseline-store';
import { openAbsHostStorage } from './abs-host-storage';
import { absJson, assertAbsBaselineContext, createAbsProjection, hashAbsText } from './abs-identity-map';
import { AbsProjection, AbsProjectionContracts, AbsSyncError } from './abs-state';
import { prepareAbsProjectData } from './abs-project-data';
import { prepareAbsReconciliation } from './abs-prepared-reconciliation';
import { assertAbsResourceContracts } from './abs-resource-contracts';
import { assertAbsReadback } from './abs-readback';
import { AbsWorkspaceLoadOptions, assertAbsProjectEnvelope, assertAbsRuntimeShapeSupported, captureAbsWorkspaceState, loadAbsWorkspaceState } from './abs-workspace-state';
import { captureAbsDeclarativeContracts } from './abs-declarative-contracts';
import { layoutAbsNewRoots } from './abs-new-root-layout';
import { fenceBlocklyWorkspaceBumps } from '../../../editors/blockly-editor/services/blockly-workspace-layout-fence';
import { AbsGenerationCandidateRequest, AbsGenerationEvidence, AbsGenerationValidation, generationEvidence } from './abs-generation-protocol';
import { inspectAbsGeneration } from './abs-generation-inspection';
import { planAbsVariableCreations } from './abs-variable-intents';
import { captureAbsBundledProcedures } from './abs-bundled-procedures';
import { describeAbsBlockCapability } from './abs-block-capabilities';
import { captureAbsCustomFunctions } from './abs-custom-functions';
import { captureAbsVariableDeclarations } from './abs-declaration-intents';
import { prepareAbsNativeReconciliation } from './abs-native-reconciliation';
import type { AbsReconcileOptions } from './abs-reconciler';
import type { AbsNativeInstance } from './abs-native-binding';
import { describePreparedAbsSyntax } from './abs-syntax-advice';
import { assertSynchronousNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate-policy';
import type { PreparedBlocklySave } from '../../../editors/blockly-editor/services/prepared-project-save';
import type { PreparedBlocklyCode } from '../../../editors/blockly-editor/services/prepared-project-code';

export interface AbsWorkspaceSyncOutcome {
  publication: AbsPublishResult;
  /** Only a fully committed, still-current application has an applied revision. */
  appliedRevision?: number;
  requiresReload: boolean;
  warnings: readonly string[];
  evidence?: AbsGenerationEvidence;
  abs?: string;
  reused?: boolean;
  draftArchive?: { generation: string; baseGeneration: string; hash: string; bytes: number };
}

/** Explicit v2 coordinator. Not an automatic legacy-format switch.
 * The editor owns FIFO/lease/runtime, ProjectService owns save preparation/derived outputs,
 * the existing baseline kernel owns publication/recovery, and preload owns the common lock.
 */
@Injectable({ providedIn: 'root' })
export class AbsWorkspaceSyncService {
  constructor(private readonly editor: BlocklyService, private readonly project: _ProjectService) {}

  /** Synchronous runtime-scoped advice. No lease, persistence, generation or callback probing. */
  describeCapabilities(input: Record<string, any>) {
    if (input['version'] !== 1 || Object.keys(input).some(key => !['version', 'type', 'types', 'filter'].includes(key))
      || ['type', 'filter'].some(key => input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 256))
      || input['type'] !== undefined && !input['type']
      || ['type', 'types', 'filter'].filter(key => input[key] !== undefined).length > 1
      || input['types'] !== undefined && (!Array.isArray(input['types']) || !input['types'].length || input['types'].length > 16
        || input['types'].some(type => typeof type !== 'string' || !type || type.length > 256)
        || new Set(input['types']).size !== input['types'].length)) {
      throw new AbsSyncError('ABS_REQUEST_INVALID', 'Invalid ABS capability query.');
    }
    const context = this.context(), runtimeRevision = getActiveProjectGeneratorRevision();
    let nativeValidation = false;
    try {
      const replay = this.editor.captureNativeReplay();
      assertSynchronousNativeCandidate({ steps: replay.steps, blocks: [] });
      replay.assertCurrent(); nativeValidation = true;
    } catch { /* Advice stays conservative when the complete runtime cannot be replayed. */ }
    const filter = (input['filter'] ?? '').toLowerCase();
    const selected: string[] | undefined = input['type'] !== undefined ? [input['type']] : input['types'];
    const types = selected ?? context.definitions.types;
    const blocks = types.map(type => ({ type, library: this.editor.blockTypeToLibMap.get(type)?.name ?? 'host' }))
      .filter(item => !filter || item.type.toLowerCase().includes(filter) || item.library.toLowerCase().includes(filter))
      .map(item => ({ ...item, ...describeAbsBlockCapability(context.definitions, item.type, nativeValidation) }));
    const instanceSyntax = selected ? this.editor.describeCommittedAbsSyntax(selected) : undefined;
    context.assertCurrent();
    return { version: 1, scope: context.scope, runtimeRevision, blocks,
      ...(selected ? { instanceSyntax: instanceSyntax ?? { scope: 'unavailable', reason: 'no-current-committed-snapshot' } } : {}) };
  }

  /** initialize must be explicit when replacing an existing unversioned ABS mirror. */
  exportGeneration(options: { initialize?: boolean; expectedAbiHash?: string; publish?: boolean; rebind?: string; reuseCurrent?: boolean; preserveDraft?: string; synchronize?: boolean } = {}): Promise<AbsWorkspaceSyncOutcome> {
    options = { ...options };
    if (options.synchronize && (options.initialize || options.publish === false || options.rebind || options.preserveDraft)) {
      return Promise.reject(new AbsSyncError('ABS_REQUEST_INVALID', 'Turn synchronization cannot initialize, rebind or replace a draft.'));
    }
    const initialize = options.initialize === true;
    return this.run(async (context, lease, store) => {
      const inspection = options.rebind !== undefined || options.preserveDraft !== undefined ? await inspectAbsGeneration(store, context.scope) : undefined;
      if (options.rebind !== undefined && (options.preserveDraft !== undefined || initialize || options.publish === false || !inspection.diagnostics.rebind
        || options.rebind !== inspection.diagnostics.rebind.token)) {
        throw new AbsSyncError('ABS_REBIND_STALE', 'Rebind requires the current inspection token, clean source and canonical export. Inspect again; never rebase a candidate.');
      }
      const expected = inspection?.disk ?? await store.captureDisk();
      if (options.expectedAbiHash !== undefined && (expected.abi === null || await hashAbsText(expected.abi) !== options.expectedAbiHash)) {
        throw new AbsSyncError('ABS_BASELINE_STALE', 'Saved ABI changed before export.');
      }
      if (await store.inspectPending()) throw new AbsSyncError('ABS_TRANSACTION_PENDING', 'Recover the pending generation before exporting.');
      const committed = inspection ? inspection.committed?.projection : await store.loadCommitted();
      if (committed && !inspection) this.assertMirrors(committed, expected, true);
      else if (!committed && (expected.map !== null || expected.abs !== null && !initialize)) {
        throw new AbsSyncError('ABS_INITIALIZATION_REQUIRED', 'An existing mirror requires explicit generation initialization; orphan maps are never overwritten.');
      }
      context.assertCurrent();
      let snapshot = this.editor.captureProjectSnapshot(lease);
      let assertCurrent = this.atRevision(context.assertCurrent, lease, snapshot);
      let prepared: PreparedBlocklySave | undefined;
      let generated: PreparedBlocklyCode | null = null;
      if (committed) {
        const diskHash = expected.abi === null ? null : await hashAbsText(absJson(JSON.parse(expected.abi)));
        if (diskHash !== committed.map.savedAbiHash) {
          // A normal save may advance disk; an independent external edit must not
          // become the baseline for a different in-memory document.
          prepared = await this.project.prepareSave(snapshot.document, assertCurrent);
          if (await hashAbsText(absJson(JSON.parse(prepared.abiText))) !== diskHash) {
            throw new AbsSyncError('ABS_DUAL_EDIT_CONFLICT', 'Saved ABI and workspace diverged; reconcile the external edit before exporting a new generation.', undefined, undefined,
              { hint: 'Call project_recover action=inspect once for disk/canvas comparison. Do not retry save/export/apply or refresh without a token; preserve both versions until the intended source is established.' });
          }
        }
        assertCurrent();
      }
      if (options.synchronize) {
        // A stale candidate cannot be applied, but a clean mirror can be replaced
        // from the current canvas. Save + projection share one lease and journal;
        // no inspection of the OLD runtime contract grants or denies this operation.
        prepared ??= await this.project.prepareSave(snapshot.document, assertCurrent);
        if (expected.abi === null || !sameAbsProgram(JSON.parse(prepared.abiText), JSON.parse(expected.abi))) {
          assertCurrent();
          generated = await this.editor.prepareProjectCode(context.assertCurrent, lease);
          context.assertCurrent();
          snapshot = this.editor.captureProjectSnapshot(lease);
          if (generated && generated.revision !== snapshot.revision) {
            throw new AbsSyncError('ABS_RUNTIME_CAPTURE_CHANGED', 'Prepared code no longer belongs to the current canvas.');
          }
          assertCurrent = this.atRevision(context.assertCurrent, lease, snapshot);
          prepared = await this.project.prepareSave(snapshot.document, assertCurrent);
        } else prepared = undefined;
      } else prepared = undefined;
      const runtime = captureAbsWorkspaceState(context.workspace, assertCurrent, context.definitions);
      if (options.preserveDraft !== undefined) {
        const readiness = await inspectAbsDraft(inspection!, snapshot.document, runtime);
        assertCurrent();
        if (initialize || options.publish === false || !readiness.refresh || readiness.refresh.token !== options.preserveDraft) {
          throw new AbsSyncError('ABS_REFRESH_STALE', 'Draft refresh requires the current inspection token and an unchanged saved workspace. Inspect again; no draft was overwritten.');
        }
      }
      const compact = await this.compactDocument(snapshot.document, runtime.contracts, assertCurrent);
      if (options.reuseCurrent && !prepared && options.publish !== false && !inspection && committed
        && sameAbsProgram(compact, committed.document)
        && absJson(runtime.contracts) === absJson(committed.contracts)
        && absJson(context.scope) === absJson(committed.map.scope)
        && committed.map.savedAbiHash === (expected.abi === null ? null : await hashAbsText(absJson(JSON.parse(expected.abi))))) {
        const evidence = await generationEvidence(committed, expected.abi);
        await this.assertDisk(store, expected, assertCurrent);
        this.editor.publishAbsContext(committed, assertCurrent().revision, context.assertCurrent);
        return { publication: { status: 'COMMITTED', generation: committed.map.generation,
          abiSaved: false, absMirrored: true, mapPublished: true }, requiresReload: false,
          warnings: [], evidence, abs: committed.abs, reused: true };
      }
      const savedAbi = prepared?.abiText ?? expected.abi;
      const projection = await this.projection(compact, runtime.contracts, savedAbi, context.scope, assertCurrent);
      const evidence = await generationEvidence(projection, savedAbi);
      await this.assertDisk(store, expected, assertCurrent);
      if (options.publish === false) return { publication: { status: 'NOT_COMMITTED', generation: projection.map.generation,
        abiSaved: false, absMirrored: false, mapPublished: false }, requiresReload: false, warnings: [], evidence, abs: projection.abs };
      await store.stage({ projection, mode: prepared ? 'import' : 'export', inputAbs: expected.abs ?? projection.abs, abi: prepared?.abiText ?? null, expected,
        ...(inspection ? { inputMap: expected.map } : {}),
        ...(options.preserveDraft ? { draftBaseGeneration: committed!.map.generation } : {}) }, inspection?.committed?.pointerHash);
      const archived = options.preserveDraft ? await store.readArchivedDraft(projection.map.generation) : undefined;
      const draftArchive = archived ? { generation: archived.generation, baseGeneration: archived.baseGeneration,
        hash: archived.hash, bytes: archived.bytes } : undefined;
      assertCurrent();
      let publication: AbsPublishResult;
      try {
        publication = await store.commit(projection.map.generation, assertCurrent, async (text, expectedHash, storage) => {
          assertCurrent();
          if (!prepared) throw new AbsSyncError('ABS_EXPORT_SAVE_FORBIDDEN', 'Export must not save ABI.');
          if (text !== prepared.abiText || !await storage.replace('project.abi', expectedHash, text)) {
            throw new AbsSyncError('ABS_ABI_COMMIT_CONFLICT', 'Prepared ABI changed before commit.');
          }
        });
      } catch (error) {
        if (prepared && context.isCurrent()) lease.quarantine(`Turn synchronization commit needs inspection: ${String(error)}`);
        throw error;
      }
      const warnings: string[] = generated?.error ? [`Current canvas code generation failed: ${generated.error}`] : [];
      const requiresReload = !!prepared && publication.abiSaved && publication.status !== 'COMMITTED';
      if (requiresReload) lease.quarantine('Canvas saved but generation publication is pending; inspect before reopening.');
      if (publication.status === 'COMMITTED') {
        assertCurrent();
        if (prepared) {
          try { await this.project.publishPreparedSaveOutputs(context.path, prepared, generated, assertCurrent); }
          catch (error) { warnings.push(`Canvas synchronized; derived outputs were not fully published: ${String(error)}`); }
          assertCurrent();
        }
        this.editor.publishAbsContext(projection, assertCurrent().revision, context.assertCurrent);
      }
      return { publication, requiresReload, warnings, ...(draftArchive ? { draftArchive } : {}),
        ...(publication.status === 'COMMITTED' ? { evidence, abs: projection.abs } : {}) };
    });
  }

  validateGeneration(source: string, request: AbsGenerationCandidateRequest): Promise<AbsGenerationValidation & { syntaxAdvice: ReturnType<typeof describePreparedAbsSyntax> }> {
    if (['preparedModels', 'preparedVariables', 'retiredModels', 'workspaceRevision'].some(key => Object.hasOwn(request, key))) {
      return Promise.reject(new AbsSyncError('ABS_REQUEST_INVALID', 'Preparation evidence is host output, not candidate input.'));
    }
    request = JSON.parse(absJson(request));
    return this.run(async (context, lease, store) => {
      const prepared = await this.prepareGeneration(context, lease, store, source, request.base.generation, request);
      return { ...request, workspaceRevision: prepared.before.revision,
        ...(prepared.preparedModels.length ? { preparedModels: prepared.preparedModels } : {}),
        ...(prepared.candidate.retiredModels.length ? { retiredModels: prepared.candidate.retiredModels } : {}),
        syntaxAdvice: describePreparedAbsSyntax(prepared.candidate.workspace, prepared.candidate.contracts, prepared.candidate.identities),
        ...(request.createVariables ? { preparedVariables: planAbsVariableCreations({ requestId: request.requestId, variables: request.createVariables }) } : {}) };
    });
  }

  private async prepareGeneration(context: ReturnType<AbsWorkspaceSyncService['context']>, lease: BlocklyWorkspaceEditLease,
    store: AbsBaselineStore, source: string, generation: string, binding?: AbsGenerationCandidateRequest | AbsGenerationValidation) {
      const shapes = captureAbsDeclarativeContracts(context.definitions);
      const procedures = captureAbsBundledProcedures(context.definitions);
      const custom = captureAbsCustomFunctions(context.definitions);
      const blockContract = (type: string, extra?: unknown, fields?: Readonly<Record<string, unknown>>) => custom.get(type, extra) ?? procedures.get(type, extra) ?? shapes.get(type, extra, fields);
      const expected = await store.captureDisk();
      if (await store.inspectPending()) throw new AbsSyncError('ABS_TRANSACTION_PENDING', 'Recover or explicitly abandon the pending generation first.');
      const baseline = await store.loadCommitted();
      if (!baseline) throw new AbsSyncError('ABS_BASELINE_MISSING', 'An authoritative committed generation is required.');
      if (generation !== baseline.map.generation) throw new AbsSyncError('ABS_BASELINE_STALE', 'The candidate belongs to another generation.');
      this.assertMirrors(baseline, expected, false);
      if (binding) {
        const evidence = await generationEvidence(baseline, expected.abi);
        if (absJson(binding.base) !== absJson(evidence.binding) || binding.candidate.hash !== await hashAbsText(source)
          || binding.candidate.bytes !== new TextEncoder().encode(source).byteLength) {
          throw new AbsSyncError('ABS_BASELINE_STALE', 'Candidate bytes or generation binding changed; no automatic rebase is allowed.');
        }
      }
      context.assertCurrent();
      const before = this.editor.captureProjectSnapshot(lease);
      const assertPreparing = this.atRevision(context.assertCurrent, lease, before);
      const rollback = captureAbsWorkspaceState(context.workspace, context.assertCurrent, context.definitions);
      assertPreparing();
      const compact = await this.compactDocument(before.document, rollback.contracts, assertPreparing);
      const unchanged = sameAbsProgram(compact, baseline.document);
      if (binding && 'workspaceRevision' in binding && binding.workspaceRevision !== before.revision && !unchanged) {
        throw new AbsSyncError('ABS_REVISION_STALE', 'Program changed after candidate validation.');
      }
      assertAbsBaselineContext(baseline.map, {
        generation, scope: context.scope,
        currentAbiHash: unchanged ? baseline.map.baseAbiHash : await hashAbsText(absJson(compact)),
        currentPageAbiHash: unchanged ? baseline.map.pageAbiHash : await hashAbsText(absJson(composeBlocklyPage(compact, context.scope.pageId))),
        savedAbiHash: expected.abi === null ? null : await hashAbsText(absJson(JSON.parse(expected.abi))),
      });
      assertAbsContractsCompatible(baseline.contracts, rollback.contracts, rollback.state);
      assertPreparing();
      const functionSyntax = custom.syntax(source, baseline.workspace);
      const reconcileOptions: AbsReconcileOptions = {
        sourceEdits: binding?.sourceEdits,
        prepareExtraState: functionSyntax.prepareExtraState,
        declaration: captureAbsVariableDeclarations(context.definitions, shapes.get),
        argumentOrder: (type, extra, fields) => functionSyntax.argumentOrder?.(type, extra, fields) ?? shapes.get(type, extra, fields)?.argumentOrder,
        fieldSelectors: type => shapes.get(type)?.fieldShape?.map(rule => rule.field),
        fieldDefinition: (type, name, id) => custom.field(type, name) ?? rollback.fieldDefinition(type, name, id) ?? shapes.get(type)?.fields[name],
        blockContract: shapes.get, prepareBlock: (block, previous, workspace, contracts) => {
          procedures.prepare(block, previous, workspace, contracts); custom.prepare(block, previous, workspace, contracts);
        },
        hostPrepared: type => !!context.definitions.procedure?.(type) || !!custom.describe(type),
        ...(binding?.createVariables ? { variableCreation: { requestId: binding.requestId, variables: binding.createVariables } } : {}),
      };
      assertAbsProcedureModelIntents(source, binding?.createVariables, reconcileOptions, type => {
        if (custom.describe(type)?.protocol.kind === 'definition') return { nameField: 'FUNC_NAME', modelType: 'FUNC' };
        return context.definitions.procedure?.(type)?.role === 'definition' ? {} : undefined;
      });
      let candidate: Awaited<ReturnType<typeof prepareAbsReconciliation>>;
      let materialized: Awaited<ReturnType<typeof candidate.materialize>>;
      let instances: ReadonlyMap<string, AbsNativeInstance> | undefined;
      let preparedModels: NonNullable<AbsGenerationValidation['preparedModels']> = [];
      let needsNative = false;
      try {
        candidate = await prepareAbsReconciliation(baseline, source, assertPreparing, reconcileOptions);
        materialized = await candidate.materialize();
        assertPreparing();
        assertAbsRuntimeShapeSupported(rollback.state, materialized, candidate.contracts, blockContract);
        // A declarative JSON shape says nothing about generator-created models.
        // New blocks must get the same native preparation even without a consumer.
        needsNative = candidate.added.length > 0 && typeof this.editor.captureNativeReplay === 'function';
      } catch (error) {
        // Native execution can supply missing structure, never relax field/identity,
        // protection, baseline, resource or transaction errors from the pure path.
        if (!(error instanceof AbsSyncError) || !['ABS_SYNTAX_INVALID', 'ABS_RUNTIME_SHAPE_UNSUPPORTED', 'ABS_SYMBOL_MISSING'].includes(error.code)
          || typeof this.editor.captureNativeReplay !== 'function') throw error;
        needsNative = true;
      }
      if (needsNative) {
        assertPreparing();
        const replay = this.editor.captureNativeReplay();
        const assertNative = () => { assertPreparing(); replay.assertCurrent(); };
        const { evaluateNativeCandidate } = await import('../../../editors/blockly-editor/services/blockly-native-candidate');
        const prepared = await prepareAbsNativeReconciliation(baseline, source, reconcileOptions,
          request => evaluateNativeCandidate({ ...request, steps: replay.steps }, { assertCurrent: assertNative }), assertNative);
        ({ candidate, materialized, instances, preparedModels } = prepared);
      }
      if (binding && 'workspaceRevision' in binding && absJson(binding.preparedModels ?? []) !== absJson(preparedModels)) {
        throw new AbsSyncError('ABS_MODEL_DECLARATION_CHANGED', 'Native model preparation changed after validation. Validate the same candidate again.');
      }
      if (binding && 'workspaceRevision' in binding && absJson(binding.retiredModels ?? []) !== absJson(candidate.retiredModels)) {
        throw new AbsSyncError('ABS_MODEL_DECLARATION_CHANGED', 'Retired model evidence changed after validation. Validate the same candidate again.');
      }
      assertPreparing();
      // Persistence composes shared definitions before page-local roots. Apply the
      // same stable partition before loading, so save/page switch/reopen cannot
      // change the live root order. Only captured/prepared ownership is authority.
      const sharedRoots = new Set(before.document.sharedModel.procedureBlocks.map(block => block.id));
      for (const [id, procedure] of Object.entries(candidate.contracts.procedures ?? {})) {
        if (procedure.role === 'definition') sharedRoots.add(id);
      }
      materialized.blocks.blocks.sort((a, b) => Number(!sharedRoots.has(a.id)) - Number(!sharedRoots.has(b.id)));
      assertAbsRuntimeShapeSupported(rollback.state, materialized, candidate.contracts, blockContract, instances);
      await this.assertDisk(store, expected, assertPreparing);
      // Code remains bound to the generation; layout follows the latest editor
      // snapshot, including moves made since export or during native preparation.
      const current = this.editor.captureProjectSnapshot(lease);
      assertPreparing();
      const currentWorkspace = composeBlocklyPage(current.document, context.scope.pageId);
      retainAbsRootLayout(materialized, currentWorkspace);
      retainAbsRootLayout(rollback.state, currentWorkspace);
      this.editor.assertWorkspaceSharedChange(current.document, materialized, lease);
      return { expected, before: current, rollback, candidate, materialized, preparedModels };
  }

  applyGeneration(source: string, generation: string, options: AbsWorkspaceLoadOptions = {}, validation?: AbsGenerationValidation): Promise<AbsWorkspaceSyncOutcome> {
    options = { ...options };
    if (validation) validation = JSON.parse(absJson(validation));
    return this.run(async (context, lease, store) => {
      const { expected, before, rollback, candidate, materialized } = await this.prepareGeneration(context, lease, store, source, generation, validation);

      let mutated = false, commitStarted = false;
      let publication: AbsPublishResult | undefined;
      const runtime = window['Blockly'];
      const group = runtime.Events.getGroup(), recordUndo = runtime.Events.getRecordUndo();
      const restore = () => {
        mutated = false; // Never retry a failed rollback.
        context.assertCurrent(); lease.assertCurrent();
        this.editor.restoreProjectWorkspaceSnapshot(before.document, lease, rollback.state.blocks.blocks.map(block => block.id));
        context.definitions.customFunctions?.synchronize(context.workspace, rollback.state);
        const restored = captureAbsWorkspaceState(context.workspace, context.assertCurrent, context.definitions);
        assertAbsReadback(rollback.state, restored.state, rollback);
      };
      try {
        mutated = true;
        await loadAbsWorkspaceState(materialized, context.workspace, options, context.assertCurrent, candidate.contracts);
        context.definitions.customFunctions?.synchronize(context.workspace, materialized);
        layoutAbsNewRoots(materialized, candidate.added, context.workspace, context.assertCurrent);
        // Library model registration belongs before complete readback and the save seal.
        const generated = await this.editor.prepareProjectCode(context.assertCurrent, lease);
        context.assertCurrent();
        const actual = captureAbsWorkspaceState(context.workspace, context.assertCurrent, context.definitions);
        assertAbsReadback(materialized, actual.state, actual);
        this.editor.assertWorkspaceSharedChange(before.document, actual.state, lease);
        const applied = this.editor.captureProjectSnapshot(lease);
        assertAbsProjectEnvelope(before.document, applied.document, context.scope.pageId);
        if (generated && generated.revision !== applied.revision) throw new AbsSyncError('ABS_RUNTIME_CAPTURE_CHANGED', 'Prepared code no longer belongs to the applied revision.');
        const assertApplied = this.atRevision(context.assertCurrent, lease, applied);
        const prepared = await this.project.prepareSave(applied.document, assertApplied);
        const savedCompact = await this.compactDocument(applied.document, actual.contracts, assertApplied);
        const projection = await this.projection(savedCompact, actual.contracts, prepared.abiText, context.scope, assertApplied);
        const evidence = await generationEvidence(projection, prepared.abiText);
        await store.stage({ projection, mode: 'import', inputAbs: source, abi: prepared.abiText, expected });
        assertApplied();
        commitStarted = true;
        publication = await store.commit(projection.map.generation, assertApplied, async (text, expectedHash, storage) => {
          assertApplied();
          if (text !== prepared.abiText || !await storage.replace('project.abi', expectedHash, text)) {
            throw new AbsSyncError('ABS_ABI_COMMIT_CONFLICT', 'Prepared ABI changed before commit.');
          }
        });
        if (!publication.abiSaved) {
          restore();
          return { publication, requiresReload: false, warnings: [] };
        }
        if (publication.status !== 'COMMITTED') {
          lease.quarantine('ABI was saved but generation publication is pending; inspect and explicitly recover before reopening.');
          return { publication, requiresReload: true, warnings: [] };
        }
        assertApplied();
        const warnings: string[] = [];
        try { await this.project.publishPreparedSaveOutputs(context.path, prepared, generated, assertApplied); }
        catch (error) { warnings.push(`Generation committed; derived outputs were not fully published: ${String(error)}`); }
        const published = assertApplied();
        this.editor.publishAbsContext(projection, published.revision, context.assertCurrent);
        return { publication, appliedRevision: published.revision, requiresReload: false, warnings, evidence };
      } catch (error) {
        if (mutated && context.isCurrent()) {
          if (commitStarted) {
            // An interrupted host acknowledgement or saved ABI is not safe to undo in memory.
            lease.quarantine(`Generation commit needs explicit inspection: ${String(error)}`);
          } else {
            try { restore(); }
            catch (rollbackError) {
              const reason = `Rollback failed; reopen the project: ${String(rollbackError)}. Original failure: ${String(error)}`;
              lease.quarantine(reason);
              throw new AbsSyncError('ABS_ROLLBACK_FAILED', reason);
            }
          }
        }
        throw error;
      } finally {
        if (context.isCurrent()) {
          this.editor.markWorkspaceCodeDirty();
          runtime.Events.setGroup(group); runtime.Events.setRecordUndo(recordUndo);
        }
      }
    });
  }

  /** Disk-only recovery remains callable for a quarantined editor. It never unblocks,
   * loads, saves, generates code or marks the current workspace clean. Host lock owns exclusion.
   */
  async inspectRecovery() {
    const context = this.context();
    const store = await this.store(context);
    const result = await store.inspectPending(); context.assertCurrent(); return result;
  }

  /** Disk recovery remains available under quarantine. Draft readiness additionally
   * captures the current workspace under its lease, without flushing/writing assets. */
  async inspectGeneration() {
    const context = this.context();
    const inspection = await inspectAbsGeneration(await this.store(context), context.scope);
    context.assertCurrent();
    if (inspection.committed && inspection.diagnostics.issues.every(issue => issue === 'ABS_SOURCE_CONFLICT')) {
      return this.run(async (context, lease, store) => {
        const current = await inspectAbsGeneration(store, context.scope);
        const snapshot = this.editor.captureProjectSnapshot(lease);
        const assertCurrent = this.atRevision(context.assertCurrent, lease, snapshot);
        const runtime = captureAbsWorkspaceState(context.workspace, assertCurrent, context.definitions);
        const diagnostics = await inspectAbsDraft(current, snapshot.document, runtime);
        await this.assertDisk(store, current.disk, assertCurrent);
        if ((await store.inspectCommitted())?.pointerHash !== current.committed?.pointerHash || await store.inspectPending()) {
          throw new AbsSyncError('ABS_BASELINE_STALE', 'Generation changed during draft inspection. Inspect again.');
        }
        return { pending: current.pending, diagnostics };
      }, false);
    }
    return { pending: inspection.pending, diagnostics: inspection.diagnostics as typeof inspection.diagnostics & AbsDraftReadiness };
  }

  async readArchivedDraft(generation: string) {
    const context = this.context(), store = await this.store(context);
    const draft = await store.readArchivedDraft(generation); context.assertCurrent(); return draft;
  }

  async recoverGeneration(): Promise<AbsPublishResult | null> {
    const context = this.context();
    const store = await this.store(context);
    const result = await store.recover(context.assertCurrent); context.assertCurrent(); return result;
  }

  async abandonGeneration(generation: string): Promise<void> {
    const context = this.context();
    const store = await this.store(context);
    await store.abandon(generation); context.assertCurrent();
  }

  private run<T>(operation: (context: ReturnType<AbsWorkspaceSyncService['context']>, lease: BlocklyWorkspaceEditLease, store: AbsBaselineStore) => Promise<T>, flush = true): Promise<T> {
    const context = this.context(); // Before queueing, not when an old task eventually starts.
    return this.editor.runProjectOperation(async () => {
      context.assertCurrent();
      const lease = this.editor.acquireWorkspaceEditLease();
      let releaseLayout = () => undefined;
      try {
        releaseLayout = fenceBlocklyWorkspaceBumps(context.workspace);
        if (flush) await projectDataRuntime.flushPending();
        context.assertCurrent(); lease.assertCurrent();
        const store = await this.store(context);
        return await operation(context, lease, store);
      } finally { try { releaseLayout(); } finally { lease.release(); } }
    });
  }

  private context() {
    const path = this.project.currentProjectPath, pageId = this.editor.getActivePageId(), workspace = this.editor.workspace;
    const definitions = this.editor.captureDeclarativeBlockDefinitions();
    const generator = getActiveProjectGenerator(), runtimeRevision = getActiveProjectGeneratorRevision();
    const session = projectDataRuntime.getSessionToken();
    const isCurrent = () => !!path && !!workspace && path === this.project.currentProjectPath
      && pageId === this.editor.getActivePageId() && workspace === this.editor.workspace
      && generator === getActiveProjectGenerator() && runtimeRevision === getActiveProjectGeneratorRevision()
      && session === projectDataRuntime.getSessionToken();
    const assertCurrent = () => {
      if (!isCurrent()) throw new AbsSyncError('ABS_CONTEXT_STALE', 'ABS operation belongs to a stale project/page/runtime.');
      definitions.assertCurrent();
    };
    assertCurrent();
    return { path, workspace, definitions, scope: { projectKey: path, pageId }, isCurrent, assertCurrent };
  }

  private async store(context: ReturnType<AbsWorkspaceSyncService['context']>) {
    const port = await openAbsHostStorage(context.path, context.assertCurrent);
    context.assertCurrent(); return new AbsBaselineStore(port, context.scope);
  }

  private atRevision(assertContext: () => void, lease: BlocklyWorkspaceEditLease,
    snapshot: { revision: number; document: BlocklyProjectDocument }) {
    return () => {
      assertContext(); lease.assertCurrent();
      const current = this.editor.captureProjectSnapshot(lease);
      // Native rendering may settle the viewport even after the save snapshot is sealed.
      // Every ABS phase uses the same content guard; persisted bytes remain immutable.
      if (current.revision !== snapshot.revision && !sameAbsProgram(snapshot.document, current.document)) {
        throw new AbsSyncError('ABS_REVISION_STALE', 'Workspace changed during generation preparation.');
      }
      return current;
    };
  }

  private async compactDocument(document: BlocklyProjectDocument, contracts: AbsProjectionContracts, assertCurrent: () => void) {
    const result = await prepareAbsProjectData(document, assertCurrent);
    assertAbsResourceContracts(composeBlocklyPage(document, document.activePageId),
      composeBlocklyPage(result.document, document.activePageId), contracts);
    assertCurrent(); return result.document;
  }

  private async projection(document: BlocklyProjectDocument, contracts: AbsProjectionContracts, abi: string | null,
    scope: AbsProjection['map']['scope'], assertCurrent: () => void) {
    const generation = crypto.randomUUID();
    const projection = await createAbsProjection(composeBlocklyPage(document, scope.pageId), { document, contracts,
      generation, baselineRef: absBaselineKey(generation), scope,
      savedAbiHash: abi === null ? null : await hashAbsText(absJson(JSON.parse(abi))) });
    assertCurrent(); return projection;
  }

  private assertMirrors(baseline: AbsProjection, disk: AbsDiskSnapshot, exporting: boolean) {
    if (disk.map !== absJson(baseline.map)) throw new AbsSyncError('ABS_MAP_INVALID', 'Public map differs from the authoritative committed baseline.');
    if (exporting && disk.abs !== baseline.abs) throw new AbsSyncError('ABS_SOURCE_CONFLICT', 'ABS contains an unapplied edit; export will not overwrite it.');
  }

  private async assertDisk(store: AbsBaselineStore, expected: AbsDiskSnapshot, assertCurrent: () => void) {
    const actual = await store.captureDisk(); assertCurrent();
    if (absJson(actual) !== absJson(expected)) throw new AbsSyncError('ABS_DISK_CONFLICT', 'Project files changed during candidate preparation.');
  }
}
