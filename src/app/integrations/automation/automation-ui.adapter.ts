import { Injectable } from '@angular/core';
import { UiService } from '@core/app-shell/public-api';
import {
  AutomationUiPort,
  AutomationWindowOptions,
} from '@integration/automation/public-api';

@Injectable({ providedIn: 'root' })
export class AutomationUiAdapter implements AutomationUiPort {
  constructor(private readonly uiService: UiService) {}

  get openToolList(): string[] {
    return this.uiService.openToolList;
  }

  get topTool(): string | null {
    return this.uiService.topTool;
  }

  openToolEmbedded(toolId: string): boolean {
    return this.uiService.openToolEmbedded(toolId);
  }

  openToolWindow(toolId: string, options?: Omit<AutomationWindowOptions, 'path'>): boolean {
    return this.uiService.openToolWindow(toolId, options);
  }

  openWindow(options: AutomationWindowOptions): void {
    this.uiService.openWindow(options);
  }
}
