import type { ISessionAccess, IChatCoordination } from '../core/chat-context';
import type { MetricsSnapshot } from 'aily-lex/browser';
import type { ChatRuntimeHostTodoItem } from '../core/chat-runtime-host-contract';
import { resolveChatModeId, type ChatModeId } from '../core/chat-mode';
import { normalizeReadSideToolName } from '../core/tool-name-normalizer';
import type { TodoItem as BlocklyTodoItem } from '../utils/todoStorage';

/** Narrow context: host sync owns model/runtime facts and requests view side effects through the host boundary. */
type LexHostSyncContext = Pick<ISessionAccess, 'sessionId'>
  & Pick<IChatCoordination, 'lexStream'>
  & {
    readonly editTracking: {
      recordAdditionalRepositoryRootCandidates(paths: readonly string[] | undefined | null): void;
      recordEdit(filePath: string, type: 'create' | 'modify' | 'delete'): void;
      publishCurrentSummary(): Promise<void>;
    };
    readonly viewRequests: LexHostViewRequestDispatcher;
  };

type AilyLexModule = import('./lex-agent-bootstrap').AilyLexModule;
type LexTodoItem = {
  id: number;
  title: string;
  activeForm?: string;
  status: BlocklyTodoItem['status'];
};
type LexHostViewRequestDispatcher = {
  syncTodoState(
    sessionId: string | null | undefined,
    items: readonly ChatRuntimeHostTodoItem[],
  ): void;
  requestHandoff(input: {
    readonly sessionId: string | null | undefined;
    readonly targetAgent?: string;
    readonly targetModeId?: ChatModeId;
    readonly message: string;
    readonly suggestedInput?: string;
  }): void;
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
      this.ctx.editTracking.recordAdditionalRepositoryRootCandidates([input.cwd]);
    }

    if (!editType) return;

    if (normalizedToolName === 'multi_replace_string_in_file') {
      const replacements = Array.isArray(input.replacements) ? input.replacements : [];
      for (const replacement of replacements) {
        const filePath = replacement && typeof replacement === 'object'
          ? (replacement as { filePath?: unknown }).filePath
          : undefined;
        if (typeof filePath === 'string' && filePath.trim()) {
          this.ctx.editTracking.recordEdit(filePath, editType);
        }
      }
      return;
    }

    const filePath = input.filePath || input.path;
    if (filePath) {
      this.ctx.editTracking.recordEdit(filePath, editType);
    }
  }

  /** 文件工具写盘完成后刷新 edits 摘要 UI（流式实时更新） */
  refreshFileEditSummary(): void {
    void this.ctx.editTracking.publishCurrentSummary();
  }

  applyLexTodos(sessionId: string, lexTodos: readonly LexTodoItem[]): void {
    const blocklyTodos: ChatRuntimeHostTodoItem[] = lexTodos.map(t => ({
      id: t.id,
      content: t.activeForm || t.title,
      status: t.status,
      priority: 'medium' as const,
      updatedAt: Date.now(),
    }));

    this.ctx.viewRequests.syncTodoState(sessionId, blocklyTodos);
  }

  applyTodoStateEvent(event: { sessionId?: string; trace?: { sessionId?: string }; snapshot?: { items?: readonly LexTodoItem[] } }): void {
    const sessionId = event.sessionId || event.trace?.sessionId || this.ctx.sessionId;
    const lexTodos = event.snapshot?.items ?? [];
    this.applyLexTodos(sessionId, lexTodos);
  }

  applyHandoffEvent(event: { targetAgent?: string; targetModeId?: string; reason?: string }): void {
    const targetAgent = typeof event.targetAgent === 'string' ? event.targetAgent.trim() : '';
    const explicitTargetModeId = resolveChatModeId(event.targetModeId);
    const targetModeId = explicitTargetModeId ?? resolveCanonicalModeFromAgentLabel(targetAgent);
    if (!targetAgent && !targetModeId) {
      return;
    }

    const targetLabel = targetModeId
      ? `${formatCanonicalChatModeLabel(targetModeId)} 模式`
      : targetAgent;
    const handoffMessage = event.reason
      ? `代理请求切换到 ${targetLabel}: ${event.reason}`
      : `代理请求切换到 ${targetLabel}`;
    const suggestedInput = `@${targetAgent} `;

    this.ctx.viewRequests.requestHandoff({
      sessionId: this.ctx.sessionId,
      ...(targetAgent ? { targetAgent } : {}),
      ...(targetModeId ? { targetModeId } : {}),
      message: handoffMessage,
      suggestedInput,
    });
  }

  subscribeLexTodoChange(lex: AilyLexModule, currentUnsubscribe?: (() => void) | null): (() => void) | null {
    currentUnsubscribe?.();
    return lex.onTodoChange((sessionId, lexTodos) => {
      this.applyLexTodos(sessionId, lexTodos);
    });
  }
}

function formatCanonicalChatModeLabel(modeId: ChatModeId): string {
  switch (modeId) {
    case 'ask':
      return 'Ask';
    case 'edit':
      return 'Edit';
    case 'agent':
      return 'Agent';
    case 'plan':
      return 'Plan';
  }
  return modeId;
}

function resolveCanonicalModeFromAgentLabel(agentLabel: string): ChatModeId | null {
  return agentLabel.trim().toLowerCase() === 'plan' ? 'plan' : null;
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
