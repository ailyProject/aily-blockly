import { Injectable, OnDestroy } from '@angular/core';
import type { IMenuItem } from '../../../configs/menu.config';
import type { ChatSessionInputState } from '../core/chat-mode';
import type { ChatSessionTitleSource } from '../core/chat-session-title';
import type { HostSessionRequestRoutingSummary } from '../helpers/host-session-request-routing';
import type {
  HostSessionListItemChanges,
  HostSessionListItemMetadata,
  HostSessionListItemTiming,
} from '../helpers/host-session-item-controller';

export interface MenuPosition {
  x: number;
  y: number;
  anchorBottom?: number;
}

export interface ChatSessionListAction {
  readonly icon: string;
  readonly action: string;
  readonly title: string;
  readonly active?: boolean;
}

export interface ChatSessionListItem {
  readonly sessionId: string;
  readonly title: string;
  readonly titleSource?: ChatSessionTitleSource;
  readonly titleDurable?: boolean;
  readonly description: string;
  readonly sessionType?: string;
  readonly projectPath?: string | null;
  readonly badge?: string;
  readonly status?: string;
  readonly timing?: HostSessionListItemTiming;
  readonly metadata?: HostSessionListItemMetadata;
  readonly changes?: HostSessionListItemChanges;
  readonly mode?: string;
  readonly requestRouting?: HostSessionRequestRoutingSummary;
  readonly inputState?: ChatSessionInputState;
  readonly archived?: boolean;
  readonly pinned?: boolean;
  readonly read?: boolean;
  readonly markedUnread?: boolean;
  readonly current: boolean;
  readonly actions: readonly ChatSessionListAction[];
}

export type ChatSessionPickerAction = ChatSessionListAction;

const CHAT_MENU_VIEWPORT_PADDING = 8;
const CHAT_MENU_ANCHOR_GAP = 4;
const CHAT_MENU_ITEM_HORIZONTAL_CHROME = 58;
const CHAT_MENU_ITEM_ICON_WIDTH = 30;
const CHAT_MENU_ITEM_META_GAP = 10;
const CHAT_MENU_ITEM_CURRENT_WIDTH = 18;
const CHAT_MENU_ITEM_ACTION_WIDTH = 22;
const CHAT_MENU_ITEM_ACTION_GAP = 2;
const CHAT_COMPACT_MENU_MIN_WIDTH = 168;
const CHAT_COMPACT_MENU_MAX_WIDTH = 220;

/**
 * 管理聊天界面的所有菜单/下拉面板状态：
 * - 会话列表
 * - 模式切换菜单
 * - 模型切换菜单
 * - 会话的重命名/删除操作
 */
@Injectable()
export class MenuManagerService implements OnDestroy {
  showContextMenu = false;
  showMode = false;
  showPermissionMenu = false;
  showModelMenu = false;
  showReasoningMenu = false;
  showActionMenu = false;
  contextMenuPosition: MenuPosition = { x: 0, y: 0 };
  modeListPosition: MenuPosition = { x: 0, y: 0 };
  permissionMenuPosition: MenuPosition = { x: 0, y: 0 };
  modelListPosition: MenuPosition = { x: 0, y: 0 };
  reasoningMenuPosition: MenuPosition = { x: 0, y: 0 };
  actionMenuPosition: MenuPosition = { x: 0, y: 0 };
  contextMenuWidth = CHAT_COMPACT_MENU_MIN_WIDTH;
  permissionMenuWidth = CHAT_COMPACT_MENU_MIN_WIDTH;
  modelMenuWidth = 260;

  ngOnDestroy(): void {
    return;
  }

  closeAll(): void {
    this.showContextMenu = false;
    this.showMode = false;
    this.showPermissionMenu = false;
    this.showModelMenu = false;
    this.showReasoningMenu = false;
    this.showActionMenu = false;
  }

  toggleContextMenu(event: MouseEvent, contextItems: IMenuItem[]): void {
    const shouldOpen = !this.showContextMenu;
    this.updateContextMenuGeometry(event.currentTarget as HTMLElement | null, contextItems);
    event.preventDefault();
    event.stopPropagation();
    this.closeAll();
    this.showContextMenu = shouldOpen;
  }

