import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { NzPopconfirmModule } from 'ng-zorro-antd/popconfirm';

import { BaseDialogComponent } from '../../../../components/base-dialog/base-dialog.component';
import { ChatProcessDetailPanelComponent } from '../process-detail-panel/chat-process-detail-panel.component';
import { AilyHost } from '../../core/host';
import type { ChatRuntimeHostSessionProcessSummary } from '../../core/chat-runtime-host-contract';
import {
  deleteBlocklyCommandSession,
  getBlocklyCommandSessionStatus,
  listPersistedBlocklyCommandSessionSnapshots,
  listPersistedBlocklyProjectCommandSessionSnapshots,
  purgeBlocklyCommandSession,
  subscribeBlocklyCommandSessionUpdates,
} from '../../helpers/lex-agent-bootstrap';
import { openChatProcessWindow, readChatProcessOutputFile } from '../../helpers/chat-process-window';
import { ChatHistoryService } from '../../services/chat-history.service';
import { ChatRuntimeInteractionHostService } from '../../services/chat-runtime-interaction-host.service';
import { resolveTerminalLifecycleState } from '../../core/terminal-status';
import {
  DEFAULT_PROCESS_LOG_SUBAPP,
  normalizeProcessLogSubappName,
  resolveProcessLogSubappNameFromOutputFilePath,
} from '../../../../utils/project-log.utils';
import { getChildToolConfig } from '../../../../configs/tool.config';
import { UiService } from '../../../../services/ui.service';
import {
  buildChildToolProcessSummaries,
  collapseActiveChildToolServeProcesses,
  isChildToolProcessSummary,
  resolveChildToolIdFromProcess,
  resolveChildToolProcessDisplayName,
  type ChildToolSessionListItem,
} from '../../helpers/child-tool-process-summary';

type ProcessFilter = 'all' | 'running' | 'background' | 'completed' | 'failed' | 'removed';

interface ChatProcessManagerDialogData {
  readonly sessionId?: string;
  readonly projectPath?: string;
}

