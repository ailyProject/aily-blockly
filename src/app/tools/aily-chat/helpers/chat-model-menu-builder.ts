import type { IMenuItem } from '../../../configs/menu.config';
import { isDefaultAutoPresetSelected } from './model-billing-label';
import type {
  AilyChatConfigService,
  ModelPickerControlOption,
  ReasoningEffortOption,
} from '../services/aily-chat-config.service';
import type {
  AilyChatLanguageModelsService,
  LanguageModelConfigurationAction,
  LanguageModelConfigurationActionGroup,
} from '../services/aily-chat-language-models.service';
import type { ChatService } from '../services/chat.service';

type ChatCurrentModel = NonNullable<ChatService['currentModel']>;

interface ModelMenuPresetEntry {
  readonly presetId: string;
  readonly sortName: string;
  readonly sortMultiplier?: number;
  readonly enabled: boolean;
  readonly item: IMenuItem;
}

type NavigationConfigurationMenuAction = LanguageModelConfigurationAction;

type NavigationConfigurationActionGroup = Omit<LanguageModelConfigurationActionGroup, 'actions'> & {
  readonly actions: readonly NavigationConfigurationMenuAction[];
};

interface ModelConfigurationMenuItemData {
  readonly model: ChatCurrentModel;
  readonly modelSelectionId?: string;
  readonly reasoningMenuItems?: readonly IMenuItem[];
  readonly configurationMenuItemsByAction?: Readonly<Record<string, readonly IMenuItem[]>>;
}

interface ReasoningEffortMenuAction {
  readonly key: string;
  readonly label: string;
  readonly tooltip?: string;
  readonly checked: boolean;
  readonly value: ReasoningEffortOption;
}

export interface ChatModelMenuState {
  readonly modelMenuItems: readonly IMenuItem[];
  readonly currentReasoningEffortMenuItems: readonly IMenuItem[];
  readonly currentReasoningEffortLabel: string;
  readonly currentReasoningEffortDisplayLabel: string;
  readonly hasReasoningEffortOptions: boolean;
}

export interface ChatModelMenuBuilderDeps {
  readonly currentModel: ChatCurrentModel | null | undefined;
  readonly recentModelPresetIds: readonly string[];
  readonly pinnedModelIds: readonly string[];
  readonly ailyChatConfigService: AilyChatConfigService;
  readonly languageModelsService: AilyChatLanguageModelsService;
}

export function buildChatModelMenuState(deps: ChatModelMenuBuilderDeps): ChatModelMenuState {
  return new ChatModelMenuBuilder(deps).build();
}

class ChatModelMenuBuilder {
  constructor(private readonly deps: ChatModelMenuBuilderDeps) {}

  build(): ChatModelMenuState {
    const currentModel = this.deps.currentModel ?? null;
    const currentNavigationConfigurationGroups = currentModel
      ? this.getNavigationConfigurationActionGroups(currentModel)
      : [];
    const currentReasoningActions = currentModel
      ? this.getReasoningEffortMenuItems(currentModel, currentNavigationConfigurationGroups)
      : [];

    return {
      modelMenuItems: this.buildModelMenuItems(currentModel),
      currentReasoningEffortMenuItems: currentModel
        ? this.buildCurrentConfigurationMenuItems(currentModel, currentNavigationConfigurationGroups)
        : [],
      currentReasoningEffortLabel: this.deps.ailyChatConfigService.getReasoningEffortLabel(
        this.getConfiguredReasoningEffort(currentModel),
      ),
      currentReasoningEffortDisplayLabel: this.getCurrentReasoningEffortDisplayLabel(currentModel, currentNavigationConfigurationGroups),
      hasReasoningEffortOptions: currentNavigationConfigurationGroups.length > 0,
    };
  }

