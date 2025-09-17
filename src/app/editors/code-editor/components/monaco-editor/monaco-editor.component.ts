import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, SimpleChanges, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzCodeEditorModule, NzCodeEditorComponent } from 'ng-zorro-antd/code-editor';
import { NzMessageService } from 'ng-zorro-antd/message';
import { VsixService } from '../../services/vsix.service';

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
export class MonacoEditorComponent {

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

  ngOnInit() {
  }

  ngAfterViewInit() {
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
      
      // 获取已加载的扩展
      const loadedExtensions = this.vsixService.getLoadedExtensions();
      console.log(`Found ${loadedExtensions.length} loaded extensions`);

      // 为每个扩展设置 Monaco 集成
      for (const extensionData of loadedExtensions) {
        await this.integrateExtensionWithMonaco(editor, extensionData);
      }

      console.log('VSIX extensions setup completed for Monaco editor');
    } catch (error) {
      console.error('Failed to setup VSIX extensions:', error);
    }
  }

  /**
   * 将扩展集成到 Monaco 编辑器
   */
  private async integrateExtensionWithMonaco(editor: any, extensionData: any): Promise<void> {
    try {
      const manifest = extensionData.manifest;
      console.log(`Integrating extension ${manifest.name} with Monaco editor`);

      // 处理语言支持
      if (manifest.contributes?.languages) {
        for (const language of manifest.contributes.languages) {
          this.registerLanguageWithMonaco(language);
        }
      }

      // 处理语法高亮
      if (manifest.contributes?.grammars) {
        for (const grammar of manifest.contributes.grammars) {
          await this.registerGrammarWithMonaco(extensionData, grammar);
        }
      }

      // 处理主题
      if (manifest.contributes?.themes) {
        for (const theme of manifest.contributes.themes) {
          await this.registerThemeWithMonaco(extensionData, theme);
        }
      }

      // 处理命令
      if (manifest.contributes?.commands) {
        for (const command of manifest.contributes.commands) {
          this.registerCommandWithMonaco(editor, command);
        }
      }

    } catch (error) {
      console.error(`Failed to integrate extension ${extensionData.manifest.name}:`, error);
    }
  }

  /**
   * 注册语言到 Monaco
   */
  private registerLanguageWithMonaco(language: any): void {
    try {
      if (this.monacoInstance?.languages) {
        console.log(`Registering language: ${language.id}`);
        
        // 注册语言
        this.monacoInstance.languages.register({
          id: language.id,
          extensions: language.extensions || [],
          aliases: language.aliases || [],
          mimetypes: language.mimetypes || []
        });
      }
    } catch (error) {
      console.error(`Failed to register language ${language.id}:`, error);
    }
  }

  /**
   * 注册语法高亮到 Monaco
   */
  private async registerGrammarWithMonaco(extensionData: any, grammar: any): Promise<void> {
    try {
      console.log(`Registering grammar for language: ${grammar.language}`);
      
      // 这里可以添加 TextMate 语法支持
      // 由于 Monaco 编辑器对 TextMate 语法的支持有限，
      // 可能需要使用 monaco-textmate 库或其他解决方案
      
    } catch (error) {
      console.error(`Failed to register grammar for ${grammar.language}:`, error);
    }
  }

  /**
   * 注册主题到 Monaco
   */
  private async registerThemeWithMonaco(extensionData: any, theme: any): Promise<void> {
    try {
      console.log(`Registering theme: ${theme.label}`);
      
      // 读取主题文件
      if (theme.path) {
        const themeContent = await this.vsixService.readExtensionFile(extensionData.path, theme.path);
        if (themeContent) {
          const themeData = JSON.parse(themeContent.toString());
          
          // 将 VSCode 主题转换为 Monaco 主题格式
          const monacoTheme = this.convertVSCodeThemeToMonaco(themeData);
          
          // 定义主题
          this.monacoInstance.editor.defineTheme(theme.id || theme.label, monacoTheme);
        }
      }
      
    } catch (error) {
      console.error(`Failed to register theme ${theme.label}:`, error);
    }
  }

  /**
   * 转换 VSCode 主题到 Monaco 主题格式
   */
  private convertVSCodeThemeToMonaco(vscodeTheme: any): any {
    // 简化的转换逻辑
    // 实际实现可能需要更复杂的转换
    return {
      base: vscodeTheme.type === 'dark' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: vscodeTheme.tokenColors?.map((token: any) => ({
        token: token.scope,
        foreground: token.settings?.foreground?.replace('#', ''),
        background: token.settings?.background?.replace('#', ''),
        fontStyle: token.settings?.fontStyle
      })) || [],
      colors: vscodeTheme.colors || {}
    };
  }

  /**
   * 注册命令到 Monaco
   */
  private registerCommandWithMonaco(editor: any, command: any): void {
    try {
      console.log(`Registering command: ${command.command} - ${command.title}`);
      
      // 注册编辑器动作
      editor.addAction({
        id: command.command,
        label: command.title,
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.5,
        run: (editor: any) => {
          console.log(`Executing command: ${command.command}`);
          // 这里可以添加命令执行逻辑
        }
      });
      
    } catch (error) {
      console.error(`Failed to register command ${command.command}:`, error);
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
        console.log('视图状态恢复成功');
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
