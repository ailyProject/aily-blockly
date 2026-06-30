import { ChangeDetectionStrategy, Component, Input, forwardRef } from '@angular/core';
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
          [first]="first"
          [last]="last"
          [only]="count === 1" />
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
}
