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
    this.publishState({
      code,
      selectedBlockId,
      blockCodeMap: Array.from(blockCodeMap.entries()),
    });
  }

  publishSelection(selectedBlockId: string | null): void {
    this.publishState({ selectedBlockId });
  }

  clear(): void {
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
}