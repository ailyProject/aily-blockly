import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, SimpleChanges, ViewChild, ElementRef, OnInit, AfterViewInit, OnDestroy, OnChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MonacoVSCodeCSSLoader } from '../../../../utils/monaco-vscode-css-loader';

import * as monaco from 'monaco-editor';
import * as vscode from 'vscode'
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
    if (label === 'TextMateWorker') {
      return new Worker(
        new URL('../../../../../../node_modules/@codingame/monaco-vscode-textmate-service-override/worker', import.meta.url));
    }
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
  @Input() options: MonacoEditorOptions = {}

  /** 编辑器内容 */
  @Input() code = '';

  /** 当前文件路径 */
  @Input() filePath: string = '';

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

  /** 已加载的语言扩展集合 */
  private loadedLanguageExtensions = new Set<string>();

  /** 当前正在进行的模型切换操作 */
  private isChangingModel = false;

  constructor(
    private extensionLoader: ExtensionLoaderService
  ) { }

  async ngOnInit(): Promise<void> {

  }

  async ngAfterViewInit(): Promise<void> {
    // 设置全局错误处理
    this.setupGlobalErrorHandling();
    this.init();
  }

  /**
   * 设置全局错误处理，特别是针对 tokenization 错误
   */
  private setupGlobalErrorHandling(): void {
    // 捕获未处理的Promise rejection
    window.addEventListener('unhandledrejection', (event) => {
      if (event.reason && typeof event.reason === 'object') {
        const error = event.reason;
        const errorMessage = error.message || '';

        // 捕获并忽略模型已释放的错误（这是正常的切换过程）
        if (errorMessage.includes('Model is disposed') ||
          errorMessage.includes('_BugIndicatingError') ||
          errorMessage.includes('Illegal value for lineNumber')) {
          console.debug('捕获到预期的模型切换错误，已忽略:', errorMessage);
          event.preventDefault(); // 阻止错误进一步传播
          return;
        }
      }
    });

    // 捕获全局错误
    const originalErrorHandler = window.onerror;
    window.onerror = (message, source, lineno, colno, error) => {
      if (typeof message === 'string') {
        // 捕获并忽略模型已释放相关的错误
        if (message.includes('Model is disposed') ||
          message.includes('Illegal value for lineNumber') ||
          message.includes('_BugIndicatingError')) {
          console.debug('捕获到预期的模型切换错误，已忽略:', message);
          return true; // 阻止默认错误处理
        }
      }

      // 调用原始错误处理器
      if (originalErrorHandler) {
        return originalErrorHandler(message, source, lineno, colno, error);
      }
      return false;
    };
  }

  /**
   * 处理 tokenization 错误
   */
  private async handleTokenizationError(): Promise<void> {
    if (!this.editorInstance) return;

    try {
      console.log('Attempting to recover from tokenization error...');

      // 保存当前内容
      const currentContent = this.editorInstance.getValue();

      // 重新创建模型
      await this.recreateModel();

      // 如果重建后内容不一致，重新设置
      setTimeout(() => {
        if (this.editorInstance && this.editorInstance.getValue() !== currentContent) {
          try {
            this.editorInstance.setValue(currentContent);
          } catch (error) {
            console.warn('Failed to restore content after tokenization error recovery:', error);
          }
        }
      }, 200);

    } catch (error) {
      console.error('Failed to handle tokenization error:', error);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    // 处理选项变化
    if (changes['options'] && this.editorInstance && !changes['options'].firstChange) {
      this.editorInstance.updateOptions(this.options);
    }

    // 处理文件路径和内容变化，确保正确的顺序
    const hasFilePathChange = changes['filePath'] && !changes['filePath'].firstChange && this.filePath && typeof this.filePath === 'string';
    const hasCodeChange = changes['code'] && !changes['code'].firstChange;

    if (hasFilePathChange || hasCodeChange) {
      this.updateEditorContentSafely(hasFilePathChange, hasCodeChange);
    }
  }

  /**
   * 安全地更新编辑器内容，处理语言和内容的同步
   */
  private async updateEditorContentSafely(hasFilePathChange: boolean, hasCodeChange: boolean): Promise<void> {
    if (!this.editorInstance) return;

    try {
      // 如果文件路径改变，先处理语言切换
      if (hasFilePathChange) {
        // 防止并发的模型切换操作
        if (this.isChangingModel) {
          console.warn('模型切换正在进行中，跳过此次请求');
          return;
        }

        this.isChangingModel = true;

        try {
          console.log('filePath changed:', this.filePath);

          // 如果只有 filePath 变化但 code 没变化，可能是因为 code 还没更新
          // 这种情况下，我们等待一小段时间，让 code 也更新
          if (!hasCodeChange) {
            // console.log('只有 filePath 变化，等待 code 更新...');
            await new Promise(resolve => setTimeout(resolve, 50));
          }

          const newLanguage = this.getLanguageFromFilePath(this.filePath);
          const currentLanguage = this.editorInstance.getModel()?.getLanguageId();
          const newContent = this.code || '';
          const validatedContent = this.validateContent(newContent);

          // console.log('准备更新模型，语言:', newLanguage, '内容长度:', newContent.length);

          // 如果语言相同，只需要更新内容，不需要切换语言扩展
          if (currentLanguage === newLanguage) {
            console.log('语言相同，仅更新模型内容');

            // 获取旧模型
            const oldModel = this.editorInstance.getModel();

            // 创建新模型
            const newModel = monaco.editor.createModel(validatedContent, newLanguage);
            this.editorInstance.setModel(newModel);

            // 异步清理旧模型
            if (oldModel) {
              setTimeout(() => {
                try {
                  oldModel.dispose();
                } catch (error) {
                  console.warn('Old model disposal warning:', error);
                }
              }, 0);
            }

            this.editorInstance.setPosition({ lineNumber: 1, column: 1 });
            console.log('模型内容更新完成');
            return;
          }

          // 1. 获取旧模型并断开连接
          const oldModel = this.editorInstance.getModel();
          this.editorInstance.setModel(null);

          // 2. 立即清理旧模型（使用 setTimeout(0) 让出主线程）
          if (oldModel) {
            setTimeout(() => {
              try {
                oldModel.dispose();
              } catch (error) {
                console.warn('Old model disposal warning:', error);
              }
            }, 0);
          }

          // 3. 短暂等待，让 dispose 操作进入事件队列
          await new Promise(resolve => setTimeout(resolve, 20));

          // 4. 加载新语言扩展
          await this.loadLanguageExtension(newLanguage);

          // 5. 创建并设置新模型
          const newModel = monaco.editor.createModel(validatedContent, newLanguage);
          this.editorInstance.setModel(newModel);

          // 6. 设置光标到文件开头
          this.editorInstance.setPosition({ lineNumber: 1, column: 1 });

          // console.log(`编辑器语言切换完成: ${newLanguage}`);
        } finally {
          // 确保标志被重置
          this.isChangingModel = false;
        }
      }
      // 如果只是内容改变，直接更新内容
      else if (hasCodeChange) {
        const currentValue = this.editorInstance.getValue();
        const newContent = this.code || '';

        if (currentValue !== newContent) {
          // 使用更安全的方式更新内容
          await this.setEditorValueSafely(newContent);
        }
      }
    } catch (error) {
      console.error('Error in updateEditorContentSafely:', error);
      // 如果所有方法都失败，尝试重建整个编辑器状态
      this.recreateModel().catch(err => console.error('Failed to recreate model:', err));
    }
  }

  /**
   * 安全地设置编辑器值
   */
  private async setEditorValueSafely(content: string): Promise<void> {
    if (!this.editorInstance) return;

    try {
      // 先暂停语法高亮
      const model = this.editorInstance.getModel();
      if (model) {
        // 设置内容
        const validatedContent = this.validateContent(content);
        this.editorInstance.setValue(validatedContent);

        // 等待一帧确保内容设置完成
        await new Promise(resolve => requestAnimationFrame(resolve));

        // 验证设置是否成功
        const actualValue = this.editorInstance.getValue();
        if (actualValue !== content) {
          console.warn('Content setting verification failed, retrying...');
          this.editorInstance.setValue(content);
        }

        // 确保光标位置安全
        this.ensureSafeCursorPosition();
      }
    } catch (error) {
      console.error('Error in setEditorValueSafely:', error);
      throw error;
    }
  }

  /**
   * 验证和清理内容，确保没有可能导致tokenization问题的字符
   */
  private validateContent(content: string): string {
    if (!content) return '';

    try {
      // 移除可能导致问题的字符
      let cleanContent = content
        .replace(/\r\n/g, '\n') // 统一换行符
        .replace(/\r/g, '\n')   // 处理单独的\r
        .replace(/\0/g, '');    // 移除null字符

      // 确保内容以换行符结束（如果非空）
      if (cleanContent && !cleanContent.endsWith('\n')) {
        cleanContent += '\n';
      }

      // 验证内容不会导致极大的行数（可能导致性能问题）
      const lines = cleanContent.split('\n');
      if (lines.length > 10000) {
        console.warn('Content has too many lines, truncating...');
        cleanContent = lines.slice(0, 10000).join('\n');
      }

      return cleanContent;
    } catch (error) {
      console.warn('Content validation failed, using empty content:', error);
      return '';
    }
  }

  /**
   * 验证模型状态，确保没有无效的行号引用
   */
  private validateModelState(): void {
    if (!this.editorInstance) return;

    try {
      const model = this.editorInstance.getModel();
      if (!model) return;

      const lineCount = model.getLineCount();

      // 检查模型的基本完整性
      if (lineCount <= 0) {
        console.warn('Model has invalid line count:', lineCount);
        this.recreateModel().catch(err => console.error('Failed to recreate model:', err));
        return;
      }

      // 验证每一行是否可以正常访问
      for (let i = 1; i <= Math.min(lineCount, 10); i++) {
        try {
          model.getLineContent(i);
          model.getLineLength(i);
        } catch (error) {
          console.error(`Error accessing line ${i}:`, error);
          this.recreateModel().catch(err => console.error('Failed to recreate model:', err));
          return;
        }
      }

      // 验证光标位置
      this.ensureSafeCursorPosition();

    } catch (error) {
      console.warn('Model validation failed:', error);
      this.recreateModel().catch(err => console.error('Failed to recreate model:', err));
    }
  }

  /**
   * 确保光标位置在安全范围内
   */
  private ensureSafeCursorPosition(): void {
    if (!this.editorInstance) return;

    try {
      const model = this.editorInstance.getModel();
      if (model && model.getLineCount() > 0) {
        const position = this.editorInstance.getPosition();
        if (position) {
          const lineCount = model.getLineCount();
          if (position.lineNumber > lineCount || position.lineNumber < 1) {
            this.editorInstance.setPosition({ lineNumber: 1, column: 1 });
          } else {
            // 检查列位置
            const maxColumn = model.getLineMaxColumn(position.lineNumber);
            if (position.column > maxColumn || position.column < 1) {
              this.editorInstance.setPosition({
                lineNumber: position.lineNumber,
                column: Math.max(1, Math.min(position.column, maxColumn))
              });
            }
          }
        }
      }
    } catch (error) {
      console.warn('Error ensuring safe cursor position:', error);
      // 回退到安全位置
      try {
        this.editorInstance?.setPosition({ lineNumber: 1, column: 1 });
      } catch (fallbackError) {
        console.error('Even fallback cursor positioning failed:', fallbackError);
      }
    }
  }

  async ngOnDestroy() {
    // 清理编辑器实例
    if (this.editorInstance) {
      try {
        // 先将模型设置为null，断开连接
        const model = this.editorInstance.getModel();
        this.editorInstance.setModel(null);

        // 等待一帧，确保所有异步操作完成
        await new Promise(resolve => requestAnimationFrame(resolve));

        // 清理模型
        if (model) {
          try {
            model.dispose();
          } catch (error) {
            console.warn('Model disposal warning:', error);
          }
        }

        // 清理编辑器
        this.editorInstance.dispose();
        this.editorInstance = null;
      } catch (error) {
        console.error('Error during editor cleanup:', error);
      }
    }
  }

  onCodeChange(newCode: string): void {
    this.codeChange.emit(newCode);
  }

  /**
   * 重新创建编辑器模型，用于解决语法高亮问题
   */
  private async recreateModel(): Promise<void> {
    if (!this.editorInstance) return;

    try {
      // 保存当前状态
      let currentValue = '';

      try {
        currentValue = this.editorInstance.getValue() || this.code || '';
      } catch (error) {
        console.warn('Failed to save current state before recreating model:', error);
        currentValue = this.code || '';
      }

      const language = this.getLanguageFromFilePath(this.filePath);

      // 先将编辑器设置为null，断开与旧模型的连接
      const oldModel = this.editorInstance.getModel();
      this.editorInstance.setModel(null);

      // 等待一帧，确保所有异步操作完成
      await new Promise(resolve => requestAnimationFrame(resolve));

      // 清理旧模型
      if (oldModel) {
        try {
          oldModel.dispose();
        } catch (error) {
          console.warn('Failed to dispose old model:', error);
        }
      }

      // 再等待一帧，确保dispose完成
      await new Promise(resolve => requestAnimationFrame(resolve));

      // 创建新的模型
      const validatedContent = this.validateContent(currentValue);
      const newModel = monaco.editor.createModel(validatedContent, language);

      // 设置新模型
      this.editorInstance.setModel(newModel);

      // 恢复光标到安全位置
      setTimeout(() => {
        try {
          this.editorInstance?.setPosition({ lineNumber: 1, column: 1 });
        } catch (error) {
          console.warn('Failed to restore position after model recreation:', error);
        }
      }, 100);

      console.log('Monaco editor model recreated successfully');
    } catch (error) {
      console.error('Failed to recreate model:', error);

      // 最后的回退方案：重置编辑器到基本状态
      try {
        const validatedContent = this.validateContent(this.code || '');
        const basicModel = monaco.editor.createModel(validatedContent, 'plaintext');
        this.editorInstance?.setModel(basicModel);
        this.editorInstance?.setPosition({ lineNumber: 1, column: 1 });
        console.log('Fallback to basic model completed');
      } catch (fallbackError) {
        console.error('Even basic model creation failed:', fallbackError);
      }
    }
  }

  /**
   * 根据文件路径推断语言类型
   */
  private getLanguageFromFilePath(filePath: any): string {
    if (!filePath || typeof filePath !== 'string') {
      return this.options.language || 'cpp';
    }

    const ext = filePath.split('.').pop()?.toLowerCase() || '';

    const languageMap: Record<string, string> = {
      'cpp': 'cpp',
      'c': 'cpp',
      'h': 'cpp',
      'ino': 'cpp',
      'json': 'json',
      'md': 'markdown'
    };

    return languageMap[ext] || this.options.language || 'cpp';
  }

  /**
   * 根据语言类型按需加载对应的扩展
   */
  private async loadLanguageExtension(language: string): Promise<void> {
    // 避免重复加载
    if (this.loadedLanguageExtensions.has(language)) {
      // console.log(`语言扩展 ${language} 已加载，跳过`);
      return;
    }

    const extensionMap: Record<string, string> = {
      'cpp': 'vscode/extensions/cpp',
      'json': 'vscode/extensions/json',
      'markdown': 'vscode/extensions/markdown-basics',

    };

    const extensionPath = extensionMap[language];
    if (!extensionPath) {
      console.warn(`未找到语言 ${language} 的扩展配置`);
      return;
    }

    try {
      // console.log(`开始加载语言扩展: ${language}`);
      await this.extensionLoader.loadExtension(extensionPath, {
        hostKind: ExtensionHostKind.LocalWebWorker,
        system: true
      });

      this.loadedLanguageExtensions.add(language);
      console.log(`语言扩展 ${language} 加载成功`);
    } catch (error) {
      console.error(`加载语言扩展 ${language} 失败:`, error);
      // 即使失败也标记为已尝试加载，避免重复尝试
      this.loadedLanguageExtensions.add(language);
      throw error;
    }
  }

  async loadCpptools() {
    // 对于C++，还要加载cpptools扩展（如果存在）
    const cppToolsPath = 'C:\\Users\\coloz\\AppData\\Local\\aily-project\\extensions\\cpptools';
    try {
      console.log('加载cpptools扩展...');
      await this.extensionLoader.loadExternalExtension(cppToolsPath, {
        hostKind: ExtensionHostKind.LocalProcess,
        system: false
      });
      console.log('cpptools扩展加载成功');
    } catch (error) {
      console.warn('加载cpptools扩展失败:', error);
      // 即使cpptools加载失败，也继续加载基本的cpp扩展
    }
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

      // 根据当前文件类型按需加载语言扩展
      const language = (this.filePath && typeof this.filePath === 'string')
        ? this.getLanguageFromFilePath(this.filePath)
        : (this.options.language || 'cpp');

      await this.loadLanguageExtension(language);

      // 手动设置默认主题配置和启用API提案
      // await this.configureDefaultTheme();
      updateUserConfiguration(`{
        "workbench.colorTheme": "Default Dark Modern",
        "extensions.enableProposedApi": ["ms-vscode.cpptools"]
      }`);

      // 创建编辑器实例
      this.editorInstance = monaco.editor.create(this.monacoContainer.nativeElement, {
        value: this.code || '',
        language: language,
        automaticLayout: true,
        // 优化minimap配置以减少重绘
        minimap: {
          enabled: true,
          side: 'right',
          size: 'proportional',
          showSlider: 'mouseover', // 只在鼠标悬停时显示滑块
          renderCharacters: false, // 不渲染字符，只显示块状颜色
          maxColumn: 120, // 限制minimap宽度
        },
        // 其他性能优化选项
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        ...this.options
      });

      // 添加内容变化监听
      if (this.editorInstance) {
        this.editorInstance.onDidChangeModelContent(() => {
          const value = this.editorInstance?.getValue() || '';
          this.onCodeChange(value);
        });

        // 添加模型变化监听
        this.editorInstance.onDidChangeModel((e) => {
          // console.log('Editor model changed:', e);
          // 当模型变化时，确保光标位置安全
          setTimeout(() => {
            this.ensureSafeCursorPosition();
          }, 50);
        });

        // 添加错误监听（如果可用）
        try {
          // 监听潜在的tokenization错误
          const model = this.editorInstance.getModel();
          if (model) {
            // 监听模型内容变化，以防出现tokenization问题
            model.onDidChangeContent(() => {
              // 延迟验证，确保tokenization完成
              setTimeout(() => {
                this.validateModelState();
              }, 100);
            });
          }
        } catch (error) {
          console.warn('Failed to setup model listeners:', error);
        }
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

      // 验证获取到的viewState是否包含有效数据
      if (viewState && this.isValidViewState(viewState)) {
        // console.log('获取视图状态成功:', viewState);
        return viewState;
      } else {
        console.warn('获取到的视图状态无效');
        return null;
      }
    } catch (error) {
      console.warn('获取视图状态失败:', error);
      return null;
    }
  }

  /**
   * 检查视图状态是否有效
   */
  private isValidViewState(viewState: ViewState): boolean {
    if (!viewState) return false;

    try {
      const model = this.editorInstance?.getModel();
      if (!model) return false;

      const lineCount = model.getLineCount();

      // 检查cursor state
      if (viewState.cursorState && Array.isArray(viewState.cursorState)) {
        for (const cursor of viewState.cursorState) {
          if (cursor && cursor.position) {
            const { lineNumber, column } = cursor.position;
            if (lineNumber < 1 || lineNumber > lineCount || column < 1) {
              console.warn('发现无效的光标位置:', cursor.position);
              return false;
            }
          }
        }
      }

      return true;
    } catch (error) {
      console.warn('验证视图状态时出错:', error);
      return false;
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
      // 验证并修正视图状态
      const validatedViewState = this.validateViewState(viewState);

      if (validatedViewState) {
        this.editorInstance.restoreViewState(validatedViewState);
        // console.log('恢复视图状态成功');
      } else {
        console.warn('视图状态验证失败，跳过恢复');
        // 回退到文件开头
        this.editorInstance.setPosition({ lineNumber: 1, column: 1 });
      }
    } catch (error) {
      console.warn('恢复视图状态失败:', error);
      // 尝试回退到安全位置
      try {
        this.editorInstance?.setPosition({ lineNumber: 1, column: 1 });
      } catch (fallbackError) {
        console.error('回退到文件开头也失败:', fallbackError);
      }
    }
  }

  /**
   * 验证并修正视图状态中的位置信息
   */
  private validateViewState(viewState: ViewState): ViewState | null {
    if (!viewState || !this.editorInstance) return null;

    try {
      const model = this.editorInstance.getModel();
      if (!model) return null;

      const lineCount = model.getLineCount();

      // 获取每行的最大列数的辅助函数
      const getMaxColumn = (lineNumber: number): number => {
        try {
          return model.getLineMaxColumn(lineNumber);
        } catch {
          return 1;
        }
      };

      // 验证并修正行号和列号
      const validatePosition = (lineNumber: number, column: number): { lineNumber: number, column: number } => {
        const validLineNumber = Math.max(1, Math.min(lineNumber || 1, lineCount));
        const maxColumn = getMaxColumn(validLineNumber);
        const validColumn = Math.max(1, Math.min(column || 1, maxColumn));
        return { lineNumber: validLineNumber, column: validColumn };
      };

      // 创建一个修正后的viewState副本
      const correctedViewState: any = { ...viewState };

      // 检查和修正cursor state
      if (correctedViewState.cursorState && Array.isArray(correctedViewState.cursorState)) {
        correctedViewState.cursorState = correctedViewState.cursorState.map((cursor: any) => {
          if (cursor && cursor.position) {
            const validatedPos = validatePosition(cursor.position.lineNumber, cursor.position.column);
            return {
              ...cursor,
              position: validatedPos
            };
          }
          return cursor;
        });
      }

      // 检查和修正view state中的滚动位置等
      if (correctedViewState.viewState) {
        // 修正滚动位置
        if (correctedViewState.viewState.scrollTop) {
          correctedViewState.viewState.scrollTop = Math.max(0, correctedViewState.viewState.scrollTop);
        }
        if (correctedViewState.viewState.scrollLeft) {
          correctedViewState.viewState.scrollLeft = Math.max(0, correctedViewState.viewState.scrollLeft);
        }
      }

      return correctedViewState as ViewState;
    } catch (error) {
      console.warn('验证视图状态失败:', error);
      return null;
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
            // 验证并修正视图状态
            const validatedViewState = this.validateViewState(viewState);

            if (validatedViewState) {
              this.editorInstance.restoreViewState(validatedViewState);
              // console.log('视图状态安全恢复成功');
              resolve(true);
            } else {
              console.warn('视图状态验证失败，跳过恢复');
              resolve(false);
            }
            return;
          } catch (error) {
            console.warn('恢复视图状态失败:', error);
            // 尝试恢复到文件开头
            try {
              this.editorInstance?.setPosition({ lineNumber: 1, column: 1 });
              resolve(true);
            } catch (fallbackError) {
              console.error('回退到文件开头也失败:', fallbackError);
              resolve(false);
            }
            return;
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
