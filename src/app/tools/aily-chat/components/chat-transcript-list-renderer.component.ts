import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnDestroy,
  Output,
  QueryList,
  ViewChild,
  ViewChildren,
} from '@angular/core';
import { Subscription } from 'rxjs';

import type { ResourceItem } from '../core/chat-types';
import type { ChatSelectedMode } from '../core/chat-mode';
import type {
  ChatVisibleTranscriptDialogItem,
  ChatVisibleTranscriptDialogItemPatch,
} from '../core/chat-visible-transcript-model';
import type { DialogTurnContext } from '../core/user-turn-action-target';
import type { ChatTaskActionDetail } from '../helpers/chat-task-action-coordinator';
import type { WorkspaceCheckpointPresentationMode } from '../services/edit-checkpoint.service';
import {
  XDialogComponent,
  type ChatDialogItemHeightChange,
} from './x-dialog/x-dialog.component';

export interface ChatTranscriptPatchResult {
  readonly applied: boolean;
  readonly requiresRowMeasurement: boolean;
}

@Component({
  selector: 'aily-chat-transcript-list-renderer',
  standalone: true,
  imports: [XDialogComponent],
  template: `
    <div #rowsContainer class="dialog-list-rows" [style.height.px]="initialRowsContainerHeight">
      @for (item of renderedItems; track item.id; let index = $index) {
        <div
          class="dialog-virtual-row"
          #dialogVirtualRow
          [style.top.px]="initialRowTop(index)"
          [style.height.px]="initialRowHeight(item)"
          [attr.data-chat-item-id]="item.id"
          [attr.data-turn-id]="item.turnId || null"
          [attr.data-response-id]="item.responseId || null">
          <aily-x-dialog
            [item]="item"
            [sessionId]="sessionId"
            [currentMode]="currentMode"
            [selectedMode]="selectedMode"
            [currentModelName]="currentModelName"
            [currentModelChipLabel]="currentModelChipLabel"
            [currentModelBillingLabel]="currentModelBillingLabel"
            [workspaceCheckpointPresentationMode]="workspaceCheckpointPresentationMode"
            [exclusiveEditTurnId]="exclusiveEditTurnId"
            [showModeMenu]="showModeMenu"
            [showModelMenu]="showModelMenu"
            (editSessionOpened)="editSessionOpened.emit($event)"
            (editSessionClosed)="editSessionClosed.emit()"
            (dismissSessionMenus)="dismissSessionMenus.emit()"
            (editAndResend)="editAndResend.emit($event)"
            (editModeToggle)="editModeToggle.emit($event)"
            (editModelToggle)="editModelToggle.emit($event)"
            (editAddFile)="editAddFile.emit($event)"
            (editAddFolder)="editAddFolder.emit($event)"
            (taskAction)="emitTaskAction($event)"
            [contentHeightChangeHandler]="rowContentHeightChangeHandler" />
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      position: relative;
      width: 100%;
      min-width: 0;
    }
    .dialog-list-rows {
      position: relative;
      width: 100%;
      min-width: 0;
      overflow: hidden;
      contain: strict;
      transform: translate3d(0, 0, 0);
    }
    .dialog-virtual-row {
      position: absolute;
      left: 0;
      width: 100%;
      min-width: 0;
      max-width: 100%;
      box-sizing: border-box;
      overflow: hidden;
      contain: layout style;
    }
    aily-x-dialog {
      display: block;
      min-width: 0;
      max-width: 100%;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatTranscriptListRendererComponent implements AfterViewInit, OnDestroy {
  private readonly estimatedRowHeight = 160;
  private _renderedItems: readonly ChatVisibleTranscriptDialogItem[] = [];
  private _topSpacerHeight = 0;
  private _bottomSpacerHeight = 0;
  private readonly rowHeightByItemId = new Map<string, number>();
  private readonly pendingRowHeightChanges = new Map<string, ChatDialogItemHeightChange>();
  private readonly mountedDialogRenderers = new Map<string, XDialogComponent>();
  private readonly mountedUserDialogRenderersByTurnId = new Map<string, XDialogComponent>();
  private readonly pendingRowPatches = new Map<string, ChatVisibleTranscriptDialogItemPatch>();
  private mountedDialogRenderersSubscription: Subscription | null = null;
  private rowsLayoutFrameId: number | null = null;
  private rowPatchFrameId: number | null = null;

  @Input({ required: true })
  set items(value: readonly ChatVisibleTranscriptDialogItem[] | null | undefined) {
    const nextItems = value ?? [];
    if (this._renderedItems === nextItems
      || (this._renderedItems.length === nextItems.length
        && this._renderedItems.every((item, index) => item === nextItems[index]))) {
      return;
    }
    this._renderedItems = nextItems;
    this.pruneRowHeightCache();
    this.scheduleRowsLayout();
  }
  get renderedItems(): readonly ChatVisibleTranscriptDialogItem[] {
    return this._renderedItems;
  }

  @Input()
  set topSpacerHeight(value: number) {
    this._topSpacerHeight = normalizeLayoutHeight(value);
    this.scheduleRowsLayout();
  }
  get topSpacerHeight(): number {
    return this._topSpacerHeight;
  }
  @Input()
  set bottomSpacerHeight(value: number) {
    this._bottomSpacerHeight = normalizeLayoutHeight(value);
    this.scheduleRowsLayout();
  }
  get bottomSpacerHeight(): number {
    return this._bottomSpacerHeight;
  }
  @Input() sessionId = '';
  @Input() currentMode = 'agent';
  @Input() selectedMode: Pick<ChatSelectedMode, 'modeId' | 'customAgentTarget'> | null | undefined;
  @Input() currentModelName = '';
  @Input() currentModelChipLabel = '';
  @Input() currentModelBillingLabel = '';
  @Input() workspaceCheckpointPresentationMode: WorkspaceCheckpointPresentationMode = 'unknown';
  @Input() exclusiveEditTurnId: string | undefined;
  @Input() showModeMenu = false;
  @Input() showModelMenu = false;

  @Output() editSessionOpened = new EventEmitter<string>();
  @Output() editSessionClosed = new EventEmitter<void>();
  @Output() dismissSessionMenus = new EventEmitter<void>();
  @Output() editAndResend = new EventEmitter<{ target: DialogTurnContext; newText: string; resources: ResourceItem[] }>();
  @Output() editModeToggle = new EventEmitter<{ event: MouseEvent; type: 'mode' }>();
  @Output() editModelToggle = new EventEmitter<{ event: MouseEvent; type: 'model' }>();
  @Output() editAddFile = new EventEmitter<DialogTurnContext>();
  @Output() editAddFolder = new EventEmitter<DialogTurnContext>();
  @Output() taskAction = new EventEmitter<ChatTaskActionDetail>();
  @Input() contentHeightChangeHandler: ((change: ChatDialogItemHeightChange) => void) | undefined;

  @ViewChild('rowsContainer', { read: ElementRef }) private rowsContainer?: ElementRef<HTMLElement>;
  @ViewChildren(XDialogComponent) private xDialogComponents!: QueryList<XDialogComponent>;
  @ViewChildren('dialogVirtualRow', { read: ElementRef }) private dialogVirtualRows!: QueryList<ElementRef<HTMLElement>>;

  constructor(
    private readonly cdr: ChangeDetectorRef,
    private readonly ngZone?: NgZone,
  ) {}

  readonly rowContentHeightChangeHandler = (change: ChatDialogItemHeightChange): void => {
    const itemId = typeof change?.itemId === 'string' ? change.itemId.trim() : '';
    const height = normalizeLayoutHeight(change?.height);
    if (!itemId || height <= 0) {
      return;
    }
    if (Math.abs((this.rowHeightByItemId.get(itemId) ?? 0) - height) > 1) {
      this.rowHeightByItemId.set(itemId, height);
    }
    this.pendingRowHeightChanges.set(itemId, { itemId, height });
    this.scheduleRowsLayout();
  };

  get initialRowsContainerHeight(): number {
    return this.computeRowsContainerHeight();
  }

  initialRowTop(index: number): number {
    let top = this._topSpacerHeight;
    for (let itemIndex = 0; itemIndex < index; itemIndex += 1) {
      top += this.readRowHeight(this._renderedItems[itemIndex]);
    }
    return top;
  }

  initialRowHeight(item: ChatVisibleTranscriptDialogItem): number {
    return this.readRowHeight(item);
  }

  ngAfterViewInit(): void {
    this.syncMountedDialogRenderers();
    this.mountedDialogRenderersSubscription = this.xDialogComponents.changes.subscribe(() => {
      this.syncMountedDialogRenderers();
      this.scheduleRowsLayout();
    });
    this.scheduleRowsLayout();
  }

  ngOnDestroy(): void {
    this.mountedDialogRenderersSubscription?.unsubscribe();
    this.mountedDialogRenderersSubscription = null;
    this.mountedDialogRenderers.clear();
    this.mountedUserDialogRenderersByTurnId.clear();
    this.pendingRowHeightChanges.clear();
    this.pendingRowPatches.clear();
    this.cancelRowPatchFrame();
    this.cancelRowsLayout();
  }

  applyPatches(
    patches: readonly ChatVisibleTranscriptDialogItemPatch[],
    canSkipRowDetect: (
      previousItem: ChatVisibleTranscriptDialogItem | null | undefined,
      nextItem: ChatVisibleTranscriptDialogItem,
    ) => boolean,
  ): ChatTranscriptPatchResult {
    if (patches.length === 0) {
      return { applied: false, requiresRowMeasurement: false };
    }

    const nextItems = [...this._renderedItems];
    let requiresListDetect = false;
    let requiresRowMeasurement = false;
    const rowPatches: ChatVisibleTranscriptDialogItemPatch[] = [];

    for (const patch of patches) {
      const existingIndex = nextItems.findIndex(item => item.id === patch.itemId);
      if (patch.kind === 'added') {
        if (existingIndex >= 0) {
          nextItems[existingIndex] = patch.item;
          rowPatches.push({ ...patch, index: existingIndex, kind: 'updated' });
          continue;
        }
        if (patch.index < 0 || patch.index > nextItems.length) {
          return { applied: false, requiresRowMeasurement: false };
        }
        nextItems.splice(patch.index, 0, patch.item);
        requiresListDetect = true;
        requiresRowMeasurement = true;
        continue;
      }

      if (existingIndex < 0) {
        return { applied: false, requiresRowMeasurement: false };
      }
      nextItems[existingIndex] = patch.item;
      rowPatches.push({ ...patch, index: existingIndex });
    }

    this._renderedItems = nextItems;
    if (requiresListDetect) {
      this.pendingRowPatches.clear();
      this.cancelRowPatchFrame();
      this.cdr.detectChanges();
      this.syncMountedDialogRenderers();
    }

    for (const patch of rowPatches) {
      const component = this.mountedDialogRenderers.get(patch.itemId);
      if (!component) {
        return { applied: false, requiresRowMeasurement };
      }
      const pendingPatch = this.pendingRowPatches.get(patch.itemId);
      const effectivePatch = pendingPatch ? mergeDialogItemPatches(pendingPatch, patch) : patch;
      const detectChanges = !canSkipRowDetect(component.item, effectivePatch.item);
      requiresRowMeasurement ||= detectChanges;
      if (!detectChanges) {
        this.pendingRowPatches.set(patch.itemId, effectivePatch);
        this.scheduleRowPatchFrame();
        continue;
      }
      this.pendingRowPatches.delete(patch.itemId);
      if (!component.applyVisibleTranscriptItemPatch(effectivePatch.item, {
        detectChanges,
        ...(effectivePatch.changedParts ? { changedParts: effectivePatch.changedParts } : {}),
      })) {
        return { applied: false, requiresRowMeasurement };
      }
    }

    return { applied: true, requiresRowMeasurement };
  }

  private scheduleRowPatchFrame(): void {
    if (this.rowPatchFrameId !== null) {
      return;
    }
    const schedule = typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as number;
    const enqueue = () => {
      this.rowPatchFrameId = schedule(() => {
        this.rowPatchFrameId = null;
        this.flushPendingRowPatches();
      });
    };
    if (this.ngZone) {
      this.ngZone.runOutsideAngular(enqueue);
    } else {
      enqueue();
    }
  }

  private flushPendingRowPatches(): void {
    if (this.pendingRowPatches.size === 0) {
      return;
    }
    const patches = [...this.pendingRowPatches.values()];
    this.pendingRowPatches.clear();
    for (const patch of patches) {
      const component = this.mountedDialogRenderers.get(patch.itemId);
      if (!component) {
        continue;
      }
      if (!component.applyVisibleTranscriptItemPatch(patch.item, {
        detectChanges: false,
        ...(patch.changedParts ? { changedParts: patch.changedParts } : {}),
      })) {
        this.cdr.detectChanges();
        this.syncMountedDialogRenderers();
        return;
      }
    }
  }

  private cancelRowPatchFrame(): void {
    if (this.rowPatchFrameId === null) {
      return;
    }
    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.rowPatchFrameId);
    } else {
      clearTimeout(this.rowPatchFrameId as unknown as ReturnType<typeof setTimeout>);
    }
    this.rowPatchFrameId = null;
  }

  findDialogByTurnId(turnId: string): XDialogComponent | undefined {
    return this.xDialogComponents?.find(dialog => dialog.role === 'user' && dialog.actionTurnId === turnId);
  }

  readVirtualRows(): readonly ElementRef<HTMLElement>[] {
    return this.dialogVirtualRows?.toArray() ?? [];
  }

  applySessionRequestState(activeTurnId: string | null, requestInProgress: boolean): void {
    const targetTurnId = typeof activeTurnId === 'string' ? activeTurnId.trim() : '';
    if (!targetTurnId) {
      return;
    }
    this.mountedUserDialogRenderersByTurnId
      .get(targetTurnId)
      ?.applySessionRequestState(requestInProgress);
  }

  private syncMountedDialogRenderers(): void {
    this.mountedDialogRenderers.clear();
    this.mountedUserDialogRenderersByTurnId.clear();
    for (const component of this.xDialogComponents?.toArray() ?? []) {
      const itemId = component.item?.id;
      if (itemId) {
        this.mountedDialogRenderers.set(itemId, component);
      }
      const turnId = component.role === 'user' ? component.actionTurnId?.trim() : '';
      if (turnId) {
        this.mountedUserDialogRenderersByTurnId.set(turnId, component);
      }
    }
  }

  private scheduleRowsLayout(): void {
    if (!this.rowsContainer || this.rowsLayoutFrameId !== null) {
      return;
    }
    const schedule = typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as number;
    this.rowsLayoutFrameId = schedule(() => {
      this.rowsLayoutFrameId = null;
      this.layoutRows();
    });
  }

  private cancelRowsLayout(): void {
    if (this.rowsLayoutFrameId === null) {
      return;
    }
    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.rowsLayoutFrameId);
    } else {
      clearTimeout(this.rowsLayoutFrameId as unknown as ReturnType<typeof setTimeout>);
    }
    this.rowsLayoutFrameId = null;
  }

  private layoutRows(): void {
    const container = this.rowsContainer?.nativeElement;
    const rows = this.dialogVirtualRows?.toArray() ?? [];
    if (!container || rows.length !== this._renderedItems.length) {
      return;
    }

    const heights = this._renderedItems.map((item, index) => {
      const cached = this.rowHeightByItemId.get(item.id);
      if (cached && cached > 0) {
        return cached;
      }
      const row = rows[index]?.nativeElement;
      const measured = normalizeLayoutHeight(row?.getBoundingClientRect().height || row?.offsetHeight);
      if (measured > 0) {
        this.rowHeightByItemId.set(item.id, measured);
        return measured;
      }
      return this.estimatedRowHeight;
    });

    let top = this._topSpacerHeight;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index].nativeElement;
      row.style.top = `${Math.round(top)}px`;
      row.style.height = `${Math.max(0, Math.round(heights[index]))}px`;
      top += heights[index];
    }
    container.style.height = `${Math.max(0, Math.round(top + this._bottomSpacerHeight))}px`;

    const pendingChanges = [...this.pendingRowHeightChanges.values()];
    this.pendingRowHeightChanges.clear();
    for (const change of pendingChanges) {
      this.contentHeightChangeHandler?.(change);
    }
  }

  private computeRowsContainerHeight(): number {
    return this._topSpacerHeight
      + this._renderedItems.reduce((height, item) => height + this.readRowHeight(item), 0)
      + this._bottomSpacerHeight;
  }

  private readRowHeight(item: ChatVisibleTranscriptDialogItem | undefined): number {
    return item ? (this.rowHeightByItemId.get(item.id) ?? this.estimatedRowHeight) : 0;
  }

  private pruneRowHeightCache(): void {
    if (this.rowHeightByItemId.size === 0) {
      return;
    }
    const itemIds = new Set(this._renderedItems.map(item => item.id));
    for (const itemId of this.rowHeightByItemId.keys()) {
      if (!itemIds.has(itemId)) {
        this.rowHeightByItemId.delete(itemId);
      }
    }
  }

  emitTaskAction(detail: ChatTaskActionDetail): void {
    this.taskAction.emit({
      ...detail,
      sessionResource: detail.sessionResource?.trim() || this.sessionId.trim(),
    });
  }
}

function mergeDialogItemPatches(
  previous: ChatVisibleTranscriptDialogItemPatch,
  next: ChatVisibleTranscriptDialogItemPatch,
): ChatVisibleTranscriptDialogItemPatch {
  const changedParts = previous.changedParts || next.changedParts
    ? [...(previous.changedParts ?? []), ...(next.changedParts ?? [])]
    : undefined;
  return {
    ...next,
    ...(changedParts ? { changedParts } : {}),
  };
}

function normalizeLayoutHeight(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.ceil(value))
    : 0;
}
