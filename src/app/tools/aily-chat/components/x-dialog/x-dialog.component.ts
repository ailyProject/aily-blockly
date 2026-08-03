import {
  Optional,
  Component,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  EventEmitter,
  signal,
  SimpleChanges,
  ViewChild,
  ElementRef,
  AfterViewInit,
  AfterViewChecked,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  NgZone,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { XMarkdownComponent } from 'ngx-x-markdown';
import type { StreamingOption, ComponentMap } from 'ngx-x-markdown';
import { AilyChatCodeComponent } from './aily-chat-code.component';
import { ChatAPI } from '../../core/api-endpoints';
import { AilyHost } from '../../core/host';
import { ResourceItem } from '../../core/chat-types';
import type { ChatPart } from '../../core/chat-parts';
import {
  type DialogTurnContext,
} from '../../core/user-turn-action-target';
import type { ChatVisibleTranscriptDialogItem } from '../../core/chat-visible-transcript-model';
import type { ChatSelectedMode } from '../../core/chat-mode';
import {
  extractTurnRequestImageResources,
  extractUserTurnResources,
  mergeUserTurnResources,
  parseUserTurnTextAndResources,
} from '../../helpers/chat-user-turn-context';
import type { ChatTaskActionDetail } from '../../helpers/chat-task-action-coordinator';
import { ChatMessagePartsComponent } from './chat-message-parts.component';
import { ChatContextToolbarComponent } from '../chat-context-toolbar/chat-context-toolbar.component';
import { AilyMarkdownExternalLinksDirective } from '../../directives/aily-markdown-external-links.directive';
import type { Attachment, TurnResponseTurn } from 'aily-lex/browser';
import { collectTurnResponseText } from 'aily-lex/browser';
import {
  extractHistoricalDialogCopyText,
  preprocessHistoricalDialogContent,
} from './x-dialog-compat-content';
import {
  getTurnResponseAssistantText,
  getTurnResponseResponseText,
} from '../../core/turn-response-stream-contract';
import { buildRenderableProgressParts, type RenderableChatPart } from './chat-render-parts';
import { isInternalDiscoveryToolName, isTerminalSessionToolName } from '../../core/tool-name-normalizer';
import type { HostResponseVoteDirection } from '../../helpers/host-turn-response-state';
import { ChatRuntimeInteractionHostService } from '../../services/chat-runtime-interaction-host.service';
import type { WorkspaceCheckpointPresentationMode } from '../../services/edit-checkpoint.service';
import { ChatEngineService } from '../../services/chat-engine.service';
import { ChatUserImageAttachmentsComponent } from './chat-user-image-attachments.component';
import {
  appendMarkdownContent,
  getMarkdownContentLength,
  storeMarkdownContent,
} from '../../core/markdown-content-store';

const EMPTY_PROGRESS_MESSAGES: readonly NonNullable<TurnResponseTurn['response']['progressMessages']>[number][] = [];
const EMPTY_CONTENT_REFERENCES: readonly NonNullable<TurnResponseTurn['response']['contentReferences']>[number][] = [];
const EMPTY_CHAT_PARTS: readonly ChatPart[] = [];
const EMPTY_ATTACHMENTS: readonly Attachment[] = [];
const MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});
const MESSAGE_TIME_TITLE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});