@Component({
  selector: 'app-chat-process-manager-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NzPopconfirmModule, BaseDialogComponent, ChatProcessDetailPanelComponent],
  templateUrl: './chat-process-manager-dialog.component.html',
  styleUrl: './chat-process-manager-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatProcessManagerDialogComponent {
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly modalRef = inject(NzModalRef);
  private readonly data = inject<ChatProcessManagerDialogData>(NZ_MODAL_DATA);
  private readonly runtimeInteractionHost = inject(ChatRuntimeInteractionHostService);
  private readonly chatHistoryService = inject(ChatHistoryService);
  private readonly translate = inject(TranslateService);
  private readonly uiService = inject(UiService);

  readonly sessionId = typeof this.data.sessionId === 'string' ? this.data.sessionId.trim() : '';
  readonly projectPath = typeof this.data.projectPath === 'string' ? this.data.projectPath.trim() : '';

  selectedFilter: ProcessFilter = 'all';
  selectedProcessId = '';
  showAdvancedFilters = false;
  subappKeyword = '';
  startDate = '';
  endDate = '';
  startTime = '';
  endTime = '';

  processes: readonly ChatRuntimeHostSessionProcessSummary[] = [];
  selectedProcessDetail: ChatRuntimeHostSessionProcessSummary | null = null;
  selectedProcessOutput = '';
  selectedProcessStatusLabel = '';
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.refreshProcesses();
    const subscription = subscribeBlocklyCommandSessionUpdates((sessionId) => {
      if (!this.sessionId || sessionId === this.sessionId) {
        this.refreshProcesses();
      }
    });
    this.startPolling();
    this.destroyRef.onDestroy(() => {
      subscription.dispose();
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }
    });
  }

  closeDialog(): void {
    this.modalRef.close(true);
  }

  updateFilter(value: string): void {
    const nextFilter = this.normalizeFilter(value);
    if (this.selectedFilter === nextFilter) {
      return;
    }
    this.selectedFilter = nextFilter;
    if (!this.filteredProcesses.some(process => process.processId === this.selectedProcessId)) {
      this.selectedProcessId = this.filteredProcesses[0]?.processId ?? '';
    }
    void this.refreshSelectedProcessDetail();
  }

  updateSubappKeyword(value: string): void {
    this.subappKeyword = value;
    this.syncSelectedProcessAfterFilterChange();
  }

  updateStartDate(value: string): void {
    this.startDate = value;
    this.syncSelectedProcessAfterFilterChange();
  }

  updateEndDate(value: string): void {
    this.endDate = value;
    this.syncSelectedProcessAfterFilterChange();
  }

  updateStartTime(value: string): void {
    this.startTime = value;
    this.syncSelectedProcessAfterFilterChange();
  }

  updateEndTime(value: string): void {
    this.endTime = value;
    this.syncSelectedProcessAfterFilterChange();
  }

  toggleAdvancedFilters(): void {
    this.showAdvancedFilters = !this.showAdvancedFilters;
    this.cdr.markForCheck();
  }

  resetAdvancedFilters(): void {
    this.subappKeyword = '';
    this.startDate = '';
    this.endDate = '';
    this.startTime = '';
    this.endTime = '';
    this.syncSelectedProcessAfterFilterChange();
  }

  selectProcess(processId: string): void {
    if (!processId || this.selectedProcessId === processId) {
      return;
    }
    this.selectedProcessId = processId;
    void this.refreshSelectedProcessDetail();
  }

  openProcessWindow(process: ChatRuntimeHostSessionProcessSummary): void {
    const toolId = resolveChildToolIdFromProcess(process);
    if (toolId) {
      const config = getChildToolConfig(toolId);
      this.uiService.openToolWindow(toolId, {
        title: this.resolveChildToolDisplayName(toolId, config),
      });
      return;
    }
    openChatProcessWindow({
      sessionId: process.sessionId,
      processId: process.processId,
      outputSessionId: process.outputSessionId,
      outputFilePath: process.outputFilePath,
      command: process.command,
    });
  }

  async stopProcess(process: ChatRuntimeHostSessionProcessSummary): Promise<void> {
    if (!process.running) {
      return;
    }
    if (isChildToolProcessSummary(process)) {
      const toolId = resolveChildToolIdFromProcess(process);
      if (toolId) {
        await window['childToolSession']?.stop?.(toolId);
      }
      this.refreshProcesses();
      return;
    }
    await this.runtimeInteractionHost.requestCommandSessionAction(process.sessionId || this.sessionId, {
      actionId: 'stop',
      processId: process.processId,
      outputSessionId: process.outputSessionId,
      outputFilePath: process.outputFilePath,
    });
    this.refreshProcesses();
  }

  deleteProcess(process: ChatRuntimeHostSessionProcessSummary): void {
    deleteBlocklyCommandSession(process.processId, process.sessionId || this.sessionId);
    if (this.selectedProcessId === process.processId) {
      this.selectedProcessId = '';
    }
    this.refreshProcesses();
  }

  hardDeleteProcess(process: ChatRuntimeHostSessionProcessSummary): void {
    purgeBlocklyCommandSession(process.processId, process.sessionId || this.sessionId);
    if (this.selectedProcessId === process.processId) {
      this.selectedProcessId = '';
    }
    this.refreshProcesses();
  }

  trackByProcessId(_: number, process: ChatRuntimeHostSessionProcessSummary): string {
    return process.processId;
  }

  get filteredProcesses(): readonly ChatRuntimeHostSessionProcessSummary[] {
    const processes = this.filterByStatus(this.processes);
    return processes.filter(process => this.matchesAdvancedFilters(process));
  }

  get hasAdvancedFilters(): boolean {
    return !!(
      this.subappKeyword.trim()
      || this.startDate
      || this.endDate
      || this.startTime
      || this.endTime
    );
  }

  get selectedProcess(): ChatRuntimeHostSessionProcessSummary | null {
    const selected = this.filteredProcesses.find(process => process.processId === this.selectedProcessId);
    return selected ?? this.filteredProcesses[0] ?? null;
  }

  resolveSubappName(process: ChatRuntimeHostSessionProcessSummary): string {
    const childToolId = resolveChildToolIdFromProcess(process);
    if (childToolId) {
      return childToolId;
    }
    return normalizeProcessLogSubappName(
      process.subappName || resolveProcessLogSubappNameFromOutputFilePath(process.outputFilePath) || DEFAULT_PROCESS_LOG_SUBAPP,
    );
  }

  resolveProcessPrimaryLabel(process: ChatRuntimeHostSessionProcessSummary): string {
    const toolId = resolveChildToolIdFromProcess(process);
    if (toolId) {
      return this.resolveChildToolDisplayName(toolId);
    }

    const displayName = resolveChildToolProcessDisplayName(process);
    return displayName || process.command;
  }

  resolveOpenActionLabel(process: ChatRuntimeHostSessionProcessSummary): string {
    return resolveChildToolIdFromProcess(process)
      ? 'AILY_CHAT.PROCESS_ACTION_CONTROL_PANEL'
      : 'AILY_CHAT.PROCESS_ACTION_OPEN_WINDOW';
  }

  formatStartedAt(process: ChatRuntimeHostSessionProcessSummary): string {
    if (typeof process.startedAt !== 'number' || !Number.isFinite(process.startedAt)) {
      return '-';
    }
    const elapsedMinutes = Math.max(1, Math.floor((Date.now() - process.startedAt) / 60_000));
    if (elapsedMinutes < 60) {
      return this.translate.instant('AILY_CHAT.PROCESS_RELATIVE_MINUTES', { count: elapsedMinutes });
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
      return this.translate.instant('AILY_CHAT.PROCESS_RELATIVE_HOURS', { count: elapsedHours });
    }

    const elapsedDays = Math.floor(elapsedHours / 24);
    return this.translate.instant('AILY_CHAT.PROCESS_RELATIVE_DAYS', { count: elapsedDays });
  }

  private filterByStatus(processes: readonly ChatRuntimeHostSessionProcessSummary[]): readonly ChatRuntimeHostSessionProcessSummary[] {
    switch (this.selectedFilter) {
      case 'running':
        return processes.filter(process => process.removed !== true && process.running);
      case 'background':
        return processes.filter(process => process.removed !== true && process.running && process.background === true);
      case 'completed':
        return processes.filter(process => process.removed !== true && !process.running && process.status === 'completed');
      case 'failed':
        return processes.filter(process =>
          process.removed !== true && !process.running && process.status !== 'completed',
        );
      case 'removed':
        return processes.filter(process => process.removed === true);
      case 'all':
      default:
        return processes.filter(process => process.removed !== true);
    }
  }

  formatElapsed(process: ChatRuntimeHostSessionProcessSummary): string {
    const totalSeconds = Math.max(0, Math.floor(process.elapsedMs / 1000));
    if (totalSeconds < 60) {
      return this.translate.instant('AILY_CHAT.PROCESS_DURATION_SECONDS', { count: totalSeconds });
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return this.translate.instant('AILY_CHAT.PROCESS_DURATION_MINUTES_SECONDS', { minutes, seconds });
  }

  summarizeStatus(process: ChatRuntimeHostSessionProcessSummary): string {
    const rawStatus = typeof process.status === 'string' && process.status.trim()
      ? process.status.trim()
      : 'unknown';
    if (process.running) {
      return this.translate.instant(
        process.background
          ? 'AILY_CHAT.PROCESS_STATUS_BACKGROUND'
          : 'AILY_CHAT.PROCESS_STATUS_RUNNING',
      );
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

  resolveStatusTone(process: ChatRuntimeHostSessionProcessSummary): 'info' | 'success' | 'error' | 'neutral' {
    const terminalState = resolveTerminalLifecycleState(process);
    if (terminalState === 'running') {
      return process.background ? 'neutral' : 'info';
    }
    if (terminalState === 'failed') {
      return 'error';
    }
    if (terminalState === 'completed') {
      return 'success';
    }
    return 'neutral';
  }

  private async refreshProcesses(): Promise<void> {
    const snapshot = this.sessionId
      ? this.runtimeInteractionHost.readSnapshot(this.sessionId)
      : null;
    const liveProcesses = Array.isArray(snapshot?.processes) ? snapshot.processes : [];
    const childToolProcesses = await this.readChildToolProcesses();
    const projectPathHint = this.projectPath || this.chatHistoryService.findEntry(this.sessionId)?.projectPath || null;
    const persistedProcesses = this.sessionId
      ? listPersistedBlocklyCommandSessionSnapshots(this.sessionId, projectPathHint)
      : listPersistedBlocklyProjectCommandSessionSnapshots(projectPathHint);
    const nextProcesses = this.mergeProcessSummaries(
      [...liveProcesses, ...childToolProcesses],
      persistedProcesses,
    );
    this.processes = nextProcesses;
    const nextFilteredProcesses = this.filteredProcesses;
    if (!this.selectedProcessId || !nextFilteredProcesses.some(process => process.processId === this.selectedProcessId)) {
      this.selectedProcessId = nextFilteredProcesses[0]?.processId ?? '';
    }
    this.cdr.markForCheck();
    void this.refreshSelectedProcessDetail();
  }

  private async refreshSelectedProcessDetail(): Promise<void> {
    const process = this.selectedProcess;
    if (!process) {
      this.selectedProcessDetail = null;
      this.selectedProcessOutput = '';
      this.selectedProcessStatusLabel = '';
      this.cdr.markForCheck();
      return;
    }

    if (isChildToolProcessSummary(process)) {
      this.selectedProcessDetail = process;
      this.selectedProcessOutput = await this.readChildToolProcessOutput(process);
      this.selectedProcessStatusLabel = this.summarizeStatus(process);
      this.cdr.markForCheck();
      return;
    }

    const snapshot = await getBlocklyCommandSessionStatus(process.processId);
    const persistedFromOutputPath = this.readPersistedSummaryFromOutputFilePath(
      process.outputFilePath,
      process.processId,
      snapshot,
    );
    const detailProcess = this.mergeDetailProcess(process, persistedFromOutputPath, snapshot);
    this.selectedProcessDetail = detailProcess;
    this.selectedProcessOutput = readChatProcessOutputFile(detailProcess.outputFilePath || process.outputFilePath)
      || snapshot?.stdout
      || '';
    this.selectedProcessStatusLabel = this.summarizeStatus(detailProcess);
    this.cdr.markForCheck();
  }

  private startPolling(): void {
    this.refreshTimer = setInterval(() => {
      this.refreshProcesses();
    }, 1000);
  }

  private mergeProcessSummaries(
    liveProcesses: readonly ChatRuntimeHostSessionProcessSummary[],
    persistedProcesses: readonly ChatRuntimeHostSessionProcessSummary[],
  ): readonly ChatRuntimeHostSessionProcessSummary[] {
    const merged = new Map<string, ChatRuntimeHostSessionProcessSummary>();
    for (const process of persistedProcesses) {
      merged.set(process.processId, this.decorateProcessSummary(process));
    }
    for (const process of liveProcesses) {
      const existing = merged.get(process.processId);
      merged.set(process.processId, existing
        ? this.decorateProcessSummary({
            ...existing,
            ...process,
            outputFilePath: process.outputFilePath ?? existing.outputFilePath,
          })
        : this.decorateProcessSummary(process));
    }
    return collapseActiveChildToolServeProcesses(
      [...merged.values()].sort((left, right) => right.startedAt - left.startedAt),
    );
  }

  private decorateProcessSummary(process: ChatRuntimeHostSessionProcessSummary): ChatRuntimeHostSessionProcessSummary {
    const subappName = this.resolveSubappName(process);
    return process.subappName === subappName
      ? process
      : {
          ...process,
          subappName,
        };
  }

  private matchesAdvancedFilters(process: ChatRuntimeHostSessionProcessSummary): boolean {
    const subappKeyword = this.subappKeyword.trim().toLowerCase();
    if (subappKeyword && !this.resolveSubappName(process).toLowerCase().includes(subappKeyword)) {
      return false;
    }

    if (!this.matchesDateRange(process.startedAt)) {
      return false;
    }

    return this.matchesTimeRange(process.startedAt);
  }

  private matchesDateRange(timestamp: number): boolean {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return false;
    }
    const currentDate = this.formatDateKey(timestamp);
    if (this.startDate && currentDate < this.startDate) {
      return false;
    }
    if (this.endDate && currentDate > this.endDate) {
      return false;
    }
    return true;
  }

  private matchesTimeRange(timestamp: number): boolean {
    const startMinutes = this.parseTimeToMinutes(this.startTime);
    const endMinutes = this.parseTimeToMinutes(this.endTime);
    if (startMinutes === null && endMinutes === null) {
      return true;
    }
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return false;
    }

    const current = new Date(timestamp);
    const minutes = current.getHours() * 60 + current.getMinutes();

    if (startMinutes !== null && endMinutes !== null) {
      return startMinutes <= endMinutes
        ? minutes >= startMinutes && minutes <= endMinutes
        : minutes >= startMinutes || minutes <= endMinutes;
    }
    if (startMinutes !== null) {
      return minutes >= startMinutes;
    }
    return endMinutes === null ? true : minutes <= endMinutes;
  }

  private parseTimeToMinutes(value: string): number | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return null;
    }
    const match = normalized.match(/^(\d{2}):(\d{2})$/);
    if (!match) {
      return null;
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return null;
    }
    return hours * 60 + minutes;
  }

  private formatDateKey(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private syncSelectedProcessAfterFilterChange(): void {
    if (!this.filteredProcesses.some(process => process.processId === this.selectedProcessId)) {
      this.selectedProcessId = this.filteredProcesses[0]?.processId ?? '';
    }
    this.cdr.markForCheck();
    void this.refreshSelectedProcessDetail();
  }

  private normalizeFilter(value: string): ProcessFilter {
    switch (value) {
      case 'running':
      case 'background':
      case 'completed':
      case 'failed':
      case 'removed':
        return value;
      default:
        return 'all';
    }
  }

  private mergeDetailProcess(
    base: ChatRuntimeHostSessionProcessSummary,
    persistedFromOutputPath: ChatRuntimeHostSessionProcessSummary | null,
    snapshot: Awaited<ReturnType<typeof getBlocklyCommandSessionStatus>>,
  ): ChatRuntimeHostSessionProcessSummary {
    const mergedBase = {
      ...base,
      ...(persistedFromOutputPath ?? {}),
    };
    const merged: ChatRuntimeHostSessionProcessSummary = {
      processId: mergedBase.processId,
      sessionId: mergedBase.sessionId,
      outputSessionId: mergedBase.outputSessionId,
      command: mergedBase.command,
      cwd: mergedBase.cwd,
      status: mergedBase.status,
      running: mergedBase.running,
      startedAt: mergedBase.startedAt,
      elapsedMs: mergedBase.elapsedMs,
      bytesTotal: mergedBase.bytesTotal,
      ...(mergedBase.exitCode !== undefined ? { exitCode: mergedBase.exitCode } : {}),
      ...(mergedBase.pid !== undefined ? { pid: mergedBase.pid } : {}),
      ...(mergedBase.lastOutputAt !== undefined ? { lastOutputAt: mergedBase.lastOutputAt } : {}),
      ...(mergedBase.completedAt !== undefined ? { completedAt: mergedBase.completedAt } : {}),
      ...(mergedBase.background !== undefined ? { background: mergedBase.background } : {}),
      ...(mergedBase.subappName ? { subappName: mergedBase.subappName } : {}),
      ...(mergedBase.outputFilePath ? { outputFilePath: mergedBase.outputFilePath } : {}),
      ...(mergedBase.removed !== undefined ? { removed: mergedBase.removed } : {}),
      ...(mergedBase.removedAt !== undefined ? { removedAt: mergedBase.removedAt } : {}),
    };
    if (!snapshot) {
      return merged;
    }

    const startedAt = snapshot.startedAt ?? merged.startedAt;
    const completedAt = snapshot.completedAt ?? merged.completedAt;
    return {
      ...merged,
      ...(snapshot.status ? { status: snapshot.status } : {}),
      running: snapshot.running === true,
      ...(typeof snapshot.exitCode === 'number' ? { exitCode: snapshot.exitCode } : {}),
      ...(typeof snapshot.pid === 'number' ? { pid: snapshot.pid } : {}),
      ...(typeof startedAt === 'number' ? { startedAt } : {}),
      ...(typeof snapshot.lastOutputAt === 'number' ? { lastOutputAt: snapshot.lastOutputAt } : {}),
      ...(typeof completedAt === 'number' ? { completedAt } : {}),
      ...(typeof snapshot.bytesTotal === 'number' ? { bytesTotal: snapshot.bytesTotal } : {}),
      ...(typeof startedAt === 'number'
        ? { elapsedMs: Math.max(0, (completedAt ?? Date.now()) - startedAt) }
        : {}),
      ...(snapshot.outputFilePath ? { outputFilePath: snapshot.outputFilePath } : {}),
      ...(snapshot.outputSessionId ? { outputSessionId: snapshot.outputSessionId } : {}),
      ...(snapshot.command ? { command: snapshot.command } : {}),
      ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
    };
  }

  private async readChildToolProcesses(): Promise<readonly ChatRuntimeHostSessionProcessSummary[]> {
    try {
      const sessions = await window['childToolSession']?.list?.();
      return buildChildToolProcessSummaries(
        Array.isArray(sessions) ? sessions as ChildToolSessionListItem[] : [],
        {
          sessionId: this.sessionId,
          projectPath: this.projectPath || this.chatHistoryService.findEntry(this.sessionId)?.projectPath || '',
        },
      );
    } catch (error) {
      console.warn('[ChatProcessManager] Failed to read child tool sessions:', error);
      return [];
    }
  }

  private async readChildToolProcessOutput(process: ChatRuntimeHostSessionProcessSummary): Promise<string> {
    const toolId = resolveChildToolIdFromProcess(process);
    if (!toolId) {
      return '';
    }

    try {
      const sessions = await window['childToolSession']?.list?.();
      const session = Array.isArray(sessions)
        ? (sessions as ChildToolSessionListItem[]).find(candidate => candidate.toolId === toolId)
        : null;
      if (!session) {
        return '';
      }

      const lines: string[] = [
        `status: ${process.running ? 'running' : process.status || 'completed'}`,
        `toolId: ${toolId}`,
      ];

      if (session.streamId) {
        lines.push(`processId: ${session.streamId}`);
      }
      if (typeof session.pid === 'number') {
        lines.push(`pid: ${session.pid}`);
      }
      if (session.cwd) {
        lines.push(`cwd: ${session.cwd}`);
      }
      if (session.command) {
        lines.push(`command: ${session.command}`);
      }

      lines.push('');
      lines.push('stdout:');
      lines.push(JSON.stringify({
        event: 'ready',
        data: this.sanitizeChildToolHostInfo(session.hostInfo),
      }, null, 2));

      return lines.join('\n');
    } catch (error) {
      console.warn('[ChatProcessManager] Failed to read child tool output preview:', error);
      return '';
    }
  }

  private resolveChildToolDisplayName(toolId: string, config = getChildToolConfig(toolId)): string {
    if (!config) {
      return toolId;
    }

    const globalName = this.translate.instant(config.namespace);
    if (typeof globalName === 'string' && globalName && globalName !== config.namespace) {
      return globalName;
    }

    const title = this.translate.instant(config.titleKey);
    if (typeof title === 'string' && title && title !== config.titleKey) {
      return title;
    }

    return toolId;
  }

  private sanitizeChildToolHostInfo(hostInfo: unknown): unknown {
    if (!hostInfo || typeof hostInfo !== 'object') {
      return hostInfo;
    }

    const normalized = { ...(hostInfo as Record<string, unknown>) };
    for (const key of ['url', 'wsUrl', 'shutdownUrl'] as const) {
      const value = normalized[key];
      normalized[key] = typeof value === 'string' ? this.sanitizeUrl(value) : value;
    }
    return normalized;
  }

  private sanitizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has('token')) {
        parsed.searchParams.set('token', '<redacted>');
      }
      return parsed.toString();
    } catch {
      return url.replace(/([?&]token=)[^&]+/g, '$1<redacted>');
    }
  }

  private readPersistedSummaryFromOutputFilePath(
    outputFilePath: string | undefined,
    processId: string,
    snapshot: Awaited<ReturnType<typeof getBlocklyCommandSessionStatus>>,
  ): ChatRuntimeHostSessionProcessSummary | null {
    const normalizedOutputFilePath = typeof outputFilePath === 'string' ? outputFilePath.trim() : '';
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
        sessionId?: string | null;
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
        background?: boolean;
        removed?: boolean;
        removedAt?: number | null;
      };
      const resolvedProcessId = typeof parsed.processId === 'string' && parsed.processId.trim()
        ? parsed.processId.trim()
        : processId;
      const startedAt = typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt)
        ? parsed.startedAt
        : 0;
      const lastOutputAt = typeof parsed.lastOutputAt === 'number' && Number.isFinite(parsed.lastOutputAt)
        ? parsed.lastOutputAt
        : undefined;
      const completedAt = typeof parsed.completedAt === 'number' && Number.isFinite(parsed.completedAt)
        ? parsed.completedAt
        : undefined;
      const bytesTotal = typeof parsed.bytesTotal === 'number' && Number.isFinite(parsed.bytesTotal)
        ? parsed.bytesTotal
        : 0;
      const running = parsed.running === true && snapshot?.running === true;
      const status = typeof parsed.status === 'string'
        ? (parsed.status === 'running' && !running ? 'cancelled' : parsed.status)
        : 'failed';
      const elapsedMs = Math.max(0, (completedAt ?? lastOutputAt ?? Date.now()) - startedAt);

      return {
        processId: resolvedProcessId,
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : this.sessionId,
        outputSessionId: typeof parsed.outputSessionId === 'string' && parsed.outputSessionId.trim()
          ? parsed.outputSessionId.trim()
          : resolvedProcessId,
        command: typeof parsed.command === 'string' && parsed.command.trim() ? parsed.command.trim() : resolvedProcessId,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
        status: status as ChatRuntimeHostSessionProcessSummary['status'],
        running,
        startedAt,
        elapsedMs,
        bytesTotal,
        ...(typeof parsed.exitCode === 'number' && Number.isFinite(parsed.exitCode) ? { exitCode: parsed.exitCode } : {}),
        ...(typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) ? { pid: parsed.pid } : {}),
        ...(typeof lastOutputAt === 'number' ? { lastOutputAt } : {}),
        ...(typeof completedAt === 'number' ? { completedAt } : {}),
        ...(parsed.background === true ? { background: true } : {}),
        ...(parsed.removed === true ? { removed: true } : {}),
        ...(typeof parsed.removedAt === 'number' && Number.isFinite(parsed.removedAt) ? { removedAt: parsed.removedAt } : {}),
        outputFilePath: typeof parsed.outputFilePath === 'string' && parsed.outputFilePath.trim()
          ? parsed.outputFilePath.trim()
          : normalizedOutputFilePath,
      };
    } catch {
      return null;
    }
  }
}
