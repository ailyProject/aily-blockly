import { splitAbsState } from './abs-full-state';
import { captureProjectRecoveryFiles, assertProjectRecoveryFilesCurrent } from '@shared/public-api';
import { publishAbsRecoveryCopy, type AbsRecoveryCopyCapture } from './abs-recovery-copy';
import { mergeAbsRequestWorkspace } from './abs-request-merge';
import { composeAbs } from './abs-compose';
import { precheckAbs, AbsPrecheckFailure } from './abs-precheck';
import { Injectable, NgZone, Optional } from '@angular/core';
import { AbsApplicationFailure } from './abs-application-failure';
import { createNativeCandidateRecovery } from '../../../editors/blockly-editor/services/blockly-native-candidate-recovery';
import { assertAbsProcedureModelIntents } from './abs-procedure-model-intents';
import { BlocklyService, BlocklyProjectDocument } from '../../../editors/blockly-editor/services/blockly.service';
import { _ProjectService } from '../../../editors/blockly-editor/services/project.service';
import { BlocklyWorkspaceEditLease, fenceBlocklyWorkspaceInput } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';
import { composeBlocklyPage, replaceBlocklyPageWorkspace } from '../../../editors/blockly-editor/services/blockly-project-model';
import { getActiveProjectGenerator, getActiveProjectGeneratorRevision } from '../../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { projectDataRuntime, ProjectDataRuntime, cloneBlocklyJson, projectSaveOutcomeError, materializeGenericProjectDataValues,
  type AilyDataRef, type BlocklySaveAsSnapshot, type ProjectCopySnapshot } from '@domain/project/public-api';
