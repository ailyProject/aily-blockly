/** platform 包内 platform.json 的 runtimeDependencies 条目 */
export interface PlatformRuntimeDependency {
  role?: string;
  package: string;
  version: string;
}

/** platform 包根目录 platform.json 结构（与 npm 包内文件一致） */
export interface PlatformManifest {
  id?: string;
  family?: string;
  framework?: string;
  version?: string;
  runtimeDependencies?: PlatformRuntimeDependency[];
  boardsIndex?: string;
  builderProfile?: Record<string, unknown>;
}

export interface PlatformPackageRef {
  /** npm 包名，如 @aily-project/platform-renesas_uno-micropython */
  packageName: string;
  /** 可选固定版本；未指定时安装 registry 最新并在 platform.json 中读取 version */
  version?: string;
}

/** runtimeDependencies → 与 Blockly boardDependencies 同构的 npm 声明表 */
export function runtimeDependenciesToBoardDependencies(
  runtimeDependencies: PlatformRuntimeDependency[] | undefined | null,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!Array.isArray(runtimeDependencies)) {
    return result;
  }
  for (const item of runtimeDependencies) {
    const pkg = String(item?.package ?? '').trim();
    const ver = String(item?.version ?? '').trim();
    if (pkg && ver) {
      result[pkg] = ver;
    }
  }
  return result;
}

function joinPath(...parts: string[]): string {
  const pathApi = window['path'] as { join: (...p: string[]) => string };
  return pathApi.join(...parts);
}

/** 从 AppData node_modules 中读取已安装 platform 包的 platform.json */
export function readPlatformManifestFromAppData(platformPackageName: string): PlatformManifest | null {
  const pathApi = window['path'] as { getAppDataPath: () => string; isExists: (p: string) => boolean };
  const fsApi = window['fs'] as { readFileSync: (p: string, enc: string) => string };
  if (!platformPackageName?.trim()) {
    return null;
  }
  const manifestPath = joinPath(
    pathApi.getAppDataPath(),
    'node_modules',
    platformPackageName,
    'platform.json',
  );
  if (!pathApi.isExists(manifestPath)) {
    return null;
  }
  try {
    return JSON.parse(fsApi.readFileSync(manifestPath, 'utf8')) as PlatformManifest;
  } catch {
    return null;
  }
}

/** 从 Coder 工程 package.json 解析 platform npm 包名与可选版本。 */
export function readPlatformRefFromProjectPackage(projectPath: string): PlatformPackageRef | null {
  const pathApi = window['path'] as { join: (...p: string[]) => string; isExists: (p: string) => boolean };
  const fsApi = window['fs'] as { readFileSync: (p: string, enc: string) => string };
  const packagePath = pathApi.join(projectPath, 'package.json');
  if (!pathApi.isExists(packagePath)) {
    return null;
  }
  try {
    const manifest = JSON.parse(fsApi.readFileSync(packagePath, 'utf8'));
    if (manifest?.type !== 'coder') {
      return null;
    }
    const packageName = String(manifest?.platform ?? '').trim();
    if (!packageName) {
      return null;
    }
    const version = String(manifest?.platformVersion ?? '').trim();
    return { packageName, ...(version ? { version } : {}) };
  } catch {
    return null;
  }
}

/** 合并主板 boardDependencies 与 platform runtimeDependencies（后者覆盖同名键） */
export function mergeBoardDependencies(
  boardDependencies: Record<string, string> | undefined | null,
  platformRuntimeDeps: Record<string, string>,
): Record<string, string> {
  return {
    ...(boardDependencies || {}),
    ...platformRuntimeDeps,
  };
}

/**
 * 解析 Aily Code 工程最终应安装/检查的平台依赖（board + platform.json runtimeDependencies）。
 * platform 包须已安装到 AppData node_modules。
 */
export function resolveEffectiveBoardDependencies(
  boardDependencies: Record<string, string> | undefined | null,
  platformPackageName: string | undefined | null,
): Record<string, string> {
  const base = { ...(boardDependencies || {}) };
  const platformName = String(platformPackageName ?? '').trim();
  if (!platformName) {
    return base;
  }
  const manifest = readPlatformManifestFromAppData(platformName);
  const runtimeDeps = runtimeDependenciesToBoardDependencies(manifest?.runtimeDependencies);
  return mergeBoardDependencies(base, runtimeDeps);
}
