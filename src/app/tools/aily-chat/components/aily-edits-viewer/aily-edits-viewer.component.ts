import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { EditCheckpointService, EditsSummary, EditFileSummary } from '../../services/edit-checkpoint.service';

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

  private sub?: Subscription;
  private checkpointService = inject(EditCheckpointService);

  ngOnInit(): void {
    this.sub = this.checkpointService.summaryChanged$.subscribe(s => {
      this.summary = s;
      if (s) {
        this.isAccepted = false;
      }
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
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

  toggleExpanded(): void {
    this.isExpanded = !this.isExpanded;
  }

  onKeep(): void {
    if (this.isAccepted) return;
    this.isAccepted = true;
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail: {
        action: 'keepEdits',
        checkpointId: this.summary?.checkpointId,
        fileCount: this.summary?.fileCount || 0,
        totalAdded: this.summary?.totalAdded || 0,
        totalRemoved: this.summary?.totalRemoved || 0,
      }
    }));
    this.checkpointService.dismissSummary();
  }

  onUndo(): void {
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail: { action: 'undoEdits' }
    }));
  }

  onRedo(): void {
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail: { action: 'redoEdits' }
    }));
  }

  onAcceptFile(file: EditFileSummary): void {
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail: { action: 'acceptFile', filePath: file.fullPath }
    }));
  }

  onRejectFile(file: EditFileSummary): void {
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail: { action: 'rejectFile', filePath: file.fullPath }
    }));
  }

  trackByPath(index: number, file: EditFileSummary): string {
    return file.fullPath;
  }
}
