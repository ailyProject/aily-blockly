/**
 * UserInteractionHelper — 用户交互辅助类
 *
 * 封装所有需要用户在聊天界面确认/回答的交互操作：
 * - ask_user 工具：显示问题 → 等待用户回答 → resolve Promise
 * - 工具审批：显示审批请求 → 等待用户批准/拒绝 → resolve Promise
 * - 新手引导：首次使用时的 onboarding 流程
 *
 * 从 ChatEngineService 中提取（Phase 4），减轻后者的体积。
 */

import type { IChatCoordination, IChatServiceAccess, IProjectContext, ISessionAccess } from '../core/chat-context';
import {
  isTerminalCommandToolName,
  normalizeReadSideToolName,
} from '../core/tool-name-normalizer';
import { normalizeToolApprovalArgs, readToolApprovalCommand } from '../core/tool-approval-input';
import { AilyHost } from '../core/host';
import { chatI18n } from './chat-i18n';
import { normalizeToolApprovalRequest } from './tool-approval-ui';
import type { ToolApprovalRequest, ToolApprovalResult, ToolApprovalScope } from './tool-approval-ui';
import type { AskUserQuestion, AskUserFullResponse, AskUserAnswer, AskUserPresentationContext } from '../core/ask-user';
import type { QuestionItem } from '../core/chat-parts';
import { AILY_CHAT_ONBOARDING_CONFIG } from '../../../configs/onboarding.config';

export interface UserInteractionToolApprovalPolicy {
  terminalAllowList: string[];
  save(): boolean | void;
  hasSessionToolApprovalRule(sessionResource: string | null | undefined, toolName: string): boolean;
  addSessionToolApprovalRule(sessionResource: string | null | undefined, toolName: string): boolean;
  getSessionTerminalApprovalRules(sessionResource: string | null | undefined): string[];
  addSessionTerminalApprovalRule(sessionResource: string | null | undefined, rule: string): boolean;
  hasSessionToolApprovalCombinationKey(sessionResource: string | null | undefined, combinationKey: string): boolean;
  addSessionToolApprovalCombinationKey(sessionResource: string | null | undefined, combinationKey: string): boolean;
  isSessionTerminalAutoApprovalEnabled(sessionResource: string | null | undefined): boolean;
  setSessionTerminalAutoApproval(sessionResource: string | null | undefined, enabled: boolean): void;
  hasWorkspaceToolApprovalRule(projectPath: string | null | undefined, toolName: string): boolean;
  addWorkspaceToolApprovalRule(projectPath: string | null | undefined, toolName: string): boolean;
  hasWorkspaceToolApprovalCombinationKey(projectPath: string | null | undefined, combinationKey: string): boolean;
  addWorkspaceToolApprovalCombinationKey(projectPath: string | null | undefined, combinationKey: string): boolean;
}

type UserInteractionContext = Pick<IChatCoordination, 'lexStream'>
  & Pick<IProjectContext, 'isLoggedIn' | 'getCurrentProjectPath'>
  & Pick<ISessionAccess, 'sessionId'>
  & Pick<IChatServiceAccess, 'runtimeInteractionHost'>
  & {
    resolveActiveRuntimeSessionId?(): string | null | undefined;
    readCurrentViewSessionResource?(): string | null | undefined;
    readonly toolApprovalPolicy: UserInteractionToolApprovalPolicy;
  };

interface ToolAutoApprovalEvaluation {
  readonly approved: boolean;
  readonly reason: string;
  readonly sessionResource: string;
  readonly toolName: string;
  readonly command?: string;
  readonly allowAutoConfirm: boolean;
  readonly combinationKey?: string;
}

function isTerminalApprovalTool(toolName: string): boolean {
  return isTerminalCommandToolName(toolName);
}

function escapeRegExpCharacters(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTerminalCommand(command: unknown): string {
  return typeof command === 'string' ? command.trim() : '';
}

function buildExactTerminalRule(command: string): string {
  return `/^${escapeRegExpCharacters(command)}$/`;
}

function compileTerminalPermissionRule(rule: string): RegExp | undefined {
  const trimmed = rule.trim();
  if (!trimmed.startsWith('/')) {
    return undefined;
  }

  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash <= 0) {
    return undefined;
  }

  try {
    return new RegExp(trimmed.slice(1, lastSlash), trimmed.slice(lastSlash + 1));
  } catch {
    return undefined;
  }
}