  private buildModelMenuItems(currentModel: ChatCurrentModel | null): readonly IMenuItem[] {
    const presets = this.deps.ailyChatConfigService.getUserVisibleModelPresets();
    const defaultPresetId = this.deps.ailyChatConfigService.getDefaultModelPresetId();
    const pinnedModelIds = this.getPinnedModelIds(defaultPresetId);
    const pinnedModelIdSet = new Set(pinnedModelIds);
    const promotedPresetIds = this.getPromotedPresetIds(defaultPresetId, pinnedModelIdSet);
    const visiblePresetIds = new Set<string>();
    const controlPresetEntries = this.deps.ailyChatConfigService.getModelPickerControlPresets();

    for (const [presetId, controlEntry] of Object.entries(controlPresetEntries)) {
      if (controlEntry.featured && presetId !== defaultPresetId) {
        promotedPresetIds.add(presetId);
      }
    }

    const presetEntries = presets
      .map<ModelMenuPresetEntry | null>((preset) => {
        const isDefaultPreset = preset.id === defaultPresetId;
        visiblePresetIds.add(preset.id);
        const displayModel = this.deps.ailyChatConfigService.resolvePresetDisplayModel(preset.id);
        if (!displayModel) {
          return null;
        }

        const executableModel = preset.enabled
          ? this.deps.ailyChatConfigService.resolveSelectablePresetModel(preset.id)
          : null;

        const item = this.createModelMenuItem(displayModel, currentModel, {
          description: isDefaultPreset
            ? this.buildDefaultAutoPresetDescription(preset.description)
            : preset.description,
          preferBillingMeta: true,
          disabled: isDefaultPreset ? false : !preset.enabled,
          disabledReason: isDefaultPreset ? undefined : preset.unavailableReason,
          requiredTier: isDefaultPreset ? undefined : preset.requiredTier,
          minimumClientVersion: isDefaultPreset ? undefined : preset.minimumClientVersion,
        });
        if (!executableModel) {
          delete item.data;
          item.actions = undefined;
        }

        return {
          presetId: preset.id,
          sortName: preset.name,
          sortMultiplier: typeof displayModel.billingMultiplier === 'number' ? displayModel.billingMultiplier : undefined,
          enabled: preset.enabled,
          item,
        } satisfies ModelMenuPresetEntry;
      })
      .filter((entry): entry is ModelMenuPresetEntry => entry !== null);

    const syntheticPromotedEntries = this.buildSyntheticPromotedEntries(
      promotedPresetIds,
      visiblePresetIds,
      defaultPresetId,
      currentModel,
    );
    const customModelEntries = this.getCustomModelMenuEntries(currentModel);
    const autoEntry = presetEntries.find(entry => entry.presetId === defaultPresetId)
      ?? this.getDefaultPresetMenuEntry(defaultPresetId, currentModel);
    const pinnedEntries = this.buildPinnedEntries(
      pinnedModelIds,
      [
        ...presetEntries.filter(entry => entry.presetId !== defaultPresetId),
        ...customModelEntries,
      ],
    );
    const promotedEntries = this.sortModelMenuPresetEntries([
      ...presetEntries.filter(entry => entry.presetId !== defaultPresetId && !pinnedModelIdSet.has(entry.presetId) && promotedPresetIds.has(entry.presetId)),
      ...syntheticPromotedEntries,
    ]);
    const otherEntries = this.sortModelMenuPresetEntries([
      ...presetEntries.filter(entry => entry.presetId !== defaultPresetId && !pinnedModelIdSet.has(entry.presetId) && !promotedPresetIds.has(entry.presetId)),
      ...customModelEntries.filter(entry => !pinnedModelIdSet.has(entry.presetId)),
    ]);

    const menuItems: IMenuItem[] = [];
    if (autoEntry) {
      menuItems.push(autoEntry.item);
    }

    if (pinnedEntries.length > 0) {
      if (menuItems.length > 0) {
        menuItems.push({ sep: true });
      }
      menuItems.push(...pinnedEntries.map(entry => ({
        ...entry.item,
        extra: {
          ...entry.item.extra,
          section: 'pinned-models',
        },
      })));
    }

    if (promotedEntries.length > 0) {
      if (menuItems.length > 0) {
        menuItems.push({ sep: true });
      }
      menuItems.push(...promotedEntries.map(entry => ({
        ...entry.item,
        extra: {
          ...entry.item.extra,
          section: 'promoted-models',
        },
      })));
    }

    if (otherEntries.length > 0) {
      if (menuItems.length > 0) {
        menuItems.push({ sep: true });
      }
      menuItems.push(this.createModelMenuSectionToggle('其他模型', 'other-models'));
      menuItems.push(...otherEntries.map(entry => ({
        ...entry.item,
        extra: {
          ...entry.item.extra,
          section: 'other-models',
        },
      })));
    }

    return menuItems;
  }

