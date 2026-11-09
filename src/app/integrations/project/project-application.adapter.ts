import { recordLibraryMutation } from '../../editors/blockly-editor/services/blockly-library-history';
import type { ProjectSaveRequest } from '@domain/project/public-api';
import type { BlocklyProjectDocument } from '../../editors/blockly-editor/services/blockly.service';
import { Injectable, Injector } from '@angular/core';
import { ActionService, UiService, WorkflowService, ProcessState } from '@core/app-shell/public-api';
import { DEPENDENCY_APPLICATION_PORT, NpmService } from '@domain/dependencies/public-api';
import {
  BlocklyLibraryRuntimeRebuildInput,
  ProjectApplicationPort,
  ProjectService,
  type BlocklySaveAsSnapshot,
  type ProjectSaveDispatchResult,
  type ProjectRecoveryFragment,
  type ProjectConflictChoice,
  type ProjectConflictResolution,
  type AilyDataRef,
  canonicalProjectJsonStringify,
  materializeGenericProjectDataValues,
  projectDataRuntime,
} from '@domain/project/public-api';
import { AiOperationRegistryService } from '@integration/automation/public-api';
import { isAilyLibraryPackageName } from '@shared/public-api';
import { applyCdcSerialPortOverrides } from '../../editors/blockly-editor/components/blockly/abf';
import { BlocklyGeneratorRuntimeService } from '../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { _ProjectService as BlocklyEditorProjectService } from '../../editors/blockly-editor/services/project.service';
import { fenceBlocklyWorkspaceInput } from '../../editors/blockly-editor/services/blockly-workspace-edit-lease';
import { CoderProjectRuntimeService } from '../coder/coder-project-runtime.service';
import { NzModalService } from 'ng-zorro-antd/modal';
import { firstValueFrom } from 'rxjs';
import { PasteInstallDialogComponent } from '../../editors/blockly-editor/components/paste-install-dialog/paste-install-dialog.component';
import { AbsWorkspaceSyncService } from '../blockly/abs/abs-workspace-sync.service';
import { CodeEditorProProjectService } from '../../editors/code-editor-pro/services/code-editor-pro-project.service';
import { settleLinkedProjectEnvironment } from '../blockly/environment-settlement';

@Injectable({ providedIn: 'root' })
export class ProjectApplicationAdapter implements ProjectApplicationPort {
  constructor(
    private readonly actionService: ActionService,
    private readonly uiService: UiService,
    private readonly aiOperationRegistry: AiOperationRegistryService,
    private readonly npmService: NpmService,
    private readonly projectService: ProjectService,
    private readonly generatorRuntime: BlocklyGeneratorRuntimeService,
    private readonly blocklyService: BlocklyService,
    private readonly blocklyEditorProjectService: BlocklyEditorProjectService,
    private readonly injector: Injector,
  ) {
    this.blocklyEditorProjectService.setEnvironmentRuntimeReader?.(async project => {
      const runtime = await this.projectService.readBlocklyEnvironmentRuntime(project);
      const libraryNames = (await this.npmService.getAllInstalledLibraries(project)).map(item => item.name);
      runtime.assertCurrent();
      return { ...runtime, libraryNames };
    });
  }

  publishBlocklyEnvironmentMutation(project: string, mutate: (publication: unknown) => Promise<any>, request?: ProjectSaveRequest) {
    return this.blocklyEditorProjectService.publishEnvironmentMutation(project, mutate, request);
  }

  async settleEnvironmentBeforeOpen(project: string, assertCurrent: () => void): Promise<void> {
    await settleLinkedProjectEnvironment(project, assertCurrent);
  }

  updateFooterState(state: { state: string; text: string; timeout?: number }): void {
    this.uiService.updateFooterState(state);
  }

  materializeCoderProjectLibraries(projectPath: string): Promise<void> {
    return this.injector.get(DEPENDENCY_APPLICATION_PORT).materializeCoderProjectLibraries(projectPath);
  }

  closeTerminal(): void {
    this.uiService.closeTerminal();
  }

