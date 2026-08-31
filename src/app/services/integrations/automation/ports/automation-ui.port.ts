import { InjectionToken } from '@angular/core';

export interface AutomationWindowOptions {
  path: string;
  title?: string;
  data?: any;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  displayId?: string | number;
  relativeToDisplay?: boolean;
  clampToWorkArea?: boolean;
  applyInitialBounds?: boolean;
}

/** Host UI surface used by automation integrations. */
export interface AutomationUiPort {
  readonly openToolList: string[];
  readonly topTool: string | null;
  openToolEmbedded(toolId: string): boolean;
  openToolWindow(toolId: string, options?: Omit<AutomationWindowOptions, 'path'>): boolean;
  openWindow(options: AutomationWindowOptions): void;
}

export const AUTOMATION_UI_PORT = new InjectionToken<AutomationUiPort>(
  'AUTOMATION_UI_PORT',
);