  private getCurrentReasoningEffortDisplayLabel(
    currentModel: ChatCurrentModel | null,
    navigationConfigurationGroups: readonly NavigationConfigurationActionGroup[],
  ): string {
    const navigationConfigurationDisplayLabel = this.getNavigationConfigurationDisplayLabel(navigationConfigurationGroups);
    if (navigationConfigurationDisplayLabel) {
      return navigationConfigurationDisplayLabel;
    }

    return this.deps.ailyChatConfigService.getReasoningEffortDisplayLabel(
      this.getConfiguredReasoningEffort(currentModel),
    );
  }

  private createModelMenuItem(
    model: ChatCurrentModel,
    currentModel: ChatCurrentModel | null,
    options?: {
      description?: string | null;
      preferBillingMeta?: boolean;
      disabled?: boolean;
      disabledReason?: 'upgrade' | 'admin' | 'update';
      requiredTier?: string;
      minimumClientVersion?: string;
    },
  ): IMenuItem {
    const isCurrentModel = currentModel?.model === model.model && currentModel?.presetId === model.presetId;
    const modelConfigurationGroups = this.getModelConfigurationActionGroups(model);
    const navigationConfigurationGroups = modelConfigurationGroups
      .filter((group) => group.group === 'navigation');
    const configuredReasoningEffort = this.getConfiguredReasoningEffort(model);
    const navigationConfigurationSummary = this.getNavigationConfigurationDisplayLabel(navigationConfigurationGroups);
    const configurationMenuItemsByAction = this.buildConfigurationMenuItemsByAction(model, modelConfigurationGroups);
    const reasoningMenuItems = configurationMenuItemsByAction[this.getModelConfigurationActionId('reasoningEffort')] ?? [];
    const hoverConfigurationGroup = navigationConfigurationGroups.find((group) => group.key === 'reasoningEffort');
    const hoverConfigurationMenuItems = hoverConfigurationGroup
      ? this.createConfigurationMenuItems(model, hoverConfigurationGroup)
      : [];
    const modelSelectionId = this.getModelSelectionId(model);
    const isPinned = !!modelSelectionId && this.deps.pinnedModelIds.includes(modelSelectionId);
    const actions = [
      ...this.createPinAction(modelSelectionId, isPinned),
      ...modelConfigurationGroups.map((group) => ({
        icon: this.getModelConfigurationActionIcon(group.key),
        action: this.getModelConfigurationActionId(group.key),
        title: group.label,
      })),
    ];
    const displayModel = configuredReasoningEffort
      ? {
          ...model,
          reasoningEffort: configuredReasoningEffort,
        }
      : model;

    return {
      name: model.name,
      text: this.buildModelMenuMeta(displayModel, navigationConfigurationSummary, { preferBilling: options?.preferBillingMeta ?? false }),
      action: 'select-model',
      current: isCurrentModel,
      disabled: options?.disabled,
      tooltip: this.deps.ailyChatConfigService.buildModelTooltip(displayModel, {
        description: this.buildPresetTooltipDescription(options),
      }),
      data: {
        model,
        modelSelectionId,
        reasoningMenuItems,
        configurationMenuItemsByAction,
      },
      children: hoverConfigurationMenuItems.length > 0 ? hoverConfigurationMenuItems : undefined,
      actions: actions.length > 0 ? actions : undefined,
      extra: {
        hoverFlyout: this.buildModelHoverFlyout(model, displayModel, modelConfigurationGroups, hoverConfigurationGroup?.label, options),
      },
      hideChildrenArrow: true,
    };
  }

  private buildModelHoverFlyout(
    model: ChatCurrentModel,
    displayModel: ChatCurrentModel,
    modelConfigurationGroups: readonly NavigationConfigurationActionGroup[],
    hoverConfigurationLabel?: string,
    options?: {
      description?: string | null;
      preferBillingMeta?: boolean;
      disabled?: boolean;
      disabledReason?: 'upgrade' | 'admin' | 'update';
      requiredTier?: string;
      minimumClientVersion?: string;
    },
  ) {
    const description = this.buildPresetTooltipDescription(options);
    const providerContextManagementDetail = this.deps.ailyChatConfigService.getModelProviderContextManagementDetail(displayModel);
    const contextValue = this.deps.ailyChatConfigService.getModelCapabilityContextWindowLabel(displayModel);
    const descriptionLines = [description, providerContextManagementDetail]
      .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
      .join('\n');

    return {
      title: model.name,
      description: descriptionLines || undefined,
      contextLabel: contextValue && contextValue !== '自动检测' ? '上下文长度' : undefined,
      contextValue: contextValue && contextValue !== '自动检测' ? contextValue : undefined,
      sectionLabel: hoverConfigurationLabel ?? this.getModelHoverSectionLabel(modelConfigurationGroups),
    };
  }

