import type { LexTurnDraft } from './lex-message-lifecycle-bridge';
import type { AgentHandle, RenderEvent, TurnRequest } from 'aily-lex/browser';

const BACKGROUND_SESSION_TRACE_FLAG = 'aily.chat.traceBackgroundSession';

function parseBackgroundSessionTraceFlag(value: unknown): boolean {
  if (value === true || value === 1) {
    return true;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
  }
  return false;
}

function isBackgroundSessionTraceEnabled(): boolean {
  try {
    const runtime = globalThis as Record<string, unknown>;
    if (parseBackgroundSessionTraceFlag(runtime['__AILY_CHAT_TRACE_BACKGROUND_SESSION__'])
      || parseBackgroundSessionTraceFlag(runtime['AILY_CHAT_TRACE_BACKGROUND_SESSION'])) {
      return true;
    }
    return parseBackgroundSessionTraceFlag(globalThis.localStorage?.getItem?.(BACKGROUND_SESSION_TRACE_FLAG));
  } catch {
    return false;
  }
}

function traceBackgroundSessionExecution(event: string, details: Record<string, unknown>): void {
  if (!isBackgroundSessionTraceEnabled()) {
    return;
  }
  // console.info('[AilyChat][bg-session][execution]', event, details);
}

const UNAMBIGUOUS_RENDER_EVENT_TYPES = new Set<string>([
  'markdown_delta',
  'thinking_delta',
  'thinking_complete',
  'tool_call_begin',
  'state_update',
  'background_task_update',
  'todo_update',
  'approval_resolve',
  'error_notice',
  'subagent_begin',
  'subagent_activity',
  'turn_begin',
  'session_meta',
]);

function isUnambiguousRenderEventLike(event: unknown): event is RenderEvent {
  if (typeof event !== 'object' || event === null) {
    return false;
  }
  const type = (event as { type?: unknown }).type;
  return typeof type === 'string' && UNAMBIGUOUS_RENDER_EVENT_TYPES.has(type);
}

type AgentLifecycleAccess = {
  getHandle?(sessionId?: string | null): Pick<AgentHandle, 'chat'> | null;
  getAgent(sessionId?: string | null): { chat(userMessage: string, signal?: AbortSignal, options?: { readonly yieldRequested?: () => boolean; readonly turnId?: string }): AsyncIterable<any> } | null;
  getLex(): { RenderEventEmitter?: new () => {
    process(event: any): readonly RenderEvent[];
    finalize(): readonly RenderEvent[];
  } } | undefined;
};

type TurnStartupAccess = {
  beginMainAgentTurn(
    userMessage: string,
    displayContent?: string,
    requestMetadata?: TurnRequest['metadata'],
    options?: { readonly turnId?: string },
  ): string | undefined;
};

type TurnExecutionAccess = {
  runTurn(agent: { chat(userMessage: string, signal?: AbortSignal, options?: { readonly yieldRequested?: () => boolean; readonly turnId?: string }): AsyncIterable<any> } | null, userMessage: string, options?: { readonly turnId?: string; readonly sessionId?: string }): Promise<void>;
  runTurnWithRenderEvents(source: { chat(message: string, signal?: AbortSignal, options?: { readonly yieldRequested?: () => boolean; readonly turnId?: string }): AsyncIterable<RenderEvent> }, userMessage: string, displayContent?: string, options?: { readonly turnId?: string; readonly sessionId?: string }): Promise<void>;
};

type TurnUiAccess = {
  getCurrentTurnDraft(): LexTurnDraft;
  ensureResponseItem(): void;
  appendLifecycleError(message: string): void;
};

/**
 * Groups the remaining turn-level startup/execution lifecycle entrypoints
 * so LexOwnerFacade can expose owner properties instead of thin method shims.
 */
export class LexTurnRuntimeBridge {
  constructor(
    private readonly agentLifecycleBridge: AgentLifecycleAccess,
    private readonly turnStartupBridge: TurnStartupAccess,
    private readonly turnExecutionBridge: TurnExecutionAccess,
    private readonly uiEventBridge: TurnUiAccess,
  ) {}

