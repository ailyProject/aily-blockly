import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import { AilyHost } from '../../core/host';
import { getBlocklyArtifactReferenceLabel, resolveBlocklyArtifactReferenceTarget } from '../../helpers/chat-artifact-reference';
import type { ImportedDebugSessionViewModel } from '../../helpers/chat-debug-viewer-state';
import { buildHostSessionDebugEventSummary, type HostSessionDebugEvent } from '../../services/host-session-debug-events';
import type { ImportedDebugResourceSummary } from '../../services/chat-debug-browser.service';
import { AilyChatDebugBreadcrumbComponent } from '../aily-chat-debug-breadcrumb/aily-chat-debug-breadcrumb.component';

interface DebugSessionDetailRow {
  readonly label: string;
  readonly value: string;
  readonly reference?: string;
}

@Component({
  selector: 'aily-chat-debug-viewer',
  standalone: true,
  imports: [CommonModule, AilyChatDebugBreadcrumbComponent],
  templateUrl: './aily-chat-debug-viewer.component.html',
  styleUrl: './aily-chat-debug-viewer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AilyChatDebugViewerComponent {
  @Input({ required: true }) session!: ImportedDebugResourceSummary;
  @Input({ required: true }) view!: ImportedDebugSessionViewModel;
  @Input() debugEvents: readonly HostSessionDebugEvent[] = [];
  @Output() homeRequested = new EventEmitter<void>();
  @Output() logsRequested = new EventEmitter<void>();
  @Output() flowRequested = new EventEmitter<void>();
  @Output() cacheRequested = new EventEmitter<void>();
  @Output() closeRequested = new EventEmitter<void>();

  get sessionDetails(): readonly DebugSessionDetailRow[] {
    return [
      {
        label: '会话类型',
        value: '导入调试快照',
      },
      {
        label: '顶层入口',
        value: this.view.surfaceMode.label,
      },
      ...(this.view.providerOptions.folderPath
        ? [{
            label: '会话目录',
            value: this.view.providerOptions.folderPath,
          }]
        : []),
      {
        label: '会话权限模式',
        value: this.view.providerOptions.permissionMode,
      },
      ...(this.view.providerOptions.permissionLevel
        ? [{
            label: '会话权限级别',
            value: this.view.providerOptions.permissionLevel,
          }]
        : []),
      ...(this.view.requestRouting.requestModeId
        ? [{
            label: '请求显式模式',
            value: this.view.requestRouting.requestModeId,
          }]
        : []),
      {
        label: '请求选中模式',
        value: this.view.requestRouting.selectedModeId,
      },
      ...(this.view.requestRouting.customAgentTarget
        ? [{
            label: '请求自定义智能体',
            value: this.view.requestRouting.customAgentTarget,
          }]
        : []),
      ...(this.view.requestRouting.permissionLevel
        ? [{
            label: '请求权限级别',
            value: this.view.requestRouting.permissionLevel,
          }]
        : []),
      ...((this.view.interactionActionSummary?.kind === 'plan_review' && this.view.interactionActionSummary.actionId)
        ? [{
            label: '退出 Plan 动作',
            value: this.view.interactionActionSummary.actionId,
          }]
        : []),
      ...(this.view.pendingPlanReview
        ? [{
            label: '待恢复 Plan 审查',
            value: this.view.pendingPlanReview.title,
          }]
        : []),
      ...(this.view.pendingPlanReview?.planUri
        ? [{
            label: '待恢复 Plan 文件',
            value: this.getReferenceLabel(this.view.pendingPlanReview.planUri),
            reference: this.view.pendingPlanReview.planUri,
          }]
        : []),
      ...this.planPartDetailRows,
      ...this.dualPersistenceDetailRows,
      ...this.restoreDiagnosticsDetailRows,
      ...this.restoreFailureDetailRows,
      ...this.liveRuntimeDetailRows,
    ];
  }

  get planPartDetailRows(): readonly DebugSessionDetailRow[] {
    const planParts = this.view.planParts ?? [];
    if (!planParts.length) {
      return [];
    }

    const latestPlan = planParts[planParts.length - 1];
    const latestStatus = [
      latestPlan.status,
      latestPlan.source ? `source=${latestPlan.source}` : '',
      latestPlan.partId ? `part=${latestPlan.partId}` : '',
    ].filter(Boolean).join(', ');
    return [
      { label: 'Plan parts', value: String(planParts.length) },
      { label: 'Latest plan status', value: latestStatus || 'unknown' },
      { label: 'Latest plan turn', value: latestPlan.turnId || '<unknown>' },
      { label: 'Latest plan chars', value: String(latestPlan.charLength) },
      ...(latestPlan.preview ? [{ label: 'Latest plan preview', value: latestPlan.preview }] : []),
    ];
  }

  get dualPersistenceDetailRows(): readonly DebugSessionDetailRow[] {
    const dualPersistence = this.view.dualPersistence;
    if (!dualPersistence) {
      return [];
    }

    const rows: DebugSessionDetailRow[] = [{
      label: 'Dual persistence',
      value: dualPersistence.lexSnapshotPresent ? 'present' : 'missing',
    }];
    rows.push(
      { label: 'Host record path', value: dualPersistence.hostRecordPath },
      { label: 'Lex snapshot path', value: dualPersistence.lexSnapshotPath },
      {
        label: 'Persistence turn counts',
        value: `host=${dualPersistence.hostTurnResponseCount}, lex=${dualPersistence.lexTurnCount ?? 0}`,
      },
    );
    if (dualPersistence.notes?.length) {
      rows.push({
        label: 'Persistence notes',
        value: dualPersistence.notes.join(' | '),
      });
    }
    return rows;
  }

  get restoreDiagnosticsDetailRows(): readonly DebugSessionDetailRow[] {
    const restoreDiagnostics = this.view.restoreDiagnostics;
    if (!restoreDiagnostics) {
      return [];
    }

    const rows: DebugSessionDetailRow[] = [{
      label: 'Restore diagnostics',
      value: restoreDiagnostics.storedSnapshotState,
    }, {
      label: 'Restore snapshot path',
      value: restoreDiagnostics.lexSnapshotPath,
    }];
    if (restoreDiagnostics.storedSnapshotError) {
      rows.push({
        label: 'Restore snapshot error',
        value: restoreDiagnostics.storedSnapshotError,
      });
    }
    if (restoreDiagnostics.missingActiveSkillNames?.length) {
      rows.push({
        label: 'Missing restored skills',
        value: restoreDiagnostics.missingActiveSkillNames.join(' | '),
      });
    }
    if (restoreDiagnostics.notes?.length) {
      rows.push({
        label: 'Restore diagnostics notes',
        value: restoreDiagnostics.notes.join(' | '),
      });
    }
    return rows;
  }

  get restoreFailureDetailRows(): readonly DebugSessionDetailRow[] {
    const restoreFailure = this.view.restoreFailure;
    if (!restoreFailure) {
      return [];
    }

    const rows: DebugSessionDetailRow[] = [{
      label: 'Restore failure',
      value: restoreFailure.restoreKind ?? restoreFailure.stage,
    }, {
      label: 'Restore failure stage',
      value: restoreFailure.stage,
    }, {
      label: 'Restore request source',
      value: restoreFailure.requestSource,
    }, {
      label: 'Restore host source',
      value: restoreFailure.hostRecordSource,
    }, {
      label: 'Restore metadata source',
      value: restoreFailure.metadataSource,
    }, {
      label: 'Restore error',
      value: restoreFailure.errorMessage,
    }];
    if (restoreFailure.hostRecordSessionId) {
      rows.push({
        label: 'Restore host session',
        value: restoreFailure.hostRecordSessionId,
      });
    }
    if (restoreFailure.storedSnapshotState) {
      rows.push({
        label: 'Restore snapshot state',
        value: restoreFailure.storedSnapshotState,
      });
    }
    if (restoreFailure.notes?.length) {
      rows.push({
        label: 'Restore failure notes',
        value: restoreFailure.notes.join(' | '),
      });
    }
    return rows;
  }

  get liveRuntimeDetailRows(): readonly DebugSessionDetailRow[] {
    const liveRuntimeOverlay = this.view.liveRuntimeOverlay;
    if (!liveRuntimeOverlay) {
      return [];
    }

    const rows: DebugSessionDetailRow[] = [{
      label: 'Live runtime overlay',
      value: liveRuntimeOverlay.status ?? 'present',
    }];
    rows.push(
      { label: 'Live pendingRequest', value: liveRuntimeOverlay.pendingRequest ? 'yes' : 'no' },
      { label: 'Live needsInput', value: liveRuntimeOverlay.needsInput ? 'yes' : 'no' },
      { label: 'Live attachedView', value: liveRuntimeOverlay.attachedView ? 'yes' : 'no' },
      { label: 'Live turnResponses', value: String(liveRuntimeOverlay.turnResponseCount) },
      { label: 'Live hostProjection', value: liveRuntimeOverlay.hostProjectionPresent ? 'present' : 'absent' },
    );
    if (typeof liveRuntimeOverlay.quotaOverlayPresent === 'boolean') {
      rows.push({
        label: 'Live quotaOverlay',
        value: liveRuntimeOverlay.quotaOverlayPresent ? 'present' : 'absent',
      });
    }
    if (typeof liveRuntimeOverlay.requestQuotaNotice === 'boolean') {
      rows.push({
        label: 'Live requestQuotaNotice',
        value: liveRuntimeOverlay.requestQuotaNotice ? 'yes' : 'no',
      });
    }
    if (typeof liveRuntimeOverlay.authQuotaProjected === 'boolean') {
      rows.push({
        label: 'Live authQuotaProjected',
        value: liveRuntimeOverlay.authQuotaProjected ? 'yes' : 'no',
      });
    }
    if (typeof liveRuntimeOverlay.contextBudgetOverlayPresent === 'boolean') {
      rows.push({
        label: 'Live contextBudgetOverlay',
        value: liveRuntimeOverlay.contextBudgetOverlayPresent ? 'present' : 'absent',
      });
    }
    if (typeof liveRuntimeOverlay.inputNoticeOverlayPresent === 'boolean') {
      rows.push({
        label: 'Live inputNoticeOverlay',
        value: liveRuntimeOverlay.inputNoticeOverlayPresent ? 'present' : 'absent',
      });
    }
    if (liveRuntimeOverlay.capabilities) {
      rows.push({
        label: 'Live capabilities',
        value: `concurrent=${liveRuntimeOverlay.capabilities.canRunConcurrently ? 'yes' : 'no'}, continueInPlace=${liveRuntimeOverlay.capabilities.canContinueInPlace ? 'yes' : 'no'}, background=${liveRuntimeOverlay.capabilities.supportsBackgroundPersistence ? 'yes' : 'no'}`,
      });
    }
    if (liveRuntimeOverlay.lastViewDetachAt) {
      rows.push({
        label: 'Live lastViewDetach',
        value: new Date(liveRuntimeOverlay.lastViewDetachAt).toISOString(),
      });
    }
    if (liveRuntimeOverlay.lastExplicitInterruptAt) {
      rows.push({
        label: 'Live lastExplicitInterrupt',
        value: new Date(liveRuntimeOverlay.lastExplicitInterruptAt).toISOString(),
      });
    }
    if (liveRuntimeOverlay.lastExplicitDisposeAt) {
      rows.push({
        label: 'Live lastExplicitDispose',
        value: new Date(liveRuntimeOverlay.lastExplicitDisposeAt).toISOString(),
      });
    }
    return rows;
  }

  get debugSummary() {
    return buildHostSessionDebugEventSummary(this.debugEvents);
  }

  get summaryMetrics() {
    const summary = this.debugSummary;
    return [
      { label: '模型轮次', value: String(summary.modelTurnCount) },
      { label: '工具调用', value: String(summary.toolCallCount) },
      { label: '输入 Tokens', value: String(summary.totalInputTokens) },
      { label: '输出 Tokens', value: String(summary.totalOutputTokens) },
      { label: '缓存 Tokens', value: String(summary.totalCachedTokens) },
      { label: '总 Tokens', value: String(summary.totalInputTokens + summary.totalOutputTokens) },
      { label: '错误事件', value: String(summary.errorCount) },
    ];
  }

  canOpenReference(reference: string | undefined): boolean {
    return Boolean(reference && this.resolveReferenceTarget(reference)?.absolutePath && AilyHost.get().editor?.showTextDocument);
  }

  openReference(reference: string, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();

    const target = this.resolveReferenceTarget(reference);
    const projectPath = AilyHost.get().project?.currentProjectPath || undefined;
    if (!target?.absolutePath || !AilyHost.get().editor?.showTextDocument) {
      return;
    }

    void Promise.resolve(AilyHost.get().editor.showTextDocument(target.absolutePath, { projectPath }));
  }

  private getReferenceLabel(reference: string): string {
    const host = AilyHost.get();
    const cwd = host.project?.currentProjectPath || host.project?.projectRootPath || undefined;
    return getBlocklyArtifactReferenceLabel(host, reference, {
      cwd,
      sessionId: this.view.metadata.sessionId,
    });
  }

  private resolveReferenceTarget(reference: string) {
    const host = AilyHost.get();
    const cwd = host.project?.currentProjectPath || host.project?.projectRootPath || undefined;
    return resolveBlocklyArtifactReferenceTarget(host, reference, {
      cwd,
      sessionId: this.view.metadata.sessionId,
    });
  }
}
