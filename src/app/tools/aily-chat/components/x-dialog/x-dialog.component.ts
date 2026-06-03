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
  AfterViewChecked,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
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
import {
  buildDialogTurnContext,
  type DialogTurnContext,
} from '../../core/user-turn-action-target';
import { extractUserTurnResources, mergeUserTurnResources, parseUserTurnTextAndResources } from '../../helpers/chat-user-turn-context';
import type { ChatTaskActionDetail } from '../../helpers/chat-task-action-coordinator';
import { ChatMessagePartsComponent } from './chat-message-parts.component';
import { ChatContextToolbarComponent } from '../chat-context-toolbar/chat-context-toolbar.component';
import type { TurnResponsePart, TurnResponseTurn } from 'aily-lex/browser';
import { collectTurnResponseText } from 'aily-lex/browser';
import {
  extractHistoricalDialogCopyText,
  preprocessHistoricalDialogContent,
} from './x-dialog-compat-content';
import {
  getTurnResponseAssistantText,
  getTurnResponseResponseText,
} from '../../core/turn-response-stream-contract';
import { turnResponsePartToChatPart } from '../../core/turn-response-part-mapper';
import { buildRenderableProgressParts, type RenderableChatPart } from './chat-render-parts';
import type { HostResponseVoteDirection } from '../../helpers/host-turn-response-state';
import { ChatRuntimeInteractionHostService } from '../../services/chat-runtime-interaction-host.service';
import type { WorkspaceCheckpointPresentationMode } from '../../services/edit-checkpoint.service';

