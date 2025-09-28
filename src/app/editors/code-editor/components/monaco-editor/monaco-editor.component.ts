import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, SimpleChanges, ViewChild, ElementRef, OnInit, AfterViewInit, OnDestroy, OnChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzMessageService } from 'ng-zorro-antd/message';
import { VsixService } from '../../services/vsix.service';
import { MonacoVSCodeCSSLoader } from '../../../../utils/monaco-vscode-css-loader';

import * as monaco from 'monaco-editor';
import * as vscode from 'vscode'
import { Uri } from 'vscode'
import 'vscode/localExtensionHost'
import { initialize } from '@codingame/monaco-vscode-api'
import getConfigurationServiceOverride, {
  updateUserConfiguration
} from '@codingame/monaco-vscode-configuration-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getExtensionsServiceOverride from '@codingame/monaco-vscode-extensions-service-override'
import getFilesServiceOverride, { FileSystemProviderCapabilities, FileSystemProviderError, IFileSystemProviderWithFileReadWriteCapability, IStat, RegisteredFileSystemProvider, RegisteredMemoryFile, registerFileSystemOverlay, DelegateFileSystemProvider, registerCustomProvider } from '@codingame/monaco-vscode-files-service-override'
// 导入主题默认扩展
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri';
import '@codingame/monaco-vscode-theme-defaults-default-extension'

(self as any).MonacoEnvironment = {
  getWorker: (workerId: string, label: string) => {
    return new Worker(new URL('../../../../../../node_modules/monaco-editor/esm/vs/editor/editor.worker', import.meta.url));
  }
};

interface MonacoEditorOptions {
  language?: string;
  theme?: string;
  lineNumbers?: 'on' | 'off' | 'relative' | 'interval';
  automaticLayout?: boolean;
  readOnly?: boolean;
  fontSize?: number;
  wordWrap?: 'on' | 'off' | 'wordWrapColumn' | 'bounded';
  [key: string]: any;
}

// 使用Monaco的原生接口类型
type ViewState = monaco.editor.ICodeEditorViewState;

// 全局初始化状态管理
declare global {
  interface Window {
    __MONACO_VSCODE_API_INITIALIZED__?: boolean;
    __MONACO_VSCODE_API_INITIALIZING__?: Promise<void>;
  }
}

@Component({
  selector: 'app-monaco-editor',
  imports: [
    CommonModule,
    FormsModule
  ],
  templateUrl: './monaco-editor.component.html',
  styleUrl: './monaco-editor.component.scss'
})
export class MonacoEditorComponent implements OnInit, AfterViewInit, OnDestroy, OnChanges {

  private static isMonacoInitialized = false;

  /** Monaco编辑器容器DOM引用 */
  @ViewChild('monacoEditorContainer', { static: true }) monacoContainer!: ElementRef<HTMLDivElement>;

  /** 编辑器配置选项 */
  @Input() options: MonacoEditorOptions = {
    language: 'cpp',
    theme: 'vs-dark',
    lineNumbers: 'on',
    automaticLayout: true
  }

  /** 编辑器内容 */
  @Input() code = '';

  /** 当前文件路径 */
  @Input() filePath = '';

  /** 代码变化事件 */
  @Output() codeChange = new EventEmitter<string>();

  /** 打开文件请求事件 */
  @Output() openFileRequest = new EventEmitter<{ filePath: string, position: any }>();

  /** SDK路径 */
  @Input() sdkPath: string;

  /** 库路径 */
  @Input() librariesPath: string;

  /** Monaco Editor实例引用 */
  public monacoInstance: typeof monaco = monaco;

  /** 当前编辑器实例 */
  public editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;

  /**
   * 组件构造函数
   * @param message 消息服务
   * @param vsixService VSIX扩展服务
   */
  constructor(
    private message: NzMessageService,
    private vsixService: VsixService
  ) { }

  async ngOnInit(): Promise<void> {

  }

