import {
  isTerminalCommandToolName,
  normalizeReadSideToolName,
} from './tool-name-normalizer';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseRecordString(value: unknown): Record<string, unknown> | undefined {
  const text = readString(value);
  if (!text) {
    return undefined;
  }

  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function firstStringField(record: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = readString(record[field]);
    if (value) {
      return value;
    }
  }
  return '';
}

function readNestedCommand(record: Record<string, unknown>): string {
  for (const field of ['input', 'args', 'arguments']) {
    const nestedRecord = asRecord(record[field]) ?? parseRecordString(record[field]);
    if (!nestedRecord) {
      continue;
    }

    const command = readToolApprovalCommand('command_exec', nestedRecord);
    if (command) {
      return command;
    }
  }

  return '';
}

function readCommandFromMessage(message: unknown): string {
  const text = readString(message);
  if (!text) {
    return '';
  }

  const lines = text.split(/\r?\n/).map(line => line.trim());
  const markerIndex = lines.findIndex(line => (
    /terminal command/i.test(line)
    || /run command/i.test(line)
    || /execute command/i.test(line)
    || /运行终端命令/.test(line)
    || /命令/.test(line)
  ));
  const candidate = markerIndex >= 0
    ? lines.slice(markerIndex + 1).find(line => line && !/^\(.+\)$/.test(line))
    : undefined;
  const normalized = readString(candidate);
  return normalized && !/unknown command/i.test(normalized) && !/未知命令/.test(normalized)
    ? normalized
    : '';
}

export function readToolApprovalCommand(
  toolName: string | undefined,
  args: unknown,
  message?: unknown,
): string {
  const normalizedToolName = normalizeReadSideToolName(toolName);
  const record = asRecord(args) ?? parseRecordString(args);
  if (record) {
    const command = firstStringField(record, ['command', 'cmd', 'commandLine', 'shellCommand', 'script']);
    if (command) {
      return command;
    }

    const nestedCommand = readNestedCommand(record);
    if (nestedCommand) {
      return nestedCommand;
    }

    if (normalizedToolName === 'send_to_terminal' || normalizedToolName === 'command_write_stdin') {
      const input = readString(record['input']);
      if (input) {
        return input;
      }
    }
  }

  if (isTerminalCommandToolName(normalizedToolName) && typeof args === 'string') {
    const command = readString(args);
    if (command && !command.startsWith('{')) {
      return command;
    }
  }

  return readCommandFromMessage(message);
}

export function normalizeToolApprovalArgs(
  toolName: string | undefined,
  args: unknown,
  message?: unknown,
): Record<string, unknown> {
  const record = asRecord(args) ?? parseRecordString(args) ?? {};
  const command = readToolApprovalCommand(toolName, record, message)
    || readToolApprovalCommand(toolName, args, message);
  if (!command || typeof record['command'] === 'string') {
    return record;
  }

  return {
    ...record,
    command,
  };
}
