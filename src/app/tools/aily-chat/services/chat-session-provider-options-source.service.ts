import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

import type { ChatSessionProviderOptionCommand } from '../core/chat-mode';
import { AilyHost } from '../core/host';
import type { IFileSystem } from '../core/host-api';
import { runHostGitCommand } from '../helpers/git-host-command';

const OPEN_REPOSITORY_COMMAND_ID = 'aily.agent.sessions.openRepository';

export type ChatSessionProviderOptionsSourceRepositoryKind = 'repository' | 'folder';

export type ChatSessionProviderOptionsSourceSubscription =
  | { dispose?: () => void; unsubscribe?: () => void }
  | (() => void)
  | void;

export interface ChatSessionProviderOptionsSourceRepository {
  readonly path: string;
  readonly label: string;
  readonly kind: ChatSessionProviderOptionsSourceRepositoryKind;
  readonly branches: readonly string[];
  readonly currentBranch?: string;
}

export interface ChatSessionProviderOptionsSourceSnapshot {
  readonly repositories: readonly ChatSessionProviderOptionsSourceRepository[];
  readonly supportsWorktree: boolean;
  readonly repositoryCommands?: readonly ChatSessionProviderOptionCommand[];
}

export interface ChatSessionProviderOptionsSourceContext {
  readonly workspacePath?: string | null;
  readonly projectPath?: string | null;
  readonly projectRootPath?: string | null;
}

export interface ChatSessionProviderOptionsSource {
  getSnapshot(): ChatSessionProviderOptionsSourceSnapshot | null;
  refresh?(context?: ChatSessionProviderOptionsSourceContext): Promise<void> | void;
  onDidChange?(listener: () => void): ChatSessionProviderOptionsSourceSubscription;
}

export interface ChatSessionProviderOptionsSourceBinding {
  readonly sessionType?: string;
  readonly source: ChatSessionProviderOptionsSource;
}

@Injectable({ providedIn: 'root' })
export class AilyAgentSessionProviderOptionsSourceService implements ChatSessionProviderOptionsSource {
  private readonly didChangeSubject = new Subject<void>();
  private snapshotState: ChatSessionProviderOptionsSourceSnapshot | null = null;
  private workspaceKey = '';
  private refreshGeneration = 0;

  getSnapshot(): ChatSessionProviderOptionsSourceSnapshot | null {
    return this.snapshotState;
  }

  onDidChange(listener: () => void): ChatSessionProviderOptionsSourceSubscription {
    return this.didChangeSubject.subscribe(listener);
  }

  async refresh(context?: ChatSessionProviderOptionsSourceContext): Promise<void> {
    const workspacePath = this.resolveWorkspacePath(context);
    const nextWorkspaceKey = workspacePath ?? '';
    const generation = ++this.refreshGeneration;
    const nextSnapshot = workspacePath
      ? await this.loadSnapshot(workspacePath)
      : null;
    if (generation !== this.refreshGeneration) {
      return;
    }

    if (this.workspaceKey === nextWorkspaceKey && this.areSnapshotsEqual(this.snapshotState, nextSnapshot)) {
      return;
    }

    this.workspaceKey = nextWorkspaceKey;
    this.snapshotState = nextSnapshot;
    this.didChangeSubject.next();
  }

  private resolveWorkspacePath(context?: ChatSessionProviderOptionsSourceContext): string | null {
    const candidates = [
      context?.workspacePath,
      context?.projectPath,
      context?.projectRootPath,
      AilyHost.get().project.currentProjectPath,
      AilyHost.get().project.projectRootPath,
    ];

    for (const candidate of candidates) {
      const normalizedCandidate = typeof candidate === 'string'
        ? candidate.trim()
        : '';
      if (normalizedCandidate) {
        return normalizedCandidate;
      }
    }

    return null;
  }

  private async loadSnapshot(workspacePath: string): Promise<ChatSessionProviderOptionsSourceSnapshot | null> {
    const repositories = await this.loadRepositoryCandidates(workspacePath);
    if (repositories.length === 0) {
      return null;
    }

    const supportsWorktree = repositories.some((repository) => repository.kind === 'repository')
      ? await this.readAnyWorktreeSupport(repositories)
      : false;

    return {
      repositories,
      supportsWorktree,
      repositoryCommands: [
        {
          command: OPEN_REPOSITORY_COMMAND_ID,
          title: 'Browse folders...',
        },
      ],
    };
  }

  private async loadRepositoryCandidates(workspacePath: string): Promise<readonly ChatSessionProviderOptionsSourceRepository[]> {
    const host = AilyHost.get();
    const fs = host.fs;
    const candidatePaths = this.collectCandidatePaths(workspacePath);
    const repositories: ChatSessionProviderOptionsSourceRepository[] = [];
    const seenPaths = new Set<string>();

    for (const candidatePath of candidatePaths) {
      if (!this.isExistingDirectory(fs, candidatePath)) {
        continue;
      }

      const repositoryRoot = await this.resolveRepositoryRoot(candidatePath);
      if (repositoryRoot) {
        const normalizedRepositoryRoot = this.normalizePathKey(repositoryRoot);
        if (seenPaths.has(normalizedRepositoryRoot)) {
          continue;
        }

        const currentBranch = await this.readCurrentBranch(repositoryRoot);
        const branches = await this.readBranches(repositoryRoot, currentBranch);
        repositories.push({
          path: repositoryRoot,
          label: host.path.basename(repositoryRoot) || repositoryRoot,
          kind: 'repository',
          branches,
          ...(currentBranch ? { currentBranch } : {}),
        });
        seenPaths.add(normalizedRepositoryRoot);
        continue;
      }

      const normalizedCandidatePath = this.normalizePathKey(candidatePath);
      if (seenPaths.has(normalizedCandidatePath)) {
        continue;
      }

      repositories.push({
        path: candidatePath,
        label: host.path.basename(candidatePath) || candidatePath,
        kind: 'folder',
        branches: [],
      });
      seenPaths.add(normalizedCandidatePath);
    }

    return repositories;
  }

