import { AilyHost } from './host';
import {
  buildBlocklyContextSnapshot,
  summarizeBlocklyContextSnapshot,
  type BlocklyContextSnapshot,
  type BlocklyContextSummaryOptions,
} from './blockly-environment-context';

interface BlocklyContextResolveOptions {
  scopes?: readonly string[];
  forceRefresh?: boolean;
  reason?: string;
}

interface BlocklyContextSummaryRequest extends BlocklyContextResolveOptions {
  agentType?: string;
  summaryOptions?: BlocklyContextSummaryOptions;
}

export interface BlocklyContextSnapshotService {
  getSnapshot(options?: BlocklyContextResolveOptions): Promise<BlocklyContextSnapshot>;
  invalidate(scopes: readonly string[], reason: string): void;
  summarize(snapshot: BlocklyContextSnapshot, options?: BlocklyContextSummaryOptions): readonly string[];
  getSummary(options?: BlocklyContextSummaryRequest): Promise<readonly string[]>;
}

let contextSnapshotVersion = 1;
let lastInvalidatedReason: string | undefined;

export function createBlocklyContextSnapshotService(
  resolveHost: () => any = () => AilyHost.get(),
): BlocklyContextSnapshotService {
  return {
  async getSnapshot(_options?: BlocklyContextResolveOptions): Promise<BlocklyContextSnapshot> {
    const snapshot = await buildBlocklyContextSnapshot(resolveHost(), {
      version: contextSnapshotVersion,
      invalidatedBy: lastInvalidatedReason,
    });
    lastInvalidatedReason = undefined;
    return snapshot;
  },

  invalidate(_scopes: readonly string[], reason: string): void {
    contextSnapshotVersion += 1;
    lastInvalidatedReason = reason;
  },

  summarize(snapshot: BlocklyContextSnapshot, options?: BlocklyContextSummaryOptions): readonly string[] {
    return summarizeBlocklyContextSnapshot(snapshot, options);
  },

  async getSummary(options?: BlocklyContextSummaryRequest): Promise<readonly string[]> {
    const snapshot = await this.getSnapshot(options);
    return this.summarize(snapshot, options?.summaryOptions);
  },
  };
}

const service: BlocklyContextSnapshotService = createBlocklyContextSnapshotService();

export function getBlocklyContextSnapshotService(): BlocklyContextSnapshotService {
  return service;
}
