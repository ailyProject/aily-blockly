import { Injectable, OnDestroy } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import {
  AppItem,
  ChildToolConfig,
  replaceChildToolConfigs,
} from '../configs/tool.config';

export interface SubappCatalogItem {
  id: string;
  role: 'app' | 'dependency';
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
  enabled: boolean;
  config?: ChildToolConfig | null;
  installError?: string;
}

export interface SubappCatalogState {
  loading: boolean;
  source: 'network' | 'cache' | 'builtin' | 'none';
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

const EMPTY_STATE: SubappCatalogState = {
  loading: true,
  source: 'none',
  indexUrl: 'https://rs1.aily.pro/subapp-index.json',
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

  readonly state$ = this.stateSubject.asObservable();
  readonly progress$ = this.progressSubject.asObservable();

  constructor(private translate: TranslateService) {
    this.languageSubscription = this.translate.onLangChange.subscribe((event) => {
      if (this.initialized) {
        void this.load(false, event.lang);
      }
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
    this.initializePromise = this.waitForInitialLocale()
      .then((locale) => this.load(true, locale))
      .then(() => {
        this.initialized = true;
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
    await this.load(force);
  }

  install(id: string): Promise<void> {
    return this.mutate('install', id);
  }

  update(id: string): Promise<void> {
    return this.mutate('update', id);
  }

  uninstall(id: string): Promise<void> {
    return this.mutate('uninstall', id);
  }

  getCatalogApps(): AppItem[] {
    return this.state.apps
      .filter((item) => item.role !== 'dependency')
      .filter((item) => item.enabled !== false)
      .map((item) => ({
        id: item.toolId,
        name: item.name,
        description: item.description,
        action: 'tool-open',
        data: { type: 'tool', data: item.toolId },
        icon: item.icon || 'fa-light fa-puzzle-piece',
        enabled: item.enabled,
        ...(item.toolId === 'aily-chat-react' ? { more: 'v2' } : {}),
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
  }

  private async load(force: boolean, locale = this.currentLocale()): Promise<void> {
    const api = (window as any).electronAPI?.subapps;
    if (!api?.list) {
      replaceChildToolConfigs([]);
      this.stateSubject.next({ ...EMPTY_STATE, loading: false });
      return;
    }

    this.stateSubject.next({ ...this.stateSubject.value, loading: true, error: null });
    try {
      const result = await api.list({ refresh: force, locale });
      this.applyResult(result);
    } catch (error) {
      replaceChildToolConfigs([]);
      this.stateSubject.next({
        ...this.stateSubject.value,
        loading: false,
        error: this.errorMessage(error),
      });
    }
  }

  private async mutate(action: 'install' | 'update' | 'uninstall', id: string): Promise<void> {
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
      const result = await operation({ id, locale: this.currentLocale() });
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
      source: result?.source === 'cache'
        ? 'cache'
        : result?.source === 'builtin'
          ? 'builtin'
          : 'network',
      indexUrl: String(result?.indexUrl || EMPTY_STATE.indexUrl),
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

  private waitForInitialLocale(): Promise<string> {
    if (this.translate.currentLang) {
      return Promise.resolve(this.translate.currentLang);
    }

    return new Promise((resolve) => {
      const subscription = this.translate.onLangChange.subscribe((event) => {
        clearTimeout(timer);
        subscription.unsubscribe();
        resolve(event.lang || this.currentLocale());
      });
      const timer = setTimeout(() => {
        subscription.unsubscribe();
        resolve(this.currentLocale());
      }, 10000);
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || 'Unknown subapp manager error');
  }
}