  closeConnectionGraphWindows(): Promise<boolean> {
    return this.uiService.closeConnectionGraphWindows();
  }

  hasActiveProjectMutation(projectPath: string): boolean {
    return this.aiOperationRegistry.hasBlocking(projectPath)
      || this.isSameProjectPath(projectPath, this.projectService.currentProjectPath)
        && this.generatorRuntime.isActive() && this.blocklyService.isWorkspaceEditInProgress();
  }

  hasActiveBlocklyBuildOrUpload(projectPath: string, libraryOperation = false): boolean {
    if (!this.isSameProjectPath(projectPath, this.projectService.currentProjectPath)) return false;
    return [ProcessState.BUILDING, ProcessState.UPLOADING, ...(!libraryOperation ? [ProcessState.INSTALLING] : [])]
      .includes(this.injector.get(WorkflowService).currentState);
  }

  captureBlocklySaveAsSnapshot(path: string): Promise<BlocklySaveAsSnapshot> {
    return this.blocklyEditorProjectService.captureSaveAsSnapshot(path);
  }

  captureBlocklyRecoveryCopySnapshot(path: string): Promise<BlocklySaveAsSnapshot> {
    return this.blocklyEditorProjectService.captureRecoveryCopySnapshot(path);
  }

  async captureBlocklyRecoveryFragment(path: string): Promise<ProjectRecoveryFragment> {
    const workspace = this.blocklyService.workspace, token = projectDataRuntime.getSessionToken();
    const assertCurrent = () => {
      if (!this.isSameProjectPath(path, this.projectService.currentProjectPath)
        || !this.isSameProjectPath(path, this.blocklyEditorProjectService.currentProjectPath)
        || workspace !== this.blocklyService.workspace || token !== projectDataRuntime.getSessionToken()
        || this.blocklyService.isWorkspaceEditInProgress()) {
        throw new Error('The partial native view changed or belongs to another project.');
      }
    };
    try {
      assertCurrent();
      const snapshot = this.blocklyService.captureRecoverySnapshot();
      const document = await materializeGenericProjectDataValues(snapshot.document, {
        resolve: async <TValue>(ref: AilyDataRef) => { const value = await projectDataRuntime.resolve<TValue>(ref); assertCurrent(); return value; },
      });
      assertCurrent();
      if (this.blocklyService.captureRecoverySnapshot().documentText !== snapshot.documentText) {
        throw new Error('The partial native view changed while its data references were read.');
      }
      const isCurrent = () => {
        try { assertCurrent(); return this.blocklyService.captureRecoverySnapshot().documentText === snapshot.documentText; }
        catch { return false; }
      };
      return { documentText: canonicalProjectJsonStringify(document), isCurrent,
        freezeForActivation: () => {
          if (!isCurrent()) throw new Error('The partial native view changed before activation.');
          return fenceBlocklyWorkspaceInput(workspace?.getParentSvg?.()?.parentElement ?? undefined);
        } };
    } catch (error) {
      return { error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };
    }
  }

  hasRunningAi(): boolean {
    return this.aiOperationRegistry.readActive().some(operation => operation.source.startsWith('child-chat-run:')
      || operation.source.startsWith('child-tool:'));
  }

  prepareProjectCopy(projectPath: string) {
    return this.projectService.getProjectMode(projectPath) === 'coder'
      ? this.injector.get(CodeEditorProProjectService).prepareCopy(projectPath)
      : this.injector.get(AbsWorkspaceSyncService).prepareCopy();
  }

  dispatchProjectSave(path: string, timeoutMs: number, request?: ProjectSaveRequest): Promise<ProjectSaveDispatchResult> {
    return new Promise((resolve) => {
      this.actionService.dispatch('project-save', { path, ...(request ? { saveRequest: request } : {}) }, (result) => {
        const outcome = result.data;
        if (outcome?.code === 'ACTION_HANDLER_UNAVAILABLE') {
          resolve({ success: false, code: 'PROJECT_SAVE_HANDLER_UNAVAILABLE', projectSaved: false,
            generatedCodePublished: false, partial: false, error: '保存处理器尚未就绪，未开始保存。' });
          return;
        }
        const structured = outcome && typeof outcome.projectSaved === 'boolean'
          && typeof outcome.generatedCodePublished === 'boolean' && typeof outcome.partial === 'boolean'
          ? outcome : undefined;
        resolve({ ...structured, success: result.success && (!structured || structured.projectSaved && !structured.partial),
          error: structured?.error || (structured?.partial ? '项目文件已保存，但生成代码未完整发布。' : result.error) });
      }, timeoutMs, { requireHandler: true });
    });
  }

