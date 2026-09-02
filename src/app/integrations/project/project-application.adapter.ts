import { Injectable } from '@angular/core';
import { ActionService, UiService } from '@core/app-shell/public-api';
import { NpmService } from '@domain/dependencies/public-api';
import {
  BlocklyLibraryRuntimeRebuildInput,
  ProjectApplicationPort,
  ProjectService,
} from '@domain/project/public-api';
import { AiOperationRegistryService } from '@integration/automation/public-api';
import { isAilyLibraryPackageName } from '@shared/public-api';
import { applyCdcSerialPortOverrides } from '../../editors/blockly-editor/components/blockly/abf';
import { BlocklyGeneratorRuntimeService } from '../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { _ProjectService as BlocklyEditorProjectService } from '../../editors/blockly-editor/services/project.service';

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
  ) {}

  updateFooterState(state: { state: string; text: string; timeout?: number }): void {
    this.uiService.updateFooterState(state);
  }

  closeTerminal(): void {
    this.uiService.closeTerminal();
  }

  closeConnectionGraphWindows(): Promise<boolean> {
    return this.uiService.closeConnectionGraphWindows();
  }

  hasActiveAiOperation(projectPath: string): boolean {
    return this.aiOperationRegistry.hasActive(projectPath);
  }

  dispatchProjectSave(path: string, timeoutMs: number): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      this.actionService.dispatch('project-save', { path }, (result) => {
        resolve({ success: result.success, error: result.error });
      }, timeoutMs);
    });
  }

  hasUnsavedBlocklyChanges(): Promise<boolean> {
    return new Promise((resolve) => {
      this.actionService.dispatch('project-check-unsaved', {}, (result) => {
        console.log(result);
        resolve(!!result.data?.hasUnsavedChanges);
      });
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
    const libraryNames = (await this.npmService.getAllInstalledLibraries(projectPath))
      .map((item) => item.name);
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
    await this.blocklyService.rebuildLibraryRuntimeInPlace({
      projectPath,
      packageJson,
      libraryNames: orderedLibraryNames,
      projectService: this.projectService,
    });
    return true;
  }

  reinstallAilyCodeDependencies(projectPath: string): Promise<boolean> {
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
