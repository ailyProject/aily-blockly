import { InjectionToken } from '@angular/core';
import type { BlocklySaveAsSnapshot, ProjectSaveOutcome } from '../project-save-outcome';
import type { ProjectRecoveryFragment } from '../project-disk-recovery';
import type { ProjectConflictChoice, ProjectConflictOffer, ProjectConflictResolution } from '../project-conflict';

export interface ProjectFooterState {
  state: string;
  text: string;
  timeout?: number;
}

export interface ProjectSaveDispatchResult extends Partial<ProjectSaveOutcome> {
  success: boolean;
  error?: string;
}

/** A retained editor revision. Writing a copy must never acknowledge/save the source. */
export interface ProjectCopySnapshot {
  write(targetPath: string): Promise<void>;
  assertCurrent(): Promise<void>;
  complete?(): Promise<void>;
  release(): void;
}

export interface BlocklyLibraryRuntimeRebuildInput {
  projectPath: string;
  packageContent: string;
  runtimeSignature: string;
  previousRuntimeSignature?: string;
  retainedDocument?: unknown;
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
  hasActiveProjectMutation(projectPath: string): boolean;
  /** Only the selected Blockly runtime; does not inspect or stop other projects. */
  hasActiveBlocklyBuildOrUpload(projectPath: string, libraryOperation?: boolean): boolean;
  hasRunningAi(): boolean;
  prepareProjectCopy(projectPath: string): Promise<ProjectCopySnapshot>;
  /** A zero feedback budget retains the original editor completion. Transport
   * observers use the domain receipt, never cancel or replay this save. */
  dispatchProjectSave(path: string, timeoutMs: number): Promise<ProjectSaveDispatchResult>;
  inspectBlocklyConflict?(path: string): Promise<ProjectConflictOffer>;
  resolveBlocklyConflict?(path: string, choice: ProjectConflictChoice, token: string): Promise<ProjectConflictResolution>;
  captureBlocklySaveAsSnapshot(sourcePath: string): Promise<BlocklySaveAsSnapshot>;
  captureBlocklyRecoveryCopySnapshot(sourcePath: string): Promise<BlocklySaveAsSnapshot>;
  /** Only a non-authoritative native fragment; failed-load copies use disk as primary. */
  captureBlocklyRecoveryFragment?(sourcePath: string): Promise<ProjectRecoveryFragment>;
  hasUnsavedBlocklyChanges(): Promise<boolean>;
  prepareBlocklyLibraryEdit?(projectPath: string, removedPackages?: string[]): Promise<{
    document: unknown;
    release(): void;
    record(restore: (forward: boolean) => Promise<void>): void;
  }>;
  captureBlocklyLibraryDocument?(): Promise<unknown>;
  /** File equality alone is not evidence that a failed Realm became ready. */
  isBlocklyLibraryRuntimeReady?(projectPath: string): boolean;
  hasBlocklyRuntimeRecovery?(projectPath: string): boolean;
  applyCdcSerialPortOverrides(boardConfig: any, cdcEnabled: boolean): any;
  rebuildActiveBlocklyLibraryRuntime(input: BlocklyLibraryRuntimeRebuildInput): Promise<boolean>;
  reinstallAilyCodeDependencies(projectPath: string): Promise<boolean>;
  materializeCoderProjectLibraries(projectPath: string): Promise<void>;
}

export const PROJECT_APPLICATION_PORT = new InjectionToken<ProjectApplicationPort>(
  'PROJECT_APPLICATION_PORT',
);
