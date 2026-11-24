import { InjectionToken } from '@angular/core';
import type { BuildLocalFallbackControl } from '../../../../utils/cloud-build-progress.utils';

/** Project-addressed Coder execution; the active UI tab is never an execution target. */
export interface CoderExecutionPort {
  build(projectPath: string, options?: { preprocessOnly?: boolean; clearCache?: boolean; requestId?: string;
    localFallback?: BuildLocalFallbackControl }): Promise<any>;
  upload(projectPath: string, port?: string): Promise<any>;
  cancel(projectPath: string, kind: 'build' | 'upload'): void;
}

export const CODER_EXECUTION_PORT = new InjectionToken<CoderExecutionPort>('CODER_EXECUTION_PORT');
