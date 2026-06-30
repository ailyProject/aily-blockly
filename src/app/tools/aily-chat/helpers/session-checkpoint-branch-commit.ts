import type { TurnResponseTurn } from 'aily-lex/browser';
import {
  canRedoSessionCheckpointTimeline,
  getSessionCheckpointHiddenTurnResponses,
  getSessionCheckpointVisibleTurnResponses,
  spliceSessionCheckpointTimelineForwardBranch,
  type SessionCheckpointTimelineState,
} from './session-checkpoint-timeline-model';

export interface CommittedSessionCheckpointBranch {
  readonly turnResponses: readonly TurnResponseTurn[];
  readonly checkpointTimelineState: SessionCheckpointTimelineState;
  readonly discardedTurnResponses: readonly TurnResponseTurn[];
}

export function commitSessionCheckpointForwardBranch(
  state: SessionCheckpointTimelineState | null | undefined,
): CommittedSessionCheckpointBranch | null {
  if (!canRedoSessionCheckpointTimeline(state)) {
    return null;
  }

  return {
    turnResponses: getSessionCheckpointVisibleTurnResponses(state),
    checkpointTimelineState: spliceSessionCheckpointTimelineForwardBranch(state),
    discardedTurnResponses: getSessionCheckpointHiddenTurnResponses(state),
  };
}
