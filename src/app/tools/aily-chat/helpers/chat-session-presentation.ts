import {
  createBuiltinChatResolvedMode,
  normalizeChatModeId,
  type ChatSessionInputState,
} from '../core/chat-mode';
import { ChatPerformanceTracer } from '../services/chat-perf-tracer';
import { normalizeHostSessionListItemStatus, type HostSessionListItemStatus } from './host-session-item-controller';
import type { ChatSessionListItem } from '../services/menu-manager.service';

export interface ChatSessionInventoryGroup {
  readonly id: 'pinned' | 'today' | 'yesterday' | 'week' | 'older' | 'archived';
  readonly label: string;
  readonly items: readonly ChatSessionListItem[];
}

export type ChatSessionPickerGroup = ChatSessionInventoryGroup;

export function buildChatSessionDetailSegments(item: ChatSessionListItem): string[] {
  const segments: string[] = [];
  const providerLabel = readNonEmptyString(item.metadata?.providerLabel);
  const projectLabel = readNonEmptyString(item.metadata?.projectLabel);
  const targetLabel = resolveChatSessionTargetLabel(item);
  const permissionLabel = resolveChatSessionPermissionLabel(item);

  appendUniqueSegment(segments, providerLabel);
  if (projectLabel && projectLabel !== providerLabel) {
    appendUniqueSegment(segments, projectLabel);
  }
  appendUniqueSegment(segments, targetLabel);
  appendUniqueSegment(segments, permissionLabel);

  return segments;
}

export function buildChatSessionDiffSegments(item: ChatSessionListItem): string[] {
  const changes = item.changes;
  if (!changes || changes.fileCount <= 0) {
    return [];
  }

  return [
    `+${Math.max(0, changes.insertions)}`,
    `-${Math.max(0, changes.deletions)}`,
  ];
}

export function resolveChatSessionDisplayDescription(item: ChatSessionListItem): string {
  const explicitDescription = readNonEmptyString(item.description);
  if (explicitDescription) {
    return explicitDescription;
  }

  return formatChatSessionStatusDescription(item.status);
}

export function hasChatSessionDisplayDescription(item: ChatSessionListItem): boolean {
  return resolveChatSessionDisplayDescription(item).length > 0;
}

export function shouldHideChatSessionAncillaryMeta(item: ChatSessionListItem): boolean {
  return hasChatSessionDisplayDescription(item) && isChatSessionInProgressStatus(item.status);
}

export function formatChatSessionStatusMeta(item: ChatSessionListItem): string {
  const timing = item.timing;
  const normalizedStatus = normalizeChatSessionStatus(item.status);
  if (normalizedStatus === 'in_progress') {
    if (typeof timing?.lastRequestStarted === 'number') {
      return `Working ${formatDuration(Math.max(1_000, Date.now() - timing.lastRequestStarted))}`;
    }

    return 'Working';
  }

  if (normalizedStatus === 'needs_input') {
    const relative = formatRelativeTime(timing?.lastRequestEnded ?? timing?.updated ?? timing?.created);
    return relative ? `Input needed · ${relative}` : 'Input needed';
  }

  if (normalizedStatus === 'failed') {
    const relative = formatRelativeTime(timing?.lastRequestEnded ?? timing?.updated ?? timing?.created);
    return relative ? `Failed · ${relative}` : 'Failed';
  }

  if (!timing) {
    return '';
  }

  return formatRelativeTime(timing.lastRequestEnded ?? timing.updated ?? timing.created);
}

export function hasChatSessionMetaContent(item: ChatSessionListItem): boolean {
  return hasChatSessionDisplayDescription(item)
    || buildChatSessionDetailSegments(item).length > 0
    || buildChatSessionDiffSegments(item).length > 0
    || formatChatSessionStatusMeta(item).length > 0;
}

export function formatChatSessionStatus(status?: string): string {
  const detailedLabel = formatDetailedChatSessionStatusLabel(status);
  if (detailedLabel) {
    return detailedLabel;
  }

  switch (normalizeChatSessionStatus(status)) {
    case 'in_progress':
      return '进行中';
    case 'needs_input':
      return '需要输入';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    default:
      return typeof status === 'string' && status.trim().length > 0
        ? status.split(/[_\s-]+/).map(part => capitalize(part)).join(' ')
        : '';
  }
}

export function getChatSessionStatusClass(status?: string): string {
  const normalizedStatus = normalizeChatSessionStatus(status);
  if (normalizedStatus) {
    return normalizedStatus.replace(/[^a-z0-9]+/g, '-');
  }

  return typeof status === 'string' && status.trim().length > 0
    ? status.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    : 'unknown';
}

