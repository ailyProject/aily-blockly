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
  ChangeDetectorRef,
  AfterViewInit,
  ComponentRef,
  OnDestroy,
  QueryList,
  SimpleChange,
  ViewChild,
  ViewContainerRef,
  ViewChildren,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type { TurnResponseTurn } from 'aily-lex/browser';

import { isProgressMessageDisplayPart, type RenderableChatPart } from './chat-render-parts';
import {
  buildActivityGroupRevision,
  buildActivityPartRevision,
  buildChatRenderItems,
  normalizePartForProjection,
  type ActivityGroupRenderItem,
  type ChatRenderItem,
} from './chat-subagent-group-projection';
import { buildChatPartIdentity } from './chat-activity-group-projection';
import { ChatActivityGroupComponent } from './chat-activity-group.component';
import { ChatMessagePartItemComponent } from './chat-message-part-item.component';
import { ChatPerformanceTracer } from '../../services/chat-perf-tracer';

type MountedChatRenderItem = {
  readonly kind: 'part';
  readonly ref: ComponentRef<ChatMessagePartItemComponent>;
} | {
  readonly kind: 'group';
  readonly ref: ComponentRef<ChatActivityGroupComponent>;
};

@Component({
  selector: 'aily-chat-message-parts',
  standalone: true,
  imports: [
    CommonModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ng-container #renderHost />`,
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
export class ChatMessagePartsComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input() parts: readonly RenderableChatPart[] | null = null;
  @Input() doing = false;
  @Input() sessionId = '';
  @Input() turnResponse: TurnResponseTurn | null = null;
  @Input() impliedWordLoadRate: number | undefined;
  @Input() detailProjectionEnabled = true;
  contentDeltaHandler: (() => void) | undefined;
  @ViewChild('renderHost', { read: ViewContainerRef, static: true })
  private renderHost?: ViewContainerRef;
  @ViewChildren(ChatMessagePartItemComponent) private partRenderers!: QueryList<ChatMessagePartItemComponent>;
  @ViewChildren(ChatActivityGroupComponent) private groupRenderers!: QueryList<ChatActivityGroupComponent>;

  renderItems: ChatRenderItem[] = [];
  private readonly mountedRenderers = new Map<string, MountedChatRenderItem>();

  constructor(private readonly cdr?: ChangeDetectorRef) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['parts'] || changes['doing']) {
      this._refresh();
    }
  }

  isGroupItem(item: ChatRenderItem): item is ActivityGroupRenderItem {
    return item.kind === 'group';
  }

  ngAfterViewInit(): void {
    this.reconcileMountedRenderers(this.renderItems, true);
  }

  ngOnDestroy(): void {
    for (const mounted of this.mountedRenderers.values()) {
      mounted.ref.destroy();
    }
    this.mountedRenderers.clear();
  }

  applyVisiblePartsPatch(input: {
    readonly parts: readonly RenderableChatPart[];
    readonly doing: boolean;
    readonly sessionId: string;
    readonly turnResponse: TurnResponseTurn | null;
    readonly impliedWordLoadRate?: number;
    readonly detailProjectionEnabled: boolean;
  }): boolean {
    return ChatPerformanceTracer.runWithSurface(
      'chat_projection',
      () => {
        const startedAt = performance.now();
        try {
          return this.applyVisiblePartsPatchInternal(input);
        } finally {
          ChatPerformanceTracer.recordDuration(
            'message_parts_incremental_patch_actual',
            performance.now() - startedAt,
            `parts=${input.parts.length},doing=${input.doing}`,
            { slowThresholdMs: 8 },
          );
        }
      },
      'message_parts_incremental_patch',
    );
  }

  private applyVisiblePartsPatchInternal(input: {
    readonly parts: readonly RenderableChatPart[];
    readonly doing: boolean;
    readonly sessionId: string;
    readonly turnResponse: TurnResponseTurn | null;
    readonly impliedWordLoadRate?: number;
    readonly detailProjectionEnabled: boolean;
  }): boolean {
    const streamingTextPatch = this.tryApplyStableStreamingTextPatch(input);
    if (streamingTextPatch !== null) {
      return streamingTextPatch;
    }
    const nextItems = buildChatRenderItems(input.parts, input.doing);
    if (!canPatchRenderItemsInPlace(this.renderItems, nextItems)) {
      return this.applyStructuralPartsPatch(input, nextItems);
    }

    const previousDoing = this.doing;
    const previousSessionId = this.sessionId;
    const previousRate = this.impliedWordLoadRate;
    const previousDetailProjectionEnabled = this.detailProjectionEnabled;
    const previousContinuation = buildContinuationRevision(this.turnResponse);
    const nextContinuation = buildContinuationRevision(input.turnResponse);
    const changedItemIds = new Set<string>();
    for (let index = 0; index < nextItems.length; index += 1) {
      const previous = this.renderItems[index];
      const next = nextItems[index];
      if (!previous || !next || hasRenderItemRevisionChanged(previous, next)) {
        if (next) {
          changedItemIds.add(next.id);
        }
        continue;
      }
      if (next.kind === 'group') {
        if (previousSessionId !== input.sessionId
          || previousRate !== input.impliedWordLoadRate
          || previousDetailProjectionEnabled !== input.detailProjectionEnabled
          || previousContinuation !== nextContinuation) {
          changedItemIds.add(next.id);
        }
        continue;
      }
      if (previousDoing !== input.doing
        || previousSessionId !== input.sessionId
        || (next.part.type === 'markdown' && previousRate !== input.impliedWordLoadRate)) {
        changedItemIds.add(next.id);
      }
    }

    const partRenderers = this.readMountedPartRenderers();
    const groupRenderers = this.readMountedGroupRenderers();
    if (nextItems.some((item) => item.kind === 'part'
      ? !partRenderers.has(item.id)
      : !groupRenderers.has(item.id))) {
      return this.applyStructuralPartsPatch(input, nextItems);
    }

    this.parts = input.parts;
    this.doing = input.doing;
    this.sessionId = input.sessionId;
    this.turnResponse = input.turnResponse;
    this.impliedWordLoadRate = input.impliedWordLoadRate;
    this.detailProjectionEnabled = input.detailProjectionEnabled;
    this.renderItems = reuseStableRenderItems(this.renderItems, nextItems);
    this.reconcileMountedRenderers(this.renderItems);

    for (const item of this.renderItems) {
      if (!changedItemIds.has(item.id)) {
        continue;
      }
      if (item.kind === 'part') {
        if (!partRenderers.get(item.id)?.applyVisiblePartPatch({
          part: item.part,
          doing: input.doing,
          sessionId: this.sessionId,
          turnResponse: input.turnResponse,
          impliedWordLoadRate: input.impliedWordLoadRate,
        })) {
          return this.applyStructuralPartsPatch(input, nextItems);
        }
        continue;
      }

      if (!groupRenderers.get(item.id)?.applyVisibleGroupPatch({
        parts: item.parts,
        doing: item.live,
        sessionId: this.sessionId,
        turnResponse: input.turnResponse,
        impliedWordLoadRate: input.impliedWordLoadRate,
        detailProjectionEnabled: input.detailProjectionEnabled,
      })) {
        return this.applyStructuralPartsPatch(input, nextItems);
      }
    }
    return true;
  }

  private applyStructuralPartsPatch(
    input: {
      readonly parts: readonly RenderableChatPart[];
      readonly doing: boolean;
      readonly sessionId: string;
      readonly turnResponse: TurnResponseTurn | null;
      readonly impliedWordLoadRate?: number;
      readonly detailProjectionEnabled: boolean;
    },
    nextItems: readonly ChatRenderItem[],
  ): true {
    this.parts = input.parts;
    this.doing = input.doing;
    this.sessionId = input.sessionId;
    this.turnResponse = input.turnResponse;
    this.impliedWordLoadRate = input.impliedWordLoadRate;
    this.detailProjectionEnabled = input.detailProjectionEnabled;
    this.renderItems = reuseStableRenderItems(this.renderItems, nextItems);
    ChatPerformanceTracer.increment('message_parts_incremental_patch.structure_local');
    if (this.renderHost) {
      this.reconcileMountedRenderers(this.renderItems, true);
    } else {
      this.cdr?.detectChanges();
    }
    return true;
  }

  private tryApplyStableStreamingTextPatch(input: {
    readonly parts: readonly RenderableChatPart[];
    readonly doing: boolean;
    readonly sessionId: string;
    readonly turnResponse: TurnResponseTurn | null;
    readonly impliedWordLoadRate?: number;
    readonly detailProjectionEnabled: boolean;
  }): boolean | null {
    const previousParts = this.parts;
    if (!previousParts
      || previousParts.length !== input.parts.length
      || this.doing !== input.doing
      || this.sessionId !== input.sessionId
      || this.impliedWordLoadRate !== input.impliedWordLoadRate
      || this.detailProjectionEnabled !== input.detailProjectionEnabled
      || buildContinuationRevision(this.turnResponse) !== buildContinuationRevision(input.turnResponse)) {
      return null;
    }

    const changedParts = new Map<string, RenderableChatPart>();
    for (let index = 0; index < input.parts.length; index += 1) {
      const previous = previousParts[index];
      const next = input.parts[index];
      const previousIdentity = buildChatPartIdentity(previous as any, 0);
      const nextIdentity = buildChatPartIdentity(next as any, 0);
      if (previousIdentity !== nextIdentity) {
        return null;
      }
      if (buildActivityPartRevision(previous as any, index) === buildActivityPartRevision(next as any, index)) {
        continue;
      }
      if ((next.type !== 'markdown' && next.type !== 'thinking')
        || (previous.type !== 'markdown' && previous.type !== 'thinking')) {
        return null;
      }
      changedParts.set(nextIdentity, normalizePartForProjection(next, index));
    }

    if (changedParts.size === 0) {
      this.parts = input.parts;
      this.turnResponse = input.turnResponse;
      return true;
    }

    const changedItemIds = new Set<string>();
    const matchedChangedPartIds = new Set<string>();
    const nextItems = this.renderItems.map((item) => {
      if (item.kind === 'part') {
        const identity = buildChatPartIdentity(item.part as any, 0);
        const replacement = changedParts.get(identity);
        if (!replacement) {
          return item;
        }
        matchedChangedPartIds.add(identity);
        changedItemIds.add(item.id);
        return { ...item, part: replacement };
      }

      let groupChanged = false;
      const parts = item.parts.map((part) => {
        const identity = buildChatPartIdentity(part, 0);
        const replacement = changedParts.get(identity);
        if (!replacement || replacement.type === 'progress') {
          return part;
        }
        matchedChangedPartIds.add(identity);
        groupChanged = true;
        return replacement as any;
      });
      if (!groupChanged) {
        return item;
      }
      changedItemIds.add(item.id);
      return {
        ...item,
        parts,
        revision: buildActivityGroupRevision(parts),
      };
    });

    if (matchedChangedPartIds.size !== changedParts.size) {
      return null;
    }

    const partRenderers = this.readMountedPartRenderers();
    const groupRenderers = this.readMountedGroupRenderers();
    for (const item of nextItems) {
      if (!changedItemIds.has(item.id)) {
        continue;
      }
      const applied = item.kind === 'part'
        ? partRenderers.get(item.id)?.applyVisiblePartPatch({
            part: item.part,
            doing: input.doing,
            sessionId: this.sessionId,
            turnResponse: input.turnResponse,
            impliedWordLoadRate: input.impliedWordLoadRate,
          })
        : groupRenderers.get(item.id)?.applyVisibleGroupPatch({
            parts: item.parts,
            doing: item.live,
            sessionId: this.sessionId,
            turnResponse: input.turnResponse,
            impliedWordLoadRate: input.impliedWordLoadRate,
            detailProjectionEnabled: input.detailProjectionEnabled,
          });
      if (!applied) {
        return null;
      }
    }

    this.parts = input.parts;
    this.sessionId = input.sessionId;
    this.turnResponse = input.turnResponse;
    this.renderItems = nextItems;
    ChatPerformanceTracer.increment('message_parts_incremental_patch.stable_streaming_text');
    return true;
  }

  private _refresh(): void {
    ChatPerformanceTracer.runWithSurface('chat_projection', () => {
      const parts = this.parts || [];
      const startedAt = performance.now();
      this.renderItems = reuseStableRenderItems(this.renderItems, buildChatRenderItems(parts, this.doing));
      this.reconcileMountedRenderers(this.renderItems, true);
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

  private readMountedPartRenderers(): Map<string, ChatMessagePartItemComponent> {
    const renderers = new Map<string, ChatMessagePartItemComponent>();
    for (const [id, mounted] of this.mountedRenderers) {
      if (mounted.kind === 'part') {
        renderers.set(id, mounted.ref.instance);
      }
    }
    for (const renderer of this.partRenderers?.map(renderer => renderer) ?? []) {
      if (!renderers.has(renderer.renderItemId)) {
        renderers.set(renderer.renderItemId, renderer);
      }
    }
    return renderers;
  }

  private readMountedGroupRenderers(): Map<string, ChatActivityGroupComponent> {
    const renderers = new Map<string, ChatActivityGroupComponent>();
    for (const [id, mounted] of this.mountedRenderers) {
      if (mounted.kind === 'group') {
        renderers.set(id, mounted.ref.instance);
      }
    }
    for (const renderer of this.groupRenderers?.map(renderer => renderer) ?? []) {
      if (!renderers.has(renderer.renderItemId)) {
        renderers.set(renderer.renderItemId, renderer);
      }
    }
    return renderers;
  }

  private reconcileMountedRenderers(
    items: readonly ChatRenderItem[],
    patchExisting = false,
  ): void {
    const host = this.renderHost;
    if (!host) {
      return;
    }

    const desiredIds = new Set(items.map(item => item.id));
    for (const [id, mounted] of [...this.mountedRenderers]) {
      if (desiredIds.has(id)) {
        continue;
      }
      const viewIndex = host.indexOf(mounted.ref.hostView);
      if (viewIndex >= 0) {
        host.remove(viewIndex);
      } else {
        mounted.ref.destroy();
      }
      this.mountedRenderers.delete(id);
    }

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      let mounted = this.mountedRenderers.get(item.id);
      if (mounted && mounted.kind !== item.kind) {
        const mountedIndex = host.indexOf(mounted.ref.hostView);
        if (mountedIndex >= 0) {
          host.remove(mountedIndex);
        } else {
          mounted.ref.destroy();
        }
        this.mountedRenderers.delete(item.id);
        mounted = undefined;
      }

      if (!mounted) {
        mounted = this.createMountedRenderer(item, index);
        this.mountedRenderers.set(item.id, mounted);
        continue;
      }

      const currentIndex = host.indexOf(mounted.ref.hostView);
      if (currentIndex !== index) {
        host.move(mounted.ref.hostView, index);
      }
      if (patchExisting) {
        this.patchMountedRenderer(mounted, item);
      }
    }
  }

  private createMountedRenderer(item: ChatRenderItem, index: number): MountedChatRenderItem {
    const host = this.renderHost!;
    if (item.kind === 'group') {
      const ref = host.createComponent(ChatActivityGroupComponent, { index });
      const instance = ref.instance;
      instance.renderItemId = item.id;
      instance.parts = item.parts;
      instance.doing = item.live;
      instance.sessionId = this.sessionId;
      instance.turnResponse = this.turnResponse;
      instance.impliedWordLoadRate = this.impliedWordLoadRate;
      instance.detailProjectionEnabled = this.detailProjectionEnabled;
      instance.contentDeltaHandler = this.contentDeltaHandler;
      instance.ngOnChanges({
        parts: new SimpleChange(undefined, item.parts, true),
        doing: new SimpleChange(undefined, item.live, true),
      });
      ref.changeDetectorRef.detectChanges();
      return { kind: 'group', ref };
    }

    const ref = host.createComponent(ChatMessagePartItemComponent, { index });
    const instance = ref.instance;
    instance.renderItemId = item.id;
    instance.part = item.part;
    instance.doing = this.doing;
    instance.sessionId = this.sessionId;
    instance.turnResponse = this.turnResponse;
    instance.impliedWordLoadRate = this.impliedWordLoadRate;
    instance.ngOnChanges({
      part: new SimpleChange(undefined, item.part, true),
      doing: new SimpleChange(undefined, this.doing, true),
      impliedWordLoadRate: new SimpleChange(undefined, this.impliedWordLoadRate, true),
    });
    const element = ref.location.nativeElement as HTMLElement;
    element.classList.add('chat-part');
    element.dataset['partType'] = item.part.type;
    element.style.display = 'block';
    ref.changeDetectorRef.detectChanges();
    return { kind: 'part', ref };
  }

  private patchMountedRenderer(mounted: MountedChatRenderItem, item: ChatRenderItem): void {
    if (mounted.kind === 'part' && item.kind === 'part') {
      mounted.ref.instance.applyVisiblePartPatch({
        part: item.part,
        doing: this.doing,
        sessionId: this.sessionId,
        turnResponse: this.turnResponse,
        impliedWordLoadRate: this.impliedWordLoadRate,
      });
      (mounted.ref.location.nativeElement as HTMLElement).dataset['partType'] = item.part.type;
      return;
    }
    if (mounted.kind === 'group' && item.kind === 'group') {
      mounted.ref.instance.applyVisibleGroupPatch({
        parts: item.parts,
        doing: item.live,
        sessionId: this.sessionId,
        turnResponse: this.turnResponse,
        impliedWordLoadRate: this.impliedWordLoadRate,
        detailProjectionEnabled: this.detailProjectionEnabled,
      });
    }
  }
}

function canPatchRenderItemsInPlace(
  previousItems: readonly ChatRenderItem[],
  nextItems: readonly ChatRenderItem[],
): boolean {
  if (previousItems.length === 0 || previousItems.length !== nextItems.length) {
    return false;
  }

  for (let index = 0; index < previousItems.length; index += 1) {
    const previous = previousItems[index];
    const next = nextItems[index];
    if (!previous || !next || previous.id !== next.id || previous.kind !== next.kind) {
      return false;
    }
  }

  return true;
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
      if (previousItem.kind !== 'part') {
        return nextItem;
      }
      previousItem.part = nextItem.part;
      return previousItem;
    }

    if (previousItem.kind !== 'group') {
      return nextItem;
    }

    previousItem.parts = nextItem.parts;
    previousItem.revision = nextItem.revision;
    previousItem.live = nextItem.live;
    return previousItem;
  });
}

