export interface ContinuationStopReasonPresentation {
  readonly label: string;
  readonly detail?: string;
  readonly isBehaviorStop: boolean;
}

const HARD_STOP_REASON_MESSAGE_MAP: Record<string, string> = {
  interaction_round_limit_exceeded: 'Round limit reached.',
  interaction_tool_call_budget_exceeded: 'Raw tool call budget reached.',
  interaction_compute_budget_exceeded: 'Execution budget reached.',
  interaction_wall_clock_budget_exceeded: 'Wall-clock budget reached.',
  upstream_error: 'Upstream error stopped the execution.',
};

const BEHAVIOR_STOP_REASON_MAP: Record<string, Omit<ContinuationStopReasonPresentation, 'isBehaviorStop'>> = {
  no_progress_loop_detected: {
    label: 'No-progress loop detected',
    detail: 'The current execution chain was stopped after repeated no-progress rounds. Send continue to start a new execution.',
  },
  tool_thrash_detected: {
    label: 'Tool thrash detected',
    detail: 'The current execution chain was stopped after repeated identical tool-call/result cycles. Send continue to start a new execution.',
  },
  repetition_loop_detected: {
    label: 'Repetition loop detected',
    detail: 'The current execution chain was stopped after repeated text or pending-state loops. Send continue to start a new execution.',
  },
};

export function getContinuationStopReasonPresentation(reason: string | undefined): ContinuationStopReasonPresentation | undefined {
  if (!reason) {
    return undefined;
  }

  const mapped = BEHAVIOR_STOP_REASON_MAP[reason];
  if (!mapped) {
    return {
      label: reason,
      isBehaviorStop: false,
    };
  }

  return {
    ...mapped,
    isBehaviorStop: true,
  };
}

export function formatContinuationStopReason(reason: string | undefined): string | undefined {
  const presentation = getContinuationStopReasonPresentation(reason);
  if (!presentation) {
    return undefined;
  }
  return presentation.label === reason
    ? presentation.label
    : `${presentation.label} (${reason})`;
}

export function getContinuationHardStopReasonMessage(reason: string | undefined): string | undefined {
  if (!reason) {
    return undefined;
  }

  return HARD_STOP_REASON_MESSAGE_MAP[reason];
}

export function formatContinuationHardStopReason(reason: string | undefined): string | undefined {
  if (!reason) {
    return undefined;
  }

  const message = getContinuationHardStopReasonMessage(reason);
  return message
    ? `${message} (${reason})`
    : reason;
}