const EMPTY_TURN_PARTS: readonly TurnResponsePart[] = [];
const EMPTY_PROGRESS_MESSAGES: readonly NonNullable<TurnResponseTurn['response']['progressMessages']>[number][] = [];


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
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class XDialogComponent implements OnChanges, AfterViewChecked, OnDestroy {
  @Input() role = 'user';
  @Input() content = '';
  @Input() doing = false;
  @Input() readOnly = false;
  /** 当前消息对应的 turn-native 容器 */
  @Input()
  set turnResponse(value: TurnResponseTurn | null) {
    this._turnResponse = value;
    this.refreshCompatTurnContext();
  }

  get turnResponse(): TurnResponseTurn | null {
    return this._turnResponse;
  }
  /** 当前消息对应的 turn-native UI 上下文 */
  @Input()
  set turnContext(value: DialogTurnContext | null) {
    this._turnContext = value;
  }

  get turnContext(): DialogTurnContext | null {
    return this._turnContext;
  }
  /** 是否为最后一条 aily 消息（显示操作按钮） */
  @Input() isLastAily = false;
  @Input() isFirstUserTurn = false;
  @Input() showCheckpointRestore = false;
  @Input() workspaceCheckpointPresentationMode: WorkspaceCheckpointPresentationMode = 'unknown';
  /** 当前会话 ID */
  @Input() sessionId = '';
  @Input()
  set responseVote(value: HostResponseVoteDirection | undefined) {
    this._responseVote = value === 0 || value === 1 ? value : undefined;
    this.feedbackState = this.mapVoteToFeedbackState(this._responseVote);
  }

  get responseVote(): HostResponseVoteDirection | undefined {
    return this._responseVote;
  }
  @Input() currentMode = 'agent';
  @Input() currentCustomAgentTarget: string | undefined;
  @Input() currentModelName = '';
  /** 与主输入区一致的模型展示文案，PRU 下会附带当前配置描述。 */
  @Input() currentModelChipLabel = '';
  @Input() currentModelBillingLabel = '';
  /** 该消息创建时使用的模型名称 */
  @Input() turnModelName = '';
  /** 该消息创建时使用的模型倍率 */
  @Input() turnModelBillingLabel = '';
  @Input() isWaiting = false;
  /** 全局互斥：当前允许展开编辑框的用户 turnId；与本条不一致时需收起（由父级统一传入） */
  @Input() exclusiveEditTurnId: string | undefined;

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

  @ViewChild('editTextarea') editTextareaRef?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('editInputBox') editInputBoxRef?: ElementRef<HTMLElement>;

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

  private _turnResponse: TurnResponseTurn | null = null;
  private _turnContext: DialogTurnContext | null = null;
  private _responseVote: HostResponseVoteDirection | undefined;
  private compatTurnContext: DialogTurnContext | null = null;
  private _effectivePartsSource: readonly TurnResponsePart[] = EMPTY_TURN_PARTS;
  private _effectiveProgressMessagesSource: readonly NonNullable<TurnResponseTurn['response']['progressMessages']>[number][] = EMPTY_PROGRESS_MESSAGES;
  private _effectivePartsDoing = false;
  private _effectivePartsCache = [] as RenderableChatPart[];

  constructor(
    private cdr: ChangeDetectorRef,
    @Optional() private runtimeInteractionHost: ChatRuntimeInteractionHostService | null = null,
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

  /** 是否可显示操作栏（非 doing 的最后一条 aily 消息） */
  get canShowActions(): boolean {
    return !this.readOnly && this.isLastAily && !this.effectiveDoing && this.role === 'aily';
  }

  get canShowLimitActions(): boolean {
    return !this.readOnly && this.role !== 'user' && !this.effectiveDoing;
  }

  /** 是否渲染底部栏 DOM（非最后一条仅占位，hover 显影） */
  get shouldRenderFooter(): boolean {
    return this.canShowActions || this.canShowLimitActions;
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
    const turnParts = response?.parts ?? EMPTY_TURN_PARTS;
    const progressMessages = response?.progressMessages ?? EMPTY_PROGRESS_MESSAGES;
    const doing = this.effectiveDoing;
    if (turnParts === this._effectivePartsSource
      && progressMessages === this._effectiveProgressMessagesSource
      && doing === this._effectivePartsDoing) {
      return this._effectivePartsCache;
    }

    this._effectivePartsSource = turnParts;
    this._effectiveProgressMessagesSource = progressMessages;
    this._effectivePartsDoing = doing;
    this._effectivePartsCache = [
      ...turnParts.map(part => turnResponsePartToChatPart(part)),
      ...buildRenderableProgressParts(response, doing, this.hasActiveConfirmationCarousel),
    ];
    return this._effectivePartsCache;
  }

  private get hasActiveConfirmationCarousel(): boolean {
    return !!this.sessionId && !!this.runtimeInteractionHost?.getActiveConfirmation(this.sessionId);
  }

  get hasStructuredAilyContent(): boolean {
    return this.role === 'aily' && this.effectiveParts.length > 0;
  }

  get activityTurnResponse(): TurnResponseTurn | null {
    return this.effectiveTurnContext?.turnResponse ?? this._turnResponse;
  }

  get effectiveDoing(): boolean {
    const responseStatus = this.effectiveTurnContext?.response?.status;

    if (this.role === 'aily' && responseStatus) {
      return responseStatus === 'streaming';
    }

    return this.doing;
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
    return this.shouldRenderFooter && this.role === 'aily' && !this.effectiveDoing && !!this.assistantModelBadgeLabel;
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
    return !this.readOnly && this.role === 'user' && !!this.actionTurnId;
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
    return this.isRequestDisabled;
  }

  get forkSessionActionDisabled(): boolean {
    return this.isRequestDisabled;
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

  get isCheckpointCompatibilityMode(): boolean {
    return this.workspaceCheckpointPresentationMode === 'compatibility';
  }

  private appendCheckpointModeHint(base: string): string {
    if (!this.isCheckpointCompatibilityMode) {
      return base;
    }

    return `${base} 当前工作区未走 git-backed checkpoint 主路径，此入口仍处于 compatibility mode，不完全等同于 VS Code / Copilot 的真实恢复语义。`;
  }

  get checkpointActionLabel(): string {
    const baseLabel = this.isFirstUserTurn
      ? '重新开始'
      : this.roundCount > 0
        ? `还原检查点 · ${this.roundCount} 轮`
        : '还原检查点';

    return this.isCheckpointCompatibilityMode ? `${baseLabel} · 兼容模式` : baseLabel;
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
    if (this.isFirstUserTurn) {
      return this.appendCheckpointModeHint('清空当前对话并撤销全部更改');
    }

    if (this.checkpointActionDisabled) {
      return this.appendCheckpointModeHint('该请求已成为失活的历史边界，不能再次作为活动检查点使用；工作区是否还能恢复，请以单独的恢复入口状态为准');
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

    return this.appendCheckpointModeHint(hints.length > 0 ? hints.join('，') : '还原到该轮检查点');
  }

  get forkSessionActionTitle(): string {
    if (this.forkSessionActionDisabled) {
      return '该请求已失活，不能再从这里分叉新会话；这只影响聊天历史操作，工作区恢复状态请看单独的恢复入口';
    }

    const previewTitle = this.actionTurnPreviewTitle;
    if (previewTitle) {
      return `创建一个新会话，并从“${previewTitle}”这条请求重新开始`;
    }

    return '创建一个新会话，并从该请求重新开始';
  }

  get checkpointRestoreStatusLabel(): string {
    return this.isCheckpointCompatibilityMode ? '已还原检查点 · 兼容模式' : '已还原检查点';
  }

  get checkpointRestoreActionLabel(): string {
    return '恢复';
  }

  get checkpointRestoreActionTitle(): string {
    return this.appendCheckpointModeHint('重新应用已撤销的工作区更改和聊天');
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
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail,
    }));
  }

  onRestoreCheckpoint(): void {
    const target = this.effectiveTurnContext;
    if (!target || this.checkpointActionDisabled) return;
    const detail: ChatTaskActionDetail = { action: 'restoreCheckpoint', target };
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail,
    }));
  }

  onForkSession(): void {
    const target = this.effectiveTurnContext;
    if (!target || this.forkSessionActionDisabled) return;
    const detail: ChatTaskActionDetail = { action: 'forkSession', target };
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail,
    }));
  }

  onRestoreCheckpointState(): void {
    const detail: ChatTaskActionDetail = { action: 'redoEdits' };
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true,
      detail,
    }));
  }

  onCopyContent(): void {
    const turnText = this.effectiveTurnContext?.response
      ? getTurnResponseResponseText(this.effectiveTurnContext.response)
      : (this.effectiveTurnContext?.turnResponse
        ? getTurnResponseAssistantText(this.effectiveTurnContext.turnResponse)
        : '');
    const text = turnText || extractHistoricalDialogCopyText(this.content || '');
    navigator.clipboard.writeText(text).catch(() => {});
  }

  onFeedback(feedback: 'helpful' | 'unhelpful'): void {
    if (this.feedbackState === feedback) return;
    this.feedbackState = feedback;
    const target = this.effectiveTurnContext;
    const vote = feedback === 'helpful' ? 1 : 0;
    if (target) {
      const detail: ChatTaskActionDetail = { action: 'voteResponse', target, vote };
      document.dispatchEvent(new CustomEvent('aily-task-action', {
        bubbles: true,
        detail,
      }));
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

  // ===== 编辑模式操作 =====

  /** 点击用户消息进入编辑模式 */
  onUserMessageClick(): void {
    if (!this.canEditUserMessage || this.isEditing) return;
    const { text, resources } = parseUserTurnTextAndResources(this.displayContent ?? this.content ?? '');
    const requestResources = extractUserTurnResources(this.requestContent);
    this.editText = text;
    this.editResources = mergeUserTurnResources(resources, requestResources);
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

    return request !== this.normalizeComparisonText(this.displayContent ?? this.content);
  }

  private normalizeComparisonText(content: string | undefined): string {
    return (content ?? '').replace(/\r\n/g, '\n').trim();
  }

  private get actionTurnPreviewLabel(): string | null {
    if (!this.hasAdditionalTurnContext) {
      return null;
    }

    return this.buildPreviewText(this.displayContent ?? this.content, 24);
  }

  private get actionTurnPreviewTitle(): string | null {
    return this.buildPreviewText(this.displayContent ?? this.content, 80);
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

  private refreshCompatTurnContext(): void {
    this.compatTurnContext = this._turnResponse
      ? buildDialogTurnContext({
          turnId: this._turnResponse.turnId,
          turnResponse: this._turnResponse,
          request: this._turnResponse.request,
          response: this._turnResponse.response,
          rounds: this._turnResponse.rounds,
          displayContent: this.role === 'user' ? this.content : undefined,
        })
      : null;
  }

  private get effectiveTurnContext(): DialogTurnContext | null {
    return this.turnContext ?? this.compatTurnContext;
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

  ngOnChanges(changes: SimpleChanges) {
    if (changes['exclusiveEditTurnId'] && this.isEditing && this.actionTurnId) {
      const excl = this.exclusiveEditTurnId;
      if (excl != null && excl !== this.actionTurnId) {
        this.forceCloseEditFromExclusiveLock();
      }
    }

    if (changes['role'] || changes['content']) {
      this.refreshCompatTurnContext();
    }

    if (changes['doing'] || changes['content'] || changes['parts'] || changes['turnResponse'] || changes['turnContext']) {
      // ★ Phase 2: aily 消息统一走 Part-based 渲染
      if (this.hasStructuredAilyContent) {
        this.streamingConfig.set({ hasNextChunk: this.effectiveDoing, enableAnimation: this.effectiveDoing });
        return;
      }

      // User 消息 & fallback：预处理后由 x-markdown 渲染
      const content = this.content || '';
      this.streamingConfig.set({ hasNextChunk: this.effectiveDoing, enableAnimation: this.effectiveDoing });
      const processed = preprocessHistoricalDialogContent(content);
      if (processed !== this.lastRaw) {
        this.lastRaw = processed;
        this.streamContent.set(processed);
      }
    }
  }

  ngAfterViewChecked(): void { }

  ngOnDestroy(): void {
    this.detachEditOutsideClickListener();
    if (this.isEditing) {
      this.editSessionClosed.emit();
    }
  }
}