  private getModelConfigurationActionGroups(
    model: ChatCurrentModel | null | undefined,
  ): readonly NavigationConfigurationActionGroup[] {
    const modelId = this.getModelConfigurationId(model);
    if (!model || !modelId || isDefaultAutoPresetSelected(model)) {
      return [];
    }

    return this.deps.languageModelsService.getModelConfigurationActions(modelId)
      .filter((group) => Array.isArray(group.actions) && group.actions.length > 0)
      .map((group) => ({
        ...group,
        label: typeof group.label === 'string' && group.label.trim() ? group.label.trim() : group.key,
        actions: group.actions.map((action) => ({
          ...action,
          label: typeof action.label === 'string' && action.label.trim() ? action.label.trim() : String(action.value),
        })),
      }));
  }

  private getNavigationConfigurationActionGroups(
    model: ChatCurrentModel | null | undefined,
  ): readonly NavigationConfigurationActionGroup[] {
    return this.getModelConfigurationActionGroups(model)
      .filter((group) => group.group === 'navigation');
  }

  private getReasoningEffortMenuItems(
    model: ChatCurrentModel | null | undefined,
    navigationConfigurationGroups?: readonly NavigationConfigurationActionGroup[],
  ): readonly ReasoningEffortMenuAction[] {
    const groups = navigationConfigurationGroups ?? this.getNavigationConfigurationActionGroups(model);
    const schemaActions = groups
      .filter((group) => group.key === 'reasoningEffort')
      .flatMap((group) => group.actions)
      .filter((action) => typeof action.value === 'string')
      .map((action) => ({
        ...action,
        value: action.value as ReasoningEffortOption,
      }));

    return schemaActions;
  }

  private getModelConfigurationId(
    model: ChatCurrentModel | null | undefined,
  ): string {
    return typeof model?.presetId === 'string' && model.presetId.trim()
      ? model.presetId.trim()
      : typeof model?.model === 'string'
        ? model.model.trim()
        : '';
  }

  private getConfiguredReasoningEffort(
    model: ChatCurrentModel | null | undefined,
  ): ReasoningEffortOption | undefined {
    const checkedAction = this.getReasoningEffortMenuItems(model).find((item) => item.checked);
    if (checkedAction) {
      return checkedAction.value;
    }

    return this.getStoredOrDefaultReasoningEffort(model);
  }

  private getStoredOrDefaultReasoningEffort(
    model: ChatCurrentModel | null | undefined,
  ): ReasoningEffortOption | undefined {
    const modelId = this.getModelConfigurationId(model);
    const configuredReasoningEffort = modelId
      ? this.deps.languageModelsService.getModelConfiguration(modelId)?.['reasoningEffort']
      : undefined;
    if (typeof configuredReasoningEffort === 'string') {
      return configuredReasoningEffort as ReasoningEffortOption;
    }

    return this.deps.ailyChatConfigService.resolveModelReasoningEffort(model, model?.reasoningEffort);
  }

  private normalizeConfigurationActionLabel(label: string): string {
    return label.replace(/\s*\(default\)$/i, '');
  }

  private getNavigationConfigurationDisplayLabel(
    navigationConfigurationGroups: readonly NavigationConfigurationActionGroup[],
  ): string {
    const labels = navigationConfigurationGroups
      .map((group) => group.actions.find((action) => action.checked))
      .filter((action): action is NavigationConfigurationMenuAction => !!action)
      .map((action) => this.normalizeConfigurationActionLabel(action.label));

    return labels.join(', ');
  }

  private buildCurrentConfigurationMenuItems(
    model: ChatCurrentModel,
    navigationConfigurationGroups: readonly NavigationConfigurationActionGroup[],
  ): IMenuItem[] {
    if (navigationConfigurationGroups.length === 0) {
      return [];
    }

    if (navigationConfigurationGroups.length === 1) {
      return this.createConfigurationMenuItems(model, navigationConfigurationGroups[0]);
    }

    return navigationConfigurationGroups.map((group) => ({
      name: group.label,
      children: this.createConfigurationMenuItems(model, group),
    }));
  }

