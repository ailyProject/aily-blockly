import { Injectable } from '@angular/core';
import { ProjectService } from '@domain/project/public-api';
import { SerialOperationQueue } from '@shared/public-api';
import type { IMenuItem } from '../../configs/menu.config';
import { CodeEditorProProjectService } from '../../editors/code-editor-pro/services/code-editor-pro-project.service';
import { CoderProjectRuntimeService } from './coder-project-runtime.service';
import { planBoardSourceEdits, writeBoardSourceEdits } from './board-config/source-edits';

@Injectable({ providedIn: 'root' })
export class CoderBoardConfigService {
  private readonly queue = new SerialOperationQueue();
  constructor(
    private readonly projects: ProjectService,
    private readonly persistence: CodeEditorProProjectService,
    private readonly runtime: CoderProjectRuntimeService,
  ) {}

  select(path: string, selection: IMenuItem): Promise<boolean> {
    return this.queue.run(async () => {
      const changed = await this.projects.withCoderBoardConfigMutation(path, () => this.apply(path, selection));
      // Coder has no Blockly preprocess-trigger listener; compile saved source.
      if (changed && !selection.extra?.selectAction) await this.runtime.build(path, { preprocessOnly: true });
      return changed;
    });
  }

  private async apply(path: string, selection: IMenuItem): Promise<boolean> {
    if (!path || this.projects.currentProjectPath !== path || selection.disabled || !selection.key) return false;
    if (this.projects.getCoderOperation(path)) {
      throw new Error('工程正在加载、编译或上传，请完成后再修改主板配置。');
    }
    const project = this.projects.getCoderProjectContext(path);
    const menu = await project.getBoardConfigMenu({ persistDefaults: false });
    const option = menu.filter(item => !item.disabled).flatMap(item => item.children || [])
      .find(item => item.key === selection.key && item.data === selection.data && !item.disabled);
    if (!option) throw new Error('主板选项已改变，请重新打开菜单。');
    const original = await project.getPackageJson();
    if (original.projectConfig?.[option.key!] === option.data) return false;
    await this.persistence.saveAll(path);
    if (this.projects.currentProjectPath !== path || this.projects.getCoderOperation(path)) {
      throw new Error('工程状态已改变，请重新选择配置。');
    }
    const manifest = await project.getPackageJson();
    const previous = await project.resolveBoardConfigForRuntime();
    const boardPath = window['path'].join(await project.getBoardPackagePath(), 'board.json');
    const boardContent = window['fs'].readFileSync(boardPath, 'utf8');
    const pins = { ...project.currentBoardPinConfig };
    try {
      await project.setPackageJson({ ...manifest, projectConfig: { ...manifest.projectConfig, [option.key!]: option.data } });
      if (option.extra?.syncPinConfig) await project.syncBoardPinConfig(option);
      const next = await project.refreshRuntimeBoardConfig();
      const edits = planBoardSourceEdits(path, manifest, option.key!, previous, next);
      if (edits.length && !await this.persistence.hasSavedProject(path)) {
        throw new Error('编辑器中有新的未保存修改，请保存后重新选择配置。');
      }
      writeBoardSourceEdits(edits);
    } catch (error) {
      window['fs'].writeFileSync(boardPath, boardContent);
      project.currentBoardPinConfig = pins;
      await project.setPackageJson(manifest);
      await project.syncCurrentBoardConfig();
      throw error;
    }
    return true;
  }
}
