import { scheduleBrowserTask } from './browserTaskScheduler';

export type EditorOperationPhase = 'queued' | 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';

export interface EditorOperationEvent {
  readonly type: 'editor_operation_progress';
  readonly operationId: string;
  readonly operationKind: string;
  readonly phase: EditorOperationPhase;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
  readonly label: string;
  readonly summary?: string;
  readonly detail?: string;
  readonly progress?: number;
  readonly queueSize?: number;
  readonly durationMs?: number;
  readonly timestamp: number;
}

export interface EditorOperationEventSink {
  reportEditorOperationEvent?(event: EditorOperationEvent): void | Promise<void>;
}

export interface ToolCallProgressEmitterOptions {
  readonly emitEvent?: (event: unknown) => void;
  readonly trace?: unknown;
  readonly forwardTo?: EditorOperationEventSink;
  readonly batchProgress?: boolean;
  readonly progressBatchMs?: number;
}

function isRunningPhase(phase: EditorOperationPhase): boolean {
  return phase === 'queued' || phase === 'started' || phase === 'progress';
}

function defaultSummary(event: EditorOperationEvent): string {
  switch (event.phase) {
    case 'queued':
      return `${event.label} queued`;
    case 'started':
      return `${event.label} started`;
    case 'completed':
      return `${event.label} completed`;
    case 'failed':
      return `${event.label} failed`;
    case 'cancelled':
      return `${event.label} cancelled`;
    case 'progress':
    default:
      return event.label;
  }
}

export function toToolCallProgressPayload(event: EditorOperationEvent): Record<string, unknown> {
  return {
    kind: 'editor_operation',
    operationId: event.operationId,
    operationKind: event.operationKind,
    phase: event.phase,
    label: event.label,
    summary: event.summary || defaultSummary(event),
    detail: event.detail,
    progress: event.progress,
    queueSize: event.queueSize,
    durationMs: event.durationMs,
    status: event.phase,
    running: isRunningPhase(event.phase),
  };
}

function isTerminalPhase(phase: EditorOperationPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled';
}

function getRouteKey(event: EditorOperationEvent): string {
  return [
    event.sessionId || '',
    event.turnId || '',
    event.toolCallId || '',
    event.operationId,
  ].join('\u0000');
}

export interface EditorOperationEventBusOptions {
  readonly downstream: EditorOperationEventSink;
  readonly batchMs?: number;
}

export class EditorOperationEventBus implements EditorOperationEventSink {
  private readonly pending = new Map<string, EditorOperationEvent>();
  private flushScheduled = false;

  constructor(private readonly options: EditorOperationEventBusOptions) {}

  async reportEditorOperationEvent(event: EditorOperationEvent): Promise<void> {
    const routeKey = getRouteKey(event);
    if (isTerminalPhase(event.phase)) {
      await this.flushRoute(routeKey);
      await this.emit(event);
      return;
    }

    this.pending.set(routeKey, event);
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    this.flushScheduled = false;
    const events = Array.from(this.pending.values());
    this.pending.clear();
    for (const event of events) {
      await this.emit(event);
    }
  }

  private async flushRoute(routeKey: string): Promise<void> {
    const pending = this.pending.get(routeKey);
    if (!pending) {
      return;
    }
    this.pending.delete(routeKey);
    await this.emit(pending);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    scheduleBrowserTask(() => {
      void this.flush().catch(error => {
        console.warn('[EditorOperationEventBus] flush failed:', error);
      });
    }, this.options.batchMs ?? 16);
  }

  private async emit(event: EditorOperationEvent): Promise<void> {
    try {
      await this.options.downstream.reportEditorOperationEvent?.(event);
    } catch (error) {
      console.warn('[EditorOperationEventBus] downstream failed:', error);
    }
  }
}

function createImmediateToolCallProgressEditorOperationSink(
  options: ToolCallProgressEmitterOptions,
): EditorOperationEventSink {
  return {
    async reportEditorOperationEvent(event: EditorOperationEvent): Promise<void> {
      await options.forwardTo?.reportEditorOperationEvent?.(event);
      if (!options.emitEvent || !event.toolCallId) {
        return;
      }
      options.emitEvent({
        type: 'tool_call_progress',
        toolCallId: event.toolCallId,
        data: toToolCallProgressPayload(event),
        timestamp: event.timestamp,
        ...(options.trace ? { trace: options.trace } : {}),
      });
    },
  };
}

export function createToolCallProgressEditorOperationSink(
  options: ToolCallProgressEmitterOptions,
): EditorOperationEventSink {
  const downstream = createImmediateToolCallProgressEditorOperationSink(options);
  if (options.batchProgress === false) {
    return downstream;
  }
  return new EditorOperationEventBus({
    downstream,
    batchMs: options.progressBatchMs,
  });
}
