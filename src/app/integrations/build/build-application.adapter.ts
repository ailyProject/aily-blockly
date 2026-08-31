import { Injectable } from '@angular/core';
import { NoticeService, WorkflowService } from '@core/app-shell/public-api';
import { BuildApplicationPort } from '@domain/build/public-api';
import type { NoticeOptions } from '@shared/public-api';

@Injectable({ providedIn: 'root' })
export class BuildApplicationAdapter implements BuildApplicationPort {
  constructor(
    private readonly workflowService: WorkflowService,
    private readonly noticeService: NoticeService,
  ) {}

  get currentProcessState(): string {
    return this.workflowService.currentState;
  }

  startBuild(): boolean {
    return this.workflowService.startBuild();
  }

  finishBuild(success: boolean, errorMessage?: string): void {
    this.workflowService.finishBuild(success, errorMessage);
  }

  updateNotice(options: NoticeOptions): void {
    this.noticeService.update(options);
  }
}
