import { AilyHost } from './host';

type CustomFileConfigChangeSubscription = { unsubscribe(): void };
type CustomFileWatchSubscription = { close?(): void; dispose?(): void; unsubscribe?(): void } | void;

export type BlocklyCustomizationFileSource = 'project' | 'user';

export interface BlocklyFileCustomizationProviderConfigSource {
  readonly configChanged$?: {
    subscribe(listener: () => void): CustomFileConfigChangeSubscription;
  };
}

export interface BlocklyDiscoveredCustomizationFile {
  readonly name: string;
  readonly content: string;
  readonly uri: string;
}

export interface BlocklyFileCustomizationProvider {
  contributeFiles(): readonly BlocklyDiscoveredCustomizationFile[];
  onFilesChanged?(listener: () => void): { dispose(): void };
}

export interface BlocklyFileCustomizationProviderOptions<
  TConfig extends BlocklyFileCustomizationProviderConfigSource = BlocklyFileCustomizationProviderConfigSource,
> {
  readonly source: BlocklyCustomizationFileSource;
  readonly projectRootPath?: string;
  readonly configSource?: TConfig;
  readonly defaultFolders: readonly string[];
  readonly resolveConfiguredFolders?: (
    configSource: TConfig | undefined,
    source: BlocklyCustomizationFileSource,
  ) => readonly string[] | undefined;
  readonly shouldIncludeFile: (folderPath: string, fileName: string, source: BlocklyCustomizationFileSource) => boolean;
}

export function createBlocklyFileCustomizationProvider<
  TConfig extends BlocklyFileCustomizationProviderConfigSource = BlocklyFileCustomizationProviderConfigSource,
>(options: BlocklyFileCustomizationProviderOptions<TConfig>): BlocklyFileCustomizationProvider {
  const { configSource } = options;
  let contributionSignature = serializeDiscoveredFiles(readDiscoveredFiles(options));
  const listeners = new Set<() => void>();
  const activeWatchers = new Map<string, CustomFileWatchSubscription>();
  let configSubscription: CustomFileConfigChangeSubscription | null = null;
  let refreshInProgress = false;
  let refreshQueued = false;

  const scheduleRefresh = () => {
    if (refreshInProgress) {
      refreshQueued = true;
      return;
    }

    refreshInProgress = true;
    try {
      do {
        refreshQueued = false;
        if (listeners.size === 0) {
          break;
        }

        refreshActiveWatchers();
        notifyListenersIfChanged();
      } while (refreshQueued);
    } finally {
      refreshInProgress = false;
    }
  };

  const notifyListenersIfChanged = () => {
    const nextSignature = serializeDiscoveredFiles(readDiscoveredFiles(options));
    if (nextSignature === contributionSignature) {
      return;
    }

    contributionSignature = nextSignature;
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };

  const refreshActiveWatchers = () => {
    const host = AilyHost.get();
    if (typeof host.fs?.watch !== 'function') {
      disposeCustomFileWatchers(activeWatchers);
      return;
    }

    const nextTargets = collectFileWatchTargets(options, host);
    const nextTargetKeys = new Set<string>();

    for (const targetPath of nextTargets) {
      const targetKey = normalizePathIdentity(targetPath, !!host.platform?.isWindows);
      nextTargetKeys.add(targetKey);
      if (activeWatchers.has(targetKey)) {
        continue;
      }

      try {
        const subscription = host.fs.watch(targetPath, () => {
          scheduleRefresh();
        });
        if (subscription) {
          activeWatchers.set(targetKey, subscription);
        }
      } catch {
        // Ignore unsupported or transient watch failures; read-side refresh remains authoritative.
      }
    }

    for (const [targetKey, subscription] of Array.from(activeWatchers.entries())) {
      if (nextTargetKeys.has(targetKey)) {
        continue;
      }

      disposeCustomFileWatchSubscription(subscription);
      activeWatchers.delete(targetKey);
    }
  };

  const attachChangeSources = () => {
    refreshActiveWatchers();
    if (!configSubscription && configSource?.configChanged$) {
      configSubscription = configSource.configChanged$.subscribe(() => {
        scheduleRefresh();
      });
    }
  };

  const detachChangeSources = () => {
    configSubscription?.unsubscribe();
    configSubscription = null;
    disposeCustomFileWatchers(activeWatchers);
  };

  const hasLiveChangeSource = !!configSource?.configChanged$ || typeof AilyHost.get().fs?.watch === 'function';

  return {
    contributeFiles(): readonly BlocklyDiscoveredCustomizationFile[] {
      const files = readDiscoveredFiles(options);
      contributionSignature = serializeDiscoveredFiles(files);
      return files;
    },
    ...(hasLiveChangeSource ? {
      onFilesChanged(listener: () => void) {
        listeners.add(listener);
        if (listeners.size === 1) {
          attachChangeSources();
        }

        return {
          dispose() {
            listeners.delete(listener);
            if (listeners.size === 0) {
              detachChangeSources();
            }
          },
        };
      },
    } : {}),
  };
}

