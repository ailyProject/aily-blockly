import type { ChatRuntimeHostSessionProcessSummary } from '../core/chat-runtime-host-contract';
import { getChildToolConfig } from '../../../configs/tool.config';
import {
  resolveProcessLogSubappNameFromCwd,
  resolveProcessLogSubappNameFromOutputFilePath,
} from '../../../utils/project-log.utils';

export interface ChildToolSessionListItem {
  readonly toolId: string;
  readonly streamId: string;
  readonly hostInfo?: {
    readonly pid?: number;
  } | null;
  readonly refCount?: number;
  readonly running?: boolean;
  readonly pid?: number;
  readonly command?: string;
  readonly cwd?: string;
  readonly durationMs?: number;
}

const CHILD_TOOL_PROCESS_ID_PREFIX = 'child-tool:';

function normalizeChildToolIdCandidate(value: string | undefined): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return '';
  }
  return getChildToolConfig(normalized)?.id || '';
}

export function resolveChildToolIdFromCommand(command: string | undefined): string {
  const normalizedCommand = typeof command === 'string' ? command.trim() : '';
  if (!normalizedCommand) {
    return '';
  }

  const patterns = [
    /child\/tools\/([^/\s'"\\]+)\/index\.js/i,
    /child\/tools\/([^/\s'"\\]+)(?:\s|&&|;|$)/i,
    /cd\s+.+?child\/tools\/([^/\s'"\\]+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = normalizedCommand.match(pattern);
    const toolId = normalizeChildToolIdCandidate(match?.[1]);
    if (toolId) {
      return toolId;
    }
  }

  return '';
}

function tokenizeCommand(command: string | undefined): string[] {
  const normalizedCommand = typeof command === 'string' ? command.trim() : '';
  if (!normalizedCommand) {
    return [];
  }

  return normalizedCommand
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean);
}

export function isChildToolServeCommand(command: string | undefined): boolean {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    return false;
  }

  return tokens.includes('serve')
    || (tokens.includes('npm') && tokens.includes('serve'))
    || (tokens.includes('npm') && tokens.includes('start'));
}

function isGenericChildToolCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return normalized === 'node'
    || normalized === 'npm'
    || normalized === 'npm run start'
    || normalized === 'npm start'
    || normalized === 'child tool';
}

function resolveChildToolProcessCommand(toolId: string, command: string | undefined): string {
  const normalizedCommand = typeof command === 'string' ? command.trim() : '';
  if (normalizedCommand && !isGenericChildToolCommand(normalizedCommand)) {
    return normalizedCommand;
  }

  const config = getChildToolConfig(toolId);
  if (config?.id) {
    return config.id;
  }

  return toolId;
}

export function buildChildToolProcessSummaries(
  sessions: readonly ChildToolSessionListItem[] | null | undefined,
  options: {
    readonly sessionId?: string;
    readonly projectPath?: string;
  } = {},
): readonly ChatRuntimeHostSessionProcessSummary[] {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return [];
  }

  const now = Date.now();
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  const projectPath = typeof options.projectPath === 'string' ? options.projectPath.trim() : '';

  const summaries: ChatRuntimeHostSessionProcessSummary[] = [];

  for (const session of sessions) {
      const toolId = typeof session?.toolId === 'string' ? session.toolId.trim() : '';
      if (!toolId) {
        continue;
      }

      const durationMs = typeof session.durationMs === 'number' && Number.isFinite(session.durationMs)
        ? Math.max(0, session.durationMs)
        : 0;
      const running = session.running === true;
      const startedAt = Math.max(0, now - durationMs);
      const cwd = typeof session.cwd === 'string' && session.cwd.trim()
        ? session.cwd.trim()
        : projectPath;
      const command = resolveChildToolProcessCommand(toolId, session.command);

      summaries.push({
        processId: `${CHILD_TOOL_PROCESS_ID_PREFIX}${toolId}`,
        sessionId,
        outputSessionId: '',
        command,
        cwd,
        status: running ? 'running' : 'completed',
        running,
        background: running,
        ...(typeof session.pid === 'number'
          ? { pid: session.pid }
          : typeof session.hostInfo?.pid === 'number'
            ? { pid: session.hostInfo.pid }
            : {}),
        startedAt,
        ...(running ? { lastOutputAt: now } : { completedAt: now, exitCode: 0 }),
        elapsedMs: durationMs,
        bytesTotal: 0,
        subappName: toolId,
      } satisfies ChatRuntimeHostSessionProcessSummary);
  }

  return summaries.sort((left, right) => right.startedAt - left.startedAt);
}

export function isChildToolProcessSummary(process: Partial<Pick<ChatRuntimeHostSessionProcessSummary, 'processId'>> | null | undefined): boolean {
  return typeof process?.processId === 'string' && process.processId.startsWith(CHILD_TOOL_PROCESS_ID_PREFIX);
}

export function readChildToolIdFromProcessSummary(process: Partial<Pick<ChatRuntimeHostSessionProcessSummary, 'processId'>> | null | undefined): string {
  if (!isChildToolProcessSummary(process)) {
    return '';
  }
  return process.processId.slice(CHILD_TOOL_PROCESS_ID_PREFIX.length).trim();
}

export function resolveChildToolIdFromProcess(
  process: Partial<Pick<ChatRuntimeHostSessionProcessSummary, 'processId' | 'subappName' | 'command' | 'cwd' | 'outputFilePath'>> | null | undefined,
): string {
  if (!process) {
    return '';
  }

  const directProcessId = readChildToolIdFromProcessSummary(process);
  if (directProcessId) {
    return directProcessId;
  }

  const fromSubappName = normalizeChildToolIdCandidate(process.subappName);
  if (fromSubappName) {
    return fromSubappName;
  }

  const fromOutputFilePath = normalizeChildToolIdCandidate(
    resolveProcessLogSubappNameFromOutputFilePath(process.outputFilePath),
  );
  if (fromOutputFilePath) {
    return fromOutputFilePath;
  }

  const fromCwd = normalizeChildToolIdCandidate(
    resolveProcessLogSubappNameFromCwd(process.cwd),
  );
  if (fromCwd) {
    return fromCwd;
  }

  return resolveChildToolIdFromCommand(process.command);
}

export function resolveChildToolProcessDisplayName(
  process: Partial<Pick<ChatRuntimeHostSessionProcessSummary, 'processId' | 'subappName' | 'command' | 'cwd' | 'outputFilePath'>> | null | undefined,
): string {
  const toolId = resolveChildToolIdFromProcess(process);
  if (toolId) {
    return toolId;
  }

  return typeof process?.command === 'string' ? process.command.trim() : '';
}

export function collapseActiveChildToolServeProcesses(
  processes: readonly ChatRuntimeHostSessionProcessSummary[],
): readonly ChatRuntimeHostSessionProcessSummary[] {
  if (!Array.isArray(processes) || processes.length === 0) {
    return [];
  }

  const activeChildToolIds = new Set(
    processes
      .filter(process => isChildToolProcessSummary(process) && process.running)
      .map(process => readChildToolIdFromProcessSummary(process))
      .filter(Boolean),
  );

  if (activeChildToolIds.size === 0) {
    return processes;
  }

  return processes.filter(process => {
    if (isChildToolProcessSummary(process)) {
      return true;
    }

    const toolId = resolveChildToolIdFromProcess(process);
    if (!toolId || !activeChildToolIds.has(toolId)) {
      return true;
    }

    if (!isChildToolServeCommand(process.command)) {
      return true;
    }

    return process.background !== true;
  });
}
