import { InjectionToken } from '@angular/core';
import type { BuildCheckpoint } from '../build-result-snapshot';
import type { ProjectBuildLogReference } from '../project-build-log';
import type { BuildSnapshot } from '../build-snapshot';

export interface BlocklyBuildInput {
  projectPath: string;
  graphSemanticRevision?: string;
  requestId?: string;
  clearCache?: boolean;
}

export interface BlocklyBuildOutcome {
  success: boolean;
  result: { state?: string; text?: string; message?: string; fullStdErr?: string; buildLog?: ProjectBuildLogReference;
    buildSource?: Record<string, unknown>; buildSnapshot?: BuildSnapshot };
  checkpoint: BuildCheckpoint;
}

/** Await the editor-owned task, not an independently expiring UI notification. */
export interface BlocklyBuildPort {
  isAvailable(): boolean;
  build(input: BlocklyBuildInput): Promise<BlocklyBuildOutcome>;
}

export const BLOCKLY_BUILD_PORT = new InjectionToken<BlocklyBuildPort>('BLOCKLY_BUILD_PORT');
