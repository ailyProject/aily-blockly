import type { IDialog } from '../core/host-api';
import type { ResourceItem } from '../core/chat-types';
import type { DialogTurnContext } from '../core/user-turn-action-target';
import { pickFileResources, pickFolderResource } from './chat-resource-picker';

interface EditResourceTargetLike {
  addEditResource(item: ResourceItem): void;
}

export type EditResourceTargetRef = DialogTurnContext;

export class ChatEditResourceShellCoordinator {
  constructor(
    private readonly deps: {
      getDialog: () => Pick<IDialog, 'selectFiles'> | null | undefined;
      resolveTarget: (target: EditResourceTargetRef) => EditResourceTargetLike | undefined;
    },
  ) {}

  async addFile(targetRef: EditResourceTargetRef): Promise<void> {
    const dialog = this.deps.getDialog();
    if (!dialog) {
      return;
    }

    const items = await pickFileResources(dialog);
    if (items.length === 0) {
      return;
    }

    const target = this.deps.resolveTarget(targetRef);
    if (!target) {
      return;
    }

    for (const item of items) {
      target.addEditResource(item);
    }
  }

  async addFolder(targetRef: EditResourceTargetRef): Promise<void> {
    const dialog = this.deps.getDialog();
    if (!dialog) {
      return;
    }

    const item = await pickFolderResource(dialog);
    if (!item) {
      return;
    }

    const target = this.deps.resolveTarget(targetRef);
    if (!target) {
      return;
    }

    target.addEditResource(item);
  }
}