function matchesTerminalPermissionRule(command: string, rule: string): boolean {
  const normalizedRule = rule.trim();
  if (!normalizedRule) {
    return false;
  }

  const regex = compileTerminalPermissionRule(normalizedRule);
  if (regex) {
    return regex.test(command);
  }

  return command === normalizedRule
    || command.startsWith(`${normalizedRule} `);
}

function matchesTerminalPermissionList(command: string, rules: readonly string[]): boolean {
  return rules.some((rule) => matchesTerminalPermissionRule(command, rule));
}

export class UserInteractionHelper {
  // ==================== 内部状态 ====================

  /** ask_user 工具的 Promise resolve 回调（等待用户在聊天界面输入） */
  _resolveAskUser: ((response: AskUserFullResponse | undefined) => void) | null = null;
  /** 当前 ask_user 的问题列表（用于事件回调时组装答案） */
  private _askUserQuestions: AskUserQuestion[] | null = null;
  /** 当前 ask_user 对应的 canonical question partId */
  private _askUserQuestionPartId: string | null = null;

  /** 工具审批 Promise resolve 回调（等待用户在聊天界面确认） */
  _resolveToolApproval: ((result: ToolApprovalResult) => void) | null = null;

  constructor(private ctx: UserInteractionContext) {}

  private normalizeSessionResource(sessionId: string | null | undefined): string {
    return typeof sessionId === 'string' ? sessionId.trim() : '';
  }

  private resolveInteractionSessionResource(sessionId?: string | null): string {
    const explicitResource = this.normalizeSessionResource(sessionId);
    if (explicitResource) {
      return explicitResource;
    }

    const activeRuntimeSessionId = typeof this.ctx.resolveActiveRuntimeSessionId === 'function'
      ? this.ctx.resolveActiveRuntimeSessionId()
      : null;
    const activeRuntimeResource = this.normalizeSessionResource(activeRuntimeSessionId);
    if (activeRuntimeResource) {
      return activeRuntimeResource;
    }

    const currentViewSessionResource = typeof this.ctx.readCurrentViewSessionResource === 'function'
      ? this.ctx.readCurrentViewSessionResource()
      : null;
    const viewResource = this.normalizeSessionResource(currentViewSessionResource);
    if (viewResource) {
      return viewResource;
    }

    throw new Error('User interaction requires a sessionResource owner.');
  }

  /** 清理内部状态（由 engine.destroy() 调用） */
  destroy(): void {
    this._resolveAskUser = null;
    this._askUserQuestions = null;
    this._askUserQuestionPartId = null;
    this._resolveToolApproval = null;
  }

  /** 显式重置当前运行中的 session 级审批缓存。 */
  resetApprovalState(): void {
    this._resolveToolApproval = null;
  }

  // ==================== ask_user 交互处理 ====================

  /**
   * ask_user 工具的 UI 层回调。
   * 在聊天界面显示全部问题，等待用户逐题回答后 resolve 完整结果。
   */
  async handleAskUser(
    questions: AskUserQuestion[],
    context?: AskUserPresentationContext,
  ): Promise<AskUserFullResponse | undefined> {
    this._askUserQuestions = questions;
    this._askUserQuestionPartId = this.ctx.lexStream.ui.presentQuestion(this.toQuestionItems(questions), context);

    const partId = this._askUserQuestionPartId;
    if (!partId) {
      throw new Error('handleAskUser requires an active question partId.');
    }

    try {
      const result = await this.ctx.runtimeInteractionHost.presentQuestion(
        this.resolveInteractionSessionResource(),
        partId,
        questions,
        context,
      );
      if (result?.answers) {
        this.ctx.lexStream.ui.updateQuestionAnswers(result.answers, partId);
      }
      return result;
    } finally {
      this._resolveAskUser = null;
      this._askUserQuestions = null;
      this._askUserQuestionPartId = null;
    }
  }

  /**
   * ★ Phase 3: 为 ask_user 创建原生 QuestionPart
   */
  private toQuestionItems(questions: AskUserQuestion[]): QuestionItem[] {
    return questions.map(q => ({
      question: q.question,
      options: q.options?.map(o => ({
        label: o.label,
        description: o.description,
        recommended: o.recommended,
      })),
      allow_freeform: q.allow_freeform,
      multi_select: q.multi_select,
    }));
  }

