import type { IAgentLifecycle, IChatServiceAccess } from '../core/chat-context';
import type { PartEventProcessor } from '../core/part-event-processor';
import { isTerminalSessionToolName } from '../core/tool-name-normalizer';
import type { LexHostSyncBridge } from './lex-host-sync-bridge';

export type LexRuntimePartProcessor = Pick<
  PartEventProcessor,
  | 'processTextDelta'
  | 'processThinking'
  | 'processToolCallStart'
  | 'processToolCallProgress'
  | 'processToolCallEnd'
  | 'processTerminalResult'
  | 'processError'
>;

export type LexRuntimeHostSyncAccess = Pick<
  LexHostSyncBridge,
  'recordFileToolEdit' | 'applyTodoStateEvent'
>;

/** Narrow context: toolCallingIteration + contextBudgetService */
export type LexRuntimeEventContext = Pick<IAgentLifecycle, 'toolCallingIteration'> & Pick<IChatServiceAccess, 'contextBudgetService'>;
type LexRuntimeLifecycleAccess = {
  closeNativeThinking(): void;
  startNativeThinking(): void;
};

const GENERIC_RUNTIME_ERROR_MESSAGE = 'Sorry, something went wrong.';

export class LexRuntimeEventBridge {
  constructor(
    private readonly ctx: LexRuntimeEventContext,
    private readonly partProcessor: LexRuntimePartProcessor,
    private readonly hostSyncBridge: LexRuntimeHostSyncAccess,
    private readonly messageLifecycleBridge: LexRuntimeLifecycleAccess,
  ) {}

  processEvent(event: any): boolean {
    switch (event.type) {
      case 'text_delta': {
        this.messageLifecycleBridge.closeNativeThinking();
        this.partProcessor.processTextDelta(event.text);
        return true;
      }

      case 'thinking':
        this.messageLifecycleBridge.startNativeThinking();
        this.partProcessor.processThinking(event.text);
        return true;

      case 'tool_call_start': {
        this.messageLifecycleBridge.closeNativeThinking();
        this.partProcessor.processToolCallStart(event.toolCallId, event.toolName, event.input);
        this.hostSyncBridge.recordFileToolEdit(event.toolName, event.input);
        return true;
      }

      case 'tool_call_progress':
        this.partProcessor.processToolCallProgress(event.toolCallId, event.data);
        return true;

      case 'tool_call_end': {
        this.partProcessor.processToolCallEnd(event.toolCallId, event.toolName, event.result);

        if (isTerminalSessionToolName(event.toolName)) {
          this.partProcessor.processTerminalResult(event.toolCallId, event.result);
        }
        return true;
      }

      case 'turn_start':
        this.ctx.toolCallingIteration++;
        return true;

      case 'turn_end':
        return true;

      case 'error':
        this.partProcessor.processError(GENERIC_RUNTIME_ERROR_MESSAGE);
        return true;

      case 'context_budget':
        this.ctx.contextBudgetService?.applyLexBudgetEvent(
          event.maxTokens,
          event.usedTokens,
          {
            systemTokens: event.systemTokens,
            baseSystemTokens: event.baseSystemTokens,
            instructionTokens: event.instructionTokens,
            skillTokens: event.skillTokens,
            toolsTokens: event.toolsTokens,
            toolSourceTokens: event.toolSourceTokens,
            messagesTokens: event.messagesTokens,
            toolResultsTokens: event.toolResultsTokens,
            usagePercent: event.usagePercent,
            compressionThreshold: event.compressionThreshold,
            summarizationThreshold: event.summarizationThreshold,
            messageCount: event.messageCount,
          },
        );
        return true;

      case 'todo_state':
        this.hostSyncBridge.applyTodoStateEvent(event);
        return true;

      default:
        return false;
    }
  }
}
