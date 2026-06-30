import { AilyHost } from './host';

export interface ChatRuntimeWorkspaceEnvironment {
  readonly currentSessionId: string;
  readonly currentSessionPath: string;
  readonly currentProjectPath: string;
  readonly projectRootPath: string;
  readonly projectPath: string;
}

let runtimeWorkspaceEnvironmentOverride: {
  readonly cwd: string;
  readonly sessionId?: string;
} | null = null;

export function setChatRuntimeWorkspaceEnvironmentOverride(input: {
  cwd?: string | null;
  sessionId?: string | null;
} | null | undefined): void {
  const cwd = normalizePath(input?.cwd);
  const sessionId = normalizePath(input?.sessionId);
  runtimeWorkspaceEnvironmentOverride = cwd
    ? {
      cwd,
      ...(sessionId ? { sessionId } : {}),
    }
    : null;
}

export function readChatRuntimeWorkspaceEnvironment(): ChatRuntimeWorkspaceEnvironment {
  const currentSessionId = runtimeWorkspaceEnvironmentOverride?.sessionId || '';
  const currentSessionPath = runtimeWorkspaceEnvironmentOverride?.cwd || '';
  const currentProjectPath = currentSessionPath || normalizePath(AilyHost.get().project?.currentProjectPath);
  const projectRootPath = normalizePath(AilyHost.get().project?.projectRootPath);
  const activeProjectPath = currentProjectPath && !isSamePath(currentProjectPath, projectRootPath)
    ? currentProjectPath
    : '';
  return {
    currentSessionId,
    currentSessionPath,
    currentProjectPath: activeProjectPath,
    projectRootPath,
    projectPath: activeProjectPath,
  };
}

function normalizePath(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    : '';
}

function isSamePath(left: string, right: string): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.toLowerCase() === right.toLowerCase();
}
