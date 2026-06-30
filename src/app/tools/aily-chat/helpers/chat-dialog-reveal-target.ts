import type { ChatRevealTarget } from '../services/scroll-manager.service';
import type { ChatVisibleTranscriptDialogItem } from '../core/chat-visible-transcript-model';

export function resolveChatDialogRevealTargetItemId(
  items: readonly ChatVisibleTranscriptDialogItem[],
  target: ChatRevealTarget,
): string | null {
  switch (target) {
    case 'current-response':
    case 'pending-confirmation':
    case 'pending-question':
    case 'pending-plan-review':
      return findLastDialogItemId(items, item => item.role === 'aily' && (item.isLastAily || item.doing));
    case 'checkpoint-anchor':
      return findLastDialogItemId(items, item => item.role === 'user' && item.showCheckpointRestore)
        ?? findLastDialogItemId(items, item => item.role === 'user' && !!item.turnContext?.turnId);
    default:
      return null;
  }
}

export function resolveChatDialogRevealTargetIndex(
  items: readonly ChatVisibleTranscriptDialogItem[],
  target: ChatRevealTarget,
): number {
  const itemId = resolveChatDialogRevealTargetItemId(items, target);
  return itemId == null
    ? -1
    : items.findIndex(item => item.id === itemId);
}

function findLastDialogItemId(
  items: readonly ChatVisibleTranscriptDialogItem[],
  predicate: (item: ChatVisibleTranscriptDialogItem) => boolean,
): string | null {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) {
      return items[index].id;
    }
  }
  return null;
}
