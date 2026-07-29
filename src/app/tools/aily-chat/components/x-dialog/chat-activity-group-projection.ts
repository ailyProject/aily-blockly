import { ChatPart, ConfirmationPart, MarkdownPart, StatePart, TerminalPart, ThinkingPart, ToolCallPart, buildScopedTextPartId, getParentToolCallId, getSubAgentInvocationId, isSubagentChildPart } from '../../core/chat-parts';
import { projectToolCallApprovalDisplayData } from '../../core/tool-call-approval';
import {
  buildActivityItemsFromDetailSections,
  buildAgentTeamDetailSections,
  buildBackgroundTaskDetailSections,
  buildSubagentDetailSections,
  buildSubagentSubtitle,
  buildStandardStateViewerProjection,
  buildTodoDetailSections,
  buildToolCallDetailSections,
  formatSubagentToolTrailing,
  isSubagentMetadata,
  toneFromSubagentToolState,
  type StateDetailRow,
  type DetailSectionDescriptor,
} from './x-aily-state-viewer/activity-detail-items';
import {
  buildChangedFilesDisplaySummary,
  collectChangedFilesEntriesFromToolMetadata,
  isChangedFilesToolName,
} from './chat-changed-files-display';
import {
  buildToolInvocationDisplaySummary,
  flattenToolInvocationDisplaySummary,
} from '../../core/tool-invocation-formatter';
import {
  isEditSummaryToolName,
  isInternalDiscoveryToolName,
  isSearchSummaryToolName,
  normalizeReadSideToolName,
} from '../../core/tool-name-normalizer';
import { getMarkdownContentWindow } from '../../core/markdown-content-store';
import { getThinkContentWindow } from '../../core/think-content-store';
import { ChatPerformanceTracer } from '../../services/chat-perf-tracer';
import { chatI18n } from '../../helpers/chat-i18n';
import type {
  ActivityApprovalDisplayData,
  ActivityApprovalSummaryDisplayData,
  ActivityGroupDisplayChild,
  ActivityGroupHeaderDisplayData,
  ActivityGroupDisplayItem,
  ActivityInvocationDisplayData,
  ActivityToolbarActionDisplayData,
} from './chat-activity-group.types';

export type ActivityGroupState = 'doing' | 'done' | 'error';

export interface ActivityGroupPresentation {
  header: ActivityGroupHeaderDisplayData;
  countLabel: string;
  state: ActivityGroupState;
  stateLabel: string;
}

export interface PrimaryActivitySummary {
  kicker?: string;
  subtitle?: string;
  note?: string;
  children?: ActivityGroupDisplayChild[];
}

export interface SubagentActivitySummary extends PrimaryActivitySummary {
  label?: string;
}

export interface ActivityShellPresentation {
  iconClass: string;
  iconColor: string;
  pill: string;
  pillTone: string;
  kicker?: string;
}

const SUBAGENT_CHILD_DISPLAY_MAX_CHARS = 12 * 1024;
const SUBAGENT_CHILD_DISPLAY_OMITTED_MARKER = '[earlier subagent output omitted]\n';

export interface ThinkingActivityPresentation {
  iconClass: string;
  iconColor: string;
  kicker: string;
  label: string;
  note?: string;
  thinking?: {
    content?: string;
    ref?: string;
    isComplete?: boolean;
    contentLength?: number;
  };
}

export interface ToolInvocationSummaryDisplay {
  label: string;
  subtitle?: string;
}

export interface ToolTimingSummaryDisplay {
  headerMeta?: string;
}

interface ActivityToolSummaryCandidate {
  toolName: string;
  label?: string;
  subtitle?: string;
  rawText?: string;
  args?: any;
}

export function buildChatPartIdentity(part: ChatPart, index: number): string {
  if (part.type === 'tool_call') {
    return part.toolCallId;
  }
  if (part.type === 'state') {
    return part.stateId;
  }
  if (part.type === 'confirmation') {
    return part.partId || part.askId;
  }
  if (part.type === 'terminal') {
    return part.toolCallId
      || part.partId
      || part.processId
      || part.outputSessionId
      || part.terminalId
      || `terminal-${index}`;
  }
  if (part.type === 'question') {
    return part.partId || `question-${index}`;
  }
  if (part.type === 'thinking') {
    return part.partId || part.contentRef || buildScopedTextPartId('thinking', part, index);
  }
  if (part.type === 'markdown') {
    return part.partId || part.contentRef || buildScopedTextPartId('markdown', part, index);
  }
  if (part.type === 'plan') {
    return part.partId || `plan-${index}`;
  }
  return `error-${index}`;
}

export function buildActivityGroupIdentity(parts: readonly ChatPart[], startIndex = 0): string {
  const firstPart = parts[0];
  if (!firstPart) {
    return `activity:empty:${startIndex}`;
  }

  return `activity:${buildChatPartIdentity(firstPart, startIndex)}`;
}

export function buildSubagentActivityGroupIdentity(subagentInvocationId: string): string {
  return `activity:subagent:${subagentInvocationId.trim() || 'unknown'}`;
}

export function isGroupableActivityPart(part: ChatPart): boolean {
  return part.type === 'thinking'
    || part.type === 'tool_call'
    || part.type === 'confirmation'
    || part.type === 'terminal'
    || isActivityStatePart(part);
}

export function buildActivityGroupPresentation(parts: readonly ChatPart[]): ActivityGroupPresentation {
  const state = getActivityGroupState(parts);
  const countLabel = `${parts.length} 项`;

  return {
    header: buildActivityGroupHeader(parts),
    countLabel,
    state,
    stateLabel: getActivityGroupStateLabel(state),
  };
}

export function getPreparedDetailSections(part: ChatPart): readonly DetailSectionDescriptor[] | undefined {
  if (part.type === 'tool_call') {
    const toolSpecificData = part.metadata?.['toolSpecificData'];
    if (toolSpecificData && typeof toolSpecificData === 'object') {
      const record = toolSpecificData as Record<string, unknown>;
      if (record['kind'] === 'subagent'
        || typeof record['agentName'] === 'string'
        || typeof record['description'] === 'string') {
        const sections = buildSubagentDetailSections({
          id: part.toolCallId,
          metadata: part.metadata || null,
        });
        return sections.length > 0 ? sections : undefined;
      }
    }

    const sections = buildToolCallDetailSections({
      id: part.toolCallId,
      toolName: part.toolName,
      metadata: part.metadata || null,
      args: part.args,
      text: part.text,
      state: part.state,
    });
    return sections.length > 0 ? sections : undefined;
  }

  if (part.type !== 'state') {
    return undefined;
  }

  if (part.kind === 'background_task') {
    const sections = buildBackgroundTaskDetailSections({
      id: part.stateId,
      metadata: part.metadata || null,
    });
    return sections.length > 0 ? sections : undefined;
  }

  if (part.kind === 'todo') {
    const sections = buildTodoDetailSections({ metadata: part.metadata || null });
    return sections.length > 0 ? sections : undefined;
  }

  if (part.kind === 'agent_team' && hasAgentTeamActivityMessages(part.metadata)) {
    const sections = buildAgentTeamDetailSections({ metadata: part.metadata || null });
    return sections.length > 0 ? sections : undefined;
  }

  if (part.kind === 'task_graph'
    || part.kind === 'task_scheduler'
    || part.kind === 'task_autonomy') {
    const projection = buildStandardStateViewerProjection({
      kind: part.kind,
      id: part.stateId,
      metadata: part.metadata || null,
    });
    return projection.sections.length > 0 ? projection.sections : undefined;
  }

  return undefined;
}

export function buildPrimaryActivitySummary(part: ChatPart): PrimaryActivitySummary | undefined {
  const sections = getPreparedDetailSections(part);
  if (!sections?.length) {
    return undefined;
  }

  const items = buildActivityItemsFromDetailSections(sections);
  const first = items[0];
  if (!first) {
    return undefined;
  }

  return {
    kicker: first.kicker,
    subtitle: first.subtitle,
    note: first.note,
    children: items.slice(1).map((item) => ({
      id: item.id,
      kind: 'detail',
      title: item.title,
      subtitle: item.subtitle,
      content: item.note,
      trailing: item.trailing,
      tone: item.tone,
    })),
  };
}

export function buildTodoPrimaryActivitySummary(part: StatePart): PrimaryActivitySummary | undefined {
  if (part.kind !== 'todo') {
    return undefined;
  }

  const metadata = asRecord(part.metadata);
  if (!metadata) {
    return undefined;
  }

  const timeline = asRecordArray(metadata['timeline']);
  const latestEntry = timeline.at(-1) ?? metadata;
  const phaseLabel = asString(latestEntry['phaseLabel']);
  const phaseDetail = asString(latestEntry['phaseDetail']);
  const activeTitle = asString(latestEntry['activeTitle']);
  const summary = asString(latestEntry['summary']) || asString(metadata['summary']);
  const totalCount = asNumber(latestEntry['totalCount']);
  const currentStep = asNumber(latestEntry['currentStep']);
  const completedCount = asNumber(latestEntry['completedCount']);
  const progressLabel = typeof totalCount === 'number' && totalCount > 0
    ? `${Math.max(0, currentStep ?? completedCount ?? 0)}/${totalCount}`
    : undefined;

  const subtitle = phaseDetail || progressLabel || activeTitle || summary;
  if (!phaseLabel && !subtitle) {
    return undefined;
  }

  return {
    kicker: phaseLabel ? '当前记录' : undefined,
    subtitle,
  };
}

