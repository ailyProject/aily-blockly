import type { ChatPartStore } from '../core/chat-part-store';
import type { Observable } from 'rxjs';
import type { ModelConfig } from '../services/chat.service';
import type { ChatSelectedMode } from '../core/chat-mode';
import type { AuthQuotaSnapshot } from '../services/auth-quota-snapshot';
import type { ChatInputNotice } from '../services/chat-input-notice';
import type { ContextBudgetSnapshot } from '../services/context-budget-snapshot';
import type { ChatContextUsagePromptTokenDetail, ChatContextUsageSnapshot } from '../services/context-usage-snapshot';
import type { InteractionBudgetSnapshot } from '../services/interaction-budget-snapshot';
import type { RequestQuotaSnapshot } from '../services/request-quota-snapshot';
import type { WorkspaceCheckpointPresentationMode } from '../services/edit-checkpoint.service';
import type { IMenuItem } from '../../../configs/menu.config';
import type { ChatVisibleTranscriptDialogItem } from '../core/chat-visible-transcript-model';
import type { CheckpointRestoreSurface } from './checkpoint-restore-visibility';
import type { ChatSessionActionState } from './chat-request-controller';
import type { HostRequestModel } from './host-turn-response-state';
import type { MenuPosition } from '../services/menu-manager.service';

interface ChatEngineViewLike {
  readonly hostRequestModel: HostRequestModel | null;
  readonly dialogItems: readonly ChatVisibleTranscriptDialogItem[];
  readonly checkpointRestoreSurface: CheckpointRestoreSurface | null;
  readonly partStore: ChatPartStore;
  readonly isWaiting: boolean;
  readonly getSessionActionState?: (sessionId?: string | null) => ChatSessionActionState;
  readonly isCompleted: boolean;
  readonly isLoggedIn: boolean;
  readonly inputValue: string;
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly currentMode: string;
  readonly selectedMode: ChatSelectedMode;
  readonly currentAgentRuntimeMode: string;
  readonly currentSessionPermissionMode: string;
  readonly currentSessionPermissionProfile: string;
  readonly currentSessionApprovalsReviewer: 'user' | 'auto_review' | undefined;
  readonly currentCustomAgentTarget: string | undefined;
  readonly currentModel: ModelConfig;
  readonly currentModelName: string | undefined;
  readonly currentReasoningEffort: string | undefined;
  readonly currentReasoningEffortLabel: string;
  readonly currentReasoningEffortDisplayLabel: string;
  readonly currentModelReasoningEfforts: readonly string[];
  readonly currentModelChipLabel: string;
  readonly currentModelTooltip: string;
  readonly currentModelBillingLabel: string | undefined;
  readonly workspaceCheckpointPresentationMode: WorkspaceCheckpointPresentationMode;
  readonly contextBudget$: Observable<ContextBudgetSnapshot>;
  readonly authQuotaSnapshot$: Observable<AuthQuotaSnapshot | null>;
  readonly chatInputNotice$: Observable<ChatInputNotice | null>;
  readonly authQuotaExhausted: boolean;
  readonly requestQuotaSnapshot$: Observable<RequestQuotaSnapshot | null>;
  readonly contextBudgetSnapshot: ContextBudgetSnapshot | null;
  readonly contextUsageSnapshot: ChatContextUsageSnapshot | null;
  readonly interactionBudgetSnapshot: InteractionBudgetSnapshot | null;
  readonly requestQuotaSnapshot: RequestQuotaSnapshot | null;
  readonly debug: boolean;
  readonly prjPath: string;
  readonly prjRootPath: string;
}

interface ChatViewStateLike {
  readonly isStandaloneWindow: boolean;
  readonly currentViewSessionId: string;
  readonly bottomHeight: number;
  readonly senderMinHeight: number;
  readonly senderMaxHeight: number;
  readonly showSessionPicker: boolean;
  readonly sessionPickerPosition: MenuPosition;
  readonly showSettings: boolean;
  readonly showAgentSuggestions: boolean;
  readonly agentSuggestions: readonly string[];
  readonly modeMenuItems: IMenuItem[];
  readonly modelMenuItems: IMenuItem[];
  readonly currentReasoningEffortMenuItems: IMenuItem[];
  readonly currentReasoningEffortLabel: string;
  readonly currentReasoningEffortDisplayLabel: string;
  readonly hasReasoningEffortOptions: boolean;
  openSessionPicker(anchor?: MouseEvent): void;
  closeSessionPicker(): void;
}

