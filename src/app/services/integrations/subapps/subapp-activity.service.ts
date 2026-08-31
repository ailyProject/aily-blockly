import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, distinctUntilChanged, map } from 'rxjs';

export type SubappInvocationState =
  | 'idle'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type SubappRuntimeState =
  | 'unknown'
  | 'starting'
  | 'ready'
  | 'stopped'
  | 'error';

export type SubappSurfaceState = 'collapsed' | 'expanded';

export type SubappActivityAutoOpen = 'never' | 'first-active' | 'always' | 'on-error';

export interface SubappActivityPresentation {
  mode: 'embedded' | 'window' | 'dock';
  surface?: string;
  autoOpen?: SubappActivityAutoOpen;
}

export type SubappActivitySummaryState = 'idle' | 'active' | 'warning' | 'error';

export interface SubappActivitySummary {
  state: SubappActivitySummaryState;
  label: string;
  detail: string;
  badge: string;
  updatedAt: number;
}

export interface SubappActivity {
  sessionId: string;
  toolId: string;
  title: string;
  icon: string;
  toolName: string;
  invocationState: SubappInvocationState;
  runtimeState: SubappRuntimeState;
  surfaceState: SubappSurfaceState;
  invocationCount: number;
  activeInvocationCount: number;
  firstUsedAt: number;
  lastUsedAt: number;
  lastCompletedAt?: number;
  lastToolCallId?: string;
  lastError?: string;
  /** True after Dock auto-open has fired once for this session+tool (first-active). */
  dockAutoOpened?: boolean;
  presentation?: SubappActivityPresentation;
  summary?: SubappActivitySummary;
}

export interface SubappInvocationStarted {
  sessionId: string;
  toolId: string;
  toolName: string;
  title?: string;
  icon?: string;
  toolCallId?: string;
  presentation?: SubappActivityPresentation;
  now?: number;
}

export interface SubappInvocationCompleted {
  sessionId: string;
  toolId: string;
  toolName?: string;
  toolCallId?: string;
  state: 'succeeded' | 'failed' | 'cancelled';
  runtimeState?: SubappRuntimeState;
  error?: string;
  now?: number;
}

export interface SubappRuntimeStateChanged {
  sessionId: string;
  toolId: string;
  state: SubappRuntimeState;
  error?: string;
  now?: number;
}

@Injectable({ providedIn: 'root' })
export class SubappActivityService {
  private readonly records = new Map<string, SubappActivity>();
  private readonly activitySubject = new BehaviorSubject<readonly SubappActivity[]>([]);

  readonly activities$ = this.activitySubject.asObservable();

  activitiesForSession$(sessionId: string): Observable<readonly SubappActivity[]> {
    const normalizedSessionId = this.normalizeId(sessionId);
    return this.activities$.pipe(
      map(activities => activities.filter(activity => activity.sessionId === normalizedSessionId)),
      distinctUntilChanged(this.sameActivityList),
    );
  }

  getSessionActivities(sessionId: string): readonly SubappActivity[] {
    const normalizedSessionId = this.normalizeId(sessionId);
    return this.snapshot().filter(activity => activity.sessionId === normalizedSessionId);
  }

  getActivity(sessionId: string, toolId: string): SubappActivity | null {
    const key = this.key(sessionId, toolId);
    const activity = key ? this.records.get(key) : null;
    return activity ? { ...activity, presentation: this.copyPresentation(activity.presentation) } : null;
  }

  recordActivitySummary(
    sessionId: string,
    toolId: string,
    summary: Omit<SubappActivitySummary, 'updatedAt'>,
  ): SubappActivity | null {
    const key = this.key(sessionId, toolId);
    const current = key ? this.records.get(key) : null;
    if (!current || current.runtimeState === 'stopped') return null;

    const next: SubappActivity = {
      ...current,
      summary: {
        state: summary.state,
        label: this.normalizeText(summary.label, 160),
        detail: this.normalizeText(summary.detail, 160),
        badge: this.normalizeText(summary.badge, 80),
        updatedAt: Date.now(),
      },
    };
    this.records.set(key, next);
    this.emit();
    return this.copyActivity(next);
  }