export function buildSubagentActivitySummary(
  part: Pick<ToolCallPart, 'toolCallId' | 'text' | 'state' | 'metadata'>,
): SubagentActivitySummary | undefined {
  const metadata = asRecord(part.metadata);
  const toolSpecificData = asRecord(metadata?.['toolSpecificData']);
  if (!isSubagentMetadata(toolSpecificData)) {
    return undefined;
  }

  const argsSummary = asString(metadata?.['argsSummary']);
  const agentName = asString(toolSpecificData?.['agentName']) || '子代理';
  const description = asString(toolSpecificData?.['description']) || argsSummary || part.text || '';
  const result = asString(toolSpecificData?.['result']) || '';
  const childItems = settleSubagentChildItemsForParent(
    asRecordArray(toolSpecificData?.['childItems']),
    part.state,
  );
  const shouldAppendResult = shouldAppendSubagentResult(childItems, result);

  return {
    label: agentName,
    kicker: 'Subagent',
    subtitle: buildSubagentSubtitle(description, childItems, result),
    note: description || undefined,
    children: [
      ...childItems
        .map((item, index) => toSubagentChild(item, index))
        .filter((item): item is ActivityGroupDisplayChild => !!item),
      ...(shouldAppendResult && result ? [{
        id: `${part.toolCallId}:result`,
        kind: 'detail' as const,
        title: '结果',
        content: result,
        tone: part.state === 'error' ? 'error' : 'success',
      }] : []),
    ],
  };
}

export function buildSubagentActivityItems(
  part: Pick<ToolCallPart, 'toolCallId' | 'text' | 'state' | 'metadata'>,
): readonly ActivityGroupDisplayItem[] {
  const startedAt = performance.now();
  let rawChildCount = 0;
  let normalizedChildCount = 0;
  let itemCount = 0;
  const metadata = asRecord(part.metadata);
  const toolSpecificData = asRecord(metadata?.['toolSpecificData']);
  if (!isSubagentMetadata(toolSpecificData)) {
    return [];
  }

  const argsSummary = asString(metadata?.['argsSummary']);
  const description = asString(toolSpecificData['description']) || argsSummary || part.text || '';
  const prompt = asString(toolSpecificData['prompt']);
  const result = asString(toolSpecificData['result']) || '';
  const rawChildItems = asRecordArray(toolSpecificData['childItems']);
  rawChildCount = rawChildItems.length;
  const childItems = settleSubagentChildItemsForParent(
    normalizeSubagentChildItems(rawChildItems),
    part.state,
  );
  normalizedChildCount = childItems.length;
  const shouldAppendResult = shouldAppendSubagentResult(childItems, result);
  const items: ActivityGroupDisplayItem[] = [];

  if (prompt && prompt !== description) {
    items.push(buildSubagentNarrativeItem({
      id: `${part.toolCallId}:prompt`,
      text: prompt,
      tone: 'info',
    }));
  }

  items.push(...childItems.flatMap((item, index) => toSubagentActivityItems(item, index)));

  if (items.length === 0 && description) {
    items.push(buildSubagentPendingItem(part.toolCallId, description, part.state));
  }

  if (shouldAppendResult && result) {
    items.push(buildSubagentNarrativeItem({
      id: `${part.toolCallId}:result`,
      text: result,
      tone: part.state === 'error' ? 'error' : 'success',
    }));
  }

  itemCount = items.length;
  ChatPerformanceTracer.increment('activity_projection.subagent_build.count');
  ChatPerformanceTracer.increment('activity_projection.subagent_child_count.raw', rawChildCount);
  ChatPerformanceTracer.increment('activity_projection.subagent_child_count.normalized', normalizedChildCount);
  ChatPerformanceTracer.recordDuration(
    'activity_projection.subagent_build',
    performance.now() - startedAt,
    `tool=${part.toolCallId},raw=${rawChildCount},normalized=${normalizedChildCount},items=${itemCount},state=${part.state}`,
    { slowThresholdMs: 6 },
  );
  return items;
}

export function buildToolInvocationSummary(
  part: Pick<ToolCallPart, 'toolName' | 'text' | 'args' | 'metadata' | 'state'>,
): ToolInvocationSummaryDisplay | undefined {
  const metadata = asRecord(part.metadata) || null;
  if (isChangedFilesToolName(part.toolName)) {
    const changedFilesSummary = buildChangedFilesDisplaySummary(
      collectChangedFilesEntriesFromToolMetadata(metadata),
    );
    if (changedFilesSummary) {
      return changedFilesSummary;
    }
  }

  const summary = buildToolInvocationDisplaySummary({
    toolName: part.toolName,
    args: part.args,
    metadata,
    state: part.state,
  });
  return summary ? { label: summary.label, subtitle: summary.subtitle } : undefined;
}

export function buildToolTimingSummary(
  part: Pick<ToolCallPart, 'metadata'>,
): ToolTimingSummaryDisplay | undefined {
  const metadata = asRecord(part.metadata);
  const headerMeta = formatToolDuration(asNumber(metadata?.['duration']));
  return headerMeta ? { headerMeta } : undefined;
}

export function buildToolActivityDisplayItem(
  part: ToolCallPart,
  options?: { id?: string; defaultKicker?: string },
): ActivityGroupDisplayItem {
  const approval = projectToolCallApprovalDisplayData(part);
  const approvalSummary = approval?.resolved ? buildResolvedApprovalSummary(approval) : undefined;
  const pendingApproval = !!approval && !approval.resolved;
  const preparedDetailSections = getPreparedDetailSections(part);
  const eagerDetailSections = pendingApproval && approval
    ? buildApprovalDetailSections({
        message: approval.message,
        description: approval.description,
      })
    : preparedDetailSections;
  const detailSections = eagerDetailSections?.length ? eagerDetailSections : undefined;
  const invocationDetail = detailSections
    ? buildInvocationDetailDisplay({
        detailSections,
        postConfirmation: !!approvalSummary,
      })
    : undefined;
  const shell = buildToolActivityShellPresentation({
    state: part.state,
    approval,
    defaultKicker: options?.defaultKicker,
  });
  const toolInvocationSummary = buildToolInvocationSummary(part);
  const toolTimingSummary = buildToolTimingSummary(part);
  const label = pendingApproval
    ? approval.title
    : (toolInvocationSummary?.label || part.text || part.toolName || approval?.title || '工具调用');
  const subtitle = pendingApproval
    ? approval.subtitle
    : (toolInvocationSummary?.subtitle || approval?.subtitle);
  return {
    id: options?.id || buildChatPartIdentity(part, 0),
    kind: 'activity',
    headerKind: 'tool',
    toolHeader: {
      title: label,
      subtitle,
      meta: toolTimingSummary?.headerMeta,
      pill: shell.pill || undefined,
      pillTone: shell.pillTone,
    },
    iconClass: shell.iconClass,
    isSpinning: part.state === 'doing',
    iconColor: shell.iconColor,
    kicker: shell.kicker,
    label,
    subtitle: undefined,
    note: undefined,
    headerMeta: undefined,
    pill: '',
    pillTone: 'neutral',
    approval,
    approvalSummary,
    invocationDetail,
    loadDetail: detailSections ? () => ({
      detailSections,
      invocationDetail,
      detailKind: 'invocation',
    }) : undefined,
    children: undefined,
    detailSections,
    detailExpanded: false,
    detailKind: detailSections?.length ? 'invocation' : undefined,
  };
}

export function buildConfirmationActivityDisplayItem(
  part: ConfirmationPart,
  options?: { id?: string },
): ActivityGroupDisplayItem {
  return buildConfirmationLikeActivityDisplayItem(part, options);
}

function buildConfirmationLikeActivityDisplayItem(
  part: ConfirmationPart,
  options?: { id?: string },
): ActivityGroupDisplayItem {
  const approval: ActivityApprovalDisplayData = {
    kind: 'confirmation',
    partId: part.partId || part.askId,
    askId: part.askId,
    toolName: part.toolName,
    title: part.title,
    subtitle: part.subtitle,
    message: part.message,
    description: part.description,
    args: part.args,
    resolved: part.resolved,
    approved: part.result === 'approved',
    scope: part.scope,
    actions: part.actions,
    primaryScope: part.primaryScope,
  };
  const tone = approval.resolved
    ? (approval.approved === false ? 'warn' : 'success')
    : 'warn';
  const pill = approval.resolved
    ? (approval.approved === false
      ? chatI18n('AILY_CHAT.PROCESS_CONFIRM_RESOLVED_CANCELLED')
      : chatI18n('AILY_CHAT.PROCESS_CONFIRM_RESOLVED_APPROVED'))
    : chatI18n('AILY_CHAT.PROCESS_CONFIRM_PENDING');
  const detailSections = buildApprovalDetailSections({
    message: approval.message,
    description: approval.description,
  });
  const invocationDetail = buildInvocationDetailDisplay({ detailSections });
  const meta = undefined;

  return {
    id: options?.id || buildChatPartIdentity(part, 0),
    kind: 'activity',
    headerKind: 'tool',
    toolHeader: {
      title: approval.title || chatI18n('AILY_CHAT.PROCESS_APPROVAL_DEFAULT_TITLE', undefined, 'Confirm Action'),
      subtitle: approval.subtitle,
      meta,
      pill,
      pillTone: tone,
    },
    iconClass: approval.resolved
      ? (approval.approved === false ? 'fa-light fa-circle-minus' : 'fa-light fa-circle-check')
      : 'fa-light fa-circle-pause',
    isSpinning: false,
    iconColor: getStateColor(approval.resolved ? (approval.approved === false ? 'warn' : 'done') : 'pending_approval'),
    kicker: approval.resolved ? undefined : chatI18n('AILY_CHAT.PROCESS_APPROVAL_KICKER'),
    label: approval.title || chatI18n('AILY_CHAT.PROCESS_APPROVAL_DEFAULT_TITLE', undefined, 'Confirm Action'),
    subtitle: undefined,
    note: undefined,
    headerMeta: undefined,
    pill: '',
    pillTone: 'neutral',
    approval,
    approvalSummary: approval.resolved ? buildResolvedApprovalSummary(approval, 'confirmation') : undefined,
    invocationDetail,
    children: undefined,
    detailSections: detailSections.length ? detailSections : undefined,
    detailExpanded: false,
    detailKind: invocationDetail ? 'invocation' : undefined,
  };
}

