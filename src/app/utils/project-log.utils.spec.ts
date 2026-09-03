import {
  PROJECT_DIAGNOSTIC_LOG_MAX_BYTES,
  readRecentProjectDiagnosticLogs,
} from './project-log.utils';
import { sanitizeDiagnosticText } from '../components/feedback-dialog/feedback-diagnostics.utils';

type MockEntryType = 'directory' | 'file' | 'symlink';

describe('readRecentProjectDiagnosticLogs', () => {
  const projectPath = '/projects/demo';
  const logRoot = `${projectPath}/.log`;
  let previousPathApi: unknown;
  let previousFsApi: unknown;
  let entryTypes: Map<string, MockEntryType>;
  let directoryEntries: Map<string, string[]>;
  let realPaths: Map<string, string>;
  let fileLines: Map<string, string[]>;
  let readFailures: Set<string>;
  let readTailLines: jasmine.Spy;

  beforeEach(() => {
    previousPathApi = (window as any).path;
    previousFsApi = (window as any).fs;
    entryTypes = new Map<string, MockEntryType>();
    directoryEntries = new Map<string, string[]>();
    realPaths = new Map<string, string>();
    fileLines = new Map<string, string[]>();
    readFailures = new Set<string>();
    readTailLines = jasmine.createSpy('readTailLines').and.callFake(async (
      filePath: string,
      options: { maxLines: number },
    ) => {
      if (readFailures.has(filePath)) {
        throw new Error('read failed');
      }
      return (fileLines.get(filePath) || []).slice(-options.maxLines);
    });

    (window as any).path = createPathApi();
    (window as any).fs = {
      lstatSync: (filePath: string) => {
        const type = entryTypes.get(filePath);
        if (!type) {
          const error = new Error('missing path') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        return {
          _isDirectory: type === 'directory',
          _isFile: type === 'file',
          _isSymbolicLink: type === 'symlink',
        };
      },
      realpathAsync: async (filePath: string) => {
        if (!entryTypes.has(filePath)) throw new Error('missing path');
        return realPaths.get(filePath) || filePath;
      },
      readdirSync: (directoryPath: string) => {
        const entries = directoryEntries.get(directoryPath);
        if (!entries) throw new Error('not a directory');
        return [...entries];
      },
      readTailLines,
    };
  });

  afterEach(() => {
    (window as any).path = previousPathApi;
    (window as any).fs = previousFsApi;
  });

  it('reads only the newest compile and upload log files', async () => {
    addDirectory(logRoot);
    addDirectory(`${logRoot}/compile`, ['20260901', 'ignored', '20260902']);
    addDirectory(`${logRoot}/compile/20260901`, ['23-59.log']);
    addFile(`${logRoot}/compile/20260901/23-59.log`, ['older compile']);
    addDirectory(`${logRoot}/compile/20260902`, ['08-30.log', '10-15.log', 'secret.txt']);
    addFile(`${logRoot}/compile/20260902/08-30.log`, ['older today']);
    addFile(`${logRoot}/compile/20260902/10-15.log`, ['newest compile']);
    addDirectory(`${logRoot}/upload`, ['20260902']);
    addDirectory(`${logRoot}/upload/20260902`, ['09-45.log']);
    addFile(`${logRoot}/upload/20260902/09-45.log`, ['newest upload']);

    const result = await readRecentProjectDiagnosticLogs(projectPath);

    expect(result.compile).toEqual({
      status: 'ok',
      content: 'newest compile',
      truncated: false,
    });
    expect(result.upload).toEqual({
      status: 'ok',
      content: 'newest upload',
      truncated: false,
    });
    expect(readTailLines.calls.allArgs().map((args) => args[0]).sort()).toEqual([
      `${logRoot}/compile/20260902/10-15.log`,
      `${logRoot}/upload/20260902/09-45.log`,
    ].sort());
  });

  it('preserves the complete partitions.csv compile error and its non-user path', async () => {
    const compileError = String.raw`[2026-09-02 23:05:37.409] [ERROR] [compile] 选择了自定义分区方案，但未找到 partitions.csv 分区文件。请将文件保存到 D:\ailyblockly\AI-VOX3yuyinkongzhiLED_357163\src\partitions.csv`;
    addDirectory(logRoot);
    addDirectory(`${logRoot}/compile`, ['20260902']);
    addDirectory(`${logRoot}/compile/20260902`, ['23-05.log']);
    addFile(`${logRoot}/compile/20260902/23-05.log`, [compileError]);

    const result = await readRecentProjectDiagnosticLogs(projectPath, sanitizeDiagnosticText);

    expect(result.compile).toEqual({
      status: 'ok',
      content: compileError,
      truncated: false,
    });
  });

  it('distinguishes confirmed absence from a read failure', async () => {
    addDirectory(logRoot);
    addDirectory(`${logRoot}/compile`, ['20260902']);
    addDirectory(`${logRoot}/compile/20260902`, ['10-15.log']);
    const compileLog = `${logRoot}/compile/20260902/10-15.log`;
    addFile(compileLog, ['compile output']);
    readFailures.add(compileLog);

    const result = await readRecentProjectDiagnosticLogs(projectPath);

    expect(result.compile.status).toBe('error');
    expect(result.upload.status).toBe('none');
  });

  it('rejects a symbolic-link log root without reading it', async () => {
    entryTypes.set(logRoot, 'symlink');

    const result = await readRecentProjectDiagnosticLogs(projectPath);

    expect(result.compile.status).toBe('error');
    expect(result.upload.status).toBe('error');
    expect(readTailLines).not.toHaveBeenCalled();
  });

  it('rejects a symbolic-link candidate file without falling back to older logs', async () => {
    addDirectory(logRoot);
    addDirectory(`${logRoot}/compile`, ['20260902']);
    addDirectory(`${logRoot}/compile/20260902`, ['10-15.log', '09-00.log']);
    entryTypes.set(`${logRoot}/compile/20260902/10-15.log`, 'symlink');
    addFile(`${logRoot}/compile/20260902/09-00.log`, ['older compile']);

    const result = await readRecentProjectDiagnosticLogs(projectPath);

    expect(result.compile.status).toBe('error');
    expect(readTailLines).not.toHaveBeenCalled();
  });

  it('rejects a symbolic-link source directory', async () => {
    addDirectory(logRoot);
    entryTypes.set(`${logRoot}/compile`, 'symlink');

    const result = await readRecentProjectDiagnosticLogs(projectPath);

    expect(result.compile.status).toBe('error');
    expect(readTailLines).not.toHaveBeenCalled();
  });

  it('rejects a symbolic-link date directory', async () => {
    addDirectory(logRoot);
    addDirectory(`${logRoot}/compile`, ['20260902']);
    entryTypes.set(`${logRoot}/compile/20260902`, 'symlink');

    const result = await readRecentProjectDiagnosticLogs(projectPath);

    expect(result.compile.status).toBe('error');
    expect(readTailLines).not.toHaveBeenCalled();
  });

  it('rejects a candidate whose canonical path escapes the log root', async () => {
    addDirectory(logRoot);
    addDirectory(`${logRoot}/compile`, ['20260902']);
    addDirectory(`${logRoot}/compile/20260902`, ['10-15.log']);
    const compileLog = `${logRoot}/compile/20260902/10-15.log`;
    addFile(compileLog, ['must not be read']);
    realPaths.set(compileLog, '/outside/secret.log');

    const result = await readRecentProjectDiagnosticLogs(projectPath);

    expect(result.compile.status).toBe('error');
    expect(readTailLines).not.toHaveBeenCalled();
  });

  it('drops the older source before bounding the newest tail by UTF-8 bytes', async () => {
    addDirectory(logRoot);
    addDirectory(`${logRoot}/compile`, ['20260902']);
    addDirectory(`${logRoot}/compile/20260902`, ['10-15.log']);
    addFile(
      `${logRoot}/compile/20260902/10-15.log`,
      Array.from({ length: 100 }, (_, index) => `${index} ${'编'.repeat(100)}${index === 99 ? 'COMPILE_END' : ''}`),
    );
    addDirectory(`${logRoot}/upload`, ['20260902']);
    addDirectory(`${logRoot}/upload/20260902`, ['10-16.log']);
    addFile(
      `${logRoot}/upload/20260902/10-16.log`,
      Array.from({ length: 100 }, (_, index) => `${index} ${'传'.repeat(150)}${index === 99 ? 'UPLOAD_END' : ''}`),
    );

    const result = await readRecentProjectDiagnosticLogs(projectPath);
    const compileContent = result.compile.content || '';
    const uploadContent = result.upload.content || '';
    const totalBytes = new TextEncoder().encode(compileContent).byteLength
      + new TextEncoder().encode(uploadContent).byteLength;

    expect(totalBytes).toBeLessThanOrEqual(PROJECT_DIAGNOSTIC_LOG_MAX_BYTES);
    expect(result.compile.truncated).toBeTrue();
    expect(result.upload.truncated).toBeTrue();
    expect(compileContent).toBe('[truncated; latest content retained]');
    expect(uploadContent.startsWith('[truncated; latest content retained]\n')).toBeTrue();
    expect(compileContent).not.toContain('COMPILE_END');
    expect(uploadContent.endsWith('UPLOAD_END')).toBeTrue();
    expect(compileContent).not.toContain('\ufffd');
    expect(uploadContent).not.toContain('\ufffd');
  });

  it('preserves timestamped filenames when choosing the newer log from oversized combined output', async () => {
    addDirectory(logRoot);
    addDirectory(`${logRoot}/compile`, ['20260902']);
    addDirectory(`${logRoot}/compile/20260902`, ['10-17.log']);
    addFile(
      `${logRoot}/compile/20260902/10-17.log`,
      [
        ...Array.from(
          { length: 399 },
          (_, index) => `[2026-09-02 10:17:00.000] [DEBUG] [compile] Writing private-compile-${index}.bin`,
        ),
        '[2026-09-02 10:17:01.000] [INFO] [compile] newest compile summary',
      ],
    );
    addDirectory(`${logRoot}/upload`, ['20260902']);
    addDirectory(`${logRoot}/upload/20260902`, ['10-16.log']);
    addFile(
      `${logRoot}/upload/20260902/10-16.log`,
      [
        ...Array.from(
          { length: 399 },
          (_, index) => `[2026-09-02 10:16:00.000] [DEBUG] [upload] Writing private-upload-${index}.bin`,
        ),
        '[2026-09-02 10:16:01.000] [INFO] [upload] [WiFi OTA] upload completed',
      ],
    );

    const result = await readRecentProjectDiagnosticLogs(projectPath, sanitizeDiagnosticText);

    expect(result.upload.content).toBe('[truncated; latest content retained]');
    expect(result.upload.truncated).toBeTrue();
    expect(result.uploadEvidence).toEqual({
      latestTimestamp: Date.parse('2026-09-02T10:16:01.000'),
      latestOtaEntry: {
        timestamp: Date.parse('2026-09-02T10:16:01.000'),
        detail: '[WiFi OTA] upload completed',
      },
    });
    expect(result.compile.content).toContain(
      '[2026-09-02 10:17:00.000] [DEBUG] [compile] Writing private-compile-398.bin',
    );
    expect(result.compile.content).toContain('newest compile summary');
    expect(result.compile.content).not.toContain('[FILE]');
    expect(result.compile.truncated).toBeFalse();
  });

  it('drops an oversized credential line instead of exposing a partial value', async () => {
    addDirectory(logRoot);
    addDirectory(`${logRoot}/compile`, ['20260902']);
    addDirectory(`${logRoot}/compile/20260902`, ['10-15.log']);
    addFile(
      `${logRoot}/compile/20260902/10-15.log`,
      [`Authorization: Bearer ${'sensitive-value'.repeat(4000)}`],
    );

    const result = await readRecentProjectDiagnosticLogs(projectPath);

    expect(result.compile).toEqual({
      status: 'ok',
      content: '[truncated; latest content retained]\n',
      truncated: true,
    });
    expect(result.compile.content).not.toContain('sensitive-value');
  });

  it('sanitizes the complete selected log before applying its byte limit', async () => {
    addDirectory(logRoot);
    addDirectory(`${logRoot}/compile`, ['20260902']);
    addDirectory(`${logRoot}/compile/20260902`, ['10-15.log']);
    const sourceTail = `private_source_${'x'.repeat(PROJECT_DIAGNOSTIC_LOG_MAX_BYTES)}`;
    addFile(
      `${logRoot}/compile/20260902/10-15.log`,
      ['sourceCode:', sourceTail],
    );

    const result = await readRecentProjectDiagnosticLogs(
      projectPath,
      (content) => sanitizeDiagnosticText(content),
    );

    expect(result.compile.status).toBe('ok');
    expect(result.compile.content).toBeNull();
    expect(result.compile.content).not.toContain(sourceTail);
  });

  it('omits a log when the bounded line window cannot prove where a source excerpt began', async () => {
    addDirectory(logRoot);
    addDirectory(`${logRoot}/compile`, ['20260902']);
    addDirectory(`${logRoot}/compile/20260902`, ['10-15.log']);
    addFile(
      `${logRoot}/compile/20260902/10-15.log`,
      Array.from({ length: 401 }, (_, index) => `line ${index}`),
    );

    const result = await readRecentProjectDiagnosticLogs(projectPath);

    expect(result.compile.status).toBe('ok');
    expect(result.compile.truncated).toBeTrue();
    expect(result.compile.content).toBeNull();
    expect(readTailLines).toHaveBeenCalledWith(
      `${logRoot}/compile/20260902/10-15.log`,
      { maxLines: 401 },
    );
  });

  it('does not expose source continuation lines when their header falls outside the bounded window', async () => {
    addDirectory(logRoot);
    addDirectory(`${logRoot}/compile`, ['20260902']);
    addDirectory(`${logRoot}/compile/20260902`, ['10-15.log']);
    const sourceTail = 'private_source_continuation();';
    addFile(
      `${logRoot}/compile/20260902/10-15.log`,
      ['sourceCode:', ...Array.from({ length: 400 }, () => sourceTail)],
    );

    const result = await readRecentProjectDiagnosticLogs(
      projectPath,
      (content) => sanitizeDiagnosticText(content),
    );

    expect(result.compile).toEqual({ status: 'ok', content: null, truncated: true });
    expect(result.compile.content).not.toContain(sourceTail);
  });

  function addDirectory(directoryPath: string, entries: string[] = []): void {
    entryTypes.set(directoryPath, 'directory');
    directoryEntries.set(directoryPath, entries);
  }

  function addFile(filePath: string, lines: string[]): void {
    entryTypes.set(filePath, 'file');
    fileLines.set(filePath, lines);
  }
});

function createPathApi() {
  return {
    join: (...parts: string[]) => normalizePath(parts.join('/')),
    resolve: (value: string) => normalizePath(value),
    relative: (from: string, to: string) => relativePath(from, to),
    isAbsolute: (value: string) => value.startsWith('/'),
  };
}

function normalizePath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `/${segments.join('/')}`;
}

function relativePath(from: string, to: string): string {
  const fromSegments = normalizePath(from).split('/').filter(Boolean);
  const toSegments = normalizePath(to).split('/').filter(Boolean);
  let shared = 0;
  while (shared < fromSegments.length
    && shared < toSegments.length
    && fromSegments[shared] === toSegments[shared]) {
    shared += 1;
  }
  return [
    ...Array(fromSegments.length - shared).fill('..'),
    ...toSegments.slice(shared),
  ].join('/');
}
