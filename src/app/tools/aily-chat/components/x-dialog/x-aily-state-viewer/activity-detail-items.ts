import { parseTerminalPayload } from '../../../core/terminal-payload';
import { isTerminalFailureState, resolveTerminalLifecycleState } from '../../../core/terminal-status';
import type { ToolResultContentPart } from '../../../core/tool-result-content';
import { isReadFileToolName } from '../../../core/tool-name-normalizer';
import { buildToolInvocationDisplaySummary } from '../../../core/tool-invocation-formatter';
import {
  collectChangedFilesEntriesFromToolResultEntry,
  isChangedFilesToolName,
} from '../chat-changed-files-display';
import {
  formatContinuationHardStopReason,
  formatContinuationStopReason,
  getContinuationStopReasonPresentation,
} from '../../../core/continuation-stop-reason';
import type { TurnResponseTurn } from 'aily-lex/browser';
import { projectRegisteredToolCallOutputRows } from './tool-call-output-projectors';
import { chatI18n } from '../../../helpers/chat-i18n';
import { formatCompactBillingLabel } from '../../../helpers/model-billing-label';

export type StateTone = 'info' | 'success' | 'warn' | 'error' | 'neutral';

export interface StateDetailRow {
  id: string;
  title: string;
  subtitle?: string;
  note?: string;
  reference?: string;
  trailing?: string;
  tone?: StateTone;
  outputKind?: 'default' | 'terminal-command' | 'terminal-stream' | 'text' | 'resource' | 'image' | 'code' | 'changed-file' | 'mermaid';
  outputChannel?: 'stdout' | 'stderr';
  outputUri?: string;
  outputMimeType?: string;
  outputData?: string;
  outputCode?: string;
  outputLanguage?: string;
  outputLabel?: string;
  outputDescription?: string;
}

export interface StateDetailOutputGroup {
  id: string;
  kind: 'terminal' | 'data' | 'code' | 'generic';
  rows: readonly StateDetailRow[];
}

export interface StateDetailSection {
  title: string;
  rows: StateDetailRow[];
  outputGroups?: readonly StateDetailOutputGroup[];
}

export interface DetailSectionDescriptor {
  title: string;
  rows: readonly StateDetailRow[];
  outputGroups?: readonly StateDetailOutputGroup[];
}

export interface ActivityDetailItem {
  id: string;
  kicker?: string;
  title: string;
  subtitle?: string;
  note?: string;
  trailing?: string;
  tone?: StateTone;
}

export interface ActivitySummaryBadge {
  label: string;
  value: string;
  tone?: StateTone;
}

export type InstructionDiagnosticFilter = 'all' | 'active' | 'inactive' | 'overridden' | 'empty' | 'not_found';

export interface InstructionFilterChip {
  id: InstructionDiagnosticFilter;
  label: string;
  count: number;
  tone?: StateTone;
  active: boolean;
}

export interface InstructionDetailProjection {
  badges: ActivitySummaryBadge[];
  filter: InstructionDiagnosticFilter;
  filterChips: InstructionFilterChip[];
  sections: DetailSectionDescriptor[];
}

export interface StateViewerStandardProjection {
  badges: ActivitySummaryBadge[];
  sections: DetailSectionDescriptor[];
}

export function appendDetailSection(
  sections: StateDetailSection[],
  activityItems: ActivityDetailItem[],
  title: string,
  rows: readonly StateDetailRow[],
  outputGroups: readonly StateDetailOutputGroup[] | undefined,
  includeActivityItems: boolean,
): void {
  if (rows.length === 0) {
    return;
  }

  sections.push({
    title,
    rows: [...rows],
    outputGroups: descriptorOutputGroups(rows, outputGroups),
  });

  if (!includeActivityItems) {
    return;
  }

  activityItems.push(
    ...rows.map((row) => ({
      id: row.id,
      kicker: title,
      title: row.title,
      subtitle: row.subtitle,
      note: row.note,
      trailing: row.trailing,
      tone: row.tone,
    })),
  );
}

export function appendDetailSections(
  sections: StateDetailSection[],
  activityItems: ActivityDetailItem[],
  descriptors: readonly DetailSectionDescriptor[],
  includeActivityItems: boolean,
): void {
  for (const descriptor of descriptors) {
    appendDetailSection(sections, activityItems, descriptor.title, descriptor.rows, descriptor.outputGroups, includeActivityItems);
  }
}

export function buildActivityItemsFromDetailSections(
  descriptors: readonly DetailSectionDescriptor[],
): ActivityDetailItem[] {
  const items: ActivityDetailItem[] = [];
  for (const descriptor of descriptors) {
    items.push(
      ...descriptor.rows.map((row) => ({
        id: row.id,
        kicker: descriptor.title || undefined,
        title: row.title,
        subtitle: row.subtitle,
        note: row.note,
        trailing: row.trailing,
        tone: row.tone,
      })),
    );
  }
  return items;
}

export function buildToolCallDetailSections(source: {
  id?: string;
  toolName?: string;
  metadata?: Record<string, unknown> | null;
  args?: unknown;
  text?: string;
  state?: 'doing' | 'done' | 'warn' | 'error' | 'pending_approval';
}): DetailSectionDescriptor[] {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return [];
  }

  const toolSpecificData = asRecord(metadata['toolSpecificData']);
  if (isSubagentMetadata(toolSpecificData)) {
    return buildSubagentDetailSections(source);
  }

  const toolName = source.toolName || asString(metadata['toolName']);
  const readFileMetadata = asRecord(metadata['readFile']);
  const argsSummary = asString(metadata['argsSummary']);
  const argsNote = argsSummary || formatToolCallArgs(source.args);
  const toolSummary = toolName ? buildToolInvocationDisplaySummary({ toolName, args: source.args, metadata }) : undefined;
  const timeline = asRecordArray(metadata['timeline']);
  const descriptors: DetailSectionDescriptor[] = [];
  const timelineEntries = timeline.length > 0 ? timeline : [metadata];
  const baseId = asString(metadata['recordId']) || source.id || 'tool';

  if (argsNote) {
    descriptors.push({
      title: '调用参数',
      rows: [{
        id: `${baseId}:args`,
        title: toolSummary?.label || toolName || '工具调用',
        subtitle: toolSummary?.subtitle,
        note: argsNote,
        tone: 'neutral',
      }],
    });
  }

  if (isReadFileToolName(toolName) && readFileMetadata) {
    const readFileDescriptor = buildReadFileDetailSection(baseId, readFileMetadata);
    if (readFileDescriptor) {
      descriptors.push(readFileDescriptor);
    }
  }

  const outputRows = buildToolCallOutputRowsWithFallback({
    metadata,
    toolSpecificData,
    timelineEntries,
    toolName,
    baseId,
    args: source.args,
    text: source.text,
    state: source.state,
  });

  const timelineRows = timelineEntries.map((entry, index) => toToolCallTimelineRow(entry, index));

  if (timelineRows.length > 0) {
    descriptors.push({
      title: timelineRows.length > 1 ? '历史时间线' : '当前记录',
      rows: timelineRows,
    });
  }

  if (outputRows.length > 0) {
    descriptors.push({
      title: '工具输出',
      rows: outputRows,
      outputGroups: buildStateDetailOutputGroups(outputRows),
    });
  }

  return descriptors;
}

function buildToolCallOutputRowsWithFallback(input: {
  metadata: Record<string, unknown>;
  toolSpecificData?: Record<string, unknown>;
  timelineEntries: readonly Record<string, unknown>[];
  toolName?: string;
  baseId: string;
  args?: unknown;
  text?: string;
  state?: 'doing' | 'done' | 'warn' | 'error' | 'pending_approval';
}): StateDetailRow[] {
  const timelineRows = input.timelineEntries.flatMap((entry, index) =>
    buildToolCallOutputRows(withToolCallArgs(entry, input.args), index, input.toolName),
  );
  if (timelineRows.length > 0) {
    return timelineRows;
  }

  const metadataRows = buildToolCallOutputRows(withToolCallArgs(input.metadata, input.args), 0, input.toolName);
  if (metadataRows.length > 0) {
    return metadataRows;
  }

  const fallbackRegisteredRows = projectRegisteredToolCallOutputRows({
    toolName: input.toolName,
    entry: {
      recordId: `${input.baseId}:output:text`,
      phase: asString(input.metadata['phase']) || toolCallStateToNarrativePhase(input.state),
      args: input.args,
      resultText: input.text,
    },
    index: 0,
  });
  if (fallbackRegisteredRows.length > 0) {
    return fallbackRegisteredRows;
  }

  const toolSpecificResult = asString(input.toolSpecificData?.['result']);
  if (toolSpecificResult) {
    return [buildFallbackToolCallOutputRow(`${input.baseId}:output:toolSpecificData`, input.toolName, toolSpecificResult, input.state)];
  }

  if (input.toolSpecificData?.['kind'] === 'editor_operation'
    || input.metadata['progressKind'] === 'editor_operation'
    || asString(input.metadata['operationKind'])?.startsWith('blockly.')) {
    return [];
  }

  const fallbackText = asMeaningfulToolCallFallbackText(input.text, input.toolName, input.state);
  if (fallbackText) {
    return [buildFallbackToolCallOutputRow(`${input.baseId}:output:text`, input.toolName, fallbackText, input.state)];
  }

  return [];
}

function withToolCallArgs(entry: Record<string, unknown>, args: unknown): Record<string, unknown> {
  if (args === undefined || entry['args'] !== undefined) {
    return entry;
  }

  return { ...entry, args };
}

function buildFallbackToolCallOutputRow(
  id: string,
  toolName: string | undefined,
  text: string,
  state: 'doing' | 'done' | 'warn' | 'error' | 'pending_approval' | undefined,
): StateDetailRow {
  const phase = state === 'error'
    ? 'failed'
    : state === 'done' || state === 'warn'
      ? 'completed'
      : state === 'doing'
        ? 'progress'
        : undefined;

  return normalizeReadFileToolOutputRow({
    id,
    title: toolName || '工具输出',
    note: text,
    trailing: phase ? formatNarrativePhase(phase) : undefined,
    tone: phase ? toneFromNarrativePhase(phase) : 'neutral',
  }, toolName);
}

function asMeaningfulToolCallFallbackText(
  value: string | undefined,
  toolName: string | undefined,
  state: 'doing' | 'done' | 'warn' | 'error' | 'pending_approval' | undefined,
): string | undefined {
  const text = asString(value);
  if (!text) {
    return undefined;
  }

  if (state !== 'done' && state !== 'error' && state !== 'warn') {
    return undefined;
  }

  const normalized = text.trim().toLowerCase();
  const normalizedToolName = (toolName || '').trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalizedToolName && (normalized === normalizedToolName || normalized === `${normalizedToolName}…`)) {
    return undefined;
  }

  if (/^正在执行工具:\s*/.test(text) || /^执行工具:\s*/.test(text)) {
    return undefined;
  }

  return text;
}

function toolCallStateToNarrativePhase(
  state: 'doing' | 'done' | 'warn' | 'error' | 'pending_approval' | undefined,
): string | undefined {
  switch (state) {
    case 'done':
    case 'warn':
      return 'completed';
    case 'error':
      return 'failed';
    case 'doing':
      return 'progress';
    default:
      return undefined;
  }
}

export function buildToolCallSummaryBadges(source: {
  metadata?: Record<string, unknown> | null;
}): ActivitySummaryBadge[] {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return [];
  }

  const toolSpecificData = asRecord(metadata['toolSpecificData']);
  if (isSubagentMetadata(toolSpecificData)) {
    return buildSubagentSummaryBadges(metadata, toolSpecificData);
  }

  const badges: ActivitySummaryBadge[] = [];
  const toolName = asString(metadata['toolName']);
  const readFileMetadata = asRecord(metadata['readFile']);
  const agentName = asString(toolSpecificData?.['agentName']);
  const phase = asString(metadata['phase']);
  const progress = asNumber(metadata['progress']);

  if (toolName) {
    badges.push({ label: '工具', value: toolName, tone: 'info' });
  }
  if (agentName) {
    badges.push({ label: '子代理', value: agentName, tone: 'info' });
  }
  if (phase) {
    badges.push({
      label: '阶段',
      value: formatNarrativePhase(phase),
      tone: toneFromNarrativePhase(phase),
    });
  }
  if (typeof progress === 'number') {
    badges.push({
      label: '进度',
      value: `${Math.round(progress)}%`,
      tone: toneFromNarrativePhase(phase),
    });
  }
  if (isReadFileToolName(toolName) && readFileMetadata) {
    badges.push(...buildReadFileSummaryBadges(readFileMetadata));
  }

  return badges;
}

