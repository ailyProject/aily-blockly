import { Injectable } from '@angular/core';
import { ActionService } from '../../../services/action.service';
import { OpenedFile } from '../code-editor.component';

interface CodeEditorComponent {
  openedFiles: OpenedFile[];
  saveFile(index: number): Promise<void>;
}

@Injectable({
  providedIn: 'root'
})
export class _ProjectService {

  private codeEditorComponent: CodeEditorComponent | null = null;
  private initialized = false; // 防止重复初始化

  constructor(
    private actionService: ActionService
  ) { }

  init() {
    if (this.initialized) {
      console.warn('Code Editor _ProjectService 已经初始化过了，跳过重复初始化');
      return;
    }
    
    this.initialized = true;
    this.actionService.listen('saveProject', data => {
      this.save(data.payload.path);
    }, 'code-editor-save-project');
    this.actionService.listen('project-check-unsaved', (action) => {
      let result = this.hasUnsavedChanges();
      return { hasUnsavedChanges: result };
    }, 'code-editor-check-unsaved');
  }

  destroy() {
    this.actionService.unlisten('code-editor-save-project');
    this.actionService.unlisten('code-editor-check-unsaved');
    this.initialized = false; // 重置初始化状态
  }

  // 注册 CodeEditorComponent 实例
  registerCodeEditor(codeEditor: CodeEditorComponent) {
    this.codeEditorComponent = codeEditor;
  }

  // 注销 CodeEditorComponent 实例
  unregisterCodeEditor() {
    this.codeEditorComponent = null;
  }

  save(path: string) {
    // 保存所有打开的文件
    if (this.codeEditorComponent && this.codeEditorComponent.openedFiles) {
      this.codeEditorComponent.openedFiles.forEach((file: OpenedFile, index: number) => {
        if (file.isDirty) {
          this.codeEditorComponent!.saveFile(index);
        }
      });
    }
  }

  hasUnsavedChanges(): boolean {
    // 检查 CodeEditorComponent 是否有未保存的文件
    if (this.codeEditorComponent && this.codeEditorComponent.openedFiles) {
      return this.codeEditorComponent.openedFiles.some((file: OpenedFile) => file.isDirty);
    }
    return false;
  }
}
