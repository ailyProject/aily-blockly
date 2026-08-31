export interface GlobalDependencyCleanupPathApi {
  resolve(path: string): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
  basename(path: string): string;
}

export interface GlobalDependencyCleanupFsApi {
  readdir(path: string): Promise<string[]>;
  rm(path: string, options: {
    recursive: boolean;
    force: boolean;
    maxRetries: number;
    retryDelay: number;
  }): Promise<void>;
}

export interface GlobalDependencyCleanupOptions {
  appDataPath: string;
  resourceBasePaths: string[];
  pathApi: GlobalDependencyCleanupPathApi;
  fsApi: GlobalDependencyCleanupFsApi;
}

export interface GlobalDependencyResourceEntry {
  /** Stable, AppData-relative identity, for example sdk/esp32_3.3.11. */
  key: string;
  absolutePath: string;
}

export interface GlobalDependencyUsageState {
  version: 2;
  dependencies: Record<string, number>;
  resources: Record<string, number>;
}

const MANAGED_RESOURCE_DIRECTORIES = new Set(['sdk', 'tools']);

/**
 * Reconcile persisted usage with the resources currently on disk. Newly
 * discovered resources receive `now`, which is a conservative migration for
 * version-1 usage files that did not track resource versions.
 */
export function reconcileGlobalDependencyUsage(
  current: Pick<GlobalDependencyUsageState, 'dependencies' | 'resources'>,
  dependencyNames: string[],
  resourceKeys: string[],
  now: number,
): GlobalDependencyUsageState {
  const dependencies: Record<string, number> = {};
  const resources: Record<string, number> = {};
  for (const name of dependencyNames) {
    dependencies[name] = current.dependencies[name] || now;
  }
  for (const key of resourceKeys) {
    resources[key] = current.resources[key] || now;
  }
  return { version: 2, dependencies, resources };
}

/**
 * Remove every extracted global SDK/compiler/tool resource while preserving the
 * managed base directories themselves. Resource package uninstall scripts can
 * only see their currently installed version, so this final sweep is required
 * to remove orphaned versions left by upgrades or interrupted uninstalls.
 */
export async function clearGlobalDependencyResourceDirectories(
  options: GlobalDependencyCleanupOptions,
): Promise<string[]> {
  const { appDataPath, pathApi, fsApi } = options;
  const appDataRoot = pathApi.resolve(appDataPath);
  const uniqueBasePaths = new Map<string, string>();

  for (const rawBasePath of options.resourceBasePaths) {
    const basePath = pathApi.resolve(String(rawBasePath || ''));
    assertManagedResourceBase(appDataRoot, basePath, pathApi);
    uniqueBasePaths.set(normalizePathKey(basePath), basePath);
  }

  const removedPaths: string[] = [];
  for (const basePath of uniqueBasePaths.values()) {
    removedPaths.push(...await removeMatchingEntries(basePath, () => true, pathApi, fsApi));
  }

  return removedPaths;
}

/**
 * List every directly managed SDK/compiler/tool resource. Directory keys are
 * persisted in dependency-usage.json so different versions of the same npm
 * package can have independent last-used timestamps.
 */
export async function listGlobalDependencyResources(
  options: GlobalDependencyCleanupOptions,
): Promise<GlobalDependencyResourceEntry[]> {
  const { appDataPath, pathApi, fsApi } = options;
  const appDataRoot = pathApi.resolve(appDataPath);
  const uniqueBasePaths = new Map<string, string>();
  for (const rawBasePath of options.resourceBasePaths) {
    const basePath = pathApi.resolve(String(rawBasePath || ''));
    assertManagedResourceBase(appDataRoot, basePath, pathApi);
    uniqueBasePaths.set(normalizePathKey(basePath), basePath);
  }

  const resources: GlobalDependencyResourceEntry[] = [];
  for (const basePath of uniqueBasePaths.values()) {
    const baseName = pathApi.basename(basePath).toLowerCase();
    for (const entry of await readDirectoryIfPresent(basePath, fsApi)) {
      resources.push({
        key: `${baseName}/${entry}`,
        absolutePath: pathApi.join(basePath, entry),
      });
    }
  }
  return resources;
}

/** Delete only the exact resource versions selected by 30/90-day cleanup. */
export async function clearGlobalDependencyResources(
  options: GlobalDependencyCleanupOptions & { resourceKeys: string[] },
): Promise<string[]> {
  const requestedKeys = new Set(options.resourceKeys.map(normalizeResourceKey));
  if (requestedKeys.size === 0) {
    return [];
  }

  const resources = await listGlobalDependencyResources(options);
  const removedPaths: string[] = [];
  for (const resource of resources) {
    if (!requestedKeys.has(normalizeResourceKey(resource.key))) {
      continue;
    }
    await removeResourcePath(resource.absolutePath, options.fsApi);
    removedPaths.push(resource.absolutePath);
  }

  const remainingKeys = new Set(
    (await listGlobalDependencyResources(options)).map((resource) => normalizeResourceKey(resource.key)),
  );
  const failedKeys = Array.from(requestedKeys).filter((key) => remainingKeys.has(key));
  if (failedKeys.length > 0) {
    throw new Error(`Global dependency cleanup incomplete: ${failedKeys.join(', ')}`);
  }

  return removedPaths;
}

async function removeMatchingEntries(
  basePath: string,
  matches: (entry: string) => boolean,
  pathApi: GlobalDependencyCleanupPathApi,
  fsApi: GlobalDependencyCleanupFsApi,
): Promise<string[]> {
  const entries = await readDirectoryIfPresent(basePath, fsApi);
  const matchingEntries = entries.filter(matches);
  const removedPaths: string[] = [];

  for (const entry of matchingEntries) {
    const targetPath = pathApi.join(basePath, entry);
    await removeResourcePath(targetPath, fsApi);
    removedPaths.push(targetPath);
  }

  const remainingEntries = (await readDirectoryIfPresent(basePath, fsApi)).filter(matches);
  if (remainingEntries.length > 0) {
    throw new Error(
      `Global dependency cleanup incomplete in ${basePath}: ${remainingEntries.join(', ')}`,
    );
  }

  return removedPaths;
}

async function removeResourcePath(
  targetPath: string,
  fsApi: GlobalDependencyCleanupFsApi,
): Promise<void> {
  await fsApi.rm(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 300,
  });
}

function assertManagedResourceBase(
  appDataRoot: string,
  basePath: string,
  pathApi: GlobalDependencyCleanupPathApi,
): void {
  const relativePath = pathApi.relative(appDataRoot, basePath);
  const pathSegments = relativePath.split(/[\\/]+/).filter(Boolean);
  const isDirectChild =
    relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !pathApi.isAbsolute(relativePath) &&
    pathSegments.length === 1;
  const baseName = pathApi.basename(basePath).toLowerCase();

  if (!isDirectChild || !MANAGED_RESOURCE_DIRECTORIES.has(baseName)) {
    throw new Error(`Unsafe global dependency resource path: ${basePath}`);
  }
}

async function readDirectoryIfPresent(
  path: string,
  fsApi: GlobalDependencyCleanupFsApi,
): Promise<string[]> {
  try {
    return await fsApi.readdir(path);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function normalizePathKey(path: string): string {
  return path.replace(/[\\/]+$/, '').toLowerCase();
}

function normalizeResourceKey(key: string): string {
  return String(key || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}
