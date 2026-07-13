import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, HostListener, Input, Output } from '@angular/core';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';

import { createBuiltinChatResolvedMode, normalizeChatModeId } from '../core/chat-mode';
import {
  type ChatSessionInventoryGroup,
  formatChatSessionStatusMeta,
  getChatSessionStatusClass,
  shouldShowChatSessionActivitySpinner,
  shouldShowChatSessionUnreadDot,
} from '../helpers/chat-session-presentation';
import type { ChatSessionListAction, ChatSessionListItem } from '../services/menu-manager.service';

const PRIMARY_SESSION_ACTIONS = new Set(['pin-session', 'unpin-session']);
const OVERFLOW_SESSION_ACTIONS = new Set([
  'archive-session',
  'unarchive-session',
  'rename-session',
  'delete-session',
]);
const OVERFLOW_MENU_VIEWPORT_MARGIN = 8;
const OVERFLOW_MENU_GAP = 2;

interface SessionOverflowMenuPosition {
  left: number;
  top: number;
}

@Component({
  selector: 'aily-chat-session-entries',
  standalone: true,
  imports: [CommonModule, NzToolTipModule],
  templateUrl: './chat-session-entries.component.html',
  styleUrl: './chat-session-entries.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatSessionEntriesComponent {
  archivedExpanded = false;
  openOverflowSessionId = '';
  overflowMenuPosition: SessionOverflowMenuPosition | null = null;

  @Input() groups: ReadonlyArray<ChatSessionInventoryGroup> | null = null;
  @Input() items: readonly ChatSessionListItem[] = [];
  @Input() selectedSessionId = '';
  @Input() listAriaLabel = 'Sessions';
  @Input() emptyLabel = 'No sessions';
  @Input() currentBadgeLabel = 'Current';
  @Input() variant: 'list' | 'picker' = 'list';

  @Output() selectSession = new EventEmitter<{ sessionId: string; item: ChatSessionListItem }>();
  @Output() preloadSession = new EventEmitter<{ sessionId: string; item: ChatSessionListItem }>();
  @Output() actionClick = new EventEmitter<{ action: string; data: ChatSessionListItem }>();
  @Output() overflowOpenChange = new EventEmitter<boolean>();

  get isListVariant(): boolean {
    return this.variant === 'list';
  }

  get isPickerVariant(): boolean {
    return this.variant === 'picker';
  }

  get displayGroups(): ReadonlyArray<ChatSessionInventoryGroup> {
    if (Array.isArray(this.groups) && this.groups.length > 0) {
      return this.groups;
    }

    if (this.items.length === 0) {
      return [];
    }

    return [{ id: 'older', label: '', items: this.items }];
  }

  trackBySessionId(_: number, item: ChatSessionListItem): string {
    return item.sessionId;
  }

  isSelected(item: ChatSessionListItem): boolean {
    return item.sessionId === this.selectedSessionId;
  }

  selectItem(item: ChatSessionListItem): void {
    this.selectSession.emit({ sessionId: item.sessionId, item });
  }

  preloadItem(item: ChatSessionListItem): void {
    this.preloadSession.emit({ sessionId: item.sessionId, item });
  }

  triggerAction(event: MouseEvent, action: ChatSessionListAction, item: ChatSessionListItem): void {
    event.stopPropagation();
    this.closeOverflowMenu();
    this.actionClick.emit({ action: action.action, data: item });
  }

  toggleOverflow(event: MouseEvent, item: ChatSessionListItem): void {
    event.stopPropagation();
    if (this.isOverflowOpen(item)) {
      this.closeOverflowMenu();
      return;
    }

    this.overflowMenuPosition = this.calculateOverflowMenuPosition(event.currentTarget, item);
    const wasClosed = !this.openOverflowSessionId;
    this.openOverflowSessionId = item.sessionId;
    if (wasClosed) {
      this.overflowOpenChange.emit(true);
    }
  }

  isOverflowOpen(item: ChatSessionListItem): boolean {
    return this.openOverflowSessionId === item.sessionId;
  }

  @HostListener('document:click')
  closeOverflow(): void {
    this.closeOverflowMenu();
  }

  @HostListener('document:keydown.escape')
  closeOverflowOnEscape(): void {
    this.closeOverflowMenu();
  }

  @HostListener('window:resize')
  closeOverflowOnResize(): void {
    this.closeOverflowMenu();
  }

  formatStatusMeta(item: ChatSessionListItem): string {
    return formatChatSessionStatusMeta(item);
  }

  detailSegments(item: ChatSessionListItem): string[] {
    const target = this.readNonEmptyString(item.requestRouting?.customAgentTarget);
    if (target) {
      return [target];
    }

    const modeId = this.readNonEmptyString(item.requestRouting?.requestModeId)
      ?? this.readNonEmptyString(item.requestRouting?.selectedModeId)
      ?? this.readNonEmptyString(item.mode)
      ?? this.readNonEmptyString(item.inputState?.mode?.kind)
      ?? this.readNonEmptyString(item.inputState?.mode?.id);
    return modeId ? [createBuiltinChatResolvedMode(normalizeChatModeId(modeId)).label] : [];
  }

  hasStatusSeparator(item: ChatSessionListItem): boolean {
    return this.detailSegments(item).length > 0;
  }

  statusClass(status?: string): string {
    return getChatSessionStatusClass(status);
  }

  showActivitySpinner(item: ChatSessionListItem): boolean {
    return shouldShowChatSessionActivitySpinner(item);
  }

  showUnreadDot(item: ChatSessionListItem): boolean {
    return shouldShowChatSessionUnreadDot(item);
  }

  isToggleAction(action: ChatSessionListAction): boolean {
    return action.action === 'pin-session'
      || action.action === 'unpin-session'
      || action.action === 'archive-session'
      || action.action === 'unarchive-session';
  }

  primaryActions(item: ChatSessionListItem): readonly ChatSessionListAction[] {
    return item.actions.filter((action) => PRIMARY_SESSION_ACTIONS.has(action.action));
  }

  overflowActions(item: ChatSessionListItem): readonly ChatSessionListAction[] {
    return item.actions.filter((action) => OVERFLOW_SESSION_ACTIONS.has(action.action));
  }

  hasOverflowActions(item: ChatSessionListItem): boolean {
    return this.overflowActions(item).length > 0;
  }

  getOverflowMenuLeft(item: ChatSessionListItem): number | null {
    return this.isOverflowOpen(item) ? this.overflowMenuPosition?.left ?? null : null;
  }

  getOverflowMenuTop(item: ChatSessionListItem): number | null {
    return this.isOverflowOpen(item) ? this.overflowMenuPosition?.top ?? null : null;
  }

  isCollapsibleGroup(group: ChatSessionInventoryGroup): boolean {
    return group.id === 'archived';
  }

  isGroupExpanded(group: ChatSessionInventoryGroup): boolean {
    return !this.isCollapsibleGroup(group) || this.archivedExpanded;
  }

  toggleGroupExpanded(event: MouseEvent, group: ChatSessionInventoryGroup): void {
    event.stopPropagation();
    if (!this.isCollapsibleGroup(group)) {
      return;
    }

    this.archivedExpanded = !this.archivedExpanded;
  }

  private readNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  private closeOverflowMenu(): void {
    const wasOpen = !!this.openOverflowSessionId;
    this.openOverflowSessionId = '';
    this.overflowMenuPosition = null;
    if (wasOpen) {
      this.overflowOpenChange.emit(false);
    }
  }

  private calculateOverflowMenuPosition(
    trigger: EventTarget | null,
    item: ChatSessionListItem
  ): SessionOverflowMenuPosition {
    const triggerElement = trigger instanceof HTMLElement ? trigger : null;
    const triggerRect = triggerElement?.getBoundingClientRect();
    const actionCount = Math.max(this.overflowActions(item).length, 1);
    const actionSize = this.isPickerVariant ? 22 : 24;
    const menuWidth = actionSize + 10;
    const menuHeight = (actionCount * actionSize) + ((actionCount - 1) * 2) + 10;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

    if (!triggerRect) {
      return {
        left: Math.max(OVERFLOW_MENU_VIEWPORT_MARGIN, viewportWidth - menuWidth - OVERFLOW_MENU_VIEWPORT_MARGIN),
        top: OVERFLOW_MENU_VIEWPORT_MARGIN,
      };
    }

    const preferredLeft = triggerRect.right - menuWidth;
    const left = this.clamp(
      preferredLeft,
      OVERFLOW_MENU_VIEWPORT_MARGIN,
      Math.max(OVERFLOW_MENU_VIEWPORT_MARGIN, viewportWidth - menuWidth - OVERFLOW_MENU_VIEWPORT_MARGIN)
    );
    const bottomTop = triggerRect.bottom + OVERFLOW_MENU_GAP;
    const topTop = triggerRect.top - menuHeight - OVERFLOW_MENU_GAP;
    const top = bottomTop + menuHeight + OVERFLOW_MENU_VIEWPORT_MARGIN <= viewportHeight
      ? bottomTop
      : this.clamp(topTop, OVERFLOW_MENU_VIEWPORT_MARGIN, Math.max(OVERFLOW_MENU_VIEWPORT_MARGIN, viewportHeight - menuHeight - OVERFLOW_MENU_VIEWPORT_MARGIN));

    return { left, top };
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
