import type { ToolCallPart } from './chat-parts';
import {
  normalizeToolApprovalPresentation,
  type ToolApprovalAction,
  type ToolApprovalScope,
} from '../helpers/tool-approval-ui';

export interface ToolCallApprovalMetadata {
  toolCallId?: string;
  toolName?: string;
  previousText?: string;
  message?: string;
  description?: string;
  source?: string;
  reviewStartedAt?: number;
  reviewCompletedAt?: number;
  reviewer?: 'user' | 'auto_review';
  reviewStatus?: 'reviewing' | 'approved' | 'denied' | 'timedOut' | 'aborted';
  reviewRiskLevel?: 'low' | 'medium' | 'high';
  decisionSource?: string;
  title?: string;
  subtitle?: string;
  actions?: readonly ToolApprovalAction[];
  primaryScope?: ToolApprovalScope;
  args?: any;
  resolved?: boolean;
  result?: 'approved' | 'rejected';
  scope?: ToolApprovalScope;
}

export interface ToolCallApprovalDisplayData {
  toolCallId: string;
  toolName?: string;
  title: string;
  subtitle?: string;
  message: string;
  description?: string;
  args?: any;
  reviewer?: 'user' | 'auto_review';
  reviewStatus?: 'reviewing' | 'approved' | 'denied' | 'timedOut' | 'aborted';
  reviewRiskLevel?: 'low' | 'medium' | 'high';
  reviewStartedAt?: number;
  reviewCompletedAt?: number;
  decisionSource?: string;
  resolved?: boolean;
  approved?: boolean;
  scope?: ToolApprovalScope;
  actions: readonly ToolApprovalAction[];
  primaryScope: ToolApprovalScope;
}

export function buildPendingToolCallApprovalMetadata(input: {
  toolCallId: string;
  toolName?: string;
  message?: string;
  description?: string;
  source?: string;
  reviewer?: 'user' | 'auto_review';
  reviewStatus?: 'reviewing' | 'approved' | 'denied' | 'timedOut' | 'aborted';
  reviewRiskLevel?: 'low' | 'medium' | 'high';
  reviewStartedAt?: number;
  reviewCompletedAt?: number;
  decisionSource?: string;
  title?: string;
  subtitle?: string;
  actions?: readonly ToolApprovalAction[];
  primaryScope?: ToolApprovalScope;
  args?: any;
}): ToolCallApprovalMetadata {
  return {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    message: input.message,
    description: input.description,
    source: input.source,
    ...(typeof input.reviewStartedAt === 'number' ? { reviewStartedAt: input.reviewStartedAt } : {}),
    ...(typeof input.reviewCompletedAt === 'number' ? { reviewCompletedAt: input.reviewCompletedAt } : {}),
    reviewer: input.reviewer,
    reviewStatus: input.reviewStatus,
    reviewRiskLevel: input.reviewRiskLevel,
    decisionSource: input.decisionSource,
    title: input.title,
    subtitle: input.subtitle,
    actions: input.actions?.map(action => ({ ...action })) || [],
    primaryScope: input.primaryScope,
    args: input.args,
    resolved: false,
  };
}

