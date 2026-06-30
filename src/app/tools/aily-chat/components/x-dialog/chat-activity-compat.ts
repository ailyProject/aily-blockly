import { mkState, mkThinking, mkToolCall, type ChatPart, type StatePart, type ToolCallPart } from '../../core/chat-parts';

export function buildCompatActivityParts(parsed: unknown, kind: 'aily-state' | 'aily-think'): readonly ChatPart[] {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  const record = parsed as Record<string, unknown>;

  if (kind === 'aily-think') {
    const content = typeof record['content'] === 'string' ? record['content'] : '';
    const isComplete = record['isComplete'] !== false;
    return content ? [mkThinking(content, isComplete)] : [];
  }

  const id = typeof record['id'] === 'string' && record['id'] ? record['id'] : 'compat-state';
  const text = typeof record['text'] === 'string' && record['text'] ? record['text'] : '任务';
  const stateKind = typeof record['kind'] === 'string' ? record['kind'] : undefined;
  const progress = typeof record['progress'] === 'number' ? record['progress'] : undefined;
  const metadata = record['metadata'] && typeof record['metadata'] === 'object'
    ? record['metadata'] as Record<string, unknown>
    : null;

  if (stateKind === 'tool_call') {
    const toolName = typeof record['toolName'] === 'string' && record['toolName']
      ? record['toolName']
      : (typeof metadata?.['toolName'] === 'string' ? metadata['toolName'] as string : 'tool');
    return [mkToolCall(id, toolName, text, toToolCallState(record['state']), undefined, metadata || undefined)];
  }

  return [mkState(id, text, toStateTone(record['state']), stateKind as StatePart['kind'], progress, metadata || undefined)];
}

function toToolCallState(value: unknown): ToolCallPart['state'] {
  switch (value) {
    case 'done':
    case 'warn':
    case 'error':
    case 'pending_approval':
      return value;
    default:
      return 'doing';
  }
}

function toStateTone(value: unknown): StatePart['state'] {
  switch (value) {
    case 'done':
    case 'warn':
    case 'error':
    case 'info':
      return value;
    default:
      return 'doing';
  }
}