function buildSubagentSummaryBadges(
  metadata: Record<string, unknown>,
  toolSpecificData: Record<string, unknown> | undefined,
): ActivitySummaryBadge[] {
  const badges: ActivitySummaryBadge[] = [];
  const agentName = asString(toolSpecificData?.['agentName']);
  const modelRouting = asRecord(metadata['modelRouting']) || asRecord(toolSpecificData?.['modelRouting']);
  const selectedPresetId = asString(modelRouting?.['selectedPresetId']);
  const requestedPresetId = asString(modelRouting?.['requestedPresetId']);
  const modelName = selectedPresetId
    || requestedPresetId
    || asString(metadata['modelName'])
    || asString(toolSpecificData?.['modelName']);
  const modelBillingLabel = formatCompactBillingLabel(
    asString(metadata['modelBillingLabel'])
      || asString(toolSpecificData?.['modelBillingLabel'])
      || asString(modelRouting?.['modelBillingLabel']),
  );

  if (agentName) {
    badges.push({ label: 'Subagent', value: agentName, tone: 'info' });
  }
  if (modelName) {
    badges.push({ label: 'Model', value: formatSubagentModelDisplayName(modelName), tone: 'neutral' });
  }
  if (modelBillingLabel) {
    badges.push({ label: 'Cost', value: modelBillingLabel, tone: 'neutral' });
  }

  return badges;
}

function formatSubagentModelDisplayName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed
    .split(/([_-]+)/)
    .map((part) => {
      if (/^[_-]+$/.test(part)) {
        return part === '_' ? '-' : part;
      }
      if (!part) {
        return part;
      }
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join('');
}

function buildReadFileSummaryBadges(readFileMetadata: Record<string, unknown>): ActivitySummaryBadge[] {
  const badges: ActivitySummaryBadge[] = [];
  const returnedRange = formatReadFileCompactLineSpan(
    readFileMetadata['returnedStartLine'],
    readFileMetadata['returnedEndLine'],
  );
  const byteRatio = formatReadFileCompactByteRatio(
    readFileMetadata['readBytes'],
    readFileMetadata['totalBytes'],
  );
  const truncatedByBytes = asBoolean(readFileMetadata['truncatedByBytes']);

  if (returnedRange) {
    badges.push({ label: '范围', value: returnedRange, tone: 'info' });
  }
  if (byteRatio) {
    badges.push({ label: '字节', value: byteRatio, tone: truncatedByBytes ? 'warn' : 'neutral' });
  }
  if (truncatedByBytes) {
    badges.push({ label: '截断', value: '字节上限', tone: 'warn' });
  }

  return badges;
}

function buildReadFileDetailSection(
  baseId: string,
  readFileMetadata: Record<string, unknown>,
): DetailSectionDescriptor | undefined {
  const rows: StateDetailRow[] = [];
  const returnedRange = formatReadFileDetailedLineSpan(
    readFileMetadata['returnedStartLine'],
    readFileMetadata['returnedEndLine'],
  );
  const requestedRange = formatReadFileDetailedLineSpan(
    readFileMetadata['requestedStartLine'],
    readFileMetadata['requestedEndLine'],
  );
  const lineCount = asNumber(readFileMetadata['lineCount']);
  const totalLines = asNumber(readFileMetadata['totalLines']);
  const byteSummary = formatReadFileDetailedBytes(
    readFileMetadata['readBytes'],
    readFileMetadata['totalBytes'],
  );
  const continuation = formatReadFileContinuation(readFileMetadata['continueWith']);
  const truncatedByBytes = asBoolean(readFileMetadata['truncatedByBytes']);

  if (returnedRange) {
    rows.push({
      id: `${baseId}:read-file:range`,
      title: '返回范围',
      subtitle: [
        requestedRange ? `请求 ${requestedRange}` : '',
        typeof totalLines === 'number' ? `共 ${formatReadFileInteger(totalLines)} 行` : '',
      ].filter(Boolean).join(' · ') || undefined,
      note: returnedRange,
      trailing: typeof lineCount === 'number' ? `${formatReadFileInteger(lineCount)} 行` : undefined,
      tone: 'info',
    });
  }

  if (byteSummary || truncatedByBytes) {
    rows.push({
      id: `${baseId}:read-file:bytes`,
      title: '字节统计',
      note: byteSummary,
      trailing: truncatedByBytes ? '字节截断' : undefined,
      tone: truncatedByBytes ? 'warn' : 'neutral',
    });
  }

  if (continuation) {
    rows.push({
      id: `${baseId}:read-file:continue`,
      title: '继续读取',
      note: continuation,
      tone: 'info',
    });
  }

  return rows.length > 0
    ? { title: '读取信息', rows }
    : undefined;
}

export function buildSubagentDetailSections(source: {
  id?: string;
  metadata?: Record<string, unknown> | null;
}): DetailSectionDescriptor[] {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return [];
  }

  const toolSpecificData = asRecord(metadata['toolSpecificData']);
  if (!isSubagentMetadata(toolSpecificData)) {
    return [];
  }

  const baseId = asString(metadata['recordId']) || source.id || 'subagent';
  const description = asString(toolSpecificData?.['description']) || asString(metadata['argsSummary']) || undefined;
  const prompt = asString(toolSpecificData?.['prompt']);
  const childItems = asRecordArray(toolSpecificData?.['childItems']);
  const result = asString(toolSpecificData?.['result']);
  const activityRows = childItems
    .map((item, index) => toSubagentDetailRow(item, index))
    .filter((row): row is StateDetailRow => !!row);
  const rows: StateDetailRow[] = [];

  if (prompt && prompt !== description) {
    rows.push(textToSubagentNarrativeRow(`${baseId}:prompt`, prompt, 'info'));
  }

  rows.push(...activityRows);

  if (rows.length === 0 && description) {
    rows.push(textToSubagentNarrativeRow(`${baseId}:pending`, description, 'info'));
  }

  if (result) {
    rows.push(textToSubagentNarrativeRow(`${baseId}:result`, result, 'success'));
  }

  return rows.length > 0
    ? [{ title: '任务', rows }]
    : [];
}

export function buildBackgroundTaskDetailSections(source: {
  id?: string;
  metadata?: Record<string, unknown> | null;
}): DetailSectionDescriptor[] {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return [];
  }

  const taskId = asString(metadata['taskId']) || source.id || 'background-task';
  const status = asString(metadata['status']);
  const agentName = asString(metadata['agentName']);
  const description = asString(metadata['description']);
  const summary = asString(metadata['summary']);
  const progress = asNumber(metadata['progress']);
  const startedAt = asNumber(metadata['startedAt']);
  const completedAt = asNumber(metadata['completedAt']);
  const output = asString(metadata['output']);
  const error = asString(metadata['error']);
  const activity = asRecord(metadata['activity']);
  const note = error || output || summary;

  if (!note && !activity) {
    return [];
  }

  const rows: StateDetailRow[] = [];
  if (note) {
    rows.push({
      id: taskId,
      title: description || taskId || '后台任务',
      subtitle: [
        agentName ? `代理 ${agentName}` : '',
        startedAt != null ? `开始 ${formatClock(startedAt)}` : '',
        completedAt != null ? `结束 ${formatClock(completedAt)}` : '',
      ].filter(Boolean).join(' · '),
      note,
      trailing: status === 'running' && typeof progress === 'number'
        ? `${Math.round(progress)}%`
        : formatBackgroundTaskStatus(status),
      tone: toneFromBackgroundTaskStatus(status),
    });
  }

  if (activity) {
    rows.push(toBackgroundTaskActivityRow(activity, taskId));
  }

  return [{
    title: output || error ? '结果摘要' : activity ? '进度与活动' : '进度摘要',
    rows,
  }];
}

export function buildTodoDetailSections(source: {
  metadata?: Record<string, unknown> | null;
}): DetailSectionDescriptor[] {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return [];
  }

  const timeline = asRecordArray(metadata['timeline']);
  const latestEntry = timeline.at(-1) ?? metadata;
  const latestRow = toTodoTimelineRow(latestEntry, 'current');
  const currentItems = buildTodoItemRows(asRecordArray(latestEntry['items']));
  const historyRows = timeline.slice(0, -1).map((entry, index) => toTodoTimelineRow(entry, `history-${index}`));
  const sections: DetailSectionDescriptor[] = [];

  if (latestRow) {
    sections.push({
      title: '当前记录',
      rows: [latestRow],
    });
  }

  if (currentItems.length > 0) {
    sections.push({
      title: '当前待办',
      rows: currentItems,
    });
  }

  if (historyRows.length > 0) {
    sections.push({
      title: '历史时间线',
      rows: historyRows,
    });
  }

  return sections;
}

export function buildBackgroundTaskSummaryBadges(source: {
  metadata?: Record<string, unknown> | null;
}): ActivitySummaryBadge[] {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return [];
  }

  const badges: ActivitySummaryBadge[] = [];
  const taskId = asString(metadata['taskId']);
  const status = asString(metadata['status']);
  const agentName = asString(metadata['agentName']);
  const progress = asNumber(metadata['progress']);
  const startedAt = asNumber(metadata['startedAt']);
  const completedAt = asNumber(metadata['completedAt']);

  if (taskId) {
    badges.push({ label: '任务', value: taskId, tone: 'info' });
  }
  if (status) {
    badges.push({
      label: '状态',
      value: formatBackgroundTaskStatus(status),
      tone: toneFromBackgroundTaskStatus(status),
    });
  }
  if (agentName) {
    badges.push({ label: '代理', value: agentName, tone: 'neutral' });
  }
  if (typeof progress === 'number') {
    badges.push({
      label: '进度',
      value: `${Math.round(progress)}%`,
      tone: status === 'running' ? 'info' : 'neutral',
    });
  }
  if (typeof startedAt === 'number') {
    badges.push({ label: '开始', value: formatClock(startedAt), tone: 'neutral' });
  }
  if (typeof completedAt === 'number') {
    badges.push({
      label: '结束',
      value: formatClock(completedAt),
      tone: toneFromBackgroundTaskStatus(status),
    });
  }

  return badges;
}

export function buildAgentTeamDetailSections(source: {
  metadata?: Record<string, unknown> | null;
}): DetailSectionDescriptor[] {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return [];
  }

  const descriptors: DetailSectionDescriptor[] = [];
  const roleRows: StateDetailRow[] = [];
  for (const value of asArray(metadata['roles'])) {
    const role = asRecord(value);
    if (!role) continue;
    roleRows.push(toAgentTeamRoleRow(role));
  }
  if (roleRows.length > 0) {
    descriptors.push({ title: '角色分工', rows: roleRows });
  }

  const messageRows: StateDetailRow[] = [];
  for (const value of asArray(metadata['recentMessages'])) {
    const message = asRecord(value);
    if (!message) continue;
    messageRows.push(toAgentTeamMessageRow(message));
  }
  if (messageRows.length > 0) {
    descriptors.push({ title: '最近消息', rows: messageRows });
  }

  return descriptors;
}

export function buildAgentTeamSummaryBadges(source: {
  metadata?: Record<string, unknown> | null;
}): ActivitySummaryBadge[] {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return [];
  }

  const badges: ActivitySummaryBadge[] = [];
  const teamId = asString(metadata['teamId']);
  const status = asString(metadata['status']);
  const roleCount = asNumber(metadata['roleCount']);
  const messageCount = asNumber(metadata['messageCount']);
  const graphId = asString(metadata['graphId']);

  if (teamId) {
    badges.push({ label: '团队', value: teamId, tone: 'info' });
  }
  if (status) {
    badges.push({
      label: '状态',
      value: formatAgentTeamStatus(status),
      tone: toneFromAgentTeamStatus(status),
    });
  }
  if (typeof roleCount === 'number') {
    badges.push({ label: '角色', value: String(roleCount), tone: 'neutral' });
  }
  if (typeof messageCount === 'number') {
    badges.push({ label: '消息', value: String(messageCount), tone: 'neutral' });
  }
  if (graphId) {
    badges.push({ label: '任务图', value: graphId, tone: 'neutral' });
  }

  return badges;
}

