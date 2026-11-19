import { Injectable } from '@angular/core';
import { ActionService } from '@core/app-shell/public-api';
import { ProjectService } from '@domain/project/public-api';
import type { BlocklyBuildInput, BlocklyBuildOutcome, BlocklyBuildPort } from '@domain/build/public-api';

@Injectable({ providedIn: 'root' })
export class BlocklyBuildAdapter implements BlocklyBuildPort {
  constructor(private readonly actions: ActionService, private readonly project: ProjectService) {}

  isAvailable(): boolean {
    return this.actions.hasListener('builder-compile-begin');
  }

  async build(input: BlocklyBuildInput): Promise<BlocklyBuildOutcome> {
    if (!this.isAvailable() || input.projectPath !== this.project.currentProjectPath) {
      throw new Error('The requested Blockly build editor is no longer active.');
    }
    // The mounted editor owns both compile-begin and compile-cancel. Wait for
    // its actual task feedback; the request observer manages its own deadline.
    return new Promise<BlocklyBuildOutcome>((resolve, reject) => {
      this.actions.dispatch('compile-begin', input, feedback => {
        if (feedback.success && feedback.data) resolve(feedback.data);
        else reject(new Error(feedback.error || 'The Blockly build editor did not accept the request.'));
      }, 0, { requireHandler: true });
    });
  }
}
