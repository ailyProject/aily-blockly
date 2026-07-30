import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import {
  SubappCatalogItem,
  SubappManagerService,
} from './subapp-manager.service';

export type CoderDependencyStatus =
  | 'loading'
  | 'not-installed'
  | 'installing'
  | 'installed'
  | 'error'
  | 'unavailable';

export interface CoderDependencyState {
  status: CoderDependencyStatus;
  installed: boolean;
  installing: boolean;
  availableVersion?: string;
  installedVersion?: string | null;
  error?: string;
}

const INITIAL_STATE: CoderDependencyState = {
  status: 'loading',
  installed: false,
  installing: false,
};

@Injectable({ providedIn: 'root' })
export class CoderDependencyService implements OnDestroy {
  static readonly CATALOG_ID = 'aily-coder';

  private readonly stateSubject = new BehaviorSubject<CoderDependencyState>(INITIAL_STATE);
  private readonly catalogSubscription: Subscription;
  private installPromise: Promise<boolean> | null = null;

  readonly state$ = this.stateSubject.asObservable();

  constructor(private readonly subappManager: SubappManagerService) {
    this.catalogSubscription = this.subappManager.state$.subscribe(() => {
      if (!this.installPromise) {
        this.syncFromCatalog();
      }
    });
  }

  get state(): CoderDependencyState {
    return this.stateSubject.value;
  }

  async initialize(): Promise<void> {
    await this.subappManager.initialize();
    this.syncFromCatalog();
  }

  async ensureInstalled(): Promise<boolean> {
    await this.initialize();
    if (this.state.installed) {
      return false;
    }
    if (this.installPromise) {
      return this.installPromise;
    }

    const entry = this.findCatalogEntry();
    if (!entry) {
      const error = 'Coder dependency is not available in the application catalog';
      this.stateSubject.next({
        status: 'unavailable',
        installed: false,
        installing: false,
        error,
      });
      throw new Error(error);
    }

    this.stateSubject.next({
      status: 'installing',
      installed: false,
      installing: true,
      availableVersion: entry.availableVersion,
      installedVersion: entry.installedVersion,
    });

    const pending = this.subappManager.install(CoderDependencyService.CATALOG_ID)
      .then(() => {
        const installed = this.findCatalogEntry();
        if (!installed?.installed) {
          throw new Error('Coder dependency installation completed without a runnable package');
        }
        this.syncFromCatalog();
        return true;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error || 'Coder dependency installation failed');
        this.stateSubject.next({
          status: 'error',
          installed: false,
          installing: false,
          availableVersion: entry.availableVersion,
          installedVersion: entry.installedVersion,
          error: message,
        });
        throw error;
      })
      .finally(() => {
        if (this.installPromise === pending) {
          this.installPromise = null;
        }
      });

    this.installPromise = pending;
    return pending;
  }

  ngOnDestroy(): void {
    this.catalogSubscription.unsubscribe();
  }

  private findCatalogEntry(): SubappCatalogItem | undefined {
    return this.subappManager.state.apps.find(
      (item) => item.id === CoderDependencyService.CATALOG_ID,
    );
  }

  private syncFromCatalog(): void {
    const entry = this.findCatalogEntry();
    if (!entry) {
      const managerState = this.subappManager.state;
      this.stateSubject.next({
        status: managerState.loading ? 'loading' : 'unavailable',
        installed: false,
        installing: false,
        ...(managerState.error ? { error: managerState.error } : {}),
      });
      return;
    }

    this.stateSubject.next({
      status: entry.installed ? 'installed' : 'not-installed',
      installed: entry.installed,
      installing: false,
      availableVersion: entry.availableVersion,
      installedVersion: entry.installedVersion,
      ...(entry.installError ? { error: entry.installError } : {}),
    });
  }
}