export function buildInstructionDetailProjection(source: {
  id?: string;
  metadata?: Record<string, unknown> | null;
  selectedFilter?: InstructionDiagnosticFilter;
}): InstructionDetailProjection {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return {
      badges: [],
      filter: 'all',
      filterChips: [],
      sections: [],
    };
  }

  const hostId = asString(metadata['hostId']);
  const modelFamily = asString(metadata['modelFamily']);
  const activeCount = asNumber(metadata['activeCount']) || 0;
  const inactiveCount = asNumber(metadata['inactiveCount']) || 0;
  const overriddenCount = asNumber(metadata['overriddenCount']) || 0;
  const emptyCount = asNumber(metadata['emptyCount']) || 0;
  const notFoundCount = asNumber(metadata['notFoundCount']) || 0;
  const capabilities = asArray(metadata['capabilities'])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const diagnostics = asRecordArray(metadata['diagnostics']);
  const filterCounts = collectInstructionDiagnosticCounts(diagnostics);
  const filter = resolveInstructionFilter(source.selectedFilter || 'all', filterCounts);

  const badges: ActivitySummaryBadge[] = [];
  if (hostId) badges.push({ label: 'Host', value: hostId, tone: 'info' });
  if (modelFamily) badges.push({ label: '模型族', value: modelFamily, tone: 'neutral' });
  badges.push({ label: '生效', value: String(activeCount), tone: activeCount > 0 ? 'success' : 'neutral' });
  if (inactiveCount > 0) badges.push({ label: '条件跳过', value: String(inactiveCount), tone: 'warn' });
  if (overriddenCount > 0) badges.push({ label: '被覆盖', value: String(overriddenCount), tone: 'warn' });
  if (emptyCount > 0) badges.push({ label: '空文件', value: String(emptyCount), tone: 'warn' });
  if (notFoundCount > 0) badges.push({ label: '未发现', value: String(notFoundCount), tone: 'neutral' });
  if (capabilities.length > 0) badges.push({ label: '能力', value: String(capabilities.length), tone: 'info' });

  const sections: DetailSectionDescriptor[] = [];
  if (hostId || modelFamily || capabilities.length > 0) {
    sections.push({
      title: '运行上下文',
      rows: [{
        id: `${source.id || 'instructions'}:context`,
        title: hostId || 'Instruction context',
        subtitle: [modelFamily ? `模型 ${modelFamily}` : '', capabilities.length > 0 ? `能力 ${capabilities.join(', ')}` : '']
          .filter(Boolean)
          .join(' · '),
        trailing: asString(metadata['summary']),
        tone: 'info',
      }],
    });
  }

  if (filter === 'all') {
    const activeRows: StateDetailRow[] = [];
    const skippedRows: StateDetailRow[] = [];
    for (const diagnostic of diagnostics) {
      const row = toInstructionDiagnosticRow(diagnostic, source.id);
      if (asBoolean(diagnostic['active'])) {
        activeRows.push(row);
      } else {
        skippedRows.push(row);
      }
    }

    if (activeRows.length > 0) {
      sections.push({ title: '已生效规则', rows: activeRows });
    }
    if (skippedRows.length > 0) {
      sections.push({ title: '跳过与覆盖', rows: skippedRows });
    }
  } else {
    const filteredRows = diagnostics
      .filter(diagnostic => matchesInstructionDiagnosticFilter(diagnostic, filter))
      .map(diagnostic => toInstructionDiagnosticRow(diagnostic, source.id));

    if (filteredRows.length > 0) {
      sections.push({
        title: formatInstructionFilterTitle(filter),
        rows: filteredRows,
      });
    }
  }

  return {
    badges,
    filter,
    filterChips: buildInstructionFilterChips(filterCounts, filter),
    sections,
  };
}

export function buildStandardStateViewerProjection(source: {
  kind: 'tool_call' | 'background_task' | 'agent_team' | 'task_graph' | 'task_scheduler' | 'task_autonomy' | 'provider_context_management';
  id?: string;
  metadata?: Record<string, unknown> | null;
  preparedDetailSections?: readonly DetailSectionDescriptor[] | null;
}): StateViewerStandardProjection {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return { badges: [], sections: [] };
  }

  const sections = source.preparedDetailSections?.length
    ? [...source.preparedDetailSections]
    : buildDefaultDetailSections(source.kind, source.id, metadata);

  return {
    badges: buildDefaultSummaryBadges(source.kind, metadata),
    sections,
  };
}

export function buildTurnResponseContinuationDetailSections(source: {
  id?: string;
  continuation?: TurnResponseTurn['response']['continuation'] | null;
}): DetailSectionDescriptor[] {
  const continuation = source.continuation;
  if (!continuation) {
    return [];
  }

  const baseId = source.id || continuation.interactionId || 'turn';
  const rows: StateDetailRow[] = [];
  const budgets = asRecord(continuation['budgets']);
  const diagnostics = asRecord(continuation['diagnostics']);
  const identity = asRecord(diagnostics?.['identity']);
  const trace = asRecord(diagnostics?.['trace']);
  const usage = asRecord(diagnostics?.['usage']);
  const runtime = asRecord(diagnostics?.['runtime']);
  const budgetDiagnostics = asRecord(diagnostics?.['budget']);
  const outcome = asRecord(diagnostics?.['outcome']);
  const behavior = asRecord(diagnostics?.['behavior']);
  const executionId = asString(budgets?.['executionId']) || asString(identity?.['executionId']);
  const executionOrigin = asString(budgets?.['origin']);
  const status = asString(continuation.status);
  const stopReason = asString(continuation.stopReason);
  const stopReasonPresentation = getContinuationStopReasonPresentation(stopReason);
  const hardStopReason = asString(continuation.hardStopReason);
  const errorCode = asString(outcome?.['errorCode']);
  const runtimeLines = [
    continuation.interactionId ? `interactionId: ${continuation.interactionId}` : undefined,
    continuation.lease ? `lease: ${continuation.lease}` : undefined,
    executionId ? `executionId: ${executionId}` : undefined,
    executionOrigin ? `origin: ${executionOrigin}` : undefined,
  ].filter((value): value is string => !!value);
  const runtimeSubtitle = [
    typeof continuation.stepIndex === 'number' ? `step ${continuation.stepIndex}` : undefined,
    status,
  ].filter((value): value is string => !!value).join(' · ');

  if (runtimeLines.length > 0 || typeof continuation.stepIndex === 'number') {
    rows.push({
      id: `${baseId}:continuation:runtime`,
      title: '继续执行上下文',
      subtitle: runtimeSubtitle || undefined,
      note: runtimeLines.length > 0 ? runtimeLines.join('\n') : undefined,
      tone: 'info',
    });
  }

  if (stopReason || hardStopReason) {
    rows.push({
      id: `${baseId}:continuation:stop`,
      title: '结束原因',
      subtitle: formatContinuationStopReason(stopReason) || undefined,
      note: [
        stopReasonPresentation?.detail,
        stopReason && stopReasonPresentation?.label !== stopReason ? `stopReason: ${stopReason}` : undefined,
        hardStopReason ? `hardStopReason: ${formatContinuationHardStopReason(hardStopReason) ?? hardStopReason}` : undefined,
        errorCode ? `errorCode: ${errorCode}` : undefined,
      ].filter((value): value is string => !!value).join('\n') || undefined,
      tone: hardStopReason || stopReasonPresentation?.isBehaviorStop ? 'warn' : 'info',
    });
  }

  const traceLines = [
    asString(identity?.['requestId']) ? `requestId: ${asString(identity?.['requestId'])}` : undefined,
    asString(trace?.['toolCallId']) ? `toolCallId: ${asString(trace?.['toolCallId'])}` : undefined,
    asString(trace?.['parentToolCallId']) ? `parentToolCallId: ${asString(trace?.['parentToolCallId'])}` : undefined,
  ].filter((value): value is string => !!value);
  const traceSubtitle = asString(outcome?.['sourceEvent']);

  if (traceLines.length > 0 || traceSubtitle) {
    rows.push({
      id: `${baseId}:continuation:trace`,
      title: '请求与追踪',
      subtitle: traceSubtitle || undefined,
      note: traceLines.length > 0 ? traceLines.join('\n') : undefined,
      tone: 'info',
    });
  }

  const usageLines = [
    typeof asNumber(usage?.['promptTokens']) === 'number' ? `promptTokens: ${Math.round(asNumber(usage?.['promptTokens'])!)}` : undefined,
    typeof asNumber(usage?.['completionTokens']) === 'number' ? `completionTokens: ${Math.round(asNumber(usage?.['completionTokens'])!)}` : undefined,
    typeof asNumber(usage?.['cacheReadTokens']) === 'number' ? `cacheReadTokens: ${Math.round(asNumber(usage?.['cacheReadTokens'])!)}` : undefined,
    typeof asNumber(usage?.['cacheCreationTokens']) === 'number' ? `cacheCreationTokens: ${Math.round(asNumber(usage?.['cacheCreationTokens'])!)}` : undefined,
  ].filter((value): value is string => !!value);
  const usageSubtitle = [
    asString(usage?.['resolvedModel']),
    asString(usage?.['modelBillingLabel']),
  ].filter((value): value is string => !!value).join(' · ');

  if (usageLines.length > 0 || usageSubtitle) {
    rows.push({
      id: `${baseId}:continuation:usage`,
      title: '模型与用量',
      subtitle: usageSubtitle || undefined,
      note: usageLines.length > 0 ? usageLines.join('\n') : undefined,
      tone: 'info',
    });
  }

  const diagnosticsLines = [
    formatDiagnosticCounter('roundCount', asNumber(runtime?.['roundCount']), asNumber(budgetDiagnostics?.['hardRoundCap'])),
    formatDiagnosticCounter('rawToolCallCount', asNumber(runtime?.['rawToolCallCount']), asNumber(budgetDiagnostics?.['rawToolCallCap'])),
    formatDiagnosticCounter('executionUnits', asNumber(runtime?.['executionUnits']), asNumber(budgetDiagnostics?.['executionUnitCap'])),
    formatDiagnosticCounter('wallClockMs', asNumber(runtime?.['wallClockMs']), asNumber(budgetDiagnostics?.['wallClockCapMs'])),
    formatDiagnosticCounter('questionAnswerCount', asNumber(runtime?.['questionAnswerCount']), asNumber(budgetDiagnostics?.['questionAnswerCap'])),
    formatDiagnosticCounter('confirmationCount', asNumber(runtime?.['confirmationCount']), asNumber(budgetDiagnostics?.['confirmationCap'])),
    formatDiagnosticValue('repeatedTextScore', asNumber(behavior?.['repeatedTextScore'])),
    formatDiagnosticValue('repeatedChunkStreak', asNumber(behavior?.['repeatedChunkStreak'])),
    formatDiagnosticValue('noProgressRounds', asNumber(behavior?.['noProgressRounds'])),
    formatDiagnosticValue('repeatedToolCallStreak', asNumber(behavior?.['repeatedToolCallStreak'])),
    formatDiagnosticValue('repeatedPendingStreak', asNumber(behavior?.['repeatedPendingStreak'])),
    formatDiagnosticValue('syncConflictStreak', asNumber(behavior?.['syncConflictStreak'])),
    formatDiagnosticValue('pendingInterruptions', asNumber(behavior?.['pendingInterruptions'])),
    formatDiagnosticValue('pendingReplyOscillationCount', asNumber(behavior?.['pendingReplyOscillationCount'])),
    formatDiagnosticValue('sameToolFingerprintCount', asNumber(behavior?.['sameToolFingerprintCount'])),
    formatDiagnosticValue('samePendingFingerprintCount', asNumber(behavior?.['samePendingFingerprintCount'])),
    formatDiagnosticValue('lastProgressAtRound', asNumber(behavior?.['lastProgressAtRound'])),
  ].filter((value): value is string => !!value);

  if (diagnosticsLines.length > 0) {
    rows.push({
      id: `${baseId}:continuation:diagnostics`,
      title: '诊断统计',
      note: diagnosticsLines.join('\n'),
      tone: behavior ? 'warn' : 'info',
    });
  }

  if (continuation.pendingState) {
    const pendingKind = asString(continuation.pendingState['kind']);
    const pendingRequestId = asString(continuation.pendingState['requestId']);
    const pendingSourceEvent = asString(continuation.pendingState['sourceEvent']);
    const pendingLines = [
      pendingRequestId ? `requestId: ${pendingRequestId}` : undefined,
      pendingSourceEvent ? `sourceEvent: ${pendingSourceEvent}` : undefined,
    ].filter((value): value is string => !!value);

    rows.push({
      id: `${baseId}:continuation:pending`,
      title: '挂起状态',
      subtitle: pendingKind || undefined,
      note: pendingLines.length > 0 ? pendingLines.join('\n') : undefined,
      tone: 'warn',
    });
  }

  return rows.length > 0 ? [{ title: '继续执行', rows }] : [];
}

