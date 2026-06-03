import type { ISessionAccess, IChatCoordination, IChatServiceAccess, IChatViewAccess } from '../core/chat-context';
import type { MetricsSnapshot } from 'aily-lex/browser';
import { resolveChatModeId } from '../core/chat-mode';
import { normalizeReadSideToolName } from '../core/tool-name-normalizer';
import { buildTodoListSemanticDataFromTodos } from '../services/todoUpdate.service';
import { setTodos, type TodoItem as BlocklyTodoItem } from '../utils/todoStorage';

/** Narrow context: editCheckpointService for recording edits, ngZone for UI sync, sessionId for todo keying */
type LexHostSyncContext = Pick<ISessionAccess, 'sessionId'>
  & Pick<IChatServiceAccess, 'editCheckpointService' | 'ngZone' | 'message'>
  & Pick<IChatCoordination, 'lexStream'>
  & Pick<IChatViewAccess, 'inputValue' | 'triggerSyncDetectChanges'>
  & {
    switchToMode?(mode: string): Promise<void>;
  };

type AilyLexModule = import('./lex-agent-bootstrap').AilyLexModule;
type LexTodoItem = {
  id: number;
  title: string;
  activeForm?: string;
  status: BlocklyTodoItem['status'];
};

/**
 * Host-side sync bridges used by the lex stream path.
 *
 * Keeps file edit checkpoint mapping and todo sync wiring out of LexOwnerFacade.
 */
export class LexHostSyncBridge {
  private static readonly LEX_FILE_TOOL_TYPES: Record<string, 'create' | 'modify' | 'delete'> = {
    create_file: 'create',
    replace_string_in_file: 'modify',
    multi_replace_string_in_file: 'modify',
    write_file: 'modify',
    delete_file: 'delete',
  };

  constructor(private readonly ctx: LexHostSyncContext) {}

  getCompactionMetricsSnapshot(): MetricsSnapshot | null {
    const snapshot = this.ctx.lexStream?.compactionMetricsSnapshot;
    return snapshot ? cloneMetricsSnapshot(snapshot) : null;
  }

  recordFileToolEdit(toolName: string, input: any): void {
    const normalizedToolName = normalizeReadSideToolName(toolName);
    const editType = LexHostSyncBridge.LEX_FILE_TOOL_TYPES[normalizedToolName];
    if (!input) return;

    if (normalizedToolName === 'run_in_terminal' && input.cwd) {
      this.ctx.editCheckpointService.recordAdditionalRepositoryRootCandidates?.([input.cwd]);
    }

    if (!editType) return;

    if (normalizedToolName === 'multi_replace_string_in_file') {
      const replacements = Array.isArray(input.replacements) ? input.replacements : [];
      for (const replacement of replacements) {
        const filePath = replacement && typeof replacement === 'object'
          ? (replacement as { filePath?: unknown }).filePath
          : undefined;
        if (typeof filePath === 'string' && filePath.trim()) {
          this.ctx.editCheckpointService.recordEdit(filePath, editType);
        }
      }
      return;
    }

    const filePath = input.filePath || input.path;
    if (filePath) {
      this.ctx.editCheckpointService.recordEdit(filePath, editType);
    }
  }

  /** 文件工具写盘完成后刷新 edits 摘要 UI（流式实时更新） */
  refreshFileEditSummary(): void {
    void this.ctx.editCheckpointService.publishCurrentSummary();
  }

  applyLexTodos(sessionId: string, lexTodos: readonly LexTodoItem[]): void {
    const blocklyTodos: BlocklyTodoItem[] = lexTodos.map(t => ({
      id: t.id,
      content: t.activeForm || t.title,
      status: t.status,
      priority: 'medium' as const,
      updatedAt: Date.now(),
    }));

    try {
      setTodos(blocklyTodos, sessionId);
    } catch {
      // ignore persistence failures for UI sync bridge
    }

    this.ctx.ngZone.run(() => {
      try {
        const svc = (window as any).todoUpdateService;
        if (svc) {
          svc.updateTodoListSemanticData(
            sessionId,
            buildTodoListSemanticDataFromTodos(blocklyTodos),
            blocklyTodos,
          );
        }
      } catch {
        // ignore UI notification failures
      }
    });
  }

  applyTodoStateEvent(event: { sessionId?: string; trace?: { sessionId?: string }; snapshot?: { items?: readonly LexTodoItem[] } }): void {
    const sessionId = event.sessionId || event.trace?.sessionId || this.ctx.sessionId;
    const lexTodos = event.snapshot?.items ?? [];
    this.applyLexTodos(sessionId, lexTodos);
  }

  applyHandoffEvent(event: { targetAgent?: string; targetModeId?: string; reason?: string }): void {
    const targetAgent = typeof event.targetAgent === 'string' ? event.targetAgent.trim() : '';
    const targetModeId = resolveChatModeId(event.targetModeId);
    if (!targetAgent && !targetModeId) {
      return;
    }

    const targetLabel = targetModeId
      ? `${targetAgent || targetModeId} 模式`
      : targetAgent;
    const handoffMessage = event.reason
      ? `代理请求切换到 ${targetLabel}: ${event.reason}`
      : `代理请求切换到 ${targetLabel}`;
    const suggestedInput = `@${targetAgent} `;

    this.ctx.ngZone.run(() => {
      if (targetModeId && this.ctx.switchToMode) {
        void this.ctx.switchToMode(targetModeId).catch((error) => {
          console.error('应用 handoff 模式切换失败:', error);
        });

        try {
          this.ctx.message.info(handoffMessage);
        } catch {
          // ignore UI notification failures for host sync bridge
        }
        return;
      }

      let prefilled = false;

      if ((this.ctx.inputValue || '').trim().length === 0) {
        this.ctx.inputValue = suggestedInput;
        this.ctx.triggerSyncDetectChanges();
        prefilled = true;
      }

      try {
        this.ctx.message.info(
          prefilled
            ? `${handoffMessage}。已在输入框中预填 ${suggestedInput.trim()}，等待你确认发送。`
            : handoffMessage,
        );
      } catch {
        // ignore UI notification failures for host sync bridge
      }
    });
  }

  subscribeLexTodoChange(lex: AilyLexModule, currentUnsubscribe?: (() => void) | null): (() => void) | null {
    currentUnsubscribe?.();
    return lex.onTodoChange((sessionId, lexTodos) => {
      this.applyLexTodos(sessionId, lexTodos);
    });
  }
}

function cloneMetricsSnapshot(snapshot: MetricsSnapshot): MetricsSnapshot {
  return {
    timestamp: snapshot.timestamp,
    counters: snapshot.counters.map((counter) => ({
      name: counter.name,
      value: counter.value,
      labels: { ...counter.labels },
    })),
    histograms: snapshot.histograms.map((histogram) => ({
      name: histogram.name,
      count: histogram.count,
      sum: histogram.sum,
      min: histogram.min,
      max: histogram.max,
      avg: histogram.avg,
      p50: histogram.p50,
      p95: histogram.p95,
      p99: histogram.p99,
      labels: { ...histogram.labels },
    })),
    gauges: snapshot.gauges.map((gauge) => ({
      name: gauge.name,
      value: gauge.value,
      labels: { ...gauge.labels },
    })),
  };
}