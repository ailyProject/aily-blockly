import { coerce, satisfies } from 'semver';

/**
 * 将主板 package.json 的 boardDependencies 解析为全局 aily-project（appdata）下的磁盘目录。
 * npm 声明版本（如 5.8.0）与 tools 下解压目录（如 ctags@5.8-arduino11）可能不一致，须扫描磁盘匹配。
 */
export type PlatformPackageKind = 'sdk' | 'compiler' | 'tool';

/** 树节点标题：tool-ctags@5.8.0（去掉 scope，保留包短名 + 版本） */
export function formatPlatformPackageDisplayLabel(
  packageName: string,
  version: string,
): string {
  const shortName = packageName.replace(/^@aily-project\//, '');
  const ver = String(version ?? '').trim();
  return ver ? `${shortName}@${ver}` : shortName;
}

export type PlatformPackageEntry = {
  /** 树节点稳定 id 片段，如 sdk-arduino_esp32 */
  id: string;
  /** 展示名，如 tool-ctags@5.8.0 */
  label: string;
  /** npm 包名，如 @aily-project/sdk-arduino_esp32 */
  packageName: string;
  version: string;
  kind: PlatformPackageKind;
  /** appdata/aily-project 下 sdk|tools 等目录中的绝对路径（已解析真实解压名） */
  absolutePath: string;
  /** tools/sdk 下实际文件夹名，如 ctags@5.8-arduino11 */
  diskDirName?: string;
};

const KIND_ORDER: Record<PlatformPackageKind, number> = {
  sdk: 0,
  compiler: 1,
  tool: 2,
};

/** 去掉 boardDependencies 中常见的 semver 范围前缀 */
function normalizeDeclaredVersion(declared: string): string {
  const raw = String(declared ?? '').trim();
  const c = coerce(raw);
  return c ? c.version : raw.replace(/^[\^~>=\s]+/, '');
}

/**
 * 工具解压目录版本段是否与 board 声明一致。
 * 例：声明 5.8.0 ↔ 磁盘 ctags@5.8-arduino11（Arduino 工具链在版本后追加 -arduinoNN 后缀）。
 */
function platformDirVersionMatchesDeclared(dirVersionPart: string, declared: string): boolean {
  const dirVer = String(dirVersionPart ?? '').trim();
  const decRaw = String(declared ?? '').trim();
  if (!dirVer || !decRaw) {
    return false;
  }
  const dec = normalizeDeclaredVersion(decRaw);
  if (!dec) {
    return false;
  }
  if (dirVer === dec || dirVer === decRaw) {
    return true;
  }
  if (dirVer.startsWith(`${dec}-`) || dirVer.startsWith(`${dec}_`)) {
    return true;
  }
  const dirSemver = coerce(dirVer.split('-arduino')[0]?.split('-')[0] ?? dirVer);
  const decSemver = coerce(dec);
  if (dirSemver && decSemver) {
    try {
      if (satisfies(dirSemver.version, `=${decSemver.version}`)) {
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  const dirBase = dirVer.split('-')[0];
  if (dirBase && (dec === dirBase || dec.startsWith(`${dirBase}.`))) {
    return true;
  }
  return false;
}

/** 多候选目录时优先：精确名 > 带 -arduino 后缀 > 其它 */
function scorePlatformDirMatch(dirName: string, declared: string): number {
  const dec = normalizeDeclaredVersion(declared);
  if (dirName === `${declared}` || dirName.endsWith(`@${dec}`)) {
    return 100;
  }
  if (dirName.includes('-arduino')) {
    return 80;
  }
  return 10;
}

function listSubdirNames(base: string): string[] {
  const pathApi = window['path'] as { isExists: (p: string) => boolean };
  const fsApi = window['fs'] as { readDirSync: (p: string) => Array<{ name?: string } | string> };
  if (!pathApi.isExists(base)) {
    return [];
  }
  try {
    return fsApi.readDirSync(base).map((d) => (typeof d === 'string' ? d : d.name || '')).filter(Boolean);
  } catch {
    return [];
  }
}

/** boardDependencies 声明对应的规范目录名（不含磁盘存在性检查） */
function canonicalPlatformPath(
  packageName: string,
  version: string,
  paths: { sdkBase: string; compilersBase: string; toolsBase: string },
): string | undefined {
  if (packageName.startsWith('@aily-project/compiler-')) {
    const shortName = packageName.replace(/^@aily-project\/compiler-/, '');
    return joinPath(paths.compilersBase, `${shortName}@${version}`);
  }
  if (packageName.startsWith('@aily-project/sdk-')) {
    const shortName = packageName.replace(/^@aily-project\/sdk-/, '');
    return joinPath(paths.sdkBase, `${shortName}_${version}`);
  }
  if (packageName.startsWith('@aily-project/tool-')) {
    let toolName = packageName.replace(/^@aily-project\/tool-/, '');
    if (toolName.startsWith('idf_')) {
      toolName = 'esp32-arduino-libs';
    }
    return joinPath(paths.toolsBase, `${toolName}@${version}`);
  }
  return undefined;
}

/**
 * 解析平台包在磁盘上的真实目录（优先规范路径，否则匹配 tools 下 avrdude@6.3.0-arduino17 等实际解压名）。
 */
export function resolvePlatformPackageDirOnDisk(
  packageName: string,
  declaredVersion: string,
  paths: {
    sdkBase: string;
    compilersBase: string;
    toolsBase: string;
  },
): string | undefined {
  const version = String(declaredVersion ?? '').trim();
  if (!version) {
    return undefined;
  }

  const canonical = canonicalPlatformPath(packageName, version, paths);
  if (canonical && window['path'].isExists(canonical)) {
    return canonical;
  }

  let base = '';
  let prefix = '';
  if (packageName.startsWith('@aily-project/compiler-')) {
    base = paths.compilersBase;
    prefix = `${packageName.replace(/^@aily-project\/compiler-/, '')}@`;
  } else if (packageName.startsWith('@aily-project/tool-')) {
    base = paths.toolsBase;
    let toolName = packageName.replace(/^@aily-project\/tool-/, '');
    if (toolName.startsWith('idf_')) {
      toolName = 'esp32-arduino-libs';
    }
    prefix = `${toolName}@`;
  } else {
    return undefined;
  }

  let bestPath: string | undefined;
  let bestScore = -1;
  for (const dirName of listSubdirNames(base)) {
    if (!dirName.startsWith(prefix)) {
      continue;
    }
    const full = joinPath(base, dirName);
    if (!window['path'].isExists(full)) {
      continue;
    }
    const verPart = dirName.slice(prefix.length);
    if (!platformDirVersionMatchesDeclared(verPart, version)) {
      continue;
    }
    const score = scorePlatformDirMatch(dirName, version);
    if (score > bestScore) {
      bestScore = score;
      bestPath = full;
    }
  }

  return bestPath;
}

/**
 * 根据 boardDependencies 条目计算平台包在磁盘上的目录绝对路径。
 */
export function resolvePlatformPackageEntries(
  boardDependencies: Record<string, string> | undefined | null,
  paths: {
    sdkBase: string;
    compilersBase: string;
    toolsBase: string;
  },
): PlatformPackageEntry[] {
  const entries: PlatformPackageEntry[] = [];
  if (!boardDependencies) {
    return entries;
  }

  for (const [key, rawVersion] of Object.entries(boardDependencies)) {
    const version = String(rawVersion ?? '').trim();
    if (!version) {
      continue;
    }

    const diskPath = resolvePlatformPackageDirOnDisk(key, version, paths);
    const fallbackPath = canonicalPlatformPath(key, version, paths);
    const absolutePath = diskPath ?? fallbackPath;
    const pathApi = window['path'] as { basename: (p: string) => string };
    const diskDirName = absolutePath ? pathApi.basename(absolutePath) : undefined;

    if (key.startsWith('@aily-project/compiler-')) {
      const shortName = key.replace(/^@aily-project\/compiler-/, '');
      entries.push({
        id: `compiler-${shortName}`,
        label: formatPlatformPackageDisplayLabel(key, version),
        packageName: key,
        version,
        kind: 'compiler',
        absolutePath: absolutePath ?? joinPath(paths.compilersBase, `${shortName}@${version}`),
        diskDirName,
      });
      continue;
    }

    if (key.startsWith('@aily-project/sdk-')) {
      const shortName = key.replace(/^@aily-project\/sdk-/, '');
      entries.push({
        id: `sdk-${shortName}`,
        label: formatPlatformPackageDisplayLabel(key, version),
        packageName: key,
        version,
        kind: 'sdk',
        absolutePath: absolutePath ?? joinPath(paths.sdkBase, `${shortName}_${version}`),
        diskDirName,
      });
      continue;
    }

    if (key.startsWith('@aily-project/tool-')) {
      let toolName = key.replace(/^@aily-project\/tool-/, '');
      if (toolName.startsWith('idf_')) {
        toolName = 'esp32-arduino-libs';
      }
      entries.push({
        id: `tool-${toolName}`,
        label: formatPlatformPackageDisplayLabel(key, version),
        packageName: key,
        version,
        kind: 'tool',
        absolutePath: absolutePath ?? joinPath(paths.toolsBase, `${toolName}@${version}`),
        diskDirName,
      });
    }
  }

  entries.sort((a, b) => {
    const ko = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (ko !== 0) {
      return ko;
    }
    return a.label.localeCompare(b.label);
  });

  return entries;
}

/** 读取当前工程主板 boardDependencies 并解析平台包列表（供 Coder 嵌入视图使用）。 */
export async function resolvePlatformPackagesForCurrentProject(
  getBoardDependencies: () => Promise<Record<string, string> | undefined>,
): Promise<PlatformPackageEntry[]> {
  const [boardDependencies, sdkBase, compilersBase, toolsBase] = await Promise.all([
    getBoardDependencies(),
    window['env'].get('AILY_SDK_PATH') as Promise<string>,
    window['env'].get('AILY_COMPILERS_PATH') as Promise<string>,
    window['env'].get('AILY_TOOLS_PATH') as Promise<string>,
  ]);

  return resolvePlatformPackageEntries(boardDependencies, {
    sdkBase,
    compilersBase,
    toolsBase,
  });
}

function joinPath(base: string, segment: string): string {
  const pathApi = window['path'] as { join: (...p: string[]) => string };
  return pathApi.join(base, segment);
}
