import type { IMenuItem } from '../../../configs/menu.config';

import { resolveChatSurfaceModeId } from '../core/chat-mode';
import {
  CHAT_CUSTOM_AGENT_EDIT_ACTION_ID,
  CHAT_CUSTOM_AGENT_VIEW_ACTION_ID,
  CHAT_PICKER_CONFIGURE_CUSTOM_AGENTS_ACTION_ID,
} from './chat-configure-custom-agents-action';
import type { ModelConfig } from '../services/chat.service';

interface MenuManagerLike {
  showMode: boolean;
  showPermissionMenu: boolean;
  showModelMenu: boolean;
  toggleModeMenu(event: MouseEvent, modeItems?: IMenuItem[]): void;
  togglePermissionMenu(event: MouseEvent, permissionItems: IMenuItem[]): void;
  toggleModelMenu(event: MouseEvent, modelItems: IMenuItem[]): void;
}

interface ChatViewStateLike {
  closeSessionPicker(): void;
}

function isSameModelSelection(left: ModelConfig | null | undefined, right: ModelConfig | null | undefined): boolean {
  return left?.model === right?.model
    && left?.presetId === right?.presetId
    && left?.reasoningEffort === right?.reasoningEffort;
}

export class ChatSwitchShellCoordinator {
  constructor(
    private readonly deps: {
      menuManager: MenuManagerLike;
      viewState: ChatViewStateLike;
      getCurrentMode: () => string | undefined;
      getCurrentModeId: () => string | undefined;
      getCurrentCustomAgentTarget: () => string | undefined;
      getCurrentModel: () => ModelConfig | null | undefined;
    },
    private readonly callbacks: {
      switchToMode: (mode: string) => void | Promise<void>;
      switchToCustomAgent: (selection: { readonly modeId?: string; readonly customAgentTarget?: string }) => void | Promise<void>;
      configureCustomAgents: () => void | Promise<void>;
      openCustomAgentSource?: (
        source: {
          readonly id?: string;
          readonly uri?: string;
          readonly source?: string;
          readonly name?: string;
          readonly target?: string;
        },
        intent: 'view' | 'edit',
      ) => boolean | void | Promise<boolean | void>;
      updatePermissionPreset: (preset: string) => void | Promise<void>;
      switchToModel: (model: ModelConfig) => void | Promise<void>;
      switchToModelConfiguration: (
        model: ModelConfig,
        update: { key: string; value: unknown },
      ) => void | Promise<void>;
    },
  ) {}

  toggleModeMenu(event: MouseEvent, modeItems: IMenuItem[] = []): void {
    this.deps.viewState.closeSessionPicker();
    this.deps.menuManager.toggleModeMenu(event, modeItems);
  }

  toggleModelMenu(event: MouseEvent, modelItems: IMenuItem[]): void {
    this.deps.viewState.closeSessionPicker();
    this.deps.menuManager.toggleModelMenu(event, modelItems);
  }

  togglePermissionMenu(event: MouseEvent, permissionItems: IMenuItem[]): void {
    this.deps.viewState.closeSessionPicker();
    this.deps.menuManager.togglePermissionMenu(event, permissionItems);
  }

  modeMenuClick(item: IMenuItem): void {
    this.deps.menuManager.showMode = false;

    if (item.action === CHAT_PICKER_CONFIGURE_CUSTOM_AGENTS_ACTION_ID) {
      void this.callbacks.configureCustomAgents();
      return;
    }

    const customModeId = typeof item.data?.modeId === 'string'
      ? item.data.modeId.trim()
      : '';
    const customAgentTarget = typeof item.data?.customAgentTarget === 'string'
      ? item.data.customAgentTarget.trim()
      : '';

    const builtinModeFromModeId = resolveChatSurfaceModeId(customModeId);
    if (builtinModeFromModeId) {
      if (builtinModeFromModeId !== this.deps.getCurrentMode() || this.needsBuiltinAgentReset(builtinModeFromModeId)) {
        void this.callbacks.switchToMode(builtinModeFromModeId);
      }
      return;
    }

    if (customModeId) {
      const currentModeId = typeof this.deps.getCurrentModeId() === 'string'
        ? this.deps.getCurrentModeId()!.trim()
        : '';
      if (this.deps.getCurrentMode() !== 'agent' || currentModeId !== customModeId) {
        void this.callbacks.switchToCustomAgent({
          modeId: customModeId,
        });
      }
      return;
    }

    if (customAgentTarget) {
      if (this.deps.getCurrentMode() !== 'agent' || this.deps.getCurrentCustomAgentTarget() !== customAgentTarget) {
        void this.callbacks.switchToCustomAgent({
          customAgentTarget,
        });
      }
      return;
    }

    const mode = resolveChatSurfaceModeId(item.data?.mode);
    if (mode && (mode !== this.deps.getCurrentMode() || this.needsBuiltinAgentReset(mode))) {
      void this.callbacks.switchToMode(mode);
    }
  }

