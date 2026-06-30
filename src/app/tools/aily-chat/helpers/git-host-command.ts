import { AilyHost } from '../core/host';

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function directoryHasExecutable(directory: string, executableName: string): boolean {
  try {
    return AilyHost.get().fs.existsSync(AilyHost.get().path.join(directory, executableName));
  } catch {
    return false;
  }
}

function getWindowsDriveRoot(value: string | null | undefined): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const match = normalized.match(/^[a-zA-Z]:[\\/]/);
  return match ? `${match[0][0].toUpperCase()}:\\` : '';
}

function getGitPathCandidates(): string[] {
  const host = AilyHost.get();
  const executableName = host.platform?.isWindows ? 'git.exe' : 'git';
  const candidates: string[] = [];

  if (host.platform?.isWindows) {
    const home = host.path?.getUserHome?.() ?? host.platform?.homedir?.() ?? '';
    const driveRoots = uniqueNonEmpty([
      'C:\\',
      getWindowsDriveRoot(home),
      getWindowsDriveRoot(host.project?.currentProjectPath),
      getWindowsDriveRoot(host.project?.projectRootPath),
      getWindowsDriveRoot(host.path?.getAppDataPath?.()),
      getWindowsDriveRoot(host.path?.getAilyChildPath?.()),
      getWindowsDriveRoot(host.path?.getElectronPath?.()),
    ]);
    for (const driveRoot of driveRoots) {
      candidates.push(
        host.path.join(driveRoot, 'Program Files', 'Git', 'cmd'),
        host.path.join(driveRoot, 'Program Files', 'Git', 'bin'),
        host.path.join(driveRoot, 'Program Files (x86)', 'Git', 'cmd'),
        host.path.join(driveRoot, 'Program Files (x86)', 'Git', 'bin'),
        host.path.join(driveRoot, 'Git', 'cmd'),
        host.path.join(driveRoot, 'Git', 'bin'),
      );
    }
    candidates.push(
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files (x86)\\Git\\cmd',
      'C:\\Program Files (x86)\\Git\\bin',
    );
    if (home) {
      candidates.push(
        host.path.join(home, 'AppData', 'Local', 'Programs', 'Git', 'cmd'),
        host.path.join(home, 'AppData', 'Local', 'Programs', 'Git', 'bin'),
      );
    }
  } else if (host.platform?.isMacOS || host.platform?.type === 'darwin') {
    candidates.push('/usr/bin', '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin');
  } else {
    candidates.push('/usr/bin', '/usr/local/bin', '/snap/bin');
  }

  return uniqueNonEmpty(candidates)
    .filter(candidate => directoryHasExecutable(candidate, executableName));
}

function buildGitPathEnv(gitDirectory: string, env?: Record<string, string>): Record<string, string> {
  const delimiter = AilyHost.get().platform?.isWindows ? ';' : ':';
  const currentPath = env?.['PATH'] ?? env?.['Path'] ?? '';
  const nextPath = currentPath ? `${gitDirectory}${delimiter}${currentPath}` : gitDirectory;
  return {
    ...(env ?? {}),
    PATH: nextPath,
    ...(AilyHost.get().platform?.isWindows ? { Path: nextPath } : {}),
  };
}

function shouldRetryWithExplicitGitPath(error: unknown): boolean {
  const message = error instanceof Error && error.message ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return normalized.includes('enoent')
    || normalized.includes('not recognized')
    || normalized.includes('command not found')
    || normalized.includes('commandnotfoundexception')
    || (message.includes('无法将') && message.includes('识别'))
    || message.includes('不是内部或外部命令');
}

function describeGitCommand(args: string[], cwd: string): string {
  return `git ${args.join(' ')} (cwd=${cwd})`;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? '');
}

function logGitDiagnostic(level: 'info' | 'warn' | 'error', message: string, error?: unknown): void {
  try {
    const logger = AilyHost.get().log;
    if (level === 'error') {
      logger?.error?.(`[AilyChat][GitCheckpoint] ${message}`, error);
      return;
    }
    logger?.[level]?.(`[AilyChat][GitCheckpoint] ${message}`);
  } catch {
    // Diagnostics must never change command execution semantics.
  }
}

export async function runHostGitCommand(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<string> {
  const host = AilyHost.get();
  if (!host.cmd?.spawn) {
    throw new Error('Git command host is unavailable');
  }

  const run = (commandEnv?: Record<string, string>): Promise<string> => new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    host.cmd.spawn('git', args, {
      cwd,
      streamId: `git_host_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      shellProfile: false,
      ...(commandEnv ? { env: commandEnv } : {}),
    }, true).subscribe({
      next: (event: any) => {
        switch (event?.type) {
          case 'stdout':
            stdout += event.data ?? '';
            break;
          case 'stderr':
            stderr += event.data ?? '';
            break;
          case 'close': {
            if (!stdout && typeof event.stdout === 'string') {
              stdout = event.stdout;
            }
            if (!stderr && typeof event.stderr === 'string') {
              stderr = event.stderr;
            }
            if ((event.code ?? 0) === 0) {
              resolve(stdout.trimEnd());
              return;
            }
            reject(new Error(stderr || stdout || `git ${args.join(' ')} failed`));
            break;
          }
          case 'error':
            reject(new Error(event.error ?? `git ${args.join(' ')} failed`));
            break;
        }
      },
      error: (error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    });
  });

  try {
    return await run(env);
  } catch (error) {
    if (!shouldRetryWithExplicitGitPath(error)) {
      logGitDiagnostic(
        'warn',
        `git command failed without PATH fallback: ${describeGitCommand(args, cwd)}; error=${stringifyError(error)}`,
      );
      throw error;
    }

    const gitPathCandidates = getGitPathCandidates();
    logGitDiagnostic(
      'warn',
      `git command was not visible on PATH; retrying with ${gitPathCandidates.length} known Git path candidate(s): ${describeGitCommand(args, cwd)}; error=${stringifyError(error)}`,
    );
    for (const gitDirectory of gitPathCandidates) {
      try {
        const output = await run(buildGitPathEnv(gitDirectory, env));
        logGitDiagnostic(
          'info',
          `git command succeeded with explicit Git path: ${gitDirectory}; ${describeGitCommand(args, cwd)}`,
        );
        return output;
      } catch (fallbackError) {
        logGitDiagnostic(
          'warn',
          `git command failed with explicit Git path: ${gitDirectory}; ${describeGitCommand(args, cwd)}; error=${stringifyError(fallbackError)}`,
        );
        // Try the next known Git installation directory.
      }
    }

    logGitDiagnostic(
      'error',
      `git command failed after PATH fallback: ${describeGitCommand(args, cwd)}; candidateCount=${gitPathCandidates.length}`,
      error,
    );
    throw error;
  }
}
