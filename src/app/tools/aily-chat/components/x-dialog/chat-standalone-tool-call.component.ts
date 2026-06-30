import { ChangeDetectionStrategy, Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';

import type { ToolCallPart } from '../../core/chat-parts';
import { ChatActivityItemComponent } from './chat-activity-item.component';
import type { ActivityGroupDisplayItem } from './chat-activity-group.types';
import { buildToolActivityDisplayItem } from './chat-activity-group-projection';

@Component({
  selector: 'aily-chat-standalone-tool-call',
  standalone: true,
  imports: [CommonModule, ChatActivityItemComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (displayItem) {
      <aily-chat-activity-item [item]="displayItem" [only]="true" />
    }
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      min-width: 0;
    }
  `],
})
export class ChatStandaloneToolCallComponent implements OnChanges {
  @Input({ required: true }) part!: ToolCallPart;

  displayItem: ActivityGroupDisplayItem | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['part'] && this.part) {
      this.displayItem = buildToolActivityDisplayItem(this.part);
    }
  }
}