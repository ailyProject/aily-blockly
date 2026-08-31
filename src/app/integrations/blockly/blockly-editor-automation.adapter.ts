import { Injectable } from '@angular/core';
import type * as Blockly from 'blockly';

import {
  type BlocklyGeneratedCodePort,
  type BlocklyLiveEditorPort,
  type BlocklyProjectRevisionSnapshot,
  type BlocklyRuntimeMetadataSnapshot,
} from '@integration/automation/public-api';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { _ProjectService } from '../../editors/blockly-editor/services/project.service';

@Injectable({ providedIn: 'root' })
export class BlocklyEditorAutomationAdapter implements
  BlocklyGeneratedCodePort,
  BlocklyLiveEditorPort {
  constructor(
    private readonly projectService: _ProjectService,
    private readonly blocklyService: BlocklyService,
  ) {}

  getWorkspace(): Blockly.WorkspaceSvg | null {
    return this.blocklyService.workspace ?? null;
  }

  getReusableGeneratedCode(): string {
    return this.blocklyService.getReusableGeneratedCode();
  }

  setAiWritingActive(source: string, active: boolean): void {
    this.blocklyService.setAiWritingActive(source, active);
  }

  async saveProject(path: string, createHistory: boolean): Promise<void> {
    await this.projectService.save(path, createHistory);
  }

  getProjectRevisionSnapshot(): Promise<BlocklyProjectRevisionSnapshot> {
    return this.projectService.getAbiRevisionSnapshot();
  }

  getRuntimeBlockMetadataSnapshot(): BlocklyRuntimeMetadataSnapshot {
    return this.blocklyService.getRuntimeBlockMetadataSnapshot();
  }
}
