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

  /** 剪贴板命令是否已注册(全局标志) */
  private static clipboardCommandsRegistered = false;

  /** Model 缓存：每个文件路径对应一个 model */
  private modelCache = new Map<string, monaco.editor.ITextModel>();

  /** ViewState 缓存：每个文件路径对应一个视图状态 */
  private viewStateCache = new Map<string, monaco.editor.ICodeEditorViewState | null>();

  constructor(
    private extensionLoader: ExtensionLoaderService
  ) { }

  async ngOnInit(): Promise<void> {

  }

  async ngAfterViewInit(): Promise<void> {
    // 延迟初始化编辑器，让组件先渲染
    setTimeout(() => {
      this.init();
    }, 0);
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
   * 安全地更新编辑器内容，使用 Model 缓存机制
   */
  private async updateEditorContentSafely(hasFilePathChange: boolean, hasCodeChange: boolean): Promise<void> {
    if (!this.editorInstance) return;

    try {
      // 如果文件路径改变，切换到对应的 model
      if (hasFilePathChange) {
        // 防止并发的模型切换操作
        if (this.isChangingModel) {
          console.warn('模型切换正在进行中，跳过此次请求');
          return;
        }

        this.isChangingModel = true;

        try {
          console.log('切换文件:', this.filePath);

          // 等待 code 更新（如果需要）
          if (!hasCodeChange) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }

          await this.switchToFile(this.filePath, this.code || '');
        } finally {
          this.isChangingModel = false;
        }
      }
      // 如果只是内容改变，更新当前 model 的内容
      else if (hasCodeChange) {
        const currentModel = this.editorInstance.getModel();
        if (currentModel) {
          const currentValue = currentModel.getValue();
          const newContent = this.code || '';

          if (currentValue !== newContent) {
            // 直接更新 model 的值，保留撤销历史
            currentModel.setValue(this.validateContent(newContent));
          }
        }
      }
    } catch (error) {
      console.error('Error in updateEditorContentSafely:', error);
    }
  }

  /**
   * 切换到指定文件（使用 Model 缓存）
   */
  private async switchToFile(filePath: string, content: string): Promise<void> {
    if (!this.editorInstance || !filePath) return;

    // 1. 保存当前文件的视图状态
    const currentModel = this.editorInstance.getModel();
    if (currentModel) {
      const currentUri = currentModel.uri.toString();
      const viewState = this.editorInstance.saveViewState();
      this.viewStateCache.set(currentUri, viewState);
      console.log('保存视图状态:', currentUri);
    }

    // 2. 获取目标文件的语言类型
    const language = this.getLanguageFromFilePath(filePath);

    // 3. 加载语言扩展（如果需要）
    await this.loadLanguageExtension(language);

    // 4. 获取或创建目标文件的 model
    const uri = monaco.Uri.file(filePath);
    const uriString = uri.toString();
    let model = this.modelCache.get(uriString);

    if (!model) {
      // 首次打开文件，创建新 model
      console.log('创建新 model:', filePath, 'language:', language);
      model = monaco.editor.createModel(this.validateContent(content), language, uri);
      this.modelCache.set(uriString, model);

      // 监听 model 内容变化，用于检测修改状态
      model.onDidChangeContent(() => {
        // 内容变化由父组件处理
      });
    } else {
      // Model 已存在，更新内容（如果外部修改了文件）
      const currentContent = model.getValue();
      if (currentContent !== content) {
        console.log('更新已存在的 model 内容');
        model.setValue(this.validateContent(content));
      }
    }

    // 5. 切换 model
    this.editorInstance.setModel(model);
    console.log('切换 model 完成:', filePath);

    // 6. 恢复视图状态
    const viewState = this.viewStateCache.get(uriString);
    if (viewState) {
      console.log('恢复视图状态:', filePath);
      this.editorInstance.restoreViewState(viewState);
    } else {
      // 新文件，跳转到开头
      this.editorInstance.setPosition({ lineNumber: 1, column: 1 });
    }

    this.editorInstance.focus();
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
        this.editorInstance.setModel(null);

        // 等待一帧，确保所有异步操作完成
        await new Promise(resolve => requestAnimationFrame(resolve));

        // 清理所有缓存的 model
        for (const [uri, model] of this.modelCache.entries()) {
          try {
            model.dispose();
            console.log('清理 model:', uri);
          } catch (error) {
            console.warn('Model disposal warning:', error);
          }
        }
        this.modelCache.clear();
        this.viewStateCache.clear();

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
   * 重新创建编辑器模型（用于错误恢复）
   */
  private async recreateModel(): Promise<void> {
    if (!this.editorInstance || !this.filePath) return;

    try {
      console.log('重新创建模型:', this.filePath);

      // 保存当前内容
      let currentValue = '';
      try {
        currentValue = this.editorInstance.getValue() || this.code || '';
      } catch (error) {
        currentValue = this.code || '';
      }

      // 清除缓存，强制重新创建
      const uri = monaco.Uri.file(this.filePath);
      const uriString = uri.toString();
      const oldModel = this.modelCache.get(uriString);

      if (oldModel) {
        this.modelCache.delete(uriString);
        this.viewStateCache.delete(uriString);
        try {
          oldModel.dispose();
        } catch (error) {
          console.warn('Failed to dispose old model:', error);
        }
      }

      // 重新创建
      await this.switchToFile(this.filePath, currentValue);

      console.log('模型重新创建成功');
    } catch (error) {
      console.error('Failed to recreate model:', error);
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
      // 'json': 'vscode/extensions/json',  // 已禁用：避免与手动注册的格式化提供者冲突
      'markdown': 'vscode/extensions/markdown-basics',
    };

    const extensionPath = extensionMap[language];

    // 对于 JSON，不加载扩展，使用手动注册的格式化提供者
    if (language === 'json') {
      console.log('JSON 语言：使用手动注册的格式化提供者，跳过扩展加载');
      this.loadedLanguageExtensions.add(language);
      return;
    }

    if (!extensionPath) {
      console.warn(`未找到语言 ${language} 的扩展配置`);
      return;
    }

    try {
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



  async init() {
    try {
      console.log('Initializing Monaco VSCode API...');
      // 加载

      if (!window['vscode_inited']) {
        await MonacoVSCodeCSSLoader.loadAllMonacoCSS();

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

      updateUserConfiguration(`{
        "workbench.colorTheme": "Default Dark Modern",
        "json.format.enable": true
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

        // // 设置剪贴板支持（Electron环境）
        // await this.setupClipboardSupport();

        // // 覆盖编辑器的剪贴板 actions
        // this.overrideClipboardActions();

        // 注册 JSON 格式化提供者（确保快捷键可用，使用 VSCode API）
        // await this.registerJsonFormattingProvider();
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
   * 关闭文件时清理对应的 model（供父组件调用）
   */
  public disposeModel(filePath: string): void {
    const uri = monaco.Uri.file(filePath);
    const uriString = uri.toString();
    const model = this.modelCache.get(uriString);

    if (model) {
      try {
        // 如果是当前正在使用的 model，先切换到 null
        if (this.editorInstance?.getModel() === model) {
          this.editorInstance.setModel(null);
        }
        model.dispose();
        this.modelCache.delete(uriString);
        this.viewStateCache.delete(uriString);
        console.log('清理文件 model:', filePath);
      } catch (error) {
        console.warn('Failed to dispose model for', filePath, error);
      }
    }
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

  /**
   * 格式化当前文档
   * 支持 JSON、C++、Markdown 等语言的格式化
   * @returns Promise<boolean> 格式化是否成功
   */
  public async formatDocument(): Promise<boolean> {
    if (!this.editorInstance) {
      console.warn('编辑器实例未初始化，无法格式化');
      return false;
    }

    const model = this.editorInstance.getModel();
    if (!model) {
      console.warn('编辑器模型未初始化，无法格式化');
      return false;
    }

    try {
      const language = model.getLanguageId();
      console.log(`正在格式化 ${language} 文档...`);

      // 先检查是否有格式化提供者
      console.log('=== 格式化前检查 ===');

      // 获取当前文档的 URI
      const uri = model.uri;
      console.log('文档 URI:', uri.toString());
      console.log('文档语言:', language);
      console.log('Monaco 语言列表:', monaco.languages.getLanguages().map(l => l.id));

      // 检查该语言是否在 Monaco 中注册
      const registeredLanguages = monaco.languages.getLanguages();
      const isLanguageRegistered = registeredLanguages.some(l => l.id === language);
      console.log(`语言 ${language} 是否已注册:`, isLanguageRegistered);

      if (!isLanguageRegistered) {
        console.error(`✗ 语言 ${language} 未在 Monaco 中注册！这是格式化失败的根本原因。`);
        console.log('尝试手动触发语言注册...');

        // 尝试触发 C++ 语言的激活
        try {
          const vscode = await import('vscode');
          await vscode.commands.executeCommand('setContext', 'resourceLangId', language);
        } catch (e) {
          console.warn('触发语言激活失败:', e);
        }
      }

      // 尝试使用 Monaco 的格式化 action
      console.log('尝试使用 Monaco 格式化 action...');
      const formatAction = this.editorInstance.getAction('editor.action.formatDocument');

      if (!formatAction) {
        console.warn(`未找到格式化 action，语言: ${language}`);

        // JSON 的回退方案
        if (language === 'json') {
          return await this.fallbackJsonFormat();
        }

        return false;
      }

      // 执行格式化
      await formatAction.run();
      console.log('✓ 文档格式化成功');
      return true;
    } catch (error) {
      console.error('文档格式化失败:', error);

      // 如果是 JSON，尝试回退方案
      const language = model.getLanguageId();
      if (language === 'json') {
        console.log('尝试使用回退的 JSON 格式化方案...');
        return await this.fallbackJsonFormat();
      }

      return false;
    }
  }

  /**
   * 检查是否有可用的格式化提供者
   */
  private async checkFormatProviders(model: monaco.editor.ITextModel): Promise<boolean> {
    try {
      // 使用 Monaco 的 API 检查格式化提供者
      const providers = monaco.languages.getLanguages();
      const languageId = model.getLanguageId();

      console.log(`检查 ${languageId} 的格式化提供者...`);

      // 等待一小段时间让提供者注册
      await new Promise(resolve => setTimeout(resolve, 100));

      return true; // 暂时返回 true，让格式化尝试执行
    } catch (error) {
      console.warn('检查格式化提供者失败:', error);
      return false;
    }
  }

  /**
   * JSON 格式化的回退方案（使用原生 JavaScript）
   */
  private async fallbackJsonFormat(): Promise<boolean> {
    if (!this.editorInstance) return false;

    try {
      const model = this.editorInstance.getModel();
      if (!model) return false;

      const content = model.getValue();
      console.log('使用原生 JSON.parse/stringify 进行格式化...');

      // 尝试解析和格式化 JSON
      const parsed = JSON.parse(content);
      const formatted = JSON.stringify(parsed, null, 2);

      // 更新编辑器内容
      const fullRange = model.getFullModelRange();
      model.pushEditOperations(
        [],
        [{
          range: fullRange,
          text: formatted
        }],
        () => null
      );

      console.log('✓ JSON 格式化成功（使用回退方案）');
      return true;
    } catch (error) {
      console.error('JSON 回退格式化失败:', error);
      return false;
    }
  }

  /**
   * 格式化选中的代码
   * @returns Promise<boolean> 格式化是否成功
   */
  public async formatSelection(): Promise<boolean> {
    if (!this.editorInstance) {
      console.warn('编辑器实例未初始化，无法格式化');
      return false;
    }

    const selection = this.editorInstance.getSelection();
    if (!selection || selection.isEmpty()) {
      console.warn('没有选中任何内容，将格式化整个文档');
      return this.formatDocument();
    }

    const model = this.editorInstance.getModel();
    if (!model) {
      console.warn('编辑器模型未初始化，无法格式化');
      return false;
    }

    try {
      const language = model.getLanguageId();
      console.log(`正在格式化选中的 ${language} 代码...`);

      // 获取格式化选区 action
      const formatAction = this.editorInstance.getAction('editor.action.formatSelection');

      if (!formatAction) {
        console.warn('未找到格式化选区 action，尝试格式化整个文档');
        return this.formatDocument();
      }

      // 执行格式化
      await formatAction.run();
      console.log('✓ 选中代码格式化成功');
      return true;
    } catch (error) {
      console.error('选中代码格式化失败:', error);
      return false;
    }
  }

  /**
   * 触发 VS Code 命令
   * @param commandId 命令 ID，例如 'editor.action.formatDocument'
   * @returns Promise<boolean> 命令是否执行成功
   */
  public async executeCommand(commandId: string): Promise<boolean> {
    if (!this.editorInstance) {
      console.warn('编辑器实例未初始化，无法执行命令');
      return false;
    }

    try {
      const action = this.editorInstance.getAction(commandId);

      if (!action) {
        console.warn(`未找到命令: ${commandId}`);
        return false;
      }

      await action.run();
      console.log(`✓ 命令 ${commandId} 执行成功`);
      return true;
    } catch (error) {
      console.error(`命令 ${commandId} 执行失败:`, error);
      return false;
    }
  }

}
