export const PROJECT_ROOT_PATH_SETTING_CHANGED_ACTION = 'project-root-path-changed';

export interface ProjectRootPathContext {
  userDocuments: string;
  userHome: string;
  separator: string;
}

/**
 * 将默认配置中的跨平台占位路径展开为当前系统的实际路径。
 * 用户通过目录选择器设置的绝对路径保持原样。
 */
export function resolveConfiguredProjectRootPath(
  rawPath: unknown,
  context: ProjectRootPathContext,
): string {
  const configuredPath = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!configuredPath) {
    return '';
  }

  const documentsPrefix = configuredPath.match(/^%HOMEPATH%[\\/]Documents(?=$|[\\/])/i);
  if (documentsPrefix) {
    return appendPathSuffix(
      context.userDocuments,
      configuredPath.slice(documentsPrefix[0].length),
      context.separator,
    );
  }

  if (/^~(?=$|[\\/])/.test(configuredPath)) {
    return appendPathSuffix(context.userHome, configuredPath.slice(1), context.separator);
  }

  return configuredPath;
}

function appendPathSuffix(basePath: string, rawSuffix: string, separator: string): string {
  const suffix = rawSuffix
    .replace(/^[\\/]+/, '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(separator);
  return suffix ? `${basePath}${separator}${suffix}` : basePath;
}
