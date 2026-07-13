/**
 * Tool approval UI contracts and message formatting.
 *
 * Ownership now lives with the user-interaction layer.
 * core/index.ts re-exports these contracts directly for the remaining barrel path.
 */

import { TranslateService } from '@ngx-translate/core';
import {
  buildToolInvocationDisplaySummary,
  flattenToolInvocationDisplaySummary,
} from '../core/tool-invocation-formatter';
import {
  isTerminalCommandToolName,
  normalizeReadSideToolName,
} from '../core/tool-name-normalizer';
import {
  normalizeToolApprovalArgs,
  readToolApprovalCommand,
} from '../core/tool-approval-input';

export interface ToolApprovalRequest {
  approvalTraceId?: string;
  toolCallId: string;
  toolName: string;
  title: string;
  subtitle?: string;
  message: string;
  source?: string;
  actions?: readonly ToolApprovalAction[];
  primaryScope?: ToolApprovalScope;
  allowAutoConfirm?: boolean;
  approveCombination?: ToolApprovalCombination;
  args?: any;
}

export interface ToolApprovalPresentation {
  readonly title?: string;
  readonly subtitle?: string;
  readonly message?: string;
  readonly source?: string;
  readonly actions?: readonly ToolApprovalAction[];
  readonly primaryScope?: ToolApprovalScope;
  readonly allowAutoConfirm?: boolean;
  readonly approveCombination?: ToolApprovalCombination;
  readonly args?: any;
}

export interface NormalizedToolApprovalPresentation {
  readonly title: string;
  readonly subtitle?: string;
  readonly message: string;
  readonly actions: readonly ToolApprovalAction[];
  readonly primaryScope: ToolApprovalScope;
  readonly allowAutoConfirm: boolean;
  readonly approveCombination?: ToolApprovalCombination;
  readonly args?: any;
}

export type ToolApprovalScope = 'once' | 'session' | 'workspace' | 'session-all-terminal' | 'session-safe';

export interface ToolApprovalCombination {
  readonly label: string;
  readonly key: string;
  readonly arguments?: string;
}

export interface ToolApprovalAction {
  readonly id?: string;
  readonly scope: ToolApprovalScope;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly disabled?: boolean;
  readonly isSecondary?: boolean;
  readonly resolves?: boolean;
  readonly combinationKey?: string;
}

export interface ToolApprovalResult {
  approved: boolean;
  reason?: string;
  scope?: ToolApprovalScope;
  actionId?: string;
}

export type ToolApprovalCallback = (request: ToolApprovalRequest) => Promise<ToolApprovalResult>;

let translateServiceRef: Pick<TranslateService, 'instant'> | null = null;

export function setToolApprovalTranslateService(translate: Pick<TranslateService, 'instant'> | null | undefined): void {
  translateServiceRef = translate ?? null;
}

function t(key: string, params?: Record<string, unknown>, fallback?: string): string {
  const translated = translateServiceRef?.instant?.(key, params);
  if (typeof translated === 'string' && translated && translated !== key) {
    return translated;
  }
  return fallback ?? key;
}

export function getToolApprovalTitle(toolName: string | undefined, fallbackTitle?: string): string {
  const normalizedToolName = normalizeReadSideToolName(toolName);

  switch (normalizedToolName) {
    case 'run_in_terminal':
    case 'command_exec':
      return t('AILY_CHAT.PROCESS_APPROVAL_RUN_COMMAND', undefined, 'Run Terminal Command');
    case 'send_to_terminal':
    case 'command_write_stdin':
      return t('AILY_CHAT.PROCESS_APPROVAL_SEND_INPUT', undefined, 'Send Terminal Input');
    case 'command_resize':
      return t('AILY_CHAT.PROCESS_APPROVAL_RESIZE', undefined, 'Resize Terminal');
    case 'kill_terminal':
    case 'command_stop':
      return t('AILY_CHAT.PROCESS_APPROVAL_STOP', undefined, 'Stop Command Process');
    default:
      {
        const defaultTitle = t('AILY_CHAT.PROCESS_APPROVAL_DEFAULT_TITLE', undefined, 'Confirm Action');
        return fallbackTitle && !fallbackTitle.startsWith(defaultTitle)
          ? fallbackTitle
          : normalizedToolName
            ? `${defaultTitle}: ${normalizedToolName}`
            : (fallbackTitle || defaultTitle);
      }
  }
}

export function getToolApprovalSubtitle(toolName: string | undefined, source?: string): string | undefined {
  const normalizedToolName = normalizeReadSideToolName(toolName) || undefined;
  const normalizedSource = source?.trim();

  if (normalizedToolName && normalizedSource) {
    return `${normalizedToolName} · ${normalizedSource}`;
  }

  return normalizedToolName || normalizedSource || undefined;
}