function formatDiagnosticCounter(label: string, used: number | undefined, cap: number | undefined): string | undefined {
  if (typeof used !== 'number' && typeof cap !== 'number') {
    return undefined;
  }
  if (typeof used === 'number' && typeof cap === 'number') {
    return `${label}: ${formatDiagnosticNumber(used)} / ${formatDiagnosticNumber(cap)}`;
  }
  return `${label}: ${formatDiagnosticNumber((used ?? cap)! )}`;
}

function formatDiagnosticValue(label: string, value: number | undefined): string | undefined {
  if (typeof value !== 'number') {
    return undefined;
  }
  return `${label}: ${formatDiagnosticNumber(value)}`;
}

function formatDiagnosticNumber(value: number): string {
  if (Number.isInteger(value)) {
    return `${value}`;
  }
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function buildDefaultSummaryBadges(
  kind: 'tool_call' | 'background_task' | 'agent_team' | 'task_graph' | 'task_scheduler' | 'task_autonomy' | 'provider_context_management',
  metadata: Record<string, unknown>,
): ActivitySummaryBadge[] {
  switch (kind) {
    case 'tool_call':
      return buildToolCallSummaryBadges({ metadata });
    case 'background_task':
      return buildBackgroundTaskSummaryBadges({ metadata });
    case 'agent_team':
      return buildAgentTeamSummaryBadges({ metadata });
    case 'task_graph':
      return buildTaskGraphSummaryBadges({ metadata });
    case 'task_scheduler':
      return buildTaskSchedulerSummaryBadges({ metadata });
    case 'task_autonomy':
      return buildTaskAutonomySummaryBadges({ metadata });
    case 'provider_context_management':
      return buildProviderContextManagementSummaryBadges({ metadata });
  }
}

function buildDefaultDetailSections(
  kind: 'tool_call' | 'background_task' | 'agent_team' | 'task_graph' | 'task_scheduler' | 'task_autonomy' | 'provider_context_management',
  id: string | undefined,
  metadata: Record<string, unknown>,
): DetailSectionDescriptor[] {
  switch (kind) {
    case 'tool_call':
      return buildToolCallDetailSections({ id, metadata });
    case 'background_task':
      return buildBackgroundTaskDetailSections({ id, metadata });
    case 'agent_team':
      return buildAgentTeamDetailSections({ metadata });
    case 'task_graph':
      return buildTaskGraphDetailSections({ metadata });
    case 'task_scheduler':
    case 'task_autonomy':
      return [];
    case 'provider_context_management':
      return buildProviderContextManagementDetailSections({ id, metadata });
  }
}

function buildTodoItemRows(items: readonly Record<string, unknown>[]): StateDetailRow[] {
  return items.map((item, index) => {
    const title = asString(item['title']) || `Todo ${index + 1}`;
    const status = asString(item['status']) || 'not-started';
    return {
      id: `todo-item:${index}:${title}`,
      title,
      subtitle: formatTodoStatus(status),
      tone: toneFromTodoState(status),
    };
  });
}

function toTodoTimelineRow(entry: Record<string, unknown>, idSuffix: string | number): StateDetailRow | undefined {
  const summary = asString(entry['summary']);
  const activeTitle = asString(entry['activeTitle']);
  const phaseLabel = asString(entry['phaseLabel']);
  const phaseDetail = asString(entry['phaseDetail']);
  const totalCount = asNumber(entry['totalCount']);
  const currentStep = asNumber(entry['currentStep']);
  const completedCount = asNumber(entry['completedCount']);
  const state = asString(entry['state']) || 'info';
  const progressLabel = typeof totalCount === 'number' && totalCount > 0
    ? `${Math.max(0, currentStep ?? completedCount ?? 0)}/${totalCount}`
    : undefined;
  const title = phaseLabel
    || activeTitle
    || (summary ? 'Todo 更新' : undefined)
    || 'Todo';

  if (!title && !summary) {
    return undefined;
  }

  return {
    id: `todo-timeline:${idSuffix}`,
    title,
    subtitle: phaseDetail || progressLabel,
    note: summary,
    trailing: formatTodoStateLabel(state),
    tone: toneFromTodoState(state),
  };
}

function formatTodoStatus(status: string): string {
  switch (status) {
    case 'completed':
      return '已完成';
    case 'in-progress':
      return '进行中';
    default:
      return '未开始';
  }
}

function formatTodoStateLabel(state: string): string {
  switch (state) {
    case 'done':
    case 'completed':
      return '已完成';
    case 'doing':
    case 'in-progress':
      return '进行中';
    default:
      return '待处理';
  }
}

function toneFromTodoState(state: string): StateTone {
  switch (state) {
    case 'done':
    case 'completed':
      return 'success';
    case 'doing':
    case 'in-progress':
      return 'info';
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'neutral';
  }
}

function buildTaskGraphSummaryBadges(source: {
  metadata?: Record<string, unknown> | null;
}): ActivitySummaryBadge[] {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return [];
  }

  const badges: ActivitySummaryBadge[] = [];
  const graphId = asString(metadata['graphId']);
  const status = asString(metadata['status']);
  const totalNodes = asNumber(metadata['totalNodes']);
  const completedNodes = asNumber(metadata['completedNodes']);
  const failedNodes = asNumber(metadata['failedNodes']);
  const runningNodes = asNumber(metadata['runningNodes']);
  const blockedNodes = asNumber(metadata['blockedNodes']);

  if (graphId) {
    badges.push({ label: '图', value: graphId, tone: 'info' });
  }
  if (status) {
    badges.push({ label: '状态', value: formatTaskGraphStatus(status), tone: toneFromTaskGraphStatus(status) });
  }
  if (typeof totalNodes === 'number' && totalNodes > 0) {
    badges.push({
      label: '进度',
      value: `${completedNodes || 0}/${totalNodes}`,
      tone: failedNodes ? 'warn' : completedNodes === totalNodes ? 'success' : 'info',
    });
  }
  if (runningNodes) {
    badges.push({ label: '运行中', value: String(runningNodes), tone: 'info' });
  }
  if (failedNodes) {
    badges.push({ label: '失败', value: String(failedNodes), tone: 'error' });
  }
  if (blockedNodes) {
    badges.push({ label: '阻塞', value: String(blockedNodes), tone: 'warn' });
  }

  return badges;
}

function buildTaskGraphDetailSections(source: {
  metadata?: Record<string, unknown> | null;
}): DetailSectionDescriptor[] {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return [];
  }

  const rows: StateDetailRow[] = [];
  const seen = new Set<string>();
  const currentNode = asRecord(metadata['currentNode']);
  if (currentNode) {
    const row = toTaskGraphRow(currentNode, true);
    rows.push(row);
    seen.add(row.id);
  }

  for (const value of asArray(metadata['nodeHighlights'])) {
    const node = asRecord(value);
    if (!node) {
      continue;
    }
    const row = toTaskGraphRow(node, false);
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    rows.push(row);
  }

  if (rows.length === 0) {
    return [];
  }

  return [{ title: currentNode ? '当前节点与关键节点' : '关键节点', rows }];
}

function buildTaskSchedulerSummaryBadges(source: {
  metadata?: Record<string, unknown> | null;
}): ActivitySummaryBadge[] {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return [];
  }

  const badges: ActivitySummaryBadge[] = [];
  const scheduleId = asString(metadata['scheduleId']);
  const phase = asString(metadata['phase']);
  const schedulerStatus = asString(metadata['schedulerStatus']);
  const launchKind = asString(metadata['launchKind']);
  const launchMode = asString(metadata['launchMode']);
  const scheduleCount = asNumber(metadata['scheduleCount']);

  if (scheduleId) {
    badges.push({ label: '调度', value: scheduleId, tone: 'info' });
  }
  if (phase) {
    badges.push({ label: '阶段', value: formatTaskSchedulerPhase(phase), tone: toneFromTaskSchedulerPhase(phase) });
  }
  if (schedulerStatus) {
    badges.push({ label: '服务', value: formatTaskSchedulerStatus(schedulerStatus), tone: schedulerStatus === 'running' ? 'info' : 'neutral' });
  }
  if (launchKind || launchMode) {
    badges.push({
      label: '触发',
      value: [formatLaunchKind(launchKind), formatLaunchMode(launchMode)].filter(Boolean).join(' · '),
      tone: launchMode === 'async' ? 'info' : 'neutral',
    });
  }
  if (typeof scheduleCount === 'number' && scheduleCount > 0) {
    badges.push({ label: '计划数', value: String(scheduleCount), tone: 'neutral' });
  }

  return badges;
}

function buildTaskAutonomySummaryBadges(source: {
  metadata?: Record<string, unknown> | null;
}): ActivitySummaryBadge[] {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return [];
  }

  const badges: ActivitySummaryBadge[] = [];
  const status = asString(metadata['status']);
  const phase = asString(metadata['phase']);
  const reason = asString(metadata['reason']);
  const consecutiveFailures = asNumber(metadata['consecutiveFailures']);
  const maxConsecutiveFailures = asNumber(metadata['maxConsecutiveFailures']);

  if (status) {
    badges.push({ label: '状态', value: formatTaskAutonomyStatus(status), tone: toneFromTaskAutonomyStatus(status) });
  }
  if (phase) {
    badges.push({ label: '事件', value: formatTaskAutonomyPhase(phase), tone: toneFromTaskAutonomyPhase(phase) });
  }
  if (typeof consecutiveFailures === 'number' && typeof maxConsecutiveFailures === 'number') {
    badges.push({
      label: '连续失败',
      value: `${consecutiveFailures}/${maxConsecutiveFailures}`,
      tone: consecutiveFailures > 0 ? 'warn' : 'success',
    });
  }
  if (reason) {
    badges.push({ label: '原因', value: formatTaskAutonomyReason(reason), tone: reason !== 'manual_stop' ? 'warn' : 'neutral' });
  }

  return badges;
}

function buildProviderContextManagementSummaryBadges(source: {
  metadata?: Record<string, unknown> | null;
}): ActivitySummaryBadge[] {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return [];
  }

  const badges: ActivitySummaryBadge[] = [];
  const kind = asString(metadata['kind']);
  const responseType = asString(metadata['responseType']);
  const editCount = asNumber(metadata['editCount']);
  const clearedInputTokens = asNumber(metadata['clearedInputTokens']);
  const clearedToolUses = asNumber(metadata['clearedToolUses']);
  const clearedThinkingTurns = asNumber(metadata['clearedThinkingTurns']);
  const hasEncryptedContent = metadata['hasEncryptedContent'] === true;

  if (kind) {
    badges.push({ label: 'Provider', value: formatProviderContextManagementKind(kind), tone: 'info' });
  }
  if (responseType) {
    badges.push({ label: '结果', value: responseType, tone: 'neutral' });
  }
  if (typeof editCount === 'number' && editCount > 0) {
    badges.push({ label: '编辑', value: String(editCount), tone: 'info' });
  }
  if (typeof clearedInputTokens === 'number' && clearedInputTokens > 0) {
    badges.push({ label: 'Tokens', value: String(clearedInputTokens), tone: 'warn' });
  }
  if (typeof clearedToolUses === 'number' && clearedToolUses > 0) {
    badges.push({ label: 'Tool Uses', value: String(clearedToolUses), tone: 'warn' });
  }
  if (typeof clearedThinkingTurns === 'number' && clearedThinkingTurns > 0) {
    badges.push({ label: 'Thinking', value: String(clearedThinkingTurns), tone: 'warn' });
  }
  if (hasEncryptedContent) {
    badges.push({ label: '载荷', value: '含加密上下文', tone: 'neutral' });
  }

  return badges;
}

