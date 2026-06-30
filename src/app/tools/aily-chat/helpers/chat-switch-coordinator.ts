import type {
  IAgentLifecycle,
  IChatServiceAccess,
  IProjectContext,
  ISessionAccess,
} from '../core/chat-context';
import { normalizeAgentIdentifier } from '../core/agent-identifiers';
import {
  resolveChatSurfaceModeId,
} from '../core/chat-mode';
import type { ChatSurfaceModeId } from '../core/chat-mode';
import type { LanguageModelConfigurationUpdate } from '../services/aily-chat-language-models.service';
import type { ModelConfig } from '../services/chat.service';

type ChatSwitchCoordinatorContext = Pick<
  IAgentLifecycle,
  'isWaiting' | '_pendingModelSwitch' | '_pendingModeSwitch' | '_pendingSwitchSessionId'
> & Pick<IProjectContext, 'currentModel' | 'currentMode'>
  & Pick<ISessionAccess, 'chatService' | 'conversationMessages' | 'sessionId'>
  & Pick<IChatServiceAccess, 'contextBudgetService' | 'languageModelsService' | 'message'>;

/**
 * Coordinates model/mode switching and deferred switch application.
 *
 * This is a visible-session selection coordinator only. It must not rebuild or
 * ensure a renderer-local agent; the host/runtime owner reads the saved
 * selection when the next turn starts.
 */
export class ChatSwitchCoordinator {
  constructor(private readonly ctx: ChatSwitchCoordinatorContext) {}

  private readPendingOwnerSessionId(): string | null {
    const sessionId = typeof this.ctx._pendingSwitchSessionId === 'string'
      ? this.ctx._pendingSwitchSessionId.trim()
      : '';
    return sessionId || null;
  }

  private readCurrentSessionId(): string | null {
    const sessionId = typeof this.ctx.chatService.currentSessionId === 'string'
      && this.ctx.chatService.currentSessionId.trim().length > 0
      ? this.ctx.chatService.currentSessionId.trim()
      : typeof this.ctx.sessionId === 'string' && this.ctx.sessionId.trim().length > 0
        ? this.ctx.sessionId.trim()
        : '';
    return sessionId || null;
  }

  private assignPendingSwitch(model: ModelConfig | null, mode: ChatSurfaceModeId | null): void {
    this.ctx._pendingModelSwitch = model;
    this.ctx._pendingModeSwitch = mode;
    this.ctx._pendingSwitchSessionId = (model || mode)
      ? this.readCurrentSessionId()
      : null;
  }

  private getConfigurationModelId(model: ModelConfig | null | undefined): string | undefined {
    const presetId = typeof model?.presetId === 'string' ? model.presetId.trim() : '';
    if (presetId) {
      return presetId;
    }

    const modelId = typeof model?.model === 'string' ? model.model.trim() : '';
    return modelId || undefined;
  }

  private getConfiguredRuntimeModel(model: ModelConfig, update: LanguageModelConfigurationUpdate): ModelConfig {
    if (update.key === 'reasoningEffort' && typeof update.value === 'string') {
      return {
        ...model,
        reasoningEffort: update.value as NonNullable<ModelConfig['reasoningEffort']>,
      };
    }

    return model;
  }

  private getConfigurationSaveErrorMessage(update: LanguageModelConfigurationUpdate): string {
    return update.key === 'reasoningEffort'
      ? '思考深度配置保存失败'
      : '模型配置保存失败';
  }

  private getPendingConfigurationMessage(update: LanguageModelConfigurationUpdate): string {
    return update.key === 'reasoningEffort'
      ? '思考深度将在当前对话完成后切换'
      : '模型配置将在当前对话完成后生效';
  }

  private isSameModelSelection(model: ModelConfig): boolean {
    return model.model === this.ctx.currentModel?.model
      && model.presetId === this.ctx.currentModel?.presetId
      && model.reasoningEffort === this.ctx.currentModel?.reasoningEffort;
  }

