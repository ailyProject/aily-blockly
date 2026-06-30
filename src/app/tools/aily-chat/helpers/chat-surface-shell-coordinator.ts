import type { ResourceItem } from '../core/chat-types';
import type { DialogTurnContext } from '../core/user-turn-action-target';

export const DEFAULT_AILY_USAGE_GUIDE_URL = 'https://aily.pro/doc/ai-usage-guide';

export type EditTurnTarget = DialogTurnContext;

export interface EditAndResendEvent {
  target: DialogTurnContext;
  newText: string;
  resources: ResourceItem[];
}

export class ChatSurfaceShellCoordinator {
  constructor(
    private readonly callbacks: {
      editAndResendFromTurn: (target: EditTurnTarget, newText: string, resources: ResourceItem[]) => Promise<void>;
      closeTool: (toolId: string) => void;
      openUrl: (url: string) => void;
    },
  ) {}

  async editAndResend(event: EditAndResendEvent): Promise<void> {
    await this.callbacks.editAndResendFromTurn(
      event.target,
      event.newText,
      event.resources,
    );
  }

  close(toolId: string = 'aily-chat'): void {
    this.callbacks.closeTool(toolId);
  }

  openUrl(url: string = DEFAULT_AILY_USAGE_GUIDE_URL): void {
    this.callbacks.openUrl(url);
  }
}