import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, combineLatest, map, shareReplay } from 'rxjs';
import {
  SubappCatalogItem,
  SubappCatalogState,
  SubappInstallProgress,
  SubappManagerService,
} from './subapp-manager.service';

export type RequiredSubappStatus =
  | 'loading'
  | 'not-installed'
  | 'installing'
  | 'installed'
  | 'error'
  | 'unavailable';

export interface RequiredSubappState {
  id: string;
  status: RequiredSubappStatus;
  installed: boolean;
  installing: boolean;
  percent: number;
  availableVersion?: string;
  installedVersion?: string | null;
  error?: string;
}

interface RequiredSubappOperation {
  status: 'installing' | 'error';
  error?: string;
}

export function resolveRequiredSubappState(
  id: string,
  catalog: SubappCatalogState,
  progress: SubappInstallProgress | null,
  operation?: RequiredSubappOperation,
): RequiredSubappState {
  const entry = catalog.apps.find((item) => item.id === id);
  const matchingProgress = progress?.id === id ? progress : null;
  const percent = matchingProgress
    ? Math.max(0, Math.min(100, Math.round(Number(matchingProgress.percent) || 0)))
    : operation?.status === 'installing'
      ? 1
      : 0;

  if (operation?.status === 'error') {
    return stateFromEntry(id, entry, {
      status: 'error',
      installed: false,
      installing: false,
      percent,
      error: operation.error || matchingProgress?.error || entry?.installError,
    });
  }

  if (
    operation?.status === 'installing'
    || (matchingProgress?.action === 'install' && matchingProgress.phase !== 'complete')
  ) {
    if (matchingProgress?.phase === 'error') {
      return stateFromEntry(id, entry, {
        status: 'error',
        installed: false,
        installing: false,
        percent,
        error: matchingProgress.error || entry?.installError,
      });
    }
    return stateFromEntry(id, entry, {
      status: 'installing',
      installed: false,
      installing: true,
      percent,
    });
  }

  if (entry?.installed) {
    return stateFromEntry(id, entry, {
      status: 'installed',
      installed: true,
      installing: false,
      percent: 100,
    });
  }

  if (entry) {
    return stateFromEntry(id, entry, {
      status: entry.installError ? 'error' : 'not-installed',
      installed: false,
      installing: false,
      percent: 0,
      ...(entry.installError ? { error: entry.installError } : {}),
    });
  }

  return {
    id,
    status: catalog.loading ? 'loading' : 'unavailable',
    installed: false,
    installing: false,
    percent: 0,
    ...(catalog.error ? { error: catalog.error } : {}),
  };
}

function stateFromEntry(
  id: string,
  entry: SubappCatalogItem | undefined,
  state: Omit<RequiredSubappState, 'id' | 'availableVersion' | 'installedVersion'>,
): RequiredSubappState {
  return {
    id,
    ...state,
    ...(entry?.availableVersion ? { availableVersion: entry.availableVersion } : {}),
    ...(entry ? { installedVersion: entry.installedVersion } : {}),
  };
}

@Injectable({ providedIn: 'root' })
export class RequiredSubappService {
  private readonly operationsSubject = new BehaviorSubject<ReadonlyMap<string, RequiredSubappOperation>>(
    new Map(),
  );
  private readonly installPromises = new Map<string, Promise<{ installedNow: boolean }>>();
  private readonly stateObservables = new Map<string, Observable<RequiredSubappState>>();

  constructor(private readonly subappManager: SubappManagerService) {}

  observe(id: string): Observable<RequiredSubappState> {
    const normalizedId = this.normalizeId(id);
    void this.subappManager.initialize();
    let state$ = this.stateObservables.get(normalizedId);
    if (!state$) {
      state$ = combineLatest([
        this.subappManager.state$,
        this.subappManager.progress$,
        this.operationsSubject,
      ]).pipe(
        map(([catalog, progress, operations]) => resolveRequiredSubappState(
          normalizedId,
          catalog,
          progress,
          operations.get(normalizedId),
        )),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
      this.stateObservables.set(normalizedId, state$);
    }
    return state$;
  }

  ensureInstalled(id: string): Promise<{ installedNow: boolean }> {
    const normalizedId = this.normalizeId(id);
    const current = this.installPromises.get(normalizedId);
    if (current) return current;

    const pending = this.ensureInstalledOnce(normalizedId).finally(() => {
      if (this.installPromises.get(normalizedId) === pending) {
        this.installPromises.delete(normalizedId);
      }
    });
    this.installPromises.set(normalizedId, pending);
    return pending;
  }

  private async ensureInstalledOnce(id: string): Promise<{ installedNow: boolean }> {
    await this.subappManager.initialize();
    let entry = this.findCatalogEntry(id);
    if (entry?.installed) {
      this.clearOperation(id);
      return { installedNow: false };
    }
    if (!entry) {
      await this.subappManager.refresh(true);
      entry = this.findCatalogEntry(id);
    }
    if (!entry) {
      const error = `Required subapp is not available in the application catalog: ${id}`;
      this.setOperation(id, { status: 'error', error });
      throw new Error(error);
    }

    this.setOperation(id, { status: 'installing' });
    try {
      await this.subappManager.install(id);
      const installed = this.findCatalogEntry(id);
      if (!installed?.installed || !installed.config) {
        throw new Error(`Required subapp installation completed without a runnable package: ${id}`);
      }
      this.clearOperation(id);
      return { installedNow: true };
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : String(error || `Required subapp installation failed: ${id}`);
      this.setOperation(id, { status: 'error', error: message });
      throw error;
    }
  }

  private findCatalogEntry(id: string): SubappCatalogItem | undefined {
    return this.subappManager.state.apps.find((item) => item.id === id);
  }

  private setOperation(id: string, operation: RequiredSubappOperation): void {
    const next = new Map(this.operationsSubject.value);
    next.set(id, operation);
    this.operationsSubject.next(next);
  }

  private clearOperation(id: string): void {
    if (!this.operationsSubject.value.has(id)) return;
    const next = new Map(this.operationsSubject.value);
    next.delete(id);
    this.operationsSubject.next(next);
  }

  private normalizeId(id: string): string {
    const normalized = String(id || '').trim();
    if (!normalized) throw new Error('Required subapp id must be a non-empty string');
    return normalized;
  }
}
