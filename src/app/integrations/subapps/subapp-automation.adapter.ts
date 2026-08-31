import { Injectable } from '@angular/core';
import { MainUiAutomationService } from '@integration/automation/public-api';
import { SubappAutomationPort } from '@integration/subapps/public-api';

@Injectable({ providedIn: 'root' })
export class SubappAutomationAdapter implements SubappAutomationPort {
  constructor(private readonly mainUiAutomation: MainUiAutomationService) {}

  isChildAppWindowOpen(toolId: string): Promise<boolean> {
    return this.mainUiAutomation.isChildAppWindowOpen(toolId);
  }

  openChildApp(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.mainUiAutomation.openChildApp(params);
  }

  waitForChildAppHostReady(toolId: string): Promise<Record<string, unknown>> {
    return this.mainUiAutomation.waitForChildAppHostReady(toolId);
  }
}