function buildProviderContextManagementDetailSections(source: {
  id?: string;
  metadata?: Record<string, unknown> | null;
}): DetailSectionDescriptor[] {
  const metadata = asRecord(source.metadata);
  if (!metadata) {
    return [];
  }

  const kind = asString(metadata['kind']);
  const responseType = asString(metadata['responseType']);
  const responseId = asString(metadata['responseId']);
  const hasEncryptedContent = metadata['hasEncryptedContent'] === true;
  const editCount = asNumber(metadata['editCount']);
  const clearedInputTokens = asNumber(metadata['clearedInputTokens']);
  const clearedToolUses = asNumber(metadata['clearedToolUses']);
  const clearedThinkingTurns = asNumber(metadata['clearedThinkingTurns']);
  const appliedEdits = asRecordArray(metadata['appliedEdits']);
  const baseId = source.id || 'provider-context-management';
  const sections: DetailSectionDescriptor[] = [];

  const summaryNotes = [
    kind ? `provider: ${formatProviderContextManagementKind(kind)}` : '',
    responseType ? `responseType: ${responseType}` : '',
    responseId ? `responseId: ${responseId}` : '',
    hasEncryptedContent ? 'encryptedContent: present' : '',
    typeof editCount === 'number' ? `editCount: ${editCount}` : '',
    typeof clearedInputTokens === 'number' && clearedInputTokens > 0 ? `clearedInputTokens: ${clearedInputTokens}` : '',
    typeof clearedToolUses === 'number' && clearedToolUses > 0 ? `clearedToolUses: ${clearedToolUses}` : '',
    typeof clearedThinkingTurns === 'number' && clearedThinkingTurns > 0 ? `clearedThinkingTurns: ${clearedThinkingTurns}` : '',
  ].filter(Boolean).join('\n');

  if (summaryNotes) {
    sections.push({
      title: '执行结果',
      rows: [{
        id: `${baseId}:summary`,
        title: kind === 'responses' ? 'Responses 上下文压缩' : 'Provider 上下文清理',
        subtitle: kind ? formatProviderContextManagementKind(kind) : undefined,
        note: summaryNotes,
        tone: kind === 'responses' ? 'info' : 'warn',
      }],
    });
  }

  const editRows = appliedEdits
    .map((edit, index) => toProviderContextManagementEditRow(edit, `${baseId}:edit:${index}`))
    .filter((row): row is StateDetailRow => !!row);

  if (editRows.length > 0) {
    sections.push({
      title: 'Applied Edits',
      rows: editRows,
    });
  }

  return sections;
}

function toProviderContextManagementEditRow(edit: Record<string, unknown>, id: string): StateDetailRow | null {
  const type = asString(edit['type']);
  const clearedInputTokens = asNumber(edit['clearedInputTokens']);
  const clearedToolUses = asNumber(edit['clearedToolUses']);
  const clearedThinkingTurns = asNumber(edit['clearedThinkingTurns']);
  const note = [
    typeof clearedInputTokens === 'number' && clearedInputTokens > 0 ? `clearedInputTokens: ${clearedInputTokens}` : '',
    typeof clearedToolUses === 'number' && clearedToolUses > 0 ? `clearedToolUses: ${clearedToolUses}` : '',
    typeof clearedThinkingTurns === 'number' && clearedThinkingTurns > 0 ? `clearedThinkingTurns: ${clearedThinkingTurns}` : '',
  ].filter(Boolean).join('\n');

  if (!type && !note) {
    return null;
  }

  return {
    id,
    title: formatProviderContextManagementEditType(type),
    subtitle: type || undefined,
    note: note || undefined,
    tone: 'warn',
  };
}

function formatProviderContextManagementKind(kind: string | undefined): string {
  switch (kind) {
    case 'responses':
      return 'Responses';
    case 'anthropic':
      return 'Anthropic';
    default:
      return kind || 'Unknown';
  }
}

function formatProviderContextManagementEditType(type: string | undefined): string {
  switch (type) {
    case 'clear_tool_uses_20250919':
      return '清理旧工具调用';
    case 'clear_thinking_20251015':
      return '清理旧思考轨迹';
    default:
      return type || 'Provider edit';
  }
}

function toTaskGraphRow(node: Record<string, unknown>, isCurrent: boolean): StateDetailRow {
  const nodeId = asString(node['nodeId']) || 'node';
  const description = asString(node['description']);
  const taskId = asString(node['taskId']);
  const status = asString(node['status']);
  const attempts = asNumber(node['attempts']);
  const executionMode = asString(node['executionMode']);
  const note = asString(node['note']);
  const subtitleParts = [
    description && description !== nodeId ? `节点 ${nodeId}` : '',
    taskId ? `任务 ${taskId}` : '',
    typeof attempts === 'number' && attempts > 0 ? `尝试 ${attempts}` : '',
    formatExecutionMode(executionMode),
    isCurrent ? '当前事件' : '',
  ].filter(Boolean);

  return {
    id: nodeId,
    title: description || taskId || nodeId,
    subtitle: subtitleParts.join(' · '),
    note,
    trailing: formatTaskGraphNodeStatus(status),
    tone: toneFromTaskGraphNodeStatus(status),
  };
}

function toAgentTeamRoleRow(role: Record<string, unknown>): StateDetailRow {
  const roleId = asString(role['roleId']) || 'role';
  const description = asString(role['description']);
  const agentType = asString(role['agentType']);
  const status = asString(role['status']);
  const assignedCount = asNumber(role['assignedCount']) || 0;
  const runningCount = asNumber(role['runningCount']) || 0;
  const completedCount = asNumber(role['completedCount']) || 0;
  const failedCount = asNumber(role['failedCount']) || 0;

  return {
    id: roleId,
    title: description || roleId,
    subtitle: [description && description !== roleId ? `角色 ${roleId}` : '', agentType].filter(Boolean).join(' · '),
    note: [
      assignedCount ? `分配 ${assignedCount}` : '',
      runningCount ? `运行 ${runningCount}` : '',
      completedCount ? `完成 ${completedCount}` : '',
      failedCount ? `失败 ${failedCount}` : '',
    ].filter(Boolean).join(' · '),
    trailing: formatAgentTeamRoleStatus(status),
    tone: toneFromAgentTeamRoleStatus(status),
  };
}

function toAgentTeamMessageRow(message: Record<string, unknown>): StateDetailRow {
  const messageId = asString(message['messageId']) || 'message';
  const fromRoleId = asString(message['fromRoleId']) || 'unknown';
  const toRoleId = asString(message['toRoleId']) || 'unknown';
  const trigger = asString(message['trigger']);
  const nodeId = asString(message['nodeId']);
  const content = asString(message['content']);

  return {
    id: messageId,
    title: `${fromRoleId} -> ${toRoleId}`,
    subtitle: [formatAgentTeamTrigger(trigger), nodeId ? `节点 ${nodeId}` : ''].filter(Boolean).join(' · '),
    note: content,
    trailing: formatAgentTeamTrigger(trigger),
    tone: 'info',
  };
}

function toToolCallTimelineRow(entry: Record<string, unknown>, index: number): StateDetailRow {
  const recordId = asString(entry['recordId']) || `tool-row-${index}`;
  const phase = asString(entry['phase']);
  const timestamp = asNumber(entry['timestamp']);
  const summary = asString(entry['summary']);
  const progress = asNumber(entry['progress']);
  const progressDetails = asRecord(entry['progressDetails']);

  return {
    id: recordId,
    title: formatNarrativePhase(phase),
    subtitle: [formatClock(timestamp), recordId].filter(Boolean).join(' · '),
    note: buildToolCallNote(summary, progressDetails),
    trailing: typeof progress === 'number' ? `${Math.round(progress)}%` : formatNarrativePhase(phase),
    tone: toneFromNarrativePhase(phase),
  };
}

function formatReadFileCompactLineSpan(start: unknown, end: unknown): string | undefined {
  const startLine = asNumber(start);
  const endLine = asNumber(end);
  if (startLine === undefined) {
    return undefined;
  }
  if (endLine === undefined || endLine === startLine) {
    return formatReadFileInteger(startLine);
  }
  return `${formatReadFileInteger(startLine)}-${formatReadFileInteger(endLine)}`;
}

function formatReadFileDetailedLineSpan(start: unknown, end: unknown): string | undefined {
  const startLine = asNumber(start);
  const endLine = asNumber(end);
  if (startLine === undefined) {
    return undefined;
  }
  if (endLine === undefined || endLine === startLine) {
    return `第 ${formatReadFileInteger(startLine)} 行`;
  }
  return `第 ${formatReadFileInteger(startLine)} 到 ${formatReadFileInteger(endLine)} 行`;
}

function formatReadFileCompactByteRatio(readBytes: unknown, totalBytes: unknown): string | undefined {
  const read = asNumber(readBytes);
  const total = asNumber(totalBytes);
  if (read === undefined && total === undefined) {
    return undefined;
  }
  if (read !== undefined && total !== undefined) {
    return `${formatReadFileInteger(read)}/${formatReadFileInteger(total)}`;
  }
  return formatReadFileInteger(read ?? total ?? 0);
}

function formatReadFileDetailedBytes(readBytes: unknown, totalBytes: unknown): string | undefined {
  const read = asNumber(readBytes);
  const total = asNumber(totalBytes);
  if (read === undefined && total === undefined) {
    return undefined;
  }
  if (read !== undefined && total !== undefined) {
    return `已读取 ${formatReadFileInteger(read)} bytes，共 ${formatReadFileInteger(total)} bytes`;
  }
  if (read !== undefined) {
    return `已读取 ${formatReadFileInteger(read)} bytes`;
  }
  return `共 ${formatReadFileInteger(total || 0)} bytes`;
}

function formatReadFileContinuation(value: unknown): string | undefined {
  const continuation = asRecord(value);
  if (!continuation) {
    return undefined;
  }

  const startLine = asNumber(continuation['startLine']);
  const endLine = asNumber(continuation['endLine']);
  if (startLine !== undefined) {
    return endLine !== undefined
      ? `startLine=${startLine}, endLine=${endLine}`
      : `startLine=${startLine}`;
  }

  const offset = asNumber(continuation['offset']);
  const limit = asNumber(continuation['limit']);
  if (offset !== undefined) {
    return limit !== undefined
      ? `offset=${offset}, limit=${limit}`
      : `offset=${offset}`;
  }

  return undefined;
}

function formatReadFileInteger(value: number): string {
  return value.toLocaleString('en-US');
}

function toSubagentDetailRow(item: Record<string, unknown>, index: number): StateDetailRow | null {
  const kind = asString(item['kind']);
  const content = asString(item['content']);
  const toolName = asString(item['toolName']);
  const argsSummary = asString(item['argsSummary']);
  const toolState = asString(item['state']);
  const duration = asNumber(item['duration']);
  const itemId = asString(item['toolCallId']) || `subagent-step-${index}`;

  if (kind === 'thinking') {
    return content ? textToSubagentNarrativeRow(`${itemId}:thinking`, content, 'info') : null;
  }

  if (kind === 'tool') {
    return {
      id: `${itemId}:tool`,
      title: toolName || '工具调用',
      subtitle: argsSummary,
      trailing: formatSubagentToolTrailing(toolState, duration),
      tone: toneFromSubagentToolState(toolState),
    };
  }

  if (!content) {
    return null;
  }

  return textToSubagentNarrativeRow(`${itemId}:text`, content, 'neutral');
}

function textToSubagentNarrativeRow(id: string, text: string, tone: StateTone): StateDetailRow {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  const title = lines[0] || text.trim();
  const note = lines.slice(1).join('\n') || undefined;

  return {
    id,
    title,
    note,
    tone,
  };
}

function buildToolCallOutputRows(
  entry: Record<string, unknown>,
  index: number,
  toolName: string | undefined,
): StateDetailRow[] {
  const registeredRows = projectRegisteredToolCallOutputRows({ toolName, entry, index });
  if (registeredRows.length > 0) {
    return registeredRows;
  }

  if (isChangedFilesToolName(toolName)) {
    const changedFiles = collectChangedFilesEntriesFromToolResultEntry(entry);
    if (changedFiles.length > 0) {
      const recordId = asString(entry['recordId']) || `tool-row-${index}`;
      return changedFiles.map((changedFile, changedIndex) => ({
        id: `${recordId}:changed-file:${changedIndex}`,
        title: changedFile.name || changedFile.path,
        subtitle: [
          changedFile.directory,
          changedFile.previousPath ? `来自 ${changedFile.previousPath}` : undefined,
        ].filter(Boolean).join(' · ') || undefined,
        trailing: changedFile.statusLabel,
        tone: changedFile.tone,
        outputKind: 'changed-file',
        outputLabel: changedFile.statusBadge,
      }));
    }
  }

  const resultContent = asToolResultContentArray(entry['resultContent']);
  if (resultContent.length > 0) {
    return buildToolCallOutputRowsFromContent(entry, resultContent, toolName);
  }

  const resultText = asString(entry['resultText']);
  if (!resultText) {
    return [];
  }

  const recordId = asString(entry['recordId']) || `tool-row-${index}`;
  const phase = asString(entry['phase']);
  const timestamp = asNumber(entry['timestamp']);
  const summary = asString(entry['summary']);
  const terminal = parseTerminalPayload(resultText);

  if (terminal) {
    return buildTerminalOutputRows({
      recordId,
      phase,
      timestamp,
      summary,
      toolName,
      terminal,
    });
  }

  return [normalizeReadFileToolOutputRow({
    id: `${recordId}:output`,
    title: summary || toolName || '工具输出',
    subtitle: [formatClock(timestamp), recordId].filter(Boolean).join(' · '),
    note: resultText,
    trailing: phase ? formatNarrativePhase(phase) : undefined,
    tone: toneFromNarrativePhase(phase),
  }, toolName)];
}

