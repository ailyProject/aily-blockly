
export async function getDefaultBuildPath(sketchFilePath: string): Promise<string> {
    if (sketchFilePath) {
        const projectPath = window['path'].resolve(window['path'].dirname(sketchFilePath), '..', '..');
        return window['path'].join(projectPath, '.build');
    }

    console.log("sketchFilePath: ", sketchFilePath);
    const sketchMd5Value = await window["tools"].calculateMD5(window['path'].resolve(sketchFilePath));
    const sketchMd5 = sketchMd5Value.slice(0, 8);
    const sketchName = window['path'].basename(sketchFilePath, '.ino');
    // 使用跨平台的路径拼接方式
    return window['path'].join(window['path'].getAilyBuilderPath(), `${sketchName}_${sketchMd5}`);
}

/**
   * 文件查找
   */
export async function findFile(basePath: string, fileName: string, version: string = ''): Promise<string> {
    // 先判断basePath是否存在
    if (!window['fs'].existsSync(basePath)) {
        console.warn(`路径不存在: ${basePath}`);
        return '';
    }

    // 保持原始fileName，不进行*替换，让底层工具处理通配符
    const findRes = await window['tools'].findFileByName(basePath, fileName);
    console.log(`find ${fileName} in tools: `, findRes);

    let filteredRes = findRes;

    // 如果传入的是 *.bin 这样的模式，过滤结果只返回确切匹配的文件
    if (fileName.includes('*')) {
        // 将通配符模式转换为正则表达式
        const pattern = fileName.replace(/\*/g, '([^.]+)').replace(/\./g, '\\.');
        const regex = new RegExp(`^${pattern}$`);

        filteredRes = findRes.filter((filePath: string) => {
            const baseName = window['path'].basename(filePath);
            return regex.test(baseName);
        });
    } else {
        // 没有通配符时，进行全字匹配
        filteredRes = findRes.filter((filePath: string) => {
            const baseName = window['path'].basename(filePath);
            return baseName === fileName;
        });
    }

    // 如果有version参数且结果包含多个文件，优先返回路径中包含version的文件
    if (version && filteredRes.length > 1) {
        const versionMatched = filteredRes.filter((filePath: string) => {
            return filePath.includes(version);
        });
        
        if (versionMatched.length > 0) {
            return versionMatched[0];
        }
    }

    return filteredRes[0] || '';
}

/** 编译产物条目（供 Coder 虚拟树与 hints 使用） */
export interface BuildArtifactV1 {
  label: string;
  abs: string;
  rel?: string;
}

/** 按展示顺序解析的固件/产物文件名（精确匹配优先） */
const BUILD_ARTIFACT_EXACT_NAMES = [
  'main.hex',
  'main.bin',
  'main.bootloader.bin',
  'main.partitions.bin',
] as const;

/** 与 upload.js 一致：ESP32 等板卡常见通配符命名 */
const BUILD_ARTIFACT_GLOB_PATTERNS = ['*.bootloader.bin', '*.partitions.bin'] as const;

/**
 * 在编译输出目录中按文件名解析单个产物：根目录直连后再递归查找。
 */
export async function resolveBuildArtifactAbsolutePath(
  buildPath: string,
  fileName: string
): Promise<string | undefined> {
  if (!buildPath?.trim() || !fileName?.trim()) {
    return undefined;
  }
  if (!window['fs'].existsSync(buildPath)) {
    return undefined;
  }
  const direct = window['path'].join(buildPath, fileName);
  if (window['fs'].existsSync(direct)) {
    return direct;
  }
  const found = await findFile(buildPath, fileName);
  return found && found.length > 0 ? found : undefined;
}

/**
 * 在编译输出目录中解析 main.hex：根目录直连后再递归查找（与烧录前解析产物一致）。
 */
export async function resolveMainHexAbsolutePath(buildPath: string): Promise<string | undefined> {
  return resolveBuildArtifactAbsolutePath(buildPath, 'main.hex');
}

/**
 * 通配符查找编译目录下全部匹配文件（去重、按路径排序）。
 */