function collectFileWatchTargets<
  TConfig extends BlocklyFileCustomizationProviderConfigSource,
>(
  options: BlocklyFileCustomizationProviderOptions<TConfig>,
  host: ReturnType<typeof AilyHost.get>,
): string[] {
  const watchTargets: string[] = [];
  const seenTargets = new Set<string>();

  for (const folderPath of resolveCustomizationFolderPaths(options, host)) {
    for (const targetPath of resolveWatchTargetsForFolder(folderPath, host)) {
      const normalizedIdentity = normalizePathIdentity(targetPath, !!host.platform?.isWindows);
      if (seenTargets.has(normalizedIdentity)) {
        continue;
      }

      seenTargets.add(normalizedIdentity);
      watchTargets.push(targetPath);
    }
  }

  return watchTargets;
}

function resolveWatchTargetsForFolder(
  folderPath: string,
  host: ReturnType<typeof AilyHost.get>,
): string[] {
  const targets: string[] = [];
  const nearestExistingDirectory = findNearestExistingDirectory(folderPath, host);
  if (nearestExistingDirectory) {
    targets.push(nearestExistingDirectory);
  }

  try {
    if (host.fs?.existsSync?.(folderPath) && isDirectory(host, folderPath)) {
      targets.push(folderPath);
    }
  } catch {
    // Ignore missing folders while resolving watch targets.
  }

  return targets;
}

function findNearestExistingDirectory(
  folderPath: string,
  host: ReturnType<typeof AilyHost.get>,
): string | null {
  let currentPath = folderPath.trim();
  while (currentPath) {
    try {
      if (host.fs?.existsSync?.(currentPath) && isDirectory(host, currentPath)) {
        return currentPath;
      }
    } catch {
      // Ignore lookup failures and continue walking to the parent path.
    }

    const parentPath = host.path?.dirname?.(currentPath);
    if (!parentPath || parentPath === currentPath) {
      break;
    }

    currentPath = parentPath;
  }

  return null;
}

function disposeCustomFileWatchSubscription(subscription: CustomFileWatchSubscription): void {
  if (!subscription) {
    return;
  }

  if (typeof subscription.unsubscribe === 'function') {
    subscription.unsubscribe();
    return;
  }

  if (typeof subscription.dispose === 'function') {
    subscription.dispose();
    return;
  }

  subscription.close?.();
}

function disposeCustomFileWatchers(watchers: Map<string, CustomFileWatchSubscription>): void {
  for (const subscription of watchers.values()) {
    disposeCustomFileWatchSubscription(subscription);
  }
  watchers.clear();
}

function readDiscoveredFiles<
  TConfig extends BlocklyFileCustomizationProviderConfigSource,
>(
  options: BlocklyFileCustomizationProviderOptions<TConfig>,
): BlocklyDiscoveredCustomizationFile[] {
  const host = AilyHost.get();
  const folderPaths = resolveCustomizationFolderPaths(options, host);
  const discovered: BlocklyDiscoveredCustomizationFile[] = [];

  for (const folderPath of folderPaths) {
    if (!folderPath || !host.fs?.existsSync?.(folderPath)) {
      continue;
    }

    try {
      if (!isDirectory(host, folderPath)) {
        continue;
      }
    } catch {
      continue;
    }

    for (const entryName of listDirectoryFileNames(host, folderPath)) {
      if (!options.shouldIncludeFile(folderPath, entryName, options.source)) {
        continue;
      }

      const filePath = host.path?.join?.(folderPath, entryName) ?? `${folderPath}/${entryName}`;
      try {
        if (!isFile(host, filePath)) {
          continue;
        }

        const content = host.fs.readFileSync(filePath, 'utf-8');
        discovered.push({
          name: entryName,
          content,
          uri: toFileUri(filePath),
        });
      } catch (error) {
        console.warn('[createBlocklyFileCustomizationProvider] Failed to read customization file:', filePath, error);
      }
    }
  }

  return discovered;
}