function buildApprovalDetailSections(input: {
  message: string;
  description?: string;
}): DetailSectionDescriptor[] {
  const sections: DetailSectionDescriptor[] = [];

  if (input.message.trim()) {
    sections.push({
      title: chatI18n('AILY_CHAT.PROCESS_APPROVAL_SECTION_CURRENT'),
      rows: [{
        id: 'approval-message',
        title: chatI18n('AILY_CHAT.PROCESS_APPROVAL_DETAIL_TITLE'),
        note: input.message,
      }],
    });
  }

  if (input.description?.trim()) {
    sections.push({
      title: chatI18n('AILY_CHAT.PROCESS_APPROVAL_SECTION_OUTPUT'),
      rows: parseApprovalDescriptionRows(input.description),
    });
  }

  return sections;
}

function parseApprovalDescriptionRows(description: string): StateDetailRow[] {
  const rows: StateDetailRow[] = [];
  const codeBlockPattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let codeIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockPattern.exec(description)) !== null) {
    const precedingText = description.slice(cursor, match.index);
    const trailingText = buildApprovalTextRow(precedingText, codeIndex === 0 ? 'approval-description' : `approval-description-note-${codeIndex}`);
    const codeRow = buildApprovalCodeRow(match[1] || '', match[2] || '', codeIndex, trailingText);

    if (codeRow) {
      if (trailingText?.mode === 'standalone') {
        rows.push(trailingText.row);
      }
      rows.push(codeRow);
    } else if (trailingText) {
      rows.push(trailingText.row);
    }

    cursor = match.index + match[0].length;
    codeIndex += 1;
  }

  const trailing = buildApprovalTextRow(description.slice(cursor), `approval-description-tail-${codeIndex}`);
  if (trailing) {
    rows.push(trailing.row);
  }

  return rows.length > 0 ? rows : [{
    id: 'approval-description',
    title: '变更预览',
    note: description,
  }];
}

function buildApprovalTextRow(
  text: string,
  id: string,
): { row: StateDetailRow; mode: 'standalone' | 'paired' } | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  return {
    row: {
      id,
      title: '变更预览',
      note: trimmed,
    },
    mode: 'standalone',
  };
}

function buildApprovalCodeRow(
  infoString: string,
  body: string,
  codeIndex: number,
  precedingText: { row: StateDetailRow; mode: 'standalone' | 'paired' } | undefined,
): StateDetailRow | undefined {
  const parsedInfo = parseApprovalCodeInfo(infoString);
  if (parsedInfo.kind !== 'diff') {
    return undefined;
  }

  const lines = body.split('\n');
  let outputUri: string | undefined;
  if (lines[0]?.startsWith('<aily_codeblock_uri>') && lines[0].endsWith('</aily_codeblock_uri>')) {
    outputUri = lines[0].slice('<aily_codeblock_uri>'.length, -'</aily_codeblock_uri>'.length);
    lines.shift();
  }

  const heading = precedingText?.row.note || '';
  const headingLines = heading.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const [titleLine, ...detailLines] = headingLines;
  if (precedingText) {
    precedingText.mode = 'paired';
  }

  return {
    id: `approval-description-code-${codeIndex}`,
    title: titleLine || '变更预览',
    subtitle: detailLines.length > 0 ? detailLines.join('\n') : undefined,
    outputKind: 'code',
    outputCode: lines.join('\n'),
    outputLanguage: parsedInfo.language || 'diff',
    outputMimeType: 'text/x-diff',
    outputUri,
  };
}

function parseApprovalCodeInfo(infoString: string): { kind: 'diff' | 'other'; language?: string } {
  const trimmed = infoString.trim();
  if (!trimmed.startsWith('diff')) {
    return { kind: 'other' };
  }

  const [, language] = trimmed.split(':', 2);
  return {
    kind: 'diff',
    language: language?.trim() || undefined,
  };
}

export function buildTerminalActivityDisplayItem(
  part: TerminalPart,
  options?: { id?: string },
): ActivityGroupDisplayItem {
  const approval = part.toolCallId
    ? projectToolCallApprovalDisplayData({
      toolCallId: part.toolCallId,
      toolName: 'run_in_terminal',
      state: part.isRunning ? 'doing' : 'done',
      args: { command: part.command, cwd: part.cwd },
      metadata: part.metadata,
    })
    : undefined;
  const approvalSummary = approval?.resolved ? buildResolvedApprovalSummary(approval) : undefined;
  const approvalDetailSections = approval
    ? buildApprovalDetailSections({
      message: approval.message,
      description: approval.description,
    })
    : [];
  const detailSections = [
    ...approvalDetailSections,
    ...buildTerminalDetailSections(part),
  ];
  const invocationDetail = buildInvocationDetailDisplay({
    detailSections,
    postConfirmation: !!approvalSummary,
  });
  const pill = part.isRunning ? '进行中' : (part.exitCode != null && part.exitCode !== 0 ? '失败' : '');
  const tone = part.isRunning ? 'info' : (part.exitCode != null && part.exitCode !== 0 ? 'error' : 'neutral');
  const meta = part.exitCode != null && part.exitCode !== 0 ? `退出码 ${part.exitCode}` : undefined;

  return {
    id: options?.id || buildChatPartIdentity(part, 0),
    kind: 'activity',
    headerKind: 'tool',
    toolHeader: {
      title: chatI18n('AILY_CHAT.PROCESS_TOOL_RUN_COMMAND'),
      subtitle: formatTerminalHeaderCommand(part.command),
      meta,
      pill: pill || undefined,
      pillTone: tone,
    },
    iconClass: part.isRunning
      ? 'fa-light fa-spinner-third'
      : (part.exitCode != null && part.exitCode !== 0 ? 'fa-light fa-circle-xmark' : 'fa-light fa-circle-check'),
    isSpinning: part.isRunning,
    iconColor: getStateColor(part.isRunning ? 'doing' : (part.exitCode != null && part.exitCode !== 0 ? 'error' : 'done')),
    kicker: undefined,
    label: chatI18n('AILY_CHAT.PROCESS_TOOL_RUN_COMMAND'),
    subtitle: undefined,
    note: undefined,
    headerMeta: undefined,
    pill: '',
    pillTone: 'neutral',
    approval,
    approvalSummary,
    invocationDetail,
    toolbarActions: buildTerminalToolbarActions(part),
    children: undefined,
    detailSections,
    detailExpanded: shouldExpandTerminalOutput(part),
    detailKind: invocationDetail ? 'invocation' : undefined,
  };
}

