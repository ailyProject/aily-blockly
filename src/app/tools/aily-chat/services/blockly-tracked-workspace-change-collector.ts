import type {
  IToolHostAccess,
  IWorkspaceChangeCollector,
  IWorkspaceTurnEffectsHandle,
  WorkspaceChangeCollectorResult,
} from 'aily-lex/browser';

class BlocklyTrackedWorkspaceTurnEffectsHandle implements IWorkspaceTurnEffectsHandle {
  async collectChanges(_host: IToolHostAccess, _cwd: string, _signal?: AbortSignal): Promise<WorkspaceChangeCollectorResult> {
    return {
      mode: 'tracked',
      changes: [],
    };
  }

  dispose(): void {
    // Explicit Blockly/editor writes are recorded by EditingTimelineRecordingBridge.
  }
}

/**
 * Blockly owns workspace edit tracking through explicit editor operation events.
 * Do not probe Git on every turn completion; Git-aware collection belongs to
 * explicit checkpoint/git features, not the live chat completion cadence.
 */
export class BlocklyTrackedWorkspaceChangeCollector implements IWorkspaceChangeCollector {
  async beginTurn(_host: IToolHostAccess, _cwd: string, _signal?: AbortSignal): Promise<IWorkspaceTurnEffectsHandle> {
    return new BlocklyTrackedWorkspaceTurnEffectsHandle();
  }
}
