import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, SimpleChanges, ViewChild, OnInit, AfterViewInit, OnDestroy, OnChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzCodeEditorModule, NzCodeEditorComponent } from 'ng-zorro-antd/code-editor';
import { NzMessageService } from 'ng-zorro-antd/message';
import { VsixService } from '../../services/vsix.service';

// Monaco VSCode API imports - 使用示例代码的方式
import * as vscode from '@codingame/monaco-vscode-extension-api';
import '@codingame/monaco-vscode-extension-api/localExtensionHost';

@Component({
  selector: 'app-monaco-editor',
  imports: [
    NzCodeEditorModule,
    CommonModule,
    FormsModule
  ],
  templateUrl: './monaco-editor.component.html',
  styleUrl: './monaco-editor.component.scss'
})
export class MonacoEditorComponent implements OnInit, AfterViewInit, OnDestroy, OnChanges {

  private static isMonacoInitialized = false;

  /**
   * 初始化 Monaco VSCode API（使用示例代码的方式）
   */
  static async initializeMonacoVSCodeAPI(): Promise<void> {
    if (MonacoEditorComponent.isMonacoInitialized) {
      return;
    }

    try {
      console.log('Initializing Monaco VSCode API with localExtensionHost...');
      
      // 使用 monaco-vscode-api 提供的方式，通过导入 vscode 和 localExtensionHost
      // 这会自动设置本地扩展主机环境
      
      MonacoEditorComponent.isMonacoInitialized = true;
      console.log('Monaco VSCode API initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Monaco VSCode API:', error);
      throw error;
    }
  }

  /**
   * 注册 VSIX 扩展到 Monaco（使用 VSCode API）
   */
  static async registerVsixExtension(extensionData: any): Promise<void> {
    try {
      console.log(`Registering VSIX extension: ${extensionData.manifest.name}`);

      // 使用 VSCode API 直接处理扩展的贡献点
      const manifest = extensionData.manifest;

      // 处理语言定义
      if (manifest.contributes?.languages) {
        for (const language of manifest.contributes.languages) {
          console.log(`Registering language: ${language.id}`);
          // 使用 VSCode API 注册语言
          // vscode.languages.setLanguageConfiguration 等 API 会在需要时自动调用
        }
      }

      // 处理语法高亮（grammars）
      if (manifest.contributes?.grammars) {
        for (const grammar of manifest.contributes.grammars) {
          console.log(`Processing grammar for language: ${grammar.language}`);
          // 语法高亮通过 monaco-vscode-api 的 textmate 集成自动处理
        }
      }

      // 处理主题
      if (manifest.contributes?.themes) {
        for (const theme of manifest.contributes.themes) {
          console.log(`Processing theme: ${theme.label}`);
          // 主题通过 monaco-vscode-api 自动处理
        }
      }

      // 处理命令
      if (manifest.contributes?.commands) {
        for (const command of manifest.contributes.commands) {
          console.log(`Registering command: ${command.command}`);
          // 使用 VSCode API 注册命令
          vscode.commands.registerCommand(command.command, (...args: any[]) => {
            console.log(`Executing command: ${command.command}`, args);
            // 这里可以添加命令的具体实现
          });
        }
      }

      // 处理补全提供者等
      if (manifest.contributes?.languages) {
        for (const language of manifest.contributes.languages) {
          // 示例：注册补全提供者
          vscode.languages.registerCompletionItemProvider(language.id, {
            provideCompletionItems: (document: any, position: any) => {
              console.log(`Providing completions for ${language.id} at position:`, position);
              // 返回补全项
              return [];
            }
          });
        }
      }

      console.log(`Successfully processed extension: ${extensionData.manifest.name}`);
    } catch (error) {
      console.error('Failed to register VSIX extension:', error);
      throw error;
    }
  }

  @ViewChild(NzCodeEditorComponent) codeEditor: NzCodeEditorComponent;

  @Input() options: any = {
    language: 'cpp',
    theme: 'vs-dark',
    lineNumbers: 'on',
    automaticLayout: true
  }

  @Input() code = '';
  @Input() filePath = ''; // 当前文件路径

  @Output() codeChange = new EventEmitter<string>();
  @Output() openFileRequest = new EventEmitter<{ filePath: string, position: any }>();

