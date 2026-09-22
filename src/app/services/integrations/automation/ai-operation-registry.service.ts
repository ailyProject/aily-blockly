import { Injectable } from '@angular/core';

export interface ActiveAiOperation {
  readonly source: string;
  readonly projectPath: string;
  readonly sessionId: string | null;
  readonly startedAt: number;
  readonly blocksProjectLifecycle: boolean;
}

/**
 * Host-owned registry for AI work reported by independent child applications.
 *
 * The registry intentionally knows nothing about chat sessions, Agent runtimes,
 * or a specific AI implementation. Activity remains useful to UI/scheduling;
 * only explicitly registered host mutations protect project disposal.
 */
@Injectable({ providedIn: 'root' })
export class AiOperationRegistryService {
  private readonly operations = new Map<string, ActiveAiOperation>();

  setActive(
    source: string,
    active: boolean,
    metadata: { projectPath?: string | null; sessionId?: string | null; blocksProjectLifecycle?: boolean } = {},
  ): void {
    const normalizedSource = String(source || '').trim();
    if (!normalizedSource) return;

    if (!active) {
      this.operations.delete(normalizedSource);
      return;
    }

    const previous = this.operations.get(normalizedSource);
    this.operations.set(normalizedSource, {
      source: normalizedSource,
      projectPath: normalizeProjectPath(metadata.projectPath),
      sessionId: normalizeOptionalText(metadata.sessionId),
      startedAt: previous?.startedAt ?? Date.now(),
      blocksProjectLifecycle: metadata.blocksProjectLifecycle === true,
    });
  }

  hasActive(projectPath?: string | null): boolean {
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    return [...this.operations.values()].some((operation) => {
      if (!normalizedProjectPath) {
        return operation.projectPath.length === 0;
      }
      return operation.projectPath === normalizedProjectPath;
    });
  }

  readActive(): readonly ActiveAiOperation[] {
    return [...this.operations.values()].map((operation) => ({ ...operation }));
  }

  /** Session activity is informational. Only executing host mutations block disposal. */
  hasBlocking(projectPath: string): boolean {
    const path = normalizeProjectPath(projectPath);
    return [...this.operations.values()].some(operation => operation.blocksProjectLifecycle && operation.projectPath === path);
  }
}

function normalizeProjectPath(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
    : '';
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