  observeProjectPublication(path: string, request: ProjectSaveRequest, originalTargetPid?: number) {
    return this.injector.get(AbsWorkspaceSyncService).observeNativeSave(path, request, originalTargetPid);
  }

  async inspectBlocklyConflict(path: string) {
    this.assertConflictProject(path);
    return this.injector.get(AbsWorkspaceSyncService).inspectViewConflict();
  }

  async resolveBlocklyConflict(path: string, choice: ProjectConflictChoice, token: string): Promise<ProjectConflictResolution> {
    this.assertConflictProject(path);
    const outcome = await this.injector.get(AbsWorkspaceSyncService).resolveViewConflict(choice, token);
    const projectSaved = outcome.publication.status === 'COMMITTED' && !outcome.requiresReload;
    const generatedCodePublished = outcome.derivedOutputs?.published ?? outcome.warnings.length === 0;
    return { project: path, choice, refreshed: outcome.refreshed, generation: outcome.publication.generation,
      projectSaved, generatedCodePublished, partial: !projectSaved || !generatedCodePublished,
      ...(!projectSaved || !generatedCodePublished ? { code: outcome.derivedOutputs?.code ?? 'ABS_VIEW_RESOLUTION_INCOMPLETE',
        error: outcome.derivedOutputs?.error ?? outcome.publication.error ?? outcome.warnings.join('\n') } : {}) };
  }

  private assertConflictProject(path: string): void {
    if (!this.isSameProjectPath(path, this.projectService.currentProjectPath)
      || this.projectService.getProjectMode(path) !== 'blockly'
      || !this.projectService.getBlocklyProjectLoadStatus(path)?.ready) {
      throw Object.assign(new Error('Conflict resolution requires this fully loaded Blockly project.'), { code: 'ABS_CONTEXT_STALE' });
    }
  }

  hasUnsavedBlocklyChanges(): Promise<boolean> {
    const path = this.projectService.currentProjectPath;
    return new Promise((resolve, reject) => {
      this.actionService.dispatch('project-check-unsaved', {}, (result) => {
        if (path !== this.projectService.currentProjectPath) return reject(new Error('Project changed during the unsaved-state check.'));
        if (!result.success || typeof result.data?.hasUnsavedChanges !== 'boolean') {
          return reject(Object.assign(new Error(result.data?.error || result.error || 'The editor did not return a valid unsaved-state result.'),
            typeof result.data?.code === 'string' ? { code: result.data.code } : {}));
        }
        resolve(result.data.hasUnsavedChanges);
      }, 15000);
    });
  }

  async captureBlocklyLibraryDocument(): Promise<unknown> {
    const workspace = this.blocklyService.workspace, session = projectDataRuntime.getSessionToken();
    const document = this.blocklyService.getProjectAbiForSave(this.blocklyService.getProjectDocument());
    const materialized = await materializeGenericProjectDataValues(document, {
      resolve: async <T>(ref: AilyDataRef) => projectDataRuntime.resolve<T>(ref),
    });
    if (workspace !== this.blocklyService.workspace || session !== projectDataRuntime.getSessionToken()) {
      throw new Error('Project changed while capturing library history.');
    }
    return materialized;
  }

