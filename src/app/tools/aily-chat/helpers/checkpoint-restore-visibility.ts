import type { ChatVisibleTranscriptDialogItem } from '../core/chat-visible-transcript-model';
import type { WorkspaceCheckpointPresentationMode } from '../services/edit-checkpoint.service';

export interface CheckpointRestoreSurface {
  readonly visible: true;
  readonly presentationMode: WorkspaceCheckpointPresentationMode;
  readonly statusLabelKey: 'AILY_CHAT.TURN_RESTORE_STATUS';
  readonly actionLabelKey: 'AILY_CHAT.TURN_RESTORE_REAPPLY';
  readonly actionTitle: string;
}

export function applyCheckpointRestoreVisibility(
  dialogItems: readonly ChatVisibleTranscriptDialogItem[],
  _canShowCheckpointRestore: boolean,
): ChatVisibleTranscriptDialogItem[] {
  if (dialogItems.length === 0) {
    return [];
  }

  let changed = false;
  const normalizedItems = dialogItems.map(item => {
    if (!item.showCheckpointRestore) {
      return item;
    }

    changed = true;
    return {
      ...item,
      showCheckpointRestore: false,
    };
  });

  return changed ? normalizedItems : [...dialogItems];
}

export function buildCheckpointRestoreSurface(
  canRedoCheckpoint: boolean,
  presentationMode: WorkspaceCheckpointPresentationMode,
): CheckpointRestoreSurface | null {
  if (!canRedoCheckpoint || (presentationMode !== 'git' && presentationMode !== 'timeline')) {
    return null;
  }

  return {
    visible: true,
    presentationMode,
    statusLabelKey: 'AILY_CHAT.TURN_RESTORE_STATUS',
    actionLabelKey: 'AILY_CHAT.TURN_RESTORE_REAPPLY',
    actionTitle: '重新应用已撤销的工作区更改和聊天',
  };
}
