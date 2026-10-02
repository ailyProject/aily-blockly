import { Injectable } from '@angular/core';
import { Subscription } from 'rxjs';
import { AILY_BLOCKLY_USED_LIBRARIES_FIELD, BlocklyLibraryRuntimeRebuildOptions, BlocklyProjectDocument, BlocklyService } from './blockly.service';
import { ActionService } from '@core/app-shell/public-api';
import { getActiveProjectGenerator, getActiveProjectGeneratorRevision } from './blockly-generator-runtime.service';
import { ElectronService, ProjectFilePublicationError } from '@core/platform/public-api';
import {
  projectDataRuntime,
  canonicalJsonStringify,
  materializeGenericProjectDataValues,
  type AilyDataRef,
} from '@domain/project/public-api';
import { sha256Hex } from '../../../utils/crypto.utils';
import { writePreparedArduinoGeneratedArtifacts } from './generated-code-artifacts';
import { patchBuildMetadata } from '../../../utils/build-publication.utils';
import type { PreparedBlocklyCode } from './prepared-project-code';
import { publishGeneratorMacros } from './prepared-generator-config';
import { PreparedBlocklySave, prepareBlocklySave, commitPreparedBlocklySave } from './prepared-project-save';
import { assertProjectLoadPreserved, BlocklyProjectCleanState } from './blockly-project-clean-state';


@Injectable({
  providedIn: 'root'
})
export class _ProjectService {

  currentProjectPath;
  currentPackageData;
  private initialized = false; // 防止重复初始化
  private readonly cleanState = new BlocklyProjectCleanState(workspace => this.blocklyService.getWorkspaceLoadReadbackView(workspace));
  private hydration?: Subscription;

  constructor(
    private blocklyService: BlocklyService,
    private actionService: ActionService,
    private electronService: ElectronService
  ) { }

  init() {
    if (this.initialized) {
      console.warn('_ProjectService 已经初始化过了，跳过重复初始化');
      return;
    }
    
    this.initialized = true;
    this.cleanState.clear();
    this.hydration = this.blocklyService.projectPageHydrated.subscribe(({ before, after }) =>
      this.cleanState.acceptHydration(this.cleanScope(), before, after));

    this.actionService.listen('project-save', async (action) => {
      await this.save(action.payload.path);
    }, 'project-save-handler');
    this.actionService.listen('project-check-unsaved', async () =>
      ({ hasUnsavedChanges: await this.hasUnsavedChanges() }), 'project-check-unsaved-handler');
  }

  destroy() {
    this.actionService.unlisten('project-save-handler');
    this.actionService.unlisten('project-check-unsaved-handler');
    this.hydration?.unsubscribe();
    this.cleanState.clear();
    this.initialized = false; // 重置初始化状态
  }

  async hasUnsavedChanges(): Promise<boolean> {
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
    return canonicalJsonStringify(memory) !== canonicalJsonStringify(this.blocklyService.normalizeProjectAbi(materialized));
  }

  /** Called only by the authoritative open path, never an ABS draft/rollback. */
  rememberLoadedProject(path: string, diskText: string, source: BlocklyProjectDocument): void {
    const context = this.captureSaveContext(path);
    context.assertCurrent(); // A stale caller must not erase a newer project's record.
    this.cleanState.clear();
    try {
      if (window['fs'].readFileSync(`${path}/project.abi`, 'utf8') !== diskText) throw new Error('Project changed during loading.');
      const document = this.blocklyService.getProjectAbiForSave();
      assertProjectLoadPreserved(this.blocklyService.getProjectAbiForSave(source), document,
        workspace => this.blocklyService.getWorkspaceLoadReadbackView(workspace));
      context.assertCurrent();
      this.cleanState.remember(this.cleanScope(), diskText, document);
    } catch (error) {
      this.cleanState.reject(error);
      // The caller must abort activation before publishing ready, running GC or
      // scheduling generation. A warning alone would announce a lossy load as successful.
      throw error;
    }
  }

