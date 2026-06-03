import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';

import type { ChatSessionListAction, ChatSessionListItem } from '../services/menu-manager.service';
import {
  type ChatSessionInventoryGroup,
  formatChatSessionStatusMeta,
  getChatSessionStatusClass,
  shouldShowChatSessionActivitySpinner,
  shouldShowChatSessionUnreadDot,
} from '../helpers/chat-session-presentation';

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

  @Input() groups: ReadonlyArray<ChatSessionInventoryGroup> | null = null;
  @Input() items: readonly ChatSessionListItem[] = [];
  @Input() selectedSessionId = '';
  @Input() listAriaLabel = 'Sessions';
  @Input() emptyLabel = 'No sessions';
  @Input() currentBadgeLabel = 'Current';
  @Input() variant: 'list' | 'picker' = 'list';

  @Output() selectSession = new EventEmitter<{ sessionId: string; item: ChatSessionListItem }>();
  @Output() actionClick = new EventEmitter<{ action: string; data: ChatSessionListItem }>();

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

  triggerAction(event: MouseEvent, action: ChatSessionListAction, item: ChatSessionListItem): void {
    event.stopPropagation();
    this.actionClick.emit({ action: action.action, data: item });
  }

  formatStatusMeta(item: ChatSessionListItem): string {
    return formatChatSessionStatusMeta(item);
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
}