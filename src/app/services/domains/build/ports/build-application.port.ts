import { InjectionToken } from '@angular/core';
import type { NoticeOptions } from '@shared/public-api';

export interface BuildActionState {
  text: string;
  desc?: string;
  state?: 'done' | 'doing' | 'error' | 'warn' | 'loading' | string;
  color?: string;
  icon?: string;
  timeout?: number;
}

/** Presentation/workflow behavior required by the build domain. */
export interface BuildApplicationPort {
  readonly currentProcessState: string;
  startBuild(): boolean;
  finishBuild(success: boolean, errorMessage?: string): void;
  updateNotice(options: NoticeOptions): void;
}

export const BUILD_APPLICATION_PORT = new InjectionToken<BuildApplicationPort>(
  'BUILD_APPLICATION_PORT',
);