function formatTerminalHeaderCommand(command: string | undefined): string | undefined {
  const normalized = typeof command === 'string'
    ? command.replace(/\s+/g, ' ').trim()
    : '';
  if (!normalized) {
    return undefined;
  }

  const maxLength = 72;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

function buildTerminalToolbarActions(part: TerminalPart): readonly ActivityToolbarActionDisplayData[] {
  const actions: ActivityToolbarActionDisplayData[] = [
    {
      id: 'toggle-output',
      iconClass: 'fa-light fa-chevron-down',
      label: chatI18n('AILY_CHAT.PROCESS_ACTION_TOGGLE_OUTPUT'),
      tooltip: chatI18n('AILY_CHAT.PROCESS_ACTION_TOGGLE_OUTPUT_TOOLTIP'),
    },
  ];

  if (part.outputFilePath) {
    actions.push({
      id: 'open-output-file',
      iconClass: 'fa-light fa-arrow-up-right-from-square',
      label: chatI18n('AILY_CHAT.PROCESS_ACTION_OPEN_OUTPUT'),
      tooltip: chatI18n('AILY_CHAT.PROCESS_ACTION_OPEN_OUTPUT_TOOLTIP'),
      data: { outputFilePath: part.outputFilePath },
    });
  }

  if (part.isRunning && part.processId) {
    const sessionData = {
      processId: part.processId,
      command: part.command,
      ...(part.outputSessionId ? { outputSessionId: part.outputSessionId } : {}),
      ...(part.outputFilePath ? { outputFilePath: part.outputFilePath } : {}),
    };

    actions.push({
      id: 'continue-background',
      iconClass: 'fa-light fa-window-minimize',
      label: chatI18n('AILY_CHAT.PROCESS_ACTION_BACKGROUND'),
      tooltip: chatI18n('AILY_CHAT.PROCESS_ACTION_BACKGROUND_TOOLTIP'),
      data: sessionData,
    });

    actions.push({
      id: 'stop-process',
      iconClass: 'fa-light fa-stop',
      label: chatI18n('AILY_CHAT.PROCESS_ACTION_INTERRUPT'),
      tooltip: chatI18n('AILY_CHAT.PROCESS_ACTION_INTERRUPT_TOOLTIP'),
      data: sessionData,
    });
  }

  if (part.processId) {
    actions.push({
      id: 'open-process-window',
      iconClass: 'fa-light fa-square-terminal',
      label: chatI18n('AILY_CHAT.PROCESS_ACTION_OPEN_WINDOW'),
      tooltip: chatI18n('AILY_CHAT.PROCESS_ACTION_OPEN_WINDOW_TOOLTIP'),
      data: {
        processId: part.processId,
        command: part.command,
        ...(part.outputSessionId ? { outputSessionId: part.outputSessionId } : {}),
        ...(part.outputFilePath ? { outputFilePath: part.outputFilePath } : {}),
      },
    });
  }

  return actions;
}

function shouldExpandTerminalOutput(part: TerminalPart): boolean {
  if (part.isRunning) {
    return !!(part.output || part.stderr);
  }
  return false;
}

export function buildToolActivityShellPresentation(input: {
  state: ToolCallPart['state'];
  approval?: Pick<ActivityApprovalDisplayData, 'resolved'> | undefined;
  defaultKicker?: string;
}): ActivityShellPresentation {
  const resolvedApproval = input.approval?.resolved === true;
  const shouldHideDonePill = input.state === 'done';
  return {
    iconClass: getToolIconClass(input.state),
    iconColor: getStateColor(input.state),
    pill: (resolvedApproval && input.state === 'done') || shouldHideDonePill ? '' : getStatePill(input.state),
    pillTone: (resolvedApproval && input.state === 'done') || shouldHideDonePill ? 'neutral' : getStateTone(input.state),
    kicker: resolvedApproval ? input.defaultKicker : (input.approval ? '审批' : input.defaultKicker),
  };
}

export function buildResolvedApprovalSummary(
  approval: Pick<ActivityApprovalDisplayData, 'approved' | 'scope' | 'primaryScope'>,
  mode: 'approval' | 'confirmation' = 'approval',
): ActivityApprovalSummaryDisplayData {
  const approved = approval.approved !== false;
  const scopeLabel = formatApprovalScopeLabel(approval.scope || approval.primaryScope);
  const isConfirmation = mode === 'confirmation';

  return {
    tone: approved ? 'success' : 'warn',
    statusLabel: isConfirmation
      ? (approved
        ? chatI18n('AILY_CHAT.PROCESS_CONFIRM_RESOLVED_APPROVED')
        : chatI18n('AILY_CHAT.PROCESS_CONFIRM_RESOLVED_CANCELLED'))
      : (approved
        ? chatI18n('AILY_CHAT.PROCESS_APPROVAL_RESOLVED_APPROVED')
        : chatI18n('AILY_CHAT.PROCESS_APPROVAL_RESOLVED_REJECTED')),
    scopeLabel: isConfirmation ? undefined : scopeLabel,
    note: isConfirmation
      ? (approved
        ? chatI18n('AILY_CHAT.PROCESS_CONFIRM_NOTE_APPROVED')
        : chatI18n('AILY_CHAT.PROCESS_CONFIRM_NOTE_CANCELLED'))
      : (approved
        ? (scopeLabel
          ? chatI18n('AILY_CHAT.PROCESS_APPROVAL_NOTE_APPROVED_SCOPED', { scope: scopeLabel })
          : chatI18n('AILY_CHAT.PROCESS_APPROVAL_NOTE_APPROVED'))
        : (scopeLabel
          ? chatI18n('AILY_CHAT.PROCESS_APPROVAL_NOTE_REJECTED_SCOPED', { scope: scopeLabel })
          : chatI18n('AILY_CHAT.PROCESS_APPROVAL_NOTE_REJECTED'))),
  };
}

export function buildInvocationDetailDisplay(input: {
  detailSections?: readonly DetailSectionDescriptor[];
  postConfirmation?: boolean;
}): ActivityInvocationDisplayData | undefined {
  const sections = input.detailSections || [];
  if (sections.length === 0) {
    return undefined;
  }

  const progressSection = sections.find((section) => section.title === '当前记录');
  const argsSection = sections.find((section) => section.title === '调用参数');
  const outputSections = sections.filter((section) => section.title === '工具输出');
  const historySections = sections.filter((section) => section.title !== '调用参数' && section.title !== '当前记录' && section.title !== '工具输出');
  const postConfirmation = input.postConfirmation === true;
  const hasChangedFilesOutput = outputSections.some((section) => section.rows.some((row) => row.outputKind === 'changed-file'));

  return {
    progressSection,
    argsSection,
    outputSections,
    historySections,
    hasWidgetSections: !!argsSection || outputSections.length > 0,
    widgetTitle: postConfirmation ? '确认后执行' : (hasChangedFilesOutput ? '文件变更' : '调用详情'),
    outputTitle: postConfirmation ? '确认后输出' : (hasChangedFilesOutput ? '更改文件' : '输出'),
    postConfirmation,
  };
}

export function buildStateActivityShellPresentation(input: {
  state: StatePart['state'];
  defaultKicker?: string;
}): ActivityShellPresentation {
  return {
    iconClass: getStateIconClass(input.state),
    iconColor: getStateColor(input.state),
    pill: getStatePill(input.state),
    pillTone: getStateTone(input.state),
    kicker: input.defaultKicker,
  };
}

export function buildThinkingActivityPresentation(
  part: Pick<ThinkingPart, 'content' | 'contentRef' | 'contentLength' | 'isComplete'>,
): ThinkingActivityPresentation {
  const isSpinning = !part.isComplete;
  return {
    iconClass: isSpinning ? 'fa-light fa-spinner-third' : 'fa-light fa-circle-check',
    iconColor: isSpinning ? 'var(--chat-info)' : 'var(--chat-success)',
    kicker: isSpinning ? 'Thinking' : 'Thought',
    label: isSpinning ? '思考中' : '思考',
    note: undefined,
    thinking: {
      ...(part.contentRef ? { ref: part.contentRef } : {}),
      ...(!part.contentRef && part.content ? { content: part.content } : {}),
      ...(typeof part.contentLength === 'number' ? { contentLength: part.contentLength } : {}),
      isComplete: part.isComplete,
    },
  };
}

export function buildScopedMarkdownActivityDisplayItem(
  part: MarkdownPart,
  options?: { id?: string },
): ActivityGroupDisplayItem {
  const content = part.contentRef
    ? getMarkdownContentWindow(part.contentRef, SUBAGENT_CHILD_DISPLAY_MAX_CHARS, SUBAGENT_CHILD_DISPLAY_OMITTED_MARKER)
    : part.content;

  return {
    id: options?.id || buildChatPartIdentity(part, 0),
    kind: 'activity',
    iconClass: 'fa-light fa-message-lines',
    isSpinning: false,
    iconColor: getSubagentStepColor('neutral'),
    kicker: 'Output',
    label: '输出',
    note: content,
    noteRenderMode: 'markdown',
    pill: '',
    pillTone: 'neutral',
  };
}

function getActivityGroupTitle(parts: readonly ChatPart[]): string {
  const singleStandaloneState = parts.length === 1 && parts[0]?.type === 'state'
    ? getStandaloneStateGroupTitle(parts[0])
    : undefined;
  const shouldUseGenericStateTitle = parts.length === 1
    && parts[0]?.type === 'state'
    && !singleStandaloneState
    && !isActivityStatePart(parts[0]);
  const hasToolLike = parts.some((part) => isToolLikeActivityPart(part));
  const hasAgentTeamActivity = parts.some((part) => part.type === 'state'
    && part.kind === 'agent_team'
    && hasAgentTeamActivityMessages(part.metadata));
  const hasSubagent = parts.some((part) => isSubagentToolCall(part));
  const latestActivityState = parts
    .filter((part): part is StatePart => isActivityStatePart(part))
    .at(-1);
  const hasThinking = parts.some((part) => part.type === 'thinking');

  if (singleStandaloneState) {
    return singleStandaloneState;
  }

  if (shouldUseGenericStateTitle) {
    return '状态';
  }

  if (hasSubagent) {
    return '子代理';
  }
  if (hasAgentTeamActivity) {
    return '协作';
  }

  if (latestActivityState) {
    return getActivityStateGroupTitle(latestActivityState);
  }

  if (hasThinking) {
    return '思考';
  }

  if (hasToolLike) {
    return '工具';
  }

  return '思考';
}

function getActivityGroupSubtitle(parts: readonly ChatPart[]): string {
  const latestSubagentPart = parts
    .filter((part): part is ToolCallPart => part.type === 'tool_call' && isSubagentToolCall(part))
    .at(-1);
  const subagentName = latestSubagentPart ? getSubagentName(latestSubagentPart) : undefined;
  const subagentDescription = latestSubagentPart ? getSubagentDescription(latestSubagentPart) : undefined;
  const activityStateText = parts
    .filter((part): part is StatePart => part.type === 'state')
    .map((part) => getActivityStateSummary(part))
    .filter((text): text is string => !!text)
    .at(-1);
  const toolTexts = parts
    .filter((part) => isToolLikeActivityPart(part))
    .map((part) => {
      const summary = buildActivityToolSummaryCandidate(part);
      return summary.label || summary.subtitle || summary.rawText || '';
    })
    .filter((text) => !!text);

  if (subagentName && subagentDescription) {
    return `${subagentName} · ${subagentDescription}`;
  }

  if (subagentDescription) {
    return subagentDescription;
  }

  if (subagentName && toolTexts.length > 0) {
    return `${subagentName} · ${toolTexts[toolTexts.length - 1]}`;
  }

  if (subagentName) {
    return subagentName;
  }

  if (activityStateText) {
    return activityStateText;
  }

  if (toolTexts.length > 0 && !parts.some((part) => part.type === 'thinking') && !parts.some((part) => isActivityStatePart(part))) {
    return toolTexts[toolTexts.length - 1];
  }

  return '';
}

function buildActivityGroupHeader(parts: readonly ChatPart[]): ActivityGroupHeaderDisplayData {
  const subagentHeader = buildSubagentGroupHeader(parts);
  if (subagentHeader) {
    return subagentHeader;
  }

  const title = getActivityGroupTitle(parts);
  const detail = getActivityGroupSubtitle(parts) || undefined;

  if (title === '思考') {
    const thinkingTitle = buildThinkingGroupSummaryTitle(parts);
    return {
      kind: 'thinking',
      title: thinkingTitle?.title || title,
      titleDetail: thinkingTitle?.detail,
    };
  }

  if (title === '工具') {
    const toolHeader = buildToolOnlyGroupHeader(parts);
    if (toolHeader) {
      return toolHeader;
    }

    return {
      kind: 'tool',
      title: detail || title,
    };
  }

  if (title === '协作') {
    return {
      kind: 'collaboration',
      title,
      detail,
    };
  }

  if (parts.some((part) => part.type === 'state')) {
    return {
      kind: 'state',
      title,
      detail,
    };
  }

  return {
    kind: 'default',
    title,
    detail,
  };
}

function buildThinkingGroupSummaryTitle(parts: readonly ChatPart[]): { title: string; detail?: string } | undefined {
  if (parts.some((part) => part.type === 'thinking' && part.isComplete === false)) {
    return undefined;
  }

  const toolSummaries = parts
    .filter((part): part is ToolCallPart => part.type === 'tool_call')
    .map((part) => buildActivityToolSummaryCandidate(part))
    .filter((summary) => !isInternalDiscoveryToolSummary(summary));

  if (toolSummaries.length === 0) {
    return undefined;
  }

  if (toolSummaries.length === 1) {
    const summaryTitle = toolSummaries[0].label || toolSummaries[0].rawText;
    if (!summaryTitle) {
      return undefined;
    }

    return splitHeaderSummaryTitle(summaryTitle);
  }

  const aggregateTitle = buildAggregateThinkingSummaryTitle(toolSummaries);
  if (!aggregateTitle) {
    return undefined;
  }

  return splitHeaderSummaryTitle(aggregateTitle);
}

function isInternalDiscoveryToolSummary(summary: ActivityToolSummaryCandidate): boolean {
  return isInternalDiscoveryToolName(summary.toolName);
}

function buildToolOnlyGroupHeader(parts: readonly ChatPart[]): ActivityGroupHeaderDisplayData | undefined {
  const toolParts = parts.filter((part) => isToolLikeActivityPart(part));
  const latestToolPart = toolParts.at(-1);

  if (!latestToolPart) {
    return undefined;
  }

  if (toolParts.length === 1) {
    return {
      kind: 'tool',
      title: '工具',
    };
  }

  const summary = buildActivityToolSummaryCandidate(latestToolPart);
  return {
    kind: 'tool',
    title: summary.label || summary.rawText || '工具',
    detail: summary.label ? summary.subtitle : undefined,
  };
}

function buildActivityToolSummaryCandidate(part: ToolCallPart | ConfirmationPart | TerminalPart): ActivityToolSummaryCandidate {
  if (part.type === 'confirmation') {
    return {
      toolName: normalizeToolName(part.toolName || 'confirmation'),
      label: normalizeThinkingHeaderText(part.title),
      subtitle: normalizeThinkingHeaderText(part.subtitle),
      rawText: normalizeThinkingHeaderText(part.message),
      args: part.args,
    };
  }

  if (part.type === 'terminal') {
    return {
      toolName: 'run_in_terminal',
      label: normalizeThinkingHeaderText(chatI18n('AILY_CHAT.PROCESS_TOOL_RUN_COMMAND')),
      subtitle: normalizeThinkingHeaderText(part.command),
      rawText: normalizeThinkingHeaderText(part.command),
      args: { command: part.command },
    };
  }

  const summary = buildToolInvocationSummary(part);

  return {
    toolName: normalizeToolName(part.toolName),
    label: normalizeThinkingHeaderText(summary?.label),
    subtitle: normalizeThinkingHeaderText(summary?.subtitle),
    rawText: normalizeThinkingHeaderText(part.text),
    args: part.args,
  };
}

function buildAggregateThinkingSummaryTitle(toolSummaries: readonly ActivityToolSummaryCandidate[]): string | undefined {
  const readTargets = uniqueValues(toolSummaries.map((summary) => extractReadTarget(summary)).filter((value): value is string => !!value));
  const searchQueries = uniqueValues(toolSummaries.map((summary) => extractSearchQuery(summary)).filter((value): value is string => !!value));
  const editTargets = uniqueValues(toolSummaries.map((summary) => extractEditTarget(summary)).filter((value): value is string => !!value));
  const hasLint = toolSummaries.some((summary) => summary.toolName === 'lint');
  const hasUnsupportedTools = toolSummaries.some((summary) => !isThinkingSummaryTool(summary.toolName));

  const withLintSummary = (title: string | undefined): string | undefined => {
    if (!hasLint) {
      return title;
    }

    if (!title) {
      return 'Checked generated code';
    }

    return title.includes('checked generated code')
      ? title
      : `${title} and checked generated code`;
  };

  if (hasUnsupportedTools) {
    return undefined;
  }

  if (editTargets.length > 0) {
    if (editTargets.length === 1 && readTargets.length === 1 && readTargets[0] === editTargets[0] && searchQueries.length === 0) {
      return withLintSummary(`Reviewed and updated ${editTargets[0]}`);
    }

    if (editTargets.length === 1 && readTargets.length === 0 && searchQueries.length === 0) {
      return withLintSummary(`Updated ${editTargets[0]}`);
    }

    if (editTargets.length > 1 && readTargets.length === 0 && searchQueries.length === 0) {
      return withLintSummary(`Modified ${editTargets.length} files`);
    }

    if (searchQueries.length === 0 && readTargets.length > 0) {
      const readSummary = readTargets.length === 1 ? readTargets[0] : `${readTargets.length} files`;
      return withLintSummary(editTargets.length === 1
        ? `Updated ${editTargets[0]} and reviewed ${readSummary}`
        : `Modified ${editTargets.length} files and reviewed ${readSummary}`);
    }

    return withLintSummary(undefined);
  }

  if (searchQueries.length === 1 && (readTargets.length > 0 || toolSummaries.length > 1)) {
    return withLintSummary(`Analyzed ${searchQueries[0]}`);
  }

  if (readTargets.length > 0 && searchQueries.length === 0) {
    return withLintSummary(readTargets.length === 1 ? `Reviewed ${readTargets[0]}` : `Reviewed ${readTargets.length} files`);
  }

  if (readTargets.length > 0 && searchQueries.length > 1) {
    return withLintSummary('Analyzed code paths');
  }

  if (searchQueries.length === 1) {
    return withLintSummary(`Searched for ${searchQueries[0]}`);
  }

  if (searchQueries.length === 2) {
    return withLintSummary(`Searched for ${searchQueries[0]} and ${searchQueries[1]}`);
  }

  if (searchQueries.length > 2) {
    return withLintSummary('Searched code paths');
  }

  return withLintSummary(undefined);
}

function splitHeaderSummaryTitle(value: string): { title: string; detail?: string } {
  const firstSpaceIndex = value.indexOf(' ');
  if (firstSpaceIndex === -1) {
    return { title: value };
  }

  const title = value.slice(0, firstSpaceIndex).trim();
  const detail = value.slice(firstSpaceIndex + 1).trim();

  return {
    title: title || value,
    detail: detail || undefined,
  };
}

function normalizeThinkingHeaderText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (!singleLine) {
    return undefined;
  }

  return isChatI18nDisplayKey(singleLine) ? chatI18n(singleLine) : singleLine;
}