interface ContextUsageDetailViewItem {
  readonly label: string;
  readonly contextPercentage: number;
}

interface ContextUsageDetailViewGroup {
  readonly category: string;
  readonly items: readonly ContextUsageDetailViewItem[];
}

interface ContextUsageSummaryViewItem {
  readonly label: string;
  readonly value: string;
}

export interface ChatContextUsageDisplay {
  readonly snapshot: ChatContextUsageSnapshot;
  readonly severity: 'normal' | 'warning' | 'error';
  readonly isEstimated: boolean;
  readonly estimatedBadgeLabel?: string;
  readonly percentage: number;
  readonly percentageLabel: string;
  readonly circleLabel: string;
  readonly usedTokensLabel: string;
  readonly totalTokensLabel: string;
  readonly summaryItems: readonly ContextUsageSummaryViewItem[];
  readonly reservedWidth: number;
  readonly showReservedWidth: boolean;
  readonly strokeDashoffset: number;
  readonly showWarningNotice: boolean;
  readonly detailGroups: readonly ContextUsageDetailViewGroup[];
}

/**
 * Read-only adapter for the chat component template.
 *
 * Keeps `AilyChatComponent` from re-declaring a long list of passthrough
 * getters while preserving the existing engine/view-state ownership split.
 */
export class ChatComponentViewModel {
  private lastContextUsageSnapshot: ChatContextUsageSnapshot | null = null;
  private lastContextUsageDisplay: ChatContextUsageDisplay | null = null;

  constructor(
    private readonly deps: {
      engine: ChatEngineViewLike;
      viewState: ChatViewStateLike;
    },
  ) {}

  get hostRequestModel(): HostRequestModel | null {
    return this.deps.engine.hostRequestModel;
  }

  get hasConversationContent(): boolean {
    const dialogItems = this.dialogItems;
    const hostRequestModel = this.hostRequestModel;
    return dialogItems.length > 0
      || hostRequestModel !== null
      || hostRequestModel?.response?.response != null
      || hostRequestModel?.response?.entireResponse != null;
  }

  get dialogItems(): readonly ChatVisibleTranscriptDialogItem[] {
    return this.deps.engine.dialogItems;
  }

  get checkpointRestoreSurface(): CheckpointRestoreSurface | null {
    return this.deps.engine.checkpointRestoreSurface;
  }

  get partStore(): ChatPartStore {
    return this.deps.engine.partStore;
  }

  get isWaiting(): boolean {
    return this.deps.engine.getSessionActionState?.(this.sessionId)?.canStop ?? this.deps.engine.isWaiting;
  }

  get isCompleted(): boolean {
    return this.deps.engine.isCompleted;
  }

  get isLoggedIn(): boolean {
    return this.deps.engine.isLoggedIn;
  }

  get inputValue(): string {
    return this.deps.engine.inputValue;
  }

  get sessionId(): string {
    return this.deps.viewState.currentViewSessionId;
  }

  get sessionTitle(): string {
    return this.deps.engine.sessionTitle;
  }

  get showSessionPicker(): boolean {
    return this.deps.viewState.showSessionPicker;
  }

  get sessionPickerPosition(): MenuPosition {
    return this.deps.viewState.sessionPickerPosition;
  }

  openSessionPicker(anchor?: MouseEvent): void {
    this.deps.viewState.openSessionPicker(anchor);
  }

  closeSessionPicker(): void {
    this.deps.viewState.closeSessionPicker();
  }

  get currentMode(): string {
    return this.deps.engine.currentMode;
  }

  get selectedMode(): ChatSelectedMode {
    return this.deps.engine.selectedMode;
  }

  get currentAgentRuntimeMode(): string {
    return this.deps.engine.currentAgentRuntimeMode;
  }

  get currentPermissionLabel(): string {
    if (this.deps.engine.currentSessionPermissionProfile === 'danger-full-access') {
      return '完全访问权限';
    }

    if (this.deps.engine.currentSessionApprovalsReviewer === 'auto_review') {
      return '自动审查';
    }

    return '默认权限';
  }

  get currentCustomAgentTarget(): string | undefined {
    return this.deps.engine.currentCustomAgentTarget;
  }

  get currentModel(): ModelConfig {
    return this.deps.engine.currentModel;
  }