  private updateContextMenuGeometry(target: HTMLElement | null, contextItems: IMenuItem[]): void {
    const estimatedMenuWidth = this.estimateMenuWidth(contextItems, {
      minWidth: CHAT_COMPACT_MENU_MIN_WIDTH,
      maxWidth: CHAT_COMPACT_MENU_MAX_WIDTH,
    });
    this.contextMenuWidth = estimatedMenuWidth;
    if (!target) {
      this.contextMenuPosition = {
        x: CHAT_MENU_VIEWPORT_PADDING,
        y: Math.max(CHAT_MENU_VIEWPORT_PADDING, window.innerHeight - 120),
      };
      return;
    }

    const rect = target.getBoundingClientRect();
    const menuHeight = this.estimateMenuHeight(contextItems);
    let x = rect.left;
    let y = rect.top - menuHeight - CHAT_MENU_ANCHOR_GAP;
    let anchorBottom: number | undefined = rect.top - CHAT_MENU_ANCHOR_GAP;

    if (x + estimatedMenuWidth > window.innerWidth - CHAT_MENU_VIEWPORT_PADDING) {
      x = Math.max(CHAT_MENU_VIEWPORT_PADDING, rect.right - estimatedMenuWidth);
    }

    if (y < CHAT_MENU_VIEWPORT_PADDING) {
      y = rect.bottom + CHAT_MENU_ANCHOR_GAP;
      anchorBottom = undefined;
    }

    this.contextMenuPosition = {
      x: Math.max(CHAT_MENU_VIEWPORT_PADDING, x),
      y: Math.max(CHAT_MENU_VIEWPORT_PADDING, y),
      anchorBottom,
    };
  }

  /** 切换模式菜单的显示/隐藏 */
  toggleModeMenu(event: MouseEvent, modeItems: IMenuItem[] = []): void {
    const target = event.currentTarget as HTMLElement;
    if (target) {
      const rect = target.getBoundingClientRect();
      const menuHeight = this.estimateMenuHeight(modeItems);
      const estimatedMenuWidth = 250;
      let x = rect.left;
      let y = rect.top - menuHeight - CHAT_MENU_ANCHOR_GAP;
      let anchorBottom: number | undefined = rect.top - CHAT_MENU_ANCHOR_GAP;

      if (x + estimatedMenuWidth > window.innerWidth - CHAT_MENU_VIEWPORT_PADDING) {
        x = Math.max(CHAT_MENU_VIEWPORT_PADDING, rect.right - estimatedMenuWidth);
      }

      if (y < CHAT_MENU_VIEWPORT_PADDING) {
        y = rect.bottom + CHAT_MENU_ANCHOR_GAP;
        anchorBottom = undefined;
      }

      this.modeListPosition = { x: Math.max(0, x), y: Math.max(0, y), anchorBottom };
    } else {
      this.modeListPosition = { x: window.innerWidth - 302, y: window.innerHeight - 280 };
    }
    event.preventDefault();
    event.stopPropagation();
    this.showContextMenu = false;
    this.showPermissionMenu = false;
    this.showReasoningMenu = false;
    this.showModelMenu = false;
    this.showMode = !this.showMode;
  }

  togglePermissionMenu(event: MouseEvent, permissionItems: IMenuItem[]): void {
    const estimatedMenuWidth = this.estimateMenuWidth(permissionItems, {
      minWidth: CHAT_COMPACT_MENU_MIN_WIDTH,
      maxWidth: CHAT_COMPACT_MENU_MAX_WIDTH,
    });
    this.permissionMenuWidth = estimatedMenuWidth;
    const target = event.currentTarget as HTMLElement;
    if (target) {
      const rect = target.getBoundingClientRect();
      const menuHeight = this.estimateMenuHeight(permissionItems);
      let x = rect.left;
      let y = rect.top - menuHeight - CHAT_MENU_ANCHOR_GAP;
      let anchorBottom: number | undefined = rect.top - CHAT_MENU_ANCHOR_GAP;

      if (x + estimatedMenuWidth > window.innerWidth - CHAT_MENU_VIEWPORT_PADDING) {
        x = Math.max(CHAT_MENU_VIEWPORT_PADDING, rect.right - estimatedMenuWidth);
      }

      if (y < CHAT_MENU_VIEWPORT_PADDING) {
        y = rect.bottom + CHAT_MENU_ANCHOR_GAP;
        anchorBottom = undefined;
      }

      this.permissionMenuPosition = { x: Math.max(0, x), y: Math.max(0, y), anchorBottom };
    } else {
      this.permissionMenuPosition = { x: window.innerWidth - 302, y: window.innerHeight - 280 };
    }
    event.preventDefault();
    event.stopPropagation();
    this.showContextMenu = false;
    this.showMode = false;
    this.showReasoningMenu = false;
    this.showModelMenu = false;
    this.showPermissionMenu = !this.showPermissionMenu;
  }

