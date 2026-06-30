import { Injectable } from '@angular/core';
import type { BlockCodeMapping } from '../components/blockly/generators/arduino/arduino';

export interface CodeViewerIpcState {
  code?: string;
  selectedBlockId?: string | null;
  blockCodeMap?: Array<[string, BlockCodeMapping]>;
  updatedAt?: number;
}

@Injectable({
  providedIn: 'root',
})
export class CodeViewerIpcService {
  private pendingCodeState: { code: string; blockCodeMap: Map<string, BlockCodeMapping> } | null = null;
  private codeStatePublishTimer: ReturnType<typeof setTimeout> | null = null;
  private latestSelectedBlockId: string | null = null;
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
  ): void {
    if (!this.isAvailable) return;

    this.latestSelectedBlockId = selectedBlockId;
    this.pendingCodeState = { code, blockCodeMap };

    if (this.codeStatePublishTimer) {
      clearTimeout(this.codeStatePublishTimer);
    }

    this.codeStatePublishTimer = setTimeout(() => {
      this.codeStatePublishTimer = null;
      this.flushPendingCodeState();
    }, this.codeStatePublishDelay);
  }

  publishSelection(selectedBlockId: string | null): void {
    this.latestSelectedBlockId = selectedBlockId;
    this.publishState({ selectedBlockId });
  }

  clear(): void {
    if (this.codeStatePublishTimer) {
      clearTimeout(this.codeStatePublishTimer);
      this.codeStatePublishTimer = null;
    }
    this.pendingCodeState = null;
    this.latestSelectedBlockId = null;

    this.publishState({
      code: '',
      selectedBlockId: null,
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
      blockCodeMap: Array.from(state.blockCodeMap.entries()),
      updatedAt: Date.now(),
    });
  }
}
