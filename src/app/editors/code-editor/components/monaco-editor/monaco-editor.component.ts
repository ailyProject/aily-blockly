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
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getExtensionsServiceOverride, { ExtensionHostKind } from '@codingame/monaco-vscode-extensions-service-override'
import { ExtensionLoaderService } from '../../services/extension-loader.service';

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
    private extensionLoader: ExtensionLoaderService
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
      // 加载

      if (!window['vscode_inited']) {
        await MonacoVSCodeCSSLoader.loadAllMonacoCSS();
        // 重定向主题资源路径
        // this.setupThemeResourcesRedirect();

        await initialize({
          ...getConfigurationServiceOverride(),
          ...getThemeServiceOverride(),
          ...getExtensionsServiceOverride(),
          ...getLanguagesServiceOverride(),
          ...getTextmateServiceOverride()
        });
        window['vscode_inited'] = true
        console.log('Monaco VSCode API initialized successfully');
      }

      await this.extensionLoader.loadExtension('vscode/extensions/theme-defaults', {
        hostKind: ExtensionHostKind.LocalWebWorker,
        system: true
      })

      await this.extensionLoader.loadExtension('vscode/extensions/cpp', {
        hostKind: ExtensionHostKind.LocalWebWorker,
        system: true
      })

      await this.extensionLoader.loadExtension('vscode/extensions/json', {
        hostKind: ExtensionHostKind.LocalWebWorker,
        system: true
      })

      // 手动设置默认主题配置
      // await this.configureDefaultTheme();
      updateUserConfiguration(`{
        "workbench.colorTheme": "Default Dark Modern"
      }`);

      // 创建编辑器实例
      this.editorInstance = monaco.editor.create(this.monacoContainer.nativeElement, {
        value: this.code,
        language: 'cpp', 
        minimap: {
          enabled: false
        }
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
            // console.log('视图状态安全恢复成功');
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