  private shouldRefreshLocalEstimate(): boolean {
    const snapshot = this.ctx.contextBudgetService?.getSnapshot();
    return !snapshot || snapshot.currentTokens <= 0 || snapshot.maxContextTokens <= 0;
  }

  private refreshLocalEstimateIfNeeded(): void {
    if (!this.shouldRefreshLocalEstimate()) {
      return;
    }

    this.ctx.contextBudgetService?.refreshLocalEstimate(this.ctx.conversationMessages);
  }

  async switchToModel(model: ModelConfig): Promise<void> {
    console.info('[AilyChat][ModelSwitch] switchToModel called', {
      requestedModel: model,
      currentModel: this.ctx.currentModel,
      isWaiting: this.ctx.isWaiting,
    });
    const currentModel = this.ctx.currentModel as { model?: string; presetId?: string; name?: string } | null | undefined;
    console.info(
      `[AilyChat][ModelSwitch] switchToModel scalar requested=${model?.model ?? ''}/${model?.presetId ?? ''}/${model?.name ?? ''} current=${currentModel?.model ?? ''}/${currentModel?.presetId ?? ''}/${currentModel?.name ?? ''} isWaiting=${this.ctx.isWaiting}`,
    );

    if (this.isSameModelSelection(model)) {
      console.info('[AilyChat][ModelSwitch] skipped because selection is unchanged', {
        requestedModel: model,
        currentModel: this.ctx.currentModel,
      });
      return;
    }

    if (this.ctx.isWaiting) {
      if (this.ctx.chatService.saveChatModel(model) === false) {
        return;
      }
      this.assignPendingSwitch(model, null);
      this.ctx.message.info('模型将在当前对话完成后切换');
      return;
    }

    await this.doSwitchModel(model);
  }

  async switchToReasoningEffort(reasoningEffort: NonNullable<ModelConfig['reasoningEffort']>): Promise<void> {
    const currentModel = this.ctx.currentModel;
    if (!currentModel) {
      return;
    }

    await this.switchToModelConfiguration(currentModel, {
      key: 'reasoningEffort',
      value: reasoningEffort,
    });
  }

  async switchToModelConfiguration(model: ModelConfig, update: LanguageModelConfigurationUpdate): Promise<void> {
    const key = typeof update?.key === 'string' ? update.key.trim() : '';
    if (!model || !key) {
      return;
    }

    const normalizedUpdate: LanguageModelConfigurationUpdate = {
      key,
      value: update.value,
    };

    const modelId = this.getConfigurationModelId(model);
    if (!modelId) {
      return;
    }

    const nextModel = this.getConfiguredRuntimeModel(model, normalizedUpdate);
    const configured = this.ctx.languageModelsService.configureModel(modelId, normalizedUpdate);
    if (!configured) {
      this.ctx.message.error(this.getConfigurationSaveErrorMessage(normalizedUpdate));
      return;
    }

    if (this.isSameModelSelection(nextModel)) {
      return;
    }

    if (this.ctx.isWaiting) {
      if (this.ctx.chatService.saveChatModel(nextModel) === false) {
        return;
      }
      this.assignPendingSwitch(nextModel, null);
      this.ctx.message.info(this.getPendingConfigurationMessage(normalizedUpdate));
      return;
    }

    await this.doSwitchModel(nextModel);
  }

  async switchToMode(mode: string): Promise<void> {
    const normalizedMode = resolveChatSurfaceModeId(mode);
    const needsBuiltinAgentReset = normalizedMode === 'agent'
      && this.ctx.currentMode === 'agent'
      && !!this.ctx.chatService.currentCustomAgentTarget;
    if (!normalizedMode || (normalizedMode === this.ctx.currentMode && !needsBuiltinAgentReset)) {
      return;
    }

    if (this.ctx.isWaiting) {
      this.ctx.message.info('当前对话运行中，无法切换模式');
      return;
    }

    await this.doSwitchMode(normalizedMode);
  }

