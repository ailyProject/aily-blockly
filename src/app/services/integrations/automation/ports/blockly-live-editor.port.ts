import { InjectionToken } from '@angular/core';
import type * as Blockly from 'blockly';

export interface BlocklyProjectRevisionSnapshot {
  algorithm: 'sha256';
  scope: 'normalized-materialized-project-abi';
  memoryHash: string;
  diskHash: string;
  changed: boolean;
}

export interface BlocklyRuntimeMetadataSnapshot {
  blocks: readonly unknown[];
  failures: string[];
}

export interface BlocklyLiveEditorPort {
  getWorkspace(): Blockly.WorkspaceSvg | null;
  setAiWritingActive(source: string, active: boolean): void;
  saveProject(path: string, createHistory: boolean): Promise<void>;
  getProjectRevisionSnapshot(): Promise<BlocklyProjectRevisionSnapshot>;
  getRuntimeBlockMetadataSnapshot(): BlocklyRuntimeMetadataSnapshot;
}

export const BLOCKLY_LIVE_EDITOR_PORT = new InjectionToken<BlocklyLiveEditorPort>(
  'BLOCKLY_LIVE_EDITOR_PORT',
);
