export type ChatSessionScopeKind = 'global' | 'project';

export interface GlobalChatSessionScope {
  readonly kind: 'global';
  readonly projectPath: null;
  readonly projectRootPath: string | null;
}

export interface ProjectChatSessionScope {
  readonly kind: 'project';
  readonly projectPath: string;
  readonly projectRootPath: string | null;
}

export type ChatSessionScope = GlobalChatSessionScope | ProjectChatSessionScope;

export interface ChatSessionProjectLike {
  readonly currentProjectPath?: string | null;
  readonly projectRootPath?: string | null;
}

export function normalizeChatSessionScopePath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') {
    return null;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function isSameChatSessionScopePath(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeChatSessionScopePath(left);
  const normalizedRight = normalizeChatSessionScopePath(right);
  if (!normalizedLeft || !normalizedRight) {
    return normalizedLeft === normalizedRight;
  }

  return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

export function resolveChatSessionScopeFromProject(project: ChatSessionProjectLike | null | undefined): ChatSessionScope {
  const currentProjectPath = normalizeChatSessionScopePath(project?.currentProjectPath);
  const projectRootPath = normalizeChatSessionScopePath(project?.projectRootPath);

  if (!currentProjectPath || isSameChatSessionScopePath(currentProjectPath, projectRootPath)) {
    return {
      kind: 'global',
      projectPath: null,
      projectRootPath,
    };
  }

  return {
    kind: 'project',
    projectPath: currentProjectPath,
    projectRootPath,
  };
}

export function createGlobalChatSessionScope(projectRootPath?: string | null): GlobalChatSessionScope {
  return {
    kind: 'global',
    projectPath: null,
    projectRootPath: normalizeChatSessionScopePath(projectRootPath),
  };
}

export function createProjectChatSessionScope(projectPath: string, projectRootPath?: string | null): ChatSessionScope {
  const normalizedProjectPath = normalizeChatSessionScopePath(projectPath);
  const normalizedProjectRootPath = normalizeChatSessionScopePath(projectRootPath);
  if (!normalizedProjectPath || isSameChatSessionScopePath(normalizedProjectPath, normalizedProjectRootPath)) {
    return createGlobalChatSessionScope(normalizedProjectRootPath);
  }

  return {
    kind: 'project',
    projectPath: normalizedProjectPath,
    projectRootPath: normalizedProjectRootPath,
  };
}

export function chatSessionScopeProjectPath(scope: ChatSessionScope): string | null {
  return scope.kind === 'project' ? scope.projectPath : null;
}

export function chatSessionScopeCacheKey(scope: ChatSessionScope): string {
  const projectPath = normalizeChatSessionScopePath(scope.projectPath);
  const projectRootPath = normalizeChatSessionScopePath(scope.projectRootPath);
  return [
    scope.kind,
    projectPath?.toLowerCase() ?? '',
    projectRootPath?.toLowerCase() ?? '',
  ].join('|');
}
