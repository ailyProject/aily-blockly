import { Injectable } from '@angular/core';
import type { BlockCodeMapping } from '../components/blockly/generators/arduino/arduino';

export interface CodeViewerIpcState {
  code?: string;
  selectedBlockId?: string | null;
  selectedBlockIds?: string[];
  blockCodeMap?: Array<[string, BlockCodeMapping]>;
  updatedAt?: number;
}

export function normalizeCodeViewerSelectedBlockIds(
  selectedBlockId: string | null | undefined,
  selectedBlockIds: ReadonlyArray<string> | null | undefined,
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  const append = (blockId: string | null | undefined): void => {
    if (!blockId || seen.has(blockId)) return;
    seen.add(blockId);
    normalized.push(blockId);
  };

  append(selectedBlockId);
  selectedBlockIds?.forEach(append);
  return normalized;
}

@Injectable({
  providedIn: 'root',
})
export class CodeViewerIpcService {
  private pendingCodeState: { code: string; blockCodeMap: Map<string, BlockCodeMapping> } | null = null;
  private codeStatePublishTimer: ReturnType<typeof setTimeout> | null = null;
  private latestSelectedBlockId: string | null = null;
  private latestSelectedBlockIds: string[] = [];
  private readonly codeStatePublishDelay = 200;

  private get api(): any {
    const currentWindow = window as any;
    return currentWindow['codeViewer'] || currentWindow.electronAPI?.codeViewer;
  }

  get isAvailable(): boolean {
    return !!this.api;
  }

  publishState(state: CodeViewerIpcState): void {
    if (!this.isAvailable) return;
    this.api.publishState(state);
  }

  publishCodeState(
    code: string,
    blockCodeMap: Map<string, BlockCodeMapping>,
    selectedBlockId: string | null,
    selectedBlockIds: ReadonlyArray<string> = [],
  ): void {
    if (!this.isAvailable) return;

    this.latestSelectedBlockId = selectedBlockId;
    this.latestSelectedBlockIds = normalizeCodeViewerSelectedBlockIds(
      selectedBlockId,
      selectedBlockIds,
    );
    this.pendingCodeState = { code, blockCodeMap };

    if (this.codeStatePublishTimer) {
      clearTimeout(this.codeStatePublishTimer);
    }

    this.codeStatePublishTimer = setTimeout(() => {
      this.codeStatePublishTimer = null;
      this.flushPendingCodeState();
    }, this.codeStatePublishDelay);
  }

  publishSelection(
    selectedBlockId: string | null,
    selectedBlockIds: ReadonlyArray<string> = [],
  ): void {
    this.latestSelectedBlockId = selectedBlockId;
    this.latestSelectedBlockIds = normalizeCodeViewerSelectedBlockIds(
      selectedBlockId,
      selectedBlockIds,
    );
    this.publishState({
      selectedBlockId,
      selectedBlockIds: this.latestSelectedBlockIds,
    });
  }

  clear(): void {
    if (this.codeStatePublishTimer) {
      clearTimeout(this.codeStatePublishTimer);
      this.codeStatePublishTimer = null;
    }
    this.pendingCodeState = null;
    this.latestSelectedBlockId = null;
    this.latestSelectedBlockIds = [];

    this.publishState({
      code: '',
      selectedBlockId: null,
      selectedBlockIds: [],
      blockCodeMap: [],
    });
  }

  async getState(): Promise<CodeViewerIpcState | null> {
    if (!this.isAvailable) return null;

    try {
      return await this.api.getState();
    } catch (error) {
      console.warn('[CodeViewerIpc] getState failed:', error);
      return null;
    }
  }

  onState(callback: (state: CodeViewerIpcState) => void): () => void {
    if (!this.isAvailable) return () => {};
    return this.api.onState(callback);
  }

  toMap(entries: Array<[string, BlockCodeMapping]> | undefined): Map<string, BlockCodeMapping> {
    return new Map(entries || []);
  }

  private flushPendingCodeState(): void {
    if (!this.pendingCodeState) return;

    const state = this.pendingCodeState;
    this.pendingCodeState = null;

    this.publishState({
      code: state.code,
      selectedBlockId: this.latestSelectedBlockId,
      selectedBlockIds: this.latestSelectedBlockIds,
      blockCodeMap: Array.from(state.blockCodeMap.entries()),
      updatedAt: Date.now(),
    });
  }
}
