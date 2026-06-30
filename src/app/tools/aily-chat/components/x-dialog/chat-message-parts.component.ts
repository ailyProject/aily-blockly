/**
 * ChatMessagePartsComponent — Part-based 消息渲染容器
 *
 * 直接消费 ChatPart[] 数组，按类型路由到对应的渲染器。
 *
 * 架构对齐 Copilot ChatThinkingContentPart：
 *   - 连续的 thinking/tool_call/state Part → aily-chat-activity-group（统一可折叠组）
 *   - 单独 Part → aily-chat-message-part-item（按类型路由至专用 viewer）
 */

import {
  Component,
  Input,
  OnChanges,
  SimpleChanges,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type { TurnResponseTurn } from 'aily-lex/browser';

import { type RenderableChatPart } from './chat-render-parts';
import { buildChatRenderItems, type ActivityGroupRenderItem, type ChatRenderItem } from './chat-subagent-group-projection';
import { ChatActivityGroupComponent } from './chat-activity-group.component';
import { ChatMessagePartItemComponent } from './chat-message-part-item.component';
import { ChatPerformanceTracer } from '../../services/chat-perf-tracer';

@Component({
  selector: 'aily-chat-message-parts',
  standalone: true,
  imports: [
    CommonModule,
    ChatActivityGroupComponent,
    ChatMessagePartItemComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (item of renderItems; track item.id) {
      @if (isGroupItem(item)) {
        <!-- 统一活动组：对齐 Copilot ChatThinkingContentPart -->
        <aily-chat-activity-group
          [parts]="item.parts"
          [doing]="item.live"
          [sessionId]="sessionId"
          [turnResponse]="turnResponse"
          [detailProjectionEnabled]="detailProjectionEnabled"
        />
      } @else {
        <!-- 独立 Part：路由至专用 viewer -->
        <div class="chat-part" [attr.data-part-type]="item.part.type">
          <aily-chat-message-part-item [part]="item.part" [doing]="doing" [sessionId]="sessionId" [turnResponse]="turnResponse" />
        </div>
      }
    }
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      min-width: 0;
    }

    .chat-part:first-child { margin-top: 0; }
    .chat-part:last-child  { margin-bottom: 0; }
  `],
})
export class ChatMessagePartsComponent implements OnChanges {
  @Input() parts: readonly RenderableChatPart[] | null = null;
  @Input() doing = false;
  @Input() sessionId = '';
  @Input() turnResponse: TurnResponseTurn | null = null;
  @Input() detailProjectionEnabled = true;

  renderItems: ChatRenderItem[] = [];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['parts'] || changes['doing']) {
      this._refresh();
    }
  }

  isGroupItem(item: ChatRenderItem): item is ActivityGroupRenderItem {
    return item.kind === 'group';
  }

  private _refresh(): void {
    ChatPerformanceTracer.runWithSurface('chat_projection', () => {
      const parts = this.parts || [];
      const startedAt = performance.now();
      this.renderItems = reuseStableRenderItems(this.renderItems, buildChatRenderItems(parts, this.doing));
      ChatPerformanceTracer.recordDuration(
        'message_parts_component_refresh',
        performance.now() - startedAt,
        `parts=${parts.length},items=${this.renderItems.length},doing=${this.doing}`,
        { slowThresholdMs: 8 },
      );
      ChatPerformanceTracer.recordJankSnapshot('message_parts_component', {
        parts: parts.length,
        renderItems: this.renderItems.length,
        doing: this.doing,
      });
    }, 'message_parts_component_refresh');
  }
}

function reuseStableRenderItems(
  previousItems: readonly ChatRenderItem[],
  nextItems: readonly ChatRenderItem[],
): ChatRenderItem[] {
  if (previousItems.length === 0 || nextItems.length === 0) {
    return [...nextItems];
  }

  const previousById = new Map(previousItems.map((item) => [item.id, item]));
  return nextItems.map((nextItem) => {
    const previousItem = previousById.get(nextItem.id);
    if (!previousItem || previousItem.kind !== nextItem.kind) {
      return nextItem;
    }

    if (nextItem.kind === 'part') {
      return nextItem;
    }

    return previousItem.kind === 'group'
      && !nextItem.live
      && previousItem.live === nextItem.live
      && previousItem.revision === nextItem.revision
      && samePartReferences(previousItem.parts, nextItem.parts)
      ? previousItem
      : nextItem;
  });
}

function samePartReferences(
  previousParts: readonly RenderableChatPart[],
  nextParts: readonly RenderableChatPart[],
): boolean {
  if (previousParts.length !== nextParts.length) {
    return false;
  }

  for (let index = 0; index < previousParts.length; index += 1) {
    if (previousParts[index] !== nextParts[index]) {
      return false;
    }
  }

  return true;
}