function isChatI18nDisplayKey(value: string): boolean {
  return /^[A-Z][A-Z0-9]*(?:\.[A-Z0-9_]+)+$/.test(value);
}

function extractReadTarget(summary: ActivityToolSummaryCandidate): string | undefined {
  if (summary.toolName !== 'read_file' || !summary.label?.startsWith('Read ')) {
    return undefined;
  }

  return normalizeThinkingHeaderText(summary.label.slice('Read '.length));
}

function extractSearchQuery(summary: ActivityToolSummaryCandidate): string | undefined {
  if (!isSearchSummaryTool(summary.toolName)) {
    return undefined;
  }

  const directQuery = normalizeThinkingHeaderText(asString(summary.args?.query) || asString(summary.args?.pattern));
  if (directQuery) {
    return directQuery;
  }

  if (summary.subtitle?.startsWith('for ')) {
    return normalizeThinkingHeaderText(summary.subtitle.slice('for '.length));
  }

  return undefined;
}

function extractEditTarget(summary: ActivityToolSummaryCandidate): string | undefined {
  if (!isEditSummaryTool(summary.toolName) || !summary.label) {
    return undefined;
  }

  const firstSpaceIndex = summary.label.indexOf(' ');
  if (firstSpaceIndex === -1) {
    return undefined;
  }

  return normalizeThinkingHeaderText(summary.label.slice(firstSpaceIndex + 1));
}

function isThinkingSummaryTool(toolName: string): boolean {
  const normalizedToolName = normalizeToolName(toolName);
  return isSearchSummaryTool(normalizedToolName)
    || normalizedToolName === 'read_file'
    || normalizedToolName === 'lint'
    || isEditSummaryTool(normalizedToolName);
}

function isSearchSummaryTool(toolName: string): boolean {
  return isSearchSummaryToolName(toolName);
}

function isEditSummaryTool(toolName: string): boolean {
  return isEditSummaryToolName(toolName);
}

function normalizeToolName(toolName: string): string {
  return normalizeReadSideToolName(toolName);
}

