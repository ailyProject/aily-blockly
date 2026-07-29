import type { RenderEvent } from 'aily-lex/browser';
import type { IAgentLifecycle, IChatServiceAccess } from '../core/chat-context';
import type { LexHostSyncBridge } from './lex-host-sync-bridge';

/** Narrow context: only the mutable counter needed by side effects. */
type SideEffectContext = Pick<IAgentLifecycle, 'toolCallingIteration'>
  & Pick<IChatServiceAccess, 'contextBudgetService'>;

/**
 * Handles non-rendering side effects triggered by RenderEvents.
 *
 * Extracted from LexRenderEventBridge so that the bridge is a pure
 * RenderEvent → ChatPartStore mapper, and side effects (file-edit
 * turn counting and todo sync live in a dedicated unit.
 */
export class LexSideEffectHandler {
  constructor(
    private readonly ctx: SideEffectContext,
    private readonly hostSyncBridge: LexHostSyncBridge,
  ) {}

  /** Process side effects for a single RenderEvent. */
  processEvent(event: RenderEvent): void {
    switch (event.type) {
      case 'turn_begin':
        this.ctx.toolCallingIteration++;
        break;

      case 'todo_update':
        // Sync todos to blockly's todo storage
        this.hostSyncBridge.applyLexTodos(
          event.sessionId,
          event.items.map(item => ({
            id: item.id,
            title: item.title,
            status: item.status,
          })),
        );
        break;

      case 'session_meta':
        if (event.kind === 'context_budget' && typeof event.maxTokens === 'number' && typeof event.usedTokens === 'number') {
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
        }
        break;

      default:
        break;
    }
  }
}
