import type { ChatPartStore, ChatPartStoreReadableHandle, ChatPartStoreResponseHandle } from './chat-part-store';
import type { ChatPart, StatePart, SubagentToolCallSnapshot, TerminalPart, ToolCallPart } from './chat-parts';

export interface MutableSubagentPart extends SubagentToolCallSnapshot {
  _toolTimers?: Record<string, number>;
}

export type ChatPartMutationStoreAccess = Pick<
  ChatPartStore,
  | 'addPartToHandle'
  | 'appendToMarkdownHandle'
  | 'appendToThinkingHandle'
  | 'completeThinkingHandle'
  | 'getPartsForHandle'
  | 'patchToolCallForHandle'
  | 'updateToolCallForHandle'
  | 'updateSubagentForHandle'
  | 'updateStateForHandle'
  | 'upsertStateForHandle'
  | 'upsertTerminalForHandle'
  | 'postProcessMarkdownForHandle'
  | 'updateLatestRunningSubagentForHandle'
>;

type ChatPartMutationStateUpdate = {
  state: StatePart['state'];
  text: string;
  progress?: number;
  kind?: StatePart['kind'];
  metadata?: Record<string, unknown>;
};

export class ChatPartMutationBridge {
  constructor(
    private readonly store: ChatPartMutationStoreAccess,
    private readonly getCurrentStoreHandle: () => ChatPartStoreReadableHandle | null,
  ) {}

  currentStoreHandle(): ChatPartStoreResponseHandle {
    return this.currentResponseHandle();
  }

  addPartToCurrentMessage(part: ChatPart): number {
    return this.store.addPartToHandle(this.currentStoreHandle(), part);
  }

  addTerminalPartForToolCall(toolCallId: string, part: TerminalPart): number {
    return this.store.upsertTerminalForHandle(this.findToolCallHandle(toolCallId), part);
  }

  appendMarkdownToCurrentMessage(text: string): number {
    return this.store.appendToMarkdownHandle(this.currentStoreHandle(), text);
  }

  appendThinkingToCurrentMessage(text: string): number {
    return this.store.appendToThinkingHandle(this.currentStoreHandle(), text);
  }

  completeThinkingOnCurrentMessage(): void {
    this.store.completeThinkingHandle(this.currentStoreHandle());
  }

  updateToolCall(
    toolCallId: string,
    state: ToolCallPart['state'],
    text: string,
  ): void {
    this.store.updateToolCallForHandle(this.findToolCallHandle(toolCallId), toolCallId, state, text);
  }

  patchToolCall(
    toolCallId: string,
    patch: Parameters<ChatPartStore['patchToolCallForHandle']>[2],
  ): boolean {
    return this.store.patchToolCallForHandle(this.findToolCallHandle(toolCallId), toolCallId, patch);
  }

  getToolCall(toolCallId: string): ToolCallPart | null {
    const handle = this.findToolCallHandle(toolCallId);
    const parts = this.store.getPartsForHandle(handle);
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index];
      if (part.type === 'tool_call' && part.toolCallId === toolCallId) {
        return part;
      }
    }
    return null;
  }

  updateSubagent(
    toolCallId: string,
    state: SubagentToolCallSnapshot['state'],
    resultText: string,
  ): void {
    this.store.updateSubagentForHandle(this.findToolCallHandle(toolCallId), toolCallId, state, resultText);
  }

  updateState(
    stateId: string,
    next: ChatPartMutationStateUpdate,
  ): void {
    this.store.updateStateForHandle(this.currentStoreHandle(), stateId, next);
  }

  upsertStateOnCurrentMessage(
    stateId: string,
    next: ChatPartMutationStateUpdate,
  ): void {
    this.store.upsertStateForHandle(this.currentStoreHandle(), stateId, next);
  }

  postProcessMarkdownOnCurrentMessage(): void {
    this.store.postProcessMarkdownForHandle(this.currentStoreHandle());
  }

  updateLatestRunningSubagentOnCurrentMessage(
    update: (part: MutableSubagentPart) => MutableSubagentPart,
  ): MutableSubagentPart | null {
    return this.store.updateLatestRunningSubagentForHandle(this.currentStoreHandle(), update);
  }

  private findToolCallHandle(toolCallId: string): ChatPartStoreReadableHandle | null {
    void toolCallId;
    return this.currentResponseHandle();
  }

  private currentResponseHandle(): ChatPartStoreResponseHandle {
    const handle = this.getCurrentStoreHandle() ?? null;
    if (isResponseHandle(handle)) {
      return handle;
    }

    throw new Error('Live transcript part writes require a canonical response handle.');
  }
}

function isResponseHandle(handle: ChatPartStoreReadableHandle | null): handle is ChatPartStoreResponseHandle {
  return !!handle
    && typeof handle === 'object'
    && 'kind' in handle
    && handle.kind === 'response'
    && typeof handle.turnId === 'string'
    && handle.turnId.trim().length > 0;
}
