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

  openToolEmbedded(toolId: string, presentationId?: string): boolean {
    return presentationId ? this.uiService.openToolEmbedded(toolId, presentationId) : this.uiService.openToolEmbedded(toolId);
  }

  openToolWindow(toolId: string, options?: Omit<AutomationWindowOptions, 'path'>): boolean {
    return this.uiService.openToolWindow(toolId, options);
  }

  completeToolPresentationClose(toolId: string, presentationId: string): void {
    this.uiService.completeToolPresentationClose(toolId, presentationId);
  }

  openWindow(options: AutomationWindowOptions): void {
    this.uiService.openWindow(options);
  }
}
