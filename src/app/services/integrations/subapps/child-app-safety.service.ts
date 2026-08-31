import { Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { NzModalService } from 'ng-zorro-antd/modal';

import { APP_LIST, getChildToolConfig } from '../../../configs/tool.config';
import { ChildAppHostRegistryService } from './child-app-host-registry.service';

export type ChildAppInterruptionReason = 'application-update' | 'logout' | 'region-switch';
export interface ChildAppSafetyPreparationResult {
  ok: boolean;
  message?: string;
  [key: string]: unknown;
}
export type ChildAppSafetyPreparationHook = () =>
  | ChildAppSafetyPreparationResult
  | Promise<ChildAppSafetyPreparationResult>;

interface ConfirmationCopy {
  titleKey: string;
  contentKey: string;
  okKey: string;
  cancelKey: string;
  interpolationKey: 'apps' | 'names';
  danger: boolean;
}

@Injectable({ providedIn: 'root' })
export class ChildAppSafetyService {
  private readonly preparationHooks = new Map<string, ChildAppSafetyPreparationHook>();

  constructor(
    private readonly modal: NzModalService,
    private readonly translate: TranslateService,
    private readonly childHostRegistry: ChildAppHostRegistryService,
  ) {}

  collectActiveChildAppIds(openWindowPaths: readonly string[] = []): string[] {
    const toolIds = new Set<string>();
    for (const registration of this.childHostRegistry.list()) {
      const toolId = String(registration.toolId || '').trim();
      if (toolId) toolIds.add(toolId);
    }
    for (const routePath of openWindowPaths) {
      const toolId = this.childToolIdFromRoute(routePath);
      if (toolId) toolIds.add(toolId);
    }
    return Array.from(toolIds);
  }

  getDisplayNames(toolIds: readonly string[]): string[] {
    return [...new Set(toolIds.map(toolId => this.getDisplayName(toolId)))];
  }

  registerPreparationHook(id: string, hook: ChildAppSafetyPreparationHook): () => void {
    const normalizedId = String(id || '').trim();
    if (!normalizedId) {
      throw new Error('Child app safety preparation hook id is required');
    }
    this.preparationHooks.set(normalizedId, hook);
    return () => {
      if (this.preparationHooks.get(normalizedId) === hook) {
        this.preparationHooks.delete(normalizedId);
      }
    };
  }

  async prepareRegisteredWork(): Promise<void> {
    for (const [id, hook] of this.preparationHooks) {
      const result = await hook();
      if (result?.ok === false) {
        throw new Error(result.message || `Child app safety preparation failed: ${id}`);
      }
    }
  }

  confirmInterruption(
    reason: ChildAppInterruptionReason,
    toolIds: readonly string[],
  ): Promise<boolean> {
    const hasActiveApps = toolIds.length > 0;
    if (reason === 'application-update' && !hasActiveApps) {
      return Promise.resolve(true);
    }

    const copy = this.confirmationCopy(reason, hasActiveApps);
    const names = this.getDisplayNames(toolIds).join(this.listSeparator);
    const params = hasActiveApps ? { [copy.interpolationKey]: names } : undefined;

    return new Promise(resolve => {
      this.modal.confirm({
        nzClassName: 'subapp-service-confirm-modal',
        nzTitle: this.translate.instant(copy.titleKey),
        nzContent: this.translate.instant(copy.contentKey, params),
        nzOkText: this.translate.instant(copy.okKey),
        nzCancelText: this.translate.instant(copy.cancelKey),
        nzOkDanger: copy.danger,
        nzMaskClosable: false,
        nzZIndex: 1200,
        nzOnOk: () => resolve(true),
        nzOnCancel: () => resolve(false),
      });
    });
  }

  private confirmationCopy(
    reason: ChildAppInterruptionReason,
    hasActiveApps: boolean,
  ): ConfirmationCopy {
    if (reason === 'logout') {
      return {
        titleKey: hasActiveApps
          ? 'COMMON.SAFE_LOGOUT_CLOSE_APPS_TITLE'
          : 'COMMON.SAFE_LOGOUT_TITLE',
        contentKey: hasActiveApps
          ? 'COMMON.SAFE_LOGOUT_CLOSE_APPS_DESC'
          : 'COMMON.SAFE_LOGOUT_DESC',
        okKey: 'COMMON.SAFE_LOGOUT_CONFIRM',
        cancelKey: 'COMMON.CANCEL',
        interpolationKey: 'apps',
        danger: true,
      };
    }

    if (reason === 'region-switch') {
      return {
        titleKey: hasActiveApps
          ? 'SETTINGS.FIELDS.REGION_CLOSE_APPS_TITLE'
          : 'SETTINGS.FIELDS.REGION_TITLE',
        contentKey: hasActiveApps
          ? 'SETTINGS.FIELDS.REGION_CLOSE_APPS_DESC'
          : 'SETTINGS.FIELDS.REGION_DESC',
        okKey: 'SETTINGS.FIELDS.REGION_CONFIRM',
        cancelKey: 'SETTINGS.FIELDS.REGION_CANCEL',
        interpolationKey: 'apps',
        danger: hasActiveApps,
      };
    }

    return {
      titleKey: 'UPDATE_DIALOG.CHILD_APPS_IN_USE_TITLE',
      contentKey: 'UPDATE_DIALOG.CHILD_APPS_IN_USE_MESSAGE',
      okKey: 'UPDATE_DIALOG.CONTINUE_INSTALL',
      cancelKey: 'UPDATE_DIALOG.CANCEL_INSTALL',
      interpolationKey: 'names',
      danger: true,
    };
  }

  private getDisplayName(toolId: string): string {
    if (toolId === 'aily-chat') {
      return 'Aily Chat';
    }

    const childConfig = getChildToolConfig(toolId);
    const builtInApp = APP_LIST.find(app => app.id === toolId);
    const label = String(childConfig?.app?.name || childConfig?.titleKey || builtInApp?.name || '').trim();
    if (!label) return toolId;

    const translated = String(this.translate.instant(label) || '').trim();
    if (!translated) return toolId;
    if (translated !== label || label.includes('.') || label.includes('_')) {
      return translated === label ? toolId : translated;
    }
    return label;
  }

  private get listSeparator(): string {
    const language = String(this.translate.currentLang || this.translate.defaultLang || '').toLowerCase();
    return language.startsWith('zh') ? '、' : ', ';
  }

  private childToolIdFromRoute(routePath: string): string {
    const match = String(routePath || '').match(/^\/?child-tool\/([^/?#]+)/);
    if (!match?.[1]) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
}
