export type AilyNpmAction = 'install' | 'uninstall';
export type AilyNpmTargetKind = 'library' | 'board';

export interface AilyNpmCommandDisplayInfo {
  action: AilyNpmAction;
  kind: AilyNpmTargetKind;
  packageName: string;
  displayName: string;
  label: string;
  startText: string;
  successText: string;
  retryText: string;
  failureText: string;
}

const ACTION_ALIASES: Record<string, AilyNpmAction | undefined> = {
  install: 'install',
  i: 'install',
  uninstall: 'uninstall',
  remove: 'uninstall',
};

const COMMAND_SEPARATORS = new Set(['&&', '||', '&', ';', '|']);

const LIB_PREFIX = '@aily-project/lib-';
const BOARD_PREFIX = '@aily-project/board-';

export function parseAilyScopedNpmCommand(command?: string): AilyNpmCommandDisplayInfo | null {
  if (!command) {
    return null;
  }

  const tokens = command.match(/"[^"]*"|'[^']*'|&&|\|\||[;&|]|\S+/g) ?? [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = normalizeToken(tokens[index]);
    if (!isNpmToken(token)) {
      continue;
    }

    const actionToken = normalizeToken(tokens[index + 1]);
    const action = ACTION_ALIASES[actionToken.toLowerCase()];
    if (!action) {
      continue;
    }

    const packageSpec = findScopedPackageToken(tokens, index + 2);
    if (!packageSpec) {
      continue;
    }

    const packageName = stripPackageVersion(packageSpec);
    if (packageName.startsWith(LIB_PREFIX)) {
      return buildDisplayInfo(action, 'library', packageName, packageName.slice(LIB_PREFIX.length));
    }

    if (packageName.startsWith(BOARD_PREFIX)) {
      return buildDisplayInfo(action, 'board', packageName, packageName.slice(BOARD_PREFIX.length));
    }
  }

  return null;
}

function buildDisplayInfo(
  action: AilyNpmAction,
  kind: AilyNpmTargetKind,
  packageName: string,
  displayName: string,
): AilyNpmCommandDisplayInfo {
  const label = `${displayName}${kind === 'library' ? ' 库' : ' 开发板'}`;
  const actionText = action === 'install' ? '安装 ' : '删除 ';

  return {
    action,
    kind,
    packageName,
    displayName,
    label,
    startText: `正在${actionText}${label}`,
    successText: `已${actionText}${label}`,
    retryText: `${label}${actionText}异常, 即将重试`,
    failureText: `${label}${actionText}失败`,
  };
}

function stripTrailingSeparators(token: string): string {
  return token.replace(/[;&|]+$/, '');
}

function stripWrappingQuotes(token: string): string {
  return token.replace(/^['"]|['"]$/g, '');
}

function normalizeToken(token?: string): string {
  return stripWrappingQuotes(stripTrailingSeparators(token || ''));
}

function isNpmToken(token: string): boolean {
  return /^(?:npm|npm\.cmd)$/i.test(token);
}

function findScopedPackageToken(tokens: string[], startIndex: number): string | null {
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = normalizeToken(tokens[index]);
    if (!token) {
      continue;
    }
    if (COMMAND_SEPARATORS.has(token)) {
      return null;
    }
    if (/^@aily-project\/(?:lib|board)-/i.test(token)) {
      return token;
    }
  }

  return null;
}

function stripPackageVersion(packageSpec: string): string {
  const scopedMatch = packageSpec.match(/^(@[^/]+\/[^@]+)(?:@.+)?$/);
  if (scopedMatch) {
    return scopedMatch[1];
  }

  return packageSpec.replace(/@[^@]+$/, '');
}