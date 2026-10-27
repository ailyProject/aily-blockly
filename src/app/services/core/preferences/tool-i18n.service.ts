import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TranslateService } from '@ngx-translate/core';
import { lastValueFrom } from 'rxjs';
import { ChildToolConfig, getChildToolConfig, getChildToolConfigs } from '../../../configs/tool.config';

export const TOOL_I18N_NAMESPACES = {
  'app-store': ['APP_STORE'],
  'ble-debugger': ['BLE_DEBUGGER'],
  'industrial-bus-debugger': ['INDUSTRIAL_BUS_DEBUGGER'],
  'log': ['LOG'],
  'mqtt-debugger': ['MQTT_DEBUGGER'],
  'network-debugger': ['NETWORK_DEBUGGER'],
  'user-center': ['USER_CENTER'],
} as const;

export type ToolI18nName = keyof typeof TOOL_I18N_NAMESPACES;

interface ToolI18nEntry {
  toolName: string;
  config: ChildToolConfig | null;
  sourceKey: string;
  loaded: boolean;
  promise?: Promise<void>;
}

@Injectable({
  providedIn: 'root',
})
export class ToolI18nService {
  private registeredTools = new Set<string>();
  private entries = new Map<string, ToolI18nEntry>();

  constructor(
    private http: HttpClient,
    private translate: TranslateService,
  ) {
    this.translate.onLangChange.subscribe((event) => {
      for (const tool of this.registeredTools) {
        void this.load(tool, event.lang, true);
      }
    });
  }

  load(toolName: string, lang: string = this.currentLang(), force = false): Promise<void> {
    const childConfig = getChildToolConfig(toolName);
    if (!this.isToolI18nName(toolName) && !childConfig) {
      return Promise.resolve();
    }

    this.registeredTools.add(toolName);
    const key = JSON.stringify([toolName, lang]);
    const sourceKey = this.sourceKey(childConfig);
    const current = this.entries.get(key);
    if (current?.config === childConfig && current.sourceKey === sourceKey) {
      if (current.promise) return current.promise;
      if (!force && current.loaded) return Promise.resolve();
    }

    const entry: ToolI18nEntry = { toolName, config: childConfig, sourceKey, loaded: false };
    const snapshot = childConfig ? { ...childConfig } : null;
    this.entries.set(key, entry);
    entry.promise = Promise.resolve()
      .then(() => this.isCurrent(key, entry) ? this.loadTranslationData(toolName, lang, snapshot) : null)
      .then((data) => {
        if (!data || !this.isCurrent(key, entry)) return;
        this.translate.setTranslation(lang, data, true);
        entry.loaded = true;
      })
      .catch((error) => {
        if (this.isCurrent(key, entry)) {
          console.warn(`Failed to load i18n for tool ${toolName} (${lang}):`, error);
        }
      })
      .finally(() => {
        if (this.isCurrent(key, entry)) entry.promise = undefined;
      });

    return entry.promise;
  }

  async loadChildTools(lang: string = this.currentLang(), force = false): Promise<void> {
    const toolIds = Object.keys(getChildToolConfigs());
    await Promise.all(toolIds.map(toolId => this.load(toolId, lang, force)));
  }

  private sourceKey(config: ChildToolConfig | null): string {
    return JSON.stringify(config ? [config.id, config.packagePath || '', config.childDir || '', config.version || ''] : null);
  }

  private isCurrent(key: string, entry: ToolI18nEntry): boolean {
    const config = getChildToolConfig(entry.toolName);
    return this.entries.get(key) === entry && config === entry.config && this.sourceKey(config) === entry.sourceKey;
  }

  private loadTranslationData(toolName: string, lang: string, childConfig: ChildToolConfig | null): Promise<Record<string, unknown>> {
    if (childConfig) {
      const data = this.readChildToolI18n(childConfig, lang);
      if (data) {
        return Promise.resolve(data);
      }
    }

    if (!this.isToolI18nName(toolName)) {
      return Promise.reject(new Error(`Tool i18n is not registered: ${toolName}`));
    }

    return lastValueFrom(
      this.http.get<Record<string, unknown>>(`tools/${toolName}/i18n/${lang}.json`, {
        responseType: 'json',
      }),
    );
  }

  private readChildToolI18n(config: ChildToolConfig, lang: string): Record<string, unknown> | null {
    const fsApi = typeof window !== 'undefined' ? window['fs'] : null;
    const pathApi = typeof window !== 'undefined' ? window['path'] : null;
    const childPath = pathApi?.getAilyChildPath?.();

    if (!childPath || !pathApi?.join || !fsApi?.existsSync || !fsApi?.readFileSync) {
      return null;
    }

    const toolDir = config.packagePath || pathApi.join(childPath, config.childDir || pathApi.join('tools', config.id));
    const candidates = lang === 'en' ? [lang] : [lang, 'en'];

    for (const candidate of candidates) {
      try {
        const filePath = pathApi.join(toolDir, 'i18n', `${candidate}.json`);
        if (!fsApi.existsSync(filePath)) {
          continue;
        }

        const data = JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
        return data && typeof data === 'object' ? data : null;
      } catch (error) {
        console.warn(`Failed to read i18n file for child tool ${config.id} (${candidate}):`, error);
      }
    }

    return null;
  }

  private currentLang(): string {
    return this.translate.currentLang || this.translate.defaultLang || 'en';
  }

  private isToolI18nName(toolName: string): toolName is ToolI18nName {
    return Object.prototype.hasOwnProperty.call(TOOL_I18N_NAMESPACES, toolName);
  }
}