function hasRenderItemRevisionChanged(previous: ChatRenderItem, next: ChatRenderItem): boolean {
  if (previous.id !== next.id || previous.kind !== next.kind) {
    return true;
  }
  if (previous.kind === 'group' && next.kind === 'group') {
    return previous.revision !== next.revision || previous.live !== next.live;
  }
  if (previous.kind === 'part' && next.kind === 'part') {
    if (isProgressMessageDisplayPart(previous.part) || isProgressMessageDisplayPart(next.part)) {
      return !isProgressMessageDisplayPart(previous.part)
        || !isProgressMessageDisplayPart(next.part)
        || previous.part.progressKind !== next.part.progressKind
        || previous.part.content !== next.part.content;
    }
    return buildActivityPartRevision(previous.part, 0) !== buildActivityPartRevision(next.part, 0);
  }
  return true;
}

function buildContinuationRevision(turnResponse: TurnResponseTurn | null): string {
  const continuation = turnResponse?.response?.continuation;
  if (!continuation) {
    return '';
  }
  return [
    continuation.interactionId ?? '',
    continuation.stepIndex ?? '',
    continuation.lease ?? '',
    continuation.status ?? '',
    continuation.stopReason ?? '',
    continuation.hardStopReason ?? '',
    continuation.pendingState?.['kind'] ?? '',
  ].join(':');
}