export function buildResolvedToolCallApprovalMetadata(input: {
  toolCallId: string;
  result: 'approved' | 'rejected';
  scope?: ToolApprovalScope;
  reviewer?: 'user' | 'auto_review';
  reviewStatus?: 'approved' | 'denied' | 'timedOut' | 'aborted';
  reviewRiskLevel?: 'low' | 'medium' | 'high';
  source?: string;
  reviewStartedAt?: number;
  reviewCompletedAt?: number;
  decisionSource?: string;
  title?: string;
  message?: string;
  description?: string;
}): ToolCallApprovalMetadata {
  return {
    toolCallId: input.toolCallId,
    ...(input.reviewer ? { reviewer: input.reviewer } : {}),
    ...(input.reviewStatus ? { reviewStatus: input.reviewStatus } : {}),
    ...(input.reviewRiskLevel ? { reviewRiskLevel: input.reviewRiskLevel } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(typeof input.reviewStartedAt === 'number' ? { reviewStartedAt: input.reviewStartedAt } : {}),
    ...(typeof input.reviewCompletedAt === 'number' ? { reviewCompletedAt: input.reviewCompletedAt } : {}),
    ...(input.decisionSource ? { decisionSource: input.decisionSource } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(input.description ? { description: input.description } : {}),
    resolved: true,
    result: input.result,
    ...(input.scope ? { scope: input.scope } : {}),
  };
}

export function getToolCallApprovalMetadata(part: Pick<ToolCallPart, 'metadata'>): ToolCallApprovalMetadata | undefined {
  const metadata = asRecord(part.metadata);
  return asApprovalRecord(metadata?.['approval'])
    || asApprovalRecord(metadata?.['approvalRequest'])
    || undefined;
}

export function projectToolCallApprovalDisplayData(
  part: Pick<ToolCallPart, 'toolCallId' | 'toolName' | 'state' | 'args' | 'metadata'>,
): ToolCallApprovalDisplayData | undefined {
  const approval = getToolCallApprovalMetadata(part);
  if (!approval && part.state !== 'pending_approval') {
    return undefined;
  }

  const metadata = asRecord(part.metadata) || {};
  const source = asString(approval?.source) || asString(metadata['source']);
  const normalized = normalizeToolApprovalPresentation({
    toolName: part.toolName,
    source,
    title: asString(approval?.title) || resolveAutoReviewTitle(approval),
    subtitle: asString(approval?.subtitle),
    message: asString(approval?.message) || resolveAutoReviewMessage(approval),
    actions: approval?.actions,
    primaryScope: asApprovalScope(approval?.primaryScope),
    args: approval?.args ?? part.args,
    metadata,
  });

  return {
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    title: normalized.title,
    subtitle: normalized.subtitle,
    message: normalized.message,
    description: asString(approval?.description),
    args: normalized.args,
    reviewer: approval?.reviewer,
    reviewStatus: approval?.reviewStatus,
    reviewRiskLevel: approval?.reviewRiskLevel,
    reviewStartedAt: approval?.reviewStartedAt,
    reviewCompletedAt: approval?.reviewCompletedAt,
    decisionSource: approval?.decisionSource,
    resolved: approval?.resolved === true,
    approved: approval?.result === 'approved',
    scope: asApprovalScope(approval?.scope),
    actions: normalized.actions,
    primaryScope: normalized.primaryScope,
  };
}

function asApprovalRecord(value: unknown): ToolCallApprovalMetadata | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  return {
    toolCallId: asString(record['toolCallId']),
    toolName: asString(record['toolName']),
    message: asString(record['message']),
    description: asString(record['description']),
    source: asString(record['source']),
    reviewStartedAt: typeof record['reviewStartedAt'] === 'number' ? record['reviewStartedAt'] : undefined,
    reviewCompletedAt: typeof record['reviewCompletedAt'] === 'number' ? record['reviewCompletedAt'] : undefined,
    reviewer: record['reviewer'] === 'user' || record['reviewer'] === 'auto_review'
      ? record['reviewer']
      : undefined,
    reviewStatus: record['reviewStatus'] === 'reviewing'
      || record['reviewStatus'] === 'approved'
      || record['reviewStatus'] === 'denied'
      || record['reviewStatus'] === 'timedOut'
      || record['reviewStatus'] === 'aborted'
      ? record['reviewStatus']
      : undefined,
    reviewRiskLevel: record['reviewRiskLevel'] === 'low'
      || record['reviewRiskLevel'] === 'medium'
      || record['reviewRiskLevel'] === 'high'
      ? record['reviewRiskLevel']
      : undefined,
    decisionSource: asString(record['decisionSource']),
    title: asString(record['title']),
    subtitle: asString(record['subtitle']),
    actions: asApprovalActions(record['actions']),
    primaryScope: asApprovalScope(record['primaryScope']),
    args: record['args'],
    resolved: record['resolved'] === true,
    result: record['result'] === 'approved' || record['result'] === 'rejected'
      ? record['result']
      : undefined,
    scope: asApprovalScope(record['scope']),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asApprovalActions(value: unknown): readonly ToolApprovalAction[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map(item => asRecord(item))
    .filter((item): item is Record<string, unknown> => !!item)
    .filter(item => typeof item['scope'] === 'string' && typeof item['label'] === 'string')
    .map(item => ({
      id: asString(item['id']),
      scope: item['scope'] as ToolApprovalScope,
      label: item['label'] as string,
      description: asString(item['description']),
      tooltip: asString(item['tooltip']),
      disabled: item['disabled'] === true,
      isSecondary: item['isSecondary'] === true,
      combinationKey: asString(item['combinationKey']),
    }));
}

function asApprovalScope(value: unknown): ToolApprovalScope | undefined {
  if (value === 'once'
    || value === 'session'
    || value === 'workspace'
    || value === 'session-all-terminal'
    || value === 'session-safe') {
    return value;
  }
  return undefined;
}

function resolveAutoReviewTitle(approval: ToolCallApprovalMetadata | undefined): string | undefined {
  if (approval?.reviewer !== 'auto_review') {
    return undefined;
  }

  switch (approval.reviewStatus) {
    case 'reviewing':
      return '自动审查中';
    case 'approved':
      return approval.decisionSource === 'user_override' ? '人工覆写后已允许' : '自动审查已允许';
    case 'timedOut':
      return '自动审查超时';
    case 'aborted':
      return '自动审查已中止';
    case 'denied':
      return approval.decisionSource === 'user_override' ? '人工覆写已拒绝' : '自动审查已拒绝';
    default:
      return undefined;
  }
}

function resolveAutoReviewMessage(approval: ToolCallApprovalMetadata | undefined): string | undefined {
  if (approval?.reviewer !== 'auto_review') {
    return undefined;
  }

  return approval.message
    || (approval.reviewStatus === 'reviewing'
      ? '正在根据确定性规则执行自动审查。'
      : undefined);
}