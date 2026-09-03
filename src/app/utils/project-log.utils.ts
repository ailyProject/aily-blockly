export type ProjectLogLevel = 'INFO' | 'DEBUG' | 'ERROR';
export const DEFAULT_PROCESS_LOG_SUBAPP = 'default';
export const PROJECT_DIAGNOSTIC_LOG_MAX_BYTES = 32 * 1024;

export interface ProjectDiagnosticLogReadResult {
  status: 'ok' | 'none' | 'error';
  content: string | null;
  truncated: boolean;
}

export interface ProjectUploadDiagnosticEvidence {
  latestTimestamp: number | null;
  latestOtaEntry: { timestamp: number; detail: string } | null;
}

export interface RecentProjectDiagnosticLogs {
  compile: ProjectDiagnosticLogReadResult;
  upload: ProjectDiagnosticLogReadResult;
  uploadEvidence: ProjectUploadDiagnosticEvidence;
}

const PROJECT_DIAGNOSTIC_LOG_SOURCES = ['compile', 'upload'] as const;
const PROJECT_DIAGNOSTIC_LOG_TRUNCATION_MARKER = '[truncated; latest content retained]\n';
const PROJECT_DIAGNOSTIC_LOG_MAX_LINES = 400;

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
  subapp = DEFAULT_PROCESS_LOG_SUBAPP,
): { outputFilePath: string; metadataFilePath: string } | null {
  const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!normalizedProjectPath || !(window as any)?.path || !(window as any)?.fs) {
    return null;
  }

  const pathApi = (window as any).path;
  const fsApi = (window as any).fs;
  const processRootDir = resolveProcessLogProjectDir(normalizedProjectPath, subapp);
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
  const logSegmentIndex = segments.lastIndexOf('.log');
  if (logSegmentIndex >= 0) {
    const subappSegment = segments[logSegmentIndex + 1];
    if (subappSegment && subappSegment !== 'process') {
      return normalizeProcessLogSubappName(subappSegment);
    }
    if (subappSegment === 'process') {
      const inferredLegacySubapp = inferLegacyProcessSubappNameFromFileName(segments[segments.length - 1] || '');
      return inferredLegacySubapp || DEFAULT_PROCESS_LOG_SUBAPP;
    }
  }

  if (segments.length < 4) {
    return DEFAULT_PROCESS_LOG_SUBAPP;
  }

  return normalizeProcessLogSubappName(segments[segments.length - 4]);
}