function buildToolCallOutputRowsFromContent(
  entry: Record<string, unknown>,
  resultContent: readonly ToolResultContentPart[],
  toolName: string | undefined,
): StateDetailRow[] {
  const recordId = asString(entry['recordId']) || 'tool-output';
  const phase = asString(entry['phase']);
  const timestamp = asNumber(entry['timestamp']);
  const summary = asString(entry['summary']);

  if (resultContent.some((part) => part.type.startsWith('terminal_'))) {
    return buildTerminalOutputRowsFromContent({
      recordId,
      phase,
      timestamp,
      summary,
      toolName,
      resultContent,
    });
  }

  if (resultContent.length === 1) {
    const singleText = getToolResultContentText(resultContent[0]);
    if (singleText) {
      const terminal = parseTerminalPayload(singleText);
      if (terminal) {
        return buildTerminalOutputRows({
          recordId,
          phase,
          timestamp,
          summary,
          toolName,
          terminal,
        });
      }
    }
  }

  return resultContent
    .map((part, partIndex) => normalizeReadFileToolOutputRow(
      normalizeStructuredToolResultRow({
        id: `${recordId}:output:${partIndex}`,
        title: formatToolResultContentPartTitle(part.type, partIndex, summary, toolName),
        subtitle: [formatClock(timestamp), recordId].filter(Boolean).join(' · '),
        note: getToolResultContentText(part) || getToolResultContentDescription(part) || (hasStructuredToolResultPayload(part) ? undefined : safeJsonStringify(part)),
        trailing: partIndex === 0 && phase ? formatNarrativePhase(phase) : undefined,
        tone: toneFromToolResultContentPart(part.type, phase),
        outputKind: outputKindFromToolResultContentType(part.type),
        outputUri: getToolResultContentUri(part),
        outputMimeType: getToolResultContentMimeType(part),
        outputData: getToolResultContentData(part),
        outputLabel: getToolResultContentLabel(part),
        outputDescription: getToolResultContentDescription(part),
      }),
      toolName,
    ));
}

function normalizeReadFileToolOutputRow(row: StateDetailRow, toolName: string | undefined): StateDetailRow {
  if (!isReadFileToolName(toolName)) {
    return row;
  }

  switch (row.outputKind) {
    case 'code':
    case 'terminal-command':
    case 'terminal-stream':
    case 'image':
    case 'resource':
    case 'changed-file':
      return row;
    default:
      break;
  }

  const text = row.outputCode || row.note;
  if (!text?.trim()) {
    return row;
  }

  return {
    ...row,
    note: undefined,
    outputKind: 'code',
    outputCode: text,
    outputLanguage: row.outputLanguage,
  };
}

function normalizeStructuredToolResultRow(row: StateDetailRow): StateDetailRow {
  if (row.outputKind !== 'text' && row.outputKind !== 'default') {
    return row;
  }

  const codeBlock = parseStandaloneFencedCodeBlock(row.note);
  if (!codeBlock) {
    return row;
  }

  return {
    ...row,
    note: undefined,
    outputKind: 'code',
    outputCode: codeBlock.code,
    outputLanguage: codeBlock.language,
  };
}

