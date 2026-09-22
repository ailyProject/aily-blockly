import { Injectable } from '@angular/core';
import { AILY_BLOCKLY_USED_LIBRARIES_FIELD, BlocklyProjectDocument, BlocklyService } from './blockly.service';
import { ActionService } from '@core/app-shell/public-api';
import { getActiveProjectGenerator, getActiveProjectGeneratorRevision } from './blockly-generator-runtime.service';
import { ElectronService, ProjectFilePublicationError } from '@core/platform/public-api';
import {
  projectDataRuntime,
  canonicalJsonStringify,
  materializePreparedGenericProjectDataValues,
  materializeGenericProjectDataValues,
  type AilyDataRef,
} from '@domain/project/public-api';
import { sha256Hex } from '../../../utils/crypto.utils';
import { writePreparedArduinoGeneratedArtifacts } from './generated-code-artifacts';
import { patchBuildMetadata } from '../../../utils/build-publication.utils';
import type { PreparedBlocklyCode } from './prepared-project-code';
import { PreparedBlocklySave, prepareBlocklySave, commitPreparedBlocklySave } from './prepared-project-save';


@Injectable({
  providedIn: 'root'
})
export class _ProjectService {

  currentProjectPath;
  currentPackageData;
  private initialized = false; // 防止重复初始化

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

    this.actionService.listen('project-save', async (action) => {
      await this.save(action.payload.path);
    }, 'project-save-handler');
    this.actionService.listen('project-check-unsaved', (action) => {
      let result = this.hasUnsavedChanges();
      return { hasUnsavedChanges: result };
    }, 'project-check-unsaved-handler');
  }

  destroy() {
    this.actionService.unlisten('project-save-handler');
    this.actionService.unlisten('project-check-unsaved-handler');
    this.initialized = false; // 重置初始化状态
  }

  close() {

  }

  hasUnsavedChanges(): boolean {
    try {
      const abi = this.getComparableAbiJson();
      return abi.memory !== abi.disk;
    } catch (error) {
      console.error('检查未保存更改时出错:', error);
      // 出错时，保守地返回 true，表示可能有未保存的更改
      return true;
    }
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
      resolve: async <TValue>(ref: AilyDataRef) => { const value = await projectDataRuntime.resolve<TValue>(ref); assertCurrent(); return value; },
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

  private getComparableAbiJson(): { memory: string; disk: string } {
    const memoryAbi = this.blocklyService.normalizeProjectAbi(
      this.blocklyService.getProjectAbiForSave(),
    );
    const diskExternalAbi = JSON.parse(
      window['fs'].readFileSync(`${this.currentProjectPath}/project.abi`, 'utf8'),
    );
    const diskAbi = this.blocklyService.normalizeProjectAbi(
      materializePreparedGenericProjectDataValues(
        diskExternalAbi,
        (ref) => projectDataRuntime.getPrepared(ref),
      ),
    );

    return {
      memory: canonicalJsonStringify(memoryAbi),
      disk: canonicalJsonStringify(diskAbi),
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

  /** Shared post-commit output publication. No ABI save, Generator execution or clean-state mutation. */
  async publishPreparedSaveOutputs(path: string, prepared: PreparedBlocklySave, generated: PreparedBlocklyCode | null, assertCurrent: () => void) {
    assertCurrent();
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
    await writePreparedArduinoGeneratedArtifacts(path, generated.artifacts);
    assertCurrent();
    if (this.electronService?.calculateHash) {
      const codeHash = await this.electronService.calculateHash(generated.code);
      assertCurrent();
      patchBuildMetadata(path, { codeHash });
    }
  }

}