  get currentModelName(): string | undefined {
    return this.deps.engine.currentModelName;
  }

  get currentReasoningEffort(): string | undefined {
    return this.deps.engine.currentReasoningEffort;
  }

  get currentReasoningEffortLabel(): string {
    return this.deps.engine.currentReasoningEffortLabel;
  }

  get currentReasoningEffortDisplayLabel(): string {
    return this.deps.viewState.currentReasoningEffortDisplayLabel;
  }

  get currentModelReasoningEfforts(): readonly string[] {
    return this.deps.engine.currentModelReasoningEfforts;
  }

  get currentModelChipLabel(): string {
    return this.deps.engine.currentModelChipLabel;
  }

  get currentReasoningEffortMenuItems(): IMenuItem[] {
    return this.deps.viewState.currentReasoningEffortMenuItems;
  }

  get currentModelTooltip(): string {
    return this.deps.engine.currentModelTooltip;
  }

  get currentModelBillingLabel(): string | undefined {
    return this.deps.engine.currentModelBillingLabel;
  }

  get workspaceCheckpointPresentationMode(): WorkspaceCheckpointPresentationMode {
    return this.deps.engine.workspaceCheckpointPresentationMode;
  }

  get contextBudget$(): Observable<ContextBudgetSnapshot> {
    return this.deps.engine.contextBudget$;
  }

  get authQuotaSnapshot$(): Observable<AuthQuotaSnapshot | null> {
    return this.deps.engine.authQuotaSnapshot$;
  }

  get chatInputNotice$(): Observable<ChatInputNotice | null> {
    return this.deps.engine.chatInputNotice$;
  }

  get authQuotaExhausted(): boolean {
    return this.deps.engine.authQuotaExhausted;
  }

  get requestQuotaSnapshot$(): Observable<RequestQuotaSnapshot | null> {
    return this.deps.engine.requestQuotaSnapshot$;
  }

  get contextBudgetSnapshot(): ContextBudgetSnapshot | null {
    return this.deps.engine.contextBudgetSnapshot;
  }

  get contextUsageSnapshot(): ChatContextUsageSnapshot | null {
    return this.deps.engine.contextUsageSnapshot;
  }

  get contextUsageDisplay(): ChatContextUsageDisplay | null {
    const snapshot = this.deps.engine.contextUsageSnapshot;
    if (!snapshot || snapshot.totalContextWindow <= 0) {
      if (this.deps.engine.isWaiting && this.lastContextUsageDisplay) {
        return this.lastContextUsageDisplay;
      }
      this.lastContextUsageSnapshot = null;
      this.lastContextUsageDisplay = null;
      return null;
    }

    if (this.lastContextUsageSnapshot === snapshot && this.lastContextUsageDisplay) {
      return this.lastContextUsageDisplay;
    }

    const percentage = clampContextUsagePercentage(snapshot.percentage);
    const reservedWidth = getContextUsageReservedWidth(snapshot, percentage);
    const display: ChatContextUsageDisplay = {
      snapshot,
      severity: percentage >= 90 ? 'error' : percentage >= 75 ? 'warning' : 'normal',
      isEstimated: snapshot.source === 'estimate',
      ...(snapshot.source === 'estimate' ? { estimatedBadgeLabel: 'Estimated' } : {}),
      percentage,
      percentageLabel: `${percentage.toFixed(0)}%`,
      circleLabel: percentage.toFixed(0),
      usedTokensLabel: formatContextUsageTokenCount(snapshot.usedTokens, 1),
      totalTokensLabel: formatContextUsageTokenCount(snapshot.totalContextWindow, 0),
      summaryItems: buildContextUsageSummaryItems(snapshot),
      reservedWidth,
      showReservedWidth: reservedWidth > 0,
      strokeDashoffset: 87.965 * (1 - (percentage / 100)),
      showWarningNotice: percentage >= 75,
      detailGroups: buildContextUsageDetailGroups(snapshot.promptTokenDetails ?? [], percentage),
    };

    this.lastContextUsageSnapshot = snapshot;
    this.lastContextUsageDisplay = display;
    return display;
  }

  get interactionBudgetSnapshot(): InteractionBudgetSnapshot | null {
    return this.deps.engine.interactionBudgetSnapshot;
  }

  get requestQuotaSnapshot(): RequestQuotaSnapshot | null {
    return this.deps.engine.requestQuotaSnapshot;
  }

