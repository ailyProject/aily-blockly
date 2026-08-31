import { InjectionToken } from '@angular/core';
import type { NoticeOptions } from '@shared/public-api';

/** Presentation/workflow behavior required by dependency installation. */
export interface DependencyApplicationPort {
  readonly currentProcessState: string;
  startInstall(): boolean;
  finishInstall(success: boolean, errorMessage?: string): void;
  updateNotice(options: NoticeOptions): void;
}

export const DEPENDENCY_APPLICATION_PORT = new InjectionToken<DependencyApplicationPort>(
  'DEPENDENCY_APPLICATION_PORT',
);
