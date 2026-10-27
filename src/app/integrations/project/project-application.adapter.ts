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
  ) {}

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

  hasActiveBlocklyBuildOrUpload(projectPath: string): boolean {
    if (!this.isSameProjectPath(projectPath, this.projectService.currentProjectPath)) return false;
    return [ProcessState.BUILDING, ProcessState.UPLOADING, ProcessState.INSTALLING]
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

  dispatchProjectSave(path: string, timeoutMs: number): Promise<ProjectSaveDispatchResult> {
    return new Promise((resolve) => {
      this.actionService.dispatch('project-save', { path }, (result) => {
        const outcome = result.data;
        const structured = outcome && typeof outcome.projectSaved === 'boolean'
          && typeof outcome.generatedCodePublished === 'boolean' && typeof outcome.partial === 'boolean'
          ? outcome : undefined;
        resolve({ ...structured, success: result.success && (!structured || structured.projectSaved && !structured.partial),
          error: structured?.error || (structured?.partial ? '项目文件已保存，但生成代码未完整发布。' : result.error) });
      }, timeoutMs);
    });
  }

  hasUnsavedBlocklyChanges(): Promise<boolean> {
    const path = this.projectService.currentProjectPath;
    return new Promise((resolve, reject) => {
      this.actionService.dispatch('project-check-unsaved', {}, (result) => {
        if (path !== this.projectService.currentProjectPath) return reject(new Error('Project changed during the unsaved-state check.'));
        if (!result.success || typeof result.data?.hasUnsavedChanges !== 'boolean') {
          return reject(new Error(result.error || 'The editor did not return a valid unsaved-state result.'));
        }
        resolve(result.data.hasUnsavedChanges);
      }, 15000);
    });
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
      previousRuntimeSignature === runtimeSignature
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
    });
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