  private buildConfigurationMenuItemsByAction(
    model: ChatCurrentModel,
    navigationConfigurationGroups: readonly NavigationConfigurationActionGroup[],
  ): Readonly<Record<string, readonly IMenuItem[]>> {
    return navigationConfigurationGroups.reduce<Record<string, readonly IMenuItem[]>>((acc, group) => {
      acc[this.getModelConfigurationActionId(group.key)] = this.createConfigurationMenuItems(model, group);
      return acc;
    }, {});
  }

  private createConfigurationMenuItems(
    model: ChatCurrentModel,
    group: NavigationConfigurationActionGroup,
  ): IMenuItem[] {
    return group.actions.map((item) => this.createConfigurationItem(model, item));
  }

  private createConfigurationItem(
    model: ChatCurrentModel,
    item: NavigationConfigurationMenuAction,
  ): IMenuItem {
    const configuredModel = item.key === 'reasoningEffort' && typeof item.value === 'string'
      ? {
          ...model,
          reasoningEffort: item.value as ReasoningEffortOption,
        }
      : model;

    return {
      name: item.label,
      action: 'select-model',
      check: item.checked,
      tooltip: item.tooltip,
      data: {
        model: configuredModel,
        modelConfiguration: {
          key: item.key,
          value: item.value,
        },
      },
      extra: {
        detail: item.tooltip,
      },
    };
  }

  private getModelConfigurationActionId(key: string): string {
    return `configure-model.${key}`;
  }

  private getModelSelectionId(model: ChatCurrentModel | null | undefined): string {
    return typeof model?.presetId === 'string' && model.presetId.trim()
      ? model.presetId.trim()
      : typeof model?.model === 'string'
        ? model.model.trim()
        : '';
  }

  private createPinAction(modelSelectionId: string, isPinned: boolean): Array<{ icon: string; action: string; title: string }> {
    if (!modelSelectionId || modelSelectionId === this.deps.ailyChatConfigService.getDefaultModelPresetId()) {
      return [];
    }

    return [{
      icon: 'fa-light fa-thumbtack',
      action: isPinned ? 'unpin-model' : 'pin-model',
      title: isPinned ? '取消固定模型' : '固定模型',
    }];
  }

  private getModelConfigurationActionIcon(key: string): string {
    switch (key) {
      case 'reasoningEffort':
        return 'fa-light fa-brain';
      default:
        return 'fa-light fa-sliders';
    }
  }

  private getModelHoverSectionLabel(
    navigationConfigurationGroups: readonly NavigationConfigurationActionGroup[],
  ): string | undefined {
    if (navigationConfigurationGroups.length === 1) {
      return navigationConfigurationGroups[0].label;
    }

    return navigationConfigurationGroups.length > 1 ? '模型配置' : undefined;
  }

  private buildModelMenuMeta(
    model: ChatCurrentModel,
    navigationConfigurationSummary: string | undefined,
    options?: { preferBilling?: boolean },
  ): string | undefined {
    const preferBilling = options?.preferBilling ?? false;
    const billingLabel = typeof this.deps.ailyChatConfigService.getModelBillingLabel === 'function'
      ? this.deps.ailyChatConfigService.getModelBillingLabel(model)
      : undefined;

    if (preferBilling && billingLabel && !navigationConfigurationSummary) {
      return billingLabel;
    }

    const parts = [navigationConfigurationSummary, billingLabel].filter((part): part is string => !!part);
    if (parts.length > 0) {
      return parts.join('·');
    }

    if (model.isCustom) {
      return 'Custom';
    }

    const contextLabel = this.deps.ailyChatConfigService.getModelCapabilityContextWindowLabel(model);
    if (contextLabel && contextLabel !== '自动检测') {
      return contextLabel;
    }

    return billingLabel;
  }

