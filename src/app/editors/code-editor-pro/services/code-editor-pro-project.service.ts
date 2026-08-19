import { Injectable } from '@angular/core';
import { ActionService } from '../../../services/action.service';
import { ProjectService } from '../../../services/project.service';

export interface CodeEditorProPersistenceBridge {
  saveAll(): Promise<{ ok: boolean; message?: string }>;
  hasUnsavedChanges(): Promise<boolean>;
}

@Injectable({
  providedIn: 'root',
})
export class CodeEditorProProjectService {
  private initialized = false;
  private persistenceBridge: CodeEditorProPersistenceBridge | null = null;

  constructor(
    private actionService: ActionService,
    private projectService: ProjectService,
  ) {}

  init() {
    if (this.initialized) {
      console.warn('CodeEditorProProjectService 已经初始化，跳过重复初始化');
      return;
    }
    this.initialized = true;
    this.actionService.listen(
      'saveProject',
      () => this.saveAll(),
      'code-editor-pro-save-project',
    );
    this.actionService.listen(
      'project-check-unsaved',
      async () => ({ hasUnsavedChanges: await this.hasUnsavedChanges() }),
      'code-editor-pro-check-unsaved',
    );
    this.actionService.listen(
      'project-save',
      async (action) => {
        const path = action.payload?.path || this.projectService.currentProjectPath;
        await this.saveAll();
        if (path) {
          await this.projectService.copyPackageJsonToTemp(path);
        }
        return { success: true, path };
      },
      'code-editor-pro-project-save',
    );
  }

  registerPersistenceBridge(bridge: CodeEditorProPersistenceBridge): void {
    this.persistenceBridge = bridge;
  }

  unregisterPersistenceBridge(bridge: CodeEditorProPersistenceBridge): void {
    if (this.persistenceBridge === bridge) {
      this.persistenceBridge = null;
    }
  }

  private async saveAll(): Promise<{ ok: true }> {
    if (!this.persistenceBridge) {
      throw new Error('Aily Coder 保存通道尚未就绪');
    }
    const result = await this.persistenceBridge.saveAll();
    if (!result.ok) {
      throw new Error(result.message || 'Aily Coder 未能保存全部代码文件');
    }
    return { ok: true };
  }

  private async hasUnsavedChanges(): Promise<boolean> {
    if (!this.persistenceBridge) {
      return true;
    }
    return this.persistenceBridge.hasUnsavedChanges();
  }

  destroy() {
    this.actionService.unlisten('code-editor-pro-save-project');
    this.actionService.unlisten('code-editor-pro-check-unsaved');
    this.actionService.unlisten('code-editor-pro-project-save');
    this.persistenceBridge = null;
    this.initialized = false;
  }
}