  private cleanScope(): readonly unknown[] {
    // Saved content belongs to the editor/data session, not a generator implementation.
    // In-flight queries still capture the generator in captureSaveContext().
    return [this.currentProjectPath, this.blocklyService.workspace, projectDataRuntime.getSessionToken()];
  }

  /** Library reload shares the save/ABS queue, but never saves the user's edits. */
  rebuildLibraryRuntime(options: BlocklyLibraryRuntimeRebuildOptions): Promise<void> {
    const context = this.captureSaveContext(options.projectPath);
    return this.blocklyService.runProjectOperation(async () => {
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
      let recoveryPath: string | undefined;
      let runtimeChanged = false;
      try {
        await projectDataRuntime.flushPending();
        context.assertCurrent();
        const before = this.blocklyService.getProjectAbiForSave(this.blocklyService.getProjectDocument(lease));
        const fs = window['fs'], abiPath = `${options.projectPath}/project.abi`;
        const disk = fs.readFileSync(abiPath, 'utf8');
        this.cleanState.compare(scope, disk, before);
        const directory = `${options.projectPath}/.temp`;
        fs.mkdirSync(directory, { recursive: true });
        recoveryPath = `${directory}/library-runtime-${crypto.randomUUID()}.recovery.json`;
        // A detached, materialized document is recoverable even if a new library cannot load it.
        fs.writeFileSync(recoveryPath, JSON.stringify(before), { encoding: 'utf8', flag: 'wx' });
        runtimeChanged = true;
        await this.blocklyService.rebuildLibraryRuntimeInPlace(options, lease, assertCurrent);
        assertCurrent();
        if (fs.readFileSync(abiPath, 'utf8') !== disk) throw new Error('project.abi changed during library runtime rebuild.');
        // The editor's load/readback boundary preserved content; page hydration may
        // acknowledge native defaults only. Never remember() this unsaved snapshot.
        try { fs.unlinkSync(recoveryPath); } catch (error) { console.warn('Could not remove completed runtime recovery snapshot:', error); }
      } catch (error) {
        if (!runtimeChanged) throw error;
        const message = `Library runtime rebuild failed: ${String((error as Error)?.message || error)}. `
          + `Unsaved project snapshot: ${recoveryPath}. Original project.abi was not saved; repair the library before restoring this snapshot.`;
        try { assertCurrent(); this.cleanState.reject(new Error(message)); lease.quarantine(message); } catch { /* Never quarantine a replacement project. */ }
        throw new Error(message);
      } finally { lease.release(); }
    });
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
    const memory = canonicalJsonStringify(this.blocklyService.normalizeProjectAbi(this.blocklyService.getProjectAbiForSave(document)));
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
    const disk = canonicalJsonStringify(this.blocklyService.normalizeProjectAbi(materialized));
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

  save(path: string): Promise<void> {
    const context = this.captureSaveContext(path);
    return this.blocklyService.runProjectOperation(async () => {
      context.assertCurrent();
      const abiPath = `${path}/project.abi`;
      const expectedAbi = window['fs'].existsSync(abiPath) ? window['fs'].readFileSync(abiPath, 'utf8') : null;
      const lease = this.blocklyService.acquireWorkspaceEditLease();
      try {
        await projectDataRuntime.flushPending();
        context.assertCurrent();
        const assertContext = () => { context.assertCurrent(); lease.assertCurrent(); };
        const generated = await this.blocklyService.prepareProjectCode(assertContext, lease);
        assertContext();
        const snapshot = this.blocklyService.captureProjectSnapshot(lease);
        if (generated && generated.revision !== snapshot.revision) throw new Error('Project changed after code preparation; retry saving the latest revision.');
        const document = snapshot.document;
        const assertRevision = () => {
          assertContext();
          if (this.blocklyService.captureProjectSnapshot(lease).revision !== snapshot.revision) {
            throw new Error('Project state changed during save preparation; retry saving the latest revision.');
          }
        };
        const prepared = await this.prepareSave(document, assertRevision);
        const publication = await this.commitPreparedSave(path, prepared, expectedAbi, assertRevision).catch(error => {
          if (error instanceof ProjectFilePublicationError && error.uncertain && context.isCurrent()) {
            // Do not overwrite a commit whose acknowledgement was lost, or quarantine a new context.
            lease.quarantine(error.message);
          }
          throw error;
        });
        if (publication?.warnings?.length) console.warn('Project ABI committed with host cleanup warnings:', publication.warnings);
        // ABI is now committed. Later derived-code failures must not imply it was rolled back.
        try {
          assertRevision();
          await this.publishPreparedSaveOutputs(path, prepared, generated, assertRevision);
        } catch (error) {
          console.warn('Project ABI is saved; skipped stale derived metadata/code updates:', error);
        }
      } finally { lease.release(); }
    });
  }

  prepareSave(document: BlocklyProjectDocument, assertCurrent: () => void): Promise<PreparedBlocklySave> {
    return prepareBlocklySave(document, snapshot => this.blocklyService.getProjectAbiForSave(snapshot), assertCurrent);
  }

  commitPreparedSave(path: string, prepared: PreparedBlocklySave, expectedAbi: string | null, assertCurrent: () => void) {
    return commitPreparedBlocklySave(path, prepared, expectedAbi, window['fs'], assertCurrent);
  }

  /** Acknowledge the committed snapshot before publishing fallible derived outputs. */
  async publishPreparedSaveOutputs(path: string, prepared: PreparedBlocklySave, generated: PreparedBlocklyCode | null, assertCurrent: () => void) {
    assertCurrent();
    if (path !== this.currentProjectPath || window['fs'].readFileSync(`${path}/project.abi`, 'utf8') !== prepared.abiText) {
      throw new Error('Cannot acknowledge a stale project save.');
    }
    this.cleanState.remember(this.cleanScope(), prepared.abiText,
      this.blocklyService.normalizeProjectAbi(this.blocklyService.getProjectAbiForSave(JSON.parse(prepared.documentText))));
    if (generated?.code !== null) await publishGeneratorMacros(path, generated?.projectMacros, assertCurrent);
    this.syncUsedLibraryManifest(path, JSON.parse(prepared.documentText));
    await this.publishPreparedCode(path, generated, assertCurrent);
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
      packageJson[AILY_BLOCKLY_USED_LIBRARIES_FIELD] = this.blocklyService.getProjectUsedLibraryManifest(packageJson, projectDocument);
      const nextContent = JSON.stringify(packageJson, null, 2);
      if (nextContent !== originalContent) {
        window['fs'].writeFileSync(packageJsonPath, nextContent);
      }
      this.currentPackageData = packageJson;
      window['packageJson'] = packageJson;
      return nextContent !== originalContent;
    } catch (error) {
      console.error('更新项目使用库清单失败:', error);
      return false;
    }
  }

