import { Injectable } from '@angular/core';

export interface UiAutomationMenuItem {
  id: string;
  label: string;
  labelKey?: string;
  action?: string;
  shortcut?: string;
  icon?: string;
  enabled: boolean;
  visible: boolean;
  dangerous?: boolean;
  mayPrompt?: boolean;
  children?: UiAutomationMenuItem[];
}

export interface UiAutomationMenuListOptions {
  includeHidden?: boolean;
}

export interface UiAutomationCommandResult {
  ok: boolean;
  message?: string;
  [key: string]: unknown;
}

export interface UiAutomationMenuProvider {
  list(options?: UiAutomationMenuListOptions): UiAutomationMenuItem[];
  execute(itemId: string, options?: { confirm?: boolean }): Promise<UiAutomationCommandResult>;
}

@Injectable({ providedIn: 'root' })
export class UiAutomationRegistryService {
  private readonly menuProviders = new Map<string, UiAutomationMenuProvider>();

  registerMenuProvider(surfaceId: string, provider: UiAutomationMenuProvider): () => void {
    const id = this.normalizeId(surfaceId);
    if (!id) {
      throw new Error('UI menu surface id is required');
    }

    this.menuProviders.set(id, provider);
    return () => {
      if (this.menuProviders.get(id) === provider) {
        this.menuProviders.delete(id);
      }
    };
  }

  listMenu(surfaceId: string, options?: UiAutomationMenuListOptions): UiAutomationCommandResult {
    const id = this.normalizeId(surfaceId);
    const provider = this.menuProviders.get(id);
    if (!provider) {
      return {
        ok: false,
        message: `界面菜单尚未就绪: ${id || surfaceId}`,
        availableSurfaces: [...this.menuProviders.keys()],
      };
    }

    const items = provider.list(options);
    return {
      ok: true,
      surface: id,
      count: this.countItems(items),
      items,
    };
  }

  async executeMenu(
    surfaceId: string,
    itemId: string,
    options?: { confirm?: boolean },
  ): Promise<UiAutomationCommandResult> {
    const id = this.normalizeId(surfaceId);
    const provider = this.menuProviders.get(id);
    if (!provider) {
      return {
        ok: false,
        message: `界面菜单尚未就绪: ${id || surfaceId}`,
        availableSurfaces: [...this.menuProviders.keys()],
      };
    }
    return provider.execute(itemId, options);
  }

  private normalizeId(value: string): string {
    return String(value || '').trim().toLowerCase();
  }

  private countItems(items: readonly UiAutomationMenuItem[]): number {
    return items.reduce((total, item) => total + 1 + this.countItems(item.children || []), 0);
  }
}
