import {
  createBrowserFrameBudget,
  yieldToBrowserFrame,
  type BrowserFrameBudgetController,
} from './browserTaskScheduler';
import type { EditorOperationEvent, EditorOperationEventSink, EditorOperationPhase } from './editorOperationEvents';
import { ChatPerformanceTracer } from '../services/chat-perf-tracer';

export type BlocklyEditorOperationPhase = EditorOperationPhase;
export type BlocklyEditorOperationProgress = EditorOperationEvent;
export type BlocklyEditorOperationProgressSink = EditorOperationEventSink;

export interface BlocklyEditorOperationProgressUpdate {
  readonly summary?: string;
  readonly detail?: string;
  readonly progress?: number;
}

export type BlocklyEditorOperationProgressReporter = (
  update: BlocklyEditorOperationProgressUpdate,
) => Promise<void>;

export interface BlocklyEditorOperationContext {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
  readonly signal?: AbortSignal;
  readonly isStale?: () => boolean;
  readonly progressSink?: EditorOperationEventSink;
  readonly runOutsideAngular?: <T>(operation: () => Promise<T> | T) => Promise<T> | T;
  readonly editorFrameBudget?: BrowserFrameBudgetController;
}

export interface BlocklyEditorOperationExecutionContext {
  readonly frameBudget: BrowserFrameBudgetController;
  checkpoint(label?: string): Promise<void>;
}

let nextOperationSeq = 1;
const PROGRESS_DETAIL_LIMIT = 180;

function createOperationId(): string {
  return `blockly-editor-op-${Date.now().toString(36)}-${nextOperationSeq++}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'AbortError' || /cancelled|canceled|aborted/i.test(error.message);
}

function createCancellationError(): Error {
  const error = new Error('Editor operation cancelled');
  error.name = 'AbortError';
  return error;
}

function createEditorOperationFrameBudget(kind: string, label: string): BrowserFrameBudgetController {
  return createBrowserFrameBudget({
    budgetMs: 6,
    maxContinuousMs: 18,
    onYield: info => {
      ChatPerformanceTracer.increment('editor_operation.frame_budget.yield');
      ChatPerformanceTracer.recordDuration(
        'editor_operation_frame_budget_elapsed',
        info.elapsedMs,
        `${kind}:${label}:${info.label ?? 'checkpoint'}`,
        { slowThresholdMs: 12 },
      );
    },
  });
}

function compactProgressDetail(detail: string | undefined): string | undefined {
  if (!detail || detail.length <= PROGRESS_DETAIL_LIMIT) {
    return detail;
  }
  return `${detail.slice(0, PROGRESS_DETAIL_LIMIT - 1)}…`;
}

function normalizeProgress(progress: number | undefined): number | undefined {
  if (progress === undefined || !Number.isFinite(progress)) {
    return undefined;
  }
  const clamped = Math.min(1, Math.max(0, progress));
  return Math.round(clamped * 1000) / 1000;
}

function isOperationStale(context?: BlocklyEditorOperationContext): boolean {
  try {
    return context?.isStale?.() === true;
  } catch {
    return true;
  }
}

function throwIfOperationCancelled(context?: BlocklyEditorOperationContext): void {
  if (context?.signal?.aborted || isOperationStale(context)) {
    throw createCancellationError();
  }
}

export class BlocklyEditorOperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private pendingCount = 0;

  enqueue<T>(
    kind: string,
    label: string,
    run: (
      reportProgress: BlocklyEditorOperationProgressReporter,
      executionContext: BlocklyEditorOperationExecutionContext,
    ) => Promise<T> | T,
    context?: BlocklyEditorOperationContext,
  ): Promise<T> {
    const operationId = createOperationId();
    const queuedAt = Date.now();
    this.pendingCount += 1;
    void this.emit({
      type: 'editor_operation_progress',
      operationId,
      operationKind: kind,
      label,
      phase: 'queued',
      sessionId: context?.sessionId,
      turnId: context?.turnId,
      toolCallId: context?.toolCallId,
      timestamp: queuedAt,
      queueSize: Math.max(0, this.pendingCount - 1),
    }, context);

    const task = this.tail.then(async () => {
      const startedAt = Date.now();
      await yieldToBrowserFrame();
      const frameBudget = context?.editorFrameBudget ?? createEditorOperationFrameBudget(kind, label);
      frameBudget.reset();
      const executionContext: BlocklyEditorOperationExecutionContext = {
        frameBudget,
        checkpoint: async checkpointLabel => {
          throwIfOperationCancelled(context);
          await frameBudget.checkpoint(checkpointLabel);
          throwIfOperationCancelled(context);
        },
      };

      try {
        throwIfOperationCancelled(context);

        await this.emit({
          type: 'editor_operation_progress',
          operationId,
          operationKind: kind,
          label,
          phase: 'started',
          sessionId: context?.sessionId,
          turnId: context?.turnId,
          toolCallId: context?.toolCallId,
          timestamp: startedAt,
          queueSize: Math.max(0, this.pendingCount - 1),
        }, context);

        const reportProgress: BlocklyEditorOperationProgressReporter = update => {
          throwIfOperationCancelled(context);
          return this.emit({
            type: 'editor_operation_progress',
            operationId,
            operationKind: kind,
            label,
            phase: 'progress',
            sessionId: context?.sessionId,
            turnId: context?.turnId,
            toolCallId: context?.toolCallId,
            summary: update.summary,
            detail: compactProgressDetail(update.detail),
            progress: normalizeProgress(update.progress),
            timestamp: Date.now(),
            queueSize: Math.max(0, this.pendingCount - 1),
          }, context);
        };

        const executeOperation = () => ChatPerformanceTracer.runWithSurface(
          'editor_operation',
          () => run(reportProgress, executionContext),
          `${kind}:${label}`,
        );
        const result = await (context?.runOutsideAngular
          ? context.runOutsideAngular(executeOperation)
          : executeOperation());
        throwIfOperationCancelled(context);
        const completedAt = Date.now();
        await this.emit({
          type: 'editor_operation_progress',
          operationId,
          operationKind: kind,
          label,
          phase: 'completed',
          sessionId: context?.sessionId,
          turnId: context?.turnId,
          toolCallId: context?.toolCallId,
          timestamp: completedAt,
          durationMs: completedAt - startedAt,
          queueSize: Math.max(0, this.pendingCount - 1),
        }, context);
        return result;
      } catch (error) {
        const completedAt = Date.now();
        const cancelled = isCancellationError(error, context?.signal);
        await this.emit({
          type: 'editor_operation_progress',
          operationId,
          operationKind: kind,
          label,
          phase: cancelled ? 'cancelled' : 'failed',
          sessionId: context?.sessionId,
          turnId: context?.turnId,
          toolCallId: context?.toolCallId,
          detail: describeError(error),
          timestamp: completedAt,
          durationMs: completedAt - startedAt,
          queueSize: Math.max(0, this.pendingCount - 1),
        }, context);
        throw error;
      } finally {
        this.pendingCount = Math.max(0, this.pendingCount - 1);
      }
    });

    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async emit(
    progress: EditorOperationEvent,
    context?: BlocklyEditorOperationContext,
  ): Promise<void> {
    try {
      await context?.progressSink?.reportEditorOperationEvent?.(progress);
    } catch (error) {
      console.warn('[BlocklyEditorOperationQueue] progress sink failed:', error);
    }
  }
}

const sharedBlocklyEditorOperationQueue = new BlocklyEditorOperationQueue();

export function getSharedBlocklyEditorOperationQueue(): BlocklyEditorOperationQueue {
  return sharedBlocklyEditorOperationQueue;
}
