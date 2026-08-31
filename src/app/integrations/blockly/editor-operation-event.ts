export type EditorOperationPhase =
  | 'queued'
  | 'started'
  | 'progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

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