  private collectCandidatePaths(workspacePath: string): readonly string[] {
    const host = AilyHost.get();
    const candidates = [
      workspacePath,
      host.project.currentProjectPath,
      host.project.projectRootPath,
    ];
    const seenPaths = new Set<string>();
    const result: string[] = [];

    for (const candidate of candidates) {
      const normalizedCandidate = typeof candidate === 'string'
        ? candidate.trim()
        : '';
      if (!normalizedCandidate) {
        continue;
      }

      const canonicalCandidate = this.resolveCanonicalPath(normalizedCandidate);
      const candidateKey = this.normalizePathKey(canonicalCandidate);
      if (seenPaths.has(candidateKey)) {
        continue;
      }

      seenPaths.add(candidateKey);
      result.push(canonicalCandidate);
    }

    return result;
  }

  private resolveCanonicalPath(path: string): string {
    const realpathSync = AilyHost.get().fs?.realpathSync;
    if (typeof realpathSync !== 'function') {
      return path;
    }

    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  }

  private normalizePathKey(path: string): string {
    const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '').trim();
    if (!normalizedPath) {
      return '';
    }

    return (AilyHost.get().platform?.isWindows ?? false)
      ? normalizedPath.toLowerCase()
      : normalizedPath;
  }

  private isExistingDirectory(fs: IFileSystem, path: string): boolean {
    try {
      if (!fs.existsSync(path)) {
        return false;
      }

      if (typeof fs.isDirectory === 'function') {
        return fs.isDirectory(path);
      }

      return fs.statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  private async readAnyWorktreeSupport(repositories: readonly ChatSessionProviderOptionsSourceRepository[]): Promise<boolean> {
    for (const repository of repositories) {
      if (repository.kind !== 'repository') {
        continue;
      }

      if (await this.readWorktreeSupport(repository.path)) {
        return true;
      }
    }

    return false;
  }

  private async resolveRepositoryRoot(workspacePath: string): Promise<string | null> {
    try {
      const inside = (await runHostGitCommand(['rev-parse', '--is-inside-work-tree'], workspacePath)).trim();
      if (inside !== 'true') {
        return null;
      }

      const repositoryRoot = (await runHostGitCommand(['rev-parse', '--show-toplevel'], workspacePath)).trim();
      return repositoryRoot || null;
    } catch {
      return null;
    }
  }

  private async readCurrentBranch(repositoryRoot: string): Promise<string | undefined> {
    try {
      const branch = (await runHostGitCommand(['branch', '--show-current'], repositoryRoot)).trim();
      return branch || undefined;
    } catch {
      try {
        const branch = (await runHostGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], repositoryRoot)).trim();
        return branch && branch !== 'HEAD'
          ? branch
          : undefined;
      } catch {
        return undefined;
      }
    }
  }

  private async readBranches(repositoryRoot: string, currentBranch?: string): Promise<readonly string[]> {
    try {
      const output = await runHostGitCommand(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repositoryRoot);
      const branches = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const uniqueBranches = Array.from(new Set(currentBranch ? [currentBranch, ...branches] : branches));
      return uniqueBranches.sort((left, right) => {
        if (currentBranch && left === currentBranch) {
          return -1;
        }
        if (currentBranch && right === currentBranch) {
          return 1;
        }
        return left.localeCompare(right);
      });
    } catch {
      return currentBranch ? [currentBranch] : [];
    }
  }

  private async readWorktreeSupport(repositoryRoot: string): Promise<boolean> {
    try {
      await runHostGitCommand(['worktree', 'list', '--porcelain'], repositoryRoot);
      return true;
    } catch {
      return false;
    }
  }

  private areSnapshotsEqual(
    left: ChatSessionProviderOptionsSourceSnapshot | null,
    right: ChatSessionProviderOptionsSourceSnapshot | null,
  ): boolean {
    if (left === right) {
      return true;
    }

    if (!left || !right) {
      return false;
    }

    if (left.supportsWorktree !== right.supportsWorktree) {
      return false;
    }

    if (left.repositories.length !== right.repositories.length) {
      return false;
    }

    return left.repositories.every((repository, index) => {
      const other = right.repositories[index];
      if (!other) {
        return false;
      }

      if (repository.path !== other.path || repository.label !== other.label || repository.kind !== other.kind || repository.currentBranch !== other.currentBranch) {
        return false;
      }

      if ((repository.branches.length > 0 || other.branches.length > 0) && repository.kind !== 'repository') {
        return false;
      }

      if (repository.branches.length !== other.branches.length) {
        return false;
      }

      if (!repository.branches.every((branch, branchIndex) => branch === other.branches[branchIndex])) {
        return false;
      }

      const leftCommands = left.repositoryCommands ?? [];
      const rightCommands = right.repositoryCommands ?? [];
      if (leftCommands.length !== rightCommands.length) {
        return false;
      }

      return leftCommands.every((command, commandIndex) => {
        const otherCommand = rightCommands[commandIndex];
        return !!otherCommand
          && command.command === otherCommand.command
          && command.title === otherCommand.title
          && command.tooltip === otherCommand.tooltip;
      });
    });
  }
}