  async ngAfterViewInit(): Promise<void> {
    this.init();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['code'] && this.editorInstance && !changes['code'].firstChange) {
      const currentValue = this.editorInstance.getValue();
      if (currentValue !== this.code) {
        this.editorInstance.setValue(this.code);
      }
    }

    if (changes['options'] && this.editorInstance && !changes['options'].firstChange) {
      this.editorInstance.updateOptions(this.options);
    }
  }

  ngOnDestroy() {
    // 清理编辑器实例
    if (this.editorInstance) {
      this.editorInstance.dispose();
      this.editorInstance = null;
    }
  }

  onCodeChange(newCode: string): void {
    this.codeChange.emit(newCode);
  }


  async init() {
    try {
      console.log('Initializing Monaco VSCode API...');

      // 检查是否需要加载CSS文件（非开发模式）
      const isDevMode = window.location.port === '4200' || 
                       window.location.hostname === 'localhost' || 
                       window.location.hostname === '127.0.0.1';
      
      if (!isDevMode) {
        console.log('Production mode detected, loading Monaco VSCode CSS files...');
        await MonacoVSCodeCSSLoader.loadAllMonacoCSS();
      } else {
        console.log('Development mode detected, skipping manual CSS loading...');
      }

      // 重定向主题资源路径
      this.setupThemeResourcesRedirect();

      await initialize({
        ...getConfigurationServiceOverride(),
        ...getThemeServiceOverride(),
        ...getExtensionsServiceOverride(),
        ...getFilesServiceOverride(),
      });

      // 手动设置默认主题配置
      await this.configureDefaultTheme();

      console.log('Monaco VSCode API initialized successfully');

      // 创建编辑器实例
      this.editorInstance = monaco.editor.create(this.monacoContainer.nativeElement, {
        value: this.code,
        language: 'cpp',
        theme: 'vs-dark', // 使用VSCode主题
        lineNumbers: 'on',
        automaticLayout: true,
        minimap: {
          enabled: false
        },
        fontSize: 14,
        fontFamily: 'Consolas, "Courier New", monospace',
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        tabSize: 2,
        insertSpaces: true
      });

      // 添加内容变化监听
      if (this.editorInstance) {
        this.editorInstance.onDidChangeModelContent(() => {
          const value = this.editorInstance?.getValue() || '';
          this.onCodeChange(value);
        });
      }

      console.log('Monaco Editor created successfully');

    } catch (error) {
      console.error('Monaco Editor initialization failed:', error);
    }
  }

  /**
   * 手动配置默认主题，避免有问题的主题文件
   */
  private async configureDefaultTheme(): Promise<void> {
    try {
      // 设置用户配置，强制使用暗色主题
      updateUserConfiguration(`{
        "workbench.colorTheme": "Default Dark Modern",
        "editor.theme": "vs-dark",
        "workbench.preferredDarkColorTheme": "Default Dark Modern",
        "workbench.preferredLightColorTheme": "Default Light Modern"
      }`);

      console.log('Default theme configuration applied');
    } catch (error) {
      console.warn('Failed to configure default theme:', error);
    }
  }

  /**
   * 设置主题资源路径重定向
   */
  private setupThemeResourcesRedirect(): void {
    try {
      // 创建专门处理 extension-file://vscode.theme-defaults 的文件系统提供者
      const extensionFileProvider = new DelegateFileSystemProvider({
        delegate: new (class implements IFileSystemProviderWithFileReadWriteCapability {
          capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
          onDidChangeCapabilities = new (vscode as any).EventEmitter().event;
          onDidChangeFile = new (vscode as any).EventEmitter().event;
          
          watch() { return { dispose: () => {} }; }
          
          async stat(resource: Uri): Promise<IStat> {
            return {
              type: 1, // FileType.File
              ctime: Date.now(),
              mtime: Date.now(),
              size: 1024 // 预估大小
            };
          }
          
          async readFile(resource: Uri): Promise<Uint8Array> {
            console.log('Reading extension file:', resource.toString());
            
            // 处理 extension-file://vscode.theme-defaults 路径
            if (resource.scheme === 'extension-file' && resource.authority === 'vscode.theme-defaults') {
              // 处理形如 /extension/themes/dark_vs.json 的路径
              let fileName: string | undefined;
              
              if (resource.path.includes('/themes/')) {
                // 提取主题文件名：/extension/themes/dark_vs.json -> dark_vs.json
                fileName = resource.path.split('/themes/').pop();
              } else {
                // 如果没有 themes 路径，直接取文件名
                fileName = resource.path.split('/').pop();
              }
              
              if (fileName) {
                const redirectedPath = `/vscode/theme-resources/${fileName}`;
                
                try {
                  console.log(`Redirecting ${resource.toString()} to: ${redirectedPath}`);
                  const response = await fetch(redirectedPath);
                  if (response.ok) {
                    const arrayBuffer = await response.arrayBuffer();
                    console.log('Successfully loaded theme file:', fileName);
                    return new Uint8Array(arrayBuffer);
                  } else {
                    console.warn('Failed to fetch theme file:', redirectedPath, response.status);
                  }
                } catch (error) {
                  console.warn('Error fetching theme file:', error);
                }
              }
            }
            
            // 如果重定向失败，返回空的JSON主题内容作为回退
            const fallbackTheme = {
              "type": "dark",
              "colors": {},
              "tokenColors": []
            };
            return new TextEncoder().encode(JSON.stringify(fallbackTheme));
          }
          
          async writeFile() { throw new Error('Write not supported'); }
          async mkdir() { throw new Error('Mkdir not supported'); }
          async readdir() { return []; }
          async delete() { throw new Error('Delete not supported'); }
          async rename() { throw new Error('Rename not supported'); }
        })(),
        toDelegate: (uri: Uri) => {
          // 对于 extension-file://vscode.theme-defaults 路径，保持原样传递给委托处理器
          return uri;
        },
        fromDeletate: (uri: Uri) => uri
      });

      // 注册 extension-file 文件系统提供者，优先级高于默认提供者
      registerCustomProvider('extension-file', extensionFileProvider);
      
      console.log('Extension file system provider registered for theme resources');
    } catch (error) {
      console.warn('Failed to setup theme resources redirect:', error);
    }
  }

  /**
   * 设置自定义右键菜单
   */
  private setupContextMenu(editor: monaco.editor.IStandaloneCodeEditor): void {
    if (!this.monacoInstance) return;

    // 添加自定义右键菜单项（可选）
    // 这里可以根据需要添加自定义的上下文菜单项
    console.log('Context menu setup completed');
  }

  /**
   * 获取编辑器的视图状态（包含滚动位置、光标位置等）
   */
  public getViewState(): ViewState | null {
    if (!this.editorInstance?.getModel()) {
      console.warn('编辑器实例或模型未准备好，无法获取视图状态');
      return null;
    }

    try {
      const viewState = this.editorInstance.saveViewState();
      // console.log('获取视图状态成功:', viewState);
      return viewState;
    } catch (error) {
      console.warn('获取视图状态失败:', error);
      return null;
    }
  }

  /**
   * 恢复编辑器的视图状态
   */
  public restoreViewState(viewState: ViewState | null): void {
    if (!viewState) {
      console.debug('没有视图状态需要恢复');
      return;
    }

    if (!this.editorInstance?.getModel()) {
      console.warn('编辑器实例或模型未准备好，无法恢复视图状态');
      return;
    }

    try {
      this.editorInstance.restoreViewState(viewState);
      // console.log('恢复视图状态成功');
    } catch (error) {
      console.warn('恢复视图状态失败:', error);
    }
  }

  /**
   * 安全地恢复编辑器状态，会等待编辑器准备就绪
   */
  public async restoreViewStateSafely(viewState: ViewState | null): Promise<boolean> {
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