function uniqueValues(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function buildSubagentGroupHeader(parts: readonly ChatPart[]): ActivityGroupHeaderDisplayData | undefined {
  const latestSubagentPart = parts
    .filter((part): part is ToolCallPart => part.type === 'tool_call' && isSubagentToolCall(part))
    .at(-1);
  const scopedChildParts = collectSubagentScopedChildParts(parts, latestSubagentPart);

  if (!latestSubagentPart) {
    if (scopedChildParts.length === 0) {
      return undefined;
    }

    return {
      kind: 'subagent',
      title: 'Subagent',
      detail: buildScopedSubagentHeaderDetail(scopedChildParts) || undefined,
    };
  }

  const toolSpecificData = asRecord(latestSubagentPart.metadata?.['toolSpecificData']);
  const childItems = normalizeSubagentChildItems(asRecordArray(toolSpecificData?.['childItems']));
  const result = asString(toolSpecificData?.['result']) || '';
  const description = asString(toolSpecificData?.['description']) || '';
  const fallbackDetail = flattenToolInvocationDisplaySummary(buildToolInvocationDisplaySummary({
    toolName: latestSubagentPart.toolName,
    args: latestSubagentPart.args,
    metadata: asRecord(latestSubagentPart.metadata) || null,
  })) || latestSubagentPart.text || '';
  const prefix = capitalizeHeaderLabel(getSubagentName(latestSubagentPart) || '子代理');
  const detail = normalizeSubagentHeaderDetail(
    prefix,
    buildSubagentSubtitle(description, childItems, result)
      || buildScopedSubagentHeaderDetail(scopedChildParts)
      || fallbackDetail,
  );

  return {
    kind: 'subagent',
    title: prefix,
    detail: detail || undefined,
  };
}

function getActivityGroupState(parts: readonly ChatPart[]): ActivityGroupState {
  const toolStates = parts
    .filter((part) => isToolLikeActivityPart(part))
    .map((part) => getToolLikeActivityState(part));
  const stateStates = parts
    .filter((part): part is StatePart => part.type === 'state')
    .map((part) => part.state);
  const hasIncompleteThinking = parts.some((part) => part.type === 'thinking' && !part.isComplete);

  if (toolStates.includes('error') || stateStates.includes('error')) {
    return 'error';
  }

  if (toolStates.includes('doing') || toolStates.includes('pending_approval') || stateStates.includes('doing') || hasIncompleteThinking) {
    return 'doing';
  }
  return 'done';
}

function isToolLikeActivityPart(part: ChatPart): part is ToolCallPart | ConfirmationPart | TerminalPart {
  return part.type === 'tool_call' || part.type === 'confirmation' || part.type === 'terminal';
}

function getToolLikeActivityState(part: ToolCallPart | ConfirmationPart | TerminalPart): string {
  if (part.type === 'confirmation') {
    return part.resolved ? 'done' : 'pending_approval';
  }

  if (part.type === 'terminal') {
    if (part.isRunning) {
      return 'doing';
    }

    return part.exitCode != null && part.exitCode !== 0 ? 'error' : 'done';
  }

  const state = String(part.state || '').trim().toLowerCase();
  if (state === 'running' || state === 'loading' || state === 'pending' || state === 'streaming') {
    return 'doing';
  }
  if (state === 'completed' || state === 'complete' || state === 'success' || state === 'succeeded') {
    return 'done';
  }
  if (state === 'failed' || state === 'failure') {
    return 'error';
  }
  return state;
}

function buildTerminalDetailSections(part: TerminalPart): readonly DetailSectionDescriptor[] {
  const terminalKey = getTerminalDisplayKey(part);
  const commandTone: StateDetailRow['tone'] = part.isRunning
    ? 'info'
    : (part.exitCode != null && part.exitCode !== 0 ? 'error' : 'success');
  const metadataRows = buildTerminalMetadataRows(part, terminalKey);
  const rows = [
    {
      id: `${terminalKey}:command`,
      title: '命令',
      subtitle: part.cwd,
      note: part.command,
      trailing: formatTerminalStatusLabel(part),
      tone: commandTone,
      outputKind: 'terminal-command' as const,
    },
    ...metadataRows,
    ...(part.output ? [{
      id: `${terminalKey}:stdout`,
      title: 'stdout tail',
      subtitle: formatTerminalTailSubtitle(part, 'stdout'),
      note: part.output,
      tone: 'neutral' as const,
      outputKind: 'terminal-stream' as const,
      outputChannel: 'stdout' as const,
    }] : []),
    ...(part.stderr ? [{
      id: `${terminalKey}:stderr`,
      title: 'stderr tail',
      subtitle: formatTerminalTailSubtitle(part, 'stderr'),
      note: part.stderr,
      tone: 'error' as const,
      outputKind: 'terminal-stream' as const,
      outputChannel: 'stderr' as const,
    }] : []),
  ];

  return [{
    title: '工具输出',
    rows,
    outputGroups: [{
      id: `${terminalKey}:output-group`,
      kind: 'terminal',
      rows,
    }],
  }];
}

function buildTerminalMetadataRows(part: TerminalPart, terminalKey: string): StateDetailRow[] {
  const rows: StateDetailRow[] = [];

  if (typeof part.bytesTotal === 'number' && Number.isFinite(part.bytesTotal)) {
    rows.push({
      id: `${terminalKey}:bytes`,
      title: chatI18n('AILY_CHAT.PROCESS_OUTPUT_RECORDED'),
      note: formatTerminalByteCount(part.bytesTotal),
      trailing: part.outputSessionId ? chatI18n('AILY_CHAT.PROCESS_OUTPUT_READ_ON_DEMAND') : undefined,
      tone: 'neutral',
      outputKind: 'default',
    });
  }

  if (part.outputFilePath) {
    rows.push({
      id: `${terminalKey}:output-file`,
      title: chatI18n('AILY_CHAT.PROCESS_OUTPUT_FILE'),
      note: part.outputFilePath,
      trailing: chatI18n('AILY_CHAT.PROCESS_OUTPUT_FULL'),
      tone: 'neutral',
      outputKind: 'resource',
      outputUri: part.outputFilePath,
    });
  }

  if (part.processId || part.outputSessionId) {
    rows.push({
      id: `${terminalKey}:identity`,
      title: chatI18n('AILY_CHAT.PROCESS_SESSION_TITLE'),
      note: [
        part.processId ? `processId=${part.processId}` : undefined,
        part.outputSessionId ? `outputSessionId=${part.outputSessionId}` : undefined,
      ].filter(Boolean).join('\n'),
      tone: 'neutral',
      outputKind: 'default',
    });
  }

  return rows;
}

function formatTerminalTailSubtitle(part: TerminalPart, stream: 'stdout' | 'stderr'): string | undefined {
  const parts: string[] = [chatI18n('AILY_CHAT.PROCESS_TAIL_LIVE')];
  if (typeof part.bytesTotal === 'number' && Number.isFinite(part.bytesTotal)) {
    parts.push(formatTerminalByteCount(part.bytesTotal));
  }
  if (stream === 'stdout' && part.outputFilePath) {
    parts.push(chatI18n('AILY_CHAT.PROCESS_OUTPUT_FULL_IN_FILE'));
  }
  return parts.join(' · ');
}

function formatTerminalByteCount(value: number): string {
  const bytes = Math.max(0, Math.floor(value));
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let current = bytes / 1024;
  for (const unit of units) {
    if (current < 1024 || unit === units[units.length - 1]) {
      return `${current >= 10 ? current.toFixed(0) : current.toFixed(1)} ${unit}`;
    }
    current /= 1024;
  }
  return `${bytes} B`;
}

function formatTerminalStatusLabel(part: TerminalPart): string {
  if (part.isRunning) {
    return chatI18n('AILY_CHAT.PROCESS_STATUS_RUNNING');
  }
  if (part.status === 'killed') {
    return chatI18n('AILY_CHAT.PROCESS_STATUS_STOPPED');
  }
  if (part.status === 'timeout') {
    return chatI18n('AILY_CHAT.PROCESS_STATUS_TIMED_OUT');
  }
  if (part.exitCode != null) {
    return `${chatI18n('AILY_CHAT.PROCESS_LABEL_EXIT_CODE')} ${part.exitCode}`;
  }
  if (part.status) {
    return part.status;
  }
  return chatI18n('AILY_CHAT.PROCESS_STATUS_COMPLETED');
}

function getTerminalDisplayKey(part: TerminalPart): string {
  return part.processId || part.outputSessionId || part.terminalId || part.toolCallId || part.partId || 'terminal';
}

function getActivityGroupStateLabel(state: ActivityGroupState): string {
  if (state === 'error') {
    return chatI18n('AILY_CHAT.PROCESS_STATUS_FAILED');
  }
  if (state === 'done') {
    return chatI18n('AILY_CHAT.PROCESS_STATUS_COMPLETED');
  }
  return chatI18n('AILY_CHAT.PROCESS_STATUS_RUNNING');
}

function getToolIconClass(state: ToolCallPart['state']): string {
  switch (state) {
    case 'done':
      return 'fa-light fa-circle-check';
    case 'error':
      return 'fa-light fa-circle-exclamation';
    case 'warn':
      return 'fa-light fa-triangle-exclamation';
    case 'pending_approval':
      return 'fa-light fa-circle-pause';
    default:
      return 'fa-light fa-spinner-third';
  }
}

function getStateIconClass(state: StatePart['state']): string {
  switch (state) {
    case 'done':
      return 'fa-light fa-circle-check';
    case 'error':
      return 'fa-light fa-circle-exclamation';
    case 'warn':
      return 'fa-light fa-triangle-exclamation';
    case 'info':
      return 'fa-light fa-circle-info';
    default:
      return 'fa-light fa-spinner-third';
  }
}

function getStateColor(state: string): string {
  switch (state) {
    case 'done':
      return 'var(--chat-success)';
    case 'error':
      return 'var(--chat-error)';
    case 'warn':
      return 'var(--chat-warn)';
    case 'info':
    case 'doing':
      return 'var(--chat-info)';
    case 'pending_approval':
      return 'var(--chat-warn)';
    default:
      return 'var(--chat-fg-muted)';
  }
}

function getStatePill(state: string): string {
  switch (state) {
    case 'done':
      return '完成';
    case 'error':
      return '失败';
    case 'warn':
      return '警告';
    case 'pending_approval':
      return chatI18n('AILY_CHAT.PROCESS_APPROVAL_PENDING');
    default:
      return '';
  }
}

function getStateTone(state: string): string {
  switch (state) {
    case 'done':
      return 'success';
    case 'error':
      return 'error';
    case 'warn':
      return 'warn';
    case 'doing':
    case 'info':
      return 'info';
    case 'pending_approval':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function isSubagentToolCall(part: ChatPart): part is ToolCallPart {
  if (part.type !== 'tool_call') {
    return false;
  }

  const toolSpecificData = part.metadata?.['toolSpecificData'];
  if (!toolSpecificData || typeof toolSpecificData !== 'object') {
    return false;
  }

  const record = toolSpecificData as Record<string, unknown>;
  return record['kind'] === 'subagent'
    || typeof record['agentName'] === 'string'
    || typeof record['description'] === 'string';
}

function getSubagentName(part: ToolCallPart): string | undefined {
  const toolSpecificData = part.metadata?.['toolSpecificData'];
  if (!toolSpecificData || typeof toolSpecificData !== 'object') {
    return undefined;
  }

  const agentName = (toolSpecificData as Record<string, unknown>)['agentName'];
  return typeof agentName === 'string' && agentName.length > 0 ? agentName : undefined;
}

function getSubagentDescription(part: ToolCallPart): string | undefined {
  const toolSpecificData = part.metadata?.['toolSpecificData'];
  if (!toolSpecificData || typeof toolSpecificData !== 'object') {
    return undefined;
  }

  const description = (toolSpecificData as Record<string, unknown>)['description'];
  return typeof description === 'string' && description.length > 0 ? description : undefined;
}

function capitalizeHeaderLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeSubagentHeaderDetail(prefix: string, detail: string): string {
  const trimmed = detail.trim();
  if (!trimmed) {
    return '';
  }

  const escapedPrefix = escapeRegExp(prefix.trim());
  const deduped = trimmed.replace(new RegExp(`^${escapedPrefix}(?:\\s*[:：·\\-—]\\s*|\\s+)`, 'i'), '').trim();
  if (!deduped && trimmed.localeCompare(prefix, undefined, { sensitivity: 'accent' }) === 0) {
    return '';
  }

  return deduped || trimmed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isActivityStatePart(part: ChatPart): part is StatePart {
  return part.type === 'state' && (
    part.kind === 'todo'
    || part.kind === 'background_task'
    || (part.kind === 'agent_team' && hasAgentTeamActivityMessages(part.metadata))
  );
}

function getActivityStateGroupTitle(part: StatePart): string {
  if (part.kind === 'todo') {
    return 'Todo';
  }

  if (part.kind === 'agent_team') {
    return '协作';
  }

  if (part.kind === 'background_task') {
    return '任务';
  }

  return '状态';
}

function getStandaloneStateGroupTitle(part: StatePart): string | undefined {
  switch (part.kind) {
    case 'todo':
      return 'Todo';
    case 'instructions':
      return '提示';
    case 'handoff':
      return '切换';
    case 'mcp':
      return 'MCP';
    case 'task_graph':
      return '任务图';
    case 'task_scheduler':
      return '调度';
    case 'task_autonomy':
      return '自治';
    default:
      return undefined;
  }
}

function getActivityStateSummary(part: StatePart): string | undefined {
  if (part.kind === 'agent_team' && hasAgentTeamActivityMessages(part.metadata)) {
    return getAgentTeamActivitySummary(part);
  }

  const metadata = part.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return part.text || undefined;
  }

  const record = metadata as Record<string, unknown>;
  const description = record['description'];
  if (typeof description === 'string' && description.length > 0) {
    return description;
  }

  const summary = record['summary'];
  if (typeof summary === 'string' && summary.length > 0) {
    return summary;
  }

  return part.text || undefined;
}

function hasAgentTeamActivityMessages(metadata: StatePart['metadata']): boolean {
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }

  const recentMessages = (metadata as Record<string, unknown>)['recentMessages'];
  return Array.isArray(recentMessages) && recentMessages.length > 0;
}

function getAgentTeamActivitySummary(part: StatePart): string | undefined {
  const metadata = part.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return part.text || undefined;
  }

  const recentMessages = (metadata as Record<string, unknown>)['recentMessages'];
  if (!Array.isArray(recentMessages) || recentMessages.length === 0) {
    return part.text || undefined;
  }

  const latestMessage = recentMessages[recentMessages.length - 1];
  if (!latestMessage || typeof latestMessage !== 'object') {
    return part.text || undefined;
  }

  const record = latestMessage as Record<string, unknown>;
  const content = record['content'];
  if (typeof content === 'string' && content.length > 0) {
    return content;
  }

  const fromRoleId = record['fromRoleId'];
  const toRoleId = record['toRoleId'];
  if (typeof fromRoleId === 'string' && typeof toRoleId === 'string') {
    return `${fromRoleId} -> ${toRoleId}`;
  }

  return part.text || undefined;
}

function toSubagentChild(item: Record<string, unknown>, index: number): ActivityGroupDisplayChild | null {
  const kind = asString(item['kind']);
  const content = asString(item['content']) || '';
  const toolName = asString(item['toolName']);
  const argsSummary = asString(item['argsSummary']);
  const toolState = asString(item['state']);
  const duration = asNumber(item['duration']);
  const itemId = asString(item['toolCallId']) || `subagent-item-${index}`;

  if (kind === 'thinking') {
    return {
      id: `${itemId}:thinking`,
      kind: 'thinking',
      title: '思考',
      content,
      tone: 'info',
    };
  }

  if (kind === 'tool') {
    return {
      id: `${itemId}:tool`,
      kind: 'tool',
      title: toolName || '工具调用',
      subtitle: argsSummary,
      content: undefined,
      trailing: formatSubagentToolTrailing(toolState, duration),
      tone: toneFromSubagentToolState(toolState),
    };
  }

  if (kind === 'question') {
    if (!content) {
      return null;
    }

    return {
      id: `${itemId}:question`,
      kind: 'detail',
      title: '提问',
      content,
      tone: 'info',
    };
  }

  if (!content) {
    return null;
  }

  return {
    id: `${itemId}:text`,
    kind: 'text',
    content,
    tone: 'neutral',
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => !!item)
    : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatToolDuration(duration: number | undefined): string | undefined {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
    return undefined;
  }

  return `${duration >= 10 ? duration.toFixed(0) : duration.toFixed(1)}s`;
}

function formatApprovalScopeLabel(scope?: string): string | undefined {
  const map: Record<string, string> = {
    once: '仅本次',
    session: '本会话',
    workspace: '工作区',
    'session-all-terminal': '会话终端',
    'session-safe': '安全命令',
  };
  return scope ? (map[scope] || scope) : undefined;
}

function getSubagentStepIconClass(tone: string | undefined): string {
  switch (tone) {
    case 'success':
      return 'fa-light fa-circle-check';
    case 'warn':
      return 'fa-light fa-triangle-exclamation';
    case 'error':
      return 'fa-light fa-circle-xmark';
    case 'info':
      return 'fa-light fa-circle-info';
    default:
      return 'fa-light fa-circle';
  }
}

function getSubagentStepColor(tone: string | undefined): string {
  switch (tone) {
    case 'success':
      return 'var(--chat-success)';
    case 'warn':
      return 'var(--chat-warn)';
    case 'error':
      return 'var(--chat-error)';
    case 'info':
      return 'var(--chat-info)';
    default:
      return 'var(--chat-fg-muted)';
  }
}

function getSubagentStepPillTone(tone: string | undefined): string {
  switch (tone) {
    case 'success':
    case 'warn':
    case 'error':
    case 'info':
      return tone;
    default:
      return 'neutral';
  }
}

function resolveSubagentChildContent(item: Record<string, unknown>): string {
  const contentRef = asString(item['contentRef']);
  if (contentRef) {
    const contentKind = asString(item['contentKind']);
    return contentKind === 'thinking'
      ? getThinkContentWindow(contentRef, SUBAGENT_CHILD_DISPLAY_MAX_CHARS, SUBAGENT_CHILD_DISPLAY_OMITTED_MARKER)
      : getMarkdownContentWindow(contentRef, SUBAGENT_CHILD_DISPLAY_MAX_CHARS, SUBAGENT_CHILD_DISPLAY_OMITTED_MARKER);
  }

  const content = asString(item['content']) || '';
  if (content.length <= SUBAGENT_CHILD_DISPLAY_MAX_CHARS) {
    return content;
  }

  const tailLength = Math.max(0, SUBAGENT_CHILD_DISPLAY_MAX_CHARS - SUBAGENT_CHILD_DISPLAY_OMITTED_MARKER.length);
  return `${SUBAGENT_CHILD_DISPLAY_OMITTED_MARKER}${content.slice(-tailLength)}`;
}

function normalizeSubagentChildItems(items: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const startedAt = performance.now();
  const normalized: Record<string, unknown>[] = [];

  try {
  for (const item of items) {
    const kind = asString(item['kind']);
    if (!kind) {
      continue;
    }

    if (kind === 'tool') {
      const toolCallId = asString(item['toolCallId']);
      if (toolCallId) {
        const existingIndex = normalized.findIndex((candidate) => (
          asString(candidate['kind']) === 'tool' && asString(candidate['toolCallId']) === toolCallId
        ));
        if (existingIndex >= 0) {
          normalized[existingIndex] = { ...normalized[existingIndex], ...item };
          continue;
        }
      }

      normalized.push({ ...item });
      continue;
    }

    const contentRef = asString(item['contentRef']);
    const content = resolveSubagentChildContent(item);
    if (!content && !contentRef) {
      continue;
    }

    if (kind === 'question') {
      normalized.push({ ...item, content });
      continue;
    }

    const previous = normalized[normalized.length - 1];
    if (previous && asString(previous['kind']) === kind) {
      const previousContentRef = asString(previous['contentRef']);
      if (previousContentRef || contentRef) {
        normalized[normalized.length - 1] = {
          ...previous,
          ...item,
          content,
        };
        continue;
      }

      normalized[normalized.length - 1] = {
        ...previous,
        content: `${asString(previous['content']) || ''}${content}`,
      };
      continue;
    }

    normalized.push({ ...item, content });
  }

  return normalized;
  } finally {
    ChatPerformanceTracer.recordDuration(
      'activity_projection.subagent_normalize',
      performance.now() - startedAt,
      `input=${items.length},output=${normalized.length}`,
      { slowThresholdMs: 4 },
    );
  }
}

function settleSubagentChildItemsForParent(
  items: readonly Record<string, unknown>[],
  parentState: ToolCallPart['state'],
): Record<string, unknown>[] {
  if (parentState === 'doing' || parentState === 'pending_approval') {
    return [...items];
  }

  const finalState = parentState === 'error' ? 'error' : 'done';
  return items.map((item) => {
    if (asString(item['kind']) !== 'tool') {
      return item;
    }

    const state = asString(item['state']);
    if (state === 'done' || state === 'error') {
      return item;
    }

    return {
      ...item,
      state: finalState,
    };
  });
}

function toSubagentActivityItems(item: Record<string, unknown>, index: number): ActivityGroupDisplayItem[] {
  const kind = asString(item['kind']);
  const content = asString(item['content']);
  const itemId = asString(item['toolCallId']) || `subagent-item-${index}`;

  if (kind === 'thinking' || kind === 'text') {
    return [buildSubagentNarrativeItem({
      id: `${itemId}:${kind}`,
      text: content || '',
      kind: kind === 'thinking' ? 'thinking' : 'text',
      tone: kind === 'thinking' ? 'info' : 'neutral',
    })];
  }

  if (kind === 'question') {
    if (!content) {
      return [];
    }

    return [buildSubagentQuestionItem(`${itemId}:question`, content)];
  }

  if (kind === 'tool') {
    const toolName = asString(item['toolName']) || 'tool';
    const argsSummary = asString(item['argsSummary']);
    const toolState = normalizeSubagentToolState(asString(item['state']));
    const duration = asNumber(item['duration']);
    const shell = buildToolActivityShellPresentation({ state: toolState });
    const summary = buildToolInvocationDisplaySummary({
      toolName,
      metadata: argsSummary ? { argsSummary } : null,
    });
    const detailSections = buildSubagentChildInvocationDetailSections({
      itemId,
      toolName,
      toolState,
      argsSummary,
      content,
      duration,
      label: summary?.label || toolName,
      subtitle: summary?.subtitle,
    });
    const invocationDetail = buildInvocationDetailDisplay({ detailSections });
    const headerMeta = formatToolDuration(duration);

    return [{
      id: `${itemId}:tool`,
      kind: 'activity',
      headerKind: 'tool',
      toolHeader: {
        title: summary?.label || toolName,
        subtitle: undefined,
        meta: headerMeta,
        pill: shell.pill || undefined,
        pillTone: shell.pillTone,
      },
      iconClass: shell.iconClass,
      isSpinning: toolState === 'doing',
      iconColor: shell.iconColor,
      kicker: shell.kicker,
      label: summary?.label || toolName,
      subtitle: undefined,
      note: undefined,
      headerMeta: undefined,
      pill: '',
      pillTone: 'neutral',
      invocationDetail,
      detailSections,
      detailExpanded: false,
      detailKind: invocationDetail ? 'invocation' : undefined,
    }];
  }

  return [];
}

function buildSubagentChildInvocationDetailSections(input: {
  itemId: string;
  toolName: string;
  toolState: 'doing' | 'done' | 'error';
  argsSummary?: string;
  content?: string;
  duration?: number;
  label: string;
  subtitle?: string;
}): DetailSectionDescriptor[] {
  const sections: DetailSectionDescriptor[] = [];

  if (input.argsSummary) {
    sections.push({
      title: '调用参数',
      rows: [{
        id: `${input.itemId}:args`,
        title: input.label,
        subtitle: input.subtitle,
        note: input.argsSummary,
        tone: 'neutral',
      }],
    });
  }

  if (input.toolState === 'doing' && input.content) {
    sections.push({
      title: '当前记录',
      rows: [{
        id: `${input.itemId}:progress`,
        title: '进行中',
        subtitle: input.label,
        note: input.content,
        trailing: input.duration != null ? `${input.duration.toFixed(1)}s` : '运行中',
        tone: 'info',
      }],
    });
  }

  if ((input.toolState === 'done' || input.toolState === 'error') && input.content) {
    sections.push({
      title: '工具输出',
      rows: [{
        id: `${input.itemId}:output`,
        title: '文本输出',
        note: input.content,
        trailing: input.duration != null ? `${input.duration.toFixed(1)}s` : undefined,
        tone: input.toolState === 'error' ? 'error' : 'success',
        outputKind: 'text',
      }],
    });
  }

  return sections;
}

function shouldAppendSubagentResult(items: readonly Record<string, unknown>[], result: string): boolean {
  if (!result) {
    return false;
  }

  const latestContent = getLatestSubagentRenderableText(items);
  if (!latestContent) {
    return true;
  }

  return normalizeSubagentText(latestContent) !== normalizeSubagentText(result);
}

function getLatestSubagentRenderableText(items: readonly Record<string, unknown>[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const kind = asString(item['kind']);
    if (kind !== 'text') {
      continue;
    }

    const content = asString(item['content']);
    if (content) {
      return content;
    }
  }

  return undefined;
}

function normalizeSubagentText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildSubagentNarrativeItem(input: {
  id: string;
  text: string;
  kind?: 'thinking' | 'text';
  tone: 'info' | 'success' | 'warn' | 'error' | 'neutral';
}): ActivityGroupDisplayItem {
  if (input.kind === 'thinking') {
    return {
      id: input.id,
      kind: 'thinking',
      iconClass: getSubagentStepIconClass(input.tone),
      isSpinning: false,
      iconColor: getSubagentStepColor(input.tone),
      label: input.text,
      note: input.text,
      pill: '',
      pillTone: 'neutral',
    };
  }

  return {
    id: input.id,
    kind: 'activity',
    iconClass: getSubagentStepIconClass(input.tone),
    isSpinning: false,
    iconColor: getSubagentStepColor(input.tone),
    label: '输出',
    note: input.text,
    noteRenderMode: 'markdown',
    pill: '',
    pillTone: 'neutral',
  };
}

function collectSubagentScopedChildParts(
  parts: readonly ChatPart[],
  parent?: ToolCallPart,
): ChatPart[] {
  const parentSubAgentInvocationId = parent ? parent.toolCallId : undefined;
  return parts.filter((part) => {
    if (part === parent || !isSubagentChildPart(part)) {
      return false;
    }
    if (!parentSubAgentInvocationId) {
      return true;
    }
    return (getSubAgentInvocationId(part) || getParentToolCallId(part)) === parentSubAgentInvocationId;
  });
}

function buildScopedSubagentHeaderDetail(parts: readonly ChatPart[]): string {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    switch (part.type) {
      case 'tool_call': {
        const summary = buildActivityToolSummaryCandidate(part);
        const text = [summary.label || summary.rawText, summary.subtitle].filter(Boolean).join(' ');
        if (text.trim()) {
          return text.trim();
        }
        break;
      }
      case 'thinking': {
        const text = normalizeSubagentHeaderText(part.content);
        if (text) {
          return text;
        }
        break;
      }
      case 'markdown': {
        const text = normalizeSubagentHeaderText(part.content);
        if (text) {
          return text;
        }
        break;
      }
      case 'question': {
        const text = part.questions.map((question) => question.question).find((question) => question.trim().length > 0);
        if (text) {
          return normalizeSubagentHeaderText(text);
        }
        break;
      }
      case 'confirmation': {
        const text = normalizeSubagentHeaderText(part.title || part.message);
        if (text) {
          return text;
        }
        break;
      }
      case 'terminal': {
        const text = normalizeSubagentHeaderText(part.command || part.output || part.stderr || '');
        if (text) {
          return text;
        }
        break;
      }
      case 'state': {
        const text = normalizeSubagentHeaderText(part.text);
        if (text) {
          return text;
        }
        break;
      }
      default:
        break;
    }
  }

  return '';
}

