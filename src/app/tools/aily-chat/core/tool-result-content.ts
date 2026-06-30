import { parseTerminalPayload } from './terminal-payload';

export interface ToolResultContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export function normalizeToolResultContent(result: unknown): ToolResultContentPart[] | undefined {
  const content = asResultContent(result);
  if (content === undefined) {
    return undefined;
  }

  if (typeof content === 'string') {
    return normalizeToolResultText(content);
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  if (content.length === 1) {
    const onlyPart = normalizeToolResultContentPart(content[0]);
    const onlyTextValue = onlyPart ? getToolResultPartText(onlyPart) : undefined;
    if (onlyTextValue && onlyPart?.type === 'output_text') {
      return normalizeToolResultText(onlyTextValue);
    }
  }

  const parts = content
    .map(item => normalizeToolResultContentPart(item))
    .filter((item): item is ToolResultContentPart => !!item);

  return parts.length > 0 ? parts : undefined;
}

export function collectToolResultText(result: unknown): string {
  const parts = normalizeToolResultContent(result);
  if (!parts?.length) {
    return '';
  }

  return parts
    .map(part => getToolResultPartText(part))
    .filter((text): text is string => !!text)
    .join('\n');
}

export function extractRawToolResultPayloadText(result: unknown): string {
  const content = asResultContent(result);
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') {
          return item;
        }
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return '';
        }
        const record = item as Record<string, unknown>;
        return typeof record['text'] === 'string' ? record['text'] : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function buildToolResultMetadataPatch(input: {
  toolCallId: string;
  toolName?: string;
  state: 'doing' | 'done' | 'error' | 'pending_approval';
  resultText?: string;
  result?: unknown;
  timestamp?: number;
  durationMs?: number;
}): Record<string, unknown> {
  const phase = input.state === 'error'
    ? 'failed'
    : input.state === 'doing'
      ? 'progress'
      : input.state === 'pending_approval'
        ? 'started'
        : 'completed';
  const resultContent = normalizeToolResultContent(input.result);
  const resultMetadata = sanitizeToolResultMetadata(asResultMetadata(input.result));

  return {
    ...resultMetadata,
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(typeof input.durationMs === 'number' ? { duration: input.durationMs / 1000 } : {}),
    phase,
    timeline: [{
      recordId: `${input.toolCallId}:${phase}`,
      phase,
      ...(input.resultText ? { resultText: input.resultText } : {}),
      ...(resultContent?.length ? { resultContent } : {}),
      ...(typeof input.timestamp === 'number' ? { timestamp: input.timestamp } : {}),
      ...(typeof input.durationMs === 'number' ? { duration: input.durationMs / 1000 } : {}),
    }],
  };
}

function asResultContent(result: unknown): unknown {
  if (!result || typeof result !== 'object') {
    return undefined;
  }
  return (result as { content?: unknown }).content;
}

function asResultMetadata(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return undefined;
  }
  const metadata = (result as { metadata?: unknown }).metadata;
  return asMetadataRecord(metadata);
}

function sanitizeToolResultMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) {
    return {};
  }

  const {
    toolName: _toolName,
    duration: _duration,
    phase: _phase,
    timeline: _timeline,
    ...rest
  } = metadata;

  return rest;
}

function asMetadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeToolResultContentPart(item: unknown): ToolResultContentPart | null {
  if (typeof item === 'string') {
    return { type: 'output_text', text: item };
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return null;
  }

  const record = item as Record<string, unknown>;
  const type = typeof record['type'] === 'string'
    ? record['type']
    : typeof record['text'] === 'string'
      ? 'text'
      : undefined;

  if (!type) {
    return null;
  }

  if (type === 'text') {
    return {
      ...record,
      type: 'output_text',
      ...(typeof record['text'] === 'string' ? { text: record['text'] } : {}),
    };
  }

  if (type === 'image' || type === 'output_image') {
    return normalizeImageToolResultContentPart(record);
  }

  if (type === 'resource' || type === 'resource_link' || type === 'file' || type === 'output_resource') {
    return normalizeResourceToolResultContentPart(record, type);
  }

  return {
    ...record,
    type,
    ...(typeof record['text'] === 'string' ? { text: record['text'] } : {}),
  };
}

function normalizeToolResultText(text: string): ToolResultContentPart[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const terminal = parseTerminalPayload(trimmed);
  if (terminal) {
    return buildTerminalToolResultContent(terminal);
  }

  return [{ type: 'output_text', text: trimmed }];
}

function buildTerminalToolResultContent(terminal: NonNullable<ReturnType<typeof parseTerminalPayload>>): ToolResultContentPart[] {
  const parts: ToolResultContentPart[] = [{
    type: 'terminal_command',
    text: terminal.command,
    terminalId: terminal.terminalId,
    processId: terminal.processId,
    outputSessionId: terminal.outputSessionId,
    outputFilePath: terminal.outputFilePath,
    cwd: terminal.cwd,
    exitCode: terminal.exitCode,
    isRunning: terminal.isRunning,
    status: terminal.status,
    bytesTotal: terminal.bytesTotal,
    lastOutputAt: terminal.lastOutputAt,
  }];

  if (terminal.output) {
    parts.push({
      type: 'terminal_stdout',
      text: terminal.output,
    });
  }

  if (terminal.stderr && terminal.stderr.trim()) {
    parts.push({
      type: 'terminal_stderr',
      text: terminal.stderr.trim(),
      exitCode: terminal.exitCode,
    });
  }

  return parts;
}

function getToolResultPartText(part: ToolResultContentPart): string | undefined {
  if (typeof part.text === 'string' && part.text.trim().length > 0) {
    return part.text;
  }
  const value = part['value'];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function normalizeImageToolResultContentPart(record: Record<string, unknown>): ToolResultContentPart {
  const source = asRecord(record['source']);
  const mimeType = firstString(record['mimeType'], source?.['media_type'], source?.['mimeType']);
  const data = firstString(record['data'], source?.['data']);
  const uri = firstString(record['uri'], record['url']);
  const text = firstString(record['text'], record['alt'], record['description']);

  return {
    ...record,
    type: 'output_image',
    ...(text ? { text } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(data ? { data } : {}),
    ...(uri ? { uri } : {}),
  };
}

function normalizeResourceToolResultContentPart(record: Record<string, unknown>, originalType: string): ToolResultContentPart {
  const resource = asRecord(record['resource']);
  const uri = firstString(record['uri'], record['url'], resource?.['uri']);
  const mimeType = firstString(record['mimeType'], resource?.['mimeType']);
  const text = firstString(record['text'], resource?.['text']);
  const description = firstString(record['description']);
  const data = firstString(record['data'], record['blob'], resource?.['blob']);
  const name = firstString(record['name'], record['title']);

  if (mimeType?.startsWith('image/') && data) {
    return {
      ...record,
      type: 'output_image',
      ...(text || description ? { text: text || description } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(data ? { data } : {}),
      ...(uri ? { uri } : {}),
      ...(name ? { name } : {}),
      originalType,
    };
  }

  return {
    ...record,
    type: 'output_resource',
    ...(text ? { text } : {}),
    ...(description ? { description } : {}),
    ...(uri ? { uri } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(data ? { data } : {}),
    ...(name ? { name } : {}),
    originalType,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