  private needsBuiltinAgentReset(nextMode: string): boolean {
    if (nextMode !== 'agent' || this.deps.getCurrentMode() !== 'agent') {
      return false;
    }
    if (this.deps.getCurrentCustomAgentTarget()) {
      return true;
    }
    const currentModeId = typeof this.deps.getCurrentModeId() === 'string'
      ? this.deps.getCurrentModeId()!.trim()
      : '';
    return !!currentModeId && !resolveChatSurfaceModeId(currentModeId);
  }

  modeMenuActionClick(payload: { readonly action?: string; readonly item?: IMenuItem } | IMenuItem): void {
    const action = typeof (payload as { readonly action?: unknown }).action === 'string'
      ? (payload as { readonly action: string }).action
      : '';
    const item = ((payload as { readonly item?: IMenuItem }).item ?? payload) as IMenuItem;

    if (action === CHAT_PICKER_CONFIGURE_CUSTOM_AGENTS_ACTION_ID) {
      this.deps.menuManager.showMode = false;
      void this.callbacks.configureCustomAgents();
      return;
    }

    if (action !== CHAT_CUSTOM_AGENT_VIEW_ACTION_ID && action !== CHAT_CUSTOM_AGENT_EDIT_ACTION_ID) {
      return;
    }

    const source = readCustomAgentSource(item);
    if (!source) {
      return;
    }

    this.deps.menuManager.showMode = false;
    void this.callbacks.openCustomAgentSource?.(
      source,
      action === CHAT_CUSTOM_AGENT_EDIT_ACTION_ID ? 'edit' : 'view',
    );
  }

  modelMenuClick(item: IMenuItem): void {
    this.deps.menuManager.showModelMenu = false;

    if (item.disabled) {
      console.info('[AilyChat][ModelSwitch] ignored disabled menu item', {
        name: item.name,
        action: item.action,
        dataModel: item.data?.model,
      });
      return;
    }

    const model = item.data?.model as ModelConfig | undefined;
    console.info('[AilyChat][ModelSwitch] menu click', {
      name: item.name,
      action: item.action,
      dataModel: model,
      currentModel: this.deps.getCurrentModel(),
    });
    const dataModel = item?.data?.['model'] as { model?: string; presetId?: string; name?: string } | undefined;
    const currentModel = this.deps.getCurrentModel() as { model?: string; presetId?: string; name?: string } | null | undefined;
    console.info(
      `[AilyChat][ModelSwitch] menu click scalar item=${item?.name ?? ''} dataModel=${dataModel?.model ?? ''}/${dataModel?.presetId ?? ''}/${dataModel?.name ?? ''} currentModel=${currentModel?.model ?? ''}/${currentModel?.presetId ?? ''}/${currentModel?.name ?? ''}`,
    );
    const modelConfiguration = item.data?.modelConfiguration as { key?: string; value?: unknown } | undefined;
    const configurationKey = typeof modelConfiguration?.key === 'string'
      ? modelConfiguration.key.trim()
      : '';
    if (model?.model && configurationKey) {
      void this.callbacks.switchToModelConfiguration(model, {
        key: configurationKey,
        value: modelConfiguration?.value,
      });
      return;
    }

    if (model?.model && !isSameModelSelection(model, this.deps.getCurrentModel())) {
      void this.callbacks.switchToModel(model);
    }
  }

  permissionMenuClick(item: IMenuItem): void {
    this.deps.menuManager.showPermissionMenu = false;
    const action = typeof item.action === 'string' ? item.action.trim() : '';
    if (!action) {
      return;
    }

    void this.callbacks.updatePermissionPreset(action);
  }
}

function readCustomAgentSource(item: IMenuItem | null | undefined): {
  readonly id?: string;
  readonly uri?: string;
  readonly source?: string;
  readonly name?: string;
  readonly target?: string;
} | undefined {
  const value = item?.data?.customAgentSource;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const resolved = {
    ...(typeof source['id'] === 'string' && source['id'].trim() ? { id: source['id'].trim() } : {}),
    ...(typeof source['uri'] === 'string' && source['uri'].trim() ? { uri: source['uri'].trim() } : {}),
    ...(typeof source['source'] === 'string' && source['source'].trim() ? { source: source['source'].trim() } : {}),
    ...(typeof source['name'] === 'string' && source['name'].trim() ? { name: source['name'].trim() } : {}),
    ...(typeof source['target'] === 'string' && source['target'].trim() ? { target: source['target'].trim() } : {}),
  };

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}
