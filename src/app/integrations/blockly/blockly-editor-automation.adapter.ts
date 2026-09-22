import { Injectable } from '@angular/core';
import type * as Blockly from 'blockly';

import {
  type BlocklyGeneratedCodePort,
  type BlocklyLibraryRuntimeSnapshot,
  type BlocklyLiveEditorPort,
  type BlocklyProjectRevisionSnapshot,
  type BlocklyRuntimeMetadataSnapshot,
} from '@integration/automation/public-api';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { _ProjectService } from '../../editors/blockly-editor/services/project.service';
import { getActiveProjectGenerator, getActiveProjectGeneratorRevision } from '../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { projectDataRuntime } from '@domain/project/public-api';

@Injectable({ providedIn: 'root' })
export class BlocklyEditorAutomationAdapter implements
  BlocklyGeneratedCodePort,
  BlocklyLiveEditorPort {
  constructor(
    private readonly projectService: _ProjectService,
    private readonly blocklyService: BlocklyService,
  ) {}

  getWorkspace(): Blockly.WorkspaceSvg | null {
    this.blocklyService.assertWorkspaceEditAvailable();
    return this.blocklyService.workspace ?? null;
  }

  runWorkspaceOperation<T>(operation: () => Promise<T>): Promise<T> {
    const workspace = this.blocklyService.workspace;
    const page = this.blocklyService.getActivePageId();
    const path = this.projectService.currentProjectPath;
    const generator = getActiveProjectGenerator();
    const runtimeRevision = getActiveProjectGeneratorRevision();
    const session = projectDataRuntime.getSessionToken();
    const assertCurrent = () => {
      if (workspace !== this.blocklyService.workspace || page !== this.blocklyService.getActivePageId()
        || path !== this.projectService.currentProjectPath || generator !== getActiveProjectGenerator()
        || session !== projectDataRuntime.getSessionToken() || runtimeRevision !== getActiveProjectGeneratorRevision()) throw new Error('Queued Blockly mutation belongs to a stale project/page/runtime.');
    };
    return this.blocklyService.runProjectOperation(async () => {
      assertCurrent();
      const result = await operation();
      assertCurrent();
      return result;
    });
  }

  getReusableGeneratedCode(): string {
    return this.blocklyService.getReusableGeneratedCode();
  }

  setAiWritingActive(source: string, active: boolean): void {
    this.blocklyService.setAiWritingActive(source, active);
  }

  async saveProject(path: string): Promise<void> {
    await this.projectService.save(path);
  }

  getProjectRevisionSnapshot(): Promise<BlocklyProjectRevisionSnapshot> {
    return this.projectService.getAbiRevisionSnapshot();
  }

  getRuntimeBlockMetadataSnapshot(): BlocklyRuntimeMetadataSnapshot {
    return this.blocklyService.getRuntimeBlockMetadataSnapshot();
  }

  getLibraryRuntimeSnapshot(): BlocklyLibraryRuntimeSnapshot {
    return this.blocklyService.getLibraryRuntimeSnapshot();
  }
}
