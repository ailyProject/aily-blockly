import { InjectionToken } from '@angular/core';

/** Automation presentation behavior required by the subapp runtime bridge. */
export interface SubappAutomationPort {
  isChildAppWindowOpen(toolId: string): Promise<boolean>;
  openChildApp(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** In-process only: focus an existing View with its original trusted grant. */
  focusChildAppPresentation(toolId: string, presentationId: string): Promise<Record<string, unknown>>;
  waitForChildAppHostReady(toolId: string): Promise<Record<string, unknown>>;
}

export const SUBAPP_AUTOMATION_PORT = new InjectionToken<SubappAutomationPort>(
  'SUBAPP_AUTOMATION_PORT',
);
