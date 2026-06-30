export interface ChatSessionRuntimePostTurnResourceRecord<TResources> {
  readonly sessionId: string;
  readonly cwd: string;
  readonly resources: TResources;
}

export class ChatSessionRuntimePostTurnResourcesCore<TResources> {
  private readonly records = new Map<string, ChatSessionRuntimePostTurnResourceRecord<TResources>>();

  getSessionIds(): readonly string[] {
    return [...this.records.keys()];
  }

  read(sessionId: string | null | undefined): ChatSessionRuntimePostTurnResourceRecord<TResources> | undefined {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    return normalizedSessionId ? this.records.get(normalizedSessionId) : undefined;
  }

  getOrCreate(
    sessionId: string | null | undefined,
    cwd: string | null | undefined,
    createResources: (sessionId: string, cwd: string) => TResources,
  ): TResources | undefined {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    const normalizedCwd = this.normalizeCwd(cwd);
    if (!normalizedSessionId || !normalizedCwd) {
      return undefined;
    }

    const existing = this.records.get(normalizedSessionId);
    if (existing && existing.cwd === normalizedCwd) {
      return existing.resources;
    }

    const resources = createResources(normalizedSessionId, normalizedCwd);
    this.records.set(normalizedSessionId, {
      sessionId: normalizedSessionId,
      cwd: normalizedCwd,
      resources,
    });
    return resources;
  }

  clearSession(sessionId: string | null | undefined): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (normalizedSessionId) {
      this.records.delete(normalizedSessionId);
    }
  }

  clearAll(): void {
    this.records.clear();
  }

  private normalizeSessionId(sessionId: string | null | undefined): string {
    return typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
  }

  private normalizeCwd(cwd: string | null | undefined): string {
    return typeof cwd === 'string'
      ? cwd.trim()
      : '';
  }
}
