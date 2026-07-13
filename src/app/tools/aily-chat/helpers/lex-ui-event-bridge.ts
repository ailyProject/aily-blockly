import type { IAgentLifecycle, IChatServiceAccess } from '../core/chat-context';
import { buildConfirmationPartId, buildQuestionPartId } from '../core/chat-parts';
import type { ChatPartScope, ConfirmationPart, QuestionItem, QuestionPart } from '../core/chat-parts';
import type { ToolApprovalRequest } from './tool-approval-ui';
import type { LexTurnDraft } from './lex-message-lifecycle-bridge';
import type { RenderEvent } from 'aily-lex/browser';
import type { HostSessionSaveTarget } from './host-session-save-bridge';
import {
  LexAgentEventBridge,
  type LexAgentHostSyncAccess,
  type LexAgentPartProcessor,
} from './lex-agent-event-bridge';

type LexUiEventContext = ConstructorParameters<typeof LexAgentEventBridge>[0]
  & {
    readonly sessionId: string;
    readCurrentViewSessionResource?(): string | null;
    emitExecutionRenderEvent?(
      sessionId: string | null | undefined,
      event: RenderEvent,
      request?: null,
    ): void;
  };

type LexUiEventLifecycleAccess = {
  ensureResponseItem(turnId?: string): void;
  resetTurnState(): void;
  getCurrentTurnDraft(): LexTurnDraft;
  finalize(saveTarget?: HostSessionSaveTarget | null): Promise<void>;
  closeNativeThinking(): void;
  startNativeThinking(): void;
};

type LexUiEventMainLifecycleAccess = Pick<
  LexUiEventLifecycleAccess,
  'ensureResponseItem' | 'closeNativeThinking' | 'startNativeThinking'
>;

type LexUiEventOwnerLifecycleAccess = Pick<
  LexUiEventLifecycleAccess,
  'ensureResponseItem' | 'resetTurnState' | 'getCurrentTurnDraft' | 'finalize'
>;

type LexUiEventMainEventBridge = Pick<
  LexAgentEventBridge,
  'processEvent'
>;

type LexUiInteractionRenderEvent = Extract<RenderEvent, { type: 'approval_request' | 'approval_resolve' | 'question_request' }>;

type LexUiEventRenderAccess = {
  processInteractionEvent(event: LexUiInteractionRenderEvent): boolean;
  updateQuestionAnswers(answers: QuestionPart['answers'], partId: string): boolean;
  appendExecutionError(message: string, options?: { readonly retry?: boolean }): boolean;
};

/**
 * LexUiEventBridge
 *
 * 将主 agent、subagent 和 pending lifecycle 事件压到同一个 UI 入口，
 * 避免 LexOwnerFacade / TurnExecutionBridge 分别感知多个 bridge。
 */
export class LexUiEventBridge {
  private readonly mainEventBridge: LexUiEventMainEventBridge;
  private readonly messageLifecycleBridge: LexUiEventOwnerLifecycleAccess;
  private readonly renderEventBridge?: LexUiEventRenderAccess;

  constructor(
    private readonly ctx: LexUiEventContext,
    partProcessor: LexAgentPartProcessor,
    hostSyncBridge: LexAgentHostSyncAccess,
    messageLifecycleBridge: LexUiEventLifecycleAccess,
    renderEventBridge?: LexUiEventRenderAccess,
  ) {
    const mainLifecycleBridge: LexUiEventMainLifecycleAccess = messageLifecycleBridge;
    this.messageLifecycleBridge = messageLifecycleBridge;
    this.renderEventBridge = renderEventBridge;
    this.mainEventBridge = new LexAgentEventBridge(
      ctx,
      partProcessor,
      hostSyncBridge,
      mainLifecycleBridge,
    );
  }

  ensureResponseItem(turnId?: string): void {
    this.messageLifecycleBridge.ensureResponseItem(turnId);
  }

  resetTurnState(): void {
    this.messageLifecycleBridge.resetTurnState();
  }

  getCurrentTurnDraft(): LexTurnDraft {
    return this.messageLifecycleBridge.getCurrentTurnDraft();
  }

  processEvent(event: any, scope: 'main' | 'subagent' = 'main'): void {
    if (scope === 'subagent') {
      // New subagent live rendering must arrive as scoped RenderEvent first-class parts.
      // Raw child events are intentionally ignored here to avoid reviving the legacy
      // parent tool_call metadata childItems live path.
      return;
    }

    this.mainEventBridge.processEvent(event);
  }

  flushPendingEvents(events: readonly any[]): void {
    for (const event of events) {
      this.processEvent(event);
    }
  }

  async finalizeTurn(saveTarget?: HostSessionSaveTarget | null): Promise<void> {
    await this.messageLifecycleBridge.finalize(saveTarget);
  }

  appendLifecycleError(message: string): void {
    if (this.renderEventBridge?.appendExecutionError(message)) {
      return;
    }
    throw new Error('Failed to append lifecycle error: no active canonical response.');
  }

  appendExecutionError(message: string, options: { retry?: boolean } = {}): void {
    if (this.renderEventBridge?.appendExecutionError(message, options)) {
      return;
    }
    throw new Error('Failed to append execution error: no active canonical response.');
  }

