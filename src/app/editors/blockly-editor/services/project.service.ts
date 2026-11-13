import { retainBlocklyHistory } from './blockly-library-history';
import type { ProjectSaveRequest } from '@domain/project/public-api';
import { Injectable, Optional } from '@angular/core';
import { Subscription, merge } from 'rxjs';
import { AILY_BLOCKLY_USED_LIBRARIES_FIELD, BlocklyLibraryRuntimeRebuildOptions, BlocklyProjectDocument, BlocklyService } from './blockly.service';
import { ActionService, NoticeService } from '@core/app-shell/public-api';
import { getActiveProjectGenerator, getActiveProjectGeneratorRevision } from './blockly-generator-runtime.service';
import { ElectronService, publishProjectText } from '@core/platform/public-api';
import {
  projectDataRuntime,
  canonicalProjectJsonStringify,
  materializeGenericProjectDataValues,
  type AilyDataRef,
  type BlocklySaveAsSnapshot,
  type ProjectSaveOutcome,
} from '@domain/project/public-api';
import { sha256Hex } from '../../../utils/crypto.utils';
import { isBuildWorkspaceBusyError, writePreparedArduinoGeneratedArtifacts,
  type GeneratedSourcePublicationOptions, type GeneratedSourcePublicationReceipt } from './generated-code-artifacts';
import { patchBuildMetadata } from '../../../utils/build-publication.utils';
import type { PreparedBlocklyCode } from './prepared-project-code';
import { publishGeneratorMacros } from './prepared-generator-config';
import { PreparedBlocklySave, prepareBlocklySave, commitPreparedBlocklySave, ProjectSaveDataRuntime } from './prepared-project-save';
import { fenceBlocklyWorkspaceInput, type BlocklyWorkspaceEditLease } from './blockly-workspace-edit-lease';
import { assertProjectLoadPreserved, BlocklyProjectCleanState } from './blockly-project-clean-state';
import { openAbsHostStorage } from '../../../integrations/blockly/abs/abs-host-storage';
import { AbsOperationJournal, type NativeSaveOperationRef } from '../../../integrations/blockly/abs/abs-operation-journal';
import type { RuntimePublicationObservation } from '../../../integrations/blockly/abs/abs-runtime-publication-observation';
import { settleAbsProjectTransaction } from '../../../integrations/blockly/abs/abs-project-restart';
import type { AbsLoadNormalizationInput, AbsLoadNormalizationOutcome } from '../../../integrations/blockly/abs/abs-load-normalization';
import { captureProjectRecoveryFiles, assertProjectRecoveryFilesCurrent, requireProjectProgramPublication } from '@shared/public-api';
import { publishAbsRecoveryCopy } from '../../../integrations/blockly/abs/abs-recovery-copy';
import { readHistoryEnvironment, type HistoryEnvironmentPlan } from '../../../integrations/blockly/history-environment';
import { isAilyLibraryPackageName } from '@shared/public-api';
import { settleLinkedProjectEnvironment } from '../../../integrations/blockly/environment-settlement';
import { describeRuntimeRecovery, runtimeRecoveryInput, runtimeRecoveryLibraries, type RuntimeRecoveryDescription,
  type RuntimeRecoveryRecord } from './blockly-library-runtime-recovery';

export type OwnedBlocklyDocumentMutation = (lease: BlocklyWorkspaceEditLease,
  assertCurrent: () => void, publication: NativeSaveOperationRef) => Promise<void>;
export interface BlocklyEnvironmentRuntimeReadback {
  packageJson: any; boardConfig: any; fingerprint: string; libraryNames?: string[];
  assertCurrent(): void; acknowledge(): boolean;
}
export type BlocklyRuntimeMutationObservation = RuntimePublicationObservation;

const actionFailure = (error: unknown): { error: string; code?: string } => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return { error: error instanceof Error ? error.message : String(error), ...(typeof code === 'string' ? { code } : {}) };
};

@Injectable({
  providedIn: 'root'
})
export class _ProjectService {

  currentProjectPath;
  currentPackageData;
  private initialized = false; // 防止重复初始化
  private readonly cleanState = new BlocklyProjectCleanState(workspace => this.blocklyService.getWorkspaceLoadReadbackView(workspace));
  private hydration?: Subscription;
  private runtimeRecovery?: RuntimeRecoveryRecord;
  private preprocessSaveGuard?: (path: string) => Promise<() => void>;
  private deferredSaveOutputs?: { timer?: ReturnType<typeof setTimeout> };
  private environmentRuntimeReader?: (project: string) => Promise<BlocklyEnvironmentRuntimeReadback>;

  setEnvironmentRuntimeReader(reader: (project: string) => Promise<BlocklyEnvironmentRuntimeReadback>): void {
    this.environmentRuntimeReader = reader;
  }

