import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

import { SubWindowComponent } from '../../../../components/sub-window/sub-window.component';
import { ToolI18nService } from '../../../../services/tool-i18n.service';
import { ChatProcessDetailPanelComponent } from '../process-detail-panel/chat-process-detail-panel.component';
import { AilyHost } from '../../core/host';
import { readChatProcessOutputFile } from '../../helpers/chat-process-window';
import {
  getBlocklyCommandSessionStatus,
  listPersistedBlocklyCommandSessionSnapshots,
  listPersistedBlocklyProjectCommandSessionSnapshots,
} from '../../helpers/lex-agent-bootstrap';
import { ChatHistoryService } from '../../services/chat-history.service';

interface ProcessWindowInitData {
  readonly sessionId?: string;
  readonly processId?: string;
  readonly outputSessionId?: string;
  readonly outputFilePath?: string;
  readonly command?: string;
}

interface ProcessWindowProcessSummary {
  readonly processId: string;
  readonly outputSessionId?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly status?: string;
  readonly running?: boolean;
  readonly exitCode?: number;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly lastOutputAt?: number;
  readonly completedAt?: number;
  readonly elapsedMs?: number;
  readonly bytesTotal?: number;
  readonly outputFilePath?: string;
}

@Component({
  selector: 'app-chat-process-detail-window',
  standalone: true,
  imports: [CommonModule, TranslateModule, SubWindowComponent, ChatProcessDetailPanelComponent],
  templateUrl: './chat-process-detail-window.component.html',
  styleUrl: './chat-process-detail-window.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatProcessDetailWindowComponent implements OnInit, OnDestroy {
  sessionId = '';
  processId = '';
  outputSessionId = '';
  outputFilePath = '';
  command = '';
  summary: ProcessWindowProcessSummary | null = null;
  output = '';
  windowTitle = '';

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private initDataCleanup: (() => void) | null = null;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly cdr: ChangeDetectorRef,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly translate: TranslateService,
    private readonly toolI18n: ToolI18nService,
  ) {}

  ngOnInit(): void {
    void this.initializeTranslations();
    this.windowTitle = this.translate.instant('AILY_CHAT.PROCESS_WINDOW_TITLE') || 'Terminal Process Detail';
    this.route.paramMap.subscribe((params) => {
      this.sessionId = decodeURIComponent(params.get('sessionId') || '');
      this.processId = decodeURIComponent(params.get('processId') || '');
      this.outputSessionId = this.processId;
      this.refresh();
    });

    if (window['subWindow']?.onInitData) {
      this.initDataCleanup = window['subWindow'].onInitData((payload: { data?: ProcessWindowInitData } | ProcessWindowInitData) => {
        const data = payload && typeof payload === 'object' && 'data' in payload
          ? payload.data
          : payload as ProcessWindowInitData | undefined;
        this.applyInitData((data ?? undefined) as ProcessWindowInitData | undefined);
      });
    }

    this.startPolling();
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.initDataCleanup?.();
    this.initDataCleanup = null;
  }

  formatElapsedMs(value: number | undefined): string {
    const totalSeconds = Math.max(0, Math.floor((value ?? 0) / 1000));
    if (totalSeconds < 60) {
      return this.translate.instant('AILY_CHAT.PROCESS_DURATION_SECONDS', { count: totalSeconds });
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return this.translate.instant('AILY_CHAT.PROCESS_DURATION_MINUTES_SECONDS', { minutes, seconds });
  }

  openOutputFile(): void {
    if (!this.outputFilePath) {
      return;
    }
    AilyHost.get().shell?.openByExplorer?.(this.outputFilePath);
  }

  get displayStatus(): string {
    const summary = this.summary;
    if (!summary) {
      return '-';
    }
    const rawStatus = typeof summary.status === 'string' && summary.status.trim()
      ? summary.status.trim()
      : 'unknown';
    if (summary.running === true) {
      return this.translate.instant('AILY_CHAT.PROCESS_STATUS_RUNNING');
    }
    if (rawStatus === 'completed') {
      return this.translate.instant('AILY_CHAT.PROCESS_STATUS_COMPLETED');
    }
    if (rawStatus === 'failed') {
      return this.translate.instant('AILY_CHAT.PROCESS_STATUS_FAILED');
    }
    if (rawStatus === 'timeout') {
      return `${this.translate.instant('AILY_CHAT.PROCESS_STATUS_FAILED')} · ${this.translate.instant('AILY_CHAT.PROCESS_REASON_TIMEOUT')}`;
    }
    if (rawStatus === 'killed') {
      return `${this.translate.instant('AILY_CHAT.PROCESS_STATUS_KILLED')} · ${this.translate.instant('AILY_CHAT.PROCESS_REASON_KILLED')}`;
    }
    if (rawStatus === 'cancelled') {
      return `${this.translate.instant('AILY_CHAT.PROCESS_STATUS_CANCELLED')} · ${this.translate.instant('AILY_CHAT.PROCESS_REASON_CANCELLED')}`;
    }
    return this.translate.instant('AILY_CHAT.PROCESS_STATUS_FAILED');
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      this.refresh();
    }, 1000);
  }

  private async initializeTranslations(): Promise<void> {
    await this.toolI18n.load('aily-chat');
    this.windowTitle = this.summary
      ? `${this.translate.instant('AILY_CHAT.PROCESS_WINDOW_TITLE') || 'Terminal Process Detail'} · ${this.command || this.processId}`
      : this.translate.instant('AILY_CHAT.PROCESS_WINDOW_TITLE') || 'Terminal Process Detail';
    this.cdr.markForCheck();
  }

  private applyInitData(data: ProcessWindowInitData | null | undefined): void {
    if (!data) {
      return;
    }
    if (typeof data.sessionId === 'string' && data.sessionId.trim()) {
      this.sessionId = data.sessionId.trim();
    }
    if (typeof data.processId === 'string' && data.processId.trim()) {
      this.processId = data.processId.trim();
    }
    if (typeof data.outputSessionId === 'string' && data.outputSessionId.trim()) {
      this.outputSessionId = data.outputSessionId.trim();
    }
    if (typeof data.outputFilePath === 'string' && data.outputFilePath.trim()) {
      this.outputFilePath = data.outputFilePath.trim();
    }
    if (typeof data.command === 'string' && data.command.trim()) {
      this.command = data.command.trim();
    }
    this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.processId) {
      this.cdr.markForCheck();
      return;
    }

    const [summary, liveStatus] = await Promise.all([
      this.readSummaryFromHost(),
      getBlocklyCommandSessionStatus(this.processId).catch(() => null),
    ]);
    const mergedSummary = this.mergeSummaryWithLiveStatus(summary, liveStatus);
    if (mergedSummary) {
      this.summary = mergedSummary;
      this.outputSessionId = mergedSummary.outputSessionId || this.outputSessionId;
      this.outputFilePath = mergedSummary.outputFilePath || this.outputFilePath;
      this.command = mergedSummary.command || this.command;
      this.windowTitle = `${this.translate.instant('AILY_CHAT.PROCESS_WINDOW_TITLE') || 'Terminal Process Detail'} · ${this.command || this.processId}`;
    }

    this.output = this.readOutput();
    this.cdr.markForCheck();
  }

  private async readSummaryFromHost(): Promise<ProcessWindowProcessSummary | null> {
    const persistedFromOutputPath = this.readPersistedSummaryFromOutputFilePath();
    if (persistedFromOutputPath) {
      return persistedFromOutputPath;
    }

    try {
      const electronApi = window['electronAPI'] as { chatRuntimeHost?: { call?: (method: string, args: readonly unknown[]) => Promise<unknown> } } | undefined;
      const snapshot = this.sessionId
        ? await electronApi?.chatRuntimeHost?.call?.('readInteractionSnapshot', [this.sessionId]) as {
          processes?: readonly ProcessWindowProcessSummary[];
        } | null
        : null;
      const liveProcess = snapshot?.processes?.find(item => item.processId === this.processId) ?? null;
      const persistedProcess = this.readPersistedSummary();
      if (liveProcess && persistedProcess) {
        return {
          ...persistedProcess,
          ...liveProcess,
          outputFilePath: liveProcess.outputFilePath ?? persistedProcess.outputFilePath,
        };
      }
      return liveProcess ?? persistedProcess;
    } catch {
      return this.readPersistedSummary();
    }
  }

  private readPersistedSummaryFromOutputFilePath(): ProcessWindowProcessSummary | null {
    const normalizedOutputFilePath = typeof this.outputFilePath === 'string' ? this.outputFilePath.trim() : '';
    if (!normalizedOutputFilePath) {
      return null;
    }

    try {
      const host = AilyHost.get();
      const metadataFilePath = normalizedOutputFilePath.replace(/\.log$/i, '.json');
      if (!host.fs?.existsSync?.(metadataFilePath)) {
        return null;
      }

      const raw = host.fs.readFileSync(metadataFilePath, 'utf-8');
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(String(raw)) as {
        processId?: string;
        outputSessionId?: string | null;
        command?: string | null;
        cwd?: string | null;
        status?: string | null;
        running?: boolean;
        exitCode?: number | null;
        pid?: number | null;
        startedAt?: number | null;
        lastOutputAt?: number | null;
        completedAt?: number | null;
        bytesTotal?: number | null;
        outputFilePath?: string | null;
      };
      const processId = typeof parsed.processId === 'string' && parsed.processId.trim()
        ? parsed.processId.trim()
        : this.processId;
      const startedAt = typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt)
        ? parsed.startedAt
        : undefined;
      const lastOutputAt = typeof parsed.lastOutputAt === 'number' && Number.isFinite(parsed.lastOutputAt)
        ? parsed.lastOutputAt
        : undefined;
      const completedAt = typeof parsed.completedAt === 'number' && Number.isFinite(parsed.completedAt)
        ? parsed.completedAt
        : undefined;
      const elapsedMs = typeof startedAt === 'number'
        ? Math.max(0, (completedAt ?? lastOutputAt ?? Date.now()) - startedAt)
        : undefined;

      return {
        processId,
        outputSessionId: typeof parsed.outputSessionId === 'string' && parsed.outputSessionId.trim()
          ? parsed.outputSessionId.trim()
          : this.outputSessionId || processId,
        command: typeof parsed.command === 'string' && parsed.command.trim()
          ? parsed.command.trim()
          : this.command,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
        status: typeof parsed.status === 'string' ? parsed.status : undefined,
        running: parsed.running === true,
        exitCode: typeof parsed.exitCode === 'number' && Number.isFinite(parsed.exitCode) ? parsed.exitCode : undefined,
        pid: typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) ? parsed.pid : undefined,
        startedAt,
        lastOutputAt,
        completedAt,
        elapsedMs,
        bytesTotal: typeof parsed.bytesTotal === 'number' && Number.isFinite(parsed.bytesTotal) ? parsed.bytesTotal : undefined,
        outputFilePath: typeof parsed.outputFilePath === 'string' && parsed.outputFilePath.trim()
          ? parsed.outputFilePath.trim()
          : normalizedOutputFilePath,
      };
    } catch {
      return null;
    }
  }

  private readOutput(): string {
    return readChatProcessOutputFile(this.outputFilePath);
  }

  private mergeSummaryWithLiveStatus(
    summary: ProcessWindowProcessSummary | null,
    liveStatus: Awaited<ReturnType<typeof getBlocklyCommandSessionStatus>>,
  ): ProcessWindowProcessSummary | null {
    if (!summary && !liveStatus) {
      return null;
    }

    const startedAt = liveStatus?.startedAt ?? summary?.startedAt;
    const completedAt = liveStatus?.completedAt ?? summary?.completedAt;
    const elapsedMs = typeof startedAt === 'number' && Number.isFinite(startedAt)
      ? Math.max(0, (completedAt ?? Date.now()) - startedAt)
      : summary?.elapsedMs;

    return {
      ...(summary ?? { processId: this.processId }),
      ...(liveStatus ?? {}),
      processId: this.processId,
      outputSessionId: liveStatus?.outputSessionId ?? summary?.outputSessionId ?? this.outputSessionId,
      outputFilePath: liveStatus?.outputFilePath ?? summary?.outputFilePath ?? this.outputFilePath,
      command: liveStatus?.command ?? summary?.command ?? this.command,
      startedAt,
      completedAt,
      elapsedMs,
      exitCode: typeof liveStatus?.exitCode === 'number'
        ? liveStatus.exitCode
        : summary?.exitCode,
    };
  }

  private readPersistedSummary(): ProcessWindowProcessSummary | null {
    const projectPathHint = this.chatHistoryService.findEntry(this.sessionId)?.projectPath ?? null;
    const sessionScoped = listPersistedBlocklyCommandSessionSnapshots(this.sessionId, projectPathHint)
      .find(item => item.processId === this.processId) ?? null;
    if (sessionScoped) {
      return sessionScoped;
    }

    return listPersistedBlocklyProjectCommandSessionSnapshots(projectPathHint)
      .find(item => item.processId === this.processId) ?? null;
  }
}
