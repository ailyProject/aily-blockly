import {
  normalizeBoardModes,
  normalizeProjectMode,
} from './linux-board-project-route';

export const AILY_NPM_SCOPE = '@aily-project';
export const AILY_LINUX_NPM_SCOPE = '@aily-project-linux';
export const AILY_PACKAGE_SCOPES = [AILY_NPM_SCOPE, AILY_LINUX_NPM_SCOPE] as const;

export function isAilyLibraryPackageName(packageName: unknown): boolean {
  const normalized = typeof packageName === 'string' ? packageName.trim() : '';
  return AILY_PACKAGE_SCOPES.some((scope) => normalized.startsWith(`${scope}/lib-`));
}

export function isAilyCoreLibraryPackageName(packageName: unknown): boolean {
  const normalized = typeof packageName === 'string' ? packageName.trim() : '';
  return AILY_PACKAGE_SCOPES.some((scope) => normalized.startsWith(`${scope}/lib-core-`));
}

export function isAilyBoardPackageName(packageName: unknown): boolean {
  const normalized = typeof packageName === 'string' ? packageName.trim() : '';
  return AILY_PACKAGE_SCOPES.some((scope) => normalized.startsWith(`${scope}/board-`));
}

export function isAilyScopedPackageName(packageName: unknown): boolean {
  const normalized = typeof packageName === 'string' ? packageName.trim() : '';
  return AILY_PACKAGE_SCOPES.some((scope) => normalized.startsWith(`${scope}/`));
}

export interface LinuxDevelopmentSources {
  npm_registry?: string;
}

export function mergeBoardCatalogs(
  arduinoBoards: readonly any[],
  linuxBoards: readonly any[],
): any[] {
  const merged = new Map<string, any>();

  // 两类目录共同展示；按包名去重，并让已有 Arduino 条目保持优先，避免远端 Linux 目录意外覆盖旧板配置。
  for (const board of [...arduinoBoards, ...linuxBoards]) {
    const name = typeof board?.name === 'string' ? board.name.trim() : '';
    if (name && !merged.has(name)) {
      merged.set(name, board);
    }
  }

  return [...merged.values()];
}

export function isPythonProject(packageData: unknown): boolean {
  // 项目加载后只由 package.json.devmode 决定 Python/Arduino 资源与执行路径。
  return normalizeProjectMode(packageData) === 'python';
}

export function isPythonBoard(boardData: unknown): boolean {
  // 新建/切板尚无新项目清单时，使用 boards.json 的 mode 选择板包仓库。
  return normalizeBoardModes(boardData).includes('python');
}

export function selectLibraryCatalog<T>(
  packageData: unknown,
  arduinoCatalog: T,
  linuxCatalog: T,
): T {
  // Python 项目使用独立 libraries-linux.json；其余模式继续使用原 Arduino 库目录。
  return isPythonProject(packageData) ? linuxCatalog : arduinoCatalog;
}

export function appendScopedNpmRegistry(command: string, registry: unknown): string {
  const normalizedRegistry = String(registry || '').trim().replace(/\/+$/, '');
  // 仅覆盖 Aily 包作用域；未配置 Linux 仓库时原样保留 Arduino/全局 npm 行为。
  return normalizedRegistry
    ? `${command} --${AILY_LINUX_NPM_SCOPE}:registry="${normalizedRegistry}"`
    : command;
}