export function resolveProcessLogSubappNameFromCommand(command: string | undefined): string {
  const normalizedCommand = typeof command === 'string' ? command.trim() : '';
  if (!normalizedCommand) {
    return DEFAULT_PROCESS_LOG_SUBAPP;
  }

  const patterns = [
    /child\/tools\/([^/\s'"\\]+)\/index\.js/i,
    /child\/tools\/([^/\s'"\\]+)(?:\s|&&|;|$)/i,
    /cd\s+.+?child\/tools\/([^/\s'"\\]+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = normalizedCommand.match(pattern);
    if (match?.[1]) {
      return normalizeProcessLogSubappName(match[1]);
    }
  }

  return DEFAULT_PROCESS_LOG_SUBAPP;
}

export function resolveProcessLogSubappNameFromCwd(cwd: string | undefined): string {
  const normalizedCwd = typeof cwd === 'string' ? cwd.trim() : '';
  if (!normalizedCwd) {
    return DEFAULT_PROCESS_LOG_SUBAPP;
  }

  const patterns = [
    /child\/tools\/([^/\s'"\\]+)$/i,
    /child\/tools\/([^/\s'"\\]+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = normalizedCwd.match(pattern);
    if (match?.[1]) {
      return normalizeProcessLogSubappName(match[1]);
    }
  }

  return DEFAULT_PROCESS_LOG_SUBAPP;
}

export function resolveProcessLogProjectDir(projectPath: string | undefined, subapp = DEFAULT_PROCESS_LOG_SUBAPP): string | null {
  const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!normalizedProjectPath || !(window as any)?.path) {
    return null;
  }

  const pathApi = (window as any).path;
  return pathApi.join(normalizedProjectPath, '.log', normalizeProcessLogSubappName(subapp));
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

export async function readRecentProjectDiagnosticLogs(
  projectPath: string | undefined,
  sanitizeContent: (content: string) => string | null = (content) => content,
): Promise<RecentProjectDiagnosticLogs> {
  const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  const pathApi = (window as any)?.path;
  const fsApi = (window as any)?.fs;
  if (!normalizedProjectPath || !hasDiagnosticLogReadApis(pathApi, fsApi)) {
    return diagnosticLogPair('error');
  }

  try {
    const logRoot = pathApi.resolve(pathApi.join(normalizedProjectPath, '.log'));
    const rootStat = lstatIfPresent(logRoot, fsApi);
    if (!rootStat) {
      return diagnosticLogPair('none');
    }
    if (rootStat?._isSymbolicLink === true || rootStat?._isDirectory !== true) {
      return diagnosticLogPair('error');
    }
    const realLogRoot = await fsApi.realpathAsync(logRoot);
    if (typeof realLogRoot !== 'string' || !realLogRoot.trim()) {
      return diagnosticLogPair('error');
    }

    const [compile, upload] = await Promise.all(PROJECT_DIAGNOSTIC_LOG_SOURCES.map((source) => (
      readLatestProjectDiagnosticLog(logRoot, realLogRoot, source, pathApi, fsApi, sanitizeContent)
    )));
    return applyCombinedDiagnosticLogByteLimit({
      compile,
      upload,
      uploadEvidence: extractProjectUploadDiagnosticEvidence(upload),
    });
  } catch {
    return diagnosticLogPair('error');
  }
}

async function readLatestProjectDiagnosticLog(
  logRoot: string,
  realLogRoot: string,
  source: typeof PROJECT_DIAGNOSTIC_LOG_SOURCES[number],
  pathApi: any,
  fsApi: any,
  sanitizeContent: (content: string) => string | null,
): Promise<ProjectDiagnosticLogReadResult> {
  try {
    const sourcePath = pathApi.resolve(pathApi.join(logRoot, source));
    if (!isPathInside(logRoot, sourcePath, pathApi)) {
      return diagnosticLogResult('error');
    }
    const sourceStat = lstatIfPresent(sourcePath, fsApi);
    if (!sourceStat) {
      return diagnosticLogResult('none');
    }
    await assertSafeDiagnosticLogPath(sourcePath, realLogRoot, 'directory', pathApi, fsApi, sourceStat);

    const dateSegments = readDirectoryNames(sourcePath, fsApi)
      .filter((name) => /^\d{8}$/.test(name))
      .sort((left, right) => right.localeCompare(left));

    for (const dateSegment of dateSegments) {
      const datePath = pathApi.resolve(pathApi.join(sourcePath, dateSegment));
      await assertSafeDiagnosticLogPath(datePath, realLogRoot, 'directory', pathApi, fsApi);
      const logFiles = readDirectoryNames(datePath, fsApi)
        .filter((name) => /^\d{2}-\d{2}\.log$/.test(name))
        .sort((left, right) => right.localeCompare(left));

      for (const logFile of logFiles) {
        const logFilePath = pathApi.resolve(pathApi.join(datePath, logFile));
        await assertSafeDiagnosticLogPath(logFilePath, realLogRoot, 'file', pathApi, fsApi);
        const lines = await fsApi.readTailLines(logFilePath, {
          maxLines: PROJECT_DIAGNOSTIC_LOG_MAX_LINES + 1,
        });
        if (!Array.isArray(lines) || lines.some((line) => typeof line !== 'string')) {
          return diagnosticLogResult('error');
        }
        if (lines.some((line) => line.length > 0)) {
          const lineTruncated = lines.length > PROJECT_DIAGNOSTIC_LOG_MAX_LINES;
          if (lineTruncated) {
            return {
              status: 'ok',
              content: null,
              truncated: true,
            };
          }
          const sanitizedContent = sanitizeContent(lines.join('\n'));
          if (sanitizedContent === null) {
            return {
              status: 'ok',
              content: null,
              truncated: lineTruncated,
            };
          }
          const content = sanitizedContent;
          return {
            status: 'ok',
            content: lineTruncated
              ? `${PROJECT_DIAGNOSTIC_LOG_TRUNCATION_MARKER}${content}`
              : content,
            truncated: lineTruncated,
          };
        }
      }
    }
    return diagnosticLogResult('none');
  } catch {
    return diagnosticLogResult('error');
  }
}

function hasDiagnosticLogReadApis(pathApi: any, fsApi: any): boolean {
  return !!pathApi
    && typeof pathApi.join === 'function'
    && typeof pathApi.resolve === 'function'
    && typeof pathApi.relative === 'function'
    && typeof pathApi.isAbsolute === 'function'
    && !!fsApi
    && typeof fsApi.lstatSync === 'function'
    && typeof fsApi.realpathAsync === 'function'
    && typeof fsApi.readdirSync === 'function'
    && typeof fsApi.readTailLines === 'function';
}

function lstatIfPresent(filePath: string, fsApi: any): any | null {
  try {
    return fsApi.lstatSync(filePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function readDirectoryNames(directoryPath: string, fsApi: any): string[] {
  const entries = fsApi.readdirSync(directoryPath);
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) {
    throw new Error('Invalid project log directory listing.');
  }
  return entries;
}

async function assertSafeDiagnosticLogPath(
  candidatePath: string,
  realLogRoot: string,
  expectedType: 'directory' | 'file',
  pathApi: any,
  fsApi: any,
  knownStat?: any,
): Promise<void> {
  const stat = knownStat ?? fsApi.lstatSync(candidatePath);
  const hasExpectedType = expectedType === 'directory' ? stat?._isDirectory === true : stat?._isFile === true;
  if (stat?._isSymbolicLink === true || !hasExpectedType) {
    throw new Error('Unsafe project log path.');
  }
  const realCandidatePath = await fsApi.realpathAsync(candidatePath);
  if (typeof realCandidatePath !== 'string' || !isPathInside(realLogRoot, realCandidatePath, pathApi)) {
    throw new Error('Project log path escaped its root.');
  }
}

function isPathInside(rootPath: string, candidatePath: string, pathApi: any): boolean {
  const relativePath = pathApi.relative(rootPath, candidatePath);
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith('../')
    && !relativePath.startsWith('..\\')
    && !pathApi.isAbsolute(relativePath)
  );
}

function applyCombinedDiagnosticLogByteLimit(
  results: RecentProjectDiagnosticLogs,
): RecentProjectDiagnosticLogs {
  const limited: RecentProjectDiagnosticLogs = {
    ...results,
    compile: { ...results.compile },
    upload: { ...results.upload },
  };
  let totalBytes = diagnosticLogByteLength(limited.compile) + diagnosticLogByteLength(limited.upload);
  if (totalBytes <= PROJECT_DIAGNOSTIC_LOG_MAX_BYTES) {
    return limited;
  }

  const logs = (['compile', 'upload'] as const)
    .map((source, index) => ({
      source,
      index,
      occurredAt: latestDiagnosticLogTimestamp(limited[source].content),
    }))
    .filter(({ source }) => diagnosticLogByteLength(limited[source]) > 0)
    .sort((left, right) => (
      (left.occurredAt ?? Number.NEGATIVE_INFINITY)
      - (right.occurredAt ?? Number.NEGATIVE_INFINITY)
      || left.index - right.index
    ));

  for (const { source } of logs.slice(0, -1)) {
    if (totalBytes <= PROJECT_DIAGNOSTIC_LOG_MAX_BYTES) {
      break;
    }
    const previousBytes = diagnosticLogByteLength(limited[source]);
    limited[source] = {
      status: 'ok',
      content: PROJECT_DIAGNOSTIC_LOG_TRUNCATION_MARKER.trimEnd(),
      truncated: true,
    };
    totalBytes -= previousBytes - diagnosticLogByteLength(limited[source]);
  }

  const newestSource = logs[logs.length - 1]?.source;
  if (newestSource && totalBytes > PROJECT_DIAGNOSTIC_LOG_MAX_BYTES) {
    const otherSource = newestSource === 'compile' ? 'upload' : 'compile';
    const newestBudget = Math.max(
      0,
      PROJECT_DIAGNOSTIC_LOG_MAX_BYTES - diagnosticLogByteLength(limited[otherSource]),
    );
    limited[newestSource] = truncateDiagnosticLogResult(limited[newestSource], newestBudget);
  }

  return limited;
}

function latestDiagnosticLogTimestamp(content: string | null): number | null {
  if (!content) {
    return null;
  }
  let latest: number | null = null;
  for (const match of content.matchAll(/\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:Z)?\]/g)) {
    const timestamp = Date.parse(`${match[1]}T${match[2]}`);
    if (Number.isFinite(timestamp) && (latest === null || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}

function extractProjectUploadDiagnosticEvidence(
  result: ProjectDiagnosticLogReadResult,
): ProjectUploadDiagnosticEvidence {
  const evidence: ProjectUploadDiagnosticEvidence = {
    latestTimestamp: null,
    latestOtaEntry: null,
  };
  if (result.status !== 'ok' || !result.content) {
    return evidence;
  }

  for (const line of result.content.split(/\r\n|\n|\r/)) {
    const match = line.match(
      /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s+\[[^\]]+\]\s+\[upload\]\s+(.*)$/,
    );
    if (!match) {
      continue;
    }
    const timestamp = Date.parse(`${match[1]}T${match[2]}`);
    const detail = match[3].trim();
    if (!Number.isFinite(timestamp) || !detail) {
      continue;
    }
    if (evidence.latestTimestamp === null || timestamp >= evidence.latestTimestamp) {
      evidence.latestTimestamp = timestamp;
    }
    if (
      /^(?:\[WiFi OTA\]|\[BLE OTA\])\s+/i.test(detail)
      && (!evidence.latestOtaEntry || timestamp >= evidence.latestOtaEntry.timestamp)
    ) {
      evidence.latestOtaEntry = { timestamp, detail };
    }
  }
  return evidence;
}

function diagnosticLogByteLength(result: ProjectDiagnosticLogReadResult): number {
  return result.status === 'ok' && result.content !== null
    ? new TextEncoder().encode(result.content).byteLength
    : 0;
}

function truncateDiagnosticLogResult(
  result: ProjectDiagnosticLogReadResult,
  maxBytes: number,
): ProjectDiagnosticLogReadResult {
  if (result.status !== 'ok' || result.content === null) {
    return result;
  }
  const encoder = new TextEncoder();
  if (encoder.encode(result.content).byteLength <= maxBytes) {
    return result;
  }

  const rawContent = result.truncated && result.content.startsWith(PROJECT_DIAGNOSTIC_LOG_TRUNCATION_MARKER)
    ? result.content.slice(PROJECT_DIAGNOSTIC_LOG_TRUNCATION_MARKER.length)
    : result.content;
  const markerBytes = encoder.encode(PROJECT_DIAGNOSTIC_LOG_TRUNCATION_MARKER);
  const bodyBudget = Math.max(0, maxBytes - markerBytes.byteLength);
  const lines = rawContent.split('\n');
  const retainedLines: string[] = [];
  let retainedBytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const lineBytes = encoder.encode(lines[index]).byteLength;
    const separatorBytes = retainedLines.length > 0 ? 1 : 0;
    if (retainedBytes + separatorBytes + lineBytes > bodyBudget) {
      break;
    }
    retainedLines.unshift(lines[index]);
    retainedBytes += separatorBytes + lineBytes;
  }
  return {
    status: 'ok',
    content: `${PROJECT_DIAGNOSTIC_LOG_TRUNCATION_MARKER}${retainedLines.join('\n')}`,
    truncated: true,
  };
}

function diagnosticLogPair(status: 'none' | 'error'): RecentProjectDiagnosticLogs {
  return {
    compile: diagnosticLogResult(status),
    upload: diagnosticLogResult(status),
    uploadEvidence: {
      latestTimestamp: null,
      latestOtaEntry: null,
    },
  };
}

function diagnosticLogResult(status: 'none' | 'error'): ProjectDiagnosticLogReadResult {
  return {
    status,
    content: null,
    truncated: false,
  };
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

function inferLegacyProcessSubappNameFromFileName(fileName: string): string | null {
  const trimmed = typeof fileName === 'string' ? fileName.trim() : '';
  if (!trimmed) {
    return null;
  }

  const baseName = trimmed.replace(/\.(log|json)$/i, '');
  const match = baseName.match(/^\d{2}-\d{2}-(.+)$/);
  if (!match?.[1]) {
    return null;
  }

  const candidate = match[1].trim();
  if (!candidate || candidate.startsWith('terminal_')) {
    return null;
  }

  return normalizeProcessLogSubappName(candidate);
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