  async prepareBlocklyLibraryEdit(projectPath: string, removedPackages: string[] = []) {
    const workspace = this.blocklyService.workspace;
    if (!workspace || !this.isBlocklyLibraryRuntimeReady(projectPath)) throw new Error('Blockly library runtime is not ready.');
    this.blocklyService.assertWorkspaceEditAvailable();
    const releaseInput = fenceBlocklyWorkspaceInput(workspace.getParentSvg()?.parentElement ?? undefined, { allowNavigation: true });
    let resumePreprocess: (() => void) | undefined;
    const release = () => { releaseInput(); resumePreprocess?.(); };
    try {
      resumePreprocess = await this.blocklyEditorProjectService.pauseBackgroundPreprocess(projectPath);
      if (workspace !== this.blocklyService.workspace || projectPath !== this.projectService.currentProjectPath) {
        throw new Error('Project changed before the library transaction could start.');
      }
      workspace.cancelCurrentGesture();
      const document = await this.captureBlocklyLibraryDocument();
      const used = this.blocklyService.getProjectUsedLibraryManifest(this.projectService.currentPackageData, document as BlocklyProjectDocument);
      if (removedPackages.some(name => used[name])) throw Object.assign(new Error('项目仍在使用待卸载库的积木，请先删除或替换这些积木。'), {code:'LIBRARY_IN_USE'});
      return { document, usedLibraries: Object.keys(used), release, record: (restore: (forward: boolean) => Promise<void | boolean>) => {
        if (workspace !== this.blocklyService.workspace) throw new Error('Blockly workspace changed before recording library history.');
        recordLibraryMutation(workspace, restore, error => this.updateFooterState({ state: 'error', text: String(error instanceof Error ? error.message : error) }));
      } };
    } catch (error) { release(); throw error; }
  }

  async confirmBlocklyLibraryRestore(offer: { forward: boolean; packages: string[];
    changes: { name: string; field?: string; before: string | null; after: string | null }[] }, apply: () => Promise<void>): Promise<boolean> {
    const action = offer.forward ? '重做' : '撤销';
    const changes: typeof offer.changes = offer.changes.length ? offer.changes : offer.packages.map(name => ({ name, after: '锁定版本', before: null }));
    const modal = this.injector.get(NzModalService).create({
      nzContent: PasteInstallDialogComponent, nzFooter: null, nzClosable: false,
      nzMaskClosable: false, nzKeyboard: false, nzWidth: 560,
      nzData: {
        title: `${action}库变更`,
        message: '此操作需要重新安装或移除以下依赖，成功后恢复积木。画布不会自动保存，可能需要联网。',
        confirmText: `恢复依赖并${action}`,
        missingLibs: changes.map(change => ({ name: changes.filter(item => item.name === change.name).length > 1
          ? `${change.name}（${change.field}）` : change.name, blockType: '',
          version: change.after === null ? `移除（当前 ${change.before}）` : `安装 ${change.after}` })),
        installFn: apply,
      },
    });
    return (await firstValueFrom(modal.afterClose))?.result === 'installed';
  }

  isBlocklyLibraryRuntimeReady(path: string): boolean {
    return this.isSameProjectPath(path, this.blocklyEditorProjectService.currentProjectPath)
      && this.blocklyService.isLibraryRuntimeReady();
  }

  hasBlocklyRuntimeRecovery(path: string): boolean {
    return this.isSameProjectPath(path, this.blocklyEditorProjectService.currentProjectPath)
      && this.blocklyEditorProjectService.hasLibraryRuntimeRecovery();
  }

  recoverBlocklyRuntimeInPlace(path: string, signal?: AbortSignal) {
    if (!this.isSameProjectPath(path, this.blocklyEditorProjectService.currentProjectPath)) {
      return Promise.resolve({ ready: false, code: 'PROJECT_RECOVERY_CONTEXT_STALE', message: 'The selected project changed.' });
    }
    return this.blocklyEditorProjectService.recoverRuntimeInPlace(signal);
  }

  async acknowledgeBlocklyRecoveryDiscard(path: string): Promise<void> {
    if (this.isSameProjectPath(path, this.blocklyEditorProjectService.currentProjectPath)) {
      await this.blocklyEditorProjectService.discardRetainedOperation(path);
    }
  }

  async prepareBlocklyRecoveryDiscard(path: string) {
    if (!this.isSameProjectPath(path, this.blocklyEditorProjectService.currentProjectPath)) throw new Error('The departing recovery view changed.');
    return this.blocklyEditorProjectService.prepareRetainedDiscard(path);
  }

