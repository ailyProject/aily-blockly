import { Injectable, OnDestroy } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import {
  AppItem,
  ChildToolAppConfig,
  ChildToolConfig,
  replaceChildToolConfigs,
} from '../../../configs/tool.config';
import { ConfigService } from '@core/preferences/public-api';

export type SubappUpdateState =
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'failed';

export interface SubappUpdateStatus {
  state: SubappUpdateState;
  targetVersion: string;
  progress?: number;
  ready?: boolean;
  error?: string;
  downloadedAt?: string;
}

export interface SubappUpdatePolicy {
  download: 'background';
  install: 'next-launch';
}

export interface SubappCatalogItem {
  id: string;
  toolId: string;
  only: string;
  packageName: string;
  availableVersion: string;
  installedVersion?: string | null;
  installed: boolean;
  updateAvailable: boolean;
  updateStatus: SubappUpdateStatus;
  updatePolicy?: SubappUpdatePolicy;
  installPath?: string;
  titleKey: string;
  namespace: string;
  name: string;
  description: string;
  icon: string;
  ai?: boolean;
  enabled: boolean;
  extension?: boolean;
  app?: ChildToolAppConfig;
  config?: ChildToolConfig | null;
  installError?: string;
}

export interface SubappCatalogState {
  loading: boolean;
  source: 'network' | 'cache' | 'none';
  indexUrl: string;
  fetchedAt?: string;
  warning?: string | null;
  error?: string | null;
  installRoot: string;
  apps: SubappCatalogItem[];
}

export interface SubappInstallProgress {
  id: string;
  action: 'install' | 'update' | 'uninstall' | string;
  phase: 'start' | 'download' | 'extract' | 'complete' | 'error' | string;
  percent: number;
  downloadProgress?: number;
  extractProgress?: number;
  error?: string;
}

type CatalogLoadStrategy = 'cache-first' | 'network-first' | 'cache-only';

const EMPTY_STATE: SubappCatalogState = {
  loading: true,
  source: 'none',
  indexUrl: '',
  installRoot: '',
  apps: [],
};

@Injectable({ providedIn: 'root' })
export class SubappManagerService implements OnDestroy {
  private readonly stateSubject = new BehaviorSubject<SubappCatalogState>(EMPTY_STATE);
  private readonly progressSubject = new BehaviorSubject<SubappInstallProgress | null>(null);
  private initializePromise: Promise<void> | null = null;
  private initialized = false;
  private removeChangedListener: (() => void) | null = null;
  private removeProgressListener: (() => void) | null = null;
  private languageSubscription?: Subscription;
  private configSubscription?: Subscription;
  private configuredIndexUrl = '';

  readonly state$ = this.stateSubject.asObservable();
  readonly progress$ = this.progressSubject.asObservable();

  constructor(
    private translate: TranslateService,
    private configService: ConfigService,
  ) {
    this.languageSubscription = this.translate.onLangChange.subscribe((event) => {
      if (this.initialized) {
        void this.load('cache-first', event.lang);
      }
    });
    this.configSubscription = this.configService.configReloaded$.subscribe(() => {
      if (!this.initialized) return;
      const indexUrl = this.configService.getSubappIndexUrl();
      if (!indexUrl || indexUrl === this.configuredIndexUrl) return;
      this.configuredIndexUrl = indexUrl;
      void this.load('network-first');
    });
  }

  get state(): SubappCatalogState {
    return this.stateSubject.value;
  }

