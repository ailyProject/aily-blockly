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
  NgZone,
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

import type { ChatPart } from '../../core/chat-parts';
import {
  isInteractionDecisionDisplayPart,
  isProgressMessageDisplayPart,
  type RenderableChatPart,
} from './chat-render-parts';
import {
  buildActivityGroupRevision,
  buildActivityPartRevision,
  buildChatRenderItems,
  buildInteractionDecisionProjectionIdentity,
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

type MountedPartLocation = {
  readonly itemIndex: number;
  readonly sourcePartIndex: number;
  readonly groupPartIndex?: number;
};

type VisiblePartsPatchInput = {
  readonly parts: readonly RenderableChatPart[];
  readonly changedParts?: readonly RenderableChatPart[];
  readonly changedPartIndices?: readonly number[];
  readonly doing: boolean;
  readonly sessionId: string;
  readonly turnResponse: TurnResponseTurn | null;
  readonly impliedWordLoadRate?: number;
  readonly detailProjectionEnabled: boolean;
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
  private readonly mountedPartLocations = new Map<string, MountedPartLocation>();
  private pendingStreamingPatch: VisiblePartsPatchInput | null = null;
  private readonly pendingStreamingSourcePartIndices = new Set<number>();
  private streamingPatchFrame: number | null = null;

  constructor(
    private readonly cdr?: ChangeDetectorRef,
    private readonly ngZone?: NgZone,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['parts'] || changes['doing']) {
      this._refresh(changes);
    }
  }

  isGroupItem(item: ChatRenderItem): item is ActivityGroupRenderItem {
    return item.kind === 'group';
  }

  ngAfterViewInit(): void {
    this.reconcileMountedRenderers(this.renderItems);
  }

  ngOnDestroy(): void {
    this.cancelPendingStreamingPatch();
    for (const mounted of this.mountedRenderers.values()) {
      mounted.ref.destroy();
    }
    this.mountedRenderers.clear();
  }

  applyVisiblePartsPatch(input: VisiblePartsPatchInput): boolean {
    if (this.canCoalesceStreamingPatch(input)) {
      this.scheduleStreamingPatch(input);
      return true;
    }
    const hadPendingStreamingPatch = this.pendingStreamingPatch !== null;
    this.cancelPendingStreamingPatch();
    const effectiveInput = hadPendingStreamingPatch
      ? { ...input, changedParts: undefined, changedPartIndices: undefined }
      : input;
    return ChatPerformanceTracer.runWithSurface(
      'chat_projection',
      () => {
        const startedAt = performance.now();
        try {
          return this.applyVisiblePartsPatchInternal(effectiveInput);
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

  private canCoalesceStreamingPatch(input: VisiblePartsPatchInput): boolean {
    if (!(input.doing
      && !!input.changedParts?.length
      && input.changedParts.every(part => part.type === 'markdown' || part.type === 'thinking')
      && !!this.parts
      && this.parts.length === input.parts.length
      && this.doing === input.doing
      && this.sessionId === input.sessionId
      && this.detailProjectionEnabled === input.detailProjectionEnabled
      && this.mountedPartLocations.size > 0)) {
      return false;
    }

    const sourcePartIndices = this.readChangedPartIndices(input);
    return !!sourcePartIndices?.length && sourcePartIndices.every(sourcePartIndex => {
      const part = input.parts[sourcePartIndex];
      return !!part && this.mountedPartLocations.has(buildChatPartIdentity(part as any, sourcePartIndex));
    });
  }

  private scheduleStreamingPatch(input: VisiblePartsPatchInput): void {
    this.pendingStreamingPatch = input;
    for (const sourcePartIndex of this.readChangedPartIndices(input) ?? []) {
      this.pendingStreamingSourcePartIndices.add(sourcePartIndex);
    }
    if (this.streamingPatchFrame !== null) {
      return;
    }

    const schedule = () => {
      const requestFrame = typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame.bind(globalThis)
        : (callback: FrameRequestCallback) => globalThis.setTimeout(() => callback(Date.now()), 16) as unknown as number;
      this.streamingPatchFrame = requestFrame(() => {
        this.streamingPatchFrame = null;
        this.flushPendingStreamingPatch();
      });
    };
    if (this.ngZone) {
      this.ngZone.runOutsideAngular(schedule);
    } else {
      schedule();
    }
  }

  private flushPendingStreamingPatch(): void {
    const pending = this.pendingStreamingPatch;
    if (!pending) {
      return;
    }
    const changedPartIndices = [...this.pendingStreamingSourcePartIndices]
      .sort((left, right) => left - right);
    const changedParts = changedPartIndices
      .map(sourcePartIndex => pending.parts[sourcePartIndex])
      .filter((part): part is RenderableChatPart => !!part);
    this.pendingStreamingPatch = null;
    this.pendingStreamingSourcePartIndices.clear();
    ChatPerformanceTracer.runWithSurface(
      'chat_projection',
      () => {
        const startedAt = performance.now();
        try {
          this.applyVisiblePartsPatchInternal({
            ...pending,
            changedParts,
            changedPartIndices,
          });
        } finally {
          ChatPerformanceTracer.recordDuration(
            'message_parts_streaming_frame_actual',
            performance.now() - startedAt,
            `parts=${pending.parts.length},changed=${changedParts.length}`,
            { slowThresholdMs: 8 },
          );
        }
      },
      'message_parts_streaming_frame',
    );
  }

  private cancelPendingStreamingPatch(): void {
    if (this.streamingPatchFrame !== null) {
      if (typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(this.streamingPatchFrame);
      } else {
        globalThis.clearTimeout(this.streamingPatchFrame);
      }
    }
    this.streamingPatchFrame = null;
    this.pendingStreamingPatch = null;
    this.pendingStreamingSourcePartIndices.clear();
  }

  private applyVisiblePartsPatchInternal(input: VisiblePartsPatchInput): boolean {
    const partDeltaPatch = this.tryApplyChangedPartDelta(input);
    if (partDeltaPatch !== null) {
      return partDeltaPatch;
    }
    const nextItems = buildChatRenderItems(input.parts, input.doing);
    if (!canPatchRenderItemsInPlace(this.renderItems, nextItems)) {
      return this.applyStructuralPartsPatch(input, nextItems);
    }

    const previousDoing = this.doing;
    const previousSessionId = this.sessionId;
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
          || previousDetailProjectionEnabled !== input.detailProjectionEnabled
          || previousContinuation !== nextContinuation) {
          changedItemIds.add(next.id);
        }
        continue;
      }
      if (previousDoing !== input.doing
        || previousSessionId !== input.sessionId) {
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
    this.rebuildMountedPartLocations(input.parts, this.renderItems);
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
      readonly changedParts?: readonly RenderableChatPart[];
      readonly changedPartIndices?: readonly number[];
      readonly doing: boolean;
      readonly sessionId: string;
      readonly turnResponse: TurnResponseTurn | null;
      readonly impliedWordLoadRate?: number;
      readonly detailProjectionEnabled: boolean;
    },
    nextItems: readonly ChatRenderItem[],
  ): true {
    const changedItemIds = collectChangedRenderItemIds({
      previousItems: this.renderItems,
      nextItems,
      previousDoing: this.doing,
      nextDoing: input.doing,
      previousSessionId: this.sessionId,
      nextSessionId: input.sessionId,
      previousTurnResponse: this.turnResponse,
      nextTurnResponse: input.turnResponse,
      previousDetailProjectionEnabled: this.detailProjectionEnabled,
      nextDetailProjectionEnabled: input.detailProjectionEnabled,
    });
    this.parts = input.parts;
    this.doing = input.doing;
    this.sessionId = input.sessionId;
    this.turnResponse = input.turnResponse;
    this.impliedWordLoadRate = input.impliedWordLoadRate;
    this.detailProjectionEnabled = input.detailProjectionEnabled;
    this.renderItems = reuseStableRenderItems(this.renderItems, nextItems);
    this.rebuildMountedPartLocations(input.parts, this.renderItems);
    ChatPerformanceTracer.increment('message_parts_incremental_patch.structure_local');
    if (this.renderHost) {
      this.reconcileMountedRenderers(this.renderItems, changedItemIds);
    } else {
      this.cdr?.detectChanges();
    }
    return true;
  }

  private tryApplyChangedPartDelta(input: {
    readonly parts: readonly RenderableChatPart[];
    readonly changedParts?: readonly RenderableChatPart[];
    readonly changedPartIndices?: readonly number[];
    readonly doing: boolean;
    readonly sessionId: string;
    readonly turnResponse: TurnResponseTurn | null;
    readonly impliedWordLoadRate?: number;
    readonly detailProjectionEnabled: boolean;
  }): boolean | null {
    const previousParts = this.parts;
    if (!input.changedParts?.length
      || !previousParts
      || previousParts.length !== input.parts.length
      || this.doing !== input.doing
      || this.sessionId !== input.sessionId
      || this.detailProjectionEnabled !== input.detailProjectionEnabled
      || buildContinuationRevision(this.turnResponse) !== buildContinuationRevision(input.turnResponse)) {
      return null;
    }

    const changedSourcePartIndices = this.readChangedPartIndices(input);
    if (!changedSourcePartIndices?.length) {
      return null;
    }
    const pendingItems = new Map<number, ChatRenderItem>();
    const changedGroupParts = new Map<number, ChatPart[]>();
    const changedGroupPartIndices = new Map<number, number[]>();
    for (const sourcePartIndex of changedSourcePartIndices) {
      const nextPart = input.parts[sourcePartIndex];
      const previousPart = previousParts[sourcePartIndex];
      if (!nextPart || !previousPart) {
        return null;
      }
      // Interaction completion changes the render-item topology: the canonical
      // part stays mounted in its group while a read-only transcript item is
      // added or removed. Let the structural reconciler preserve stable item
      // identities instead of patching only the old group membership.
      if (buildInteractionDecisionProjectionIdentity(previousPart)
        || buildInteractionDecisionProjectionIdentity(nextPart)) {
        return null;
      }
      const identity = buildChatPartIdentity(nextPart as any, sourcePartIndex);
      const location = this.mountedPartLocations.get(identity);
      if (!location) {
        return null;
      }
      if (location.sourcePartIndex !== sourcePartIndex) {
        return null;
      }
      const currentItem = pendingItems.get(location.itemIndex) ?? this.renderItems[location.itemIndex];
      if (!currentItem) {
        return null;
      }
      const normalizedPart = normalizePartForProjection(nextPart, location.sourcePartIndex);
      if (currentItem.kind === 'part') {
        pendingItems.set(location.itemIndex, { ...currentItem, part: normalizedPart });
        continue;
      }
      if (normalizedPart.type === 'progress' || location.groupPartIndex === undefined) {
        return null;
      }
      const groupParts = [...currentItem.parts];
      groupParts[location.groupPartIndex] = normalizedPart as any;
      const changedParts = changedGroupParts.get(location.itemIndex) ?? [];
      changedParts.push(normalizedPart as ChatPart);
      changedGroupParts.set(location.itemIndex, changedParts);
      const changedPartIndices = changedGroupPartIndices.get(location.itemIndex) ?? [];
      changedPartIndices.push(location.groupPartIndex);
      changedGroupPartIndices.set(location.itemIndex, changedPartIndices);
      pendingItems.set(location.itemIndex, {
        ...currentItem,
        parts: groupParts,
        revision: buildActivityGroupRevision(groupParts, currentItem.sourcePartIndices),
      });
    }

    for (const [itemIndex, item] of pendingItems) {
      const mounted = this.mountedRenderers.get(item.id);
      if (!mounted || mounted.kind !== item.kind) {
        return null;
      }
      let applied: boolean;
      if (item.kind === 'part' && mounted.kind === 'part') {
        applied = mounted.ref.instance.applyVisiblePartPatch({
            part: item.part,
            doing: input.doing,
            sessionId: input.sessionId,
            turnResponse: input.turnResponse,
            impliedWordLoadRate: input.impliedWordLoadRate,
          });
      } else if (item.kind === 'group' && mounted.kind === 'group') {
        applied = mounted.ref.instance.applyVisibleGroupPatch({
          parts: item.parts,
          changedParts: changedGroupParts.get(itemIndex),
          changedPartIndices: changedGroupPartIndices.get(itemIndex),
          doing: item.live,
          sessionId: input.sessionId,
          turnResponse: input.turnResponse,
          impliedWordLoadRate: input.impliedWordLoadRate,
          detailProjectionEnabled: input.detailProjectionEnabled,
        });
      } else {
        return null;
      }
      if (!applied) {
        return null;
      }
      this.renderItems[itemIndex] = item;
    }

    this.parts = input.parts;
    this.doing = input.doing;
    this.sessionId = input.sessionId;
    this.turnResponse = input.turnResponse;
    this.impliedWordLoadRate = input.impliedWordLoadRate;
    this.detailProjectionEnabled = input.detailProjectionEnabled;
    ChatPerformanceTracer.increment('message_parts_incremental_patch.host_part_delta');
    return true;
  }

  private rebuildMountedPartLocations(
    parts: readonly RenderableChatPart[],
    items: readonly ChatRenderItem[],
  ): void {
    this.mountedPartLocations.clear();
    items.forEach((item, itemIndex) => {
      if (item.kind === 'part') {
        const sourcePartIndex = item.sourcePartIndex;
        const sourcePart = sourcePartIndex === undefined ? undefined : parts[sourcePartIndex];
        if (sourcePart && sourcePartIndex !== undefined) {
          const identity = buildChatPartIdentity(sourcePart as any, sourcePartIndex);
          this.mountedPartLocations.set(identity, { itemIndex, sourcePartIndex });
        }
        return;
      }
      item.parts.forEach((part, groupPartIndex) => {
        const sourcePartIndex = item.sourcePartIndices[groupPartIndex];
        const sourcePart = sourcePartIndex === undefined ? undefined : parts[sourcePartIndex];
        if (sourcePart && sourcePartIndex !== undefined) {
          const identity = buildChatPartIdentity(sourcePart as any, sourcePartIndex);
          this.mountedPartLocations.set(identity, { itemIndex, sourcePartIndex, groupPartIndex });
        }
      });
    });
  }

  private readChangedPartIndices(
    input: Pick<VisiblePartsPatchInput, 'parts' | 'changedParts' | 'changedPartIndices'>,
  ): number[] | null {
    if (!input.changedParts?.length
      || !input.changedPartIndices?.length
      || input.changedParts.length !== input.changedPartIndices.length) {
      return null;
    }

    const resolved = new Set<number>();
    for (const sourcePartIndex of input.changedPartIndices) {
      if (!Number.isInteger(sourcePartIndex)
        || sourcePartIndex < 0
        || sourcePartIndex >= input.parts.length) {
        return null;
      }
      resolved.add(sourcePartIndex);
    }
    return [...resolved];
  }

  private _refresh(changes?: SimpleChanges): void {
    ChatPerformanceTracer.runWithSurface('chat_projection', () => {
      const parts = this.parts || [];
      const startedAt = performance.now();
      const nextItems = buildChatRenderItems(parts, this.doing);
      const changedItemIds = collectChangedRenderItemIds({
        previousItems: this.renderItems,
        nextItems,
        previousDoing: changes?.['doing']?.previousValue ?? this.doing,
        nextDoing: this.doing,
        previousSessionId: this.sessionId,
        nextSessionId: this.sessionId,
        previousTurnResponse: this.turnResponse,
        nextTurnResponse: this.turnResponse,
        previousDetailProjectionEnabled: this.detailProjectionEnabled,
        nextDetailProjectionEnabled: this.detailProjectionEnabled,
      });
      this.renderItems = reuseStableRenderItems(this.renderItems, nextItems);
      this.rebuildMountedPartLocations(parts, this.renderItems);
      this.reconcileMountedRenderers(this.renderItems, changedItemIds);
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
    changedItemIds?: ReadonlySet<string>,
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
      ChatPerformanceTracer.increment('message_parts_renderer_diff.disposed');
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
        ChatPerformanceTracer.increment('message_parts_renderer_diff.disposed');
        mounted = undefined;
      }

      if (!mounted) {
        mounted = this.createMountedRenderer(item, index);
        this.mountedRenderers.set(item.id, mounted);
        ChatPerformanceTracer.increment('message_parts_renderer_diff.inserted');
        continue;
      }

      ChatPerformanceTracer.increment('message_parts_renderer_diff.retained');
      const currentIndex = host.indexOf(mounted.ref.hostView);
      if (currentIndex !== index) {
        host.move(mounted.ref.hostView, index);
        ChatPerformanceTracer.increment('message_parts_renderer_diff.moved');
      }
      if (changedItemIds?.has(item.id)) {
        this.patchMountedRenderer(mounted, item);
        ChatPerformanceTracer.increment('message_parts_renderer_diff.updated');
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

type RenderItemDiffInput = {
  readonly previousItems: readonly ChatRenderItem[];
  readonly nextItems: readonly ChatRenderItem[];
  readonly previousDoing: boolean;
  readonly nextDoing: boolean;
  readonly previousSessionId: string;
  readonly nextSessionId: string;
  readonly previousTurnResponse: TurnResponseTurn | null;
  readonly nextTurnResponse: TurnResponseTurn | null;
  readonly previousDetailProjectionEnabled: boolean;
  readonly nextDetailProjectionEnabled: boolean;
};

/**
 * Mirrors VS Code's content-part diff contract: retained content is represented
 * by no update, while only changed indices consume an in-place renderer patch.
 * Structural insert/move/remove work is owned by the container itself.
 */
function collectChangedRenderItemIds(input: RenderItemDiffInput): Set<string> {
  const changedItemIds = new Set<string>();
  const previousById = new Map(input.previousItems.map(item => [item.id, item]));
  const continuationChanged = buildContinuationRevision(input.previousTurnResponse)
    !== buildContinuationRevision(input.nextTurnResponse);

  for (const next of input.nextItems) {
    const previous = previousById.get(next.id);
    if (!previous || previous.kind !== next.kind) {
      continue;
    }
    if (hasRenderItemRevisionChanged(previous, next)) {
      changedItemIds.add(next.id);
      continue;
    }

    if (next.kind === 'group') {
      if (input.previousSessionId !== input.nextSessionId
        || input.previousDetailProjectionEnabled !== input.nextDetailProjectionEnabled
        || continuationChanged) {
        changedItemIds.add(next.id);
      }
      continue;
    }

    if (input.previousDoing !== input.nextDoing
      || input.previousSessionId !== input.nextSessionId) {
      changedItemIds.add(next.id);
    }
  }

  return changedItemIds;
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
      previousItem.sourcePartIndex = nextItem.sourcePartIndex;
      return previousItem;
    }

    if (previousItem.kind !== 'group') {
      return nextItem;
    }

    previousItem.parts = nextItem.parts;
    previousItem.sourcePartIndices = nextItem.sourcePartIndices;
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
    if (isInteractionDecisionDisplayPart(previous.part) || isInteractionDecisionDisplayPart(next.part)) {
      return !isInteractionDecisionDisplayPart(previous.part)
        || !isInteractionDecisionDisplayPart(next.part)
        || previous.part.interactionKind !== next.part.interactionKind
        || buildActivityPartRevision(previous.part.source, 0) !== buildActivityPartRevision(next.part.source, 0);
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