  begin(
    userMessage: string,
    displayContent?: string,
    requestMetadata?: TurnRequest['metadata'],
    options?: { readonly turnId?: string },
  ): string | undefined {
    traceBackgroundSessionExecution('runtime-bridge-begin', {
      hasDisplayContent: typeof displayContent === 'string' && displayContent.length > 0,
      hasRequestMetadata: !!requestMetadata,
    });
    return this.turnStartupBridge.beginMainAgentTurn(userMessage, displayContent, requestMetadata, options);
  }

  async run(userMessage: string, displayContent?: string, options: { readonly turnId?: string; readonly sessionId?: string } = {}): Promise<void> {
    const handle = this.agentLifecycleBridge.getHandle?.(options.sessionId) ?? null;
    if (handle) {
      console.info('[AilyChat][LexRuntimePath]', {
        phase: 'turn-run',
        path: 'handle-render-event',
        sessionId: options.sessionId ?? null,
        turnId: options.turnId ?? null,
      });
      traceBackgroundSessionExecution('runtime-bridge-path', {
        path: 'handle-render-event',
      });
      await this.turnExecutionBridge.runTurnWithRenderEvents(handle, userMessage, displayContent, options);
      return;
    }

    const agent = this.agentLifecycleBridge.getAgent(options.sessionId);
    if (!agent) {
      console.warn('[AilyChat][LexRuntimePath]', {
        phase: 'turn-run',
        path: 'no-agent',
        sessionId: options.sessionId ?? null,
        turnId: options.turnId ?? null,
      });
      traceBackgroundSessionExecution('runtime-bridge-path', {
        path: 'no-agent',
      });
      throw new Error(`[AilyChat][TurnOwner] No Lex agent is available for session ${options.sessionId ?? '<active>'}.`);
    }

    // Wrap raw AilyLexAgent into a RenderEventSource using RenderEventEmitter
    const lex = this.agentLifecycleBridge.getLex();
    if (lex?.RenderEventEmitter) {
      console.info('[AilyChat][LexRuntimePath]', {
        phase: 'turn-run',
        path: 'emitter-render-event',
        sessionId: options.sessionId ?? null,
        turnId: options.turnId ?? null,
      });
      traceBackgroundSessionExecution('runtime-bridge-path', {
        path: 'emitter-render-event',
      });
      const RenderEventEmitter = lex.RenderEventEmitter;
      const source = {
        async *chat(
          message: string,
          signal?: AbortSignal,
          options?: { readonly yieldRequested?: () => boolean; readonly turnId?: string },
        ): AsyncIterable<RenderEvent> {
          const emitter = new RenderEventEmitter();
          let eventMode: 'unknown' | 'render' | 'agent' = 'unknown';
          try {
            for await (const rawEvent of agent.chat(message, signal, options)) {
              if (eventMode === 'unknown') {
                eventMode = isUnambiguousRenderEventLike(rawEvent) ? 'render' : 'agent';
                traceBackgroundSessionExecution('emitter-bridge-first-event-shape', {
                  eventMode,
                  rawType: typeof rawEvent === 'object' && rawEvent !== null
                    ? String((rawEvent as { type?: unknown }).type ?? '')
                    : typeof rawEvent,
                });
              }

              if (eventMode === 'render') {
                yield rawEvent;
                continue;
              }

              const renderEvents = emitter.process(rawEvent as any);
              for (const renderEvent of renderEvents) {
                yield renderEvent;
              }
            }
          } finally {
            const finalEvents = emitter.finalize();
            for (const re of finalEvents) {
              yield re;
            }
          }
        },
      };
      await this.turnExecutionBridge.runTurnWithRenderEvents(source, userMessage, displayContent, options);
    } else {
      // Fallback: legacy AgentEvent path
      console.warn('[AilyChat][LexRuntimePath]', {
        phase: 'turn-run',
        path: 'legacy-agent-event',
        sessionId: options.sessionId ?? null,
        turnId: options.turnId ?? null,
      });
      traceBackgroundSessionExecution('runtime-bridge-path', {
        path: 'legacy-agent-event',
      });
      await this.turnExecutionBridge.runTurn(agent, userMessage, options);
    }
  }

  draft(): LexTurnDraft {
    return this.uiEventBridge.getCurrentTurnDraft();
  }

  ensureMessage(): void {
    this.uiEventBridge.ensureResponseItem();
  }

  appendError(message: string): void {
    this.uiEventBridge.appendLifecycleError(message);
  }
}
