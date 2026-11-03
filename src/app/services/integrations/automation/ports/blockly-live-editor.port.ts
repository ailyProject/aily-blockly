import { InjectionToken } from '@angular/core';
import type * as Blockly from 'blockly';
import type { ProjectSaveOutcome } from '@domain/project/public-api';

export interface BlocklyProjectRevisionSnapshot {
  algorithm: 'sha256';
  scope: 'normalized-materialized-project-abi';
  memoryHash: string;
  diskHash: string;
  changed: boolean;
  usedLibraries: string[];
}

export interface BlocklyRuntimeMetadataSnapshot {
  blocks: readonly unknown[];
  failures: string[];
}

export interface BlocklyLibraryRuntimeSnapshot {
  active: boolean;
  loadedLibraries: string[];
  toolboxLibraries: string[];
  failedLibraries: string[];
}

export interface BlocklyLiveEditorPort {
  getWorkspace(): Blockly.WorkspaceSvg | null;
  /** Queue only the mutation; saving/importing inside this callback would re-enter the same FIFO. */
  runWorkspaceOperation<T>(operation: () => Promise<T>): Promise<T>;
  setAiWritingActive(source: string, active: boolean): void;
  saveProject(path: string): Promise<ProjectSaveOutcome | void>;
  getProjectRevisionSnapshot(): Promise<BlocklyProjectRevisionSnapshot>;
  getRuntimeBlockMetadataSnapshot(): BlocklyRuntimeMetadataSnapshot;
  getLibraryRuntimeSnapshot(): BlocklyLibraryRuntimeSnapshot;
}

export const BLOCKLY_LIVE_EDITOR_PORT = new InjectionToken<BlocklyLiveEditorPort>(
  'BLOCKLY_LIVE_EDITOR_PORT',
);
