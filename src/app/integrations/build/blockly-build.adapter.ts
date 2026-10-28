import { Injectable, Injector } from '@angular/core';
import { ActionService } from '@core/app-shell/public-api';
import { ProjectService } from '@domain/project/public-api';
import type { BlocklyBuildInput, BlocklyBuildOutcome, BlocklyBuildPort, BuildCheckpoint } from '@domain/build/public-api';
import { _BuilderService } from '../../editors/blockly-editor/services/builder.service';

@Injectable({ providedIn: 'root' })
export class BlocklyBuildAdapter implements BlocklyBuildPort {
  constructor(private readonly actions: ActionService, private readonly project: ProjectService,
    private readonly injector: Injector) {}

  isAvailable(): boolean {
    return this.actions.hasListener('builder-compile-begin');
  }

  async build(input: BlocklyBuildInput): Promise<BlocklyBuildOutcome> {
    if (!this.isAvailable() || input.projectPath !== this.project.currentProjectPath) {
      throw new Error('The requested Blockly build editor is no longer active.');
    }
    // Resolve lazily: Coder/disk builds must not instantiate the Blockly editor.
    const editor = this.injector.get(_BuilderService);
    const checkpoint: BuildCheckpoint = {};
    try {
      const result = await editor.build(input.graphSemanticRevision, input.requestId, checkpoint);
      return { success: true, result, checkpoint };
    } catch (error) {
      const result = error as BlocklyBuildOutcome['result'];
      return { success: false, result: result && typeof result === 'object' ? result : { text: String(error) }, checkpoint };
    }
  }
}
