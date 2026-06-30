import type { ToolResultContentPart } from '../../../core/tool-result-content';
import { normalizeReadSideToolName } from '../../../core/tool-name-normalizer';
import type { StateDetailRow, StateTone } from './activity-detail-items';

export interface RegisteredToolCallOutputRowsInput {
  toolName?: string;
  entry: Record<string, unknown>;
  index: number;
}

type ToolCallOutputRowProjector = (input: RegisteredToolCallOutputRowsInput) => StateDetailRow[];

const TOOL_CALL_OUTPUT_ROW_PROJECTORS: Record<string, ToolCallOutputRowProjector> = {
  get_board_parameters: ({ entry, index }) => buildBoardParametersOutputRows(entry, index),
  buildProject: ({ entry, index }) => buildProjectOutputRows(entry, index),
};

export function projectRegisteredToolCallOutputRows(input: RegisteredToolCallOutputRowsInput): StateDetailRow[] {
  const toolName = normalizeReadSideToolName(input.toolName);
  if (!toolName) {
    return [];
  }

  const projector = TOOL_CALL_OUTPUT_ROW_PROJECTORS[toolName];
  return projector ? projector(input) : [];
}

function buildBoardParametersOutputRows(
  entry: Record<string, unknown>,
  index: number,
): StateDetailRow[] {
  const resultText = asString(entry['resultText']);
  const resultContent = asToolResultContentArray(entry['resultContent']);
  const contentText = resultContent.length === 1
    ? getToolResultContentText(resultContent[0])
    : undefined;
  const rawText = resultText || contentText || '';
  if (!rawText.trim()) {
    return [];
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(rawText);
    parsed = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return [];
  }

  const boardName = asString(parsed['boardName']) || asString(parsed['boardId']) || 'Board';
  const parameters = asRecord(parsed['parameters']);
  const parameterCount = parameters ? Object.keys(parameters).length : 0;
  if (!parameters && !boardName) {
    return [];
  }

  const recordId = asString(entry['recordId']) || `tool-row-${index}`;
  const phase = asString(entry['phase']);
  const timestamp = asNumber(entry['timestamp']);
  const boardDisplayName = asString(parameters?.['name']) || boardName;
  const core = asString(parameters?.['core']);
  const fqbn = asString(parameters?.['fqbn']);
  const boardType = asString(parameters?.['type']);
  const builtinLed = asString(parameters?.['builtinLed']);
  const preview = [
    core ? `core=${core}` : undefined,
    fqbn ? `fqbn=${fqbn}` : undefined,
    boardType ? `type=${boardType}` : undefined,
    builtinLed ? `builtinLed=${builtinLed}` : undefined,
  ].filter(Boolean).join(', ');

  return [{
    id: `${recordId}:board-parameters`,
    title: `Board parameters - ${boardDisplayName}`,
    subtitle: [
      parameterCount > 0 ? `${parameterCount} parameter${parameterCount === 1 ? '' : 's'}` : undefined,
      formatClock(timestamp),
      recordId,
    ].filter(Boolean).join(' - ') || undefined,
    note: preview || undefined,
    trailing: phase ? formatNarrativePhase(phase) : undefined,
    tone: toneFromNarrativePhase(phase),
  }];
}

function buildProjectOutputRows(
  entry: Record<string, unknown>,
  index: number,
): StateDetailRow[] {
  const rawText = getEntryResultText(entry);
  if (!rawText.trim()) {
    return [];
  }

  const parsed = parseJsonRecord(rawText);
  const success = asBoolean(parsed?.['success']);
  const output = asString(parsed?.['output']) || asString(parsed?.['message']) || rawText;
  const durationMs = asNumber(parsed?.['duration']) ?? asNumber(parsed?.['durationMs']);
  const recordId = asString(entry['recordId']) || `tool-row-${index}`;
  const phase = asString(entry['phase']);
  const timestamp = asNumber(entry['timestamp']);
  const title = success === false
    ? 'Build failed'
    : success === true
      ? 'Build completed'
      : 'Build result';

  return [{
    id: `${recordId}:build-project`,
    title,
    subtitle: [
      durationMs !== undefined ? formatDuration(durationMs) : undefined,
      formatClock(timestamp),
      recordId,
    ].filter(Boolean).join(' - ') || undefined,
    note: output,
    trailing: phase ? formatNarrativePhase(phase) : undefined,
    tone: success === false ? 'error' : success === true ? 'success' : toneFromNarrativePhase(phase),
  }];
}

function getEntryResultText(entry: Record<string, unknown>): string {
  const resultText = asString(entry['resultText']);
  if (resultText) {
    return resultText;
  }

  const resultContent = asToolResultContentArray(entry['resultContent']);
  return resultContent.length === 1
    ? getToolResultContentText(resultContent[0]) || ''
    : '';
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asToolResultContentArray(value: unknown): ToolResultContentPart[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(item => item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string')
    .map(item => item as ToolResultContentPart);
}

function getToolResultContentText(part: ToolResultContentPart): string | undefined {
  if (typeof part.text === 'string') {
    return part.text;
  }
  if (typeof part['content'] === 'string') {
    return part['content'];
  }
  return undefined;
}

function formatClock(timestamp: number | undefined): string | undefined {
  if (typeof timestamp !== 'number') {
    return undefined;
  }
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return undefined;
  }
}

function formatDuration(value: number): string {
  const seconds = value > 100 ? value / 1000 : value;
  return `${seconds.toFixed(seconds >= 10 ? 0 : 2)}s`;
}

function formatNarrativePhase(phase: string | undefined): string | undefined {
  switch (phase) {
    case 'started':
      return 'Started';
    case 'progress':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return phase;
  }
}

function toneFromNarrativePhase(phase: string | undefined): StateTone {
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
