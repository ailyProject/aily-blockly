import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';

export interface BuildActionFeedback<T = any> {
  actionId: string;
  success: boolean;
  data: T;
  error?: string;
  timestamp: number;
}

export interface BuildActionPort {
  hasListener(listenerId: string): boolean;
  dispatch<T = any>(
    type: string,
    payload?: T,
    feedbackCallback?: (feedback: BuildActionFeedback<T>) => void,
    timeoutMs?: number,
  ): void;
  dispatchWithFeedback<T = any>(
    type: string,
    payload?: T,
    timeoutMs?: number,
  ): Observable<BuildActionFeedback<T>>;
}

export const BUILD_ACTION_PORT = new InjectionToken<BuildActionPort>('BUILD_ACTION_PORT');