function normalizeSubagentHeaderText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function buildSubagentPendingItem(
  toolCallId: string,
  description: string,
  state: ToolCallPart['state'],
): ActivityGroupDisplayItem {
  const normalizedState = state === 'error' ? 'error' : state === 'done' ? 'done' : 'doing';
  const isRunning = normalizedState === 'doing';
  return {
    id: `${toolCallId}:running`,
    kind: 'activity',
    iconClass: isRunning ? 'fa-light fa-spinner-third' : getSubagentStepIconClass(normalizedState === 'error' ? 'error' : 'success'),
    isSpinning: isRunning,
    iconColor: isRunning ? 'var(--chat-info)' : getSubagentStepColor(normalizedState === 'error' ? 'error' : 'success'),
    label: description,
    subtitle: isRunning ? '运行中' : undefined,
    note: undefined,
    pill: '',
    pillTone: 'neutral',
  };
}

function normalizeSubagentToolState(state: string | undefined): 'doing' | 'done' | 'error' {
  if (state === 'done' || state === 'error') {
    return state;
  }
  return 'doing';
}

function buildSubagentQuestionItem(id: string, text: string): ActivityGroupDisplayItem {
  return {
    id,
    kind: 'activity',
    headerKind: 'default',
    iconClass: 'fa-light fa-circle-question',
    isSpinning: false,
    iconColor: 'var(--chat-info, #75beff)',
    kicker: 'Question',
    label: text,
    subtitle: undefined,
    note: undefined,
    headerMeta: undefined,
    pill: '',
    pillTone: 'neutral',
    approval: undefined,
    approvalSummary: undefined,
    invocationDetail: undefined,
    children: undefined,
    detailSections: undefined,
    detailExpanded: false,
    detailKind: undefined,
  };
}
