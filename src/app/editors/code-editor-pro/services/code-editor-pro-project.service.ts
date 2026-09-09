import { Injectable } from '@angular/core';
import { ActionService } from '@core/app-shell/public-api';
import { ProjectService } from '@domain/project/public-api';
import { CoderBuildInfoService } from '@domain/build/public-api';

export interface CodeEditorProPersistenceBridge {
  saveAll(): Promise<{ ok: boolean; message?: string }>;
  hasUnsavedChanges(): Promise<boolean>;
}

@Injectable({
  providedIn: 'root',
})
export class CodeEditorProProjectService {
  private initialized = false;
  private readonly persistenceBridges = new Map<string, CodeEditorProPersistenceBridge>();
  private key(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  constructor(
    private actionService: ActionService,
    private projectService: ProjectService,
    private coderBuildInfo: CoderBuildInfoService,
  ) {}

  init() {
    if (this.initialized) {
      console.warn('CodeEditorProProjectService 已经初始化，跳过重复初始化');
      return;
    }
    this.initialized = true;
    this.actionService.listen(
      'saveProject',
      () => this.saveAllOpenProjects(),
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
        await this.saveAll(path);
        if (path) {
          await this.projectService.copyPackageJsonToTemp(path);
        }
        return { success: true, path };
      },
      'code-editor-pro-project-save',
    );
  }

  registerPersistenceBridge(path: string, bridge: CodeEditorProPersistenceBridge): void {
    this.persistenceBridges.set(this.key(path), bridge);
  }

  unregisterPersistenceBridge(path: string, bridge: CodeEditorProPersistenceBridge): void {
    if (this.persistenceBridges.get(this.key(path)) === bridge) this.persistenceBridges.delete(this.key(path));
  }

  async saveAll(path = this.projectService.currentProjectPath): Promise<{ ok: true }> {
    const bridge = this.persistenceBridges.get(this.key(path));
    if (!bridge) throw new Error(`Aily Coder 保存通道尚未就绪: ${path}`);
    const result = await bridge.saveAll();
    if (!result.ok) throw new Error(result.message || 'Aily Coder 未能保存全部代码文件');
    if (path && this.projectService.isAilyCodeProject(path)) {
      await this.coderBuildInfo.updateCodeHash(path);
    }
    return { ok: true };
  }

  async saveAllOpenProjects(): Promise<{ ok: true }> {
    await Promise.all([...this.persistenceBridges.keys()].map(path => this.saveAll(path)));
    return { ok: true };
  }

  private async hasUnsavedChanges(): Promise<boolean> {
    const states = await Promise.all([...this.persistenceBridges.values()].map(bridge => bridge.hasUnsavedChanges()));
    return states.some(Boolean);
  }

  destroy() {
    this.actionService.unlisten('code-editor-pro-save-project');
    this.actionService.unlisten('code-editor-pro-check-unsaved');
    this.actionService.unlisten('code-editor-pro-project-save');
    this.persistenceBridges.clear();
    this.initialized = false;
  }
}