  private buildPresetTooltipDescription(options?: {
    description?: string | null;
    disabledReason?: 'upgrade' | 'admin' | 'update';
    requiredTier?: string;
    minimumClientVersion?: string;
  }): string | undefined {
    const description = typeof options?.description === 'string' && options.description.trim()
      ? options.description.trim()
      : undefined;

    if (options?.disabledReason === 'upgrade') {
      const requiredTier = typeof options.requiredTier === 'string' && options.requiredTier.trim()
        ? options.requiredTier.trim().toUpperCase()
        : 'PAID';
      const upgradeMessage = `升级到 ${requiredTier} 后可用`;
      return description ? `${description}\n\n${upgradeMessage}` : upgradeMessage;
    }

    if (options?.disabledReason === 'update') {
      const minimumClientVersion = typeof options.minimumClientVersion === 'string' && options.minimumClientVersion.trim()
        ? options.minimumClientVersion.trim()
        : undefined;
      const updateMessage = minimumClientVersion
        ? `升级客户端到 ${minimumClientVersion} 或更高版本后可用`
        : '升级客户端后可用';
      return description ? `${description}\n\n${updateMessage}` : updateMessage;
    }

    if (options?.disabledReason === 'admin') {
      const adminMessage = '需要管理员权限后可用';
      return description ? `${description}\n\n${adminMessage}` : adminMessage;
    }

    return description;
  }

  private getPromotedPresetIds(defaultPresetId: string, pinnedModelIdSet: ReadonlySet<string>): Set<string> {
    const promotedPresetIds = new Set<string>();
    const currentPresetId = typeof this.deps.currentModel?.presetId === 'string'
      ? this.deps.currentModel.presetId.trim()
      : '';

    if (currentPresetId && currentPresetId !== defaultPresetId && !pinnedModelIdSet.has(currentPresetId)) {
      promotedPresetIds.add(currentPresetId);
    }

    for (const presetId of this.deps.recentModelPresetIds) {
      if (presetId && presetId !== defaultPresetId && !pinnedModelIdSet.has(presetId)) {
        promotedPresetIds.add(presetId);
      }
    }

    return promotedPresetIds;
  }

  private getPinnedModelIds(defaultPresetId: string): string[] {
    return [...new Set(this.deps.pinnedModelIds
      .filter((modelId): modelId is string => typeof modelId === 'string')
      .map((modelId) => modelId.trim())
      .filter((modelId) => modelId.length > 0 && modelId !== defaultPresetId))];
  }

  private buildPinnedEntries(
    pinnedModelIds: readonly string[],
    entries: readonly ModelMenuPresetEntry[],
  ): ModelMenuPresetEntry[] {
    const entryMap = new Map(entries.map((entry) => [entry.presetId, entry]));
    return pinnedModelIds
      .map((modelId) => entryMap.get(modelId))
      .filter((entry): entry is ModelMenuPresetEntry => !!entry);
  }

  private buildSyntheticPromotedEntries(
    promotedPresetIds: ReadonlySet<string>,
    visiblePresetIds: ReadonlySet<string>,
    defaultPresetId: string,
    currentModel: ChatCurrentModel | null,
  ): ModelMenuPresetEntry[] {
    const syntheticEntries: ModelMenuPresetEntry[] = [];

    for (const presetId of promotedPresetIds) {
      if (!presetId || presetId === defaultPresetId || visiblePresetIds.has(presetId)) {
        continue;
      }

      const preset = this.deps.ailyChatConfigService.getModelPresetById(presetId);
      const controlEntry = this.deps.ailyChatConfigService.getModelPickerControlPresetById(presetId);
      if (!preset && !controlEntry) {
        continue;
      }

      const displayModel = this.deps.ailyChatConfigService.resolvePresetDisplayModel(presetId);
      const sortName = controlEntry?.label || preset?.name || presetId;

      if (displayModel) {
        const executableModel = preset?.enabled !== false
          ? this.deps.ailyChatConfigService.resolveSelectablePresetModel(presetId)
          : null;
        const item = this.createModelMenuItem(displayModel, currentModel, {
          description: preset?.description,
          preferBillingMeta: true,
          disabled: preset ? !preset.enabled : false,
          disabledReason: preset?.unavailableReason,
          requiredTier: preset?.requiredTier,
          minimumClientVersion: preset?.minimumClientVersion,
        });
        if (!executableModel) {
          delete item.data;
          item.actions = undefined;
        }
        item.name = sortName;
        syntheticEntries.push({
          presetId,
          sortName,
          sortMultiplier: typeof displayModel.billingMultiplier === 'number' ? displayModel.billingMultiplier : undefined,
          enabled: preset?.enabled ?? true,
          item,
        });
        continue;
      }

      if (controlEntry) {
        syntheticEntries.push({
          presetId,
          sortName,
          sortMultiplier: typeof preset?.billingMultiplier === 'number' ? preset.billingMultiplier : undefined,
          enabled: false,
          item: this.createUnavailableModelMenuItem(controlEntry, {
            description: preset?.description,
            disabledReason: preset?.unavailableReason ?? this.resolveSyntheticUnavailableReason(controlEntry),
            requiredTier: preset?.requiredTier,
            minimumClientVersion: preset?.minimumClientVersion ?? controlEntry.minClientVersion,
          }),
        });
      }
    }

    return syntheticEntries;
  }