function resolveCustomizationFolderPaths<
  TConfig extends BlocklyFileCustomizationProviderConfigSource,
>(
  options: BlocklyFileCustomizationProviderOptions<TConfig>,
  host: ReturnType<typeof AilyHost.get>,
): string[] {
  const isUserSource = options.source === 'user';
  const configuredFolders = normalizeFolderList(options.resolveConfiguredFolders?.(options.configSource, options.source));
  const homePath = getUserHome(host);
  const projectRootPath = options.projectRootPath ?? host.project?.projectRootPath ?? host.project?.currentProjectPath ?? '';
  const normalizedIdentity = new Set<string>();
  const resolvedFolders: string[] = [];

  for (const folder of [...options.defaultFolders, ...configuredFolders]) {
    const resolvedFolder = resolveFolderPath(folder, { isUserSource, homePath, projectRootPath, host });
    if (!resolvedFolder) {
      continue;
    }

    const identity = normalizePathIdentity(resolvedFolder, !!host.platform?.isWindows);
    if (normalizedIdentity.has(identity)) {
      continue;
    }

    normalizedIdentity.add(identity);
    resolvedFolders.push(resolvedFolder);
  }

  return resolvedFolders;
}

function normalizeFolderList(value: readonly string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

function resolveFolderPath(
  folder: string,
  context: {
    readonly isUserSource: boolean;
    readonly homePath: string;
    readonly projectRootPath: string;
    readonly host: ReturnType<typeof AilyHost.get>;
  },
): string | null {
  const trimmedFolder = folder.trim();
  if (!trimmedFolder) {
    return null;
  }

  const basePath = context.isUserSource ? context.homePath : context.projectRootPath;
  const relativePath = trimmedFolder.replace(/^~[\\/]/, '');

  if (trimmedFolder === '~') {
    return context.homePath || null;
  }

  if (/^~[\\/]/.test(trimmedFolder)) {
    return context.homePath
      ? context.host.path?.join?.(context.homePath, relativePath) ?? `${context.homePath}/${relativePath}`
      : null;
  }

  if (isAbsolutePath(context.host, trimmedFolder)) {
    return trimmedFolder;
  }

  if (!basePath) {
    return null;
  }

  return context.host.path?.join?.(basePath, trimmedFolder) ?? `${basePath}/${trimmedFolder}`;
}

function getUserHome(host: ReturnType<typeof AilyHost.get>): string {
  return host.path?.getUserHome?.() || host.platform?.homedir?.() || '';
}

function isAbsolutePath(host: ReturnType<typeof AilyHost.get>, value: string): boolean {
  if (host.path?.isAbsolute) {
    return host.path.isAbsolute(value);
  }

  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

function listDirectoryFileNames(host: ReturnType<typeof AilyHost.get>, folderPath: string): string[] {
  if (host.fs?.readDirSync) {
    return host.fs.readDirSync(folderPath)
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  return (host.fs?.readdirSync?.(folderPath) ?? [])
    .slice()
    .sort((left, right) => left.localeCompare(right));
}

function isDirectory(host: ReturnType<typeof AilyHost.get>, folderPath: string): boolean {
  if (host.fs?.isDirectory) {
    return host.fs.isDirectory(folderPath);
  }

  return !!host.fs?.statSync?.(folderPath)?.isDirectory?.();
}

function isFile(host: ReturnType<typeof AilyHost.get>, filePath: string): boolean {
  if (host.fs?.statSync) {
    return !!host.fs.statSync(filePath)?.isFile?.();
  }

  return true;
}

function toFileUri(filePath: string): string {
  const normalized = normalizeFilesystemPath(filePath);
  const encoded = encodeURI(normalized);

  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encoded}`;
  }

  if (normalized.startsWith('//')) {
    return `file:${encoded}`;
  }

  return normalized.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

function normalizeFilesystemPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '');
}

function normalizePathIdentity(value: string, isWindows: boolean): string {
  const normalized = normalizeFilesystemPath(value);
  return isWindows ? normalized.toLowerCase() : normalized;
}

function serializeDiscoveredFiles(files: readonly BlocklyDiscoveredCustomizationFile[]): string {
  return JSON.stringify(files.map(file => ({
    name: file.name,
    uri: file.uri,
    content: file.content,
  })));
}