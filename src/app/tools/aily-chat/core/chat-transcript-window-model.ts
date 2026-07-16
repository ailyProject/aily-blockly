import type { ChatVisibleTranscriptDialogItem } from './chat-visible-transcript-model';

export interface ChatTranscriptWindowOptions {
  readonly minimumItemCount: number;
  readonly overscanPx: number;
  readonly estimatedUserHeight: number;
  readonly estimatedAssistantHeight: number;
}

export interface ChatTranscriptWindowSnapshot {
  readonly items: readonly ChatVisibleTranscriptDialogItem[];
  readonly startIndex: number;
  readonly endIndex: number;
  readonly topSpacerHeight: number;
  readonly bottomSpacerHeight: number;
  readonly totalHeight: number;
}

const DEFAULT_OPTIONS: ChatTranscriptWindowOptions = {
  minimumItemCount: 40,
  overscanPx: 1200,
  estimatedUserHeight: 92,
  estimatedAssistantHeight: 160,
};

/**
 * Renderer-owned transcript range model. It mirrors VS Code ListView's split:
 * stable elements live outside the DOM while a prefix-height index resolves the
 * mounted range without scanning every preceding row on each scroll frame.
 */
export class ChatTranscriptWindowModel {
  private readonly options: ChatTranscriptWindowOptions;
  private readonly measuredHeightById = new Map<string, number>();
  private readonly indexById = new Map<string, number>();
  private readonly heightIndex = new PrefixHeightIndex();
  private sourceItems: ChatVisibleTranscriptDialogItem[] = [];
  private currentSnapshot: ChatTranscriptWindowSnapshot = {
    items: [], startIndex: 0, endIndex: 0,
    topSpacerHeight: 0, bottomSpacerHeight: 0, totalHeight: 0,
  };

  constructor(options: Partial<ChatTranscriptWindowOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get snapshot(): ChatTranscriptWindowSnapshot { return this.currentSnapshot; }
  get source(): readonly ChatVisibleTranscriptDialogItem[] { return this.sourceItems; }
  get measuredRowCount(): number { return this.measuredHeightById.size; }
  get totalHeight(): number { return this.heightIndex.total; }

  shouldWindow(items: readonly ChatVisibleTranscriptDialogItem[] = this.sourceItems): boolean {
    return items.length > this.options.minimumItemCount;
  }

  setItems(items: readonly ChatVisibleTranscriptDialogItem[]): boolean {
    const previousItems = this.sourceItems;
    let prefixLength = 0;
    const sharedLength = Math.min(previousItems.length, items.length);
    while (prefixLength < sharedLength && previousItems[prefixLength].id === items[prefixLength].id) {
      prefixLength++;
    }

    let previousSuffix = previousItems.length;
    let nextSuffix = items.length;
    while (previousSuffix > prefixLength && nextSuffix > prefixLength
      && previousItems[previousSuffix - 1].id === items[nextSuffix - 1].id) {
      previousSuffix--;
      nextSuffix--;
    }

    const structureChanged = previousItems.length !== items.length || prefixLength !== previousItems.length;
    let referencesChanged = structureChanged;
    if (structureChanged) {
      this.sourceItems.splice(prefixLength, previousSuffix - prefixLength, ...items.slice(prefixLength, nextSuffix));
    }
    for (let index = 0; index < items.length; index++) {
      if (this.sourceItems[index] !== items[index]) {
        this.sourceItems[index] = items[index];
        referencesChanged = true;
      }
    }
    if (structureChanged) {
      this.rebuildHeightIndex();
    }
    if (referencesChanged) {
      this.refreshCurrentSnapshotItems();
    }
    return referencesChanged;
  }

  showAll(): boolean { return this.applyWindow(0, this.sourceItems.length); }

  layout(viewportTop: number, viewportHeight: number): boolean {
    if (!this.shouldWindow()) {
      return this.showAll();
    }
    const top = Math.max(0, viewportTop - this.options.overscanPx);
    const bottom = Math.max(top, viewportTop + Math.max(1, viewportHeight) + this.options.overscanPx);
    return this.layoutRange(top, bottom);
  }

  layoutRange(windowTop: number, windowBottom: number): boolean {
    if (this.sourceItems.length === 0) {
      return this.applyWindow(0, 0);
    }
    const totalHeight = this.heightIndex.total;
    const boundedTop = Math.max(0, Math.min(windowTop, totalHeight));
    const boundedBottom = Math.max(boundedTop, Math.min(windowBottom, totalHeight));
    const start = Math.min(this.sourceItems.length - 1, this.heightIndex.firstIndexEndingAtOrAfter(boundedTop));
    const end = Math.min(this.sourceItems.length, this.heightIndex.countWithEndAtOrBefore(boundedBottom) + 1);
    return this.applyWindow(start, Math.max(start + 1, end));
  }

  layoutItem(index: number): boolean {
    const boundedIndex = Math.max(0, Math.min(index, this.sourceItems.length - 1));
    const itemTop = this.offsetBefore(boundedIndex);
    const itemBottom = itemTop + this.heightAt(boundedIndex);
    return this.layoutRange(
      Math.max(0, itemTop - this.options.overscanPx),
      itemBottom + this.options.overscanPx,
    );
  }

  layoutBottom(viewportHeight: number): boolean {
    const viewportTop = Math.max(0, this.totalHeight - Math.max(1, viewportHeight));
    return this.layoutRange(
      Math.max(0, viewportTop - this.options.overscanPx),
      this.totalHeight,
    );
  }

  updateMeasuredHeight(itemId: string, height: number): boolean {
    if (!Number.isFinite(height) || height <= 0) {
      return false;
    }
    const previous = this.measuredHeightById.get(itemId);
    if (previous != null && Math.abs(previous - height) <= 1) {
      return false;
    }
    this.measuredHeightById.set(itemId, height);
    const index = this.indexById.get(itemId);
    if (index != null) {
      this.heightIndex.set(index, height);
    }
    return true;
  }

  offsetBefore(index: number): number {
    return this.heightIndex.prefix(Math.max(0, Math.min(index, this.sourceItems.length)));
  }

  heightAt(index: number): number { return this.heightIndex.get(index); }

  private applyWindow(startIndex: number, endIndex: number): boolean {
    const boundedStart = Math.max(0, Math.min(startIndex, this.sourceItems.length));
    const boundedEnd = Math.max(boundedStart, Math.min(endIndex, this.sourceItems.length));
    const topSpacerHeight = this.heightIndex.prefix(boundedStart);
    const bottomSpacerHeight = Math.max(0, this.heightIndex.total - this.heightIndex.prefix(boundedEnd));
    const previous = this.currentSnapshot;
    const nextItems = this.sourceItems.slice(boundedStart, boundedEnd);
    const sameItems = previous.items.length === nextItems.length
      && previous.items.every((item, index) => item === nextItems[index]);
    const changed = previous.startIndex !== boundedStart || previous.endIndex !== boundedEnd
      || Math.abs(previous.topSpacerHeight - topSpacerHeight) > 1
      || Math.abs(previous.bottomSpacerHeight - bottomSpacerHeight) > 1 || !sameItems;
    if (changed) {
      this.currentSnapshot = {
        items: sameItems ? previous.items : nextItems,
        startIndex: boundedStart,
        endIndex: boundedEnd,
        topSpacerHeight: Math.max(0, Math.round(topSpacerHeight)),
        bottomSpacerHeight: Math.max(0, Math.round(bottomSpacerHeight)),
        totalHeight: this.heightIndex.total,
      };
    }
    return changed;
  }

  private refreshCurrentSnapshotItems(): void {
    const { startIndex, endIndex } = this.currentSnapshot;
    this.currentSnapshot = {
      ...this.currentSnapshot,
      items: this.sourceItems.slice(startIndex, Math.min(endIndex, this.sourceItems.length)),
      totalHeight: this.heightIndex.total,
    };
  }

  private rebuildHeightIndex(): void {
    this.indexById.clear();
    const liveIds = new Set<string>();
    const heights = this.sourceItems.map((item, index) => {
      this.indexById.set(item.id, index);
      liveIds.add(item.id);
      return this.measuredHeightById.get(item.id) ?? this.estimateHeight(item);
    });
    for (const itemId of Array.from(this.measuredHeightById.keys())) {
      if (!liveIds.has(itemId)) {
        this.measuredHeightById.delete(itemId);
      }
    }
    this.heightIndex.reset(heights);
  }

  private estimateHeight(item: ChatVisibleTranscriptDialogItem): number {
    return item.role === 'user' ? this.options.estimatedUserHeight : this.options.estimatedAssistantHeight;
  }
}

class PrefixHeightIndex {
  private values: number[] = [];
  private tree: number[] = [0];

