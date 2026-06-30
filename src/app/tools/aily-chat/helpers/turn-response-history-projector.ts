import type { TurnResponseTurn } from 'aily-lex/browser';

import {
  TurnResponseHostProjectionBuilder,
  type TurnResponseProjectionHandle,
} from '../core/turn-response-host-projection-builder';
import { getTurnResponseParticipant } from '../core/turn-response-stream-contract';
import type { ChatListItem } from '../services/chat-history.service';
import { ChatViewWriteBridge, type ChatViewWriteBridgeContext } from './chat-view-write-bridge';
import {
  type ChatMessageHandle,
} from './chat-message-handle';

type TurnResponseHistoryProjectorViewWriteAccess = Pick<
  ChatViewWriteBridge,
  'findMessageHandleByTurnId' | 'getMessageHandles' | 'insertAilyPartsMessageHandleAfter' | 'ensureTrailingAilyPartsMessageHandle'
>;

type TurnResponseHistoryProjectorViewWriteContext = ConstructorParameters<typeof ChatViewWriteBridge>[0];

/**
 * Project turn-native response containers back onto the existing host list + partStore view.
 *
 * This keeps the current UI stable while letting history restore move onto the new
 * `TurnResponseTurn[]` container first.
 */
export function projectTurnResponsesToHistory(
  ctx: ChatViewWriteBridgeContext,
  turns: readonly TurnResponseTurn[],
): void {
  const viewWriteContext: TurnResponseHistoryProjectorViewWriteContext = {
    get list() {
      return ctx.list;
    },
    set list(list) {
      ctx.list = list;
    },
    get partStore() {
      return ctx.partStore;
    },
    get viewAdapter() {
      return ctx.viewAdapter;
    },
    get scrollManager() {
      return ctx.scrollManager;
    },
    get invalidateHostRequestGraph() {
      return ctx.invalidateHostRequestGraph;
    },
    get triggerSyncDetectChanges() {
      return ctx.triggerSyncDetectChanges;
    },
    get sessionId() {
      const viewResource = (ctx as { readCurrentViewSessionResource?: () => string | null | undefined })
        .readCurrentViewSessionResource?.();
      return typeof viewResource === 'string' ? viewResource.trim() : '';
    },
    markHistoryDirty: (sessionId) => ctx.markHistoryDirty(sessionId),
    get currentModelName() {
      return ctx.currentModelName;
    },
    get currentMessageSource() {
      return ctx.currentMessageSource;
    },
    get ngZone() {
      return ctx.ngZone;
    },
    markCurrentViewVisibleProjectionOwner: () => ctx.markCurrentViewVisibleProjectionOwner?.(),
    legacyListProjectionBoundary: 'history-import',
  };
  const viewWriteBridge: TurnResponseHistoryProjectorViewWriteAccess = new ChatViewWriteBridge(viewWriteContext);
  const projectionBuilder = new TurnResponseHostProjectionBuilder(ctx.partStore);
  const remainingAilyHandles = viewWriteBridge
    .getMessageHandles('aily')
    .filter(handle => typeof handle.message.turnId === 'string' && handle.message.turnId.length > 0);

  for (const turn of turns) {
    let handle: ChatMessageHandle<ChatListItem>;

    const matchedIndex = turn.turnId
      ? remainingAilyHandles.findIndex(candidate => candidate.message.turnId === turn.turnId)
      : -1;

    if (matchedIndex >= 0) {
      handle = remainingAilyHandles.splice(matchedIndex, 1)[0];
    } else if (turn.turnId) {
      const turnAnchorHandle = viewWriteBridge.findMessageHandleByTurnId(turn.turnId);
      if (turnAnchorHandle) {
        handle = viewWriteBridge.insertAilyPartsMessageHandleAfter(turnAnchorHandle, {
          source: getTurnResponseParticipant(turn.response.participant),
          state: turn.response.status === 'streaming' ? 'doing' : 'done',
          scrollOnCreate: false,
          turnId: turn.turnId,
        });
      } else if (remainingAilyHandles.length > 0) {
        handle = remainingAilyHandles.shift()!;
      } else {
        handle = viewWriteBridge.ensureTrailingAilyPartsMessageHandle({
          source: getTurnResponseParticipant(turn.response.participant),
          state: turn.response.status === 'streaming' ? 'doing' : 'done',
          scrollOnCreate: false,
          forceNew: true,
          turnId: turn.turnId,
        });
      }
    } else if (remainingAilyHandles.length > 0) {
      handle = remainingAilyHandles.shift()!;
    } else {
      handle = viewWriteBridge.ensureTrailingAilyPartsMessageHandle({
        source: getTurnResponseParticipant(turn.response.participant),
        state: turn.response.status === 'streaming' ? 'doing' : 'done',
        scrollOnCreate: false,
        forceNew: true,
        turnId: turn.turnId,
      });
    }

    projectionBuilder.projectTurn(handle, turn);
  }

  if (turns.length > 0) {
    ctx.invalidateHostRequestGraph();
  }
  ctx.triggerSyncDetectChanges();
}

export function syncTurnResponseMessageMeta(
  ctx: Pick<ChatViewWriteBridgeContext, 'partStore'>,
  handle: TurnResponseProjectionHandle<ChatListItem>,
  turn: TurnResponseTurn,
): void {
  new TurnResponseHostProjectionBuilder(ctx.partStore).syncMessageMeta(handle, turn);
}

export function projectTurnResponseToHandle(
  ctx: Pick<ChatViewWriteBridgeContext, 'partStore'>,
  handle: TurnResponseProjectionHandle<ChatListItem>,
  turn: TurnResponseTurn,
  options: { preserveInteractiveState?: boolean } = {},
): void {
  new TurnResponseHostProjectionBuilder(ctx.partStore).projectTurn(handle, turn, {
    preserveInteractiveState: options.preserveInteractiveState,
    syncContent: true,
  });
}