export async function findAllFiles(basePath: string, fileNamePattern: string): Promise<string[]> {
  if (!basePath?.trim() || !fileNamePattern?.trim()) {
    return [];
  }
  if (!window['fs'].existsSync(basePath)) {
    return [];
  }
  const findRes = await window['tools'].findFileByName(basePath, fileNamePattern);
  let filteredRes = findRes;
  if (fileNamePattern.includes('*')) {
    const pattern = fileNamePattern.replace(/\*/g, '([^.]+)').replace(/\./g, '\\.');
    const regex = new RegExp(`^${pattern}$`);
    filteredRes = findRes.filter((filePath: string) => {
      const baseName = window['path'].basename(filePath);
      return regex.test(baseName);
    });
  } else {
    filteredRes = findRes.filter((filePath: string) => {
      return window['path'].basename(filePath) === fileNamePattern;
    });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of filteredRes) {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * 扫描单个 build 目录内全部已知产物（hex / bin / bootloader / partitions）。
 */
export async function resolveBuildArtifactsInDirectory(
  buildPath: string
): Promise<Array<{ label: string; abs: string }>> {
  if (!buildPath?.trim() || !window['fs'].existsSync(buildPath)) {
    return [];
  }
  const seen = new Set<string>();
  const out: Array<{ label: string; abs: string }> = [];

  const push = (label: string, abs: string | undefined) => {
    if (!abs || seen.has(abs)) {
      return;
    }
    seen.add(abs);
    out.push({ label, abs });
  };

  for (const name of BUILD_ARTIFACT_EXACT_NAMES) {
    push(name, await resolveBuildArtifactAbsolutePath(buildPath, name));
  }

  for (const pattern of BUILD_ARTIFACT_GLOB_PATTERNS) {
    const hits = await findAllFiles(buildPath, pattern);
    for (const abs of hits) {
      push(window['path'].basename(abs), abs);
    }
  }

  return out;
}

/** 将绝对路径转为相对工程根路径（工作区外则 undefined） */
export function workspaceRelPathFromAbs(
  projectRoot: string,
  absPath: string
): string | undefined {
  const pathApi = window['path'] as {
    relative: (from: string, to: string) => string;
    sep: string;
  };
  const relRaw = pathApi.relative(projectRoot, absPath);
  if (relRaw.startsWith('..') || relRaw.includes('..')) {
    return undefined;
  }
  return relRaw.split(pathApi.sep).join('/');
}

/**
 * aily-builder 实际子目录命名规则：`<basenameWithoutExt>_<md5(sourceAbs).slice(0,8)>`。
 * 与 `getDefaultBuildPath` 区别：basename 去掉所有扩展名（兼容 .ino / .cpp 等多种入口）。
 */
export async function getAilyBuilderBuildDir(sketchFilePath: string): Promise<string> {
  const md5 = (await window['tools'].calculateMD5(window['path'].resolve(sketchFilePath))).slice(0, 8);
  const sketchName = window['path'].basename(sketchFilePath).replace(/\.[^.]+$/, '');
  return window['path'].join(window['path'].getAilyBuilderBuildPath(), `${sketchName}_${md5}`);
}

/**
 * 解析工程实际使用的 build 目录（与 compile.js 候选入口一致）。
 */
async function resolveEffectiveBuildDirectory(
  projectRoot: string,
  primaryBuildPath: string
): Promise<string> {
  const fsApi = window['fs'] as { existsSync?: (p: string) => boolean } | undefined;
  const pathApi = window['path'] as {
    join: (...s: string[]) => string;
    getAilyBuilderBuildPath?: () => string;
  } | undefined;

  const primaryArtifacts = await resolveBuildArtifactsInDirectory(primaryBuildPath);
  if (primaryArtifacts.length > 0) {
    return primaryBuildPath;
  }

  const globalRoot = pathApi?.getAilyBuilderBuildPath?.();
  if (globalRoot && fsApi?.existsSync?.(globalRoot) && pathApi) {
    const sketchCandidates = [
      pathApi.join(projectRoot, 'sketch', 'src', 'main.cpp'),
      pathApi.join(projectRoot, '.temp', 'sketch', 'sketch.ino'),
    ];
    for (const sketchPath of sketchCandidates) {
      if (!fsApi.existsSync?.(sketchPath)) {
        continue;
      }
      try {
        const candidateDir = await getAilyBuilderBuildDir(sketchPath);
        const found = await resolveBuildArtifactsInDirectory(candidateDir);
        if (found.length > 0) {
          return candidateDir;
        }
      } catch {
        /* 计算失败继续下一个候选 */
      }
    }
  }

  return primaryBuildPath;
}

/**
 * 工程层面解析全部编译产物：优先项目 buildPath，否则回探 aily-builder 缓存子目录。
 */
export async function resolveActualBuildOutputs(
  projectRoot: string,
  primaryBuildPath: string
): Promise<{ buildPath: string; artifacts: BuildArtifactV1[] }> {
  const buildPath = await resolveEffectiveBuildDirectory(projectRoot, primaryBuildPath);
  const raw = await resolveBuildArtifactsInDirectory(buildPath);
  const artifacts: BuildArtifactV1[] = raw.map((item) => ({
    label: item.label,
    abs: item.abs,
    rel: workspaceRelPathFromAbs(projectRoot, item.abs),
  }));
  return { buildPath, artifacts };
}

/**
 * 工程层面解析 main.hex 真实落点：优先项目预期 buildPath，否则按 aily-builder 实际命名回探缓存子目录。
 * 候选 sketch 入口与 compile.js 一致：Coder -> `sketch/src/main.cpp`；Blockly -> `.temp/sketch/sketch.ino`。
 */
export async function resolveActualMainHexLocation(
  projectRoot: string,
  primaryBuildPath: string
): Promise<{ abs?: string; buildPath: string }> {
  const { buildPath, artifacts } = await resolveActualBuildOutputs(projectRoot, primaryBuildPath);
  const hex = artifacts.find((a) => a.label === 'main.hex');
  return { abs: hex?.abs, buildPath };
}
