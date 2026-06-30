import { Component, OnInit, OnDestroy, inject, HostBinding } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { EditCheckpointService, EditsSummary, EditFileSummary } from '../../services/edit-checkpoint.service';
import type { ChatTaskActionDetail } from '../../helpers/chat-task-action-coordinator';
import { getInteractionDisplayContent } from '../../core/user-turn-action-target';
import { AiCoderDiffBridgeService } from '../../../../services/ai-coder-diff-bridge.service';
import type { AiEditDiffResultPayload } from '../../../../services/ai-coder-diff-channels';

@Component({
  selector: 'app-aily-edits-viewer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './aily-edits-viewer.component.html',
  styleUrl: './aily-edits-viewer.component.scss'
})
export class AilyEditsViewerComponent implements OnInit, OnDestroy {
  summary: EditsSummary | null = null;
  isExpanded = false;
  isAccepted = false;

  @HostBinding('class.chat-editing-session-host')
  readonly hostClass = true;

  @HostBinding('class.has-summary')
  get hasSummaryClass(): boolean {
    return !!this.summary;
  }

  private sub?: Subscription;
  private diffResultSub?: Subscription;
  private checkpointService = inject(EditCheckpointService);
  private diffBridge = inject(AiCoderDiffBridgeService);

  ngOnInit(): void {
    this.sub = this.checkpointService.summaryChanged$.subscribe(s => {
      this.summary = s;
      if (s) {
        this.isAccepted = false;
      }
    });
    this.diffResultSub = this.diffBridge.result$.subscribe(result => {
      this.handleDiffEditorResult(result);
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.diffResultSub?.unsubscribe();
  }

  get files(): EditFileSummary[] {
    return this.summary?.files || [];
  }

  get canUndo(): boolean {
    return this.checkpointService.canUndo;
  }

  get canRedo(): boolean {
    return this.checkpointService.canRedo;
  }

  get requestPreview(): string | null {
    const normalized = (getInteractionDisplayContent(this.summary?.turnContext) ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return null;
    }

    return normalized.length > 72
      ? `${normalized.slice(0, 72).trimEnd()}...`
      : normalized;
  }

  get keepActionTitle(): string {
    return this.requestPreview
      ? `保留与“${this.requestPreview}”关联的所有变更`
      : '保留所有变更';
  }

  get undoActionTitle(): string {
    return this.requestPreview
      ? `撤销与“${this.requestPreview}”关联的文件变更`
      : '撤销';
  }

  get redoActionTitle(): string {
    return this.requestPreview
      ? `重新应用与“${this.requestPreview}”关联的文件变更`
      : '重做';
  }

  get summaryTitle(): string {
    const fileCount = this.summary?.fileCount ?? 0;
    return `已更改 ${fileCount} 个文件`;
  }

  onOverviewClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button')) {
      return;
    }

    this.toggleExpanded();
  }

  toggleExpanded(): void {
    this.isExpanded = !this.isExpanded;
  }

  onKeep(): void {
    if (this.isAccepted) return;
    this.isAccepted = true;
    const detail: ChatTaskActionDetail = {
      action: 'keepEdits',
      target: this.summary?.turnContext,
      fileCount: this.summary?.fileCount || 0,
      totalAdded: this.summary?.totalAdded || 0,
      totalRemoved: this.summary?.totalRemoved || 0,
    };
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail,
    }));
    this.checkpointService.dismissSummary();
    this.diffBridge.dismissPreview(this.summary?.checkpointId);
  }

  onUndo(): void {
    const detail: ChatTaskActionDetail = { action: 'undoEdits' };
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail,
    }));
    this.diffBridge.dismissPreview(this.summary?.checkpointId);
  }

  onRedo(): void {
    const detail: ChatTaskActionDetail = { action: 'redoFileEdits' };
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail,
    }));
  }

  onAcceptFile(file: EditFileSummary): void {
    const detail: ChatTaskActionDetail = { action: 'acceptFile', filePath: file.fullPath };
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail,
    }));
    if (this.summary) {
      this.diffBridge.dismissPreview(this.summary.checkpointId, { filePath: file.fullPath });
    }
  }

  onRejectFile(file: EditFileSummary): void {
    const detail: ChatTaskActionDetail = { action: 'rejectFile', filePath: file.fullPath };
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail,
    }));
    if (this.summary) {
      this.diffBridge.dismissPreview(this.summary.checkpointId, { filePath: file.fullPath });
    }
  }

  onPreviewFile(file: EditFileSummary, event: MouseEvent): void {
    event.stopPropagation();
    if (!this.summary || file.contentKind !== 'text') {
      return;
    }
    this.diffBridge.openSingleFile(
      this.summary,
      file,
      (filePath) => this.checkpointService.getInitialContent(filePath),
    );
  }

  onOpenAllDiffs(event: MouseEvent): void {
    event.stopPropagation();
    if (!this.summary) {
      return;
    }
    this.openDiffPreview(this.summary);
  }

  private openDiffPreview(summary: EditsSummary): void {
    this.diffBridge.openFromSummary(
      summary,
      (filePath) => this.checkpointService.getInitialContent(filePath),
    );
  }

  private handleDiffEditorResult(result: AiEditDiffResultPayload): void {
    if (this.summary && result.previewId !== this.summary.checkpointId) {
      return;
    }

    switch (result.action) {
      case 'acceptFile':
        if (result.filePath) {
          if (this.summary) {
            this.onAcceptFile({ fullPath: result.filePath } as EditFileSummary);
          } else {
            this.diffBridge.dismissPreview(result.previewId, { filePath: result.filePath });
          }
        }
        break;
      case 'rejectFile':
        if (result.filePath) {
          if (this.summary) {
            this.onRejectFile({ fullPath: result.filePath } as EditFileSummary);
          } else {
            document.dispatchEvent(new CustomEvent('aily-task-action', {
              bubbles: true,
              detail: { action: 'rejectFile', filePath: result.filePath } satisfies ChatTaskActionDetail,
            }));
            this.diffBridge.dismissPreview(result.previewId, { filePath: result.filePath });
          }
        }
        break;
      case 'acceptAll':
        if (this.summary) {
          this.onKeep();
        } else {
          this.diffBridge.dismissPreview(result.previewId);
        }
        break;
      case 'rejectAll':
        if (this.summary) {
          this.onUndo();
        } else {
          document.dispatchEvent(new CustomEvent('aily-task-action', {
            bubbles: true,
            detail: { action: 'undoEdits' } satisfies ChatTaskActionDetail,
          }));
          this.diffBridge.dismissPreview(result.previewId);
        }
        break;
    }
  }

  trackByPath(index: number, file: EditFileSummary): string {
    return file.fullPath;
  }

  getFileKindBadge(file: EditFileSummary): string | null {
    if (file.contentKind === 'binary') {
      return '二进制';
    }
    if (file.contentKind === 'notebook') {
      return 'Notebook';
    }
    return null;
  }
}
