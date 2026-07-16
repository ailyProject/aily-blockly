import type { DialogTurnContext } from '../core/user-turn-action-target';
import type { ChatSessionBoundaryActionController } from './chat-session-boundary-controller';
import type { EditActionsHelper } from './edit-actions.helper';

export type ChatTaskActionName =
  | 'continue'
  | 'retry'
  | 'regenerate'
  | 'undoEdits'
  | 'redoEdits'
  | 'redoFileEdits'
  | 'keepEdits'
  | 'acceptFile'
  | 'rejectFile'
  | 'voteResponse'
  | 'restoreCheckpoint'
  | 'forkSession'
  | 'newChat'
  | 'dismiss';

export interface ChatTaskActionDetail {
  action?: ChatTaskActionName | string;
  data?: unknown;
  target?: DialogTurnContext | null;
  sessionResource?: string;
  vote?: 0 | 1;
  filePath?: string;
  fileCount?: number;
  totalAdded?: number;
  totalRemoved?: number;
}

export type ChatTaskActionEvent = CustomEvent<ChatTaskActionDetail | undefined>;

interface TaskActionCallbacks {
  continueConversation: () => Promise<void> | void;
  retryLastAction: () => Promise<void> | void;
  newChat: () => Promise<void> | void;
  voteResponse: (target: DialogTurnContext, vote: 0 | 1) => Promise<void> | void;
  warnUnknownAction: (action: string | undefined) => void;
}

/**
 * Routes task action payloads from UI events to the appropriate helpers.
 */
export class ChatTaskActionCoordinator {
  constructor(
    private readonly boundaryActions: ChatSessionBoundaryActionController,
    private readonly editActions: EditActionsHelper,
    private readonly callbacks: TaskActionCallbacks,
  ) {}

  handle(detail?: ChatTaskActionDetail): void {
    const action = detail?.action;

    switch (action) {
      case 'continue':
        void this.callbacks.continueConversation();
        return;
      case 'retry':
        void this.callbacks.retryLastAction();
        return;
      case 'regenerate':
        void this.boundaryActions.regenerateTurn(detail?.target);
        return;
      case 'undoEdits':
        void this.editActions.undoLastEdits();
        return;
      case 'redoEdits':
        void this.boundaryActions.redoEdits(detail?.sessionResource);
        return;
      case 'redoFileEdits':
        void this.editActions.redoEdits();
        return;
      case 'keepEdits':
        this.editActions.onKeepEdits(detail);
        return;
      case 'acceptFile':
        this.editActions.onAcceptFile(detail?.filePath);
        return;
      case 'rejectFile':
        this.editActions.onRejectFile(detail?.filePath);
        return;
      case 'voteResponse':
        if (detail?.target && (detail.vote === 0 || detail.vote === 1)) {
          void this.callbacks.voteResponse(detail.target, detail.vote);
        }
        return;
      case 'restoreCheckpoint':
        if (detail?.target) {
          void this.boundaryActions.restoreCheckpoint(detail.target, detail.sessionResource);
        }
        return;
      case 'forkSession':
        if (detail?.target) {
          void this.boundaryActions.forkSession(detail.target, detail.sessionResource);
        }
        return;
      case 'newChat':
        void this.callbacks.newChat();
        return;
      case 'dismiss':
        return;
      default:
        this.callbacks.warnUnknownAction(action);
    }
  }
}
