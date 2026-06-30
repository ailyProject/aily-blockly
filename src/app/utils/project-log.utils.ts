export type ProjectLogLevel = 'INFO' | 'DEBUG' | 'ERROR';
export const DEFAULT_PROCESS_LOG_SUBAPP = 'default';

export function appendProjectLog(
  projectPath: string | undefined,
  source: string,
  level: ProjectLogLevel,
  message: string,
  at = new Date(),
): string | null {
  const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  const normalizedMessage = normalizeLogMessage(message);
  if (!normalizedMessage || !(window as any)?.path || !(window as any)?.fs) {
    return null;
  }

  const pathApi = (window as any).path;
  const fsApi = (window as any).fs;
  const projectLogRoot = resolveProjectLogRootDir(normalizedProjectPath, pathApi);
  if (!projectLogRoot) {
    return null;
  }
  const sourceId = normalizeLogSource(source);
  const daySegment = formatDateSegment(at);
  const minuteSegment = formatMinuteSegment(at);
  const dirPath = pathApi.join(projectLogRoot, sourceId, daySegment);
  const filePath = pathApi.join(dirPath, `${minuteSegment}.log`);

  if (!fsApi.existsSync(dirPath)) {
    fsApi.mkdirSync(dirPath, { recursive: true });
  }

  const lines = normalizedMessage
    .split(/\r?\n/)
    .map((line: string) => normalizeLogLine(line, level))
    .filter((line): line is { level: ProjectLogLevel; message: string } => !!line)
    .map((line) => `[${formatTimestamp(at)}] [${line.level}] [${sourceId}] ${line.message}`);
  if (lines.length === 0) {
    return filePath;
  }

  fsApi.appendFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

export function resolveProcessLogStoragePaths(
  projectPath: string | undefined,
  processId: string,
  at = new Date(),
  _subapp = DEFAULT_PROCESS_LOG_SUBAPP,
): { outputFilePath: string; metadataFilePath: string } | null {
  const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!normalizedProjectPath || !(window as any)?.path || !(window as any)?.fs) {
    return null;
  }

  const pathApi = (window as any).path;
  const fsApi = (window as any).fs;
  const processRootDir = resolveProcessLogProjectDir(normalizedProjectPath);
  if (!processRootDir) {
    return null;
  }
  const dirPath = pathApi.join(
    processRootDir,
    formatDateSegment(at),
  );
  if (!fsApi.existsSync(dirPath)) {
    fsApi.mkdirSync(dirPath, { recursive: true });
  }

  const fileBaseName = `${formatMinuteSegment(at)}-${sanitizeProcessFileName(processId)}`;
  return {
    outputFilePath: pathApi.join(dirPath, `${fileBaseName}.log`),
    metadataFilePath: pathApi.join(dirPath, `${fileBaseName}.json`),
  };
}

export function normalizeProcessLogSubappName(subapp: string | undefined): string {
  const trimmed = typeof subapp === 'string' ? subapp.trim() : '';
  if (!trimmed) {
    return DEFAULT_PROCESS_LOG_SUBAPP;
  }
  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]/g, '-');
  return normalized || DEFAULT_PROCESS_LOG_SUBAPP;
}

export function resolveProcessLogSubappNameFromOutputFilePath(outputFilePath: string | undefined): string {
  const normalizedPath = typeof outputFilePath === 'string' ? outputFilePath.trim() : '';
  if (!normalizedPath) {
    return DEFAULT_PROCESS_LOG_SUBAPP;
  }

  const segments = normalizedPath
    .split(/[\\/]+/)
    .map(segment => segment.trim())
    .filter(Boolean);
  const processSegmentIndex = segments.lastIndexOf('process');
  if (processSegmentIndex >= 0) {
    return DEFAULT_PROCESS_LOG_SUBAPP;
  }

  if (segments.length < 4) {
    return DEFAULT_PROCESS_LOG_SUBAPP;
  }

  return normalizeProcessLogSubappName(segments[segments.length - 4]);
}

export function resolveProcessLogProjectDir(projectPath: string | undefined): string | null {
  const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!normalizedProjectPath || !(window as any)?.path) {
    return null;
  }

  const pathApi = (window as any).path;
  return pathApi.join(normalizedProjectPath, '.log', 'process');
}

export function resolveProjectLogRootDir(projectPath: string | undefined, pathApi?: any): string | null {
  const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  const resolvedPathApi = pathApi ?? (window as any)?.path;
  if (!normalizedProjectPath || !resolvedPathApi) {
    return null;
  }

  return resolvedPathApi.join(normalizedProjectPath, '.log');
}

export function resolveProjectAssetsRootDir(projectPath: string | undefined, pathApi?: any): string | null {
  const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  const resolvedPathApi = pathApi ?? (window as any)?.path;
  if (!normalizedProjectPath || !resolvedPathApi) {
    return null;
  }

  return resolvedPathApi.join(normalizedProjectPath, '.assets');
}

function normalizeLogMessage(message: string): string {
  return typeof message === 'string' ? stripAnsi(message).trim() : '';
}

function normalizeLogSource(source: string): string {
  const trimmed = typeof source === 'string' ? source.trim() : '';
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '-') || 'app';
}

function sanitizeProcessFileName(processId: string): string {
  const trimmed = typeof processId === 'string' ? processId.trim() : '';
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_') || 'process';
}

function formatDateSegment(value: Date): string {
  return `${value.getFullYear()}${pad2(value.getMonth() + 1)}${pad2(value.getDate())}`;
}

function formatMinuteSegment(value: Date): string {
  return `${pad2(value.getHours())}-${pad2(value.getMinutes())}`;
}

function formatTimestamp(value: Date): string {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())} ${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}.${pad3(value.getMilliseconds())}`;
}

function normalizeLogLine(
  line: string,
  fallbackLevel: ProjectLogLevel,
): { level: ProjectLogLevel; message: string } | null {
  const sanitized = stripAnsi(String(line || '')).trim();
  if (!sanitized) {
    return null;
  }

  const nestedPrefix = sanitized.match(/^\[(INFO|DEBUG|ERROR)\]\s*/i);
  if (!nestedPrefix) {
    return {
      level: fallbackLevel,
      message: sanitized,
    };
  }

  const nestedLevel = nestedPrefix[1].toUpperCase() as ProjectLogLevel;
  const normalizedMessage = sanitized.slice(nestedPrefix[0].length).trim();
  return {
    level: nestedLevel,
    message: normalizedMessage || sanitized,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function pad3(value: number): string {
  return String(value).padStart(3, '0');
}