@Component({
  selector: 'aily-x-dialog',
  templateUrl: './x-dialog.component.html',
  styleUrls: ['./x-dialog.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    NzToolTipModule,
    XMarkdownComponent,
    ChatMessagePartsComponent,
    ChatContextToolbarComponent,
    ChatUserImageAttachmentsComponent,
    AilyMarkdownExternalLinksDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class XDialogComponent implements OnChanges, AfterViewInit, AfterViewChecked, OnDestroy {
  @Input({ required: true }) item!: ChatVisibleTranscriptDialogItem;
  @Input() readOnly = false;
  @Input() workspaceCheckpointPresentationMode: WorkspaceCheckpointPresentationMode = 'unknown';
  /** 当前会话 ID */
  @Input() sessionId = '';
  @Input() currentMode = 'agent';
  @Input() currentCustomAgentTarget: string | undefined;
  @Input() currentModelName = '';
  /** 与主输入区一致的模型展示文案，PRU 下会附带当前配置描述。 */
  @Input() currentModelChipLabel = '';
  @Input() currentModelBillingLabel = '';
  @Input() isWaiting = false;
  @Input() selectedMode: Pick<ChatSelectedMode, 'modeId' | 'customAgentTarget'> | null | undefined;
  /** 全局互斥：当前允许展开编辑框的用户 turnId；与本条不一致时需收起（由父级统一传入） */
  @Input() exclusiveEditTurnId: string | undefined;
  @Input() showModeMenu = false;
  @Input() showModelMenu = false;

  @Output() editAndResend = new EventEmitter<{ target: DialogTurnContext; newText: string; resources: ResourceItem[] }>();
  /** 本消息进入编辑态时发出 turnId，供父级互斥 */
  @Output() editSessionOpened = new EventEmitter<string>();
  /** 用户在本条取消或提交编辑时发出，父级清除互斥态 */
  @Output() editSessionClosed = new EventEmitter<void>();
  /** 编辑区内点击会 stopPropagation，父级需主动收起模式/模型等会话菜单 */
  @Output() dismissSessionMenus = new EventEmitter<void>();
  @Output() editModeToggle = new EventEmitter<{ event: MouseEvent; type: 'mode' }>();
  @Output() editModelToggle = new EventEmitter<{ event: MouseEvent; type: 'model' }>();
  @Output() editAddFile = new EventEmitter<DialogTurnContext>();
  @Output() editAddFolder = new EventEmitter<DialogTurnContext>();
  @Output() taskAction = new EventEmitter<ChatTaskActionDetail>();
  @Input() contentHeightChangeHandler: ((change: ChatDialogItemHeightChange) => void) | undefined;

  @ViewChild('editTextarea') editTextareaRef?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('editInputBox') editInputBoxRef?: ElementRef<HTMLElement>;
  private messagePartsComponent?: ChatMessagePartsComponent;

  @ViewChild(ChatMessagePartsComponent)
  private set mountedMessagePartsComponent(component: ChatMessagePartsComponent | undefined) {
    this.messagePartsComponent = component;
    if (component && this.hasStructuredAilyContent) {
      component.contentDeltaHandler = () => this.handleStructuredContentDelta();
      this.patchMountedMessageParts(component);
    }
  }

  streamContent = signal('');
  streamingConfig = signal<StreamingOption>({ hasNextChunk: false, enableAnimation: false });
  readonly componentMap: ComponentMap = { code: AilyChatCodeComponent };

  /** 反馈状态 */
  feedbackState: 'helpful' | 'unhelpful' | null = null;

  // ===== 编辑模式 =====
  isEditing = false;
  editText = '';
  editResources: ResourceItem[] = [];
  showEditAddList = false;
  isViewportVisible = true;
  private lastRenderedContentHeight = 0;
  private lastEmittedItemHeight = 0;
  private visibilityObserver: IntersectionObserver | null = null;
  private contentResizeObserver: ResizeObserver | null = null;
  private contentDeltaFrameId: number | null = null;

  private _effectivePartsSource: readonly ChatPart[] = EMPTY_CHAT_PARTS;
  private _effectiveProgressMessagesSource: readonly NonNullable<TurnResponseTurn['response']['progressMessages']>[number][] = EMPTY_PROGRESS_MESSAGES;
  private _effectivePartsDoing = false;
  private _effectivePartsConfirmationActive = false;
  private _effectivePartsItemId = '';
  private _effectivePartsItemRef: ChatVisibleTranscriptDialogItem | null = null;
  private _effectivePartsCache = [] as RenderableChatPart[];
  private fallbackMarkdownProjection: {
    readonly itemId: string;
    readonly partId: string;
    readonly contentRef: string;
    readonly content: string;
    readonly part: ChatPart;
  } | null = null;
  private renderStateItemId: string | null = null;
  private hostTextDeltaVisibilityTurnId: string | null = null;
  private feedbackItemId: string | null = null;

  constructor(
    private cdr: ChangeDetectorRef,
    private hostElement: ElementRef<HTMLElement>,
    private ngZone: NgZone,
    @Optional() private runtimeInteractionHost: ChatRuntimeInteractionHostService | null = null,
    @Optional() private chatEngine: ChatEngineService | null = null,
  ) {}

  /** 在已进入编辑态之后通过 setTimeout 挂载，避免「点开编辑」的同一次点击误关 */
  private readonly editOutsideDocumentClickBound = (e: MouseEvent) => this.onEditOutsideDocumentClick(e);

  private onEditOutsideDocumentClick(event: MouseEvent): void {
    if (!this.isEditing) {
      return;
    }
    if (this.shouldKeepEditingForOutsideClick(event.target)) {
      return;
    }
    this.onCancelEdit();
  }

  private attachEditOutsideClickListener(): void {
    document.addEventListener('click', this.editOutsideDocumentClickBound, true);
  }

  private detachEditOutsideClickListener(): void {
    document.removeEventListener('click', this.editOutsideDocumentClickBound, true);
  }

  private scheduleAttachEditOutsideClickListener(): void {
    this.detachEditOutsideClickListener();
    setTimeout(() => {
      if (this.isEditing) {
        this.attachEditOutsideClickListener();
      }
    }, 0);
  }

  /** 编辑框根节点 stopPropagation，document 无法收到点击，需让父级关掉 app-menu */
  private dismissChatShellMenus(): void {
    this.dismissSessionMenus.emit();
  }

  get role(): string {
    return this.item.role;
  }

  get content(): string {
    return this.item.content;
  }

  get doing(): boolean {
    return this.item.doing;
  }

  get turnContext(): DialogTurnContext | null {
    return this.item.turnContext;
  }

  get turnResponse(): TurnResponseTurn | null {
    return this.item.turnResponse;
  }

  get userImageAttachments(): readonly Attachment[] {
    if (this.role !== 'user') {
      return EMPTY_ATTACHMENTS;
    }
    const attachments = this.effectiveTurnContext?.request?.attachments ?? EMPTY_ATTACHMENTS;
    return attachments.some(attachment => attachment.type === 'image')
      ? attachments
      : EMPTY_ATTACHMENTS;
  }

  get userImageAttachmentsOmittedByModel(): boolean {
    if (this.role !== 'user' || this.userImageAttachments.length === 0) {
      return false;
    }
    const modelId = this.effectiveTurnContext?.request?.modelId;
    return this.chatEngine?.resolveImageAttachmentCapabilitiesForModelId(modelId).status === 'unsupported';
  }

  get userImageContentReferences(): readonly NonNullable<TurnResponseTurn['response']['contentReferences']>[number][] {
    return this.role === 'user'
      ? this.effectiveTurnContext?.response?.contentReferences ?? EMPTY_CONTENT_REFERENCES
      : EMPTY_CONTENT_REFERENCES;
  }

  get isLastAily(): boolean {
    return this.item.isLastAily;
  }

  get isFirstUserTurn(): boolean {
    return this.item.isFirstUserTurn;
  }

  get turnModelName(): string {
    return this.item.turnModelName;
  }

  get turnModelBillingLabel(): string {
    return this.item.turnModelBillingLabel ?? '';
  }

  get responseVote(): HostResponseVoteDirection | undefined {
    return this.item.responseVote;
  }

  get parts(): readonly ChatPart[] {
    return this.item.parts;
  }

  /** 是否可显示操作栏（非 doing 的最后一条 aily 消息） */
  get canShowActions(): boolean {
    return !this.readOnly && this.isLastAily && !this.effectiveDoing && this.role === 'aily';
  }

  get canShowLimitActions(): boolean {
    return !this.readOnly && this.role !== 'user' && !this.effectiveDoing;
  }

  /** 是否渲染底部栏 DOM（非最后一条仅占位，hover 显影） */
  get shouldRenderFooter(): boolean {
    if (this.isEditing) {
      return false;
    }

    if (this.role === 'user') {
      return !!this.userCopyText || !!this.messageTimeLabel;
    }

    if (this.role !== 'aily' || this.effectiveDoing) {
      return false;
    }

    return this.canShowActions
      || this.canShowLimitActions
      || !!this.assistantModelBadgeLabel;
  }

  /** 非最后一条助手消息：底部栏 hover 淡入，避免 @if 撑开布局 */
  get hasHoverFooterFade(): boolean {
    return this.canShowLimitActions && !this.canShowActions;
  }

  get actionTurnId(): string | undefined {
    return this.effectiveTurnContext?.turnId;
  }

  get requestContent(): string | undefined {
    return this.effectiveTurnContext?.requestContent;
  }

  get displayContent(): string | undefined {
    return this.effectiveTurnContext?.displayContent;
  }

  get roundCount(): number {
    return this.effectiveTurnContext?.roundCount ?? 0;
  }

  get toolCallCount(): number {
    return this.effectiveTurnContext?.toolCallCount ?? 0;
  }

  get effectiveParts() {
    const response = this.effectiveTurnContext?.response;
    const itemParts = this.role === 'aily' ? this.parts : EMPTY_CHAT_PARTS;
    const progressMessages = response?.progressMessages ?? EMPTY_PROGRESS_MESSAGES;
    const doing = this.effectiveDoing;
    const hasActiveConfirmationCarousel = this.hasActiveConfirmationCarousel;
    const itemId = this.item.id;
    if (itemId === this._effectivePartsItemId
      && this.item === this._effectivePartsItemRef
      && itemParts === this._effectivePartsSource
      && progressMessages === this._effectiveProgressMessagesSource
      && doing === this._effectivePartsDoing
      && hasActiveConfirmationCarousel === this._effectivePartsConfirmationActive) {
      return this._effectivePartsCache;
    }

    this._effectivePartsItemId = itemId;
    this._effectivePartsItemRef = this.item;
    this._effectivePartsSource = itemParts;
    this._effectiveProgressMessagesSource = progressMessages;
    this._effectivePartsDoing = doing;
    this._effectivePartsConfirmationActive = hasActiveConfirmationCarousel;
    const visibleItemParts = filterTerminalOwnedToolCalls(itemParts.filter(isVisibleResponsePart));
    const assistantFallbackPart = this.createAssistantFallbackMarkdownPart(visibleItemParts);
    this._effectivePartsCache = [
      ...visibleItemParts,
      ...(assistantFallbackPart ? [assistantFallbackPart] : []),
      ...buildRenderableProgressParts(response, visibleItemParts, doing, hasActiveConfirmationCarousel),
    ];
    return this._effectivePartsCache;
  }

  private get hasActiveConfirmationCarousel(): boolean {
    return !!this.sessionId && !!this.runtimeInteractionHost?.getActiveConfirmation(this.sessionId);
  }

  get hasStructuredAilyContent(): boolean {
    return this.role === 'aily' && this.effectiveParts.length > 0;
  }

  get shouldRenderHeavyContent(): boolean {
    return this.isViewportVisible || this.shouldForceRenderHeavyContent;
  }

  get virtualizedPlaceholderHeight(): number {
    return Math.max(this.lastRenderedContentHeight || 0, this.role === 'user' ? 34 : 42);
  }

  get activityTurnResponse(): TurnResponseTurn | null {
    return this.effectiveTurnContext?.turnResponse ?? this.turnResponse;
  }

  get effectiveDoing(): boolean {
    const responseStatus = this.effectiveTurnContext?.response?.status;

    if (this.role === 'aily' && responseStatus) {
      return responseStatus === 'streaming';
    }

    return this.doing;
  }

  private get shouldForceRenderHeavyContent(): boolean {
    return this.isEditing
      || this.effectiveDoing
      || this.isLastAily
      || this.canRenderCheckpointAnchor
      || this.hasActiveConfirmationCarousel;
  }

  get assistantModelBadgeLabel(): string | null {
    const modelName = this.turnModelName;
    const billingLabel = this.turnModelBillingLabel;
    if (!modelName) {
      return null;
    }

    return billingLabel ? `${modelName} · ${billingLabel}` : modelName;
  }

  get showAssistantModelBadge(): boolean {
    return this.role === 'aily'
      && !this.effectiveDoing
      && !!this.assistantModelBadgeLabel
      && (this.canShowActions || this.canShowLimitActions);
  }

  get messageTimeLabel(): string | null {
    const timestamp = this.messageTimestampMs;
    return timestamp == null ? null : this.formatMessageTime(timestamp);
  }

  get messageTimeTitle(): string {
    const timestamp = this.messageTimestampMs;
    return timestamp == null ? '' : this.formatMessageTimeTitle(timestamp);
  }

  private get messageTimestampMs(): number | null {
    const turn = this.activityTurnResponse;
    if (!turn) {
      return null;
    }

    if (this.role === 'user') {
      return this.normalizeTimestampMs(turn.createdAt ?? turn.response?.createdAt);
    }

    if (this.role === 'aily' && !this.effectiveDoing) {
      return this.normalizeTimestampMs(
        turn.response?.updatedAt
          ?? turn.updatedAt
          ?? turn.response?.createdAt
          ?? turn.createdAt,
      );
    }

    return null;
  }

  private get userCopyText(): string {
    if (this.role !== 'user') {
      return '';
    }

    return this.renderableUserContent
      || this.requestContent
      || extractHistoricalDialogCopyText(this.content || '');
  }

  get assistantModelBadgeTitle(): string {
    const modelName = this.turnModelName;
    const billingLabel = this.turnModelBillingLabel;
    if (!modelName) {
      return '当前模型信息';
    }

    return billingLabel
      ? `当前模型: ${modelName}\n${this.isMultiplierBillingLabel(billingLabel) ? '计费倍率' : '计费信息'}: ${billingLabel}`
      : `当前模型: ${modelName}`;
  }

  private isMultiplierBillingLabel(label: string): boolean {
    return /^\s*(?:x\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*x)\s*$/i.test(label);
  }

  private normalizeTimestampMs(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    return null;
  }

  private formatMessageTime(timestamp: number): string {
    return MESSAGE_TIME_FORMATTER.format(new Date(timestamp));
  }

  private formatMessageTimeTitle(timestamp: number): string {
    return MESSAGE_TIME_TITLE_FORMATTER.format(new Date(timestamp));
  }

  get assistantTerminationLabel(): string | null {
    if (this.role !== 'aily' || this.effectiveDoing) {
      return null;
    }

    const reason = this.effectiveTerminationReason;
    if (!reason || reason === 'end_turn' || reason === 'stop') {
      return null;
    }

    return this.formatTerminationReason(reason);
  }

  get assistantTerminationTitle(): string {
    const reason = this.effectiveTerminationReason;
    if (!reason) {
      return '终止原因';
    }

    const status = this.effectiveResponseStatus;
    const statusLabel = status
      ? this.formatTerminationStatus(status)
      : '已结束';

    return `${statusLabel} · ${this.formatTerminationReason(reason)}\n原始原因: ${reason}`;
  }

  get canRenderCheckpointAnchor(): boolean {
    return !this.readOnly
      && this.role === 'user'
      && !!this.actionTurnId
      && !this.isCheckpointWorkspaceUnavailable;
  }
  
  get isCurrentStreamingResponse(): boolean {
    return this.role === 'aily' && this.isLastAily && this.effectiveDoing;
  }

  /** 是否可编辑用户消息（非 doing 的 user 消息） */
  get canEditUserMessage(): boolean {
    return !this.readOnly && this.role === 'user' && !this.effectiveDoing && !this.isWaiting && !!this.actionTurnId && !this.isRequestDisabled;
  }

  get isRequestDisabled(): boolean {
    return this.effectiveTurnContext?.requestDisabled === true;
  }

  get checkpointActionDisabled(): boolean {
    return this.isRequestDisabled || this.isCheckpointWorkspaceUnavailable;
  }

  get forkSessionActionDisabled(): boolean {
    return this.isRequestDisabled || this.isCheckpointWorkspaceUnavailable;
  }

  get regenerateActionDisabled(): boolean {
    return this.isRequestDisabled;
  }

  get editTooltipTitle(): string {
    if (!this.canEditUserMessage || this.isEditing) {
      return '';
    }

    const metadataLabel = this.userTurnMetadataLabel;
    const previewLabel = this.actionTurnPreviewLabel;
    if (metadataLabel && previewLabel) {
      return `点击编辑 · ${metadataLabel} · ${previewLabel}`;
    }
    if (metadataLabel) {
      return `点击编辑 · ${metadataLabel}`;
    }
    return previewLabel ? `点击编辑 · ${previewLabel}` : '点击编辑';
  }

  get isCheckpointWorkspaceUnavailable(): boolean {
    return this.workspaceCheckpointPresentationMode !== 'git'
      && this.workspaceCheckpointPresentationMode !== 'timeline';
  }

  get checkpointActionLabel(): string {
    return this.isFirstUserTurn
      ? '重新开始'
      : this.roundCount > 0
        ? `还原检查点 · ${this.roundCount} 轮`
        : '还原检查点';
  }

  get checkpointActionShortLabel(): string {
    if (this.isFirstUserTurn) {
      return '重新开始';
    }
    if (this.roundCount > 0) {
      return `还原 · ${this.roundCount} 轮`;
    }
    return '还原检查点';
  }

  get checkpointActionIconClass(): string {
    return this.isFirstUserTurn ? 'fa-arrow-rotate-left' : 'fa-clock-rotate-left';
  }

  get forkSessionActionLabel(): string {
    return '分叉新会话';
  }

  get checkpointActionTitle(): string {
    if (this.isCheckpointWorkspaceUnavailable) {
      return '当前工作区 checkpoint 尚未就绪，不能执行检查点恢复、重新开始或历史分叉。';
    }

    if (this.isFirstUserTurn) {
      return '清空当前对话并撤销全部更改';
    }

    if (this.checkpointActionDisabled) {
      return '该请求已成为失活的历史边界，不能再次作为活动检查点使用；工作区是否还能恢复，请以单独的恢复入口状态为准';
    }

    const hints: string[] = [];
    const previewTitle = this.actionTurnPreviewTitle;
    if (previewTitle) {
      hints.push(`当前可见请求“${previewTitle}”`);
    }
    if (this.roundCount > 0) {
      hints.push(`关联 ${this.roundCount} 轮执行记录`);
    }
    if (this.toolCallCount > 0) {
      hints.push(`累计 ${this.toolCallCount} 次工具调用`);
    }
    if (this.hasAdditionalTurnContext) {
      hints.push('该轮请求包含额外上下文');
    }

    return hints.length > 0 ? hints.join('，') : '还原到该轮检查点';
  }

  get forkSessionActionTitle(): string {
    if (this.isCheckpointWorkspaceUnavailable) {
      return '当前工作区 checkpoint 尚未就绪，不能创建带有工作区检查点边界的新会话。';
    }

    if (this.forkSessionActionDisabled) {
      return '该请求已失活，不能再从这里分叉新会话；这只影响聊天历史操作，工作区恢复状态请看单独的恢复入口';
    }

    const previewTitle = this.actionTurnPreviewTitle;
    if (previewTitle) {
      return `创建一个新会话，并从“${previewTitle}”这条请求重新开始`;
    }

    return '创建一个新会话，并从该请求重新开始';
  }

  get userTurnMetadataLabel(): string | null {
    if (this.role !== 'user' || !this.actionTurnId) {
      return null;
    }

    const labels: string[] = [];
    if (this.roundCount > 0) {
      labels.push(`${this.roundCount} 轮`);
    }
    if (this.toolCallCount > 0) {
      labels.push(`${this.toolCallCount} 调用`);
    }
    if (this.hasAdditionalTurnContext) {
      labels.push('含上下文');
    }

    return labels.length > 0 ? labels.join(' · ') : null;
  }

  get disabledRequestBadgeLabel(): string | null {
    if (!this.isRequestDisabled) {
      return null;
    }

    return this.role === 'user' ? '已还原' : '已失活';
  }

  get disabledRequestBadgeTitle(): string {
    if (!this.isRequestDisabled) {
      return '';
    }

    if (this.role === 'user') {
      return '该请求已经被还原到更早的检查点之后，当前只保留历史展示，不再作为活动请求参与后续聊天操作；工作区是否还能恢复，请以单独的恢复入口状态为准。';
    }

    return '该响应所属请求已经失活；当前仅保留历史展示，不能继续重新执行。工作区是否还能恢复，请以单独的恢复入口状态为准。';
  }

  get editContextHint(): string | null {
    if (!this.isEditing || this.role !== 'user' || !this.actionTurnId) {
      return null;
    }

    const hints: string[] = [];
    const previewTitle = this.actionTurnPreviewTitle;
    if (previewTitle) {
      hints.push(`当前可见请求为“${previewTitle}”。`);
    }
    if (this.roundCount > 0) {
      hints.push(`该轮已记录 ${this.roundCount} 轮执行历史。`);
    }
    if (this.toolCallCount > 0) {
      hints.push(`该轮累计触发了 ${this.toolCallCount} 次工具调用。`);
    }
    if (this.hasAdditionalTurnContext) {
      hints.push('该轮请求还包含额外上下文，编辑时仍以当前可见内容和已附加资源为准。');
    }

    return hints.length > 0 ? hints.join(' ') : null;
  }

  get regenerateActionTitle(): string {
    if (this.regenerateActionDisabled) {
      return '该请求已失活，不能重新执行；这只影响聊天历史操作，工作区恢复状态请看单独的恢复入口';
    }

    const preview = this.buildPreviewText(
      this.effectiveTurnContext?.request?.displayContent
        ?? this.effectiveTurnContext?.displayContent
        ?? this.effectiveTurnContext?.request?.content
        ?? this.effectiveTurnContext?.requestContent,
      48,
    );
    if (!preview) {
      return '重试';
    }

    const detail = this.effectiveTurnContext?.roundCount ?? 0;

    return detail > 0
      ? `重新执行“${preview}” · ${detail} 轮`
      : `重新执行“${preview}”`;
  }

  onRegenerate(): void {
    const target = this.effectiveTurnContext;
    if (this.regenerateActionDisabled) {
      return;
    }
    const detail: ChatTaskActionDetail = target
      ? { action: 'regenerate', target }
      : { action: 'regenerate' };
    this.taskAction.emit(detail);
  }

  onRestoreCheckpoint(): void {
    const target = this.effectiveTurnContext;
    if (!target || this.checkpointActionDisabled) return;
    const detail: ChatTaskActionDetail = {
      action: 'restoreCheckpoint',
      target,
      sessionResource: this.sessionId,
    };
    this.taskAction.emit(detail);
  }

  onForkSession(): void {
    const target = this.effectiveTurnContext;
    if (!target || this.forkSessionActionDisabled) return;
    const detail: ChatTaskActionDetail = {
      action: 'forkSession',
      target,
      sessionResource: this.sessionId,
    };
    this.taskAction.emit(detail);
  }

  onCopyContent(): void {
    if (this.role === 'user') {
      void this.writeClipboardText(this.userCopyText);
      return;
    }

    const turnText = this.effectiveTurnContext?.response
      ? getTurnResponseResponseText(this.effectiveTurnContext.response)
      : (this.effectiveTurnContext?.turnResponse
        ? getTurnResponseAssistantText(this.effectiveTurnContext.turnResponse)
        : '');
    const text = turnText || extractHistoricalDialogCopyText(this.content || '');
    void this.writeClipboardText(text);
  }

  private async writeClipboardText(text: string): Promise<void> {
    if (!text) {
      return;
    }

    const host = getOptionalAilyHost();
    const hostClipboard = host?.clipboard;
    const electronClipboard = (window as any)['electronAPI']?.clipboard ?? (window as any)['clipboard'];

    try {
      if (hostClipboard?.writeText) {
        await Promise.resolve(hostClipboard.writeText(text));
        return;
      }

      if (electronClipboard?.writeText) {
        await Promise.resolve(electronClipboard.writeText(text));
        return;
      }

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }

      if (this.writeClipboardTextWithTextarea(text)) {
        return;
      }

      throw new Error('No clipboard writer available');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      host?.log?.warn?.(`[AilyChat] Copy response failed: ${message}`);
    }
  }

  private writeClipboardTextWithTextarea(text: string): boolean {
    if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
      return false;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';

    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    try {
      return document.execCommand('copy');
    } finally {
      document.body.removeChild(textarea);
    }
  }

  onFeedback(feedback: 'helpful' | 'unhelpful'): void {
    if (this.feedbackState === feedback) return;
    this.feedbackState = feedback;
    const target = this.effectiveTurnContext;
    const vote = feedback === 'helpful' ? 1 : 0;
    if (target) {
      const detail: ChatTaskActionDetail = { action: 'voteResponse', target, vote };
      this.taskAction.emit(detail);
    }

    if (!this.sessionId) {
      return;
    }

    AilyHost.get().auth.getToken!().then(token => {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      fetch(`${ChatAPI.conversationFeedback}/${this.sessionId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ feedback }),
      }).catch(() => {});
    }).catch(() => {});
  }

  private mapVoteToFeedbackState(vote: HostResponseVoteDirection | undefined): 'helpful' | 'unhelpful' | null {
    return vote === 1 ? 'helpful' : vote === 0 ? 'unhelpful' : null;
  }

  private syncFeedbackStateFromItem(): void {
    const itemId = this.item.id;
    if (this.feedbackItemId === itemId) {
      return;
    }

    this.feedbackItemId = itemId;
    this.feedbackState = this.mapVoteToFeedbackState(this.responseVote);
  }

  // ===== 编辑模式操作 =====

  /** 点击用户消息进入编辑模式 */
  onUserMessageClick(): void {
    if (!this.canEditUserMessage || this.isEditing) return;
    const { text, resources } = parseUserTurnTextAndResources(this.renderableUserContent);
    const requestResources = extractUserTurnResources(this.requestContent);
    const imageResources = extractTurnRequestImageResources(
      this.effectiveTurnContext?.request?.attachments,
    );
    this.editText = text;
    this.editResources = mergeUserTurnResources(
      mergeUserTurnResources(resources, requestResources),
      imageResources,
    );
    this.showEditAddList = false;
    this.isEditing = true;
    this.scheduleAttachEditOutsideClickListener();
    const tid = this.actionTurnId;
    if (tid) {
      this.editSessionOpened.emit(tid);
    }
    // 下一帧再 focus，确保 @if (isEditing) 已渲染出 textarea
    setTimeout(() => this.editTextareaRef?.nativeElement?.focus(), 0);
  }

  onCancelEdit(): void {
    const wasEditing = this.isEditing;
    this.dismissChatShellMenus();
    this.detachEditOutsideClickListener();
    this.isEditing = false;
    this.editText = '';
    this.editResources = [];
    this.showEditAddList = false;
    if (wasEditing) {
      this.editSessionClosed.emit();
    }
  }

  onSubmitEdit(): void {
    const trimmed = this.editText.trim();
    const target = this.effectiveTurnContext;
    if (!trimmed || !target) return;
    this.dismissChatShellMenus();
    this.detachEditOutsideClickListener();
    this.isEditing = false;
    this.editAndResend.emit({
      target,
      newText: trimmed,
      resources: [...this.editResources],
    });
    this.editText = '';
    this.editResources = [];
    this.showEditAddList = false;
    this.editSessionClosed.emit();
  }

  onEditAddFileRequest(): void {
    const target = this.effectiveTurnContext;
    if (!target) {
      return;
    }

    this.editAddFile.emit(target);
  }

  onEditAddFolderRequest(): void {
    const target = this.effectiveTurnContext;
    if (!target) {
      return;
    }

    this.editAddFolder.emit(target);
  }

  onEditKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.onCancelEdit();
    } else if (event.key === 'Enter' && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      this.onSubmitEdit();
    } else if (event.key === 'Enter' && event.ctrlKey) {
      // Ctrl+Enter 换行
      const textarea = event.target as HTMLTextAreaElement;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      this.editText = this.editText.substring(0, start) + '\n' + this.editText.substring(end);
      setTimeout(() => { textarea.selectionStart = textarea.selectionEnd = start + 1; }, 0);
      event.preventDefault();
    }
  }

  onEditRemoveResource(index: number): void {
    if (index >= 0 && index < this.editResources.length) {
      this.editResources.splice(index, 1);
    }
  }

  onEditToggleAddList(): void {
    this.showEditAddList = !this.showEditAddList;
  }

  /** 互斥：其它消息打开编辑时收起本条，不向父级发 closed（避免清掉新的 active） */
  private forceCloseEditFromExclusiveLock(): void {
    if (!this.isEditing) {
      return;
    }
    this.dismissChatShellMenus();
    this.detachEditOutsideClickListener();
    this.isEditing = false;
    this.editText = '';
    this.editResources = [];
    this.showEditAddList = false;
    this.cdr.markForCheck();
  }

  /** 点击在编辑壳层、会话级菜单或 ng-zorro 浮层上时不因「点外部」收起 */
  private shouldKeepEditingForOutsideClick(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) {
      return true;
    }
    const box = this.editInputBoxRef?.nativeElement;
    if (box?.contains(target)) {
      return true;
    }
    if (target instanceof Element) {
      if (target.closest('.menu-container')) {
        return true;
      }
      if (target.closest('.ant-tooltip, .ant-popover, .ant-dropdown, .ant-picker-dropdown, .cdk-overlay-container')) {
        return true;
      }
    }
    return false;
  }

  /** 从父组件接收添加的文件资源 */
  addEditResource(item: ResourceItem): void {
    const exists = this.editResources.some(r =>
      r.type === item.type && (r.path === item.path || r.url === item.url)
    );
    if (!exists) {
      this.editResources.push(item);
      this.cdr.markForCheck();
    }
  }

  private get hasAdditionalTurnContext(): boolean {
    if (this.role !== 'user' || !this.actionTurnId) {
      return false;
    }

    const request = this.normalizeComparisonText(this.requestContent);
    if (!request) {
      return false;
    }

    return request !== this.normalizeComparisonText(this.renderableUserContent);
  }

  private normalizeComparisonText(content: string | undefined): string {
    return (content ?? '').replace(/\r\n/g, '\n').trim();
  }

  private get actionTurnPreviewLabel(): string | null {
    if (!this.hasAdditionalTurnContext) {
      return null;
    }

    return this.buildPreviewText(this.renderableUserContent, 24);
  }

  private get actionTurnPreviewTitle(): string | null {
    return this.buildPreviewText(this.renderableUserContent, 80);
  }

  private buildPreviewText(content: string | undefined, maxLength: number): string | null {
    const normalized = this.normalizeComparisonText(content).replace(/\s+/g, ' ');
    if (!normalized) {
      return null;
    }

    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength).trimEnd()}...`
      : normalized;
  }

  private get effectiveTurnContext(): DialogTurnContext | null {
    return this.turnContext;
  }

  private get renderableUserContent(): string {
    const context = this.effectiveTurnContext;
    if (!this.isBlankContent(context?.displayContent)) {
      return context?.displayContent ?? '';
    }
    if (!this.isBlankContent(context?.request?.displayContent)) {
      return context?.request?.displayContent ?? '';
    }
    if (!this.isBlankContent(this.content)) {
      return this.content;
    }

    return context?.requestContent
      ?? context?.request?.content
      ?? '';
  }

  private get renderableFallbackContent(): string {
    return this.role === 'user'
      ? this.renderableUserContent
      : this.renderableAssistantFallbackContent;
  }

  private get renderableAssistantFallbackContent(): string {
    const response = this.effectiveTurnContext?.response;
    if (response) {
      return getTurnResponseResponseText(response);
    }

    const turnResponse = this.effectiveTurnContext?.turnResponse ?? this.turnResponse;
    return turnResponse ? getTurnResponseAssistantText(turnResponse) : '';
  }

  private createAssistantFallbackMarkdownPart(visibleItemParts: readonly ChatPart[]): ChatPart | null {
    if (this.role !== 'aily') {
      return null;
    }

    if (visibleItemParts.some(part => part.type === 'markdown')) {
      return null;
    }

    const content = preprocessHistoricalDialogContent(this.renderableAssistantFallbackContent);
    if (this.isBlankContent(content)) {
      this.fallbackMarkdownProjection = null;
      return null;
    }

    const itemId = this.item.id;
    const partId = `fallback-markdown:${itemId}`;
    const contentRef = `visible-fallback-markdown:${itemId}`;
    const previous = this.fallbackMarkdownProjection;
    if (!previous || previous.itemId !== itemId || previous.partId !== partId || previous.contentRef !== contentRef) {
      storeMarkdownContent(contentRef, content);
    } else if (content !== previous.content) {
      if (content.startsWith(previous.content)) {
        appendMarkdownContent(contentRef, content.slice(previous.content.length));
      } else {
        storeMarkdownContent(contentRef, content);
      }
    }

    const part: ChatPart = {
      type: 'markdown',
      partId,
      content: this.effectiveDoing ? '' : content,
      contentRef,
      contentLength: getMarkdownContentLength(contentRef),
      sourceAgentRole: 'main',
      sequence: Number.MAX_SAFE_INTEGER - 1,
    };
    this.fallbackMarkdownProjection = {
      itemId,
      partId,
      contentRef,
      content,
      part,
    };
    return part;
  }

  private isBlankContent(content: string | null | undefined): boolean {
    return typeof content !== 'string' || content.trim().length === 0;
  }

  private get effectiveResponseStatus(): TurnResponseTurn['response']['status'] | undefined {
    return this.effectiveTurnContext?.response?.status;
  }

  private get effectiveTerminationReason(): TurnResponseTurn['response']['terminationReason'] | undefined {
    return this.effectiveTurnContext?.response?.terminationReason;
  }

  private formatTerminationStatus(status: TurnResponseTurn['response']['status']): string {
    switch (status) {
      case 'cancelled':
        return '已取消';
      case 'error':
        return '失败';
      case 'completed':
        return '已完成';
      case 'streaming':
        return '进行中';
      default:
        return status;
    }
  }

  private formatTerminationReason(reason: string): string {
    switch (reason) {
      case 'cancelled_by_user':
        return '用户取消';
      case 'cancelled_by_new_turn':
        return '新对话中断';
      case 'cancelled_by_handoff':
        return '切换代理中断';
      case 'aborted':
        return '执行中止';
      case 'max_iterations':
        return '达到轮次上限';
      case 'hook_blocked':
        return '被规则阻止';
      case 'validation_retry_exhausted':
        return '重试耗尽';
      case 'model_error':
        return '模型错误';
      default:
        return reason;
    }
  }

  private lastRaw = '';

  private createStreamingConfig(enableAnimation: boolean): StreamingOption {
    return {
      hasNextChunk: this.effectiveDoing,
      enableAnimation,
      // Match VS Code's IncrementalDOMMorpher default: active markdown is
      // committed at stable block boundaries instead of reparsing the full
      // growing document for every host revision.
      buffering: 'paragraph',
      impliedWordLoadRate: this.item.contentUpdateTimings?.impliedWordLoadRate,
    };
  }

  private syncStreamingConfig(enableAnimation: boolean): void {
    const next = this.createStreamingConfig(enableAnimation);
    const current = this.streamingConfig();
    if (current.hasNextChunk === next.hasNextChunk
      && current.enableAnimation === next.enableAnimation
      && current.buffering === next.buffering
      && current.impliedWordLoadRate === next.impliedWordLoadRate) {
      return;
    }
    this.streamingConfig.set(next);
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['exclusiveEditTurnId'] && this.isEditing && this.actionTurnId) {
      const excl = this.exclusiveEditTurnId;
      if (excl != null && excl !== this.actionTurnId) {
        this.forceCloseEditFromExclusiveLock();
      }
    }

    if (changes['item']) {
      this.syncRowLocalStateFromItemId();
      this.syncFeedbackStateFromItem();
      this.syncHostTextDeltaVisibility();
      if (!this.shouldRenderHeavyContent) {
        this.syncStreamingConfig(false);
        return;
      }

      // ★ Phase 2: aily 消息统一走 Part-based 渲染
      if (this.hasStructuredAilyContent) {
        this.syncStreamingConfig(this.effectiveDoing);
        return;
      }

      // User 消息 & fallback：预处理后由 x-markdown 渲染
      const content = this.renderableFallbackContent;
      this.syncStreamingConfig(this.effectiveDoing);
      const processed = preprocessHistoricalDialogContent(content);
      if (processed !== this.lastRaw) {
        this.lastRaw = processed;
        this.streamContent.set(processed);
      }
    }
  }

  applyVisibleTranscriptItemPatch(
    nextItem: ChatVisibleTranscriptDialogItem,
    options?: {
      readonly detectChanges?: boolean;
      readonly changedParts?: readonly ChatPart[];
      readonly changedPartIndices?: readonly number[];
    },
  ): boolean {
    if (!nextItem || nextItem.id !== this.item?.id) {
      return false;
    }

    this.item = nextItem;
    if (options?.detectChanges === false) {
      if (this.hasStructuredAilyContent) {
        return this.messagePartsComponent
          ? this.patchMountedMessageParts(
              this.messagePartsComponent,
              options?.changedParts,
              options?.changedPartIndices,
            )
          : true;
      }
      return true;
    }

    this.syncRowLocalStateFromItemId();
    this.syncFeedbackStateFromItem();
    this.syncHostTextDeltaVisibility();
    if (!this.shouldRenderHeavyContent) {
      this.syncStreamingConfig(false);
      this.cdr.detectChanges();
      return true;
    }

    if (this.hasStructuredAilyContent) {
      this.syncStreamingConfig(this.effectiveDoing);
      if (this.messagePartsComponent) {
        this.patchMountedMessageParts(
          this.messagePartsComponent,
          options?.changedParts,
          options?.changedPartIndices,
        );
      }
      // The part renderer owns only the mounted part subtree. Row chrome such
      // as footer model/billing metadata, completion time, feedback, and
      // lifecycle classes belongs to this stable list item and must consume
      // the same item revision even when the part delta was applied directly.
      this.cdr.detectChanges();
      return true;
    }

    const content = this.renderableFallbackContent;
    this.syncStreamingConfig(this.effectiveDoing);
    const processed = preprocessHistoricalDialogContent(content);
    if (processed !== this.lastRaw) {
      this.lastRaw = processed;
      this.streamContent.set(processed);
    }
    this.cdr.detectChanges();
    return true;
  }

  private patchMountedMessageParts(
    component: ChatMessagePartsComponent,
    changedParts?: readonly ChatPart[],
    changedPartIndices?: readonly number[],
  ): boolean {
    return component.applyVisiblePartsPatch({
      parts: this.effectiveParts,
      changedParts,
      changedPartIndices,
      doing: this.effectiveDoing,
      sessionId: this.sessionId,
      turnResponse: this.activityTurnResponse,
      impliedWordLoadRate: this.item.contentUpdateTimings?.impliedWordLoadRate,
      detailProjectionEnabled: this.isViewportVisible,
    });
  }

  applySessionRequestState(requestInProgress: boolean): void {
    if (this.isWaiting === requestInProgress) {
      return;
    }
    this.isWaiting = requestInProgress;
    this.cdr.detectChanges();
  }

  ngAfterViewInit(): void {
    this.observeViewportVisibility();
    this.observeContentHeight();
    this.syncHostTextDeltaVisibility();
  }

  ngAfterViewChecked(): void { }

  ngOnDestroy(): void {
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    this.contentResizeObserver?.disconnect();
    this.contentResizeObserver = null;
    this.cancelScheduledContentDelta();
    this.syncHostTextDeltaVisibility(true);
    this.detachEditOutsideClickListener();
    if (this.isEditing) {
      this.editSessionClosed.emit();
    }
  }

  private syncRowLocalStateFromItemId(): void {
    const itemId = this.item.id;
    if (this.renderStateItemId === itemId) {
      return;
    }

    this.renderStateItemId = itemId;
    this._effectivePartsItemId = '';
    this._effectivePartsItemRef = null;
    this._effectivePartsSource = EMPTY_CHAT_PARTS;
    this._effectiveProgressMessagesSource = EMPTY_PROGRESS_MESSAGES;
    this._effectivePartsDoing = false;
    this._effectivePartsConfirmationActive = false;
    this._effectivePartsCache = [];
    this.fallbackMarkdownProjection = null;
    this.lastRaw = '';
    this.streamContent.set('');
    this.lastRenderedContentHeight = 0;
    this.lastEmittedItemHeight = 0;
    this.forceCloseEditFromExclusiveLock();
  }

  private observeViewportVisibility(): void {
    if (typeof IntersectionObserver === 'undefined') {
      this.isViewportVisible = true;
      return;
    }

    const host = this.hostElement.nativeElement;
    const root = host.closest('.dialog-list') as HTMLElement | null;
    this.ngZone.runOutsideAngular(() => {
      this.visibilityObserver = new IntersectionObserver(entries => {
        const entry = entries[0];
        if (!entry) {
          return;
        }

        const nextVisible = entry.isIntersecting || this.shouldForceRenderHeavyContent;
        if (nextVisible === this.isViewportVisible) {
          return;
        }

        this.ngZone.run(() => {
          this.isViewportVisible = nextVisible;
          this.syncHostTextDeltaVisibility();
          if (nextVisible) {
            this.refreshRenderableContent();
          }
          this.cdr.markForCheck();
        });
      }, {
        root,
        rootMargin: '900px 0px',
        threshold: 0,
      });
      this.visibilityObserver.observe(host);
    });
  }

  private syncHostTextDeltaVisibility(forceVisible?: boolean): void {
    if (!this.chatEngine) {
      return;
    }

    const turnId = this.role === 'aily' ? this.activityTurnResponse?.turnId : undefined;
    if (this.hostTextDeltaVisibilityTurnId && this.hostTextDeltaVisibilityTurnId !== turnId) {
      this.chatEngine.setTurnHostTextDeltaVisibility(this.hostTextDeltaVisibilityTurnId, true);
      this.hostTextDeltaVisibilityTurnId = null;
    }

    if (!turnId) {
      return;
    }

    const visible = forceVisible ?? this.shouldRenderHeavyContent;
    this.chatEngine.setTurnHostTextDeltaVisibility(turnId, visible);
    this.hostTextDeltaVisibilityTurnId = turnId;
  }

  private observeContentHeight(): void {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const element = this.hostElement.nativeElement;

    this.ngZone.runOutsideAngular(() => {
      this.contentResizeObserver = new ResizeObserver(entries => {
        const entry = entries[0];
        const height = entry?.contentRect?.height ?? 0;
        if (!this.shouldRenderHeavyContent || height <= 0) {
          return;
        }
        const nextHeight = Math.ceil(height);
        if (nextHeight === this.lastRenderedContentHeight) {
          return;
        }
        this.lastRenderedContentHeight = nextHeight;
        this.emitMeasuredContentDelta(nextHeight);
      });
      this.contentResizeObserver.observe(element);
    });
  }

  handleStructuredContentDelta(): void {
    // ResizeObserver is the row-height authority. Nested part notifications do
    // not need a second measurement frame when the observer is available.
    if (this.contentResizeObserver) {
      return;
    }
    this.scheduleContentDelta();
  }

  private emitMeasuredContentDelta(height: number): void {
    if (!this.shouldRenderHeavyContent || height <= 0 || height === this.lastEmittedItemHeight) {
      return;
    }
    this.lastEmittedItemHeight = height;
    this.contentHeightChangeHandler?.({ itemId: this.item.id, height });
  }

  private scheduleContentDelta(): void {
    if (this.contentDeltaFrameId !== null) {
      return;
    }

    const emit = () => {
      this.contentDeltaFrameId = null;
      if (this.shouldRenderHeavyContent) {
        const height = Math.ceil(this.hostElement.nativeElement.getBoundingClientRect().height || 0);
        this.emitMeasuredContentDelta(height);
      }
    };

    if (typeof globalThis.requestAnimationFrame === 'function') {
      this.contentDeltaFrameId = globalThis.requestAnimationFrame(emit);
      return;
    }

    this.contentDeltaFrameId = setTimeout(emit, 16) as unknown as number;
  }

  private cancelScheduledContentDelta(): void {
    if (this.contentDeltaFrameId === null) {
      return;
    }
    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.contentDeltaFrameId);
    } else {
      clearTimeout(this.contentDeltaFrameId as unknown as ReturnType<typeof setTimeout>);
    }
    this.contentDeltaFrameId = null;
  }

  private refreshRenderableContent(): void {
    this.syncStreamingConfig(this.effectiveDoing);
    if (this.hasStructuredAilyContent) {
      return;
    }

    const processed = preprocessHistoricalDialogContent(this.renderableFallbackContent);
    if (processed !== this.lastRaw) {
      this.lastRaw = processed;
      this.streamContent.set(processed);
    }
  }
}

function isVisibleResponsePart(part: ChatPart): boolean {
  if (part.type === 'tool_call' && isInternalDiscoveryToolName(part.toolName)) {
    return false;
  }

  if (part.type !== 'markdown' && part.type !== 'thinking') {
    return true;
  }

  const content = typeof part.content === 'string' ? part.content : '';
  const contentRef = typeof part.contentRef === 'string' ? part.contentRef.trim() : '';
  const contentLength = typeof part.contentLength === 'number' && Number.isFinite(part.contentLength)
    ? part.contentLength
    : 0;
  return content.trim().length > 0 || contentRef.length > 0 || contentLength > 0;
}

export interface ChatDialogItemHeightChange {
  readonly itemId: string;
  readonly height: number;
}

function filterTerminalOwnedToolCalls(parts: readonly ChatPart[]): ChatPart[] {
  const terminalOwners = collectTerminalPartOwners(parts);
  if (terminalOwners.toolCallIds.size === 0 && terminalOwners.sessionIds.size === 0) {
    return [...parts];
  }

  return parts.filter(part => {
    if (part.type !== 'tool_call' || !isTerminalSessionToolName(part.toolName)) {
      return true;
    }

    if (terminalOwners.toolCallIds.has(part.toolCallId)) {
      return false;
    }

    const args = toObjectRecord(part.args);
    const metadata = toObjectRecord(part.metadata);
    const sessionIds = [
      readString(args?.['processId']),
      readString(args?.['outputSessionId']),
      readString(args?.['terminalId']),
      readString(args?.['id']),
      readString(metadata?.['processId']),
      readString(metadata?.['outputSessionId']),
      readString(metadata?.['terminalId']),
      readString(metadata?.['id']),
    ].filter((value): value is string => !!value);

    return !sessionIds.some(sessionId => terminalOwners.sessionIds.has(sessionId));
  });
}

function collectTerminalPartOwners(parts: readonly ChatPart[]): { toolCallIds: Set<string>; sessionIds: Set<string> } {
  const toolCallIds = new Set<string>();
  const sessionIds = new Set<string>();

  for (const part of parts) {
    if (part.type !== 'terminal') {
      continue;
    }

    if (part.toolCallId) {
      toolCallIds.add(part.toolCallId);
    }
    for (const sourceToolCallId of part.sourceToolCallIds ?? []) {
      if (sourceToolCallId) {
        toolCallIds.add(sourceToolCallId);
      }
    }
    for (const sessionId of [part.processId, part.outputSessionId, part.terminalId]) {
      if (sessionId) {
        sessionIds.add(sessionId);
      }
    }
  }

  return { toolCallIds, sessionIds };
}

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getOptionalAilyHost(): ReturnType<typeof AilyHost.get> | null {
  try {
    return AilyHost.get();
  } catch {
    return null;
  }
}
