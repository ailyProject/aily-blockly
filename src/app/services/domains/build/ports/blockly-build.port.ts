import { InjectionToken } from '@angular/core';
import type { BuildCheckpoint } from '../build-result-snapshot';

export interface BlocklyBuildInput {
  projectPath: string;
  graphSemanticRevision?: string;
  requestId?: string;
}

export interface BlocklyBuildOutcome {
  success: boolean;
  result: { state?: string; text?: string; message?: string; fullStdErr?: string };
  checkpoint: BuildCheckpoint;
}

/** Await the editor-owned task, not an independently expiring UI notification. */
export interface BlocklyBuildPort {
  isAvailable(): boolean;
  build(input: BlocklyBuildInput): Promise<BlocklyBuildOutcome>;
}

export const BLOCKLY_BUILD_PORT = new InjectionToken<BlocklyBuildPort>('BLOCKLY_BUILD_PORT');