  /** 切换模型菜单的显示/隐藏 */
  toggleModelMenu(event: MouseEvent, modelItems: IMenuItem[]): void {
    const estimatedMenuWidth = this.estimateMenuWidth(modelItems, {
      minWidth: 224,
      maxWidth: 300,
      includeGlobalFilter: true,
    });
    this.modelMenuWidth = estimatedMenuWidth;
    const target = event.currentTarget as HTMLElement;
    if (target) {
      const rect = target.getBoundingClientRect();
      const menuHeight = this.estimateMenuHeight(modelItems, { includeGlobalFilter: true });
      let x = rect.left;
      let y = rect.top - menuHeight - CHAT_MENU_ANCHOR_GAP;
      let anchorBottom: number | undefined = rect.top - CHAT_MENU_ANCHOR_GAP;

      if (x + estimatedMenuWidth > window.innerWidth - CHAT_MENU_VIEWPORT_PADDING) {
        x = Math.max(CHAT_MENU_VIEWPORT_PADDING, rect.right - estimatedMenuWidth);
      }

      if (y < CHAT_MENU_VIEWPORT_PADDING) {
        y = rect.bottom + CHAT_MENU_ANCHOR_GAP;
        anchorBottom = undefined;
      }

      this.modelListPosition = { x: Math.max(0, x), y: Math.max(0, y), anchorBottom };
    } else {
      this.modelListPosition = { x: window.innerWidth - 302, y: window.innerHeight - 280 };
    }
    event.preventDefault();
    event.stopPropagation();
    this.showContextMenu = false;
    this.showMode = false;
    this.showPermissionMenu = false;
    this.showReasoningMenu = false;
    this.showModelMenu = !this.showModelMenu;
  }

  private estimateMenuWidth(
    items: IMenuItem[] | null | undefined,
    options: {
      minWidth: number;
      maxWidth: number;
      includeGlobalFilter?: boolean;
    },
  ): number {
    const viewportMaxWidth = Math.max(
      options.minWidth,
      window.innerWidth - CHAT_MENU_VIEWPORT_PADDING * 2,
    );
    const maxWidth = Math.min(options.maxWidth, viewportMaxWidth);
    let width = options.includeGlobalFilter ? 224 : options.minWidth;

    for (const item of items ?? []) {
      if (!item || item.sep) {
        continue;
      }

      const nameWidth = this.estimateTextWidth(item.name);
      const metaWidth = this.estimateTextWidth(item.text);
      const actionCount = Array.isArray(item.actions) ? item.actions.length : 0;
      const actionsWidth = actionCount > 0
        ? actionCount * CHAT_MENU_ITEM_ACTION_WIDTH + Math.max(0, actionCount - 1) * CHAT_MENU_ITEM_ACTION_GAP
        : 0;
      const hasIcon = typeof item.icon === 'string' && item.icon.trim().length > 0;
      const hasArrow = Array.isArray(item.children) && item.children.length > 0 && !item.hideChildrenArrow;

      const itemWidth =
        CHAT_MENU_ITEM_HORIZONTAL_CHROME
        + (hasIcon ? CHAT_MENU_ITEM_ICON_WIDTH : 0)
        + nameWidth
        + (metaWidth > 0 ? CHAT_MENU_ITEM_META_GAP + metaWidth : 0)
        + (item.current ? CHAT_MENU_ITEM_CURRENT_WIDTH : 0)
        + actionsWidth
        + (hasArrow ? 22 : 0);

      width = Math.max(width, itemWidth);
    }

    return Math.round(Math.min(maxWidth, Math.max(options.minWidth, width)));
  }

  private estimateTextWidth(value: unknown): number {
    if (typeof value !== 'string') {
      return 0;
    }

    return Array.from(value.trim()).reduce((total, char) => {
      if (/[\u3400-\u9fff\uff00-\uffef]/.test(char)) {
        return total + 12;
      }
      if (/[A-Z0-9]/.test(char)) {
        return total + 7;
      }
      if (/\s/.test(char)) {
        return total + 4;
      }
      return total + 6;
    }, 0);
  }