  /**
   * 用户在聊天界面回答 ask_user 问题后调用此方法（兼容外部调用）。
   */
  resolveAskUserResponse(answer: string, wasFreeform: boolean, sessionId?: string | null): void {
    this.ctx.runtimeInteractionHost.resolveQuestionCompat(
      this.resolveInteractionSessionResource(sessionId),
      answer,
      wasFreeform,
    );
  }

  /**
   * 用户跳过/取消 ask_user 问题。
   */
  skipAskUserResponse(sessionId?: string | null): void {
    this.ctx.runtimeInteractionHost.skipQuestion(this.resolveInteractionSessionResource(sessionId));
  }

  // ==================== 工具审批交互处理 ====================

  /**
   * lex ApprovalHandler 桥接：将 lex 的审批请求转为 blockly UI 审批流程。
  * 由 LexOwnerFacade 在 createAgent 时作为 approvalHandler 传入。
   */
  async handleToolApproval(
    request: ToolApprovalRequest,
  ): Promise<{ approved: true } | { approved: false; reason?: string }> {
    const normalizedRequest = normalizeToolApprovalRequest({
      ...request,
      args: normalizeToolApprovalArgs(request.toolName, request.args, request.message || request.title),
    });
    const autoApproval = this.evaluateAutoApproval(normalizedRequest);
    this.logToolApprovalTrace('handle-auto-check', normalizedRequest, autoApproval);
    if (autoApproval.approved) {
      this.logToolApprovalTrace('handle-auto-approved', normalizedRequest, autoApproval);
      return { approved: true };
    }

    this.logToolApprovalTrace('ui-request', normalizedRequest, autoApproval);
    const result = await this._handleToolApproval(normalizedRequest);
    this.logToolApprovalTrace('ui-result', normalizedRequest, autoApproval, {
      approved: result.approved,
      scope: result.scope,
      actionId: result.actionId,
    });
    if (result.approved) {
      this.rememberApproval(normalizedRequest, result.scope ?? 'once', result.actionId);
    }
    return result.approved
      ? { approved: true }
      : { approved: false, reason: result.reason };
  }

  async checkToolApprovalPreflight(
    request: ToolApprovalRequest,
  ): Promise<{ approved: true } | { approved: false; reason?: string }> {
    const normalizedRequest = normalizeToolApprovalRequest({
      ...request,
      args: normalizeToolApprovalArgs(request.toolName, request.args, request.message || request.title),
    });
    const autoApproval = this.evaluateAutoApproval(normalizedRequest, { ignoreAllowAutoConfirm: true });
    this.logToolApprovalTrace('preflight', normalizedRequest, autoApproval);
    return autoApproval.approved
      ? { approved: true }
      : { approved: false, reason: autoApproval.reason };
  }

  private evaluateAutoApproval(
    request: ToolApprovalRequest,
    options?: { ignoreAllowAutoConfirm?: boolean },
  ): ToolAutoApprovalEvaluation {
    const sessionResource = this.resolveInteractionSessionResource();
    const toolName = normalizeReadSideToolName(request.toolName);
    const input = request.args && typeof request.args === 'object'
      ? request.args as Record<string, unknown>
      : {};
    const command = normalizeTerminalCommand(readToolApprovalCommand(toolName, input, request.message));
    const combinationKey = typeof request.approveCombination?.key === 'string'
      ? request.approveCombination.key.trim()
      : '';
    const base = {
      sessionResource,
      toolName,
      ...(command ? { command } : {}),
      allowAutoConfirm: request.allowAutoConfirm !== false,
      ...(combinationKey ? { combinationKey } : {}),
    };

    if (request.allowAutoConfirm === false && options?.ignoreAllowAutoConfirm !== true) {
      return {
        ...base,
        approved: false,
        reason: 'allowAutoConfirm=false',
      };
    }

    if (combinationKey) {
      if (this.ctx.toolApprovalPolicy.hasSessionToolApprovalCombinationKey(sessionResource, combinationKey)) {
        return {
          ...base,
          approved: true,
          reason: 'session-combination',
        };
      }

      if (this.ctx.toolApprovalPolicy.hasWorkspaceToolApprovalCombinationKey(this.ctx.getCurrentProjectPath(), combinationKey)) {
        return {
          ...base,
          approved: true,
          reason: 'workspace-combination',
        };
      }
    }

    if (isTerminalApprovalTool(toolName)) {
      if (this.ctx.toolApprovalPolicy.isSessionTerminalAutoApprovalEnabled(sessionResource)) {
        return {
          ...base,
          approved: true,
          reason: 'session-all-terminal',
        };
      }

      if (!command) {
        return {
          ...base,
          approved: false,
          reason: 'missing-terminal-command',
        };
      }

      if (matchesTerminalPermissionList(command, this.ctx.toolApprovalPolicy.getSessionTerminalApprovalRules(sessionResource))) {
        return {
          ...base,
          approved: true,
          reason: 'session-terminal-command',
        };
      }

      if (matchesTerminalPermissionList(command, this.ctx.toolApprovalPolicy.terminalAllowList ?? [])) {
        return {
          ...base,
          approved: true,
          reason: 'workspace-terminal-allow-list',
        };
      }

      return {
        ...base,
        approved: false,
        reason: 'no-terminal-rule',
      };
    }

    if (this.ctx.toolApprovalPolicy.hasSessionToolApprovalRule(sessionResource, toolName)) {
      return {
        ...base,
        approved: true,
        reason: 'session-tool',
      };
    }

    if (this.ctx.toolApprovalPolicy.hasWorkspaceToolApprovalRule(this.ctx.getCurrentProjectPath(), toolName)) {
      return {
        ...base,
        approved: true,
        reason: 'workspace-tool',
      };
    }

    return {
      ...base,
      approved: false,
      reason: 'no-tool-rule',
    };
  }

