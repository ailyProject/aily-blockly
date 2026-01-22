import { Injectable } from '@angular/core';
import { ActionService } from '../../../services/action.service';
import { ProjectService } from '../../../services/project.service';
import { ElectronService } from '../../../services/electron.service';
import { OpenedFile } from '../code-editor.component';

interface CodeEditorComponent {
  openedFiles: OpenedFile[];
  saveFile(index: number): Promise<void>;
  projectPath: string;
}

@Injectable({
  providedIn: 'root'
})
export class _ProjectService {

  private codeEditorComponent: CodeEditorComponent | null = null;
  private initialized = false;
  currentProjectPath: string = '';
  currentPackageData: any = null;

  constructor(
    private actionService: ActionService,
    private projectService: ProjectService,
    private electronService: ElectronService
  ) { }

  init() {
    if (this.initialized) {
      console.warn('Code Editor _ProjectService 已经初始化过了，跳过重复初始化');
      return;
    }
    
    this.initialized = true;
    
    // 监听项目保存事件
    this.actionService.listen('project-save', async (action) => {
      await this.save(action.payload.path);
    }, 'code-editor-project-save');
    
    // 监听检查未保存状态
    this.actionService.listen('project-check-unsaved', (action) => {
      let result = this.hasUnsavedChanges();
      return { hasUnsavedChanges: result };
    }, 'code-editor-check-unsaved');

    // 兼容旧的 saveProject 事件
    this.actionService.listen('saveProject', async (data) => {
      await this.save(data.payload.path);
    }, 'code-editor-save-project');
  }

  destroy() {
    this.actionService.unlisten('code-editor-project-save');
    this.actionService.unlisten('code-editor-check-unsaved');
    this.actionService.unlisten('code-editor-save-project');
    this.initialized = false;
  }

  // 注册 CodeEditorComponent 实例
  registerCodeEditor(codeEditor: CodeEditorComponent) {
    this.codeEditorComponent = codeEditor;
  }

  // 注销 CodeEditorComponent 实例
  unregisterCodeEditor() {
    this.codeEditorComponent = null;
  }

  /**
   * 保存项目
   * @param path 项目路径
   */
  async save(path: string): Promise<void> {
    // 保存所有打开且已修改的文件
    if (this.codeEditorComponent && this.codeEditorComponent.openedFiles) {
      const savePromises = this.codeEditorComponent.openedFiles
        .map((file: OpenedFile, index: number) => {
          if (file.isDirty) {
            return this.codeEditorComponent!.saveFile(index);
          }
          return Promise.resolve();
        });
      
      await Promise.all(savePromises);
      console.log('✅ 所有文件已保存');
    }

    // 更新 package.json 的修改时间
    await this.updateProjectMetadata(path);
  }

  /**
   * 更新项目元数据
   */
  private async updateProjectMetadata(path: string): Promise<void> {
    try {
      const packageJsonPath = `${path}/package.json`;
      if (window['path'].isExists(packageJsonPath)) {
        const packageJson = JSON.parse(window['fs'].readFileSync(packageJsonPath, 'utf8'));
        packageJson.lastModified = new Date().toISOString();
        window['fs'].writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
        console.log('✅ 项目元数据已更新');
      }
    } catch (error) {
      console.error('更新项目元数据失败:', error);
    }
  }

  /**
   * 检查是否有未保存的更改
   */
  hasUnsavedChanges(): boolean {
    if (this.codeEditorComponent && this.codeEditorComponent.openedFiles) {
      return this.codeEditorComponent.openedFiles.some((file: OpenedFile) => file.isDirty);
    }
    return false;
  }

  /**
   * 获取当前打开的所有文件
   */
  getOpenedFiles(): OpenedFile[] {
    if (this.codeEditorComponent) {
      return this.codeEditorComponent.openedFiles || [];
    }
    return [];
  }

  /**
   * 获取当前项目路径
   */
  getCurrentProjectPath(): string {
    return this.currentProjectPath || this.projectService.currentProjectPath;
  }
}