import { assertAbsContractsCompatible } from './abs-contract-compatibility';
import { inspectAbsDraft, canInspectAbsDraft, AbsDraftReadiness } from './abs-draft-readiness';
import { orderAbsSharedRoots, retainAbsRootLayout, sameAbsProgram } from './abs-program-state';
import { createAbsProjectSnapshotGuard } from './abs-project-snapshot-guard';
import { AbsBaselineStore, AbsDiskSnapshot, AbsPublishResult, absBaselineKey } from './abs-baseline-store';
import { openAbsHostStorage } from './abs-host-storage';
import { absJson, assertAbsBaselineContext, createAbsProjection, hashAbsText } from './abs-identity-map';
import { AbsProjection, AbsProjectionContracts, AbsSyncError } from './abs-state';
import { prepareAbsProjectData } from './abs-project-data';
import { prepareAbsReconciledResources } from './abs-prepared-reconciliation';
import { assertAbsResourceContracts } from './abs-resource-contracts';
import { AbsWorkspaceLoadOptions, assertAbsProjectEnvelope, assertAbsRuntimeShapeSupported, assertAbsWorkspaceReadback, captureAbsWorkspaceState, loadAbsWorkspaceState } from './abs-workspace-state';
import { BlocklyCommentLoading } from '../../../editors/blockly-editor/services/blockly-comment-loading';
import { captureAbsDeclarativeContracts } from './abs-declarative-contracts';
import { layoutAbsNewRoots } from './abs-new-root-layout';
import { fenceBlocklyWorkspaceBumps } from '../../../editors/blockly-editor/services/blockly-workspace-layout-fence';
import { AbsGenerationCandidateRequest, AbsGenerationEvidence, AbsGenerationValidation, generationEvidence } from './abs-generation-protocol';
import { inspectAbsGeneration } from './abs-generation-inspection';
import { inspectAbsGenerationForRecovery } from './abs-baseline-recovery';
import { describeAbsRepair, type AbsRecoveryArchive } from './abs-generation-repair';
import { publishAbsSaveAs, type AbsSaveAsCapture } from './abs-save-as';
import { planAbsVariableCreations } from './abs-variable-intents';
import { captureAbsBundledProcedures } from './abs-bundled-procedures';
import { describeAbsBlockCapability } from './abs-block-capabilities';
import { captureAbsCustomFunctions } from './abs-custom-functions';
import { captureAbsVariableDeclarations } from './abs-declaration-intents';
import { prepareAbsNativeReconciliation } from './abs-native-reconciliation';
import { createAbsReconcilerFactory, type AbsReconcileOptions } from './abs-reconciler';
import type { AbsNativeInstance } from './abs-native-binding';
import { describePreparedAbsSyntax } from './abs-syntax-advice';
import { assertSynchronousNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate-policy';
import type { PreparedBlocklySave } from '../../../editors/blockly-editor/services/prepared-project-save';
import type { PreparedBlocklyCode } from '../../../editors/blockly-editor/services/prepared-project-code';
import { readAbsBlockStateRequest, planAbsBlockStateChanges } from './abs-block-state';
import { AbsBlockStateAdmission } from './abs-block-state-admission';
import { inspectLiveBlockStates, prepareLiveBlockStateOperation } from '../../../editors/blockly-editor/services/blockly-block-state-operation';
import { serializeAbsFailure } from './abs-diagnostics';
import { normalizeAbsSerializedWorkspace } from './abs-serialized-workspace';
import { assertAbsReadback } from './abs-readback';
import { describeAbsDerivedOutputs, type AbsDerivedOutputs } from './abs-derived-outputs';
import { AbsJournalReopenAdmission, type AbsJournalReopenObservation } from './abs-journal-reopen';
import { AbsRepairDerivedReports } from './abs-repair-derived';
import { canSaveAbsWorkspace, sameAbsSavedProgram } from './abs-save-semantics';
import { deferredAbsLoadNormalization, matchesAbsLoadNormalizationReadback, verifyAbsLoadNormalization,
  type AbsLoadNormalizationInput, type AbsLoadNormalizationOutcome } from './abs-load-normalization';

type AbsExportOptions = { initialize?: boolean; expectedAbiHash?: string; publish?: boolean; rebind?: string;
  reuseCurrent?: boolean; preserveDraft?: string; synchronize?: boolean; save?: boolean };

export interface AbsWorkspaceSyncOutcome {
  publication: AbsPublishResult;
  /** Only a fully committed, still-current application has an applied revision. */
  appliedRevision?: number;
  requiresReload: boolean;
  warnings: readonly string[];
  evidence?: AbsGenerationEvidence;
  abs?: string;
  reused?: boolean;
  inputAbiHash?: string | null;
  draftArchive?: { generation: string; baseGeneration: string | null; origin?: 'initial-baseline'; hash: string; bytes: number };
  recoveryArchive?: AbsRecoveryArchive;
  derivedOutputs?: AbsDerivedOutputs;
  /** Read-only pre-AI user state for history; never a published generation. */
  historyBase?: { snapshot: string; hash: string; inputAbsHash: string | null };
}

/** Explicit v2 coordinator. Not an automatic legacy-format switch.
 * The editor owns FIFO/lease/runtime, ProjectService owns save preparation/derived outputs,
 * the existing baseline kernel owns publication/recovery, and preload owns the common lock.
 */
@Injectable({ providedIn: 'root' })
export class AbsWorkspaceSyncService {
  private readonly reconcile = createAbsReconcilerFactory();
  private readonly blockStateAdmission = new AbsBlockStateAdmission();
  private readonly journalReopen = new AbsJournalReopenAdmission();
  private readonly repairDerived = new AbsRepairDerivedReports();
  private completedJournalReopen?: {
    generation: string; token: string; context: ReturnType<AbsWorkspaceSyncService['context']>;
    documentText: string; pointerHash: string; hashes: { abi: string | null; abs: string | null; map: string | null };
    result: { evidence: AbsGenerationEvidence; abs: string; publication: AbsPublishResult; requiresReload: false };
  };
  /** One short-lived candidate handoff. A wire receipt alone is never prepared state. */
  private preparedValidation?: {
    source: string; key: string; requestKey: string; validation: AbsGenerationValidation; expires: number;
    prepared: Awaited<ReturnType<AbsWorkspaceSyncService['prepareGeneration']>>;
  };
  constructor(private readonly editor: BlocklyService, private readonly project: _ProjectService,
    @Optional() private readonly zone?: NgZone) {
    this.project.setAbsSaveHandler?.(async path => {
      if (path !== this.project.currentProjectPath) throw new AbsSyncError('ABS_CONTEXT_STALE', 'Save belongs to another project.');
      const result = await this.exportGeneration({ save: true });
      if (result.publication.status !== 'COMMITTED' || result.requiresReload) {
        throw projectSaveOutcomeError({ projectSaved: result.publication.abiSaved,
          generatedCodePublished: false, partial: result.publication.abiSaved, code: 'ABS_SAVE_INCOMPLETE',
          error: result.publication.error ?? 'Complete ABS save did not commit.' });
      }
      let dependencyError: string | undefined;
      try { await window['libraryDependencies']?.save(path); }
      catch (error) { dependencyError = error instanceof Error ? error.message : String(error); }
      const generatedCodePublished = result.derivedOutputs?.published ?? result.warnings.length === 0;
      const partial = !generatedCodePublished || !!dependencyError;
      return { projectSaved: true, generatedCodePublished, partial,
        ...(partial ? { code: result.derivedOutputs?.code ?? 'PROJECT_DERIVED_OUTPUT_PENDING',
          error: [result.derivedOutputs?.error, dependencyError].filter(Boolean).join('\n') || result.warnings.join('\n') } : {}) };
    });
    this.project.setAbsSaveAsHandler?.(path => this.captureSaveAsSnapshot(path));
    this.project.setAbsRecoveryCopyHandler?.(path => this.captureRecoveryCopySnapshot(path));
    this.project.setAbsLoadNormalizationHandler?.(input => this.publishLoadedNormalization(input));
  }

  /** Trusted open-path continuation, after native readback and release of the
   * load lease. Normalization is not an ABS edit and never consumes a draft.
   * The old saved recipe and all mirrors are archived before the same save
   * journal publishes a new generation under the ordinary FIFO/editor lease. */
  publishLoadedNormalization(input: AbsLoadNormalizationInput): Promise<AbsLoadNormalizationOutcome> {
    input.assertCurrent();
    if (input.projectPath !== this.project.currentProjectPath) {
      return Promise.resolve(deferredAbsLoadNormalization(input.projectPath, 'ABS_CONTEXT_STALE'));
    }
    return this.run(async (context, lease, store) => {
      const assertContext = () => { context.assertCurrent(); input.assertCurrent(); lease.assertCurrent(); };
      const quarantineCurrent = (reason: string) => {
        if (!context.isCurrent()) return;
        try { assertContext(); } catch { return; }
        lease.quarantine(reason);
      };
      assertContext();
      if (!await verifyAbsLoadNormalization(store, input, context.scope)) {
        return deferredAbsLoadNormalization(context.path, 'ABS_LOAD_NORMALIZATION_DEFERRED');
      }
      const snapshot = this.editor.captureProjectSnapshot(lease);
      if (!matchesAbsLoadNormalizationReadback(input, snapshot)) {
        return deferredAbsLoadNormalization(context.path, 'ABS_LOAD_NORMALIZATION_READBACK_CHANGED');
      }
      const guard = () => {
        assertContext();
        const current = this.editor.captureProjectSnapshot(lease);
        if (!matchesAbsLoadNormalizationReadback(input, current)) {
          throw new AbsSyncError('ABS_LOAD_NORMALIZATION_READBACK_CHANGED', 'Native load state changed before normalization publication.');
        }
        assertContext(); return current;
      };
      let prepared: PreparedBlocklySave, projection: AbsProjection, generation: string;
      try {
        prepared = await this.project.prepareSave(snapshot.document, guard);
        if (!await sameAbsSavedProgram(JSON.parse(prepared.abiText), JSON.parse(input.persistedText), {
          normalize: value => this.editor.normalizeProjectAbi(value),
          resolve: ref => projectDataRuntime.resolve(ref), assertCurrent: guard,
        })) return deferredAbsLoadNormalization(context.path, 'ABS_LOAD_NORMALIZATION_READBACK_CHANGED');
        const runtime = captureAbsWorkspaceState(context.workspace, guard, context.definitions, assertContext);
        const compact = await this.compactDocument(snapshot.document, runtime.contracts, guard);
        generation = crypto.randomUUID();
        projection = await this.projection(compact, runtime.contracts, prepared.abiText, context.scope, guard, generation);
        const token = await hashAbsText(absJson({ kind: 'load-normalization',
          originalContent: input.originalContent, persistedText: input.persistedText, expected: input.expected }));
        await this.assertDisk(store, input.expected.disk, guard);
        const archive = await store.archiveRepair(generation, input.expected.disk, input.expected.pointerHash,
          absJson(snapshot.document), token, guard);
        await store.stage({ projection, mode: 'import', abi: prepared.abiText,
          inputAbs: input.expected.disk.abs, inputMap: input.expected.disk.map, expected: input.expected.disk,
          recoveryArchive: { key: archive.key, hash: archive.hash } }, input.expected.pointerHash);
      } catch (error) {
        if ((error as any)?.code === 'ABS_LOAD_NORMALIZATION_READBACK_CHANGED') {
          return deferredAbsLoadNormalization(context.path, 'ABS_LOAD_NORMALIZATION_READBACK_CHANGED');
        }
        throw error;
      }
      let publication: AbsPublishResult;
      let abiWriteAttempted = false;
      try {
        publication = await store.commit(generation, guard, async (text, expectedHash, storage) => {
          guard();
          abiWriteAttempted = true;
          if (text !== prepared.abiText || !await storage.replace('project.abi', expectedHash, text)) {
            throw new AbsSyncError('ABS_ABI_COMMIT_CONFLICT', 'Project ABI changed during load normalization.');
          }
        });
      } catch (error) {
        // Pre-ABI admission failures cannot have saved anything. Once a write
        // was attempted, a lost host acknowledgement must retain protection.
        // Confirmed NOT_COMMITTED outcomes are returned normally below.
        if (!abiWriteAttempted) {
          if ((error as any)?.code === 'ABS_LOAD_NORMALIZATION_READBACK_CHANGED') {
            return deferredAbsLoadNormalization(context.path, 'ABS_LOAD_NORMALIZATION_READBACK_CHANGED');
          }
          throw error;
        }
        quarantineCurrent('Load normalization outcome is unknown; inspect the retained journal before writing.');
        throw new AbsSyncError('ABS_LOAD_NORMALIZATION_OUTCOME_UNKNOWN', `Load normalization acknowledgement is unknown: ${String(error)}`,
          undefined, [], { hint: 'Keep the source and migration archive. Call project_recover action=inspect once; recover only the offered pending journal or already committed generation. Do not repeat normalization, delete locks or apply an old draft.' });
      }
      if (publication.status !== 'COMMITTED') {
        if (publication.abiSaved) quarantineCurrent('Normalized ABI committed; recover its pending generation before writing.');
        return deferredAbsLoadNormalization(context.path, 'ABS_LOAD_NORMALIZATION_INCOMPLETE');
      }
      try {
        guard();
        // This open-path acknowledgement intentionally does not generate C++, run
        // library save hooks or republish manifests as a side effect of migration.
        this.project.rememberLoadedProject(context.path, prepared.abiText, snapshot.document, lease);
        this.editor.publishAbsContext(projection, guard().revision, assertContext);
      } catch (error) {
        quarantineCurrent('Normalization committed but native acknowledgement changed; inspect before writing.');
        throw error;
      }
      return { status: 'COMMITTED', abiText: prepared.abiText, generation };
    });
  }

  private captureRecoveryCopySnapshot(path: string): Promise<BlocklySaveAsSnapshot> {
    if (path !== this.project.currentProjectPath) return Promise.reject(new AbsSyncError('ABS_CONTEXT_STALE', 'Recovery copy belongs to another project.'));
    return this.editor.runRecoveryCopyOperation(async () => {
      const context = this.context(), snapshot = this.editor.captureRecoverySnapshot();
      const guard = () => {
        context.assertCurrent();
        if (this.editor.captureRecoverySnapshot().documentText !== snapshot.documentText) {
          throw new AbsSyncError('ABS_REVISION_STALE', 'Recovery canvas changed during capture.');
        }
      };
      const sourceFiles = await captureProjectRecoveryFiles(path,
        ['project.abi', 'project.abs', 'project.abs.map.json'], context.assertCurrent);
      // Resolve cache-only resources by reading them. Never flush the source,
      // prepare code, run custom serialization or probe its dynamic contracts.
      const document = await materializeGenericProjectDataValues(snapshot.document, {
        resolve: async <TValue>(ref: AilyDataRef) => { const value = await projectDataRuntime.resolve<TValue>(ref); guard(); return value; },
      });
      guard();
      const capture: AbsRecoveryCopyCapture = { sourceProject: path, documentText: absJson(document),
        abiShapeText: absJson(this.editor.getProjectAbiForSave(document)), sourceFiles };
      let disposed = false;
      const assertContext = () => { if (disposed) throw new AbsSyncError('ABS_CONTEXT_STALE', 'Recovery copy was disposed.'); context.assertCurrent(); };
      return {
        publish: target => { assertContext(); return publishAbsRecoveryCopy(target, capture, assertContext); },
        isCurrent: () => { try { assertContext(); guard(); assertProjectRecoveryFilesCurrent(path, sourceFiles); return true; } catch { return false; } },
        freezeForActivation: () => { assertContext(); guard(); assertProjectRecoveryFilesCurrent(path, sourceFiles); return fenceBlocklyWorkspaceInput(context.workspace.getParentSvg?.()?.parentElement ?? undefined); },
        dispose: () => { disposed = true; },
      };
    });
  }

  private captureSaveAsSnapshot(path: string): Promise<BlocklySaveAsSnapshot> {
    if (path !== this.project.currentProjectPath) return Promise.reject(new AbsSyncError('ABS_CONTEXT_STALE', 'Save As belongs to another project.'));
    return this.run(async (context, lease) => {
      const generated = await this.withViewChecks(() => this.editor.prepareProjectCode(context.assertCurrent, lease));
      const snapshot = this.editor.captureProjectSnapshot(lease);
      const assertRevision = this.atRevision(context.assertCurrent, lease, snapshot);
      const runtime = captureAbsWorkspaceState(context.workspace, assertRevision, context.definitions,
        () => { context.assertCurrent(); lease.assertCurrent(); });
      const capture: AbsSaveAsCapture = { documentText: absJson(snapshot.document),
        abiShapeText: absJson(this.editor.getProjectAbiForSave(snapshot.document)), contractsText: absJson(runtime.contracts), generated };
      assertRevision();
      let disposed = false;
      const assertContext = () => {
        if (disposed) throw new AbsSyncError('ABS_CONTEXT_STALE', 'Save As snapshot was disposed.');
        context.assertCurrent();
      };
      const isCurrent = () => {
        try { assertContext(); return this.editor.captureProjectSnapshot().revision === snapshot.revision; }
        catch { return false; }
      };
      return {
        publish: target => { assertContext(); return publishAbsSaveAs(target, capture, assertContext); },
        isCurrent, dispose: () => { disposed = true; },
        freezeForActivation: () => {
          if (!isCurrent()) throw new AbsSyncError('ABS_REVISION_STALE', 'Source changed before Save As activation.');
          return fenceBlocklyWorkspaceInput(context.workspace.getParentSvg?.()?.parentElement ?? undefined);
        },
      };
    });
  }

  /** Blockly updates its own SVG. Angular only needs published state/progress,
   * not a whole-editor view check for every internal frame or load fragment. */
  private withoutViewChecks<T>(action: () => T): T {
    return this.zone ? this.zone.runOutsideAngular(action) : action();
  }

  private withViewChecks<T>(action: () => T): T {
    return this.zone ? this.zone.run(action) : action();
  }

  /** Retain the live revision while publishing an independent generation only in the copy. */
  prepareCopy(): Promise<ProjectCopySnapshot> {
    const context = this.context();
    return this.editor.runProjectOperation(async () => {
      context.assertCurrent();
      const lease = this.editor.acquireWorkspaceEditLease();
      try {
        await projectDataRuntime.flushPending();
        const sourceStore = await this.store(context);
        if (await sourceStore.inspectPending()) throw new AbsSyncError('ABS_TRANSACTION_PENDING', '请先恢复未完成的项目保存，再另存为。');
        const expected = await sourceStore.captureDisk();
        const committed = await sourceStore.inspectCommitted();
        if (committed) this.assertMirrors(committed.projection, expected, true);
        const generated = await this.editor.prepareProjectCode(context.assertCurrent, lease);
        const snapshot = this.editor.captureProjectSnapshot(lease);
        if (generated && generated.revision !== snapshot.revision) throw new AbsSyncError('ABS_REVISION_STALE', '项目在准备另存为时发生变化，请重试。');
        const checkRevision = this.atRevision(context.assertCurrent, lease, snapshot);
        const guard = () => { checkRevision(); };
        const runtime = captureAbsWorkspaceState(context.workspace, guard, context.definitions,
          () => { context.assertCurrent(); lease.assertCurrent(); });
        const assertCurrent = async () => { guard(); await this.assertDisk(sourceStore, expected, guard); };
        return {
          assertCurrent,
          release: () => lease.release(),
          write: async target => {
            await assertCurrent();
            // The destination runtime externalizes new values into the copy, never into A.
            const data = new ProjectDataRuntime();
            data.configure(target);
            const prepared = await this.project.prepareSave(snapshot.document, guard, data);
            const compact = await prepareAbsProjectData(snapshot.document, guard, data);
            assertAbsResourceContracts(composeBlocklyPage(snapshot.document, snapshot.document.activePageId),
              composeBlocklyPage(compact.document, snapshot.document.activePageId), runtime.contracts);
            const scope = { ...context.scope, projectKey: target };
            const projection = await this.projection(compact.document, runtime.contracts, prepared.abiText, scope, guard);
            const targetStore = new AbsBaselineStore(await openAbsHostStorage(target, guard), scope);
            const disk = await targetStore.captureDisk();
            await targetStore.stage({ projection, mode: 'import', inputAbs: disk.abs ?? projection.abs,
              abi: prepared.abiText, expected: disk });
            const publication = await targetStore.commit(projection.map.generation, guard, async (text, hash, storage) => {
              guard();
              if (text !== prepared.abiText || !await storage.replace('project.abi', hash, text)) {
                throw new AbsSyncError('ABS_ABI_COMMIT_CONFLICT', '另存为项目写入冲突。');
              }
            });
            if (publication.status !== 'COMMITTED') throw new AbsSyncError('ABS_SAVE_INCOMPLETE', publication.error ?? '另存为项目未完整保存。');
            await this.project.publishCopyOutputs(target, snapshot.document, generated, guard);
            await assertCurrent();
          },
        };
      } catch (error) { lease.release(); throw error; }
    });
  }

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
      assertSynchronousNativeCandidate({ steps: replay.steps, graphics: replay.graphics, blocks: [] });
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

  /** Read-only authoring advice; never acquires a write lease or publishes a generation. */
  authoring(operation: 'abs_compose' | 'abs_precheck', input: Record<string, any>) {
    const key = operation === 'abs_compose' ? 'program' : 'abs';
    if (input['version'] !== 1 || Object.keys(input).some(name => !['version', key].includes(name))
      || !Object.hasOwn(input, key) || operation === 'abs_precheck' && typeof input['abs'] !== 'string'
      || JSON.stringify(input).length > 4 * 1024 * 1024) {
      throw new AbsSyncError('ABS_REQUEST_INVALID', 'Invalid or oversized structured authoring request.');
    }
    const context = this.context();
    const shapes = captureAbsDeclarativeContracts(context.definitions);
    const procedures = captureAbsBundledProcedures(context.definitions);
    const custom = captureAbsCustomFunctions(context.definitions);
    const blockContract = (type: string, extra?: unknown, fields?: Readonly<Record<string, unknown>>) =>
      custom.get(type, extra) ?? procedures.get(type, extra) ?? shapes.get(type, extra, fields);
    const known = new Set(context.definitions.types);
    const definitions = { blockContract, knownType: (type: string) => known.has(type),
      deferType: (type: string) => !!context.definitions.procedure?.(type) || !!custom.describe(type),
      argumentOrder: (type: string, extra?: unknown, fields?: Readonly<Record<string, unknown>>) => blockContract(type, extra, fields)?.argumentOrder,
      fieldSelectors: (type: string) => shapes.get(type)?.fieldShape?.map(rule => rule.field),
      fieldDefinition: (type: string, name: string) => custom.field(type, name) ?? shapes.get(type)?.fields[name] };
    const read = () => operation === 'abs_compose' ? composeAbs(input['program'], definitions)
      : { precheck: precheckAbs(input['abs'], definitions) };
    const result = context.definitions.withSynchronousRead ? context.definitions.withSynchronousRead(read) : read();
    context.assertCurrent();
    return { ok: result.precheck.ok, operation, project: context.path, ...result };
  }

  /** initialize must be explicit when replacing an existing unversioned ABS mirror. */
  exportGeneration(options: AbsExportOptions = {}): Promise<AbsWorkspaceSyncOutcome> {
    options = { ...options };
    if (options.synchronize && (options.initialize || options.publish === false || options.rebind || options.preserveDraft)) {
      return Promise.reject(new AbsSyncError('ABS_REQUEST_INVALID', 'Turn synchronization cannot initialize, rebind or replace a draft.'));
    }
    return this.run((context, lease, store) => this.exportInContext(context, lease, store, options));
  }

  /** Shared by save/export and explicit state changes under the SAME FIFO lease. */
  private exportInContext(context: ReturnType<AbsWorkspaceSyncService['context']>, lease: BlocklyWorkspaceEditLease,
    store: AbsBaselineStore, options: AbsExportOptions,
    input?: { expected: AbsDiskSnapshot; generation: string | null }): Promise<AbsWorkspaceSyncOutcome> {
    const initialize = options.initialize === true || options.save === true;
    return this.withoutViewChecks(async (): Promise<AbsWorkspaceSyncOutcome> => {
      const inspection = options.rebind !== undefined || options.preserveDraft !== undefined ? await inspectAbsGeneration(store, context.scope) : undefined;
      if (options.rebind !== undefined && (options.preserveDraft !== undefined || initialize || options.publish === false || !inspection.diagnostics.rebind
        || options.rebind !== inspection.diagnostics.rebind.token)) {
        throw new AbsSyncError('ABS_REBIND_STALE', 'Rebind requires the current inspection token, clean source and canonical export. Inspect again; never rebase a candidate.');
      }
      const expected = inspection?.disk ?? await store.captureDisk();
      if (input && absJson(expected) !== absJson(input.expected)) {
        throw new AbsSyncError('ABS_DISK_CONFLICT', 'Project files changed after state-operation preflight. No newer writer may become this operation\'s save baseline.');
      }
      if (options.expectedAbiHash !== undefined && (expected.abi === null || await hashAbsText(expected.abi) !== options.expectedAbiHash)) {
        throw new AbsSyncError('ABS_BASELINE_STALE', 'Saved ABI changed before export.');
      }
      if (await store.inspectPending()) throw new AbsSyncError('ABS_TRANSACTION_PENDING', 'Recover the pending generation before exporting.');
      const savedCommit = !inspection && options.save ? await store.inspectCommitted() : null;
      const committed = inspection ? inspection.committed?.projection : options.save ? savedCommit?.projection : await store.loadCommitted();
      if (input && (committed?.map.generation ?? null) !== input.generation) {
        throw new AbsSyncError('ABS_BASELINE_STALE', 'Committed generation changed after state-operation preflight.');
      }
      if (committed && !inspection) this.assertMirrors(committed, expected, true);
      else if (!committed && (expected.map !== null || expected.abs !== null && !initialize)) {
        throw new AbsSyncError('ABS_INITIALIZATION_REQUIRED', 'An existing mirror requires explicit generation initialization; orphan maps are never overwritten.', undefined, [], {
          reason: expected.map === null ? 'initial-baseline' : 'orphan-map',
          hint: expected.map === null
            ? 'No pending transaction or map exists. Explicit initialize=true may establish the first baseline from the trusted current canvas while preserving the old ABS.'
            : 'An orphan map exists. Preserve it and inspect project recovery; initialization cannot overwrite it.',
        });
      }
      context.assertCurrent();
      let snapshot = this.editor.captureProjectSnapshot(lease);
      let assertCurrent = this.atRevision(context.assertCurrent, lease, snapshot);
      let prepared: PreparedBlocklySave | undefined;
      let generated: PreparedBlocklyCode | null | undefined;
      if (committed) {
        const diskHash = expected.abi === null ? null : await hashAbsText(absJson(JSON.parse(expected.abi)));
        if (diskHash !== committed.map.savedAbiHash) {
          // Compare D with the actual saved ABI B, not only with edited canvas W.
          // A layout-only D drift is not a competing edit. Recipe verification
          // and the unchanged raw three-file CAS retain publication authority.
          prepared = await this.project.prepareSave(snapshot.document, assertCurrent);
          const savedAbi = await store.readDerivedAbi(committed.map.generation);
          if (!await canSaveAbsWorkspace(savedAbi, expected.abi, prepared.abiText, {
            normalize: value => this.editor.normalizeProjectAbi(value),
            resolve: ref => projectDataRuntime.resolve(ref), assertCurrent,
          })) {
            throw new AbsSyncError('ABS_DUAL_EDIT_CONFLICT', 'Saved ABI and workspace diverged; reconcile the external edit before exporting a new generation.', undefined, undefined,
              { hint: 'Call project_recover action=inspect once for disk/canvas comparison. Do not retry save/export/apply or refresh without a token; preserve both versions until the intended source is established.' });
          }
        }
        assertCurrent();
      }
      if (options.publish !== false) {
        // A stale candidate cannot be applied, but a clean mirror can be replaced
        // from the current canvas. Save + projection share one lease and journal;
        // no inspection of the OLD runtime contract grants or denies this operation.
        prepared ??= await this.project.prepareSave(snapshot.document, assertCurrent);
        if (options.save || expected.abi === null || !sameAbsProgram(JSON.parse(prepared.abiText), JSON.parse(expected.abi))) {
          assertCurrent();
          generated = await this.withViewChecks(() => this.editor.prepareProjectCode(context.assertCurrent, lease));
          context.assertCurrent();
          snapshot = this.editor.captureProjectSnapshot(lease);
          if (generated && generated.revision !== snapshot.revision) {
            throw new AbsSyncError('ABS_RUNTIME_CAPTURE_CHANGED', 'Prepared code no longer belongs to the current canvas.');
          }
          assertCurrent = this.atRevision(context.assertCurrent, lease, snapshot);
          prepared = await this.project.prepareSave(snapshot.document, assertCurrent);
        }
      } else prepared = undefined;
      const runtime = captureAbsWorkspaceState(context.workspace, assertCurrent, context.definitions,
          () => { context.assertCurrent(); lease.assertCurrent(); });
      if (options.preserveDraft !== undefined) {
        const readiness = await inspectAbsDraft(inspection!, snapshot.document, runtime);
        assertCurrent();
        if (initialize || options.publish === false || !readiness.refresh || readiness.refresh.token !== options.preserveDraft) {
          throw new AbsSyncError('ABS_REFRESH_STALE', 'Draft refresh requires the current inspection token and unchanged inspected canvas/files. Inspect again; no draft was overwritten.');
        }
      }
      const compact = await this.compactDocument(snapshot.document, runtime.contracts, assertCurrent);
      if (options.reuseCurrent && options.publish !== false && !inspection && committed
        && sameAbsProgram(compact, committed.document)
        && absJson(runtime.contracts) === absJson(committed.contracts)
        && absJson(context.scope) === absJson(committed.map.scope)
        && committed.map.savedAbiHash === (expected.abi === null ? null : await hashAbsText(absJson(JSON.parse(expected.abi))))) {
        const evidence = await generationEvidence(committed, expected.abi);
        await this.assertDisk(store, expected, assertCurrent);
        let derived = describeAbsDerivedOutputs(generated);
        if (prepared && generated !== undefined) {
          try { await this.withViewChecks(() => this.project.publishPreparedSaveOutputs(context.path, prepared, generated ?? null, () => { assertCurrent(); })); }
          catch (error) { derived = describeAbsDerivedOutputs(generated, { error }); }
        }
        this.withViewChecks(() => this.editor.publishAbsContext(committed, assertCurrent().revision, context.assertCurrent));
        return { publication: { status: 'COMMITTED', generation: committed.map.generation,
          abiSaved: false, absMirrored: true, mapPublished: true }, requiresReload: false,
          warnings: derived.warnings, derivedOutputs: derived.output, evidence, abs: committed.abs, reused: true };
      }
      const savedAbi = prepared?.abiText ?? expected.abi;
      const projection = await this.projection(compact, runtime.contracts, savedAbi, context.scope, assertCurrent);
      const evidence = await generationEvidence(projection, savedAbi);
      await this.assertDisk(store, expected, assertCurrent);
      if (options.publish === false) return { publication: { status: 'NOT_COMMITTED', generation: projection.map.generation,
        abiSaved: false, absMirrored: false, mapPublished: false }, requiresReload: false, warnings: [], evidence, abs: projection.abs };
      await store.stage({ projection, mode: prepared ? 'import' : 'export', inputAbs: expected.abs ?? projection.abs, abi: prepared?.abiText ?? null, expected,
        ...(inspection ? { inputMap: expected.map } : {}),
        ...(options.preserveDraft ? { draftBaseGeneration: committed!.map.generation } : {}) },
        input?.generation === null ? null : inspection?.committed?.pointerHash ?? savedCommit?.pointerHash);
      const archived = options.preserveDraft || input?.generation === null && expected.abs !== null
        ? await store.readArchivedDraft(projection.map.generation) : undefined;
      const draftArchive = archived ? { generation: archived.generation, baseGeneration: archived.baseGeneration,
        ...(archived.origin ? { origin: archived.origin } : {}), hash: archived.hash, bytes: archived.bytes } : undefined;
      assertCurrent();
      let publication: AbsPublishResult;
      try {
        publication = await store.commit(projection.map.generation, assertCurrent, async (text, expectedHash, storage) => {
          assertCurrent();
          if (!prepared) throw new AbsSyncError('ABS_EXPORT_SAVE_FORBIDDEN', 'This publication has no prepared derived ABI.');
          if (text !== prepared.abiText || !await storage.replace('project.abi', expectedHash, text)) {
            throw new AbsSyncError('ABS_ABI_COMMIT_CONFLICT', 'Prepared ABI changed before commit.');
          }
        });
      } catch (error) {
        if (prepared && context.isCurrent()) lease.quarantine(`Turn synchronization commit needs inspection: ${String(error)}`);
        throw error;
      }
      let derived = describeAbsDerivedOutputs(generated);
      const requiresReload = !!prepared && publication.abiSaved && publication.status !== 'COMMITTED';
      if (requiresReload) lease.quarantine('Canvas saved but generation publication is pending; inspect before reopening.');
      if (publication.status === 'COMMITTED') {
        assertCurrent();
        if (prepared) {
          try { await this.withViewChecks(() => this.project.publishPreparedSaveOutputs(context.path, prepared, generated ?? null, () => { assertCurrent(); })); }
          catch (error) {
            derived = describeAbsDerivedOutputs(generated, { error });
          }
        }
        this.withViewChecks(() => this.editor.publishAbsContext(projection, assertCurrent().revision, context.assertCurrent));
      }
      return { publication, requiresReload, warnings: derived.warnings, derivedOutputs: derived.output, ...(draftArchive ? { draftArchive,
          inputAbiHash: expected.abi === null ? null : await hashAbsText(expected.abi) } : {}),
        ...(publication.status === 'COMMITTED' ? { evidence, abs: projection.abs } : {}) };
    });
  }

  /** Only explicit manual-disable/collapse intents. Ordinary ABS edits retain all
   * user state. IDs come from bounded inspection, never guessed from block order. */
  setBlockState(input: unknown): Promise<any> {
    const request = readAbsBlockStateRequest(input);
    return this.run(async (context, lease, store) => {
      const assertCurrent = () => { context.assertCurrent(); lease.assertCurrent(); };
      assertCurrent();
      if (request.action === 'inspect') {
        let committed: AbsProjection | null = null, baseline: { status: string; code?: string };
        let expectedCanvas: string | undefined;
        let assertInspection: (() => unknown) | undefined;
        try {
          committed = await store.loadCommitted();
          baseline = { status: committed ? 'committed' : 'missing' };
          if (!committed) {
            const disk = await store.captureDisk();
            if (await store.inspectPending()) baseline = { status: 'unavailable', code: 'ABS_TRANSACTION_PENDING' };
            else if (disk.map !== null) baseline = { status: 'unavailable', code: 'ABS_INITIALIZATION_REQUIRED' };
            else {
              const snapshot = this.editor.captureProjectSnapshot(lease);
              assertCurrent();
              assertInspection = this.atRevision(context.assertCurrent, lease, snapshot);
              expectedCanvas = this.blockStateAdmission.issue(absJson({ scope: context.scope,
                runtimeRevision: context.runtimeRevision, session: context.session, snapshot, disk }), () => {
                try { context.assertCurrent(); return true; } catch { return false; }
              });
            }
          }
        } catch (error) {
          baseline = { status: 'unavailable', code: (error as any)?.code ?? 'ABS_STATE_INSPECTION_UNAVAILABLE' };
        }
        assertCurrent();
        const result = inspectLiveBlockStates(context.workspace, request);
        assertInspection?.();
        const locations = new Map(committed?.map.nodes.map(node => [node.blockId, node]) ?? []);
        return { ok: true, operation: 'blocks_set_state', project: context.path, requiresReload: false,
          ...(committed ? { expectedGeneration: committed.map.generation } : { baseline }),
          ...(expectedCanvas ? { expectedCanvas } : {}), ...result,
          instances: result.instances.map(state => {
            const node = locations.get(state.blockId);
            return { ...state, ...(node ? { sourceRange: { start: node.start, end: node.end }, astPath: node.astPath,
              source: 'committed-abs', sourceGeneration: committed!.map.generation } : {}) };
          }), receipt: { version: 2, requestId: request.requestId, action: 'inspect', ...(expectedCanvas ? { expectedCanvas } : {}) } };
      }
      const committed = await store.loadCommitted();
      if (committed ? request.expectedCanvas !== undefined || request.expectedGeneration !== committed.map.generation
        : request.expectedCanvas === undefined) {
        throw new AbsSyncError('ABS_BASELINE_STALE', 'Inspect current block states and use their exact generation or first-baseline canvas token before updating.');
      }
      const expected = await store.captureDisk();
      if (committed && expected.abi === null) throw new AbsSyncError('ABS_BASELINE_MISSING', 'Save/export the current canvas before changing block state.');
      if (await store.inspectPending()) throw new AbsSyncError('ABS_TRANSACTION_PENDING', 'Inspect and recover the pending generation before changing block state.');
      if (committed) this.assertMirrors(committed, expected, true);
      else if (expected.map !== null) throw new AbsSyncError('ABS_INITIALIZATION_REQUIRED', 'An orphan map cannot authorize first-baseline state changes. Inspect project recovery.');
      assertCurrent();
      const before = this.editor.captureProjectSnapshot(lease);
      if (!committed) this.blockStateAdmission.consume(request.expectedCanvas!, absJson({ scope: context.scope,
        runtimeRevision: context.runtimeRevision, session: context.session, snapshot: before, disk: expected }));
      // A user may explicitly disable a block whose active option provider is
      // broken. State admission needs complete serialized data, not execution
      // of that provider before the requested disable can take effect.
      const captureState = () => {
        assertCurrent();
        const state = normalizeAbsSerializedWorkspace(window['Blockly'].serialization.workspaces.save(context.workspace));
        assertCurrent(); return state;
      };
      const rollback = captureState();
      const plan = planAbsBlockStateChanges(rollback, request);
      const operation = prepareLiveBlockStateOperation(context.workspace, plan, assertCurrent);
      const restore = () => {
        this.withViewChecks(() => operation.restore());
        assertAbsReadback(rollback, captureState());
      };
      const inputAbiHash = expected.abi === null ? null : await hashAbsText(expected.abi);
      await this.assertDisk(store, expected, this.atRevision(context.assertCurrent, lease, before));
      let mutated = false;
      try {
        mutated = true;
        this.withViewChecks(() => operation.apply());
        assertAbsReadback(plan.workspace, captureState());
        // The editor handles generation/model registration as it does for a
        // normal user state change. The save seal captures the resulting models.
        const outcome = await this.exportInContext(context, lease, store, { save: true }, { expected, generation: committed?.map.generation ?? null });
        if (outcome.publication.status === 'NOT_COMMITTED' && !outcome.publication.abiSaved) {
          restore();
          return { ok: false, operation: 'blocks_set_state', project: context.path, ...outcome,
            projectSaved: false, partial: false, application: 'ROLLED_BACK', code: 'ABS_BLOCK_STATE_SAVE_INCOMPLETE',
            error: outcome.publication.error ?? 'State change was restored because the ABI did not commit. Inspect the preserved pending generation before retrying.' };
        }
        const committedOutput = outcome.publication.status === 'COMMITTED' && !!outcome.evidence && typeof outcome.abs === 'string';
        const partial = !committedOutput || outcome.requiresReload || outcome.derivedOutputs?.published === false;
        return { ok: !partial, operation: 'blocks_set_state', project: context.path, ...outcome,
          projectSaved: outcome.publication.abiSaved, partial,
          ...(partial ? { code: committedOutput ? outcome.derivedOutputs?.code ?? 'PROJECT_DERIVED_OUTPUT_PENDING' : 'ABS_BLOCK_STATE_SAVE_INCOMPLETE',
            error: outcome.derivedOutputs?.error ?? outcome.publication.error ?? (outcome.warnings.join('\n') || 'Block state publication requires inspection.') } : {}),
          receipt: { version: 2, requestId: request.requestId, action: 'update',
            ...(request.expectedCanvas ? { expectedCanvas: request.expectedCanvas } : { expectedGeneration: request.expectedGeneration }),
            changes: request.changes, inputAbiHash, beforeStates: plan.beforeStates, states: operation.states(),
            ...(committedOutput ? { output: outcome.evidence } : {}) } };
      } catch (error) {
        // Never roll a committed/uncertain generation back behind its files. Only
        // an unchanged disk with no journal permits restoring these tracked flags.
        let application = 'NOT_STARTED', rollbackError: unknown;
        if (mutated) {
          application = 'UNKNOWN';
          try {
            assertCurrent();
            if (!await store.inspectPending() && absJson(await store.captureDisk()) === absJson(expected)) {
              restore();
              application = 'ROLLED_BACK';
            }
          } catch (failure) { rollbackError = failure; }
        }
        const failure = serializeAbsFailure(error);
        if (application === 'UNKNOWN' && context.isCurrent()) {
          lease.quarantine('Block state publication or rollback is uncertain; inspect project recovery before another mutation.');
        }
        return { ok: false, operation: 'blocks_set_state', project: context.path, ...failure, application,
          requiresReload: application === 'UNKNOWN', partial: application === 'UNKNOWN',
          ...(rollbackError ? { rollbackError: serializeAbsFailure(rollbackError) } : {}),
          recovery: 'Inspect project recovery and current block states before another mutation. Do not repeat a state change with an old generation or clear library disabled reasons.' };
      }
    }, request.action !== 'inspect');
  }

  validateGeneration(source: string, request: AbsGenerationCandidateRequest): Promise<AbsGenerationValidation & { syntaxAdvice: ReturnType<typeof describePreparedAbsSyntax> }> {
    if (['preparedModels', 'preparedVariables', 'retiredModels', 'workspaceRevision'].some(key => Object.hasOwn(request, key))) {
      return Promise.reject(new AbsSyncError('ABS_REQUEST_INVALID', 'Preparation evidence is host output, not candidate input.'));
    }
    request = JSON.parse(absJson(request));
    return this.run(async (context, lease, store) => {
      const { requestId, ...intent } = request;
      // Tool-level dry-run followed by apply has a new transport nonce, not a
      // new candidate. Explicit variable IDs, however, are request-bound.
      const requestKey = absJson({ ...intent, ...(request.createVariables?.length ? { requestId } : {}) });
      const cached = this.preparedValidation;
      const reuse = cached?.source === source && cached.requestKey === requestKey && cached.expires >= Date.now();
      if (!reuse) this.preparedValidation = undefined;
      // Reuse the same disk/program/runtime/contract checks as application. No
      // receipt-only cache and no bypass of edits made after the first dry-run.
      // Preparation owns detached candidate data, not Angular view publication.
      // Include pure analysis/storage reads, not only the native iframe phase.
      const prepared = await this.withoutViewChecks(() => reuse
        ? this.prepareApplication(context, lease, store, source, request.base.generation, cached.validation)
        : this.prepareGeneration(context, lease, store, source, request.base.generation, request));
      const result = { ...request, workspaceRevision: prepared.before.revision,
        ...(prepared.preparedModels.length ? { preparedModels: prepared.preparedModels } : {}),
        ...(prepared.candidate.retiredModels.length ? { retiredModels: prepared.candidate.retiredModels } : {}),
        syntaxAdvice: describePreparedAbsSyntax(prepared.candidate.workspace, prepared.candidate.contracts, prepared.candidate.identities),
        ...(request.createVariables ? { preparedVariables: planAbsVariableCreations({ requestId: request.requestId, variables: request.createVariables }) } : {}) };
      this.preparedValidation = { source, key: this.validationKey(result), requestKey, validation: result,
        expires: reuse ? cached.expires : Date.now() + 30000, prepared };
      return result;
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
      const committed = await store.loadCommitted();
      if (!committed) throw new AbsSyncError('ABS_BASELINE_MISSING', 'An authoritative committed generation is required.');
      if (generation !== committed.map.generation) throw new AbsSyncError('ABS_BASELINE_STALE', 'The candidate belongs to another generation.');
      const requestPriority = binding?.concurrentEdits === 'request-priority';
      const baseline = requestPriority ? await store.load(binding!.intentGeneration!) : committed;
      this.assertMirrors(committed, expected, false);
      if (binding) {
        const evidence = await generationEvidence(committed, expected.abi);
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
      if (!requestPriority && binding && 'workspaceRevision' in binding && binding.workspaceRevision !== before.revision && !unchanged) {
        throw new AbsSyncError('ABS_REVISION_STALE', 'Program changed after candidate validation.');
      }
      assertAbsBaselineContext(committed.map, {
        generation, scope: context.scope,
        currentAbiHash: requestPriority || unchanged ? committed.map.baseAbiHash : await hashAbsText(absJson(compact)),
        currentPageAbiHash: requestPriority || unchanged ? committed.map.pageAbiHash : await hashAbsText(absJson(composeBlocklyPage(compact, context.scope.pageId))),
        savedAbiHash: expected.abi === null ? null : await hashAbsText(absJson(JSON.parse(expected.abi))),
      });
      if (requestPriority) {
        // Added/removed user blocks change the instance catalogue, not the
        // library protocol. Compare surviving identities; merged nodes still
        // require declared shape checks and complete native readback below.
        const ids = new Set(Object.keys(baseline.contracts.fields).filter(id => Object.hasOwn(rollback.contracts.fields, id)));
        const retained = (contracts: AbsProjectionContracts): AbsProjectionContracts => {
          const pick = (record: Record<string, any> | undefined) => Object.fromEntries(Object.entries(record ?? {}).filter(([id]) => ids.has(id)));
          return { ...contracts, fields: pick(contracts.fields), syntax: pick(contracts.syntax),
            selectors: pick(contracts.selectors), procedures: pick(contracts.procedures) };
        };
        assertAbsContractsCompatible(retained(baseline.contracts), retained(rollback.contracts), rollback.state);
      } else assertAbsContractsCompatible(baseline.contracts, rollback.contracts, rollback.state);
      assertPreparing();
      const readDefinitions = context.definitions.withSynchronousRead ?? (<T>(read: () => T) => read());
      const functionSyntax = readDefinitions(() => custom.syntax(source, baseline.workspace));
      const reconcileOptions: AbsReconcileOptions = {
        withSynchronousRead: readDefinitions,
        sourceEdits: binding?.sourceEdits,
        prepareExtraState: functionSyntax.prepareExtraState,
        declaration: captureAbsVariableDeclarations(context.definitions, shapes.get),
        argumentOrder: (type, extra, fields) => functionSyntax.argumentOrder?.(type, extra, fields) ?? shapes.get(type, extra, fields)?.argumentOrder,
        fieldSelectors: type => shapes.get(type)?.fieldShape?.map(rule => rule.field),
        fieldDefinition: (type, name, id) => custom.field(type, name)
          ?? (requestPriority && id && !Object.hasOwn(rollback.contracts.fields, id)
            ? baseline.contracts.fields[id]?.[name] : rollback.fieldDefinition(type, name, id))
          ?? shapes.get(type)?.fields[name],
        blockContract: shapes.get, prepareBlock: (block, previous, workspace, contracts) => {
          procedures.prepare(block, previous, workspace, contracts); custom.prepare(block, previous, workspace, contracts);
        },
        hostPrepared: type => !!context.definitions.procedure?.(type) || !!custom.describe(type),
        ...(binding?.createVariables ? { variableCreation: { requestId: binding.requestId, variables: binding.createVariables } } : {}),
      };
      const precheck = readDefinitions(() => precheckAbs(source, { ...reconcileOptions, blockContract, deferType: reconcileOptions.hostPrepared,
        knownType: type => context.definitions.types.includes(type) }));
      if (!precheck.ok) throw new AbsPrecheckFailure(precheck);
      assertAbsProcedureModelIntents(source, binding?.createVariables, reconcileOptions, type => {
        if (custom.describe(type)?.protocol.kind === 'definition') return { nameField: 'FUNC_NAME', modelType: 'FUNC' };
        return context.definitions.procedure?.(type)?.role === 'definition' ? {} : undefined;
      });
      const reconciler = this.reconcile(baseline, source, absJson({
        runtimeRevision: context.runtimeRevision, session: context.session, contracts: rollback.contracts,
      }));
      let candidate: Awaited<ReturnType<typeof prepareAbsReconciledResources>>;
      let materialized: Awaited<ReturnType<typeof candidate.materialize>>;
      let instances: ReadonlyMap<string, AbsNativeInstance> | undefined;
      let preparedModels: NonNullable<AbsGenerationValidation['preparedModels']> = [];
      // Unlike assertPreparing, this guard does not capture the short-lived lease.
      let assertRuntimeCurrent = context.assertCurrent;
      let needsNative = false;
      try {
        assertPreparing();
        const draft = await reconciler.draft(reconcileOptions);
        assertPreparing();
        // A declarative JSON shape says nothing about generator-created models.
        // New blocks must get the same native preparation even without a consumer.
        needsNative = draft.added.length > 0 && typeof this.editor.captureNativeReplay === 'function';
        // Only the final authoritative draft needs resource externalization and
        // hydration. Native preparation discards this provisional draft, but its
        // strict syntax/identity/field/protection checks above still run.
        if (!needsNative) {
          candidate = await prepareAbsReconciledResources(source, draft, assertPreparing);
          materialized = await candidate.materialize();
          assertPreparing();
          this.assertRuntimeShape(context.definitions, rollback.state, materialized, candidate.contracts, blockContract);
        }
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
        assertRuntimeCurrent = () => { context.assertCurrent(); replay.assertCurrent(); };
        const assertNative = () => { assertPreparing(); replay.assertCurrent(); };
        // The realm only sees detached input and cannot access the host workspace.
        // Keep cheap ownership/runtime checks inside its transport; reconciliation
        // checks the full host program before and after each isolated execution,
        // before trusting the result. Do not reserialize it at every iframe event.
        const assertNativeScope = () => { assertRuntimeCurrent(); lease.assertCurrent(); };
        const { evaluateNativeCandidate } = await import('../../../editors/blockly-editor/services/blockly-native-candidate');
        const execute = createNativeCandidateRecovery((request, options) =>
          evaluateNativeCandidate(request, { ...options, assertCurrent: assertNativeScope }), assertNative);
        const prepared = await prepareAbsNativeReconciliation(reconciler, reconcileOptions,
          request => execute({ ...request, steps: replay.steps, graphics: replay.graphics }), assertNative);
        ({ candidate, materialized, instances, preparedModels } = prepared);
      }
      if (binding && 'workspaceRevision' in binding && absJson(binding.preparedModels ?? []) !== absJson(preparedModels)) {
        throw new AbsSyncError('ABS_MODEL_DECLARATION_CHANGED', 'Native model preparation changed after validation. Validate the same candidate again.');
      }
      if (binding && 'workspaceRevision' in binding && absJson(binding.retiredModels ?? []) !== absJson(candidate.retiredModels)) {
        throw new AbsSyncError('ABS_MODEL_DECLARATION_CHANGED', 'Retired model evidence changed after validation. Validate the same candidate again.');
      }
      assertPreparing();
      let historyBase: AbsWorkspaceSyncOutcome['historyBase'];
      if (requestPriority) {
        let currentWorkspace = composeBlocklyPage(compact, context.scope.pageId);
        let historyContracts = rollback.contracts;
        // An inline caller can coexist with a separately edited public draft.
        // Resolve its public syntax against the committed generation, never by
        // adopting a public state section as authority.
        if (expected.abs !== null && expected.abs !== committed.abs && expected.abs !== source) {
          const draftBase = splitAbsState(expected.abs).state === splitAbsState(baseline.abs).state ? baseline : committed;
          const draft = await this.reconcile(draftBase, expected.abs, absJson({ runtimeRevision: context.runtimeRevision, session: context.session }))
            .draft({ ...reconcileOptions, sourceEdits: undefined });
          const user = await prepareAbsReconciledResources(expected.abs, draft, assertPreparing);
          currentWorkspace = mergeAbsRequestWorkspace(draftBase.workspace, currentWorkspace, user.workspace);
          historyContracts = { ...rollback.contracts,
            fields: { ...rollback.contracts.fields, ...user.contracts.fields },
            procedures: { ...rollback.contracts.procedures, ...user.contracts.procedures } };
          candidate.contracts = { ...candidate.contracts, fields: { ...user.contracts.fields, ...candidate.contracts.fields } };
        }
        const userResources = await prepareAbsProjectData(currentWorkspace, assertPreparing);
        this.assertRuntimeShape(context.definitions, rollback.state, await userResources.materialize(), historyContracts, blockContract);
        const userDocument = replaceBlocklyPageWorkspace(compact, context.scope.pageId, currentWorkspace,
          block => historyContracts.procedures?.[block.id]?.role);
        const userProjection = await this.projection(userDocument, historyContracts, expected.abi, context.scope, assertPreparing);
        historyBase = { snapshot: userProjection.abs, hash: await hashAbsText(userProjection.abs),
          inputAbsHash: expected.abs === null ? null : await hashAbsText(expected.abs) };
        const merged = mergeAbsRequestWorkspace(baseline.workspace, currentWorkspace, candidate.workspace);
        const resources = await prepareAbsProjectData(merged, assertPreparing);
        materialized = await resources.materialize();
        candidate.contracts = { ...candidate.contracts,
          fields: { ...rollback.contracts.fields, ...candidate.contracts.fields },
          procedures: { ...rollback.contracts.procedures, ...candidate.contracts.procedures } };
        assertPreparing();
      }
      // Persistence composes shared definitions before page-local roots. Apply the
      // same stable partition before loading, so save/page switch/reopen cannot
      // change the live root order. Only captured/prepared ownership is authority.
      orderAbsSharedRoots(materialized, before.document, candidate.contracts);
      this.assertRuntimeShape(context.definitions, rollback.state, materialized, candidate.contracts, blockContract, instances);
      await this.assertDisk(store, expected, assertPreparing);
      // Code remains bound to the generation; layout follows the latest editor
      // snapshot, including moves made since export or during native preparation.
      const current = assertPreparing();
      const currentWorkspace = composeBlocklyPage(current.document, context.scope.pageId);
      retainAbsRootLayout(materialized, currentWorkspace);
      retainAbsRootLayout(rollback.state, currentWorkspace);
      this.editor.assertWorkspaceSharedChange(current.document, materialized, lease);
      return { expected, baselineSource: baseline.abs, before: current, rollback, candidate, materialized, preparedModels, assertRuntimeCurrent, historyBase };
  }

  private validationKey(value: AbsGenerationValidation): string {
    const keys = ['version', 'requestId', 'base', 'candidate', 'workspaceRevision', 'sourceEdits',
      'createVariables', 'preparedVariables', 'preparedModels', 'retiredModels', 'concurrentEdits', 'intentGeneration'];
    return absJson(Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])));
  }

  private async prepareApplication(context: ReturnType<AbsWorkspaceSyncService['context']>, lease: BlocklyWorkspaceEditLease,
    store: AbsBaselineStore, source: string, generation: string, validation?: AbsGenerationValidation) {
    const cached = this.preparedValidation;
    this.preparedValidation = undefined; // Never replay a consumed or failed application.
    if (!validation || !cached || cached.expires < Date.now() || cached.source !== source
      || validation.base.generation !== generation || cached.key !== this.validationKey(validation)) {
      return this.prepareGeneration(context, lease, store, source, generation, validation);
    }
    const prepared = cached.prepared;
    prepared.assertRuntimeCurrent(); context.assertCurrent(); lease.assertCurrent();
    const before = this.editor.captureProjectSnapshot(lease);
    if (!sameAbsProgram(prepared.before.document, before.document)) {
      if (validation.concurrentEdits === 'request-priority') return this.prepareGeneration(context, lease, store, source, generation, validation);
      throw new AbsSyncError('ABS_REVISION_STALE', 'Program changed after candidate validation.');
    }
    const assertCurrent = this.atRevision(() => { prepared.assertRuntimeCurrent(); context.assertCurrent(); }, lease, before);
    if (await store.inspectPending()) throw new AbsSyncError('ABS_TRANSACTION_PENDING', 'Recover the pending generation first.');
    const baseline = await store.loadCommitted();
    assertCurrent();
    if (baseline?.map.generation !== generation) throw new AbsSyncError('ABS_BASELINE_STALE', 'Generation changed after validation.');
    const expected = await store.captureDisk();
    assertCurrent();
    // An Agent may persist these exact candidate bytes after validation. No
    // unrelated draft, ABI edit or map/generation change may reuse preparation.
    if (expected.abi !== prepared.expected.abi || expected.map !== prepared.expected.map
      || expected.abs !== prepared.expected.abs && expected.abs !== source) {
      if (validation.concurrentEdits === 'request-priority' && expected.abi === prepared.expected.abi && expected.map === prepared.expected.map)
        return this.prepareGeneration(context, lease, store, source, generation, validation);
      throw new AbsSyncError('ABS_DISK_CONFLICT', 'Project files changed after candidate validation.');
    }
    this.assertMirrors(baseline, expected, false);
    await this.assertDisk(store, expected, assertCurrent);
    // Layout may change while the disk checks await. Capture it only after the
    // final asynchronous boundary, just like a freshly prepared application.
    const current = assertCurrent();
    // Field inspection is synchronous. Its per-field guard must not recursively
    // serialize the entire project; compare the program at the boundaries.
    const rollback = captureAbsWorkspaceState(context.workspace, assertCurrent, context.definitions, context.assertCurrent);
    assertAbsContractsCompatible(prepared.rollback.contracts, rollback.contracts, rollback.state);
    const materialized = cloneBlocklyJson(prepared.materialized);
    retainAbsRootLayout(materialized, composeBlocklyPage(current.document, context.scope.pageId));
    this.editor.assertWorkspaceSharedChange(current.document, materialized, lease);
    return { ...prepared, expected, before: current, rollback, materialized };
  }

  applyGeneration(source: string, generation: string, options: AbsWorkspaceLoadOptions = {}, validation?: AbsGenerationValidation): Promise<AbsWorkspaceSyncOutcome> {
    options = { ...options };
    if (validation) validation = JSON.parse(absJson(validation));
    return this.run(async (context, lease, store) => {
      const { expected, before, rollback, candidate, materialized, historyBase } = await this.withoutViewChecks(async () => {
        try {
          const prepared = await this.prepareApplication(context, lease, store, source, generation, validation);
          // Validation is read-only and may inspect any candidate. Application
          // must never adopt another writer's draft, even if it was already
          // present at validation or the prepared handoff has since expired.
          if (validation?.concurrentEdits !== 'request-priority' && prepared.expected.abs !== prepared.baselineSource && prepared.expected.abs !== source) {
            throw new AbsSyncError('ABS_SOURCE_CONFLICT', 'ABS contains another unapplied edit. Preserve both candidates and read the current draft before preparing a new edit; do not overwrite it or rebind the old candidate.');
          }
          return prepared;
        } catch (error) { throw new AbsApplicationFailure(error, 'NOT_STARTED'); }
      });

      let mutated = false, commitStarted = false;
      let publication: AbsPublishResult | undefined;
      const runtime = window['Blockly'];
      const group = runtime.Events.getGroup(), recordUndo = runtime.Events.getRecordUndo();
      const restore = async () => {
        mutated = false; // Never retry a failed rollback.
        context.assertCurrent(); lease.assertCurrent();
        const comments = new BlocklyCommentLoading(runtime, context.workspace);
        runtime.Events.disable();
        try {
          comments.run(() => this.editor.restoreProjectWorkspaceSnapshot(before.document, lease, rollback.state.blocks.blocks.map(block => block.id)));
          await comments.finish(() => { context.assertCurrent(); lease.assertCurrent(); });
        } finally { runtime.Events.enable(); }
        context.definitions.customFunctions?.synchronize(context.workspace, rollback.state);
        const restored = captureAbsWorkspaceState(context.workspace, context.assertCurrent, context.definitions);
        assertAbsWorkspaceReadback(rollback.state, restored.state, rollback, context.definitions);
      };
      try {
        mutated = true;
        const loadOptions = options.onProgress && this.zone ? { ...options,
          onProgress: (blocks: number, batches: number) => this.zone!.run(() => options.onProgress!(blocks, batches)),
        } : options;
        // A formatting-only edit may prepare the exact state already on the
        // canvas. Zero delta requires no native callbacks: preserve instances
        // rather than clearing and rebuilding them. Compare the whole state,
        // including dormant shadows, models, root order/layout and serializers.
        // Any difference keeps the existing complete-load path. All readback,
        // generation, save/commit and rollback checks below still apply.
        if (absJson(materialized) !== absJson(rollback.state)) {
          await this.withoutViewChecks(() => loadAbsWorkspaceState(materialized, context.workspace, loadOptions, context.assertCurrent, candidate.contracts));
          context.definitions.customFunctions?.synchronize(context.workspace, materialized);
          layoutAbsNewRoots(materialized, candidate.added, context.workspace, context.assertCurrent);
        }
        // Library model registration belongs before complete readback and the save seal.
        const generated = await this.editor.prepareProjectCode(context.assertCurrent, lease);
        context.assertCurrent();
        const actual = captureAbsWorkspaceState(context.workspace, context.assertCurrent, context.definitions);
        assertAbsWorkspaceReadback(materialized, actual.state, actual, context.definitions);
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
          await restore();
          return { publication, requiresReload: false, warnings: [] };
        }
        if (publication.status !== 'COMMITTED') {
          lease.quarantine('ABI was saved but generation publication is pending; inspect and explicitly recover before reopening.');
          return { publication, requiresReload: true, warnings: [] };
        }
        assertApplied();
        let derived = describeAbsDerivedOutputs(generated);
        try { await this.project.publishPreparedSaveOutputs(context.path, prepared, generated, () => { assertApplied(); }); }
        catch (error) { derived = describeAbsDerivedOutputs(generated, { error }); }
        const published = assertApplied();
        this.editor.publishAbsContext(projection, published.revision, context.assertCurrent);
        return { publication, appliedRevision: published.revision, requiresReload: false,
          warnings: derived.warnings, derivedOutputs: derived.output, evidence,
          ...(historyBase ? { historyBase } : {}) };
      } catch (error) {
        if (mutated && context.isCurrent()) {
          if (commitStarted) {
            // An interrupted host acknowledgement or saved ABI is not safe to undo in memory.
            lease.quarantine(`Generation commit needs explicit inspection: ${String(error)}`);
          } else {
            try { await restore(); }
            catch (rollbackError) {
              const reason = `Rollback failed; reopen the project: ${String(rollbackError)}. Original failure: ${String(error)}`;
              lease.quarantine(reason);
              throw new AbsSyncError('ABS_ROLLBACK_FAILED', reason);
            }
            throw new AbsApplicationFailure(error, 'ROLLED_BACK');
          }
        }
        throw error;
      } finally {
        if (context.isCurrent()) {
          this.editor.markWorkspaceCodeDirty();
          runtime.Events.setGroup(group); runtime.Events.setRecordUndo(recordUndo);
          // Native loading suppressed change events. Refresh the final canvas,
          // including a restored snapshot on failure, once its edit lease ends.
          this.editor.requestWorkspaceVisualRefresh();
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
    const inspection = await inspectAbsGenerationForRecovery(await this.store(context), context.scope)
      .catch(error => { context.assertCurrent(); throw error; });
    context.assertCurrent();
    const completed = this.completedJournalReopen;
    if (completed) {
      const observed = await this.observeJournalReopen(completed.generation, completed.token);
      if (observed) return { pending: inspection.pending, diagnostics: { ...inspection.diagnostics,
        reopen: { action: 'reopen' as const, generation: completed.generation, token: completed.token,
          scope: context.scope, reused: true } } };
    }
    if (this.journalReopen.matches()) {
      // A recovered journal may leave the old native canvas quarantined. Read
      // its complete state without taking a write lease or invoking generators.
      try {
        const observation = await this.captureJournalReopen(context);
        const reopen = await this.journalReopen.offer(observation);
        context.assertCurrent();
        if (reopen) return { pending: inspection.pending, diagnostics: { ...inspection.diagnostics, reopen } };
      } catch (error) {
        const failure = serializeAbsFailure(error);
        return { pending: inspection.pending, diagnostics: { ...inspection.diagnostics,
          reopenBlocked: failure } };
      }
    }
    if (canInspectAbsDraft(inspection) || inspection.committed && !inspection.pending && inspection.diagnostics.issues.length > 0) {
      return this.run(async (context, lease, store) => {
        const current = await inspectAbsGeneration(store, context.scope);
        const snapshot = this.editor.captureProjectSnapshot(lease);
        const assertCurrent = this.atRevision(context.assertCurrent, lease, snapshot);
        const runtime = captureAbsWorkspaceState(context.workspace, assertCurrent, context.definitions,
          () => { context.assertCurrent(); lease.assertCurrent(); });
        const diagnostics = await inspectAbsDraft(current, snapshot.document, runtime);
        diagnostics.repair = await describeAbsRepair({ ...current, diagnostics }, snapshot.document, runtime.contracts);
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

  /** Explicit, archived derivative rebuild. Never parses the old draft as authority. */
  repairGeneration(token: string, authority: string): Promise<AbsWorkspaceSyncOutcome> {
    if (authority !== 'workspace') return Promise.reject(new AbsSyncError('ABS_REPAIR_AUTHORITY_INVALID', 'Repair requires authority=workspace.'));
    return this.run(async (context, lease, store) => {
      const inspection = await inspectAbsGeneration(store, context.scope);
      let snapshot = this.editor.captureProjectSnapshot(lease);
      let guard = this.atRevision(context.assertCurrent, lease, snapshot);
      let runtime = captureAbsWorkspaceState(context.workspace, guard, context.definitions,
        () => { context.assertCurrent(); lease.assertCurrent(); });
      // A lost reply must not turn a completed repair into another dead end.
      // Reuse only the exact committed result, never a historical draft or log.
      if (inspection.committed && !inspection.pending && inspection.diagnostics.issues.length === 0
        && sameAbsProgram(snapshot.document, inspection.committed.projection.document)
        && absJson(runtime.contracts) === absJson(inspection.committed.projection.contracts)
        && await hashAbsText(absJson(JSON.parse(inspection.disk.abi!))) === inspection.committed.projection.map.savedAbiHash) {
        try {
          const previous = await store.inspectRepair(inspection.committed.projection.map.generation);
          if (previous.archive.repairToken === token) {
            await this.assertDisk(store, inspection.disk, guard);
            if ((await store.inspectCommitted())?.pointerHash !== inspection.committed.pointerHash) throw new AbsSyncError('ABS_REPAIR_STALE', 'Committed repair changed.');
            const projection = inspection.committed.projection;
            const evidence = await generationEvidence(projection, inspection.disk.abi);
            const derived = this.repairDerived.observe(token, evidence.binding);
            guard(); this.editor.publishAbsContext(projection, snapshot.revision, context.assertCurrent);
            return { publication: { status: 'COMMITTED', generation: projection.map.generation,
              abiSaved: true, absMirrored: true, mapPublished: true }, requiresReload: false,
              warnings: derived.warnings, derivedOutputs: derived.output,
              recoveryArchive: previous.recoveryArchive, evidence, abs: projection.abs, reused: true,
              inputAbiHash: previous.recoveryArchive.files.abi.hash };
          }
        } catch (error) { if ((error as any)?.code !== 'ABS_RECOVERY_ARCHIVE_MISSING') throw error; }
      }
      const readiness = await inspectAbsDraft(inspection, snapshot.document, runtime);
      const offer = await describeAbsRepair({ ...inspection, diagnostics: readiness }, snapshot.document, runtime.contracts);
      guard();
      if (!offer || token !== offer.token) throw new AbsSyncError('ABS_REPAIR_STALE', 'Repair token no longer matches the inspected inputs and canvas. Inspect again.');
      const generation = crypto.randomUUID();
      const archive = await store.archiveRepair(generation, inspection.disk, inspection.committed!.pointerHash,
        absJson(snapshot.document), token, guard);
      guard();
      const generated = await this.withViewChecks(() => this.editor.prepareProjectCode(context.assertCurrent, lease));
      context.assertCurrent();
      snapshot = this.editor.captureProjectSnapshot(lease);
      if (generated && generated.revision !== snapshot.revision) throw new AbsSyncError('ABS_RUNTIME_CAPTURE_CHANGED', 'Code preparation changed before repair.');
      guard = this.atRevision(context.assertCurrent, lease, snapshot);
      const prepared = await this.project.prepareSave(snapshot.document, guard);
      runtime = captureAbsWorkspaceState(context.workspace, guard, context.definitions,
        () => { context.assertCurrent(); lease.assertCurrent(); });
      const compact = await this.compactDocument(snapshot.document, runtime.contracts, guard);
      const projection = await this.projection(compact, runtime.contracts, prepared.abiText, context.scope, guard, generation);
      const evidence = await generationEvidence(projection, prepared.abiText);
      await this.assertDisk(store, inspection.disk, guard);
      await store.stage({ projection, mode: 'import', abi: prepared.abiText,
        inputAbs: inspection.disk.abs ?? projection.abs, inputMap: inspection.disk.map, expected: inspection.disk,
        recoveryArchive: { key: archive.key, hash: archive.hash } }, inspection.committed!.pointerHash);
      let publication: AbsPublishResult;
      try {
        publication = await store.commit(generation, guard, async (text, expectedHash, storage) => {
          guard();
          if (text !== prepared.abiText || !await storage.replace('project.abi', expectedHash, text)) {
            throw new AbsSyncError('ABS_ABI_COMMIT_CONFLICT', 'Project ABI changed during repair.');
          }
        });
      } catch (error) {
        // Repair never replaces the live canvas. The pending journal / current
        // generation still fences normal writes; do not add a permanent editor
        // quarantine that would also block inspection and recovery snapshots.
        throw new AbsSyncError('ABS_REPAIR_OUTCOME_UNKNOWN', `Repair commit acknowledgement is unknown: ${String(error)}`,
          undefined, [], { hint: 'Preserve the candidate and token. Inspect once; recover a pending journal, or retrieve the already committed repair with the same token. Do not assume rollback or delete recovery records.' });
      }
      const requiresReload = publication.abiSaved && publication.status !== 'COMMITTED';
      if (requiresReload) lease.quarantine('Repair ABI committed; finish the existing generation recovery before writing.');
      let derived = describeAbsDerivedOutputs(generated);
      if (publication.status === 'COMMITTED') {
        try { await this.project.publishPreparedSaveOutputs(context.path, prepared, generated, () => { guard(); }); }
        catch (error) { derived = describeAbsDerivedOutputs(generated, { error }); }
        this.editor.publishAbsContext(projection, guard().revision, context.assertCurrent);
        this.repairDerived.remember(token, evidence.binding, derived);
      }
      return { publication, requiresReload, warnings: derived.warnings, derivedOutputs: derived.output, recoveryArchive: archive,
        inputAbiHash: inspection.disk.abi === null ? null : await hashAbsText(inspection.disk.abi),
        ...(publication.status === 'COMMITTED' ? { evidence, abs: projection.abs } : {}) };
    });
  }

  async readRepair(generation: string) {
    const context = this.context(), store = await this.store(context);
    const result = await store.readRepair(generation); context.assertCurrent(); return result;
  }

  async recoverGeneration(generation?: string, token?: string): Promise<AbsPublishResult | null> {
    const context = this.context();
    const store = await this.store(context);
    const result = await store.recover(context.assertCurrent, { generation, token }); context.assertCurrent();
    if (token && generation && result?.status === 'COMMITTED' && result.generation === generation) {
      this.journalReopen.remember(generation, token);
    }
    return result;
  }

  private async captureJournalReopen(context = this.context()): Promise<AbsJournalReopenObservation> {
    const snapshot = this.editor.captureRecoverySnapshot(), store = await this.store(context);
    const assertCurrent = () => {
      context.assertCurrent();
      if (this.editor.captureRecoverySnapshot().documentText !== snapshot.documentText) {
        throw new AbsSyncError('ABS_JOURNAL_REOPEN_STALE', 'The full canvas changed during journal recovery inspection.');
      }
    };
    const inspection = await inspectAbsGeneration(store, context.scope);
    if (!inspection.committed || inspection.pending || inspection.diagnostics.issues.length
      || !inspection.disk.abi || !this.journalReopen.matches(inspection.committed.projection.map.generation)) {
      throw new AbsSyncError('ABS_JOURNAL_REOPEN_UNAVAILABLE', 'Only the just-recovered committed journal with intact project mirrors can be reopened.');
    }
    const libraries = await window['libraryDependencies']?.status(context.path);
    if (!libraries || libraries.dirty || libraries.busy) {
      throw new AbsSyncError('ABS_JOURNAL_REOPEN_BUSY', 'Finish or recover pending dependency changes before reopening this journal.');
    }
    const saved = await materializeGenericProjectDataValues(JSON.parse(inspection.disk.abi), {
      resolve: async <TValue>(ref: AilyDataRef) => { const value = await projectDataRuntime.resolve<TValue>(ref); assertCurrent(); return value; },
    });
    const memory = this.editor.normalizeProjectAbi(this.editor.getProjectAbiForSave(snapshot.document));
    if (!sameAbsProgram(memory, this.editor.normalizeProjectAbi(saved))) {
      throw new AbsSyncError('ABS_JOURNAL_REOPEN_CANVAS_DIVERGED', 'The complete canvas differs from the recovered saved ABI. Both versions remain preserved; reopening would lose unsaved state and is not authorized.');
    }
    await this.assertDisk(store, inspection.disk, assertCurrent);
    if ((await store.inspectCommitted())?.pointerHash !== inspection.committed.pointerHash || await store.inspectPending()) {
      throw new AbsSyncError('ABS_JOURNAL_REOPEN_STALE', 'Recovered generation changed while inspecting reopen.');
    }
    assertCurrent();
    const canvasHash = await hashAbsText(snapshot.documentText); assertCurrent();
    return { generation: inspection.committed.projection.map.generation, scope: context.scope,
      pointerHash: inspection.committed.pointerHash, hashes: inspection.diagnostics.hashes,
      canvasHash, revision: snapshot.revision, runtimeRevision: context.runtimeRevision };
  }

  /** The descriptor never crosses IPC. Hold its native input fence until activation finishes. */
  async beginJournalReopen(generation: string, token: string) {
    const context = this.context();
    const release = fenceBlocklyWorkspaceInput(context.workspace.getParentSvg?.()?.parentElement ?? undefined);
    try {
      const observation = await this.captureJournalReopen(context);
      this.journalReopen.consume(generation, token, observation);
      const snapshot = this.editor.captureRecoverySnapshot();
      const assertCurrent = () => {
        context.assertCurrent();
        if (this.editor.captureRecoverySnapshot().documentText !== snapshot.documentText) {
          throw new AbsSyncError('ABS_JOURNAL_REOPEN_STALE', 'Canvas changed before recovery activation; the candidate remains unapplied.');
        }
      };
      return { path: context.path, generation, token, observation, assertCurrent, release };
    } catch (error) { release(); throw error; }
  }

  async verifyJournalReopen(input: Awaited<ReturnType<AbsWorkspaceSyncService['beginJournalReopen']>>) {
    const context = this.context(), store = await this.store(context);
    if (absJson(context.scope) !== absJson(input.observation.scope)) throw new AbsSyncError('ABS_JOURNAL_REOPEN_UNKNOWN', 'Recovery activation belongs to another project/page.');
    const inspection = await inspectAbsGeneration(store, context.scope);
    if (!inspection.committed || inspection.pending || inspection.diagnostics.issues.length
      || inspection.committed.pointerHash !== input.observation.pointerHash
      || absJson(inspection.diagnostics.hashes) !== absJson(input.observation.hashes)) {
      throw new AbsSyncError('ABS_JOURNAL_REOPEN_UNKNOWN', 'Project mirrors changed during activation; inspect before another write.');
    }
    // A newly activated workspace must also preserve every page and hidden flag.
    const snapshot = this.editor.captureRecoverySnapshot();
    const saved = await materializeGenericProjectDataValues(JSON.parse(inspection.disk.abi!), {
      resolve: async <TValue>(ref: AilyDataRef) => { const value = await projectDataRuntime.resolve<TValue>(ref); context.assertCurrent(); return value; },
    });
    if (this.editor.isWorkspaceEditBlocked() || !sameAbsProgram(
      this.editor.normalizeProjectAbi(this.editor.getProjectAbiForSave(snapshot.document)), this.editor.normalizeProjectAbi(saved))) {
      throw new AbsSyncError('ABS_JOURNAL_REOPEN_UNKNOWN', 'The activated canvas does not prove the recovered complete saved program.');
    }
    const evidence = await generationEvidence(inspection.committed.projection, inspection.disk.abi);
    await this.assertDisk(store, inspection.disk, context.assertCurrent);
    context.assertCurrent();
    if ((await store.inspectCommitted())?.pointerHash !== inspection.committed.pointerHash || await store.inspectPending()) {
      throw new AbsSyncError('ABS_JOURNAL_REOPEN_UNKNOWN', 'New canvas or generation changed before activation verification completed.');
    }
    context.assertCurrent();
    if (this.editor.captureRecoverySnapshot().documentText !== snapshot.documentText) {
      throw new AbsSyncError('ABS_JOURNAL_REOPEN_UNKNOWN', 'New canvas changed during activation verification.');
    }
    const result = { evidence, abs: inspection.committed.projection.abs,
      publication: { status: 'COMMITTED' as const, generation: input.generation,
        abiSaved: true, absMirrored: true, mapPublished: true }, requiresReload: false as const };
    this.completedJournalReopen = { generation: input.generation, token: input.token, context,
      documentText: snapshot.documentText, pointerHash: inspection.committed.pointerHash,
      hashes: inspection.diagnostics.hashes, result };
    return result;
  }

  /** A lost reply can observe one exact completed activation, never invoke it twice. */
  async observeJournalReopen(generation: string, token: string) {
    const completed = this.completedJournalReopen;
    if (!completed || completed.generation !== generation || completed.token !== token) return undefined;
    try {
      const context = this.context(); completed.context.assertCurrent(); context.assertCurrent();
      const store = await this.store(context), inspection = await inspectAbsGeneration(store, context.scope);
      const libraries = await window['libraryDependencies']?.status(context.path);
      if (!libraries || libraries.dirty || libraries.busy || inspection.pending || inspection.diagnostics.issues.length
        || inspection.committed?.pointerHash !== completed.pointerHash
        || absJson(inspection.diagnostics.hashes) !== absJson(completed.hashes)
        || this.editor.isWorkspaceEditBlocked() || this.editor.captureRecoverySnapshot().documentText !== completed.documentText) {
        this.completedJournalReopen = undefined; return undefined;
      }
      completed.context.assertCurrent(); context.assertCurrent();
      return { ...completed.result, reused: true as const };
    } catch { this.completedJournalReopen = undefined; return undefined; }
  }

  async abandonGeneration(generation: string, token?: string): Promise<void> {
    const context = this.context();
    const store = await this.store(context);
    await store.abandon(generation, token); context.assertCurrent();
    if (token) {
      const committed = await store.inspectCommitted(); context.assertCurrent();
      if (committed) this.journalReopen.remember(committed.projection.map.generation, token);
    }
  }

  private historyNavigation?: {
    token: string; lease: BlocklyWorkspaceEditLease; assertCurrent: () => void;
    store: AbsBaselineStore; expected: AbsDiskSnapshot; pointerHash: string;
    sealed: boolean; timeout: ReturnType<typeof setTimeout>;
  };

  /** Hold the same native input fence from the preflight through file history publication. */
  beginHistoryNavigation(): Promise<{ token: string }> {
    const context = this.context();
    return this.editor.runProjectOperation(async () => {
      context.assertCurrent();
      const lease = this.editor.acquireWorkspaceEditLease();
      try {
        await projectDataRuntime.flushPending();
        const snapshot = this.editor.captureProjectSnapshot(lease);
        const guard = this.atRevision(context.assertCurrent, lease, snapshot);
        const store = await this.store(context), inspection = await store.inspectCommitted();
        if (!inspection || await store.inspectPending()) throw new AbsSyncError('ABS_HISTORY_NOT_READY', 'History requires a complete committed ABS snapshot.');
        const baseline = await store.loadCommitted();
        const expected = await store.captureDisk();
        this.assertMirrors(baseline!, expected, true);
        const prepared = await this.project.prepareSave(snapshot.document, guard);
        const committedAbi = await store.readDerivedAbi(baseline!.map.generation);
        guard();
        if (expected.abi === null || committedAbi === null
          || !sameAbsProgram(JSON.parse(expected.abi), JSON.parse(committedAbi))
          || !sameAbsProgram(JSON.parse(prepared.abiText), JSON.parse(expected.abi))) {
          throw new AbsSyncError('ABS_DUAL_EDIT_CONFLICT', 'Unsaved canvas or external ABI changes must be resolved before history restoration.');
        }
        const token = crypto.randomUUID();
        const timeout = setTimeout(() => this.releaseHistoryNavigation(token), 120_000);
        this.historyNavigation = { token, lease, assertCurrent: () => { guard(); }, store, expected,
          pointerHash: inspection.pointerHash, sealed: false, timeout };
        return { token };
      } catch (error) { lease.release(); throw error; }
    });
  }

  /** Quarantine keeps the old canvas fenced until project reload activates a new workspace. */
  async sealHistoryNavigation(token: string): Promise<void> {
    const transaction = this.historyNavigation;
    if (!transaction || transaction.token !== token) throw new AbsSyncError('ABS_HISTORY_STALE', 'History lease is missing or expired.');
    if (transaction.sealed) return;
    transaction.assertCurrent();
    const disk = await transaction.store.captureDisk(), committed = await transaction.store.inspectCommitted();
    transaction.assertCurrent();
    if (disk.abi !== transaction.expected.abi || disk.map !== transaction.expected.map || committed?.pointerHash !== transaction.pointerHash) {
      throw new AbsSyncError('ABS_DUAL_EDIT_CONFLICT', 'Derived cache or committed snapshot changed during history restoration.');
    }
    transaction.lease.quarantine('正在从完整 ABS 恢复项目；重新加载完成前保持旧画布锁定。');
    transaction.lease.release(); transaction.sealed = true;
  }

  releaseHistoryNavigation(token: string): void {
    const transaction = this.historyNavigation;
    if (!transaction || transaction.token !== token) return;
    clearTimeout(transaction.timeout);
    transaction.lease.release(); this.historyNavigation = undefined;
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
    return { path, workspace, definitions, runtimeRevision, session, scope: { projectKey: path, pageId }, isCurrent, assertCurrent };
  }

  private assertRuntimeShape(definitions: ReturnType<AbsWorkspaceSyncService['context']>['definitions'],
    ...args: Parameters<typeof assertAbsRuntimeShapeSupported>) {
    const inspect = () => assertAbsRuntimeShapeSupported(...args);
    // Shape inspection only reads the captured declarations. Validate all used
    // registrations before/after the synchronous traversal, not once per block.
    if (definitions.withSynchronousRead) definitions.withSynchronousRead(inspect);
    else inspect();
  }

  private async store(context: ReturnType<AbsWorkspaceSyncService['context']>) {
    const port = await openAbsHostStorage(context.path, context.assertCurrent);
    context.assertCurrent(); return new AbsBaselineStore(port, context.scope);
  }

  private atRevision(assertContext: () => void, lease: BlocklyWorkspaceEditLease,
    snapshot: { revision: number; document: BlocklyProjectDocument }) {
    return createAbsProjectSnapshotGuard(snapshot, () => this.editor.captureProjectSnapshot(lease),
      () => { assertContext(); lease.assertCurrent(); });
  }

  private async compactDocument(document: BlocklyProjectDocument, contracts: AbsProjectionContracts, assertCurrent: () => void) {
    const result = await prepareAbsProjectData(document, assertCurrent);
    assertAbsResourceContracts(composeBlocklyPage(document, document.activePageId),
      composeBlocklyPage(result.document, document.activePageId), contracts);
    assertCurrent(); return result.document;
  }

  private async projection(document: BlocklyProjectDocument, contracts: AbsProjectionContracts, abi: string | null,
    scope: AbsProjection['map']['scope'], assertCurrent: () => void, generation: string = crypto.randomUUID()) {
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