  get progress(): SubappInstallProgress | null {
    return this.progressSubject.value;
  }

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.registerDesktopListeners();
    this.configuredIndexUrl = this.configService.getSubappIndexUrl();
    const locale = this.currentLocale();
    this.initializePromise = this.load('cache-first', locale)
      .then(() => {
        this.initialized = true;
        if (this.state.source === 'cache') {
          this.refreshCatalogInBackground(locale);
        }
      });
    return this.initializePromise;
  }

  async refresh(force = true): Promise<void> {
    await this.load(force ? 'network-first' : 'cache-first');
  }

  install(id: string, options: { forceClose?: boolean } = {}): Promise<void> {
    return this.mutate('install', id, options);
  }

  update(id: string, options: { forceClose?: boolean } = {}): Promise<void> {
    return this.mutate('update', id, options);
  }

  downloadUpdate(id: string): Promise<void> {
    return this.mutate('downloadUpdate', id);
  }

  installUpdate(id: string, options: { forceClose?: boolean } = {}): Promise<void> {
    return this.mutate('installUpdate', id, options);
  }

  uninstall(id: string, options: { forceClose?: boolean } = {}): Promise<void> {
    return this.mutate('uninstall', id, options);
  }

  getCatalogApps(): AppItem[] {
    return this.state.apps
      .filter((item) => item.enabled !== false)
      .map((item) => ({
        ...(item.app || {}),
        id: item.toolId,
        only: item.only,
        name: item.name,
        description: item.description,
        action: 'tool-open',
        data: { type: 'tool', data: item.toolId },
        icon: item.icon || 'fa-light fa-puzzle-piece',
        ai: item.ai === true || item.app?.ai === true,
        extension: item.extension === true || item.app?.extension === true,
        enabled: true,
        ...(item.toolId === 'aily-chat' ? { more: 'AI' } : {}),
        subapp: {
          catalogId: item.id,
          packageName: item.packageName,
          availableVersion: item.availableVersion,
          installedVersion: item.installedVersion,
          installed: item.installed,
          updateAvailable: item.updateAvailable,
          updateStatus: item.updateStatus,
          updatePolicy: item.updatePolicy,
          installPath: item.installPath,
        },
      }));
  }

  ngOnDestroy(): void {
    this.removeChangedListener?.();
    this.removeProgressListener?.();
    this.languageSubscription?.unsubscribe();
    this.configSubscription?.unsubscribe();
  }

  private async load(
    strategy: CatalogLoadStrategy,
    locale = this.currentLocale(),
    showLoading = true,
  ): Promise<void> {
    const api = (window as any).electronAPI?.subapps;
    if (!api?.list) {
      replaceChildToolConfigs([]);
      this.stateSubject.next({ ...EMPTY_STATE, loading: false });
      return;
    }

    if (showLoading) {
      this.stateSubject.next({ ...this.stateSubject.value, loading: true, error: null });
    }
    try {
      const result = await api.list({ strategy, locale });
      this.applyResult(result);
    } catch (error) {
      if (showLoading || this.stateSubject.value.apps.length === 0) {
        replaceChildToolConfigs([]);
        this.stateSubject.next({
          ...this.stateSubject.value,
          loading: false,
          error: this.errorMessage(error),
        });
      } else {
        this.stateSubject.next({
          ...this.stateSubject.value,
          warning: this.errorMessage(error),
        });
      }
    }
  }

  private refreshCatalogInBackground(locale: string): void {
    void this.load('network-first', locale, false);
  }

  private async mutate(
    action: 'install' | 'update' | 'downloadUpdate' | 'installUpdate' | 'uninstall',
    id: string,
    options: { forceClose?: boolean } = {},
  ): Promise<void> {
    const api = (window as any).electronAPI?.subapps;
    const operation = api?.[action];
    if (!operation) throw new Error('Subapp manager is unavailable outside the desktop app');
    const progressAction = action === 'downloadUpdate'
      ? 'download-update'
      : action === 'installUpdate'
        ? 'install-update'
        : action;
    this.progressSubject.next({
      id,
      action: progressAction,
      phase: 'start',
      percent: 1,
      downloadProgress: 0,
      extractProgress: 0,
    });
    try {
      const result = await operation({
        id,
        locale: this.currentLocale(),
        forceClose: options.forceClose === true,
      });
      this.applyResult(result);
      const completedProgress: SubappInstallProgress = {
        id,
        action: progressAction,
        phase: 'complete',
        percent: 100,
        downloadProgress: 100,
        extractProgress: 100,
      };
      this.progressSubject.next(completedProgress);
      setTimeout(() => {
        if (this.progressSubject.value === completedProgress) {
          this.progressSubject.next(null);
        }
      }, 400);
    } catch (error) {
      const failedProgress: SubappInstallProgress = {
        id,
        action: progressAction,
        phase: 'error',
        percent: this.progressSubject.value?.id === id
          && this.progressSubject.value.action === progressAction
          ? (this.progressSubject.value.percent || 0)
          : 0,
        error: this.errorMessage(error),
      };
      this.progressSubject.next(failedProgress);
      await this.load('cache-first', this.currentLocale(), false);
      throw error;
    }
  }

  private applyProgress(payload: SubappInstallProgress): void {
    if (!payload || typeof payload.id !== 'string') return;
    const percent = Math.max(0, Math.min(100, Math.round(Number(payload.percent) || 0)));
    const previous = this.progressSubject.value;
    const nextPercent = previous?.id === payload.id && previous.action === payload.action
      ? Math.max(previous.percent || 0, percent)
      : percent;
    const progress = {
      ...payload,
      percent: payload.phase === 'error' ? percent : nextPercent,
    };
    this.progressSubject.next(progress);

    if (payload.action !== 'download-update' && payload.action !== 'install-update') return;

    const currentState = this.stateSubject.value;
    let changed = false;
    const apps = currentState.apps.map((item) => {
      if (item.id !== payload.id) return item;

      changed = true;
      const failed = payload.phase === 'error';
      const state: SubappUpdateState = failed
        ? 'failed'
        : payload.action === 'download-update'
          ? 'downloading'
          : 'installing';
      return {
        ...item,
        updateStatus: {
          ...item.updateStatus,
          state,
          progress: progress.percent,
          ...(failed && payload.error ? { error: payload.error } : {}),
          ...(payload.action === 'download-update' ? { ready: false } : {}),
        },
      };
    });

    if (changed) {
      this.stateSubject.next({ ...currentState, apps });
    }
  }

  private applyResult(result: any): void {
    const apps: SubappCatalogItem[] = Array.isArray(result?.apps)
      ? result.apps.map((item: any) => this.normalizeCatalogItem(item))
      : [];
    replaceChildToolConfigs(
      apps
        .filter((item) => item.installed && item.config)
        .map((item) => item.config as ChildToolConfig),
    );
    this.stateSubject.next({
      loading: false,
      source: result?.source === 'cache' ? 'cache' : 'network',
      indexUrl: String(result?.indexUrl || this.configuredIndexUrl),
      fetchedAt: typeof result?.fetchedAt === 'string' ? result.fetchedAt : undefined,
      warning: typeof result?.warning === 'string' ? result.warning : null,
      error: null,
      installRoot: String(result?.installRoot || ''),
      apps,
    });
  }

  private registerDesktopListeners(): void {
    const api = (window as any).electronAPI?.subapps;
    if (!this.removeChangedListener && api?.onChanged) {
      this.removeChangedListener = api.onChanged(() => void this.refresh(false));
    }
    if (!this.removeProgressListener && api?.onProgress) {
      this.removeProgressListener = api.onProgress((payload: SubappInstallProgress) => {
        this.applyProgress(payload);
      });
    }
  }

  private normalizeCatalogItem(item: any): SubappCatalogItem {
    const availableVersion = String(item?.availableVersion || '');
    const allowedStates: SubappUpdateState[] = [
      'current',
      'available',
      'downloading',
      'ready',
      'installing',
      'failed',
    ];
    const rawStatus = item?.updateStatus;
    const state = allowedStates.includes(rawStatus?.state)
      ? rawStatus.state as SubappUpdateState
      : item?.updateAvailable === true
        ? 'available'
        : 'current';
    return {
      ...item,
      updateStatus: {
        ...rawStatus,
        state,
        targetVersion: String(rawStatus?.targetVersion || availableVersion),
      },
    } as SubappCatalogItem;
  }

  private currentLocale(): string {
    return this.translate.currentLang || this.translate.defaultLang || 'en';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || 'Unknown subapp manager error');
  }
}
