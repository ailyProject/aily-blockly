import { Injectable } from '@angular/core';
import { ActionService } from '@core/app-shell/public-api';
import { ProjectService, type ProjectCopySnapshot } from '@domain/project/public-api';
import { CoderBuildInfoService } from '@domain/build/public-api';

export interface CodeEditorProPersistenceBridge {
  saveAll(): Promise<{ ok: boolean; message?: string }>;
  hasUnsavedChanges(): Promise<boolean>;
  captureCopy?(): Promise<{ token: string; files: Array<{ path: string; bytes: Uint8Array }> }>;
  checkCopy?(token: string): Promise<void>;
  completeCopy?(token: string): Promise<void>;
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
    await this.projectService.saveLibraryChanges(path);
    if (path && this.projectService.isAilyCodeProject(path)) {
      await this.coderBuildInfo.updateCodeHash(path);
    }
    return { ok: true };
  }

  async saveAllOpenProjects(): Promise<{ ok: true }> {
    await Promise.all([...this.persistenceBridges.keys()].map(path => this.saveAll(path)));
    return { ok: true };
  }

  async prepareCopy(path: string): Promise<ProjectCopySnapshot> {
    const bridge = this.persistenceBridges.get(this.key(path));
    if (!bridge?.captureCopy || !bridge.checkCopy) throw new Error('另存为需要更新后的 Coder 编辑器，请更新编辑器后重试。');
    const captured = await bridge.captureCopy();
    const assertCurrent = async () => {
      if (this.persistenceBridges.get(this.key(path)) !== bridge) throw new Error('Coder 编辑器已切换，请重新执行另存为。');
      await bridge.checkCopy!(captured.token);
    };
    await assertCurrent();
    return {
      assertCurrent, release: () => undefined,
      complete: async () => { await bridge.completeCopy?.(captured.token); },
      write: async target => {
        const paths = window['path'], fs = window['fs'];
        const root = await fs.realpathAsync(target);
        for (const file of captured.files) {
          const relative = paths.relative(path, file.path);
          const inside = (value: string) => !!value && !paths.isAbsolute(value) && value !== '..' && !/^\.\.[/\\]/.test(value);
          if (!inside(relative)) throw new Error(`未保存文件不在当前项目内，请先处理该文件：${file.path}`);
          const destination = paths.join(target, relative);
          // cp preserves symlinks. Never follow one back into A while applying dirty buffers.
          const physical = fs.existsSync(destination) ? await fs.realpathAsync(destination)
            : paths.join(await fs.realpathAsync(paths.dirname(destination)), paths.basename(destination));
          if (!inside(paths.relative(root, physical))) throw new Error(`另存为文件指向项目外部：${relative}`);
          await assertCurrent();
          fs.writeFileSync(destination, file.bytes);
        }
        await assertCurrent();
      },
    };
  }

  /** Missing/unmounted editors are unknown, never implicitly clean. No save. */
  async hasSavedProject(path: string, cachedLibraries = false): Promise<boolean> {
    const key = this.key(path), bridge = this.persistenceBridges.get(key);
    if (!bridge) return false;
    const dirty = (cachedLibraries ? this.projectService.hasCachedLibraryChanges(path)
      : await this.projectService.hasUnsavedLibraryChanges(path)) || await bridge.hasUnsavedChanges();
    return this.persistenceBridges.get(key) === bridge && dirty === false;
  }

  private async hasUnsavedChanges(): Promise<boolean> {
    const states = await Promise.all([...this.persistenceBridges.entries()].map(async ([path, bridge]) =>
      await this.projectService.hasUnsavedLibraryChanges(path) || await bridge.hasUnsavedChanges()));
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