function parseStandaloneFencedCodeBlock(note: string | undefined): { code: string; language?: string } | undefined {
  if (!note) {
    return undefined;
  }

  const trimmed = note.trim();
  const match = /^```([^\n`]*)\n([\s\S]*?)\n```$/.exec(trimmed);
  if (!match) {
    return undefined;
  }

  const language = match[1].trim() || undefined;
  const code = match[2].replace(/\n$/, '');
  if (!code.trim()) {
    return undefined;
  }

  return { code, language };
}

function buildTerminalOutputRowsFromContent(input: {
  recordId: string;
  phase: string | undefined;
  timestamp: number | undefined;
  summary: string | undefined;
  toolName: string | undefined;
  resultContent: readonly ToolResultContentPart[];
}): StateDetailRow[] {
  const { recordId, phase, timestamp, summary, toolName, resultContent } = input;
  const baseSubtitle = [formatClock(timestamp), recordId].filter(Boolean);
  return resultContent.flatMap<StateDetailRow>((part, partIndex) => {
    const text = getToolResultContentText(part);
    if (!text) {
      return [];
    }

    if (part.type === 'terminal_command') {
      const exitCode = typeof part['exitCode'] === 'number' ? part['exitCode'] : undefined;
      const isRunning = part['isRunning'] === true;
      const status = typeof part['status'] === 'string' ? part['status'] : undefined;
      const terminalState = resolveTerminalLifecycleState({ exitCode, isRunning, status });
      const terminalId = firstDisplayString(part['processId'], part['outputSessionId'], part['terminalId']);
      const cwd = typeof part['cwd'] === 'string' ? part['cwd'] : undefined;
      return [{
        id: `${recordId}:output:command`,
        title: text || summary || toolName || chatI18n('AILY_CHAT.PROCESS_FALLBACK_TERMINAL_COMMAND'),
        subtitle: [...baseSubtitle, terminalId ? `${chatI18n('AILY_CHAT.PROCESS_TERMINAL_ID_PREFIX')} ${terminalId}` : '', cwd || ''].filter(Boolean).join(' · ') || undefined,
        note: summary && summary !== text ? summary : undefined,
        trailing: isRunning ? chatI18n('AILY_CHAT.PROCESS_STATUS_RUNNING') : (typeof exitCode === 'number' ? `${chatI18n('AILY_CHAT.PROCESS_LABEL_EXIT_CODE')} ${exitCode}` : (phase ? formatNarrativePhase(phase) : undefined)),
        tone: terminalState === 'running' ? 'info' : (terminalState === 'failed' ? 'error' : (terminalState === 'cancelled' ? 'warn' : toneFromNarrativePhase(phase))),
        outputKind: 'terminal-command',
      }];
    }

    if (part.type === 'terminal_stdout') {
      return [{
        id: `${recordId}:output:stdout`,
        title: chatI18n('AILY_CHAT.PROCESS_OUTPUT_STDOUT'),
        subtitle: baseSubtitle.join(' · ') || undefined,
        note: text,
        tone: 'success',
        outputKind: 'terminal-stream',
        outputChannel: 'stdout',
      }];
    }

    if (part.type === 'terminal_stderr') {
      const exitCode = typeof part['exitCode'] === 'number' ? part['exitCode'] : undefined;
      const status = typeof part['status'] === 'string' ? part['status'] : undefined;
      return [{
        id: `${recordId}:output:stderr`,
        title: chatI18n('AILY_CHAT.PROCESS_OUTPUT_STDERR'),
        subtitle: baseSubtitle.join(' · ') || undefined,
        note: text,
        tone: isTerminalFailureState({ exitCode, status }) ? 'error' : 'warn',
        outputKind: 'terminal-stream',
        outputChannel: 'stderr',
      }];
    }

    return [{
      id: `${recordId}:output:${partIndex}`,
      title: formatToolResultContentPartTitle(part.type, partIndex, summary, toolName),
      subtitle: baseSubtitle.join(' · ') || undefined,
      note: text || getToolResultContentDescription(part),
      trailing: partIndex === 0 && phase ? formatNarrativePhase(phase) : undefined,
      tone: toneFromToolResultContentPart(part.type, phase),
      outputKind: outputKindFromToolResultContentType(part.type),
      outputUri: getToolResultContentUri(part),
      outputMimeType: getToolResultContentMimeType(part),
      outputData: getToolResultContentData(part),
      outputLabel: getToolResultContentLabel(part),
      outputDescription: getToolResultContentDescription(part),
    }];
  });
}

function buildTerminalOutputRows(input: {
  recordId: string;
  phase: string | undefined;
  timestamp: number | undefined;
  summary: string | undefined;
  toolName: string | undefined;
  terminal: ReturnType<typeof parseTerminalPayload> extends infer T ? Exclude<T, null> : never;
}): StateDetailRow[] {
  const { recordId, phase, timestamp, summary, toolName, terminal } = input;
  const baseSubtitle = [formatClock(timestamp), recordId].filter(Boolean);
  const rows: StateDetailRow[] = [];
  const commandTitle = terminal.command || summary || toolName || chatI18n('AILY_CHAT.PROCESS_FALLBACK_TERMINAL_COMMAND');
  const commandSubtitle = [
    ...baseSubtitle,
    getParsedTerminalDisplayId(terminal) ? `${chatI18n('AILY_CHAT.PROCESS_TERMINAL_ID_PREFIX')} ${getParsedTerminalDisplayId(terminal)}` : '',
    terminal.cwd || '',
  ].filter(Boolean).join(' · ');
  const stderr = normalizeTerminalStream(terminal.stderr);
  const terminalState = resolveTerminalLifecycleState(terminal);
  const commandTone: StateTone = terminalState === 'running'
    ? 'info'
    : terminalState === 'failed'
      ? 'error'
      : stderr || terminalState === 'cancelled'
        ? 'warn'
        : toneFromNarrativePhase(phase);

  rows.push({
    id: `${recordId}:output:command`,
    title: commandTitle,
    subtitle: commandSubtitle || undefined,
    note: summary && summary !== commandTitle ? summary : undefined,
    trailing: terminal.isRunning
      ? chatI18n('AILY_CHAT.PROCESS_STATUS_RUNNING')
      : (typeof terminal.exitCode === 'number' ? `${chatI18n('AILY_CHAT.PROCESS_LABEL_EXIT_CODE')} ${terminal.exitCode}` : (phase ? formatNarrativePhase(phase) : undefined)),
    tone: commandTone,
    outputKind: 'terminal-command',
  });

  if (terminal.output) {
    rows.push({
      id: `${recordId}:output:stdout`,
      title: chatI18n('AILY_CHAT.PROCESS_OUTPUT_STDOUT'),
      subtitle: baseSubtitle.join(' · ') || undefined,
      note: terminal.output,
      tone: stderr ? 'neutral' : 'success',
      outputKind: 'terminal-stream',
      outputChannel: 'stdout',
    });
  }

  if (stderr) {
    rows.push({
      id: `${recordId}:output:stderr`,
      title: chatI18n('AILY_CHAT.PROCESS_OUTPUT_STDERR'),
      subtitle: baseSubtitle.join(' · ') || undefined,
      note: stderr,
      tone: isTerminalFailureState(terminal) ? 'error' : 'warn',
      outputKind: 'terminal-stream',
      outputChannel: 'stderr',
    });
  }

  return rows;
}

function normalizeTerminalStream(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === '(terminal stderr completed with no output)') {
    return undefined;
  }
  return trimmed;
}

function formatToolCallArgs(args: unknown): string | undefined {
  if (args == null) {
    return undefined;
  }
  if (typeof args === 'string') {
    return args.trim() || undefined;
  }
  return safeJsonStringify(args);
}

function asToolResultContentArray(value: unknown): ToolResultContentPart[] {
  return Array.isArray(value)
    ? value
      .map(item => asRecord(item))
      .filter((item): item is Record<string, unknown> => !!item && typeof item['type'] === 'string')
      .map(item => item as ToolResultContentPart)
    : [];
}

function getToolResultContentText(part: ToolResultContentPart): string | undefined {
  if (typeof part.text === 'string' && part.text.trim().length > 0) {
    return part.text;
  }
  const value = part['value'];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getToolResultContentDescription(part: ToolResultContentPart): string | undefined {
  const description = part['description'];
  return typeof description === 'string' && description.trim().length > 0 ? description : undefined;
}

function getToolResultContentUri(part: ToolResultContentPart): string | undefined {
  const uri = part['uri'];
  if (typeof uri === 'string' && uri.trim().length > 0) {
    return uri;
  }
  const url = part['url'];
  return typeof url === 'string' && url.trim().length > 0 ? url : undefined;
}

function getToolResultContentMimeType(part: ToolResultContentPart): string | undefined {
  const mimeType = part['mimeType'];
  if (typeof mimeType === 'string' && mimeType.trim().length > 0) {
    return mimeType;
  }
  const mediaType = part['media_type'];
  return typeof mediaType === 'string' && mediaType.trim().length > 0 ? mediaType : undefined;
}

function getToolResultContentData(part: ToolResultContentPart): string | undefined {
  const data = part['data'];
  return typeof data === 'string' && data.trim().length > 0 ? data : undefined;
}

function getToolResultContentLabel(part: ToolResultContentPart): string | undefined {
  const name = part['name'];
  if (typeof name === 'string' && name.trim().length > 0) {
    return name;
  }
  const title = part['title'];
  if (typeof title === 'string' && title.trim().length > 0) {
    return title;
  }
  const uri = getToolResultContentUri(part);
  if (!uri) {
    return undefined;
  }
  const slashIndex = Math.max(uri.lastIndexOf('/'), uri.lastIndexOf('\\'));
  return slashIndex >= 0 ? uri.slice(slashIndex + 1) || uri : uri;
}

function hasStructuredToolResultPayload(part: ToolResultContentPart): boolean {
  return !!(
    getToolResultContentUri(part)
    || getToolResultContentMimeType(part)
    || getToolResultContentData(part)
    || getToolResultContentDescription(part)
    || getToolResultContentLabel(part)
  );
}

function formatToolResultContentPartTitle(
  type: string,
  index: number,
  summary: string | undefined,
  toolName: string | undefined,
): string {
  if (index === 0) {
    return summary || toolName || '工具输出';
  }

  switch (type) {
    case 'terminal_command':
      return summary || toolName || chatI18n('AILY_CHAT.PROCESS_FALLBACK_TERMINAL_COMMAND');
    case 'terminal_stdout':
      return chatI18n('AILY_CHAT.PROCESS_OUTPUT_STDOUT');
    case 'terminal_stderr':
      return chatI18n('AILY_CHAT.PROCESS_OUTPUT_STDERR');
    case 'text':
    case 'output_text':
      return `文本输出 ${index + 1}`;
    case 'image':
    case 'output_image':
      return `图像输出 ${index + 1}`;
    case 'output_resource':
    case 'resource':
    case 'resource_link':
    case 'file':
      return `资源输出 ${index + 1}`;
    default:
      return `${type} 输出 ${index + 1}`;
  }
}

function toneFromToolResultContentPart(type: string, phase: string | undefined): StateTone {
  switch (type) {
    case 'terminal_command':
      return toneFromNarrativePhase(phase);
    case 'terminal_stdout':
      return 'success';
    case 'terminal_stderr':
      return 'warn';
    case 'image':
    case 'output_image':
    case 'output_resource':
    case 'resource':
    case 'resource_link':
    case 'file':
      return 'info';
    default:
      return toneFromNarrativePhase(phase);
  }
}

function outputKindFromToolResultContentType(type: string): StateDetailRow['outputKind'] {
  switch (type) {
    case 'terminal_command':
      return 'terminal-command';
    case 'terminal_stdout':
    case 'terminal_stderr':
      return 'terminal-stream';
    case 'image':
    case 'output_image':
      return 'image';
    case 'output_resource':
    case 'resource':
    case 'resource_link':
    case 'file':
      return 'resource';
    case 'text':
    case 'output_text':
      return 'text';
    default:
      return 'default';
  }
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function buildToolCallNote(
  summary: string | undefined,
  progressDetails: Record<string, unknown> | undefined,
): string | undefined {
  const notes: string[] = [];
  const pushNote = (value: string | undefined): void => {
    if (!value || notes.includes(value)) {
      return;
    }
    notes.push(value);
  };

  pushNote(summary);
  if (progressDetails) {
    pushNote(asString(progressDetails['message']));
    const detail = asString(progressDetails['detail']);
    if (detail) {
      pushNote(`详情: ${detail}`);
    }
    const step = asString(progressDetails['step']);
    if (step) {
      pushNote(`步骤: ${step}`);
    }
    const statusText = asString(progressDetails['statusText']);
    if (statusText) {
      pushNote(`状态: ${statusText}`);
    }
    const operationKind = asString(progressDetails['operationKind']);
    if (operationKind) {
      pushNote(`操作: ${operationKind}`);
    }
    const queueSize = asNumber(progressDetails['queueSize']);
    if (queueSize !== undefined) {
      pushNote(`队列: ${queueSize}`);
    }
    const durationMs = asNumber(progressDetails['durationMs']);
    if (durationMs !== undefined) {
      pushNote(`耗时: ${formatDurationMs(durationMs)}`);
    }
  }

  return notes.length > 0 ? notes.join('\n') : undefined;
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function toBackgroundTaskActivityRow(activity: Record<string, unknown>, taskId: string): StateDetailRow {
  const kind = asString(activity['kind']);
  const toolName = asString(activity['toolName']);
  const agentName = asString(activity['agentName']);
  const description = asString(activity['description']);
  const summary = asString(activity['summary']);
  const detail = asString(activity['detail']);
  const step = asString(activity['step']);
  const statusText = asString(activity['statusText']);
  const resultText = asString(activity['resultText']);
  const progress = asNumber(activity['progress']);

  const notes = [summary, detail, step ? `步骤: ${step}` : undefined, statusText ? `状态: ${statusText}` : undefined, resultText]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');

  return {
    id: `${taskId}:activity`,
    title: formatBackgroundTaskActivityKind(kind),
    subtitle: [toolName, agentName, description].filter(Boolean).join(' · '),
    note: notes || undefined,
    trailing: typeof progress === 'number' ? `${Math.round(progress)}%` : undefined,
    tone: toneFromBackgroundTaskActivityKind(kind),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return asArray(value)
    .map(item => asRecord(item))
    .filter((item): item is Record<string, unknown> => !!item);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function firstDisplayString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function getParsedTerminalDisplayId(terminal: ReturnType<typeof parseTerminalPayload> extends infer T ? Exclude<T, null> : never): string | undefined {
  return firstDisplayString(terminal.processId, terminal.outputSessionId, terminal.terminalId);
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function collectInstructionDiagnosticCounts(diagnostics: readonly Record<string, unknown>[]): Record<InstructionDiagnosticFilter, number> {
  const counts: Record<InstructionDiagnosticFilter, number> = {
    all: diagnostics.length,
    active: 0,
    inactive: 0,
    overridden: 0,
    empty: 0,
    not_found: 0,
  };

  for (const diagnostic of diagnostics) {
    if (asBoolean(diagnostic['active'])) {
      counts.active += 1;
      continue;
    }

    switch (asString(diagnostic['skipReason'])) {
      case 'inactive':
        counts.inactive += 1;
        break;
      case 'overridden':
        counts.overridden += 1;
        break;
      case 'empty':
        counts.empty += 1;
        break;
      case 'not_found':
        counts.not_found += 1;
        break;
      default:
        break;
    }
  }

  return counts;
}

function resolveInstructionFilter(
  current: InstructionDiagnosticFilter,
  counts: Record<InstructionDiagnosticFilter, number>,
): InstructionDiagnosticFilter {
  if (current === 'all' || counts[current] > 0) {
    return current;
  }

  return 'all';
}

function buildInstructionFilterChips(
  counts: Record<InstructionDiagnosticFilter, number>,
  selected: InstructionDiagnosticFilter,
): InstructionFilterChip[] {
  if (counts.all === 0) {
    return [];
  }

  const options: Array<{ id: InstructionDiagnosticFilter; label: string; tone: StateTone }> = [
    { id: 'all', label: '全部', tone: 'neutral' },
    { id: 'active', label: '已生效', tone: 'success' },
    { id: 'inactive', label: '条件跳过', tone: 'warn' },
    { id: 'overridden', label: '被覆盖', tone: 'warn' },
    { id: 'empty', label: '空文件', tone: 'warn' },
    { id: 'not_found', label: '未发现', tone: 'neutral' },
  ];

  return options
    .filter(option => option.id === 'all' || counts[option.id] > 0)
    .map(option => ({
      id: option.id,
      label: option.label,
      count: counts[option.id],
      tone: option.tone,
      active: option.id === selected,
    }));
}

function matchesInstructionDiagnosticFilter(
  diagnostic: Record<string, unknown>,
  filter: InstructionDiagnosticFilter,
): boolean {
  if (filter === 'all') {
    return true;
  }

  if (filter === 'active') {
    return asBoolean(diagnostic['active']);
  }

  return asString(diagnostic['skipReason']) === filter;
}

function formatInstructionFilterTitle(filter: InstructionDiagnosticFilter): string {
  const map: Record<InstructionDiagnosticFilter, string> = {
    all: '规则明细',
    active: '已生效规则',
    inactive: '条件跳过',
    overridden: '被覆盖规则',
    empty: '空文件',
    not_found: '未发现文件',
  };

  return map[filter];
}

function toInstructionDiagnosticRow(diagnostic: Record<string, unknown>, fallbackId?: string): StateDetailRow {
  const id = asString(diagnostic['id']) || `${fallbackId || 'instructions'}:diagnostic`;
  const name = formatInstructionDiagnosticTitle(diagnostic, id);
  const source = asString(diagnostic['source']);
  const reference = asString(diagnostic['reference']);
  const ownerId = asString(diagnostic['ownerId']);
  const priority = asNumber(diagnostic['priority']);
  const active = asBoolean(diagnostic['active']);
  const skipReason = asString(diagnostic['skipReason']);
  const overriddenById = asString(diagnostic['overriddenById']);
  const activation = asRecord(diagnostic['activation']);

  return {
    id,
    title: name,
    subtitle: [formatInstructionSource(source), ownerId ? `来源 ${ownerId}` : '', typeof priority === 'number' ? `优先级 ${priority}` : '']
      .filter(Boolean)
      .join(' · '),
    note: buildInstructionDiagnosticNote(activation, overriddenById, active, skipReason),
    reference,
    trailing: active ? '已生效' : formatInstructionSkipReason(skipReason),
    tone: toneFromInstructionDiagnostic(active, skipReason),
  };
}

function buildInstructionDiagnosticNote(
  activation: Record<string, unknown> | undefined,
  overriddenById: string | undefined,
  active: boolean,
  skipReason: string | undefined,
): string | undefined {
  const notes: string[] = [];
  const explanation = describeInstructionDiagnostic(active, skipReason, overriddenById);
  if (explanation) {
    notes.push(explanation);
  }
  const activationSummary = summarizeInstructionActivation(activation);
  if (activationSummary) {
    notes.push(`条件: ${activationSummary}`);
  }
  return notes.length > 0 ? notes.join('\n') : undefined;
}

function formatInstructionDiagnosticTitle(diagnostic: Record<string, unknown>, fallbackId: string): string {
  const displayPath = asString(diagnostic['displayPath']);
  if (displayPath) {
    return `指令文件 ${displayPath}`;
  }

  const referenceLabel = formatInstructionReferenceLabel(asString(diagnostic['reference']));
  if (referenceLabel) {
    return `指令文件 ${referenceLabel}`;
  }

  const rawName = asString(diagnostic['name']);
  if (rawName) {
    return `指令文件 ${rawName}`;
  }

  const logicalName = asString(diagnostic['logicalName']);
  return logicalName ? `指令文件 ${logicalName}` : `指令文件 ${fallbackId}`;
}

function formatInstructionReferenceLabel(reference: string | undefined): string | undefined {
  if (!reference) {
    return undefined;
  }

  const normalized = reference.replace(/\\/g, '/').trim();
  if (!normalized) {
    return undefined;
  }

  const segments = normalized.split('/').filter(Boolean);
  const fileName = segments.at(-1);
  if (!fileName) {
    return undefined;
  }

  const parent = segments.at(-2);
  return parent === '.aily' ? `${parent}/${fileName}` : fileName;
}

function describeInstructionDiagnostic(
  active: boolean,
  skipReason: string | undefined,
  overriddenById: string | undefined,
): string | undefined {
  if (active) {
    return '当前规则优先级最高，已注入最终 prompt。';
  }

  switch (skipReason) {
    case 'inactive':
      return '当前规则存在激活条件，但未命中当前运行上下文，因此未注入最终 prompt。';
    case 'overridden':
      return overriddenById
        ? `同名规则已被更高优先级条目 ${overriddenById} 覆盖。`
        : '同名规则已被更高优先级条目覆盖。';
    case 'empty':
      return '文件为空，或去除 frontmatter 后没有可注入内容。';
    case 'not_found':
      return '扫描候选路径后未找到该指令文件。';
    default:
      return undefined;
  }
}

function summarizeInstructionActivation(activation: Record<string, unknown> | undefined): string | undefined {
  if (!activation) {
    return undefined;
  }

  const enabled = typeof activation['enabled'] === 'boolean' ? activation['enabled'] : undefined;
  const applyTo = stringifyStringArray(activation['applyTo']);
  const hostIds = stringifyStringArray(activation['hostIds']);
  const modelFamilies = stringifyStringArray(activation['modelFamilies']);
  const requiredCapabilities = stringifyStringArray(activation['requiredCapabilities']);
  const summary = [
    typeof enabled === 'boolean' ? `enabled=${enabled}` : '',
    applyTo ? `applyTo=${applyTo}` : '',
    hostIds ? `hosts=${hostIds}` : '',
    modelFamilies ? `models=${modelFamilies}` : '',
    requiredCapabilities ? `capabilities=${requiredCapabilities}` : '',
  ].filter(Boolean).join(' · ');

  return summary || undefined;
}

function stringifyStringArray(value: unknown): string | undefined {
  const items = asArray(value)
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim());
  return items.length > 0 ? items.join(', ') : undefined;
}

function formatInstructionSource(source?: string): string {
  const map: Record<string, string> = {
    user: '用户',
    project: '项目',
    repo: '仓库',
    host: '宿主',
    plugin: '插件',
  };
  return map[source || ''] || source || '指令';
}

function formatInstructionSkipReason(reason?: string): string {
  const map: Record<string, string> = {
    inactive: '条件未命中',
    overridden: '已被覆盖',
    empty: '空文件',
    not_found: '未发现',
  };
  return map[reason || ''] || reason || '已跳过';
}

function toneFromInstructionDiagnostic(active: boolean, skipReason?: string): StateTone {
  if (active) {
    return 'success';
  }

  switch (skipReason) {
    case 'inactive':
    case 'empty':
      return 'warn';
    case 'overridden':
      return 'info';
    case 'not_found':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function isSubagentMetadata(toolSpecificData: Record<string, unknown> | undefined): boolean {
  return asString(toolSpecificData?.['kind']) === 'subagent'
    || !!asString(toolSpecificData?.['agentName'])
    || !!asString(toolSpecificData?.['description']);
}

export function buildSubagentSubtitle(description: string, childItems: Record<string, unknown>[], result: string): string {
  if (description) {
    return truncateSingleLine(description, 72);
  }

  for (let index = childItems.length - 1; index >= 0; index -= 1) {
    const item = childItems[index];
    const kind = asString(item['kind']);
    if (kind === 'tool' && asString(item['state']) === 'doing') {
      return [asString(item['toolName']), asString(item['argsSummary'])]
        .filter((value): value is string => !!value)
        .join(' · ');
    }
  }

  for (let index = childItems.length - 1; index >= 0; index -= 1) {
    const item = childItems[index];
    const kind = asString(item['kind']);
    if (kind === 'text' || kind === 'thinking') {
      const content = asString(item['content']);
      if (content) {
        return truncateSingleLine(content, 72);
      }
    }
  }

  if (result) {
    return truncateSingleLine(result, 72);
  }

  return '';
}

export function findSubagentResultText(timeline: Record<string, unknown>[]): string | undefined {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const recordId = asString(timeline[index]['recordId']);
    if (recordId.startsWith('child:')) {
      continue;
    }

    const resultText = asString(timeline[index]['resultText']);
    if (resultText) {
      return resultText;
    }
  }
  return undefined;
}

export function toneFromSubagentToolState(state: string | undefined): StateTone {
  if (state === 'error') {
    return 'error';
  }
  if (state === 'done') {
    return 'success';
  }
  if (state === 'doing') {
    return 'info';
  }
  return 'neutral';
}

export function formatSubagentToolTrailing(state: string | undefined, duration: number | undefined): string | undefined {
  if (state === 'done' && typeof duration === 'number') {
    return `${duration >= 10 ? duration.toFixed(0) : duration.toFixed(1)}s`;
  }

  const map: Record<string, string> = {
    doing: '运行中',
    done: '完成',
    error: '失败',
  };
  return map[state || ''] || undefined;
}

export function formatSubagentState(state: string | undefined): string {
  const map: Record<string, string> = {
    doing: '运行中',
    done: '已完成',
    error: '失败',
    warn: '警告',
    info: '信息',
  };
  return map[state || ''] || '子代理';
}

export function toneFromSubagentState(state: string | undefined, phase?: string): StateTone {
  if (state === 'error') {
    return 'error';
  }
  if (state === 'done') {
    return 'success';
  }
  if (state === 'doing') {
    return 'info';
  }
  return toneFromNarrativePhase(phase);
}

function truncateSingleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatBackgroundTaskStatus(status?: string): string {
  const map: Record<string, string> = {
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return map[status || ''] || (status || '状态未知');
}

function formatTaskGraphStatus(status?: string): string {
  const map: Record<string, string> = {
    running: '运行中',
    completed: '已完成',
    failed: '失败',
  };
  return map[status || ''] || (status || '状态未知');
}

function formatNarrativePhase(phase?: string): string {
  const map: Record<string, string> = {
    queued: '排队',
    started: '开始',
    progress: '进度',
    completed: '完成',
    failed: '失败',
    cancelled: '取消',
  };
  return map[phase || ''] || (phase || '事件');
}

function formatBackgroundTaskActivityKind(kind?: string): string {
  const map: Record<string, string> = {
    tool_started: '子工具启动',
    tool_progress: '子工具进度',
    tool_completed: '子工具完成',
    tool_failed: '子工具失败',
    subagent_started: '子代理启动',
    subagent_completed: '子代理完成',
    subagent_failed: '子代理失败',
  };
  return map[kind || ''] || '最近活动';
}

function formatAgentTeamRoleStatus(status?: string): string {
  const map: Record<string, string> = {
    idle: '空闲',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
  };
  return map[status || ''] || (status || '状态未知');
}

function formatAgentTeamStatus(status?: string): string {
  const map: Record<string, string> = {
    running: '运行中',
    completed: '已完成',
    failed: '失败',
  };
  return map[status || ''] || (status || '状态未知');
}

function formatAgentTeamTrigger(trigger?: string): string {
  const map: Record<string, string> = {
    team_started: '团队启动',
    node_completed: '节点完成',
    node_failed: '节点失败',
  };
  return map[trigger || ''] || (trigger || '协议消息');
}

function toneFromBackgroundTaskStatus(status?: string): StateTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'warn';
    case 'running':
      return 'info';
    default:
      return 'neutral';
  }
}

function toneFromNarrativePhase(phase?: string): StateTone {
  switch (phase) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'warn';
    case 'started':
    case 'progress':
      return 'info';
    default:
      return 'neutral';
  }
}

function toneFromBackgroundTaskActivityKind(kind?: string): StateTone {
  switch (kind) {
    case 'tool_failed':
    case 'subagent_failed':
      return 'error';
    case 'tool_completed':
    case 'subagent_completed':
      return 'success';
    case 'tool_started':
    case 'tool_progress':
    case 'subagent_started':
      return 'info';
    default:
      return 'neutral';
  }
}

function toneFromAgentTeamRoleStatus(status?: string): StateTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'running':
      return 'info';
    default:
      return 'neutral';
  }
}

function toneFromAgentTeamStatus(status?: string): StateTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'running':
      return 'info';
    default:
      return 'neutral';
  }
}

function formatClock(timestamp?: number): string | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return undefined;
  }

  const date = new Date(timestamp);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatTaskGraphNodeStatus(status?: string): string {
  const map: Record<string, string> = {
    pending: '等待中',
    ready: '就绪',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    blocked: '已阻塞',
  };
  return map[status || ''] || (status || '状态未知');
}

function formatTaskSchedulerPhase(phase?: string): string {
  const map: Record<string, string> = {
    started: '已启动',
    stopped: '已停止',
    triggered: '已触发',
    trigger_failed: '触发失败',
    skipped: '已跳过',
  };
  return map[phase || ''] || (phase || '阶段未知');
}

function formatTaskSchedulerStatus(status?: string): string {
  const map: Record<string, string> = {
    running: '运行中',
    stopped: '已停止',
  };
  return map[status || ''] || (status || '状态未知');
}

function formatTaskAutonomyStatus(status?: string): string {
  const map: Record<string, string> = {
    disabled: '已禁用',
    enabled: '已启用',
    stopped: '已停止',
  };
  return map[status || ''] || (status || '状态未知');
}

function formatTaskAutonomyPhase(phase?: string): string {
  const map: Record<string, string> = {
    enabled: '已启用',
    stopped: '已停止',
    failure_recorded: '记录失败',
    success_recorded: '记录成功',
  };
  return map[phase || ''] || (phase || '事件');
}

function formatTaskAutonomyReason(reason?: string): string {
  const map: Record<string, string> = {
    manual_stop: '手动停止',
    schedule_failure: '调度失败',
    background_task_failure: '后台任务失败',
    graph_failure: '任务图失败',
    max_consecutive_failures: '连续失败超限',
  };
  return map[reason || ''] || reason || '';
}

function formatLaunchKind(kind?: string): string {
  const map: Record<string, string> = {
    graph: '任务图',
    task: '任务',
  };
  return map[kind || ''] || (kind || '');
}

function formatLaunchMode(mode?: string): string {
  const map: Record<string, string> = {
    async: '异步',
    sync: '同步',
  };
  return map[mode || ''] || (mode || '');
}

function formatExecutionMode(mode?: string): string {
  const map: Record<string, string> = {
    async: '异步',
    sync: '同步',
  };
  return map[mode || ''] || '';
}

function toneFromTaskGraphStatus(status?: string): StateTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'running':
      return 'info';
    default:
      return 'neutral';
  }
}

function toneFromTaskGraphNodeStatus(status?: string): StateTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'blocked':
      return 'warn';
    case 'running':
    case 'ready':
    case 'pending':
      return 'info';
    default:
      return 'neutral';
  }
}

function toneFromTaskSchedulerPhase(phase?: string): StateTone {
  switch (phase) {
    case 'trigger_failed':
      return 'error';
    case 'skipped':
      return 'warn';
    case 'triggered':
      return 'info';
    default:
      return 'neutral';
  }
}

function toneFromTaskAutonomyStatus(status?: string): StateTone {
  switch (status) {
    case 'enabled':
      return 'success';
    case 'stopped':
      return 'warn';
    default:
      return 'neutral';
  }
}

function toneFromTaskAutonomyPhase(phase?: string): StateTone {
  switch (phase) {
    case 'failure_recorded':
    case 'stopped':
      return 'warn';
    case 'success_recorded':
    case 'enabled':
      return 'success';
    default:
      return 'neutral';
  }
}

function buildStateDetailOutputGroups(rows: readonly StateDetailRow[]): StateDetailOutputGroup[] {
  if (rows.length === 0) {
    return [];
  }

  const groups: StateDetailOutputGroup[] = [];
  let currentKind: StateDetailOutputGroup['kind'] | null = null;
  let currentRows: StateDetailRow[] = [];

  const pushGroup = (): void => {
    if (!currentKind || currentRows.length === 0) {
      return;
    }
    groups.push({
      id: currentRows[0].id,
      kind: currentKind,
      rows: [...currentRows],
    });
    currentKind = null;
    currentRows = [];
  };

  for (const row of rows) {
    const nextKind = outputGroupKindFromRow(row);
    if (currentKind !== nextKind) {
      pushGroup();
      currentKind = nextKind;
    }
    currentRows.push(row);
  }

  pushGroup();
  return groups;
}

function outputGroupKindFromRow(row: StateDetailRow): StateDetailOutputGroup['kind'] {
  switch (row.outputKind) {
    case 'terminal-command':
    case 'terminal-stream':
      return 'terminal';
    case 'code':
    case 'mermaid':
      return 'code';
    case 'image':
    case 'resource':
    case 'text':
    case 'default':
      return 'data';
    default:
      return 'generic';
  }
}

function descriptorOutputGroups(
  rows: readonly StateDetailRow[],
  outputGroups?: readonly StateDetailOutputGroup[],
): readonly StateDetailOutputGroup[] | undefined {
  if (outputGroups && outputGroups.length > 0) {
    return outputGroups;
  }
  return rows.some((row) => row.outputKind) ? buildStateDetailOutputGroups(rows) : undefined;
}
