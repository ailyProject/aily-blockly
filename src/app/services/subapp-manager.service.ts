import { Injectable, OnDestroy } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import {
  AppItem,
  ChildToolAppConfig,
  ChildToolConfig,
  replaceChildToolConfigs,
} from '../configs/tool.config';
import { ConfigService } from './config.service';

export interface SubappCatalogItem {
  id: string;
  toolId: string;
  packageName: string;
  availableVersion: string;
  installedVersion?: string | null;
  installed: boolean;
  updateAvailable: boolean;
  installPath?: string;
  titleKey: string;
  namespace: string;
  name: string;
  description: string;
  icon: string;
  ai?: boolean;
  enabled: boolean;
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
    this.configuredIndexUrl = this.configService.getSubappIndexUrl();
    const locale = this.currentLocale();
    this.initializePromise = this.load('cache-first', locale)
      .then(() => {
        this.initialized = true;
        if (this.state.source === 'cache') {
          this.refreshCatalogInBackground(locale);
        }
      })
      .finally(() => {
        const api = (window as any).electronAPI?.subapps;
        if (!this.removeChangedListener && api?.onChanged) {
          this.removeChangedListener = api.onChanged(() => void this.refresh(false));
        }
        if (!this.removeProgressListener && api?.onProgress) {
          this.removeProgressListener = api.onProgress((payload: SubappInstallProgress) => {
            this.applyProgress(payload);
          });
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

  uninstall(id: string, options: { forceClose?: boolean } = {}): Promise<void> {
    return this.mutate('uninstall', id, options);
  }

  getCatalogApps(): AppItem[] {
    return this.state.apps
      .filter((item) => item.enabled !== false)
      .map((item) => ({
        ...(item.app || {}),
        id: item.toolId,
        name: item.name,
        description: item.description,
        action: 'tool-open',
        data: { type: 'tool', data: item.toolId },
        icon: item.icon || 'fa-light fa-puzzle-piece',
        ai: item.ai === true || item.app?.ai === true,
        enabled: true,
        ...(item.toolId === 'aily-chat-react' ? { more: 'AI' } : {}),
        subapp: {
          catalogId: item.id,
          packageName: item.packageName,
          availableVersion: item.availableVersion,
          installedVersion: item.installedVersion,
          installed: item.installed,
          updateAvailable: item.updateAvailable,
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
    action: 'install' | 'update' | 'uninstall',
    id: string,
    options: { forceClose?: boolean } = {},
  ): Promise<void> {
    const api = (window as any).electronAPI?.subapps;
    const operation = api?.[action];
    if (!operation) throw new Error('Subapp manager is unavailable outside the desktop app');
    this.progressSubject.next({
      id,
      action,
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
      this.progressSubject.next({
        id,
        action,
        phase: 'complete',
        percent: 100,
        downloadProgress: 100,
        extractProgress: 100,
      });
    } catch (error) {
      this.progressSubject.next({
        id,
        action,
        phase: 'error',
        percent: this.progressSubject.value?.id === id ? (this.progressSubject.value.percent || 0) : 0,
        error: this.errorMessage(error),
      });
      throw error;
    } finally {
      // 稍延迟清空，避免 UI 在成功瞬间闪回 0%
      setTimeout(() => {
        if (this.progressSubject.value?.id === id) {
          this.progressSubject.next(null);
        }
      }, 400);
    }
  }

  private applyProgress(payload: SubappInstallProgress): void {
    if (!payload || typeof payload.id !== 'string') return;
    const percent = Math.max(0, Math.min(100, Math.round(Number(payload.percent) || 0)));
    const previous = this.progressSubject.value;
    const nextPercent = previous?.id === payload.id
      ? Math.max(previous.percent || 0, percent)
      : percent;
    this.progressSubject.next({
      ...payload,
      percent: payload.phase === 'error' ? percent : nextPercent,
    });
  }

  private applyResult(result: any): void {
    const apps = Array.isArray(result?.apps) ? result.apps as SubappCatalogItem[] : [];
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

  private currentLocale(): string {
    return this.translate.currentLang || this.translate.defaultLang || 'en';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || 'Unknown subapp manager error');
  }
}
