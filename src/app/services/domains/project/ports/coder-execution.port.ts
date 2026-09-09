import { InjectionToken } from '@angular/core';

/** Project-addressed Coder execution; the active UI tab is never an execution target. */
export interface CoderExecutionPort {
  build(projectPath: string, options?: { preprocessOnly?: boolean; clearCache?: boolean }): Promise<any>;
  upload(projectPath: string, port?: string): Promise<any>;
  cancel(projectPath: string, kind: 'build' | 'upload'): void;
}

export const CODER_EXECUTION_PORT = new InjectionToken<CoderExecutionPort>('CODER_EXECUTION_PORT');
