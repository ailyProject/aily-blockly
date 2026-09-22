import { Injectable, Injector } from '@angular/core';
import { NoticeService, WorkflowService } from '@core/app-shell/public-api';
import { DependencyApplicationPort } from '@domain/dependencies/public-api';
import type { NoticeOptions } from '@shared/public-api';
import { RequiredSubappService, SubappAgentBridgeService } from '@integration/subapps/public-api';
import { AILY_CODER_EDITOR_SUBAPP_ID } from '../../configs/required-subapp.config';

@Injectable({ providedIn: 'root' })
export class DependencyApplicationAdapter implements DependencyApplicationPort {
  constructor(
    private readonly workflowService: WorkflowService,
    private readonly noticeService: NoticeService,
    private readonly injector: Injector,
  ) {}

  get currentProcessState(): string {
    return this.workflowService.currentState;
  }

  startInstall(): boolean {
    return this.workflowService.startInstall();
  }

  finishInstall(success: boolean, errorMessage?: string): void {
    this.workflowService.finishInstall(success, errorMessage);
  }

  updateNotice(options: NoticeOptions): void {
    this.noticeService.update(options);
  }

  async materializeCoderProjectLibraries(projectPath: string): Promise<void> {
    // Resolve lazily: the subapp automation graph also uses dependency services.
    await this.injector.get(RequiredSubappService).ensureInstalled(AILY_CODER_EDITOR_SUBAPP_ID);
    await this.injector.get(SubappAgentBridgeService).materializeCoderProjectLibraries(projectPath);
  }
}