export function getToolApprovalActions(toolName: string | undefined): readonly ToolApprovalAction[] {
  if (isTerminalCommandToolName(toolName)) {
      return [
        {
          id: 'session',
          scope: 'session',
          label: t('AILY_CHAT.PROCESS_APPROVAL_ALLOW_SESSION', undefined, 'Always allow in this chat'),
          description: t('AILY_CHAT.PROCESS_APPROVAL_ALLOW_SESSION_DESC', undefined, 'Future identical commands run directly without asking again.'),
          tooltip: t('AILY_CHAT.PROCESS_APPROVAL_ALLOW_SESSION_TIP', undefined, 'Remember this command and auto-run it in the current chat.'),
        },
        {
          id: 'workspace',
          scope: 'workspace',
          label: t('AILY_CHAT.PROCESS_APPROVAL_ALLOW_WORKSPACE', undefined, 'Always allow in this workspace'),
          description: t('AILY_CHAT.PROCESS_APPROVAL_ALLOW_WORKSPACE_DESC', undefined, 'Add this command to the workspace-level allow list.'),
          tooltip: t('AILY_CHAT.PROCESS_APPROVAL_ALLOW_WORKSPACE_TIP', undefined, 'Write this command into the current workspace rules.'),
        },
        {
          id: 'session-all-terminal',
          scope: 'session-all-terminal',
          label: t('AILY_CHAT.PROCESS_APPROVAL_ALLOW_ALL_TERMINAL', undefined, 'Allow all terminal commands in this chat'),
          description: t('AILY_CHAT.PROCESS_APPROVAL_ALLOW_ALL_TERMINAL_DESC', undefined, 'Future terminal commands run directly in this chat.'),
          tooltip: t('AILY_CHAT.PROCESS_APPROVAL_ALLOW_ALL_TERMINAL_TIP', undefined, 'Subsequent terminal commands in this chat will no longer require individual confirmation.'),
          isSecondary: true,
        },
      ];
  }

  return [
    {
      id: 'session',
      scope: 'session',
      label: '在当前对话中自动运行此工具',
      description: '同一工具的后续请求将不再重复询问。',
      tooltip: '当前对话中的同类工具请求将自动执行。',
    },
    {
      id: 'workspace',
      scope: 'workspace',
      label: '在当前工作区中自动运行此工具',
      description: '把此工具加入当前工作区级 permission rule。',
      tooltip: '当前工作区中的同类工具请求将自动执行。',
    },
  ];
}

function buildApprovalFallbackDetail(
  toolName: string | undefined,
  args: any,
  metadata?: Record<string, unknown> | null,
): string | undefined {
  if (!toolName) {
    return undefined;
  }

  return flattenToolInvocationDisplaySummary(buildToolInvocationDisplaySummary({
    toolName,
    args,
    metadata,
  }));
}

function coalesceNonEmptyString(primary: string | undefined, fallback: string | undefined): string | undefined {
  return typeof primary === 'string' && primary.trim().length > 0 ? primary : fallback;
}

function buildApproveCombinationActions(
  combination: ToolApprovalCombination | undefined,
): readonly ToolApprovalAction[] {
  if (!combination) {
    return [];
  }

  const argumentSummary = typeof combination.arguments === 'string' && combination.arguments.trim().length > 0
    ? `\n参数：${combination.arguments.trim()}`
    : '';

  return [
    {
      id: 'combination:session',
      scope: 'session',
      label: `在当前对话中允许“${combination.label}”`,
      description: '仅记住这组工具与参数的组合，不影响该工具的其他调用。',
      tooltip: `在当前对话中自动允许此工具与参数组合。${argumentSummary}`,
      combinationKey: combination.key,
    },
    {
      id: 'combination:workspace',
      scope: 'workspace',
      label: `在当前工作区中允许“${combination.label}”`,
      description: '把这组工具与参数组合写入当前工作区规则。',
      tooltip: `在当前工作区中自动允许此工具与参数组合。${argumentSummary}`,
      combinationKey: combination.key,
    },
  ];
}

