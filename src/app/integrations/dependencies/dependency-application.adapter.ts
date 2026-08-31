import { Injectable } from '@angular/core';
import { NoticeService, WorkflowService } from '@core/app-shell/public-api';
import { DependencyApplicationPort } from '@domain/dependencies/public-api';
import type { NoticeOptions } from '@shared/public-api';

@Injectable({ providedIn: 'root' })
export class DependencyApplicationAdapter implements DependencyApplicationPort {
  constructor(
    private readonly workflowService: WorkflowService,
    private readonly noticeService: NoticeService,
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
}
