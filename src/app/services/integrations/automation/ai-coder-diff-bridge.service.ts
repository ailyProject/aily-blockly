import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import type { EditsSummary, EditFileSummary } from './coder-diff/ai-edit-summary.types';
import {
  AILY_CODER_EDITOR_AI_EDIT_DIFF_CHANNEL,
  AILY_CODER_EDITOR_AI_EDIT_DIFF_RESULT_CHANNEL,
  type AiEditDiffOpenPayload,
  type AiEditDiffResultPayload,
} from './coder-diff/ai-coder-diff-channels';
import { AiCoderDiffPreviewStoreService } from './ai-coder-diff-preview-store.service';
import { ProjectService } from '@domain/project/public-api';

@Injectable({ providedIn: 'root' })
export class AiCoderDiffBridgeService implements OnDestroy {
  readonly result$ = new Subject<AiEditDiffResultPayload>();

  private embedWindow: Window | null = null;
  private pendingOpen: AiEditDiffOpenPayload | null = null;
  private workspaceRoot: string | null = null;

  private readonly onEmbedMessage = (ev: MessageEvent) => this.handleEmbedMessage(ev);

  constructor(
    private readonly previewStore: AiCoderDiffPreviewStoreService,
    private readonly projectService: ProjectService,
  ) {
    window.addEventListener('message', this.onEmbedMessage);
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.onEmbedMessage);
  }

  setWorkspaceRoot(workspaceRoot: string | null): void {
    this.workspaceRoot = workspaceRoot;
  }

  registerEmbed(contentWindow: Window | null): void {
    this.embedWindow = contentWindow;
    if (contentWindow && this.pendingOpen) {
      this.postOpen(this.pendingOpen);
      this.pendingOpen = null;
      return;
    }
    if (contentWindow) {
      this.restorePendingPreview();
    }
  }

  openFromSummary(
    summary: EditsSummary,
    getBaselineContent: (filePath: string) => string | null | undefined,
    options?: { focusFilePath?: string; autoOpen?: boolean },
  ): void {
    const textFiles = summary.files.filter((file) => file.contentKind === 'text');
    if (textFiles.length === 0) {
      return;
    }

    const payload: AiEditDiffOpenPayload = {
      previewId: summary.checkpointId,
      title: this.buildPreviewTitle(summary),
      files: textFiles.map((file) => this.toDiffFilePayload(file, getBaselineContent)),
      focusFilePath: options?.focusFilePath,
    };

    if (options?.autoOpen === false) {
      this.pendingOpen = payload;
      this.persistPreview(payload);
      return;
    }

    this.openPreview(payload);
  }

  openSingleFile(
    summary: EditsSummary,
    file: EditFileSummary,
    getBaselineContent: (filePath: string) => string | null | undefined,
  ): void {
    if (file.contentKind !== 'text') {
      return;
    }

    this.openPreview({
      previewId: summary.checkpointId,
      title: `${file.path} (AI 编辑)`,
      files: [this.toDiffFilePayload(file, getBaselineContent)],
      focusFilePath: file.fullPath,
    });
  }

  /** 用户确认/拒绝后清除缓存并关闭 diff 视图 */
  dismissPreview(previewId?: string, options?: { filePath?: string }): void {
    const root = this.resolveWorkspaceRoot();
    if (root) {
      if (options?.filePath) {
        const remaining = this.previewStore.removeFile(root, options.filePath);
        if (!remaining) {
          this.closePreview(previewId);
          this.pendingOpen = null;
          return;
        }
        const payload = this.previewStore.toOpenPayload(remaining);
        if (payload) {
          this.openPreview(payload);
        } else {
          this.closePreview(previewId);
          this.pendingOpen = null;
        }
        return;
      }
      this.previewStore.clear(root);
    }
    this.closePreview(previewId);
    this.pendingOpen = null;
  }

  closePreview(previewId?: string): void {
    const win = this.embedWindow;
    if (!win) {
      return;
    }
    try {
      win.postMessage(
        {
          channel: AILY_CODER_EDITOR_AI_EDIT_DIFF_CHANNEL,
          op: 'close',
          payload: previewId ? { previewId } : undefined,
        },
        '*',
      );
    } catch {
      /* ignore */
    }
  }

  restorePendingPreview(): void {
    const root = this.resolveWorkspaceRoot();
    if (!root) {
      return;
    }
    this.workspaceRoot = root;

    const record = this.previewStore.load(root);
    if (!record) {
      return;
    }

    const payload = this.previewStore.toOpenPayload(record);
    if (!payload) {
      return;
    }

    this.openPreview(payload);
  }

  private resolveWorkspaceRoot(): string | null {
    if (this.workspaceRoot) {
      return this.workspaceRoot;
    }
    return this.projectService.currentProjectPath
      || this.projectService.projectRootPath
      || null;
  }

  private openPreview(payload: AiEditDiffOpenPayload): void {
    const root = this.resolveWorkspaceRoot();
    if (root) {
      this.workspaceRoot = root;
    }
    if (!payload.files.length) {
      return;
    }
    this.persistPreview(payload);
    if (this.embedWindow) {
      this.postOpen(payload);
      return;
    }
    this.pendingOpen = payload;
  }

  private persistPreview(payload: AiEditDiffOpenPayload): void {
    if (this.workspaceRoot) {
      this.previewStore.save(this.workspaceRoot, payload);
    }
  }

  private postOpen(payload: AiEditDiffOpenPayload): void {
    const win = this.embedWindow;
    if (!win) {
      this.pendingOpen = payload;
      return;
    }
    try {
      win.postMessage(
        {
          channel: AILY_CODER_EDITOR_AI_EDIT_DIFF_CHANNEL,
          op: 'open',
          payload,
        },
        '*',
      );
      this.pendingOpen = null;
    } catch {
      this.pendingOpen = payload;
    }
  }

  private toDiffFilePayload(
    file: EditFileSummary,
    getBaselineContent: (filePath: string) => string | null | undefined,
  ) {
    const baselineContent = getBaselineContent(file.fullPath);
    return {
      filePath: file.fullPath,
      baselineContent: baselineContent ?? '',
      currentContent: this.readCurrentFileContent(file.fullPath),
      type: file.type,
    };
  }

  private readCurrentFileContent(filePath: string): string {
    try {
      const fs = window['fs'];
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
      }
    } catch {
      /* ignore */
    }
    return '';
  }

  private buildPreviewTitle(summary: EditsSummary): string {
    return summary.fileCount === 1
      ? `AI 编辑：${summary.files[0]?.path ?? '1 个文件'}`
      : `AI 编辑预览（${summary.fileCount} 个文件）`;
  }

  private handleEmbedMessage(ev: MessageEvent): void {
    const data = ev.data as Partial<AiEditDiffResultPayload> | undefined;
    if (data?.channel !== AILY_CODER_EDITOR_AI_EDIT_DIFF_RESULT_CHANNEL) {
      return;
    }
    const source = ev.source as Window | null;
    if (this.embedWindow && source && source !== this.embedWindow) {
      return;
    }
    if (!data.previewId || !data.action) {
      return;
    }
    this.result$.next(data as AiEditDiffResultPayload);
  }
}