export function generateApprovalMessage(
  toolName: string | undefined,
  args: any,
  metadata?: Record<string, unknown> | null,
): { title: string; message: string } {
  const normalizedToolName = normalizeReadSideToolName(toolName);

  switch (normalizedToolName) {
    case 'run_in_terminal':
    case 'command_exec':
      return {
        title: getToolApprovalTitle(normalizedToolName),
        message: [
          t('AILY_CHAT.PROCESS_APPROVAL_MESSAGE_RUN_PREFIX', undefined, 'Run terminal command:'),
          readToolApprovalCommand(normalizedToolName, args) || t('AILY_CHAT.PROCESS_UNKNOWN_COMMAND', undefined, '(unknown command)'),
          ...(args?.goal ? [`${t('AILY_CHAT.PROCESS_APPROVAL_GOAL_PREFIX', undefined, 'Goal:')} ${args.goal}`] : []),
        ].join('\n'),
      };
    case 'send_to_terminal':
    case 'command_write_stdin':
      return {
        title: getToolApprovalTitle(normalizedToolName),
        message: t(
          'AILY_CHAT.PROCESS_APPROVAL_MESSAGE_INPUT',
          {
            input: args?.input || args?.command || t('AILY_CHAT.PROCESS_EMPTY_INPUT', undefined, '(empty input / poll)'),
          },
          `Send input to terminal:\n${args?.input || args?.command || '(empty input / poll)'}`,
        ),
      };
    case 'command_resize':
      return {
        title: getToolApprovalTitle(normalizedToolName),
        message: t(
          'AILY_CHAT.PROCESS_APPROVAL_MESSAGE_RESIZE',
          {
            processId: args?.processId || t('AILY_CHAT.PROCESS_UNKNOWN_ID', undefined, '(unknown process)'),
            rows: args?.size?.rows ?? t('AILY_CHAT.PROCESS_UNKNOWN_VALUE', undefined, '(unknown)'),
            cols: args?.size?.cols ?? t('AILY_CHAT.PROCESS_UNKNOWN_VALUE', undefined, '(unknown)'),
          },
          `Resize terminal for process ${args?.processId || '(unknown process)'}\nrows=${args?.size?.rows ?? '(unknown)'} cols=${args?.size?.cols ?? '(unknown)'}`,
        ),
      };
    case 'kill_terminal':
    case 'command_stop':
      return {
        title: getToolApprovalTitle(normalizedToolName),
        message: t(
          'AILY_CHAT.PROCESS_APPROVAL_MESSAGE_STOP',
          {
            processId: args?.processId || args?.id || args?.terminalId || t('AILY_CHAT.PROCESS_UNKNOWN_ID', undefined, '(unknown process)'),
          },
          `Stop command process: ${args?.processId || args?.id || args?.terminalId || '(unknown process)'}`,
        ),
      };
    default:
      {
        const title = getToolApprovalTitle(normalizedToolName);
        const detail = buildApprovalFallbackDetail(normalizedToolName, args, metadata);
        return {
          title,
          message: detail
            ? `即将执行工具 ${normalizedToolName || '(未知工具)'}：\n${detail}`
            : normalizedToolName
              ? `即将执行工具 ${normalizedToolName}，请确认是否继续。`
              : '即将执行工具操作，请确认是否继续。',
        };
      }
  }
}

export function normalizeToolApprovalPresentation(input: {
  toolName?: string;
  source?: string;
  title?: string;
  subtitle?: string;
  message?: string;
  actions?: readonly ToolApprovalAction[];
  primaryScope?: ToolApprovalScope;
  allowAutoConfirm?: boolean;
  approveCombination?: ToolApprovalCombination;
  args?: any;
  metadata?: Record<string, unknown> | null;
}): NormalizedToolApprovalPresentation {
  const normalizedToolName = normalizeReadSideToolName(input.toolName);
  const fallback = generateApprovalMessage(normalizedToolName, input.args, input.metadata);
  const allowAutoConfirm = input.allowAutoConfirm !== false;
  const defaultActions = allowAutoConfirm ? getToolApprovalActions(normalizedToolName) : [];
  const combinationActions = allowAutoConfirm ? buildApproveCombinationActions(input.approveCombination) : [];

  return {
    title: coalesceNonEmptyString(input.title, fallback.title) || fallback.title,
    subtitle: coalesceNonEmptyString(input.subtitle, getToolApprovalSubtitle(normalizedToolName, input.source)),
    message: coalesceNonEmptyString(input.message, fallback.message) || fallback.message,
    actions: input.actions ?? [...combinationActions, ...defaultActions],
    primaryScope: input.primaryScope ?? 'once',
    allowAutoConfirm,
    approveCombination: input.approveCombination,
    args: input.args,
  };
}

export function normalizeToolApprovalRequest(input: ToolApprovalRequest): ToolApprovalRequest {
  const normalizedToolName = normalizeReadSideToolName(input.toolName);
  const normalizedArgs = normalizeToolApprovalArgs(normalizedToolName, input.args, input.message || input.title);
  const approvalTraceId = typeof input.approvalTraceId === 'string' && input.approvalTraceId.trim()
    ? input.approvalTraceId.trim()
    : `approval-${input.toolCallId}`;
  const normalized = normalizeToolApprovalPresentation({
    toolName: normalizedToolName,
    source: input.source,
    title: input.title,
    subtitle: input.subtitle,
    message: input.message,
    actions: input.actions,
    primaryScope: input.primaryScope,
    allowAutoConfirm: input.allowAutoConfirm,
    approveCombination: input.approveCombination,
    args: normalizedArgs,
  });

  return {
    ...input,
    approvalTraceId,
    toolName: normalizedToolName,
    title: normalized.title,
    subtitle: normalized.subtitle,
    message: normalized.message,
    actions: normalized.actions,
    primaryScope: normalized.primaryScope,
    allowAutoConfirm: normalized.allowAutoConfirm,
    approveCombination: normalized.approveCombination,
    args: normalizedArgs,
  };
}
