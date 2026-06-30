export interface ParsedTerminalPayload {
  command: string;
  output: string;
  stderr: string;
  exitCode?: number;
  isRunning: boolean;
  toolCallId?: string;
  terminalId?: string;
  processId?: string;
  outputSessionId?: string;
  outputFilePath?: string;
  cwd?: string;
  status?: string;
  bytesTotal?: number;
  lastOutputAt?: string;
}

const EMPTY_STDOUT_MARKER = '(terminal stdout completed with no output)';
const EMPTY_STDERR_MARKER = '(terminal stderr completed with no output)';

export function parseTerminalPayload(text: string): ParsedTerminalPayload | null {
  try {
    const data = JSON.parse(text);
    if (!isTerminalPayloadRecord(data)) {
      return null;
    }
    const status = asString(data['status']);
    return {
      command: asString(data['command']) || '',
      output: cleanTerminalStream(asString(data['output']) ?? asString(data['stdout']) ?? '', EMPTY_STDOUT_MARKER),
      stderr: cleanTerminalStream(asString(data['stderr']) ?? '', EMPTY_STDERR_MARKER),
      exitCode: asNumber(data['exit_code']) ?? asNumber(data['exitCode']),
      isRunning: status === 'running',
      toolCallId: asString(data['toolCallId']),
      terminalId: asString(data['terminalId']),
      processId: asString(data['processId']) || asString(data['id']),
      outputSessionId: asString(data['outputSessionId']),
      outputFilePath: asString(data['outputFilePath']),
      cwd: asString(data['cwd']),
      status,
      bytesTotal: asNumber(data['bytesTotal']),
      lastOutputAt: asString(data['lastOutputAt']),
    };
  } catch {
    const lines = text.split(/\r?\n/);
    const headers = new Map<string, string>();
    const stdout: string[] = [];
    const stderr: string[] = [];
    let section: 'headers' | 'stdout' | 'stderr' = 'headers';

    for (const line of lines) {
      if (line === 'stdout:') {
        section = 'stdout';
        continue;
      }
      if (line === 'stderr:') {
        section = 'stderr';
        continue;
      }
      if (section === 'headers') {
        const match = line.match(/^([A-Za-z]+):\s*(.*)$/);
        if (match) {
          headers.set(match[1].toLowerCase(), match[2]);
        }
        continue;
      }
      if (section === 'stdout') {
        stdout.push(line);
        continue;
      }
      stderr.push(line);
    }

    const command = headers.get('command') || '';
    const exitCodeRaw = headers.get('exitcode');
    const exitCode = exitCodeRaw != null && exitCodeRaw !== '' ? Number(exitCodeRaw) : undefined;
    const bytesTotal = asNumber(headers.get('bytestotal'));
    const status = headers.get('status');

    if (!command && stdout.length === 0 && stderr.length === 0) {
      return null;
    }

    return {
      command,
      output: cleanTerminalStream(stdout.join('\n').trim(), EMPTY_STDOUT_MARKER),
      stderr: cleanTerminalStream(stderr.join('\n').trim(), EMPTY_STDERR_MARKER),
      exitCode: Number.isNaN(exitCode as number) ? undefined : exitCode,
      isRunning: status === 'running',
      toolCallId: headers.get('toolcallid'),
      terminalId: headers.get('terminalid'),
      processId: headers.get('processid'),
      outputSessionId: headers.get('outputsessionid'),
      outputFilePath: headers.get('outputfilepath'),
      cwd: headers.get('cwd'),
      status,
      bytesTotal,
      lastOutputAt: headers.get('lastoutputat'),
    };
  }
}

function isTerminalPayloadRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const hasCommand = hasOwn(record, 'command') && asString(record['command']) !== undefined;
  const hasTerminalIdentity = hasOwn(record, 'terminalId')
    || hasOwn(record, 'processId')
    || hasOwn(record, 'outputSessionId')
    || hasOwn(record, 'outputFilePath');
  const hasTerminalStream = hasOwn(record, 'stdout') || hasOwn(record, 'stderr');
  const hasTerminalOutputMetadata = hasOwn(record, 'bytesTotal') || hasOwn(record, 'lastOutputAt');

  return hasCommand
    || hasTerminalIdentity
    || hasTerminalStream
    || (hasTerminalOutputMetadata && (hasCommand || hasTerminalIdentity || hasTerminalStream));
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function cleanTerminalStream(value: string, emptyMarker: string): string {
  if (!value) {
    return '';
  }

  const trimmed = value.trim();
  if (trimmed === emptyMarker) {
    return '';
  }

  if (value.startsWith(emptyMarker)) {
    return value.slice(emptyMarker.length).replace(/^\r?\n+/, '');
  }

  return value;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