  publishEnvironmentMutation(path: string, mutate: (publication: unknown) => Promise<any>, request?: ProjectSaveRequest): Promise<ProjectSaveOutcome> {
    return this.publishRuntimeMutation(path, async (lease, guard, publication) => {
      await settleLinkedProjectEnvironment(path, guard); lease.assertCurrent();
      const result = await mutate(publication);
      guard(); lease.assertCurrent();
      if (result?.environment?.status !== 'completed' || result.environment.current !== true || result.candidateApplied !== false) {
        throw Object.assign(new Error('The original environment change is not verified complete.'),
          { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN', environment: result?.environment, candidateApplied: false });
      }
      const target = this.blocklyService.captureProjectSnapshot(lease).document;
      await this.rebuildOwnedEnvironment(target, lease, guard, result.environment.requestId);
    }, request);
  }

  /** Called only inside the existing publisher, after durable full S1 admission.
   * No second queue, lease, program writer or model-supplied callback exists. */
  async restoreHistoryEnvironment(input: HistoryEnvironmentPlan, targetDocument: unknown,
    lease: BlocklyWorkspaceEditLease, assertCurrent: () => void, publication: NativeSaveOperationRef): Promise<void> {
    const environment = readHistoryEnvironment(input)!;
    const project = this.currentProjectPath, host = window['libraryDependencies'];
    const guard = () => { assertCurrent(); lease.assertCurrent(); if (this.currentProjectPath !== project) throw new Error('History environment project changed.'); };
    guard();
    if (!this.environmentRuntimeReader || host?.environmentVersion !== 2 || typeof host.configure !== 'function') {
      throw Object.assign(new Error('The matching environment publisher/runtime reader is unavailable.'), { code: 'LIBRARY_ENVIRONMENT_UNAVAILABLE' });
    }
    await settleLinkedProjectEnvironment(project, guard);
    const result = await host.configure(project, { ...environment, operation: 'history-environment', programRef: publication });
    guard();
    if (result.environment?.status !== 'completed' || result.environment.current !== true || result.candidateApplied !== false) {
      throw Object.assign(new Error('The original environment outcome is not complete/current; no program was published.'),
        { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN', environment: result.environment, candidateApplied: false });
    }
    await this.rebuildOwnedEnvironment(targetDocument, lease, guard, environment.requestId);
  }

  private async rebuildOwnedEnvironment(targetDocument: unknown, lease: BlocklyWorkspaceEditLease,
    guard: () => void, requestId: string): Promise<void> {
    const project = this.currentProjectPath, host = window['libraryDependencies'];
    if (!this.environmentRuntimeReader) throw new Error('The matching environment runtime reader is unavailable.');
    const reader = await this.environmentRuntimeReader(project);
    guard(); reader.assertCurrent();
    this.currentPackageData = reader.packageJson;
    window['packageJson'] = reader.packageJson;
    this.blocklyService.boardConfig = reader.boardConfig;
    window['boardConfig'] = reader.boardConfig;
    this.blocklyService.setToolboxSortOrder(reader.packageJson?.blocklyToolboxOrder);
    const libraryNames = reader.libraryNames ?? Object.keys({ ...(reader.packageJson?.dependencies || {}), ...(reader.packageJson?.devDependencies || {}),
      ...(reader.packageJson?.optionalDependencies || {}), ...(reader.packageJson?.peerDependencies || {}) }).filter(isAilyLibraryPackageName);
    await this.blocklyService.rebuildLibraryRuntimeInPlace({ projectPath: project, packageJson: reader.packageJson, libraryNames },
      lease, () => { guard(); reader.assertCurrent(); }, targetDocument as BlocklyProjectDocument);
    guard(); reader.assertCurrent();
    const verified = await host.observeEnvironment(project, { requestId });
    guard(); reader.assertCurrent();
    if (verified.environment?.status !== 'completed' || verified.environment.current !== true
      || !this.blocklyService.isLibraryRuntimeReady(lease) || !reader.acknowledge()) {
      throw Object.assign(new Error('Environment/runtime changed before the original program publication.'),
        { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN', environment: verified.environment, candidateApplied: false });
    }
  }

  constructor(
    private blocklyService: BlocklyService,
    private actionService: ActionService,
    private electronService: ElectronService,
    @Optional() private noticeService?: NoticeService,
  ) { }

  init() {
    if (this.initialized) {
      console.warn('_ProjectService 已经初始化过了，跳过重复初始化');
      return;
    }
    
    this.initialized = true;
    this.cleanState.clear();
    this.blocklyService.projectDirtyState?.reset();
    this.hydration = new Subscription();
    this.hydration.add(this.blocklyService.projectPageHydrated.subscribe(({ before, after }) => {
      const baseline = this.cleanState.acceptHydration(this.cleanScope(), before, after);
      this.blocklyService.projectDirtyState?.acceptHydration(baseline);
    }));
    if (this.blocklyService.projectDirtyState) this.hydration.add(merge(
      this.blocklyService.pagesSubject, this.blocklyService.activePageIdSubject,
      this.blocklyService.openedPageIdsSubject, this.blocklyService.sharedModelSubject,
      this.blocklyService.aiWriting$,
    ).subscribe(() => this.blocklyService.projectDirtyState?.invalidate()));

    this.actionService.listen('project-save', async action => {
      try { return await this.save(action.payload.path, action.payload.saveRequest, action.payload.background === true); }
      catch (error) {
        return { projectSaved: false, generatedCodePublished: false, partial: false,
          ...actionFailure(error) };
      }
    }, 'project-save-handler');
    this.actionService.listen('project-check-unsaved', async () => {
      try { return { hasUnsavedChanges: await this.hasUnsavedChanges() }; }
      catch (error) {
        return actionFailure(error);
      }
    }, 'project-check-unsaved-handler');
  }

  destroy() {
    this.cancelDeferredSaveOutputs();
    this.actionService.unlisten('project-save-handler');
    this.actionService.unlisten('project-check-unsaved-handler');
    this.hydration?.unsubscribe();
    this.blocklyService.projectDirtyState?.reset();
    this.cleanState.clear();
    this.runtimeRecovery = undefined;
    this.initialized = false; // 重置初始化状态
  }

  async hasUnsavedChanges(): Promise<boolean> {
    const libraries = await window['libraryDependencies']?.status(this.currentProjectPath);
    if (libraries?.dirty || libraries?.busy) return true;
    const context = this.captureSaveContext(this.currentProjectPath);
    context.assertCurrent();
    await projectDataRuntime.flushPending(); context.assertCurrent();
    const { document, revision } = this.blocklyService.captureProjectSnapshot();
    const path = `${this.currentProjectPath}/project.abi`;
    const diskText = window['fs'].readFileSync(path, 'utf8');
    const memory = this.blocklyService.normalizeProjectAbi(this.blocklyService.getProjectAbiForSave(document));
    const known = this.cleanState.compare(this.cleanScope(), diskText, memory);
    if (known !== undefined) return known;
    const materialized = await materializeGenericProjectDataValues(JSON.parse(diskText), {
      resolve: async <T>(ref: AilyDataRef) => { const value = await projectDataRuntime.resolve<T>(ref); context.assertCurrent(); return value; },
    });
    context.assertCurrent();
    if (this.blocklyService.captureProjectSnapshot().revision !== revision || window['fs'].readFileSync(path, 'utf8') !== diskText) {
      throw new Error('Project changed while checking unsaved state. Please retry.');
    }
    return canonicalProjectJsonStringify(memory) !== canonicalProjectJsonStringify(this.blocklyService.normalizeProjectAbi(materialized));
  }

  /** Called only by the authoritative open path, never an ABS draft/rollback. */
  rememberLoadedProject(path: string, diskText: string, source: BlocklyProjectDocument, owner?: BlocklyWorkspaceEditLease): void {
    const context = this.captureSaveContext(path);
    context.assertCurrent(); // A stale caller must not erase a newer project's record.
    this.cleanState.clear();
    try {
      if (window['fs'].readFileSync(`${path}/project.abi`, 'utf8') !== diskText) throw new Error('Project changed during loading.');
      const document = this.blocklyService.getProjectAbiForSave(owner ? this.blocklyService.getProjectDocument(owner) : undefined);
      assertProjectLoadPreserved(this.blocklyService.getProjectAbiForSave(source), document,
        workspace => this.blocklyService.getWorkspaceLoadReadbackView(workspace));
      context.assertCurrent();
      this.cleanState.remember(this.cleanScope(), diskText, document);
      this.blocklyService.projectDirtyState?.remember(document);
    } catch (error) {
      this.cleanState.reject(error);
      // The caller must abort activation before publishing ready, running GC or
      // scheduling generation. A warning alone would announce a lossy load as successful.
      throw error;
    }
  }

  /** Read an existing acknowledgement without reading disk or marking Working saved. */
  readSavedAbiRecipe(project: string): string | undefined {
    try {
      const context = this.captureSaveContext(project);
      context.assertCurrent();
      const recipe = this.cleanState.readSavedAbiRecipe(this.cleanScope());
      context.assertCurrent();
      return recipe;
    } catch { return undefined; }
  }

  /** A crash-recovered pre-operation view may contain unsaved edits. Verify
   * every page without acknowledging those edits as a saved checkpoint. */
  async rememberRecoveredProject(path: string, diskText: string, source: BlocklyProjectDocument, owner: BlocklyWorkspaceEditLease): Promise<void> {
    const assertCurrent = () => { this.captureSaveContext(path).assertCurrent(); owner.assertCurrent(); };
    assertCurrent();
    if (window['fs'].readFileSync(`${path}/project.abi`, 'utf8') !== diskText) throw new Error('Project changed during recovery loading.');
    assertProjectLoadPreserved(this.blocklyService.getProjectAbiForSave(source),
      this.blocklyService.getProjectAbiForSave(this.blocklyService.getProjectDocument(owner)),
      workspace => this.blocklyService.getWorkspaceLoadReadbackView(workspace));
    this.cleanState.clear();
    const saved = await materializeGenericProjectDataValues(JSON.parse(diskText), {
      resolve: async <T>(ref: AilyDataRef) => { const value = await projectDataRuntime.resolve<T>(ref); assertCurrent(); return value; },
    });
    assertCurrent();
    if (window['fs'].readFileSync(`${path}/project.abi`, 'utf8') !== diskText) throw new Error('Saved document changed during recovery readback.');
    this.blocklyService.projectDirtyState?.recover(this.blocklyService.normalizeProjectAbi(saved),
      this.blocklyService.normalizeProjectAbi(this.blocklyService.getProjectAbiForSave(this.blocklyService.getProjectDocument(owner))));
  }

  private cleanScope(): readonly unknown[] {
    // Saved content belongs to the editor/data session, not a generator implementation.
    // In-flight queries still capture the generator in captureSaveContext().
    return [this.currentProjectPath, this.blocklyService.workspace, projectDataRuntime.getSessionToken()];
  }

  /** Library reload shares the save/ABS queue, but never saves the user's edits. */
  rebuildLibraryRuntime(options: BlocklyLibraryRuntimeRebuildOptions, admit: (lease?: BlocklyWorkspaceEditLease) => void = () => {}, retainedDocument?: BlocklyProjectDocument): Promise<void> {
    // A quarantined rebuild has its own retained full document and private
    // grant. Ordinary library synchronization must not recapture a partial canvas.
    if (this.hasLibraryRuntimeRecovery()) {
      return Promise.reject(Object.assign(new Error('Inspect the retained runtime snapshot and use recover_runtime; no rebuild was replayed.'),
        { code: 'BLOCKLY_RUNTIME_RECOVERY_REQUIRED' }));
    }
    const context = this.captureSaveContext(options.projectPath);
    return this.blocklyService.runProjectOperation(async () => {
      admit();
      context.assertCurrent();
      await this.blocklyService.whenLibraryLoadsSettled();
      context.assertCurrent();
      const lease = this.blocklyService.acquireWorkspaceEditLease();
      const scope = this.cleanScope();
      const assertCurrent = () => {
        lease.assertCurrent();
        const current = this.cleanScope();
        if (!scope.every((value, index) => value === current[index])) {
          throw new Error('Project changed during library runtime rebuild.');
        }
      };
      let recovery: RuntimeRecoveryRecord | undefined;
      let operation: { journal: AbsOperationJournal; id: string } | undefined;
      let runtimeChanged = false;
      try {
        await projectDataRuntime.flushPending();
        context.assertCurrent();
        const before = this.blocklyService.getProjectAbiForSave(this.blocklyService.getProjectDocument(lease));
        const fs = window['fs'], abiPath = `${options.projectPath}/project.abi`;
        const disk = fs.readFileSync(abiPath, 'utf8');
        this.cleanState.compare(scope, disk, before);
        const sourceFiles = await captureProjectRecoveryFiles(options.projectPath,
          ['project.abi', 'project.abs', 'project.abs.map.json'], assertCurrent);
        const materialized = await materializeGenericProjectDataValues(before, {
          resolve: async <T>(ref: AilyDataRef) => { const value = await projectDataRuntime.resolve<T>(ref); assertCurrent(); return value; },
        });
        assertCurrent(); assertProjectRecoveryFilesCurrent(options.projectPath, sourceFiles);
        const directory = `${options.projectPath}/.temp`;
        fs.mkdirSync(directory, { recursive: true });
        const recoveryPath = `${directory}/library-runtime-${crypto.randomUUID()}.recovery.json`;
        // A detached, materialized document is recoverable even if a new library cannot load it.
        const documentText = JSON.stringify(materialized);
        const port = await openAbsHostStorage(options.projectPath, assertCurrent);
        const journal = new AbsOperationJournal(port, options.projectPath);
        const id = await journal.begin({ kind: 'runtime-rebuild', document: materialized,
          disk: { abi: sourceFiles.files['project.abi'], abs: sourceFiles.files['project.abs'], map: sourceFiles.files['project.abs.map.json'] } }, assertCurrent);
        operation = { journal, id };
        fs.writeFileSync(recoveryPath, documentText, { encoding: 'utf8', flag: 'wx' });
        recovery = { project: options.projectPath, path: recoveryPath, documentText, sourceFiles, scope,
          options: { ...options, libraryNames: [...new Set([...options.libraryNames,
            ...Array.from(this.blocklyService.loadedLibraryInfos.values(), item => item.packageName)])] },
          restoreCheckpoint: this.cleanState.captureCheckpoint(), operation: { id } };
        admit(lease);
        runtimeChanged = true;
        const restoreHistory = retainBlocklyHistory(this.blocklyService.workspace);
        try { await this.blocklyService.rebuildLibraryRuntimeInPlace(options, lease, assertCurrent, retainedDocument); }
        finally { if (this.blocklyService.workspace) restoreHistory(); }
        assertCurrent();
        if (fs.readFileSync(abiPath, 'utf8') !== disk) throw new Error('project.abi changed during library runtime rebuild.');
        // The editor's load/readback boundary preserved content; page hydration may
        // acknowledge native defaults only. Never remember() this unsaved snapshot.
        this.runtimeRecovery = undefined;
        await journal.restored(id, assertCurrent);
        try { fs.unlinkSync(recoveryPath); } catch (error) { console.warn('Could not remove completed runtime recovery snapshot:', error); }
      } catch (error) {
        if (!runtimeChanged) {
          if (operation) await operation.journal.finish(operation.id, assertCurrent);
          throw error;
        }
        const message = `Library runtime rebuild failed: ${String((error as Error)?.message || error)}. `
          + `The complete pre-rebuild snapshot is retained. Project recovery restores this same project; source files and ABS candidate were not changed.`;
        try {
          assertCurrent();
          const grant = lease.quarantine(message);
          if (grant && recovery) { recovery.grant = grant; this.runtimeRecovery = recovery; }
          this.cleanState.reject(new Error(message));
        } catch { /* Never quarantine a replacement project. */ }
        throw Object.assign(new Error(message), { code: 'BLOCKLY_RUNTIME_RECOVERY_REQUIRED' });
      } finally { lease.release(); }
    });
  }

  private assertRuntimeRecoveryScope(record: RuntimeRecoveryRecord): void {
    const scope = this.cleanScope();
    if (this.runtimeRecovery !== record || !record.scope.every((value, index) => value === scope[index])) {
      throw Object.assign(new Error('The retained runtime snapshot or its project activation changed.'), { code: 'PROJECT_RECOVERY_SOURCE_CHANGED' });
    }
  }

  private assertRuntimeRecovery(record: RuntimeRecoveryRecord): void {
    this.assertRuntimeRecoveryScope(record);
    if (window['fs'].readFileSync(record.path, 'utf8') !== record.documentText) {
      throw Object.assign(new Error('The retained full snapshot changed; no partial canvas may replace it.'), { code: 'PROJECT_RECOVERY_SOURCE_CHANGED' });
    }
    // ABS/map are unapplied candidates, independent of restoring the retained
    // canvas. New draft bytes must survive, not revoke this recovery forever.
    // A changed authoritative ABI still requires explicit conflict resolution.
    assertProjectRecoveryFilesCurrent(record.project, {
      files: { 'project.abi': record.sourceFiles.files['project.abi'] },
      rawFiles: { 'project.abi': record.sourceFiles.rawFiles['project.abi'] },
    });
  }

  async inspectLibraryRuntimeRecovery(): Promise<RuntimeRecoveryDescription | undefined> {
    const record = this.runtimeRecovery;
    // Keep the original completion receipt for exact-ID observation, but never
    // let its old disk capture obstruct a later legitimate save or inspection.
    if (!record || !this.hasLibraryRuntimeRecovery()) return;
    this.assertRuntimeRecovery(record);
    const description = await describeRuntimeRecovery(record, runtimeRecoveryInput(record));
    this.assertRuntimeRecovery(record);
    return description;
  }

  hasLibraryRuntimeRecovery(): boolean {
    const record = this.runtimeRecovery, scope = this.cleanScope();
    return !!record && record.description?.status !== 'completed'
      && record.scope.every((value, index) => value === scope[index]);
  }

  /** UI and Agent callers use the same original runtime capability. Waiting
   * observes an existing attempt; it never creates another rebuild. */
  async recoverRuntimeInPlace(signal?: AbortSignal): Promise<{ ready: boolean; cancelled?: boolean; code?: string; message?: string }> {
    const cancelled = () => ({ ready: false, cancelled: true, code: 'PROJECT_RECOVERY_CANCELLED' });
    if (signal?.aborted) return cancelled();
    const description = await this.inspectLibraryRuntimeRecovery();
    if (signal?.aborted) return cancelled();
    if (!description) return { ready: !this.hasLibraryRuntimeRecovery() };
    const start = Date.now();
    let result = await this.recoverLibraryRuntime(description.token, description.requestId, false);
    while (result.status === 'running' && Date.now() - start < 60_000) {
      if (signal?.aborted) return cancelled();
      await new Promise(resolve => setTimeout(resolve, 50));
      result = await this.recoverLibraryRuntime(description.token, description.requestId, true);
    }
    if (signal?.aborted) return cancelled();
    return result.status === 'completed' && result.value?.ready === true ? { ready: true }
      : { ready: false, code: result.failure?.code ?? result.value?.failure?.code ?? 'BLOCKLY_RUNTIME_RECOVERY_FAILED',
        message: result.failure?.message ?? result.value?.failure?.message ?? 'The retained complete runtime did not become ready.' };
  }

  /** Only the lifecycle's accepted explicit discard invokes this. Archives and
   * candidate history remain intact; ordinary cancellation never calls it. */
  async discardRetainedOperation(path: string): Promise<void> {
    const discard = await this.prepareRetainedDiscard(path);
    try { await discard.commit(); } finally { discard.dispose(); }
  }

  async prepareRetainedDiscard(path: string): Promise<{ commit(): Promise<void>; dispose(): void }> {
    const context = this.captureSaveContext(path);
    return this.blocklyService.runRecoveryCopyOperation(async () => {
      context.assertCurrent();
      let disposed = false;
      // Navigation may destroy the native editor after its final veto. The
      // short-lived admission retains only the exact project and operation.
      const guard = () => {
        if (disposed || this.currentProjectPath !== path) throw new Error('The accepted recovery discard expired.');
      };
      const port = await openAbsHostStorage(path, guard);
      await settleAbsProjectTransaction(port, path, guard);
      const journal = new AbsOperationJournal(port, path), retained = await journal.inspect();
      return { commit: async () => { guard(); if (retained) await journal.finish(retained.id, guard); },
        dispose: () => { disposed = true; } };
    });
  }

  async recoverLibraryRuntime(token: string, requestId: string, observe: boolean): Promise<{
    status: 'running' | 'completed' | 'failed' | 'unavailable'; value?: RuntimeRecoveryDescription;
    freshCompletion?: boolean;
    failure?: { code: string; message: string };
  }> {
    const record = this.runtimeRecovery;
    if (record) this.assertRuntimeRecoveryScope(record);
    const original = record?.previous;
    if (observe && original?.token === token && original?.requestId === requestId) {
      return { status: original.status === 'failed' ? 'failed' : 'unavailable',
        value: { ...original, requiredLibraries: [...original.requiredLibraries] } };
    }
    const offered = record?.description;
    if (!record || !offered || token !== offered.token || requestId !== offered.requestId) {
      return { status: 'unavailable', failure: { code: 'BLOCKLY_RUNTIME_RECOVERY_STALE', message: 'Inspect the current host recovery offer; no operation was started.' } };
    }
    const result = () => ({ status: offered.status === 'available' ? 'unavailable' as const : offered.status,
      value: { ...offered, requiredLibraries: [...offered.requiredLibraries] } });
    if (observe || offered.status !== 'available') return result();
    this.assertRuntimeRecovery(record);
    const input = runtimeRecoveryInput(record);
    if (input !== record.offeredInput || !record.grant) return { status: 'unavailable',
      failure: { code: 'BLOCKLY_RUNTIME_RECOVERY_STALE', message: 'Runtime inputs changed after inspection. Inspect again before recovery.' } };
    record.attemptedInput = input; offered.status = 'running';
    try {
      await this.blocklyService.runRecoveryCopyOperation(async () => {
        this.assertRuntimeRecovery(record);
        const lease = this.blocklyService.acquireWorkspaceRecoveryLease(record.grant!);
        const guard = () => { lease.assertCurrent(); this.assertRuntimeRecoveryScope(record); };
        try {
          guard();
          const packagePath = `${record.project}/package.json`, fs = window['fs'];
          const packageJson = fs.existsSync(packagePath) ? JSON.parse(fs.readFileSync(packagePath, 'utf8')) : record.options.packageJson;
          await this.blocklyService.rebuildLibraryRuntimeInPlace({ ...record.options, packageJson,
            libraryNames: runtimeRecoveryLibraries(record) }, lease, guard, JSON.parse(record.documentText));
          guard(); this.assertRuntimeRecovery(record);
          if (runtimeRecoveryInput(record) !== input) throw new Error('Runtime dependencies changed during restoration.');
          record.restoreCheckpoint();
          this.currentPackageData = packageJson;
          // Persist the retained view while the recovery lease can still
          // validate its owner. Completing recovery ends that lease.
          if (record.operation) {
            // Storage capabilities retain their admission guard. The failed
            // writer's lease has ended; acknowledge with this recovery owner.
            const port = await openAbsHostStorage(record.project, guard);
            await new AbsOperationJournal(port, record.project).restored(record.operation.id, guard);
          }
          guard();
          // Only the recovery owner can clear this quarantine, after full native readback.
          lease.completeRecovery();
          offered.status = 'completed'; offered.ready = true; delete offered.failure;
        } finally { lease.release(); }
      });
    } catch (error) {
      offered.status = 'failed'; offered.ready = false;
      offered.failure = { code: 'BLOCKLY_RUNTIME_RECOVERY_FAILED', message: String((error as Error)?.message || error) };
    }
    const outcome = result();
    return { ...outcome, ...(outcome.status === 'completed' ? { freshCompletion: true } : {}) };
  }

  /** Registered full snapshot wins over any partial live reconstruction. */
  async captureLibraryRuntimeRecoveryCopy(path: string): Promise<BlocklySaveAsSnapshot | undefined> {
    const record = this.runtimeRecovery;
    if (!record || !this.hasLibraryRuntimeRecovery()) return;
    if (path !== record.project) throw new Error('Runtime recovery belongs to another project.');
    return this.blocklyService.runRecoveryCopyOperation(async () => {
      this.assertRuntimeRecovery(record);
      const currentFiles = await captureProjectRecoveryFiles(path,
        ['project.abi', 'project.abs', 'project.abs.map.json'], () => this.assertRuntimeRecovery(record));
      let disposed = false;
      const guard = () => { if (disposed) throw new Error('Recovery capture was disposed.'); this.assertRuntimeRecovery(record);
        assertProjectRecoveryFilesCurrent(path, currentFiles); };
      return {
        publish: async target => {
          guard();
          const outcome = await publishAbsRecoveryCopy(target, { sourceProject: record.project,
            documentText: record.documentText, abiShapeText: record.documentText,
            sourceFiles: currentFiles, retainedSourceFiles: record.sourceFiles }, guard);
          return { ...outcome, recoverySource: { version: 1, kind: 'workspace', origin: 'runtime-snapshot',
            complete: true, loadFailed: false, partialCanvas: 'not-applicable' } };
        },
        isCurrent: () => { try { guard(); return true; } catch { return false; } },
        freezeForActivation: () => { guard(); return fenceBlocklyWorkspaceInput(this.blocklyService.workspace?.getParentSvg?.()?.parentElement ?? undefined); },
        dispose: () => { disposed = true; },
      };
    });
  }

  /** Recovery reloads exactly the already loaded libraries. It neither installs
   * dependencies nor saves/rebinds the user's canvas or ABS draft. */
  rebuildNativeCandidateRuntime(admit: (lease?: BlocklyWorkspaceEditLease) => void): Promise<void> {
    admit();
    return this.rebuildLibraryRuntime({ projectPath: this.currentProjectPath,
      packageJson: this.currentPackageData,
      libraryNames: Array.from(this.blocklyService.loadedLibraryInfos.values(), item => item.packageName),
    }, admit);
  }

  async getAbiRevisionSnapshot(): Promise<{
    algorithm: 'sha256';
    scope: 'normalized-materialized-project-abi';
    memoryHash: string;
    diskHash: string;
    changed: boolean;

    usedLibraries: string[];
  }> {
    const context = this.captureSaveContext(this.currentProjectPath);
    context.assertCurrent();
    await projectDataRuntime.flushPending(); context.assertCurrent();

    const { document, revision } = this.blocklyService.captureProjectSnapshot();
    const path = `${this.currentProjectPath}/project.abi`;
    const diskText = window['fs'].readFileSync(path, 'utf8');
    const memory = canonicalProjectJsonStringify(this.blocklyService.normalizeProjectAbi(this.blocklyService.getProjectAbiForSave(document)));
    const usedLibraries = Object.keys(this.blocklyService.getProjectUsedLibraryManifest(undefined, document));

    const assertCurrent = () => {
      context.assertCurrent();
      if (this.blocklyService.captureProjectSnapshot().revision !== revision || window['fs'].readFileSync(path, 'utf8') !== diskText) {
        throw new Error('Project changed during ABI revision verification.');
      }
    };
    // A cache miss after reopen/eviction is not missing project data. Resolve the fixed disk snapshot.
    const materialized = await materializeGenericProjectDataValues(JSON.parse(diskText), {
      // Per-resource guards are lightweight; compare whole-project revisions at phase boundaries.
      // Re-serializing the project for every resource makes this read-only query quadratic.
      resolve: async <TValue>(ref: AilyDataRef) => { const value = await projectDataRuntime.resolve<TValue>(ref); context.assertCurrent(); return value; },
    });
    assertCurrent();
    const disk = canonicalProjectJsonStringify(this.blocklyService.normalizeProjectAbi(materialized));
    const [memoryHash, diskHash] = await Promise.all([
      sha256Hex(memory),
      sha256Hex(disk),
    ]);
    assertCurrent();

    return {
      algorithm: 'sha256',
      scope: 'normalized-materialized-project-abi',
      memoryHash,
      diskHash,
      changed: memoryHash !== diskHash,
      usedLibraries,
    };
  }

  private absSaveHandler?: (path: string, request?: ProjectSaveRequest, background?: boolean) => Promise<ProjectSaveOutcome>;
  private absRuntimeMutationHandler?: (path: string, mutate: OwnedBlocklyDocumentMutation, request?: ProjectSaveRequest) => Promise<ProjectSaveOutcome>;
  private absRuntimeMutationObserver?: (path: string, publication: NativeSaveOperationRef) => Promise<BlocklyRuntimeMutationObservation>;
  private absSaveAsHandler?: (path: string) => Promise<BlocklySaveAsSnapshot>;
  private absRecoveryCopyHandler?: (path: string) => Promise<BlocklySaveAsSnapshot>;
  private absLoadNormalizationHandler?: (input: AbsLoadNormalizationInput) => Promise<AbsLoadNormalizationOutcome>;

  setAbsSaveHandler(handler: (path: string, request?: ProjectSaveRequest, background?: boolean) => Promise<ProjectSaveOutcome>): void { this.absSaveHandler = handler; }
  setAbsRuntimeMutationHandler(handler: NonNullable<_ProjectService['absRuntimeMutationHandler']>): void { this.absRuntimeMutationHandler = handler; }
  setAbsRuntimeMutationObserver(handler: NonNullable<_ProjectService['absRuntimeMutationObserver']>): void { this.absRuntimeMutationObserver = handler; }
  observeRuntimeMutation(path: string, publication: NativeSaveOperationRef): Promise<BlocklyRuntimeMutationObservation> {
    if (!this.absRuntimeMutationObserver) return Promise.reject(Object.assign(new Error('The original publication observer is unavailable.'),
      { code: 'PROJECT_SAVE_DURABILITY_UNAVAILABLE' }));
    return this.absRuntimeMutationObserver(path, publication);
  }
  publishRuntimeMutation(path: string, mutate: OwnedBlocklyDocumentMutation, request?: ProjectSaveRequest): Promise<ProjectSaveOutcome> {
    requireProjectProgramPublication();
    if (!this.absRuntimeMutationHandler) return Promise.reject(Object.assign(new Error('The document publisher is unavailable; the runtime change was not started.'),
      { code: 'PROJECT_SAVE_DURABILITY_UNAVAILABLE' }));
    return this.absRuntimeMutationHandler(path, mutate, request);
  }
  setAbsSaveAsHandler(handler: (path: string) => Promise<BlocklySaveAsSnapshot>): void { this.absSaveAsHandler = handler; }
  setAbsRecoveryCopyHandler(handler: (path: string) => Promise<BlocklySaveAsSnapshot>): void { this.absRecoveryCopyHandler = handler; }
  setAbsLoadNormalizationHandler(handler: (input: AbsLoadNormalizationInput) => Promise<AbsLoadNormalizationOutcome>): void {
    this.absLoadNormalizationHandler = handler;
  }

  publishLoadedNormalization(input: AbsLoadNormalizationInput): Promise<AbsLoadNormalizationOutcome> {
    input.assertCurrent();
    if (input.projectPath !== this.currentProjectPath || !this.absLoadNormalizationHandler) {
      return Promise.resolve({ status: 'DEFERRED', code: 'ABS_LOAD_NORMALIZATION_UNAVAILABLE', recovery: {
        tool: 'project_recover', arguments: { action: 'inspect', project: input.projectPath },
        guidance: 'The original files were retained; inspect this exact project and use its verified preserving repair or independent fork. No load-normalization writer is available.',
      } });
    }
    return this.absLoadNormalizationHandler(input);
  }

  captureRecoveryCopySnapshot(path: string): Promise<BlocklySaveAsSnapshot> {
    if (path !== this.currentProjectPath || !this.absRecoveryCopyHandler) {
      return Promise.reject(new Error('The active Blockly editor cannot capture a recovery copy.'));
    }
    return this.absRecoveryCopyHandler(path);
  }

  captureSaveAsSnapshot(path: string): Promise<BlocklySaveAsSnapshot> {
    if (path !== this.currentProjectPath || !this.absSaveAsHandler) {
      return Promise.reject(new Error('The active Blockly editor cannot capture a Save As snapshot. Update and reopen the host.'));
    }
    return this.absSaveAsHandler(path);
  }

  bindPreprocessSaveGuard(guard: (path: string) => Promise<() => void>): () => void {
    this.preprocessSaveGuard = guard;
    return () => { if (this.preprocessSaveGuard === guard) this.preprocessSaveGuard = undefined; };
  }

  async save(path: string, request?: ProjectSaveRequest, background = false): Promise<ProjectSaveOutcome> {
    // Isolated builds never use this document's mutable generated inputs.
    // Older hosts keep their existing preprocessing handoff.
    const context = this.captureSaveContext(path);
    const release = await (window['builder']?.isolatedBuildExecutionVersion === 1 ? undefined : this.pauseBackgroundPreprocess(path));
    try { context.assertCurrent(); return await this.saveProjectAfterPreprocess(path, request, background); }
    finally { release?.(); }
  }

  pauseBackgroundPreprocess(path: string): Promise<() => void> | undefined {
    return this.preprocessSaveGuard?.(path);
  }

  private saveProjectAfterPreprocess(path: string, request?: ProjectSaveRequest, background = false): Promise<ProjectSaveOutcome> {
    requireProjectProgramPublication();
    if (this.absSaveHandler) return background ? this.absSaveHandler(path, request, true) : this.absSaveHandler(path, request);
    return Promise.reject(Object.assign(new Error('The matching document publisher is unavailable; no save was started.'),
      { code: 'PROJECT_SAVE_DURABILITY_UNAVAILABLE' }));
  }

  prepareSave(document: BlocklyProjectDocument, assertCurrent: () => void, runtime?: ProjectSaveDataRuntime): Promise<PreparedBlocklySave> {
    return prepareBlocklySave(document, snapshot => this.blocklyService.getProjectAbiForSave(snapshot), assertCurrent, runtime);
  }

  /** Derived outputs for a new project, without changing the source editor's clean baseline. */
  async publishCopyOutputs(path: string, document: BlocklyProjectDocument, generated: PreparedBlocklyCode | null, assertCurrent: () => void) {
    assertCurrent();
    const manifestPath = window['path'].join(path, 'package.json');
    const manifest = JSON.parse(window['fs'].readFileSync(manifestPath, 'utf8'));
    manifest[AILY_BLOCKLY_USED_LIBRARIES_FIELD] = this.blocklyService.getProjectUsedLibraryManifest(manifest, document);
    window['fs'].writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    if (generated?.code != null) {
      await publishGeneratorMacros(path, generated.projectMacros, assertCurrent);
      await writePreparedArduinoGeneratedArtifacts(path, generated.artifacts,
        generated.artifacts === null ? undefined : generated.code);
      assertCurrent();
    }
  }

  commitPreparedSave(path: string, prepared: PreparedBlocklySave, expectedAbi: string | null, assertCurrent: () => void) {
    return commitPreparedBlocklySave(path, prepared, expectedAbi, window['fs'], assertCurrent);
  }

  /** Acknowledge the committed snapshot before publishing fallible derived outputs. */
  async publishPreparedSaveOutputs(path: string, prepared: PreparedBlocklySave, generated: PreparedBlocklyCode | null, assertCurrent: () => void,
    options: GeneratedSourcePublicationOptions = {}): Promise<GeneratedSourcePublicationReceipt | void> {
    assertCurrent();
    if (path !== this.currentProjectPath || window['fs'].readFileSync(`${path}/project.abi`, 'utf8') !== prepared.abiText) {
      throw new Error('Cannot acknowledge a stale project save.');
    }
    this.cancelDeferredSaveOutputs();
    this.cleanState.remember(this.cleanScope(), prepared.abiText,
      this.blocklyService.normalizeProjectAbi(this.blocklyService.getProjectAbiForSave(JSON.parse(prepared.documentText))));
    this.blocklyService.projectDirtyState?.remember(JSON.parse(prepared.documentText));
    // Navigation can continue during a background save. Reconcile after its
    // lease releases so a newer viewport is not acknowledged by the old snapshot.
    this.blocklyService.projectDirtyState?.invalidate();
    try {
      if (window['builder']?.isolatedBuildExecutionVersion === 1) {
        // Builds consume their captured inputs in private execution directories.
        // Saving a document must not acquire an older build's root-output lease.
        await this.publishUsedLibraryManifest(path, JSON.parse(prepared.documentText), assertCurrent);
        return await this.publishPreparedCode(path, generated, assertCurrent, options);
      }
      if (generated?.code !== null) await publishGeneratorMacros(path, generated?.projectMacros, assertCurrent);
      this.syncUsedLibraryManifest(path, JSON.parse(prepared.documentText));
      return await this.publishPreparedCode(path, generated, assertCurrent, options);
    } catch (error) {
      if (window['builder']?.isolatedBuildExecutionVersion !== 1 && isBuildWorkspaceBusyError(error) && generated?.code != null) {
        this.deferSaveOutputs(path, prepared, generated, options);
      }
      throw error;
    }
  }

  private cancelDeferredSaveOutputs(): void {
    if (this.deferredSaveOutputs?.timer) clearTimeout(this.deferredSaveOutputs.timer);
    this.deferredSaveOutputs = undefined;
  }

  /** Retry only derived writes, outside the save's input lease. The source
   * document is already committed; never save it again or regenerate a draft. */
  private deferSaveOutputs(path: string, prepared: PreparedBlocklySave, generated: PreparedBlocklyCode,
    options: GeneratedSourcePublicationOptions): void {
    if (window['builder']?.isolatedBuildExecutionVersion === 1) return;
    const context = this.captureSaveContext(path);
    const pending: NonNullable<_ProjectService['deferredSaveOutputs']> = {};
    this.deferredSaveOutputs = pending;
    const current = () => this.deferredSaveOutputs === pending && context.isCurrent()
      && window['builder']?.isolatedBuildExecutionVersion !== 1;
    const assertCurrent = () => {
      if (!current() || this.blocklyService.captureProjectSnapshot().revision !== generated.revision
        || window['fs'].readFileSync(`${path}/project.abi`, 'utf8') !== prepared.abiText) {
        throw Object.assign(new Error('Saved code publication was superseded.'), { code: 'PROJECT_CODE_PUBLICATION_STALE' });
      }
    };
    let retryDelay = 250;
    const schedule = () => {
      pending.timer = setTimeout(() => { pending.timer = undefined; void publish(); }, retryDelay);
      retryDelay = Math.min(2000, retryDelay * 2);
    };
    const publish = async () => {
      if (!current()) {
        if (this.deferredSaveOutputs === pending) this.cancelDeferredSaveOutputs();
        return;
      }
      try {
        // The normal project queue serializes this attempt with newer saves,
        // ABS and library reloads. No edit fence is held while waiting on a build.
        await this.blocklyService.runProjectOperation(async () => {
          assertCurrent();
          await publishGeneratorMacros(path, generated.projectMacros, assertCurrent);
          this.syncUsedLibraryManifest(path, JSON.parse(prepared.documentText));
          await this.publishPreparedCode(path, generated, assertCurrent, options);
        });
        if (current()) this.cancelDeferredSaveOutputs();
      } catch (error) {
        if (!current()) {
          if (this.deferredSaveOutputs === pending) this.cancelDeferredSaveOutputs();
          return;
        }
        if (isBuildWorkspaceBusyError(error) || (error as { code?: string })?.code === 'BLOCKLY_EDIT_BUSY') {
          schedule(); return;
        }
        this.cancelDeferredSaveOutputs();
        if ((error as { code?: string })?.code === 'PROJECT_CODE_PUBLICATION_STALE') return;
        console.error('Saved project derived-code publication failed:', error);
        this.noticeService?.update({ title: '生成代码更新失败', text: '项目文件已保存，生成代码未更新。',
          detail: error instanceof Error ? error.message : String(error), state: 'error', sendToLog: true });
      }
    };
    schedule();
  }

  /** Library usage is canonical project data, independent of generated build outputs. */
  private async publishUsedLibraryManifest(path: string, document: BlocklyProjectDocument, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    const original = window['fs'].readFileSync(`${path}/package.json`, 'utf8');
    const manifest = JSON.parse(original);
    const libraries = this.blocklyService.getProjectUsedLibraryManifest(manifest, document);
    if (JSON.stringify(manifest[AILY_BLOCKLY_USED_LIBRARIES_FIELD]) !== JSON.stringify(libraries)) {
      manifest[AILY_BLOCKLY_USED_LIBRARIES_FIELD] = libraries;
      await publishProjectText(path, 'package.json', JSON.stringify(manifest, null, 2), original, assertCurrent);
    }
    assertCurrent();
    this.currentPackageData = manifest;
    window['packageJson'] = manifest;
  }

  private captureSaveContext(path: string) {
    const workspace = this.blocklyService.workspace;
    const pageId = this.blocklyService.getActivePageId();
    const generator = getActiveProjectGenerator();
    const runtimeRevision = getActiveProjectGeneratorRevision();
    const session = projectDataRuntime.getSessionToken();
    const isCurrent = () => Boolean(path) && path === this.currentProjectPath && workspace === this.blocklyService.workspace
      && pageId === this.blocklyService.getActivePageId() && generator === getActiveProjectGenerator()
      && session === projectDataRuntime.getSessionToken() && runtimeRevision === getActiveProjectGeneratorRevision();
    return { isCurrent, assertCurrent: () => {
      if (!isCurrent()) {
        throw new Error('Project, page or runtime changed; stopped the stale save.');
      }
    } };
  }

  syncUsedLibraryManifest(path: string, projectDocument?: BlocklyProjectDocument): boolean {
    const packageJsonPath = `${path}/package.json`;
    try {
      if (!window['fs'].existsSync(packageJsonPath)) {
        return false;
      }

      const originalContent = window['fs'].readFileSync(packageJsonPath, 'utf8');
      const packageJson = JSON.parse(originalContent);
      const previousLibraries = JSON.stringify(packageJson[AILY_BLOCKLY_USED_LIBRARIES_FIELD]);
      packageJson[AILY_BLOCKLY_USED_LIBRARIES_FIELD] = this.blocklyService.getProjectUsedLibraryManifest(packageJson, projectDocument);
      const changed = previousLibraries !== JSON.stringify(packageJson[AILY_BLOCKLY_USED_LIBRARIES_FIELD]);
      // Loading/restoring a version must not rewrite its manifest merely to
      // normalize whitespace when the derived library metadata is unchanged.
      if (changed) {
        window['fs'].writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
      }
      this.currentPackageData = packageJson;
      window['packageJson'] = packageJson;
      return changed;
    } catch (error) {
      console.error('更新项目使用库清单失败:', error);
      return false;
    }
  }

  /** Post-commit work consumes immutable code/artifacts; never calls a Generator. */
  private async publishPreparedCode(path: string, generated: PreparedBlocklyCode | null, assertCurrent: () => void,
    options: GeneratedSourcePublicationOptions = {}) {
    if (!generated || generated.code === null) {
      if (generated?.error) console.warn('Project ABI is saved; code generation failed:', generated.error);
      return;
    }
    assertCurrent();
    // Save/ABS publication owns this exact prepared snapshot too. Updating only
    // codeSubject leaves the IPC viewer/map on the previous generation until a
    // later UI debounce happens to regenerate. Disk contention must not hide it.
    this.blocklyService.publishPreparedCodeView(generated.code, generated.blockCodeMapText);
    if (window['builder']?.isolatedBuildExecutionVersion === 1) {
      // No root sketch, headers or build metadata were published. Local builds
      // materialize this prepared input in their own execution workspace.
      return { changed: false, target: 'preview', previewPublished: true, diskPublished: false } as GeneratedSourcePublicationReceipt;
    }
    // The artifact snapshot is the captured Arduino publication capability.
    // Publish its sketch and headers together, as startup/build already do;
    // otherwise a successful ABS save leaves the on-disk sketch one edit behind.
    // Other generators have null artifacts and must not write Python into .ino.
    const publication = await writePreparedArduinoGeneratedArtifacts(path, generated.artifacts,
      generated.artifacts === null ? undefined : generated.code, options);
    assertCurrent();
    if (this.electronService?.calculateHash) {
      const codeHash = await this.electronService.calculateHash(generated.code);
      assertCurrent();
      patchBuildMetadata(path, { codeHash });
    }
    return publication;
  }

}