  /** Post-commit work consumes immutable code/artifacts; never calls a Generator. */
  private async publishPreparedCode(path: string, generated: PreparedBlocklyCode | null, assertCurrent: () => void) {
    if (!generated || generated.code === null) {
      if (generated?.error) console.warn('Project ABI is saved; code generation failed:', generated.error);
      return;
    }
    assertCurrent();
    // Save/ABS publication owns this exact prepared snapshot too. Updating only
    // codeSubject leaves the IPC viewer/map on the previous generation until a
    // later UI debounce happens to regenerate. Disk contention must not hide it.
    this.blocklyService.publishPreparedCodeView(generated.code, generated.blockCodeMapText);
    // The artifact snapshot is the captured Arduino publication capability.
    // Publish its sketch and headers together, as startup/build already do;
    // otherwise a successful ABS save leaves the on-disk sketch one edit behind.
    // Other generators have null artifacts and must not write Python into .ino.
    await writePreparedArduinoGeneratedArtifacts(path, generated.artifacts,
      generated.artifacts === null ? undefined : generated.code);
    assertCurrent();
    if (this.electronService?.calculateHash) {
      const codeHash = await this.electronService.calculateHash(generated.code);
      assertCurrent();
      patchBuildMetadata(path, { codeHash });
    }
  }

}
