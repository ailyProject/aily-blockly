import { InjectionToken } from '@angular/core';

export interface ProjectFooterState {
  state: string;
  text: string;
  timeout?: number;
}

export interface ProjectSaveDispatchResult {
  success: boolean;
  error?: string;
}

export interface BlocklyLibraryRuntimeRebuildInput {
  projectPath: string;
  packageContent: string;
  runtimeSignature: string;
  previousRuntimeSignature?: string;
}

/**
 * Application-owned behavior needed by the project domain.
 *
 * Implementations may coordinate UI, editor runtime, automation, and dependency
 * services. Keeping those details behind this port prevents ProjectService from
 * depending on application presentation or sibling domains.
 */
export interface ProjectApplicationPort {
  updateFooterState(state: ProjectFooterState): void;
  closeTerminal(): void;
  closeConnectionGraphWindows(): Promise<boolean>;
  hasActiveAiOperation(projectPath: string): boolean;
  dispatchProjectSave(path: string, timeoutMs: number): Promise<ProjectSaveDispatchResult>;
  hasUnsavedBlocklyChanges(): Promise<boolean>;
  applyCdcSerialPortOverrides(boardConfig: any, cdcEnabled: boolean): any;
  rebuildActiveBlocklyLibraryRuntime(input: BlocklyLibraryRuntimeRebuildInput): Promise<boolean>;
  reinstallAilyCodeDependencies(projectPath: string): Promise<boolean>;
}

export const PROJECT_APPLICATION_PORT = new InjectionToken<ProjectApplicationPort>(
  'PROJECT_APPLICATION_PORT',
);