  recordInvocationStarted(input: SubappInvocationStarted): SubappActivity | null {
    const sessionId = this.normalizeId(input.sessionId);
    const toolId = this.normalizeId(input.toolId);
    if (!sessionId || !toolId) return null;

    const key = this.key(sessionId, toolId);
    const current = this.records.get(key);
    const now = this.normalizeTimestamp(input.now);
    const presentation = input.presentation
      ? this.copyPresentation(input.presentation)
      : this.copyPresentation(current?.presentation);
    // first-active = first Dock auto-open for this session+tool, not first tool call.
    // Earlier read-only calls (e.g. serial_ports_list) create an activity without Dock
    // presentation; the later open/session action must still expand the left Dock promptly.
    const shouldAutoOpen = presentation?.mode === 'dock' && (
      presentation.autoOpen === 'always'
      || (presentation.autoOpen === 'first-active' && !current?.dockAutoOpened)
    );
    const next: SubappActivity = {
      sessionId,
      toolId,
      title: this.normalizeText(input.title, 160) || current?.title || toolId,
      icon: this.normalizeText(input.icon, 160) || current?.icon || 'fa-light fa-puzzle-piece',
      toolName: this.normalizeText(input.toolName, 120) || current?.toolName || '',
      invocationState: 'running',
      runtimeState: current?.runtimeState === 'ready' ? 'ready' : 'starting',
      surfaceState:
        presentation?.mode === 'window'
          ? 'collapsed'
          : shouldAutoOpen
            ? 'expanded'
            : current?.surfaceState || 'collapsed',
      invocationCount: (current?.invocationCount || 0) + 1,
      activeInvocationCount: (current?.activeInvocationCount || 0) + 1,
      firstUsedAt: current?.firstUsedAt || now,
      lastUsedAt: now,
      ...(current?.lastCompletedAt !== undefined ? { lastCompletedAt: current.lastCompletedAt } : {}),
      ...(this.normalizeText(input.toolCallId, 160)
        ? { lastToolCallId: this.normalizeText(input.toolCallId, 160) }
        : current?.lastToolCallId
          ? { lastToolCallId: current.lastToolCallId }
          : {}),
      ...(current?.lastError ? { lastError: current.lastError } : {}),
      ...(shouldAutoOpen || current?.dockAutoOpened ? { dockAutoOpened: true } : {}),
      ...(presentation ? { presentation } : {}),
      ...(current?.summary ? { summary: { ...current.summary } } : {}),
    };
    this.records.set(key, next);
    this.emit();
    return this.copyActivity(next);
  }

  recordInvocationCompleted(input: SubappInvocationCompleted): SubappActivity | null {
    const sessionId = this.normalizeId(input.sessionId);
    const toolId = this.normalizeId(input.toolId);
    if (!sessionId || !toolId) return null;

    const key = this.key(sessionId, toolId);
    const current = this.records.get(key);
    if (!current) return null;

    const now = this.normalizeTimestamp(input.now);
    const activeInvocationCount = Math.max(0, current.activeInvocationCount - 1);
    const error = this.normalizeText(input.error, 800);
    const next: SubappActivity = {
      ...current,
      toolName: this.normalizeText(input.toolName, 120) || current.toolName,
      invocationState: activeInvocationCount > 0 ? 'running' : input.state,
      runtimeState: input.runtimeState || current.runtimeState,
      activeInvocationCount,
      lastUsedAt: now,
      lastCompletedAt: now,
      ...(this.normalizeText(input.toolCallId, 160)
        ? { lastToolCallId: this.normalizeText(input.toolCallId, 160) }
        : {}),
    };
    if (
      input.state === 'failed'
      && current.presentation?.mode === 'dock'
      && current.presentation.autoOpen === 'on-error'
    ) {
      next.surfaceState = 'expanded';
      next.dockAutoOpened = true;
    }
    if (error) {
      next.lastError = error;
    } else if (input.state === 'succeeded') {
      delete next.lastError;
    }
    this.records.set(key, next);
    this.emit();
    return this.copyActivity(next);
  }

  recordRuntimeState(input: SubappRuntimeStateChanged): SubappActivity | null {
    const sessionId = this.normalizeId(input.sessionId);
    const toolId = this.normalizeId(input.toolId);
    if (!sessionId || !toolId) return null;

    const key = this.key(sessionId, toolId);
    const current = this.records.get(key);
    if (!current) return null;

    const error = this.normalizeText(input.error, 800);
    const next: SubappActivity = {
      ...current,
      runtimeState: input.state,
      lastUsedAt: this.normalizeTimestamp(input.now),
    };
    if (error) next.lastError = error;
    this.records.set(key, next);
    this.emit();
    return this.copyActivity(next);
  }