  private rememberApproval(request: ToolApprovalRequest, scope: ToolApprovalScope, actionId?: string): void {
    const sessionResource = this.resolveInteractionSessionResource();
    const toolName = normalizeReadSideToolName(request.toolName);
    const input = request.args && typeof request.args === 'object'
      ? request.args as Record<string, unknown>
      : {};
    const normalizedScope = scope === 'session-safe' ? 'session-all-terminal' : scope;
    const combinationKey = typeof request.approveCombination?.key === 'string'
      ? request.approveCombination.key.trim()
      : '';
    const isCombinationApproval = !!combinationKey && actionId?.startsWith('combination:');

    if (normalizedScope === 'once') {
      return;
    }

    if (isCombinationApproval) {
      if (normalizedScope === 'session') {
        this.ctx.toolApprovalPolicy.addSessionToolApprovalCombinationKey(sessionResource, combinationKey);
        this.logToolApprovalTrace('remember', request, undefined, {
          sessionResource,
          toolName,
          scope: normalizedScope,
          actionId,
          remembered: 'session-combination',
          combinationKey,
        });
        return;
      }

      if (normalizedScope === 'workspace'
        && this.ctx.toolApprovalPolicy.addWorkspaceToolApprovalCombinationKey(this.ctx.getCurrentProjectPath(), combinationKey)) {
        this.ctx.toolApprovalPolicy.save();
      }
      this.logToolApprovalTrace('remember', request, undefined, {
        sessionResource,
        toolName,
        scope: normalizedScope,
        actionId,
        remembered: 'workspace-combination',
        combinationKey,
      });
      return;
    }

    if (isTerminalApprovalTool(toolName)) {
      const command = normalizeTerminalCommand(readToolApprovalCommand(toolName, input, request.message));
      if (normalizedScope === 'session-all-terminal') {
        this.ctx.toolApprovalPolicy.setSessionTerminalAutoApproval(sessionResource, true);
        this.logToolApprovalTrace('remember', request, undefined, {
          sessionResource,
          toolName,
          command,
          scope: normalizedScope,
          actionId,
          remembered: 'session-all-terminal',
        });
        return;
      }

      if (!command) {
        return;
      }

      const exactRule = buildExactTerminalRule(command);
      this.ctx.toolApprovalPolicy.addSessionTerminalApprovalRule(sessionResource, exactRule);
      this.logToolApprovalTrace('remember', request, undefined, {
        sessionResource,
        toolName,
        command,
        exactRule,
        scope: normalizedScope,
        actionId,
        remembered: 'session-terminal-command',
      });

      if (normalizedScope === 'workspace') {
        const currentAllowList = this.ctx.toolApprovalPolicy.terminalAllowList ?? [];
        if (!currentAllowList.includes(exactRule)) {
          this.ctx.toolApprovalPolicy.terminalAllowList = [...currentAllowList, exactRule];
          this.ctx.toolApprovalPolicy.save();
        }
        this.logToolApprovalTrace('remember', request, undefined, {
          sessionResource,
          toolName,
          command,
          exactRule,
          scope: normalizedScope,
          actionId,
          remembered: 'workspace-terminal-command',
        });
      }
      return;
    }

    if (normalizedScope === 'session') {
      this.ctx.toolApprovalPolicy.addSessionToolApprovalRule(sessionResource, toolName);
      this.logToolApprovalTrace('remember', request, undefined, {
        sessionResource,
        toolName,
        scope: normalizedScope,
        actionId,
        remembered: 'session-tool',
      });
      return;
    }

    if (normalizedScope === 'workspace'
      && this.ctx.toolApprovalPolicy.addWorkspaceToolApprovalRule(this.ctx.getCurrentProjectPath(), toolName)) {
      this.ctx.toolApprovalPolicy.save();
      this.logToolApprovalTrace('remember', request, undefined, {
        sessionResource,
        toolName,
        scope: normalizedScope,
        actionId,
        remembered: 'workspace-tool',
      });
    }
  }