  async switchToCustomAgent(selection: { readonly modeId?: string; readonly customAgentTarget?: string }): Promise<void> {
    const normalizedModeId = typeof selection?.modeId === 'string'
      ? selection.modeId.trim()
      : '';
    const normalizedAgentTarget = normalizeAgentIdentifier(selection?.customAgentTarget);
    const resolvedMode = normalizedModeId
      ? this.ctx.chatService.findResolvedModeById(normalizedModeId)
        ?? this.ctx.chatService.findResolvedModeByName(normalizedModeId)
      : undefined;
    const effectiveModeId = resolvedMode && resolvedMode.kind === 'agent' && resolvedMode.isBuiltin !== true
      ? resolvedMode.id.trim()
      : normalizedModeId;
    const effectiveAgentTarget = resolvedMode && resolvedMode.kind === 'agent' && resolvedMode.isBuiltin !== true
      ? resolvedMode.customAgentTarget ?? normalizedAgentTarget
      : normalizedAgentTarget;

    if (!effectiveModeId && !effectiveAgentTarget) {
      return;
    }

    if (
      this.ctx.currentMode === 'agent'
      && ((effectiveModeId && this.ctx.chatService.currentResolvedMode?.id === effectiveModeId)
        || (!effectiveModeId && this.ctx.chatService.currentCustomAgentTarget === effectiveAgentTarget))
    ) {
      return;
    }

    if (this.ctx.isWaiting) {
      this.ctx.message.info('当前对话运行中，无法切换智能体');
      return;
    }

    if (effectiveModeId) {
      this.ctx.chatService.setChatMode(effectiveModeId, true);
    } else if (typeof this.ctx.chatService.saveSelectedMode === 'function') {
      this.ctx.chatService.saveSelectedMode({
        modeId: 'agent',
        customAgentTarget: effectiveAgentTarget,
      });
    } else {
      this.ctx.chatService.saveChatMode('agent');
      this.ctx.chatService.saveCurrentCustomAgentTarget(effectiveAgentTarget);
    }

    this.refreshLocalEstimateIfNeeded();
  }

  async applyPendingSwitch(sessionId?: string | null): Promise<void> {
    const pendingOwnerSessionId = this.readPendingOwnerSessionId();
    const targetSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    if (pendingOwnerSessionId && targetSessionId && pendingOwnerSessionId !== targetSessionId) {
      return;
    }

    const pendingModel = this.ctx._pendingModelSwitch;
    const pendingMode = this.ctx._pendingModeSwitch;
    this.assignPendingSwitch(null, null);

    if (pendingModel) {
      await this.doSwitchModel(pendingModel);
      return;
    }

    if (pendingMode) {
      await this.doSwitchMode(pendingMode);
    }
  }

  private async doSwitchModel(model: ModelConfig): Promise<void> {
    console.info('[AilyChat][ModelSwitch] doSwitchModel start', {
      requestedModel: model,
    });
    console.info(
      `[AilyChat][ModelSwitch] doSwitchModel scalar requested=${model?.model ?? ''}/${model?.presetId ?? ''}/${model?.name ?? ''}`,
    );
    if (this.ctx.chatService.saveChatModel(model) === false) {
      console.info('[AilyChat][ModelSwitch] doSwitchModel aborted because saveChatModel returned false', {
        requestedModel: model,
      });
      return;
    }

    this.ctx.contextBudgetService?.updateModelContextSize(model);
    this.refreshLocalEstimateIfNeeded();
  }

  private async doSwitchMode(mode: string): Promise<void> {
    const normalizedMode = resolveChatSurfaceModeId(mode);
    if (!normalizedMode) {
      return;
    }

    this.ctx.chatService.saveChatMode(normalizedMode);
    this.ctx.chatService.clearCurrentCustomAgentTarget();
    this.refreshLocalEstimateIfNeeded();
  }
}
