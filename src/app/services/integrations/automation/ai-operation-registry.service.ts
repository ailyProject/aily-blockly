import { Injectable } from '@angular/core';

export interface ActiveAiOperation {
  readonly source: string;
  readonly projectPath: string;
  readonly sessionId: string | null;
  readonly startedAt: number;
}

/**
 * Host-owned registry for AI work reported by independent child applications.
 *
 * The registry intentionally knows nothing about chat sessions, Agent runtimes,
 * or a specific AI implementation. Product lifecycle guards only need to know
 * whether an operation is active for the project that is about to be changed.
 */
@Injectable({ providedIn: 'root' })
export class AiOperationRegistryService {
  private readonly operations = new Map<string, ActiveAiOperation>();

  setActive(
    source: string,
    active: boolean,
    metadata: { projectPath?: string | null; sessionId?: string | null } = {},
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
}

function normalizeProjectPath(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
    : '';
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