  get total(): number { return this.prefix(this.values.length); }

  reset(values: readonly number[]): void {
    this.values = Array.from(values);
    this.tree = new Array(values.length + 1).fill(0);
    for (let index = 0; index < values.length; index++) {
      this.add(index, values[index]);
    }
  }

  get(index: number): number { return this.values[index] ?? 0; }

  set(index: number, value: number): void {
    if (index < 0 || index >= this.values.length) return;
    const delta = value - this.values[index];
    this.values[index] = value;
    this.add(index, delta);
  }

  prefix(endExclusive: number): number {
    let index = Math.max(0, Math.min(endExclusive, this.values.length));
    let sum = 0;
    while (index > 0) {
      sum += this.tree[index];
      index -= index & -index;
    }
    return sum;
  }

  firstIndexEndingAtOrAfter(target: number): number {
    if (this.values.length === 0 || target <= 0) return 0;
    let index = 0;
    let sum = 0;
    for (let bit = highestPowerOfTwoAtMost(this.values.length); bit !== 0; bit >>= 1) {
      const next = index + bit;
      if (next <= this.values.length && sum + this.tree[next] < target) {
        index = next;
        sum += this.tree[next];
      }
    }
    return Math.min(index, this.values.length - 1);
  }

  countWithEndAtOrBefore(target: number): number {
    let index = 0;
    let sum = 0;
    for (let bit = highestPowerOfTwoAtMost(this.values.length); bit !== 0; bit >>= 1) {
      const next = index + bit;
      if (next <= this.values.length && sum + this.tree[next] <= target) {
        index = next;
        sum += this.tree[next];
      }
    }
    return index;
  }

  private add(index: number, delta: number): void {
    for (let treeIndex = index + 1; treeIndex < this.tree.length; treeIndex += treeIndex & -treeIndex) {
      this.tree[treeIndex] += delta;
    }
  }
}

function highestPowerOfTwoAtMost(value: number): number {
  let result = 1;
  while ((result << 1) <= value) result <<= 1;
  return value > 0 ? result : 0;
}