  get debug(): boolean {
    return this.deps.engine.debug;
  }

  get prjPath(): string {
    return this.deps.engine.prjPath;
  }

  get prjRootPath(): string {
    return this.deps.engine.prjRootPath;
  }

  get isStandaloneWindow(): boolean {
    return this.deps.viewState.isStandaloneWindow;
  }

  get bottomHeight(): number {
    return this.deps.viewState.bottomHeight;
  }

  get senderMinHeight(): number {
    return this.deps.viewState.senderMinHeight;
  }

  get senderMaxHeight(): number {
    return this.deps.viewState.senderMaxHeight;
  }

  get showSettings(): boolean {
    return this.deps.viewState.showSettings;
  }

  get showAgentSuggestions(): boolean {
    return this.deps.viewState.showAgentSuggestions;
  }

  get agentSuggestions(): readonly string[] {
    return this.deps.viewState.agentSuggestions;
  }

  get modeMenuItems(): IMenuItem[] {
    return this.deps.viewState.modeMenuItems;
  }

  get modelMenuItems(): IMenuItem[] {
    return this.deps.viewState.modelMenuItems;
  }

  get hasReasoningEffortOptions(): boolean {
    return this.deps.viewState.hasReasoningEffortOptions;
  }
}

function formatContextUsageTokenCount(count: number, decimals: number): string {
  const mThreshold = 1000000 - 500 * Math.pow(10, -decimals);

  if (count >= mThreshold) {
    return `${(count / 1000000).toFixed(decimals)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(decimals)}K`;
  }

  return count.toString();
}

function clampContextUsagePercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function getContextUsageReservedWidth(snapshot: ChatContextUsageSnapshot, percentage: number): number {
  if (typeof snapshot.outputBufferPercentage !== 'number' || snapshot.outputBufferPercentage <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100 - percentage, snapshot.outputBufferPercentage));
}

function buildContextUsageDetailGroups(
  details: readonly ChatContextUsagePromptTokenDetail[],
  percentage: number,
): readonly ContextUsageDetailViewGroup[] {
  if (details.length === 0) {
    return [];
  }

  const categoryMap = new Map<string, Array<{ label: string; percentageOfPrompt: number }>>();
  let totalPercentage = 0;

  for (const detail of details) {
    const items = categoryMap.get(detail.category) ?? [];
    items.push({ label: detail.label, percentageOfPrompt: detail.percentageOfPrompt });
    categoryMap.set(detail.category, items);
    totalPercentage += detail.percentageOfPrompt;
  }

  if (totalPercentage < 100) {
    categoryMap.set('Uncategorized', [{ label: 'Other', percentageOfPrompt: 100 - totalPercentage }]);
  }

  const groups: ContextUsageDetailViewGroup[] = [];
  for (const [category, items] of categoryMap.entries()) {
    const visibleItems = items
      .map(item => ({
        label: item.label,
        contextPercentage: (item.percentageOfPrompt / 100) * percentage,
      }))
      .filter(item => item.contextPercentage >= 0.05);

    if (visibleItems.length === 0) {
      continue;
    }

    groups.push({ category, items: visibleItems });
  }

  return groups;
}

function buildContextUsageSummaryItems(
  snapshot: ChatContextUsageSnapshot,
): readonly ContextUsageSummaryViewItem[] {
  const items: ContextUsageSummaryViewItem[] = [
    {
      label: 'Prompt tokens',
      value: formatContextUsageTokenCount(snapshot.promptTokens, 1),
    },
    {
      label: 'Completion tokens',
      value: formatContextUsageTokenCount(snapshot.completionTokens, 1),
    },
    {
      label: 'Usage source',
      value: formatContextUsageSource(snapshot.source),
    },
  ];

  if (typeof snapshot.outputBuffer === 'number' && snapshot.outputBuffer > 0) {
    items.splice(2, 0, {
      label: 'Reserved for response',
      value: formatContextUsageTokenCount(snapshot.outputBuffer, 1),
    });
  }

  return items;
}

function formatContextUsageSource(
  source: ChatContextUsageSnapshot['source'],
): string {
  switch (source) {
    case 'provider-request':
      return 'Provider (request update)';
    case 'provider-turn-final':
      return 'Provider (turn final)';
    case 'estimate':
      return 'Estimated';
    default:
      return 'Provider';
  }
}
