import type { IAilyHostAPI, IDirent, IFileSystem } from '../core/host-api';

export interface BlocklyMemoryStorageRoots {
  readonly userDir: string;
  readonly sessionRootDir: string;
  readonly repoDir: string;
  readonly sessionDir?: string;
}

export interface BlocklyMemoryStorageLayout {
  readonly userDir: string;
  readonly sessionRootDir: string;
  readonly sessionDir: string;
  readonly repoDir: string;
}

export interface BlocklyMemoryEntry {
  readonly scope: 'user' | 'session' | 'repo';
  readonly absolutePath: string;
  readonly publicPath: string;
  readonly name: string;
}

export interface ClearBlocklyMemoriesResult {
  readonly deletedAny: boolean;
  readonly hadError: boolean;
}

export function resolveBlocklyMemoryStorageRoots(
  host: Pick<IAilyHostAPI, 'path' | 'project'>,
  cwd?: string,
  sessionId?: string,
): BlocklyMemoryStorageRoots | undefined {
  const appDataPath = host.path?.getAppDataPath?.();
  const workspaceRoot = cwd || host.project?.currentProjectPath || host.project?.projectRootPath || '';
  if (!appDataPath || !workspaceRoot) {
    return undefined;
  }

  const globalMemoryRoot = host.path.join(appDataPath, 'chat_history', 'memory-tool', 'memories');
  const workspaceMemoryRoot = host.path.join(workspaceRoot, '.chat_history', 'memory-tool', 'memories');

  return {
    userDir: globalMemoryRoot,
    sessionRootDir: workspaceMemoryRoot,
    repoDir: host.path.join(workspaceMemoryRoot, 'repo'),
    ...(sessionId ? { sessionDir: host.path.join(workspaceMemoryRoot, sessionId) } : {}),
  };
}

export function resolveBlocklyMemoryStorageLayout(
  host: Pick<IAilyHostAPI, 'path' | 'project'>,
  cwd?: string,
  sessionId?: string,
): BlocklyMemoryStorageLayout | undefined {
  if (!sessionId) {
    return undefined;
  }

  const roots = resolveBlocklyMemoryStorageRoots(host, cwd, sessionId);
  if (!roots?.sessionDir) {
    return undefined;
  }

  return {
    userDir: roots.userDir,
    sessionRootDir: roots.sessionRootDir,
    sessionDir: roots.sessionDir,
    repoDir: roots.repoDir,
  };
}

export function listBlocklyLocalMemoryEntries(
  host: Pick<IAilyHostAPI, 'fs' | 'path' | 'project'>,
  cwd?: string,
  sessionId?: string,
  repositoryMemoryEnabled = false,
): BlocklyMemoryEntry[] {
  const roots = resolveBlocklyMemoryStorageRoots(host, cwd, sessionId);
  if (!roots) {
    return [];
  }

  const entries: BlocklyMemoryEntry[] = [];
  entries.push(...readScopeEntries(host.fs, host.path, roots.userDir, 'user', '/memories/'));

  if (roots.sessionDir) {
    entries.push(...readScopeEntries(host.fs, host.path, roots.sessionDir, 'session', '/memories/session/'));
  }

  if (!repositoryMemoryEnabled) {
    entries.push(...readScopeEntries(host.fs, host.path, roots.repoDir, 'repo', '/memories/repo/'));
  }

  return entries;
}

export function clearBlocklyLocalMemories(
  host: Pick<IAilyHostAPI, 'fs' | 'path' | 'project'>,
  cwd?: string,
): ClearBlocklyMemoriesResult {
  const roots = resolveBlocklyMemoryStorageRoots(host, cwd);
  if (!roots) {
    return { deletedAny: false, hadError: false };
  }

  let deletedAny = false;
  let hadError = false;

  for (const targetPath of [roots.userDir, roots.sessionRootDir]) {
    if (!targetPath || !host.fs.existsSync(targetPath)) {
      continue;
    }

    try {
      host.fs.rmdirSync(targetPath, { recursive: true, force: true });
      deletedAny = true;
    } catch {
      hadError = true;
    }
  }

  return { deletedAny, hadError };
}

export function resolveBlocklyMemoryPublicPath(
  host: Pick<IAilyHostAPI, 'path' | 'project'>,
  cwd: string | undefined,
  sessionId: string | undefined,
  publicPath: string,
): string | undefined {
  const normalized = typeof publicPath === 'string' ? publicPath.trim() : '';
  if (!normalized.startsWith('/memories/')) {
    return undefined;
  }

  if (normalized.startsWith('/memories/session/')) {
    const layout = resolveBlocklyMemoryStorageLayout(host, cwd, sessionId);
    if (!layout) {
      return undefined;
    }

    const relativePath = normalized.slice('/memories/session/'.length);
    return relativePath ? host.path.join(layout.sessionDir, relativePath) : undefined;
  }

  if (normalized.startsWith('/memories/repo/')) {
    const roots = resolveBlocklyMemoryStorageRoots(host, cwd, sessionId);
    if (!roots) {
      return undefined;
    }

    const relativePath = normalized.slice('/memories/repo/'.length);
    return relativePath ? host.path.join(roots.repoDir, relativePath) : undefined;
  }

  const roots = resolveBlocklyMemoryStorageRoots(host, cwd, sessionId);
  if (!roots) {
    return undefined;
  }

  const relativePath = normalized.slice('/memories/'.length);
  if (!relativePath || relativePath.startsWith('session/') || relativePath.startsWith('repo/')) {
    return undefined;
  }

  return host.path.join(roots.userDir, relativePath);
}

function readScopeEntries(
  fs: Pick<IFileSystem, 'existsSync' | 'readdirSync' | 'readDirSync' | 'statSync'>,
  pathUtils: Pick<IAilyHostAPI['path'], 'join'>,
  scopeRoot: string,
  scope: BlocklyMemoryEntry['scope'],
  publicPrefix: string,
): BlocklyMemoryEntry[] {
  if (!scopeRoot || !fs.existsSync(scopeRoot)) {
    return [];
  }

  try {
    return readDirEntries(fs, scopeRoot)
      .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(entry => ({
        scope,
        name: entry.name,
        absolutePath: pathUtils.join(scopeRoot, entry.name),
        publicPath: `${publicPrefix}${entry.name}`,
      }));
  } catch {
    return [];
  }
}

function readDirEntries(
  fs: Pick<IFileSystem, 'readdirSync' | 'readDirSync' | 'statSync'>,
  dirPath: string,
): IDirent[] {
  if (fs.readDirSync) {
    return fs.readDirSync(dirPath);
  }

  return fs.readdirSync(dirPath).map(name => ({
    name,
    isDirectory: () => fs.statSync(`${dirPath}/${name}`).isDirectory(),
    isFile: () => fs.statSync(`${dirPath}/${name}`).isFile(),
  }));
}