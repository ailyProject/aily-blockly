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
import { ChatPerformanceTracer } from '../../services/chat-perf-tracer';

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
      const previousIds = new Set(previousItems.map(item => item.id));
      const nextIds = new Set(items.map(item => item.id));
      ChatPerformanceTracer.increment(
        'activity_item_renderer_diff.inserted',
        items.filter(item => !previousIds.has(item.id)).length,
      );
      ChatPerformanceTracer.increment(
        'activity_item_renderer_diff.disposed',
        previousItems.filter(item => !nextIds.has(item.id)).length,
      );
      ChatPerformanceTracer.increment(
        'activity_item_renderer_diff.retained',
        items.filter(item => previousIds.has(item.id)).length,
      );
      this.cdr.detectChanges();
      return true;
    }

    const renderers = this.itemRenderers?.toArray() ?? [];
    if (renderers.length !== items.length) {
      return false;
    }

    const sharedInputChanged = previousSessionId !== sessionId
      || previousImpliedWordLoadRate !== impliedWordLoadRate;
    let retainedCount = 0;
    let updatedCount = 0;
    for (let index = 0; index < items.length; index += 1) {
      if (!sharedInputChanged && previousItems[index] === items[index]) {
        retainedCount += 1;
        continue;
      }
      updatedCount += 1;
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
    ChatPerformanceTracer.increment('activity_item_renderer_diff.retained', retainedCount);
    ChatPerformanceTracer.increment('activity_item_renderer_diff.updated', updatedCount);
    return true;
  }

  applyItemPatch(
    item: ActivityGroupDisplayItem,
    sessionId: string,
    impliedWordLoadRate: number | undefined,
  ): boolean {
    const itemIndex = this.items.findIndex(candidate => candidate.id === item.id);
    if (itemIndex < 0) {
      return false;
    }
    const renderers = this.itemRenderers?.toArray() ?? [];
    const renderer = renderers[itemIndex];
    if (!renderer) {
      return false;
    }

    const nextItems = [...this.items];
    nextItems[itemIndex] = item;
    this.items = nextItems;
    this.sessionId = sessionId;
    this.impliedWordLoadRate = impliedWordLoadRate;
    return renderer.applyVisibleActivityItemPatch({
      item,
      sessionId,
      impliedWordLoadRate,
      first: itemIndex === 0,
      last: itemIndex === nextItems.length - 1,
      only: nextItems.length === 1,
    });
  }
}