  applyCdcSerialPortOverrides(boardConfig: any, cdcEnabled: boolean): any {
    return applyCdcSerialPortOverrides(boardConfig, cdcEnabled);
  }

  async rebuildActiveBlocklyLibraryRuntime(
    input: BlocklyLibraryRuntimeRebuildInput,
  ): Promise<boolean> {
    const {
      projectPath,
      packageContent,
      runtimeSignature,
      previousRuntimeSignature,
    } = input;
    if (
      !this.generatorRuntime.isActive()
      || !this.isSameProjectPath(projectPath, this.projectService.currentProjectPath)
    ) {
      return false;
    }

    const packageJson = JSON.parse(packageContent);
    const workspace = this.blocklyService.workspace;
    const libraryNames = (await this.npmService.getAllInstalledLibraries(projectPath))
      .map((item) => item.name);
    if (workspace !== this.blocklyService.workspace
      || !this.isSameProjectPath(projectPath, this.projectService.currentProjectPath)) {
      throw new Error('Project changed while discovering libraries for runtime rebuild.');
    }
    const loadedLibraryNames = Array.from(this.blocklyService.loadedLibraryInfos.values())
      .map((item) => item.packageName);
    const declaredLibraryNames = new Set(
      Object.keys({
        ...(packageJson?.dependencies || {}),
        ...(packageJson?.devDependencies || {}),
        ...(packageJson?.optionalDependencies || {}),
      }).filter((name) => isAilyLibraryPackageName(name)),
    );
    const scannedLibraryNames = new Set(libraryNames);
    const missingRetainedLibraryNames = [...new Set(loadedLibraryNames)]
      .filter((name) => declaredLibraryNames.has(name) && !scannedLibraryNames.has(name))
      .sort((a, b) => a.localeCompare(b));
    if (missingRetainedLibraryNames.length > 0) {
      throw new Error(
        '[BlocklyLibraryRuntime] retained dependencies are not ready: '
        + missingRetainedLibraryNames.join(', '),
      );
    }

    // getAllInstalledLibraries() already returns the toolbox's canonical order.
    const orderedLibraryNames = [...new Set(libraryNames)];
    const normalizedLibraryNames = [...orderedLibraryNames].sort((a, b) => a.localeCompare(b));
    const normalizedLoadedLibraryNames = [...new Set(loadedLibraryNames)].sort((a, b) => a.localeCompare(b));
    if (
      input.retainedDocument === undefined
      && previousRuntimeSignature === runtimeSignature
      && this.isBlocklyLibraryRuntimeReady(projectPath)
      && JSON.stringify(normalizedLoadedLibraryNames) === JSON.stringify(normalizedLibraryNames)
    ) {
      return false;
    }

    this.projectService.currentPackageData = packageJson;
    this.blocklyEditorProjectService.currentPackageData = packageJson;
    window['packageJson'] = packageJson;
    this.blocklyService.setToolboxSortOrder(packageJson?.blocklyToolboxOrder);
    await this.blocklyEditorProjectService.rebuildLibraryRuntime({
      projectPath,
      packageJson,
      libraryNames: orderedLibraryNames,
      projectService: this.projectService,
    }, undefined, input.retainedDocument as BlocklyProjectDocument | undefined);
    return true;
  }

  reinstallAilyCodeDependencies(projectPath: string): Promise<boolean> {
    if (!this.isSameProjectPath(projectPath, this.projectService.currentProjectPath)) {
      // Conversion installs into an inactive Coder context, never the active Blockly manifest.
      return this.injector.get(CoderProjectRuntimeService).getSession(projectPath).injector
        .get(NpmService).reinstallDepsForAilyCodeBoardSwitch(projectPath);
    }
    return this.npmService.reinstallDepsForAilyCodeBoardSwitch(projectPath);
  }

  private isSameProjectPath(left: string, right: string): boolean {
    const normalize = (value: string) => String(value || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/u, '')
      .toLowerCase();
    return normalize(left) === normalize(right);
  }
}