  toggleReasoningMenu(event: MouseEvent, reasoningItems: IMenuItem[]): void {
    const target = event.currentTarget as HTMLElement;
    if (target) {
      const rect = target.getBoundingClientRect();
      const menuHeight = this.estimateMenuHeight(reasoningItems);
      const estimatedMenuWidth = 220;
      let x = rect.left;
      let y = rect.bottom + CHAT_MENU_ANCHOR_GAP;

      if (x + estimatedMenuWidth > window.innerWidth - CHAT_MENU_VIEWPORT_PADDING) {
        x = Math.max(CHAT_MENU_VIEWPORT_PADDING, rect.right - estimatedMenuWidth);
      }

      if (y + menuHeight > window.innerHeight - CHAT_MENU_VIEWPORT_PADDING) {
        y = Math.max(CHAT_MENU_VIEWPORT_PADDING, rect.top - menuHeight - CHAT_MENU_ANCHOR_GAP);
      }

      this.reasoningMenuPosition = { x: Math.max(0, x), y: Math.max(0, y) };
    } else {
      this.reasoningMenuPosition = { x: window.innerWidth - 240, y: window.innerHeight - 280 };
    }

    event.preventDefault();
    event.stopPropagation();
    this.showContextMenu = false;
    this.showMode = false;
    this.showPermissionMenu = false;
    this.showModelMenu = false;
    this.showActionMenu = false;
    this.showReasoningMenu = !this.showReasoningMenu;
  }

  toggleActionMenu(event: MouseEvent, actionItems: IMenuItem[]): void {
    const target = event.currentTarget as HTMLElement;
    if (target) {
      const rect = target.getBoundingClientRect();
      const menuHeight = this.estimateMenuHeight(actionItems);
      const estimatedMenuWidth = 300;
      let x = rect.left;
      let y = rect.bottom + CHAT_MENU_ANCHOR_GAP;

      if (x + estimatedMenuWidth > window.innerWidth - CHAT_MENU_VIEWPORT_PADDING) {
        x = Math.max(CHAT_MENU_VIEWPORT_PADDING, rect.right - estimatedMenuWidth);
      }

      if (y + menuHeight > window.innerHeight - CHAT_MENU_VIEWPORT_PADDING) {
        y = Math.max(CHAT_MENU_VIEWPORT_PADDING, rect.top - menuHeight - CHAT_MENU_ANCHOR_GAP);
      }

      this.actionMenuPosition = { x: Math.max(0, x), y: Math.max(0, y) };
    } else {
      this.actionMenuPosition = { x: window.innerWidth - 320, y: 72 };
    }

    event.preventDefault();
    event.stopPropagation();
    this.showContextMenu = false;
    this.showMode = false;
    this.showPermissionMenu = false;
    this.showModelMenu = false;
    this.showActionMenu = !this.showActionMenu;
  }

  private estimateMenuHeight(items: IMenuItem[] | null | undefined, options?: { includeGlobalFilter?: boolean }): number {
    if (!Array.isArray(items) || items.length === 0) {
      return 40;
    }

    const collapsedSections: Record<string, boolean> = {};
    for (const item of items) {
      const action = typeof item?.action === 'string' ? item.action : '';
      if (!action.startsWith('section-toggle-')) {
        continue;
      }

      const sectionId = typeof item?.extra?.sectionId === 'string'
        ? item.extra.sectionId
        : action.slice('section-toggle-'.length);
      if (!sectionId) {
        continue;
      }

      collapsedSections[sectionId] = item.extra?.collapsed !== false;
    }

    let height = 8;
    if (options?.includeGlobalFilter) {
      height += 40;
    }

    for (const item of items) {
      if (item?.sep) {
        height += 9;
        continue;
      }

      const scopedSectionId = typeof item?.extra?.section === 'string' ? item.extra.section : '';
      if (scopedSectionId && collapsedSections[scopedSectionId]) {
        continue;
      }

      if (typeof item?.action === 'string' && item.action.startsWith('section-')) {
        if (item.action.startsWith('section-filter-') && options?.includeGlobalFilter) {
          continue;
        }
        if (item.action.startsWith('section-toggle-')) {
          height += 28;
        } else if (item.action.startsWith('section-filter-')) {
          height += 34;
        } else {
          height += 20;
        }
        continue;
      }

      height += 28;
    }

    return height;
  }
}