  setSurfaceState(
    sessionId: string,
    toolId: string,
    surfaceState: SubappSurfaceState,
  ): SubappActivity | null {
    const key = this.key(sessionId, toolId);
    const current = key ? this.records.get(key) : null;
    if (!current || current.surfaceState === surfaceState) {
      return current ? this.copyActivity(current) : null;
    }
    const next = { ...current, surfaceState };
    this.records.set(key, next);
    this.emit();
    return this.copyActivity(next);
  }

  releaseSession(sessionId: string, error = ''): void {
    const normalizedSessionId = this.normalizeId(sessionId);
    if (!normalizedSessionId) return;

    let changed = false;
    const normalizedError = this.normalizeText(error, 800);
    const now = Date.now();
    for (const [key, current] of this.records.entries()) {
      if (current.sessionId !== normalizedSessionId) continue;
      this.records.set(key, {
        ...current,
        invocationState: current.activeInvocationCount > 0 ? 'cancelled' : current.invocationState,
        runtimeState: 'stopped',
        activeInvocationCount: 0,
        lastUsedAt: now,
        ...(current.activeInvocationCount > 0 ? { lastCompletedAt: now } : {}),
        ...(current.summary
          ? {
              summary: {
                ...current.summary,
                state: 'idle',
                badge: '',
                updatedAt: now,
              },
            }
          : {}),
        ...(normalizedError ? { lastError: normalizedError } : {}),
      });
      changed = true;
    }
    if (changed) this.emit();
  }

  forgetActivity(sessionId: string, toolId: string): void {
    const key = this.key(sessionId, toolId);
    if (key && this.records.delete(key)) this.emit();
  }

  clearSession(sessionId: string): void {
    const normalizedSessionId = this.normalizeId(sessionId);
    if (!normalizedSessionId) return;
    let changed = false;
    for (const [key, activity] of this.records.entries()) {
      if (activity.sessionId !== normalizedSessionId) continue;
      this.records.delete(key);
      changed = true;
    }
    if (changed) this.emit();
  }

  private emit(): void {
    this.activitySubject.next(this.snapshot());
  }

  private snapshot(): readonly SubappActivity[] {
    return [...this.records.values()]
      .map(activity => this.copyActivity(activity))
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt || left.toolId.localeCompare(right.toolId));
  }

  private copyActivity(activity: SubappActivity): SubappActivity {
    return {
      ...activity,
      presentation: this.copyPresentation(activity.presentation),
      summary: activity.summary ? { ...activity.summary } : undefined,
    };
  }

  private copyPresentation(
    presentation?: SubappActivityPresentation,
  ): SubappActivityPresentation | undefined {
    return presentation ? { ...presentation } : undefined;
  }

  private key(sessionId: string, toolId: string): string {
    const normalizedSessionId = this.normalizeId(sessionId);
    const normalizedToolId = this.normalizeId(toolId);
    return normalizedSessionId && normalizedToolId
      ? JSON.stringify([normalizedSessionId, normalizedToolId])
      : '';
  }

  private normalizeId(value: unknown): string {
    return String(value || '').trim();
  }

  private normalizeText(value: unknown, maxLength: number): string {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }

  private normalizeTimestamp(value: unknown): number {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? Math.round(timestamp) : Date.now();
  }

  private readonly sameActivityList = (
    left: readonly SubappActivity[],
    right: readonly SubappActivity[],
  ): boolean => {
    if (left.length !== right.length) return false;
    return left.every((activity, index) => {
      const candidate = right[index];
      return candidate !== undefined
        && activity.sessionId === candidate.sessionId
        && activity.toolId === candidate.toolId
        && activity.lastUsedAt === candidate.lastUsedAt
        && activity.invocationState === candidate.invocationState
        && activity.runtimeState === candidate.runtimeState
        && activity.surfaceState === candidate.surfaceState
        && activity.activeInvocationCount === candidate.activeInvocationCount
        && activity.summary?.updatedAt === candidate.summary?.updatedAt;
    });
  };
}