  presentQuestion(questions: QuestionItem[], scope?: ChatPartScope): string {
    const requestId = `question-${Date.now()}`;
    const partId = buildQuestionPartId(questions, requestId);
    const event = {
      type: 'question_request',
      requestId,
      questions: questions.map(question => ({
        question: question.question,
        options: question.options?.map(option => ({ ...option })),
        allowFreeform: question.allow_freeform,
        multiSelect: question.multi_select,
      })),
      timestamp: Date.now(),
      sourceAgentRole: scope?.sourceAgentRole,
      subAgentInvocationId: scope?.subAgentInvocationId,
      parentToolCallId: scope?.parentToolCallId,
      sequence: scope?.sequence,
    } as const;
    if (this.renderEventBridge?.processInteractionEvent(event)) {
      return partId;
    }

    if (this.emitHostInteractionRenderEvent(event)) {
      return partId;
    }

    if (!this.canWriteCurrentView()) {
      return partId;
    }

    throw new Error('Failed to create question part: no active canonical response.');
  }

  updateQuestionAnswers(answers: QuestionPart['answers'], partId: string): boolean {
    return this.renderEventBridge?.updateQuestionAnswers(answers, partId) ?? false;
  }

  presentToolCallApproval(request: ToolApprovalRequest): string {
    const event = {
      type: 'approval_request',
      approvalTraceId: request.approvalTraceId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      input: request.args ?? {},
      message: request.message,
      title: request.title,
      subtitle: request.subtitle,
      actions: request.actions,
      primaryScope: request.primaryScope,
      source: request.source,
      timestamp: Date.now(),
    } as const;
    const mirrored = this.renderEventBridge?.processInteractionEvent(event as any) ?? false;
    if (mirrored) {
      return request.toolCallId;
    }

    if (this.emitHostInteractionRenderEvent(event)) {
      return request.toolCallId;
    }

    if (!this.canWriteCurrentView()) {
      return request.toolCallId;
    }

    throw new Error(`Failed to present tool approval ${request.toolCallId}: no active canonical response.`);
  }

  resolveToolCallApproval(
    toolCallId: string,
    approved: boolean,
    scope?: ConfirmationPart['scope'],
    approvalTraceId?: string,
  ): void {
    const event = {
      type: 'approval_resolve',
      approvalTraceId,
      toolCallId,
      result: approved ? 'approved' : 'rejected',
      scope,
      timestamp: Date.now(),
    } as const;
    const mirrored = this.renderEventBridge?.processInteractionEvent(event as any) ?? false;
    if (mirrored) {
      return;
    }

    if (this.emitHostInteractionRenderEvent(event)) {
      return;
    }

    if (!this.canWriteCurrentView()) {
      return;
    }

    throw new Error(`Failed to resolve tool approval ${toolCallId}: no active canonical response.`);
  }

  presentConfirmation(
    askId: string,
    message: string,
    toolName?: string,
    source?: string,
    presentation?: Partial<Pick<ConfirmationPart, 'title' | 'subtitle' | 'actions' | 'primaryScope' | 'args'>>,
  ): string {
    const partId = buildConfirmationPartId(askId);
    if (this.renderEventBridge?.processInteractionEvent({
      type: 'approval_request',
      requestId: askId,
      toolName: toolName ?? '',
      input: presentation?.args ?? {},
      message,
      title: presentation?.title,
      subtitle: presentation?.subtitle,
      actions: presentation?.actions,
      primaryScope: presentation?.primaryScope,
      source,
      timestamp: Date.now(),
    })) {
      return partId;
    }

    if (!this.canWriteCurrentView()) {
      return partId;
    }

    throw new Error(`Failed to present confirmation ${askId}: no active canonical response.`);
  }

  resolveConfirmation(
    partId: string,
    askId: string,
    approved: boolean,
    scope?: ConfirmationPart['scope'],
  ): void {
    void partId;
    if (this.renderEventBridge?.processInteractionEvent({
      type: 'approval_resolve',
      requestId: askId,
      result: approved ? 'approved' : 'rejected',
      scope,
      timestamp: Date.now(),
    })) {
      return;
    }

    throw new Error(`Failed to resolve confirmation ${askId}: no active canonical response.`);
  }

  private canWriteCurrentView(): boolean {
    const readCurrentViewSessionResource = this.ctx.readCurrentViewSessionResource;
    if (typeof readCurrentViewSessionResource !== 'function') {
      return true;
    }

    const currentViewSessionResource = readCurrentViewSessionResource();
    const normalizedViewResource = typeof currentViewSessionResource === 'string'
      ? currentViewSessionResource.trim()
      : '';
    if (!normalizedViewResource) {
      return false;
    }

    const targetSessionId = typeof this.ctx.sessionId === 'string'
      ? this.ctx.sessionId.trim()
      : '';
    return !!targetSessionId && targetSessionId === normalizedViewResource;
  }

  private emitHostInteractionRenderEvent(event: LexUiInteractionRenderEvent): boolean {
    if (typeof this.ctx.emitExecutionRenderEvent !== 'function') {
      return false;
    }

    const sessionId = typeof this.ctx.sessionId === 'string' ? this.ctx.sessionId.trim() : '';
    if (!sessionId) {
      return false;
    }

    this.ctx.emitExecutionRenderEvent(sessionId, event, null);
    return true;
  }
}
