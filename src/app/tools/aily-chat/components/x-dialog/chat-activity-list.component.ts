import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  QueryList,
  ViewChildren,
  forwardRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';

import { ChatActivityItemComponent } from './chat-activity-item.component';
import type { ActivityGroupDisplayItem } from './chat-activity-group.types';

@Component({
  selector: 'aily-chat-activity-list',
  standalone: true,
  imports: [CommonModule, forwardRef(() => ChatActivityItemComponent)],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cag-list">
      @for (item of items; track item.id; let first = $first; let last = $last; let count = $count) {
        <aily-chat-activity-item
          [item]="item"
          [sessionId]="sessionId"
          [impliedWordLoadRate]="impliedWordLoadRate"
          [first]="first"
          [last]="last"
          [only]="count === 1"
          [contentDeltaHandler]="contentDeltaHandler" />
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      min-width: 0;
    }

    .cag-list {
      position: relative;
      border: none;
      border-radius: 0;
      padding: 0;
      margin-top: 0;
      margin-left: 8px;
      display: flex;
      flex-direction: column;
      overflow: visible;
    }
  `],
})
export class ChatActivityListComponent {
  @Input() items: readonly ActivityGroupDisplayItem[] = [];
  @Input() sessionId = '';
  @Input() impliedWordLoadRate: number | undefined;
  @Input() contentDeltaHandler: (() => void) | undefined;

  @ViewChildren(forwardRef(() => ChatActivityItemComponent))
  private itemRenderers!: QueryList<ChatActivityItemComponent>;

  constructor(private readonly cdr: ChangeDetectorRef) {}

  /** Apply a response-part revision without checking the parent group subtree. */
  applyItemsPatch(
    items: readonly ActivityGroupDisplayItem[],
    sessionId: string,
    impliedWordLoadRate: number | undefined,
  ): boolean {
    const previousItems = this.items;
    const previousSessionId = this.sessionId;
    const previousImpliedWordLoadRate = this.impliedWordLoadRate;
    const sameStructure = previousItems.length === items.length
      && previousItems.every((item, index) => item.id === items[index]?.id);

    this.items = items;
    this.sessionId = sessionId;
    this.impliedWordLoadRate = impliedWordLoadRate;

    if (!sameStructure) {
      this.cdr.detectChanges();
      return true;
    }

    const renderers = this.itemRenderers?.toArray() ?? [];
    if (renderers.length !== items.length) {
      return false;
    }

    const sharedInputChanged = previousSessionId !== sessionId
      || previousImpliedWordLoadRate !== impliedWordLoadRate;
    for (let index = 0; index < items.length; index += 1) {
      if (!sharedInputChanged && previousItems[index] === items[index]) {
        continue;
      }
      if (!renderers[index]?.applyVisibleActivityItemPatch({
        item: items[index],
        sessionId,
        impliedWordLoadRate,
        first: index === 0,
        last: index === items.length - 1,
        only: items.length === 1,
      })) {
        return false;
      }
    }
    return true;
  }
}
