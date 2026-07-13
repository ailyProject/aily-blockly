import type { RenderEvent, TurnRequest } from 'aily-lex/browser';

type NoticeSink = {
  emitNotice?(opts: {
    title?: string;
    text?: string;
    state?: string;
    showProgress?: boolean;
    setTimeout?: number;
    sendToLog?: boolean;
  }): void;
};

type RenderEventRequestContext = {
  readonly sessionId: string;
  readonly requestText: string;
  readonly displayText?: string;
  readonly metadata?: TurnRequest['metadata'] | null;
  readonly activeResponseHandle?: unknown;
} | null;

type SchematicScope = {
  readonly toolCallId: string;
  readonly subAgentInvocationId: string;
  readonly agentName: string;
};

const SCHEMATIC_AGENT_NAME = 'schematicagent';
const SCHEMATIC_TOOL_NAMES = new Set([
  'generate_schematic',
  'validate_schematic',
  'get_current_schematic',
  'apply_schematic',
  'generateConnectionGraph',
  'validateConnectionGraph',
  'getCurrentSchematic',
  'applySchematic',
]);

const TOOL_PROGRESS_TEXT: Record<string, string> = {
  generate_schematic: '正在准备开发板与外设引脚信息...',
  validate_schematic: '正在验证并保存连线方案...',
  get_current_schematic: '正在读取当前连线图...',
  apply_schematic: '正在应用连线方案...',
  generateConnectionGraph: '正在准备开发板与外设引脚信息...',
  validateConnectionGraph: '正在验证并保存连线方案...',
  getCurrentSchematic: '正在读取当前连线图...',
  applySchematic: '正在应用连线方案...',
};

/**
 * Projects the standard Lex/Copilot-style RenderEvent stream into the
 * connection-graph iframe notice channel. This keeps schematic iframe progress
 * as an observer of the host-owned response model instead of reviving the old
 * BackgroundAgent execution owner.
 */
export class SchematicIframeProgressProjector {
  private readonly activeScopes = new Map<string, SchematicScope>();
  private lastThinkingNoticeAt = 0;

  constructor(private readonly noticeSink: NoticeSink) {}

  process(
    _sessionId: string | null | undefined,
    event: RenderEvent,
    _request?: RenderEventRequestContext,
  ): void {
    switch (event.type) {
      case 'subagent_begin':
        this.handleSubagentBegin(event);
        return;
      case 'subagent_end':
        this.handleSubagentEnd(event);
        return;
      case 'thinking_delta':
      case 'markdown_delta':
        this.handleScopedText(event);
        return;
      case 'tool_call_begin':
        this.handleToolBegin(event);
        return;
      case 'tool_call_end':
        this.handleToolEnd(event);
        return;
    }
  }

  private handleSubagentBegin(event: Extract<RenderEvent, { type: 'subagent_begin' }>): void {
    if (!this.isSchematicAgentName(event.agentName)) {
      return;
    }
    const scope: SchematicScope = {
      toolCallId: event.toolCallId,
      subAgentInvocationId: event.subAgentInvocationId || event.toolCallId,
      agentName: event.agentName || 'SchematicAgent',
    };
    this.activeScopes.set(scope.toolCallId, scope);
    this.activeScopes.set(scope.subAgentInvocationId, scope);
    this.emitDoing('电路图生成中', `${scope.agentName} 正在分析项目连线需求...`);
  }

  private handleSubagentEnd(event: Extract<RenderEvent, { type: 'subagent_end' }>): void {
    const scope = this.findScope(event);
    if (!scope) {
      return;
    }
    const isError = event.state === 'error';
    this.emitNotice({
      title: isError ? '电路图生成失败' : '电路图生成完成',
      text: isError ? this.compactText(event.resultText) || 'SchematicAgent 执行失败。' : 'SchematicAgent 已完成连线图处理。',
      state: isError ? 'error' : 'done',
      showProgress: false,
      setTimeout: isError ? 600000 : 5000,
      sendToLog: false,
    });
    this.activeScopes.delete(scope.toolCallId);
    this.activeScopes.delete(scope.subAgentInvocationId);
  }

  private handleScopedText(event: Extract<RenderEvent, { type: 'thinking_delta' | 'markdown_delta' }>): void {
    if (!this.findScope(event)) {
      return;
    }
    const now = Date.now();
    if (now - this.lastThinkingNoticeAt < 800) {
      return;
    }
    this.lastThinkingNoticeAt = now;
    const text = this.compactText(event.text);
    this.emitDoing('电路图生成中', text ? `正在分析：${text}` : '正在分析连线方案...');
  }

  private handleToolBegin(event: Extract<RenderEvent, { type: 'tool_call_begin' }>): void {
    if (!this.findScope(event) && !SCHEMATIC_TOOL_NAMES.has(event.toolName || '')) {
      return;
    }
    const toolName = event.toolName || '';
    this.emitDoing('电路图生成中', TOOL_PROGRESS_TEXT[toolName] || `正在执行 ${toolName || '连线图工具'}...`);
  }

  private handleToolEnd(event: Extract<RenderEvent, { type: 'tool_call_end' }>): void {
    if (!this.findScope(event) && !SCHEMATIC_TOOL_NAMES.has(event.toolName || '')) {
      return;
    }
    const toolName = event.toolName || '';
    const isError = event.state === 'error' || event.isError === true;
    this.emitNotice({
      title: isError ? '电路图工具执行失败' : '电路图工具执行完成',
      text: isError
        ? this.compactText(event.resultText) || `${toolName || '连线图工具'} 执行失败。`
        : `${TOOL_PROGRESS_TEXT[toolName] || toolName || '连线图工具'}完成。`,
      state: isError ? 'error' : 'done',
      showProgress: false,
      setTimeout: isError ? 600000 : 3000,
      sendToLog: false,
    });
  }

  private findScope(event: { readonly toolCallId?: string; readonly subAgentInvocationId?: string; readonly parentToolCallId?: string }): SchematicScope | null {
    const candidates = [event.subAgentInvocationId, event.parentToolCallId, event.toolCallId];
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      const scope = this.activeScopes.get(candidate);
      if (scope) {
        return scope;
      }
    }
    return null;
  }

  private isSchematicAgentName(agentName: string | undefined): boolean {
    return typeof agentName === 'string'
      && agentName.trim().toLowerCase() === SCHEMATIC_AGENT_NAME;
  }

  private emitDoing(title: string, text: string): void {
    this.emitNotice({
      title,
      text,
      state: 'doing',
      showProgress: false,
      setTimeout: 0,
      sendToLog: false,
    });
  }

  private emitNotice(opts: Parameters<NonNullable<NoticeSink['emitNotice']>>[0]): void {
    try {
      this.noticeSink.emitNotice?.(opts);
    } catch {
      // The iframe may not be open; progress projection must never affect turn execution.
    }
  }

  private compactText(value: unknown): string {
    if (typeof value !== 'string') {
      return '';
    }
    return value.replace(/\s+/g, ' ').trim().slice(0, 80);
  }
}
