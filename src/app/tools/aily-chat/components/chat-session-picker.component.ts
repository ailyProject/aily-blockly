import { CommonModule } from '@angular/common';
import {
  AfterViewChecked,
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { ChatSessionListItem, MenuPosition } from '../services/menu-manager.service';
import {
  buildChatSessionSearchText,
  groupChatSessionPickerItemsByDate,
  type ChatSessionInventoryGroup,
} from '../helpers/chat-session-presentation';
import { ChatSessionEntriesComponent } from './chat-session-entries.component';

@Component({
  selector: 'aily-chat-session-picker',
  standalone: true,
  imports: [CommonModule, FormsModule, ChatSessionEntriesComponent],
  templateUrl: './chat-session-picker.component.html',
  styleUrl: './chat-session-picker.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatSessionPickerComponent implements AfterViewInit, AfterViewChecked, OnChanges {
  @Input() groups: readonly ChatSessionInventoryGroup[] = [];
  @Input() items: readonly ChatSessionListItem[] = [];
  @Input() selectedSessionId = '';
  @Input() revealSessionId = '';
  @Input() position: MenuPosition = { x: 0, y: 0 };
  @Input() width = 320;
  @Input() maxHeight = 360;

  @Output() selectSession = new EventEmitter<{ sessionId: string; item: ChatSessionListItem }>();
  @Output() preloadSession = new EventEmitter<{ sessionId: string; item: ChatSessionListItem }>();
  @Output() actionClick = new EventEmitter<{ action: string; data: ChatSessionListItem }>();
  @Output() closeRequested = new EventEmitter<void>();

  @ViewChild('pickerRoot') pickerRoot?: ElementRef<HTMLElement>;
  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;

  filterValue = '';
  private pendingRevealSessionId = '';
  private cachedSourceGroups: {
    groupsInput: readonly ChatSessionInventoryGroup[];
    itemsInput: readonly ChatSessionListItem[];
    groups: readonly ChatSessionInventoryGroup[];
  } | null = null;
  private cachedFilteredGroups: {
    sourceGroups: readonly ChatSessionInventoryGroup[];
    query: string;
    groups: readonly ChatSessionInventoryGroup[];
  } | null = null;
  private cachedFilteredItems: {
    groups: readonly ChatSessionInventoryGroup[];
    items: readonly ChatSessionListItem[];
  } | null = null;

  ngAfterViewInit(): void {
    setTimeout(() => {
      this.searchInput?.nativeElement.focus();
      this.searchInput?.nativeElement.select();
    });
    this.scheduleReveal(this.revealSessionId || this.selectedSessionId);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['items'] || changes['selectedSessionId'] || changes['revealSessionId']) {
      this.scheduleReveal(this.revealSessionId || this.selectedSessionId);
    }
  }

  ngAfterViewChecked(): void {
    this.flushPendingReveal();
  }

  get sourceGroups(): readonly ChatSessionInventoryGroup[] {
    if (this.cachedSourceGroups?.groupsInput === this.groups && this.cachedSourceGroups.itemsInput === this.items) {
      return this.cachedSourceGroups.groups;
    }

    const groups = this.groups.length > 0
      ? this.groups
      : groupChatSessionPickerItemsByDate(this.items);
    this.cachedSourceGroups = {
      groupsInput: this.groups,
      itemsInput: this.items,
      groups,
    };
    return groups;
  }

  get filteredGroups(): readonly ChatSessionInventoryGroup[] {
    const query = this.filterValue.trim().toLowerCase();
    const sourceGroups = this.sourceGroups;
    if (this.cachedFilteredGroups?.sourceGroups === sourceGroups && this.cachedFilteredGroups.query === query) {
      return this.cachedFilteredGroups.groups;
    }

    const groups = !query
      ? sourceGroups
      : sourceGroups
        .map(group => ({
          ...group,
          items: group.items.filter(item => buildChatSessionSearchText(item).includes(query)),
        }))
        .filter(group => group.items.length > 0);

    this.cachedFilteredGroups = {
      sourceGroups,
      query,
      groups,
    };
    return groups;
  }

  get filteredItems(): readonly ChatSessionListItem[] {
    const groups = this.filteredGroups;
    if (this.cachedFilteredItems?.groups === groups) {
      return this.cachedFilteredItems.items;
    }

    const items = groups.flatMap(group => group.items);
    this.cachedFilteredItems = {
      groups,
      items,
    };
    return items;
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

  handleFilterChanged(): void {
    this.scheduleReveal(this.revealSessionId || this.selectedSessionId);
  }

  @HostListener('document:click', ['$event'])
  @HostListener('document:contextmenu', ['$event'])
  handleDocumentPointer(event: MouseEvent): void {
    const target = event.target as Node | null;
    if (!target) {
      this.closeRequested.emit();
      return;
    }

    if (!this.pickerRoot?.nativeElement.contains(target)) {
      this.closeRequested.emit();
    }
  }

  @HostListener('document:keydown.escape')
  handleEscape(): void {
    this.closeRequested.emit();
  }

  private scheduleReveal(sessionId: string): void {
    this.pendingRevealSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  }

  private flushPendingReveal(): void {
    const sessionId = this.pendingRevealSessionId;
    if (sessionId.length === 0) {
      return;
    }

    if (!this.filteredItems.some(item => item.sessionId === sessionId)) {
      this.pendingRevealSessionId = '';
      return;
    }

    const itemElement = Array.from(this.pickerRoot?.nativeElement.querySelectorAll<HTMLElement>('[data-session-id]') ?? [])
      .find(candidate => candidate.dataset['sessionId'] === sessionId);
    if (!itemElement) {
      return;
    }

    itemElement.scrollIntoView({ block: 'nearest' });
    this.pendingRevealSessionId = '';
  }
}