export function buildChatSessionSearchText(item: ChatSessionListItem): string {
  return [
    item.title,
    item.description,
    resolveChatSessionDisplayDescription(item),
    item.sessionId,
    item.status,
    item.metadata?.providerLabel,
    item.metadata?.projectLabel,
    item.metadata?.workingDirectoryPath,
    item.requestRouting?.customAgentTarget,
    item.requestRouting?.permissionLevel,
    item.requestRouting?.requestModeId,
    item.requestRouting?.selectedModeId,
    ...buildChatSessionDetailSegments(item),
    ...buildChatSessionDiffSegments(item),
    formatChatSessionStatusMeta(item),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

export function groupChatSessionItemsByDate(
  items: readonly ChatSessionListItem[],
  options?: { includeArchived?: boolean },
): readonly ChatSessionInventoryGroup[] {
  const groupingSpan = ChatPerformanceTracer.begin('session_list.grouping', `count=${items.length}`);
  ChatPerformanceTracer.increment('session_list.grouping');
  const now = Date.now();
  const dayThreshold = 24 * 60 * 60 * 1000;
  const weekThreshold = 7 * dayThreshold;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const startOfYesterday = startOfToday - dayThreshold;
  const recentWeekThreshold = now - weekThreshold;
  const includeArchived = options?.includeArchived === true;

  const buckets: ChatSessionInventoryGroup[] = [
    { id: 'pinned', label: 'Pinned', items: [] },
    { id: 'today', label: 'Today', items: [] },
    { id: 'yesterday', label: 'Yesterday', items: [] },
    { id: 'week', label: 'Last 7 Days', items: [] },
    { id: 'older', label: 'Older', items: [] },
    ...(includeArchived ? [{ id: 'archived' as const, label: 'Archived', items: [] }] : []),
  ];

  for (const item of [...items].sort(compareChatSessionPickerItems)) {
    if (item.archived === true) {
      if (includeArchived) {
        (buckets[buckets.length - 1].items as ChatSessionListItem[]).push(item);
      }
      continue;
    }

    if (item.pinned === true) {
      (buckets[0].items as ChatSessionListItem[]).push(item);
      continue;
    }

    const sessionTime = item.timing?.created;
    if (typeof sessionTime !== 'number' || !Number.isFinite(sessionTime)) {
      (buckets[4].items as ChatSessionListItem[]).push(item);
      continue;
    }

    if (sessionTime >= startOfToday) {
      (buckets[1].items as ChatSessionListItem[]).push(item);
    } else if (sessionTime >= startOfYesterday) {
      (buckets[2].items as ChatSessionListItem[]).push(item);
    } else if (sessionTime >= recentWeekThreshold) {
      (buckets[3].items as ChatSessionListItem[]).push(item);
    } else {
      (buckets[4].items as ChatSessionListItem[]).push(item);
    }
  }

  const groups = buckets.filter(group => group.items.length > 0);
  ChatPerformanceTracer.end(groupingSpan, 'session_list.grouping', `groups=${groups.length}`);
  return groups;
}

export function groupChatSessionPickerItemsByDate(items: readonly ChatSessionListItem[]): readonly ChatSessionPickerGroup[] {
  return groupChatSessionItemsByDate(items, { includeArchived: false });
}

function resolveChatSessionTargetLabel(item: ChatSessionListItem): string | undefined {
  const explicitCustomAgentTarget = readNonEmptyString(item.requestRouting?.customAgentTarget);
  if (explicitCustomAgentTarget) {
    return explicitCustomAgentTarget;
  }

  const modeInstructionName = readNonEmptyString(item.inputState?.mode?.modeInstructions?.name);
  if (modeInstructionName) {
    return modeInstructionName;
  }

  const modeId = readNonEmptyString(item.requestRouting?.requestModeId)
    ?? readNonEmptyString(item.requestRouting?.selectedModeId)
    ?? readNonEmptyString(item.mode)
    ?? readNonEmptyString(item.inputState?.mode?.kind)
    ?? readNonEmptyString(item.inputState?.mode?.id);
  if (!modeId) {
    return undefined;
  }

  return createBuiltinChatResolvedMode(normalizeChatModeId(modeId)).label;
}

function resolveChatSessionPermissionLabel(item: ChatSessionListItem): string | undefined {
  const permissionModeLabel = readPermissionModeLabel(item.inputState);
  if (permissionModeLabel) {
    return permissionModeLabel;
  }

  const permissionLevel = readNonEmptyString(item.requestRouting?.permissionLevel);
  return permissionLevel
    ? permissionLevel.split(/[_\s-]+/).map(part => capitalize(part)).join(' ')
    : undefined;
}

function readPermissionModeLabel(inputState?: ChatSessionInputState): string | undefined {
  const selectedPermissionItem = inputState?.groups?.find(group => group.id === 'permissionMode')?.selected?.name;
  return readNonEmptyString(selectedPermissionItem);
}

function formatChatSessionStatusDescription(status?: string): string {
  const detailedDescription = formatDetailedChatSessionStatusDescription(status);
  if (detailedDescription) {
    return detailedDescription;
  }

  switch (normalizeChatSessionStatus(status)) {
    case 'in_progress':
      return 'Working...';
    case 'needs_input':
      return 'Input needed';
    case 'failed':
      return 'Failed';
    default:
      return '';
  }
}

export function isChatSessionActivityInProgress(status?: string): boolean {
  return normalizeChatSessionStatus(status) === 'in_progress';
}

export function isChatSessionUnread(item: Pick<ChatSessionListItem, 'read' | 'markedUnread'>): boolean {
  return item.read !== true || item.markedUnread === true;
}

export function shouldShowChatSessionActivitySpinner(item: Pick<ChatSessionListItem, 'status'>): boolean {
  return isChatSessionActivityInProgress(item.status);
}

export function shouldShowChatSessionUnreadDot(
  item: Pick<ChatSessionListItem, 'read' | 'markedUnread' | 'status'>,
): boolean {
  return isChatSessionUnread(item) && !isChatSessionActivityInProgress(item.status);
}

function isChatSessionInProgressStatus(status?: string): boolean {
  switch (normalizeChatSessionStatus(status)) {
    case 'in_progress':
    case 'needs_input':
      return true;
    default:
      return false;
  }
}

function normalizeChatSessionStatus(status?: string): HostSessionListItemStatus | undefined {
  return normalizeHostSessionListItemStatus(status);
}

function formatDetailedChatSessionStatusLabel(status?: string): string {
  switch (typeof status === 'string' ? status.trim() : '') {
    case 'waiting_question':
      return '等待回答';
    case 'waiting_confirmation':
      return '等待确认';
    case 'waiting_tool_results':
      return '等待结果';
    case 'plan_review':
    case 'waiting_plan_review':
      return '计划评审';
    case 'continue':
      return '等待继续';
    case 'hard_stopped':
      return '已停止';
    default:
      return '';
  }
}

function formatDetailedChatSessionStatusDescription(status?: string): string {
  switch (typeof status === 'string' ? status.trim() : '') {
    case 'waiting_question':
      return 'Waiting for answer';
    case 'waiting_confirmation':
      return 'Waiting for confirmation';
    case 'waiting_tool_results':
      return 'Waiting for tool results';
    case 'plan_review':
    case 'waiting_plan_review':
      return 'Plan review required';
    case 'continue':
      return 'Continue required';
    case 'hard_stopped':
      return 'Stopped';
    default:
      return '';
  }
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatRelativeTime(timestamp: number | null | undefined): string {
  if (!Number.isFinite(timestamp) || (timestamp ?? 0) <= 0) {
    return '';
  }

  const diffMs = (timestamp as number) - Date.now();
  const absMs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (absMs < 60_000) {
    return rtf.format(Math.round(diffMs / 1000), 'second');
  }
  if (absMs < 3_600_000) {
    return rtf.format(Math.round(diffMs / 60_000), 'minute');
  }
  if (absMs < 86_400_000) {
    return rtf.format(Math.round(diffMs / 3_600_000), 'hour');
  }
  if (absMs < 604_800_000) {
    return rtf.format(Math.round(diffMs / 86_400_000), 'day');
  }

  return rtf.format(Math.round(diffMs / 604_800_000), 'week');
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function capitalize(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function appendUniqueSegment(target: string[], value: string | undefined): void {
  if (!value || target.includes(value)) {
    return;
  }

  target.push(value);
}

function compareChatSessionPickerItems(itemA: ChatSessionListItem, itemB: ChatSessionListItem): number {
  const pinnedDelta = Number(itemB.pinned === true) - Number(itemA.pinned === true);
  if (pinnedDelta !== 0) {
    return pinnedDelta;
  }

  const timeA = itemA.timing?.created ?? 0;
  const timeB = itemB.timing?.created ?? 0;
  if (timeA !== timeB) {
    return timeB - timeA;
  }

  return itemA.title.localeCompare(itemB.title, undefined, { sensitivity: 'base' });
}