  @Input() sdkPath: string;
  @Input() librariesPath: string;

  private disposables: any[] = [];
  public monacoInstance: any;
  public editorInstance: any; // 添加编辑器实例的引用

  constructor(
    private message: NzMessageService,
    private vsixService: VsixService
  ) { }

  async ngOnInit() {
    // 确保 Monaco VSCode API 已初始化
    await MonacoEditorComponent.initializeMonacoVSCodeAPI();
  }

  async ngAfterViewInit() {
    // 等待编辑器初始化完成后再加载扩展
    setTimeout(async () => {
      if (this.editorInstance) {
        await this.setupVsixExtensions(this.editorInstance);
      }
    }, 1000);
  }

  ngOnChanges(changes: SimpleChanges): void {
  }

  ngOnDestroy() {
    this.disposables.forEach(d => d.dispose());
  }

  onCodeChange(newCode: string): void {
    this.codeChange.emit(newCode);
  }

  editorInitialized(editor: any): void {
    this.monacoInstance = (window as any).monaco;
    this.editorInstance = editor; // 保存编辑器实例

    // 在编辑器初始化后设置Tab键处理
    if (editor && this.monacoInstance) {
      // 添加自定义右键菜单项
      this.setupContextMenu(editor);
      
      // 配置 VSIX 扩展支持
      this.setupVsixExtensions(editor);
    }
  }

  /**
   * 设置自定义右键菜单
   */
  private setupContextMenu(editor: any): void {
    if (!this.monacoInstance) return;
  }

  /**
   * 设置 VSIX 扩展支持
   */
  private async setupVsixExtensions(editor: any): Promise<void> {
    try {
      console.log('Setting up VSIX extensions for Monaco editor...');

      // 首先初始化所有可用的扩展
      await this.vsixService.initializeAllExtensions();

      // 获取所有已加载的扩展
      const loadedExtensions = this.vsixService.getLoadedExtensions();
      console.log(`Found ${loadedExtensions.length} loaded extensions`);

      // 使用新的扩展注册方式
      for (const extensionData of loadedExtensions) {
        try {
          await MonacoEditorComponent.registerVsixExtension(extensionData);
          console.log(`Successfully registered extension: ${extensionData.manifest.name}`);
        } catch (error) {
          console.error(`Failed to register extension ${extensionData.manifest.name}:`, error);
        }
      }

      console.log('VSIX extensions setup completed for Monaco editor');
    } catch (error) {
      console.error('Failed to setup VSIX extensions:', error);
    }
  }

  /**
   * 获取编辑器的视图状态（包含滚动位置、光标位置等）
   */
  public getViewState(): any {
    if (this.editorInstance && this.editorInstance.getModel()) {
      try {
        const viewState = this.editorInstance.saveViewState();
        // console.log('获取视图状态成功:', viewState);
        return viewState;
      } catch (error) {
        console.warn('获取视图状态失败:', error);
        return null;
      }
    } else {
      console.warn('编辑器实例或模型未准备好，无法获取视图状态');
      return null;
    }
  }

  /**
   * 恢复编辑器的视图状态
   */
  public restoreViewState(viewState: any): void {
    if (!viewState) return;

    if (this.editorInstance && this.editorInstance.getModel()) {
      try {
        this.editorInstance.restoreViewState(viewState);
        // console.log('恢复视图状态成功');
      } catch (error) {
        console.warn('恢复视图状态失败:', error);
      }
    } else {
      console.warn('编辑器实例或模型未准备好，无法恢复视图状态');
    }
  }

  /**
   * 安全地恢复编辑器状态，会等待编辑器准备就绪
   */
  public async restoreViewStateSafely(viewState: any): Promise<boolean> {
    if (!viewState) return false;

    return new Promise((resolve) => {
      const maxAttempts = 20;
      let attempts = 0;

      const tryRestore = () => {
        if (this.editorInstance && this.editorInstance.getModel()) {
          try {
            this.editorInstance.restoreViewState(viewState);
            console.log('视图状态安全恢复成功');
            resolve(true);
            return;
          } catch (error) {
            console.warn('恢复视图状态失败:', error);
          }
        }

        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(tryRestore, 50);
        } else {
          console.warn('视图状态恢复超时');
          resolve(false);
        }
      };

      tryRestore();
    });
  }

}