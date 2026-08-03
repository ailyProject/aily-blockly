import { Injectable } from '@angular/core';

import { getChildToolConfig } from '../configs/tool.config';
import {
  type ChildAppOpenMode,
  MainUiAutomationService,
} from './main-ui-automation.service';
import { SubappManagerService } from './subapp-manager.service';
import { UiService } from './ui.service';

export type InstalledChildToolLaunchStatus =
  | 'opened'
  | 'not-installed'
  | 'unavailable'
  | 'failed';

export interface InstalledChildToolLaunchResult {
  readonly toolId: string;
  readonly status: InstalledChildToolLaunchStatus;
  readonly mode: ChildAppOpenMode;
  readonly catalogId?: string;
  readonly message?: string;
}

export interface InstalledChildToolLaunchOptions {
  readonly mode?: ChildAppOpenMode;
}

/**
 * Generic product entry for opening an already-installed Child Tool.
 *
 * The launcher never installs packages and never owns a child Runtime. Missing
 * tools are redirected to the App Store; installed tools still use the shared
 * Child Tool Host/session/window lifecycle.
 */
@Injectable({ providedIn: 'root' })
export class InstalledChildToolLauncherService {
  constructor(
    private readonly subapps: SubappManagerService,
    private readonly mainUiAutomation: MainUiAutomationService,
    private readonly ui: UiService,
  ) {}

  async launch(
    toolId: string,
    options: InstalledChildToolLaunchOptions = {},
  ): Promise<InstalledChildToolLaunchResult> {
    const normalizedToolId = typeof toolId === 'string' ? toolId.trim() : '';
    const mode = options.mode ?? 'embedded';
    if (!normalizedToolId) {
      return {
        toolId: '',
        status: 'unavailable',
        mode,
        message: 'Child Tool ID is required.',
      };
    }

    let initializeError: unknown;
    try {
      await this.subapps.initialize();
    } catch (error) {
      initializeError = error;
    }

    const config = getChildToolConfig(normalizedToolId);
    const catalogItem = this.subapps.state.apps.find(
      item => item.toolId === normalizedToolId && item.enabled !== false,
    );
    if (!config) {
      this.ui.openTool('app-store');
      return {
        toolId: normalizedToolId,
        status: catalogItem && !catalogItem.installed
          ? 'not-installed'
          : 'unavailable',
        mode,
        ...(catalogItem?.id ? { catalogId: catalogItem.id } : {}),
        ...(initializeError === undefined
          ? {}
          : { message: errorMessage(initializeError) }),
      };
    }

    try {
      const result = await this.mainUiAutomation.openChildApp({
        toolId: normalizedToolId,
        mode,
      });
      if (result['ok'] === true) {
        return {
          toolId: normalizedToolId,
          status: 'opened',
          mode,
          ...(config.catalogId ? { catalogId: config.catalogId } : {}),
        };
      }
      return {
        toolId: normalizedToolId,
        status: 'failed',
        mode,
        ...(config.catalogId ? { catalogId: config.catalogId } : {}),
        message: String(result['message'] || 'Child Tool could not be opened.'),
      };
    } catch (error) {
      return {
        toolId: normalizedToolId,
        status: 'failed',
        mode,
        ...(config.catalogId ? { catalogId: config.catalogId } : {}),
        message: errorMessage(error),
      };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error || 'Unknown Child Tool launch error.');
}