  private getCustomModelMenuEntries(
    currentModel: ChatCurrentModel | null,
  ): ModelMenuPresetEntry[] {
    return this.deps.ailyChatConfigService.getEnabledModels()
      .filter(model => model.isCustom)
      .map((model) => ({
        presetId: model.model,
        sortName: model.name,
        sortMultiplier: typeof model.billingMultiplier === 'number' ? model.billingMultiplier : undefined,
        enabled: model.enabled,
        item: this.createModelMenuItem(model, currentModel, {
          description: model.description,
        }),
      }));
  }

  private getDefaultPresetMenuEntry(
    defaultPresetId: string,
    currentModel: ChatCurrentModel | null,
  ): ModelMenuPresetEntry | undefined {
    const defaultPreset = this.deps.ailyChatConfigService.getModelPresetById(defaultPresetId);
    const defaultModel = this.deps.ailyChatConfigService.resolveSelectablePresetModel(defaultPresetId);
    if (!defaultModel) {
      return undefined;
    }

    return {
      presetId: defaultPresetId,
      sortName: defaultPreset?.name ?? defaultModel.name,
      sortMultiplier: typeof defaultModel.billingMultiplier === 'number' ? defaultModel.billingMultiplier : undefined,
      enabled: true,
      item: this.createModelMenuItem(defaultModel, currentModel, {
        description: this.buildDefaultAutoPresetDescription(defaultPreset?.description),
        preferBillingMeta: true,
        disabled: false,
      }),
    };
  }

  private buildDefaultAutoPresetDescription(description: string | null | undefined): string {
    const normalizedDescription = typeof description === 'string' ? description.trim() : '';
    const autoRoutingDescription = 'Auto routing. The runtime keeps Auto as your selected preset and resolves a concrete model for each request.';

    if (!normalizedDescription) {
      return autoRoutingDescription;
    }

    return /auto\s*routing|automatic model selection/i.test(normalizedDescription)
      ? normalizedDescription
      : `${normalizedDescription}\n\n${autoRoutingDescription}`;
  }

  private createUnavailableModelMenuItem(
    controlEntry: ModelPickerControlOption,
    options?: {
      description?: string;
      disabledReason?: 'upgrade' | 'admin' | 'update';
      requiredTier?: string;
      minimumClientVersion?: string;
    },
  ): IMenuItem {
    return {
      name: controlEntry.label,
      action: 'select-model',
      disabled: true,
      tooltip: this.buildPresetTooltipDescription(options),
      hideChildrenArrow: true,
    };
  }

  private resolveSyntheticUnavailableReason(controlEntry: ModelPickerControlOption): 'upgrade' | 'admin' | 'update' {
    if (controlEntry.minClientVersion) {
      return 'update';
    }

    return 'admin';
  }

  private sortModelMenuPresetEntries(entries: readonly ModelMenuPresetEntry[]): ModelMenuPresetEntry[] {
    return [...entries].sort((left, right) => {
      if (left.enabled !== right.enabled) {
        return left.enabled ? -1 : 1;
      }

      const leftMultiplier = typeof left.sortMultiplier === 'number' && Number.isFinite(left.sortMultiplier)
        ? left.sortMultiplier
        : Number.NEGATIVE_INFINITY;
      const rightMultiplier = typeof right.sortMultiplier === 'number' && Number.isFinite(right.sortMultiplier)
        ? right.sortMultiplier
        : Number.NEGATIVE_INFINITY;
      if (leftMultiplier !== rightMultiplier) {
        return rightMultiplier - leftMultiplier;
      }

      return left.sortName.localeCompare(right.sortName);
    });
  }

  private createModelMenuSectionToggle(name: string, sectionId: string): IMenuItem {
    return {
      name,
      action: `section-toggle-${sectionId}`,
      extra: {
        sectionId,
        collapsed: true,
      },
    };
  }
}