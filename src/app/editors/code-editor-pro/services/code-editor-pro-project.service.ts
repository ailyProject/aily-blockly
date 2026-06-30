import { Injectable } from '@angular/core';
import { ActionService } from '../../../services/action.service';
import { ProjectService } from '../../../services/project.service';

/**
 * iframe 内嵌 Coder 时，由子页面自行处理保存；主应用侧不跟踪未保存状态。
 */
@Injectable({
  providedIn: 'root',
})
export class CodeEditorProProjectService {
  private initialized = false;

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
      () => {
        /* iframe 内编辑器自行保存 */
      },
      'code-editor-pro-save-project',
    );
    this.actionService.listen(
      'project-check-unsaved',
      () => ({ hasUnsavedChanges: false }),
      'code-editor-pro-check-unsaved',
    );
    // 避免 save() 无监听导致 5s 超时（切换开发板等仍会 dispatch project-save）
    this.actionService.listen(
      'project-save',
      async (action) => {
        const path = action.payload?.path || this.projectService.currentProjectPath;
        if (path) {
          await this.projectService.copyPackageJsonToTemp(path);
        }
        return { success: true, path };
      },
      'code-editor-pro-project-save',
    );
  }

  destroy() {
    this.actionService.unlisten('code-editor-pro-save-project');
    this.actionService.unlisten('code-editor-pro-check-unsaved');
    this.actionService.unlisten('code-editor-pro-project-save');
    this.initialized = false;
  }
}