  private logToolApprovalTrace(
    phase: string,
    request: ToolApprovalRequest,
    evaluation?: ToolAutoApprovalEvaluation,
    extra?: Record<string, unknown>,
  ): void {
    const input = request.args && typeof request.args === 'object'
      ? request.args as Record<string, unknown>
      : {};
    const normalizedToolName = normalizeReadSideToolName(request.toolName);
    console.info('[AilyChat][ToolApprovalTrace]', {
      approvalTraceId: request.approvalTraceId,
      phase,
      toolCallId: request.toolCallId,
      rawToolName: request.toolName,
      normalizedToolName,
      sessionResource: evaluation?.sessionResource ?? extra?.['sessionResource'],
      command: evaluation?.command ?? normalizeTerminalCommand(readToolApprovalCommand(normalizedToolName, input, request.message)),
      allowAutoConfirm: evaluation?.allowAutoConfirm ?? request.allowAutoConfirm !== false,
      approved: evaluation?.approved,
      reason: evaluation?.reason,
      combinationKey: evaluation?.combinationKey,
      ...extra,
    });
  }

  /**
   * 工具审批的 UI 层回调。
   */
  private _handleToolApproval(request: ToolApprovalRequest): Promise<ToolApprovalResult> {
    const sessionResource = this.resolveInteractionSessionResource();
    this.logToolApprovalTrace('host-ui-request', request, undefined, {
      sessionResource,
    });
    return this.ctx.runtimeInteractionHost.presentToolApproval(sessionResource, request).then((result) => {
      this.logToolApprovalTrace('host-ui-result', request, undefined, {
        sessionResource,
        approved: !!result.approved,
        scope: result.scope,
        actionId: typeof result.actionId === 'string' ? result.actionId : undefined,
      });
      return {
        approved: !!result.approved,
        reason: result.reason || (result.approved ? undefined : chatI18n('AILY_CHAT.PROCESS_CONFIRM_REJECT_REASON')),
        scope: result.scope || 'once',
        actionId: typeof result.actionId === 'string' ? result.actionId : undefined,
      };
    });
  }

  /**
   * 外部调用：用户批准工具执行。
   */
  approveToolExecution(toolCallId: string, scope: ToolApprovalScope = 'once', actionId?: string): void {
    this.ctx.runtimeInteractionHost.resolveToolApproval(
      this.resolveInteractionSessionResource(),
      toolCallId,
      { approved: true, scope, actionId },
    );
  }

  /**
   * 外部调用：用户拒绝工具执行。
   */
  rejectToolExecution(toolCallId: string, reason?: string): void {
    this.ctx.runtimeInteractionHost.resolveToolApproval(
      this.resolveInteractionSessionResource(),
      toolCallId,
      {
        approved: false,
        reason: reason || chatI18n('AILY_CHAT.PROCESS_CONFIRM_REJECT_REASON'),
      },
    );
  }

  // ==================== 新手引导 ====================

  checkFirstUsage(): void {
    const hasSeenOnboarding = AilyHost.get().config.data?.ailyChatOnboardingCompleted;
    if (!hasSeenOnboarding && this.ctx.isLoggedIn) {
      setTimeout(() => {
        AilyHost.get().onboarding?.start(AILY_CHAT_ONBOARDING_CONFIG, {
          onClosed: () => this._onOnboardingClosed(),
          onCompleted: () => this._onOnboardingClosed()
        });
      }, 500);
    }
  }

  private _onOnboardingClosed(): void {
    AilyHost.get().config.data.ailyChatOnboardingCompleted = true;
    AilyHost.get().config.save?.();
  }
}
