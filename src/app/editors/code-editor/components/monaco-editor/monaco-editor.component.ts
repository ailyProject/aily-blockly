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

  // /** cpptools扩展是否已加载 */
  // private cpptoolsLoaded = false;

  /** clangd扩展是否已加载 */
  private clangdLoaded = false;

  /** JSON格式化提供者是否已注册(全局标志) */
  private static jsonFormatterRegistered = false;

  /** 当前正在进行的模型切换操作 */
  private isChangingModel = false;

  /** 剪贴板命令是否已注册(全局标志) */
  private static clipboardCommandsRegistered = false;

  constructor(
    private extensionLoader: ExtensionLoaderService
  ) { }

  async ngOnInit(): Promise<void> {

  }

  async ngAfterViewInit(): Promise<void> {
    this.init();
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

      // 最后的回退方案：重置编辑器到基本状态（使用json作为默认，因为我们有手动注册的格式化器）
      try {
        const validatedContent = this.validateContent(this.code || '');
        const fallbackLanguage = this.getLanguageFromFilePath(this.filePath) || 'json';
        const basicModel = monaco.editor.createModel(validatedContent, fallbackLanguage);
        this.editorInstance?.setModel(basicModel);
        this.editorInstance?.setPosition({ lineNumber: 1, column: 1 });
        console.log(`Fallback to basic model completed with language: ${fallbackLanguage}`);
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
      // console.log(`开始加载语言扩展: ${language}`);
      await this.extensionLoader.loadExtension(extensionPath, {
        hostKind: ExtensionHostKind.LocalWebWorker,
        system: true
      });

      this.loadedLanguageExtensions.add(language);
      console.log(`语言扩展 ${language} 加载成功`);

      // 如果是C++语言，自动加载cpptools扩展以提供代码补全功能
      if (language === 'cpp') {
        // await this.loadCpptools();
      }
    } catch (error) {
      console.error(`加载语言扩展 ${language} 失败:`, error);
      // 即使失败也标记为已尝试加载，避免重复尝试
      this.loadedLanguageExtensions.add(language);
      throw error;
    }
  }

  /**
   * 检查格式化提供者是否已注册
   */
  private async checkFormattingProviders(): Promise<void> {
    try {
      console.log('=== 检查格式化提供者 ===');
      
      // 1. 检查 Monaco 的语言注册
      const languages = monaco.languages.getLanguages();
      console.log('Monaco 已注册的语言:', languages.map(l => l.id));
      
      // 2. 检查 C++ 相关语言
      const cppLanguages = languages.filter(l => 
        l.id === 'cpp' || l.id === 'c' || l.id === 'cuda-cpp' || 
        l.id === 'objective-c' || l.id === 'objective-cpp'
      );
      console.log('C++ 相关语言:', cppLanguages.map(l => l.id));
      
      if (cppLanguages.length === 0) {
        console.warn('⚠ 没有找到 C++ 语言注册！');
      } else {
        console.log('✓ C++ 语言已注册');
      }
      
      // 3. 检查 VSCode 扩展
      const vscode = await import('vscode');
      const allExtensions = vscode.extensions.all;
      console.log('所有扩展数量:', allExtensions.length);
      
      const clangdExtension = vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd');
      if (clangdExtension) {
        console.log('✓ clangd 扩展已找到');
        console.log('  - 扩展 ID:', clangdExtension.id);
        console.log('  - 是否激活:', clangdExtension.isActive);
        console.log('  - 版本:', clangdExtension.packageJSON?.version);
        
        if (!clangdExtension.isActive) {
          console.warn('⚠ clangd 扩展未激活，尝试激活...');
          try {
            await clangdExtension.activate();
            console.log('✓ clangd 扩展激活成功');
          } catch (error) {
            console.error('✗ clangd 扩展激活失败:', error);
          }
        }
      } else {
        console.error('✗ 未找到 clangd 扩展');
      }
      
      // 4. 检查可用的命令
      const commands = await vscode.commands.getCommands();
      const formatCommands = commands.filter(cmd => 
        cmd.includes('format') || cmd.includes('clangd')
      );
      console.log('格式化相关命令 (部分):', formatCommands.slice(0, 10));
      
      console.log('=== 检查完成 ===');
    } catch (error) {
      console.error('检查格式化提供者时出错:', error);
    }
  }

  /**
   * 获取 clangd 可执行文件路径
   * 优先使用项目内置的 clangd，如果不存在则使用系统路径
   */
  private async getClangdPath(): Promise<string> {
    try {
      // 如果在 Electron 环境中
      const electronAPI = (window as any).electronAPI;
      
      if (electronAPI) {
        try {
          // 尝试从 Electron 获取应用路径
          const appPath = await electronAPI.platform?.getAppPath?.();
          
          if (appPath) {
            // 判断平台
            const platform = await electronAPI.platform?.getPlatform?.() || 'win32';
            const isWindows = platform === 'win32';
            const clangdBinary = isWindows ? 'clangd.exe' : 'clangd';
            
            // 构造完整路径：appPath/child/clangd/bin/clangd.exe
            const fullPath = `${appPath}/child/clangd/bin/${clangdBinary}`;
            console.log('构造的 clangd 路径:', fullPath);
            return fullPath;
          }
        } catch (error) {
          console.warn('从 Electron API 获取路径失败:', error);
        }
      }
      
      // 回退方案1: 使用 location.origin 构造路径（开发环境）
      if (typeof window !== 'undefined' && window.location) {
        const origin = window.location.origin;
        const isWindows = navigator.platform.toLowerCase().includes('win');
        
        if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
          // 开发环境，使用项目根目录
          const clangdBinary = isWindows ? 'clangd.exe' : 'clangd';
          return `child/clangd/bin/${clangdBinary}`;
        }
      }
      
      // 回退方案2: 使用系统的 clangd（从 PATH 查找）
      console.warn('无法确定 clangd 路径，使用系统默认值');
      return 'clangd';
    } catch (error) {
      console.error('获取 clangd 路径时出错:', error);
      return 'clangd';
    }
  }



  /**
   * 加载 vscode-clangd 扩展，提供 C/C++ 代码补全、导航和分析功能
   * 
   * 使用示例:
   * ```typescript
   * // 使用默认的 clangd 配置
   * await this.loadClangdExtension();
   * 
   * // 或者指定自定义的 clangd 可执行文件路径
   * await this.loadClangdExtension('D:\\path\\to\\clangd\\bin\\clangd.exe');
   * ```
   * 
   * @param clangdPath clangd 可执行文件的路径，例如：'D:\\path\\to\\clangd.exe'
   *                   如果不提供，将使用扩展的默认配置（'clangd'，从 PATH 中查找）
   * @returns Promise<void>
   */
  async loadClangdExtension(): Promise<void> {
    // 检查是否已加载
    if (this.clangdLoaded) {
      console.log('clangd 扩展已加载，跳过');
      return;
    }

    // 使用绝对路径进行测试
    const clangdExtensionPath = 'D:\\Git\\aily-project\\aily-blockly-vscode\\public\\vscode\\extensions\\clangd';

    console.log('开始加载 clangd 扩展...');

    try {
      // **关键修改1**: 先加载扩展（这会自动注册配置项）
      console.log(`加载 clangd 扩展: ${clangdExtensionPath}`);
      const result = await this.extensionLoader.loadExtension(clangdExtensionPath, {
        hostKind: ExtensionHostKind.LocalProcess,
        system: true
      });

      // 等待扩展注册完成（包括配置项注册）
      await result.whenReady();
      console.log('✓ clangd 扩展已注册');

      // **关键修改2**: 手动激活扩展
      // 由于 clangd 的 activationEvents 是 "onLanguage:cpp"，我们需要手动触发激活
      console.log('尝试手动激活 clangd 扩展...');
      
      const { extensions, commands } = await import('vscode');
      
      try {
        // 方法1: 通过 extensions API 获取并激活扩展
        const clangdExtension = extensions.getExtension('llvm-vs-code-extensions.vscode-clangd');
        
        if (clangdExtension) {
          console.log('找到 clangd 扩展，开始激活...');
          
          if (!clangdExtension.isActive) {
            // 手动激活扩展
            await clangdExtension.activate();
            console.log('✓ clangd 扩展已通过 extensions.activate() 激活');
          } else {
            console.log('✓ clangd 扩展已经处于激活状态');
          }
          
          // 等待一下确保命令已注册
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // 检查命令是否已注册
          console.log('检查 clangd 命令是否已注册...');
          const allCommands = await commands.getCommands();
          const clangdCommands = allCommands.filter(cmd => cmd.startsWith('clangd.'));
          console.log('可用的 clangd 命令:', clangdCommands);
          
          if (clangdCommands.length > 0) {
            console.log('✓ clangd 命令已成功注册');
            
            // 可选：执行 clangd.activate 或 clangd.restart 来启动语言服务器
            if (clangdCommands.includes('clangd.activate')) {
              await commands.executeCommand('clangd.activate');
              console.log('✓ 已执行 clangd.activate，启动语言服务器');
            } else if (clangdCommands.includes('clangd.restart')) {
              await commands.executeCommand('clangd.restart');
              console.log('✓ 已执行 clangd.restart，启动语言服务器');
            }
          } else {
            console.warn('⚠ 扩展已激活但命令未注册');
          }
          
        } else {
          console.error('✗ 未找到 clangd 扩展（ID: llvm-vs-code-extensions.vscode-clangd）');
          
          // 列出所有已加载的扩展以供调试
          const allExtensions = extensions.all.map(ext => ext.id);
          console.log('所有已加载的扩展:', allExtensions);
        }
        
      } catch (activationError) {
        console.warn('手动激活扩展时出错:', activationError);
        console.warn('扩展将在打开 C++ 文件时自动激活');
      }

      // 额外等待确保语言服务器完全启动
      console.log('等待 clangd 语言服务器完全启动...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 标记为已加载
      this.clangdLoaded = true;
      this.loadedLanguageExtensions.add('clangd');
      
      // **关键**: 手动注册 C++ 语言到 Monaco（如果尚未注册）
      await this.ensureCppLanguageRegistered();
      
      console.log('✓ clangd 扩展加载成功');

      // **重要**: 强制触发 clangd 连接，使其注册格式化提供者
      await this.activateClangdFormatting();

      // 最终检查
      console.log('=== clangd 加载后状态检查 ===');
      const clangdExt = extensions.getExtension('llvm-vs-code-extensions.vscode-clangd');
      if (clangdExt) {
        console.log('  扩展状态:', clangdExt.isActive ? '已激活' : '未激活');
        
        // 检查 clangd 相关命令
        const allCmds = await commands.getCommands();
        const clangdCmds = allCmds.filter(cmd => cmd.startsWith('clangd.') || cmd.includes('format'));
        console.log('  可用命令:', clangdCmds);
        
        // 尝试检查 clangd 服务器状态
        try {
          // 某些扩展会暴露状态信息
          if (clangdExt.exports) {
            console.log('  扩展导出:', Object.keys(clangdExt.exports));
          }
        } catch (e) {
          console.log('  无法获取扩展导出信息');
        }
      }
      
      // 检查 Monaco 语言注册情况
      const monacoLanguages = monaco.languages.getLanguages();
      console.log('  Monaco 已注册语言:', monacoLanguages.map(l => l.id));
      const hasCpp = monacoLanguages.some(l => l.id === 'cpp' || l.id === 'c');
      console.log('  C++ 语言已注册:', hasCpp);
      
      console.log('=== 状态检查完成 ===');

    } catch (error) {
      console.error('加载 clangd 扩展失败:', error);
      throw error;
    }
  }

  /**
   * 激活 clangd 的格式化功能
   * 通过手动注册格式化提供者来确保格式化功能可用
   */
  private async activateClangdFormatting(): Promise<void> {
    try {
      console.log('激活 clangd 格式化功能...');
      
      const vscode = await import('vscode');
      
      // 方法1: 尝试执行 clangd.activate 命令（如果存在）
      try {
        const commands = await vscode.commands.getCommands();
        if (commands.includes('clangd.activate')) {
          await vscode.commands.executeCommand('clangd.activate');
          console.log('✓ 执行了 clangd.activate 命令');
        }
      } catch (e) {
        console.log('clangd.activate 命令不可用或执行失败');
      }
      
      // 方法2: 手动为 C++ 注册一个格式化提供者
      // 使用 clang-format 命令行工具进行格式化
      console.log('注册 C++ 格式化提供者 (使用 clang-format)...');
      
      const languageIds = ['cpp', 'c', 'cuda-cpp', 'objective-c', 'objective-cpp'];
      
      for (const langId of languageIds) {
        try {
          // 使用 Monaco 的 API 注册格式化提供者
          const disposable = monaco.languages.registerDocumentFormattingEditProvider(langId, {
            async provideDocumentFormattingEdits(model, options, token) {
              console.log(`开始格式化 ${langId} 文档...`);
              
              try {
                const content = model.getValue();
                const lineCount = model.getLineCount();
                
                console.log(`  - 文档行数: ${lineCount}`);
                console.log(`  - 调用 clang-format 工具...`);
                
                // 使用 Electron API 调用 clang-format
                const electronAPI = (window as any).electronAPI;
                
                if (!electronAPI || !electronAPI.cmd) {
                  console.error('  ✗ Electron API 不可用');
                  return [];
                }
                
                // 构造 clang-format 命令
                const clangFormatPath = 'C:\\Users\\coloz\\Downloads\\clang+llvm-21.1.3-x86_64-pc-windows-msvc.tar\\clang+llvm-21.1.3-x86_64-pc-windows-msvc\\bin\\clang-format.exe';
                
                // 检查 clang-format 是否存在
                if (!electronAPI.fs.existsSync(clangFormatPath)) {
                  console.error('  ✗ clang-format 不存在:', clangFormatPath);
                  return [];
                }
                
                console.log('  ✓ 找到 clang-format:', clangFormatPath);
                
                // 使用 stdin/stdout 方式调用 clang-format
                // clang-format 会从 stdin 读取代码，格式化后输出到 stdout
                const result = await new Promise<string>((resolve, reject) => {
                  const streamId = `format_${Date.now()}`;
                  let output = '';
                  let errorOutput = '';
                  let isCompleted = false;
                  
                  // 监听输出
                  const removeListener = electronAPI.cmd.onData(streamId, (data: any) => {
                    if (data.type === 'stdout') {
                      output += data.data;
                    } else if (data.type === 'stderr') {
                      errorOutput += data.data;
                    } else if (data.type === 'exit') {
                      if (isCompleted) return; // 防止重复调用
                      isCompleted = true;
                      removeListener();
                      
                      if (data.code === 0) {
                        console.log('  ✓ clang-format 执行成功，输出长度:', output.length);
                        resolve(output);
                      } else {
                        reject(new Error(`clang-format 退出码: ${data.code}, 错误: ${errorOutput}`));
                      }
                    } else if (data.type === 'error') {
                      if (isCompleted) return;
                      isCompleted = true;
                      removeListener();
                      reject(new Error(`执行错误: ${data.message || data.data}`));
                    }
                  });
                  
                  // 执行命令
                  // 使用 --assume-filename 参数指定文件类型
                  // 使用 --style=Google 指定代码风格
                  electronAPI.cmd.run({
                    command: clangFormatPath,
                    args: ['--assume-filename=code.cpp', '--style=Google'],
                    cwd: 'D:\\',
                    streamId: streamId
                  }).then(() => {
                    console.log('  - 命令已启动，正在写入代码到 stdin...');
                    // 延迟一下确保进程已启动
                    setTimeout(() => {
                      // 通过 stdin 发送代码内容
                      electronAPI.cmd.input(streamId, content);
                      console.log('  - 代码已写入，等待格式化结果...');
                    }, 100);
                  }).catch((error: any) => {
                    if (isCompleted) return;
                    isCompleted = true;
                    removeListener();
                    reject(error);
                  });
                  
                  // 超时处理（增加到 10 秒）
                  setTimeout(() => {
                    if (isCompleted) return;
                    isCompleted = true;
                    removeListener();
                    electronAPI.cmd.kill(streamId);
                    reject(new Error('clang-format 超时'));
                  }, 10000);
                });
                
                console.log('  ✓ clang-format 执行成功');
                
                // 如果格式化后的内容与原内容相同，返回空
                if (result === content) {
                  console.log('  - 代码已经是格式化的，无需修改');
                  return [];
                }
                
                // 返回完整替换的编辑
                const fullRange = {
                  startLineNumber: 1,
                  startColumn: 1,
                  endLineNumber: lineCount,
                  endColumn: model.getLineMaxColumn(lineCount)
                };
                
                console.log('  ✓ 返回格式化编辑');
                
                return [{
                  range: fullRange,
                  text: result
                }];
                
              } catch (error) {
                console.error('  ✗ 格式化失败:', error);
                return [];
              }
            }
          });
          
          console.log(`✓ 已为 ${langId} 注册格式化提供者`);
        } catch (error) {
          console.error(`注册 ${langId} 格式化提供者失败:`, error);
        }
      }
      
      console.log('✓ clangd 格式化功能激活完成');
    } catch (error) {
      console.error('激活 clangd 格式化功能失败:', error);
    }
  }

  /**
   * 确保 C++ 语言在 Monaco 中正确注册
   */
  private async ensureCppLanguageRegistered(): Promise<void> {
    try {
      console.log('检查并注册 C++ 语言...');
      
      const registeredLanguages = monaco.languages.getLanguages();
      const cppLanguages = ['cpp', 'c', 'cuda-cpp', 'objective-c', 'objective-cpp'];
      
      for (const langId of cppLanguages) {
        const isRegistered = registeredLanguages.some(l => l.id === langId);
        
        if (!isRegistered) {
          console.log(`  - 注册语言: ${langId}`);
          
          // 手动注册语言
          monaco.languages.register({
            id: langId,
            extensions: langId === 'cpp' ? ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h'] :
                        langId === 'c' ? ['.c', '.h'] :
                        langId === 'cuda-cpp' ? ['.cu', '.cuh'] :
                        langId === 'objective-c' ? ['.m'] :
                        ['.mm'],
            aliases: langId === 'cpp' ? ['C++', 'Cpp', 'cpp'] :
                     langId === 'c' ? ['C', 'c'] :
                     langId === 'cuda-cpp' ? ['CUDA C++'] :
                     langId === 'objective-c' ? ['Objective-C'] :
                     ['Objective-C++'],
            mimetypes: langId === 'cpp' || langId === 'c' ? ['text/x-c++src', 'text/x-c++hdr'] : []
          });
          
          console.log(`✓ 语言 ${langId} 已注册`);
        } else {
          console.log(`  - 语言 ${langId} 已存在`);
        }
      }
      
      console.log('C++ 语言注册检查完成');
    } catch (error) {
      console.error('注册 C++ 语言失败:', error);
    }
  }

  // async loadCpptools() {
  //   // 避免重复加载cpptools扩展
  //   if (this.cpptoolsLoaded) {
  //     console.log('cpptools扩展已加载，跳过');
  //     return;
  //   }

  //   // 对于C++，还要加载cpptools扩展（如果存在）
  //   const cppToolsPath = 'C:\\Users\\coloz\\AppData\\Local\\aily-project\\extensions\\cpptools';
  //   try {
  //     console.log('加载cpptools扩展...');
  //     await this.extensionLoader.loadExternalExtension(cppToolsPath, {
  //       hostKind: ExtensionHostKind.LocalProcess,
  //       system: false
  //     });
  //     this.cpptoolsLoaded = true;
  //     console.log('cpptools扩展加载成功');
  //   } catch (error) {
  //     console.warn('加载cpptools扩展失败:', error);
  //     // 即使cpptools加载失败，也标记为已尝试加载，避免重复尝试
  //     this.cpptoolsLoaded = true;
  //   }
  // }


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

      // **重要**: 先配置 clangd 路径，再加载扩展
      // 使用绝对路径进行测试
      updateUserConfiguration(`{
        "workbench.colorTheme": "Default Dark Modern",
        "extensions.enableProposedApi": ["llvm-vs-code-extensions.vscode-clangd"],
        "json.format.enable": true,
        "clangd.path": "D:\\\\Git\\\\aily-project\\\\aily-blockly-vscode\\\\child\\\\clangd\\\\bin\\\\clangd.exe",
        "clangd.arguments": [
          "--background-index",
          "--clang-tidy",
          "--completion-style=detailed",
          "--header-insertion=iwyu",
          "--pch-storage=memory"
        ],
        "clangd.enable": true
      }`);

      // 加载 clangd 扩展以提供 C/C++ 智能提示和格式化
      await this.loadClangdExtension();

      // 等待一段时间确保 clangd 完全启动
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 检查格式化提供者是否已注册
      await this.checkFormattingProviders();

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
   * 注册通用格式化提供者
   * 使用 VSCode API 而不是 Monaco API，这是 monaco-vscode-api 的正确用法
   * 为所有语言（包括 plaintext）注册基本的格式化提供者
   */
  // private async registerJsonFormattingProvider(): Promise<void> {
  //   // 检查是否已经注册过，避免重复注册
  //   if (MonacoEditorComponent.jsonFormatterRegistered) {
  //     console.log('格式化提供者已注册，跳过');
  //     return;
  //   }

  //   try {
  //     // 导入 VSCode API（这是 monaco-vscode-api 的正确用法）
  //     const vscode = await import('vscode');

  //     // 注册 JSON 文档格式化提供者
  //     const jsonDisposable = vscode.languages.registerDocumentFormattingEditProvider(
  //       { scheme: '*', language: 'json' },
  //       {
  //         provideDocumentFormattingEdits(document, options, token) {
  //           try {
  //             const text = document.getText();

  //             // 解析并格式化 JSON
  //             const parsed = JSON.parse(text);
  //             const tabSize = options.tabSize || 2;
  //             const formatted = JSON.stringify(parsed, null, tabSize);

  //             // 返回 VSCode TextEdit 对象
  //             const fullRange = new vscode.Range(
  //               document.positionAt(0),
  //               document.positionAt(text.length)
  //             );

  //             return [vscode.TextEdit.replace(fullRange, formatted)];
  //           } catch (error) {
  //             console.error('JSON 格式化失败:', error);
  //             return [];
  //           }
  //         }
  //       }
  //     );

  //     // 注册 JSON 范围格式化提供者
  //     const jsonRangeDisposable = vscode.languages.registerDocumentRangeFormattingEditProvider(
  //       { scheme: '*', language: 'json' },
  //       {
  //         provideDocumentRangeFormattingEdits(document, range, options, token) {
  //           try {
  //             // 获取选中范围的文本
  //             const text = document.getText(range);

  //             // 尝试解析并格式化
  //             const parsed = JSON.parse(text);
  //             const tabSize = options.tabSize || 2;
  //             const formatted = JSON.stringify(parsed, null, tabSize);

  //             return [vscode.TextEdit.replace(range, formatted)];
  //           } catch (error) {
  //             // 如果选中的不是完整的 JSON，尝试格式化整个文档
  //             console.warn('选中的文本不是有效的 JSON，尝试格式化整个文档');
  //             try {
  //               const fullText = document.getText();
  //               const parsed = JSON.parse(fullText);
  //               const tabSize = options.tabSize || 2;
  //               const formatted = JSON.stringify(parsed, null, tabSize);

  //               const fullRange = new vscode.Range(
  //                 document.positionAt(0),
  //                 document.positionAt(fullText.length)
  //               );

  //               return [vscode.TextEdit.replace(fullRange, formatted)];
  //             } catch (fullError) {
  //               console.error('JSON 范围格式化失败:', fullError);
  //               return [];
  //             }
  //           }
  //         }
  //       }
  //     );

  //     // 为 plaintext 也注册一个格式化提供者（防止报错）
  //     const plaintextDisposable = vscode.languages.registerDocumentFormattingEditProvider(
  //       { scheme: '*', language: 'plaintext' },
  //       {
  //         provideDocumentFormattingEdits(document, options, token) {
  //           // 尝试作为 JSON 格式化
  //           try {
  //             const text = document.getText();
  //             const parsed = JSON.parse(text);
  //             const tabSize = options.tabSize || 2;
  //             const formatted = JSON.stringify(parsed, null, tabSize);

  //             const fullRange = new vscode.Range(
  //               document.positionAt(0),
  //               document.positionAt(text.length)
  //             );

  //             return [vscode.TextEdit.replace(fullRange, formatted)];
  //           } catch (error) {
  //             // 不是有效的 JSON，返回空数组
  //             return [];
  //           }
  //         }
  //       }
  //     );

  //     // 标记已注册，避免重复注册
  //     MonacoEditorComponent.jsonFormatterRegistered = true;
  //     console.log('✓ 格式化提供者已注册（JSON 和 plaintext，使用 VSCode API，支持快捷键 Shift+Alt+F）');
  //   } catch (error) {
  //     console.error('注册格式化提供者失败:', error);
  //   }
  // }

  /**
   * 设置剪贴板支持（Electron环境）
   */
  private async setupClipboardSupport(): Promise<void> {
    if (!this.editorInstance) return;

    // 检查是否在 Electron 环境中
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI || !electronAPI.clipboard) {
      // console.log('Not in Electron environment or clipboard API not available');
      return;
    }

    // 检查命令是否已经注册过,避免重复注册
    if (MonacoEditorComponent.clipboardCommandsRegistered) {
      // console.log('Clipboard commands already registered, skipping');
      return;
    }

    try {
      // 使用 VSCode API 注册剪贴板命令处理器
      const { commands } = await import('vscode');

      // 注册复制命令
      commands.registerCommand('editor.action.clipboardCopyAction', async () => {
        const selection = this.editorInstance?.getSelection();
        if (selection && this.editorInstance) {
          const model = this.editorInstance.getModel();
          if (model && !selection.isEmpty()) {
            const text = model.getValueInRange(selection);
            if (text) {
              await electronAPI.clipboard.writeText(text);
              // 同时也写入 navigator.clipboard 作为备用
              if (navigator.clipboard) {
                try {
                  await navigator.clipboard.writeText(text);
                } catch (e) {
                  // 忽略 navigator.clipboard 错误
                }
              }
              // console.log('✓ Text copied to clipboard');
            }
          }
        }
      });

      // 注册剪切命令
      commands.registerCommand('editor.action.clipboardCutAction', async () => {
        const selection = this.editorInstance?.getSelection();
        if (selection && this.editorInstance) {
          const model = this.editorInstance.getModel();
          if (model && !selection.isEmpty()) {
            const text = model.getValueInRange(selection);
            if (text) {
              await electronAPI.clipboard.writeText(text);
              // 同时也写入 navigator.clipboard 作为备用
              if (navigator.clipboard) {
                try {
                  await navigator.clipboard.writeText(text);
                } catch (e) {
                  // 忽略 navigator.clipboard 错误
                }
              }
              // 删除选中的文本
              this.editorInstance.executeEdits('cut', [{
                range: selection,
                text: ''
              }]);
              // console.log('✓ Text cut to clipboard');
            }
          }
        }
      });

      // 注册粘贴命令
      commands.registerCommand('editor.action.clipboardPasteAction', async () => {
        try {
          let text = await electronAPI.clipboard.readText();
          // 如果 Electron clipboard 为空，尝试使用 navigator.clipboard
          if (!text && navigator.clipboard) {
            try {
              text = await navigator.clipboard.readText();
            } catch (e) {
              // 忽略错误
            }
          }

          if (text && this.editorInstance) {
            const selection = this.editorInstance.getSelection();
            if (selection) {
              this.editorInstance.executeEdits('paste', [{
                range: selection,
                text: text
              }]);
              // 将光标移动到粘贴文本的末尾
              const lines = text.split('\n');
              const lastLine = lines[lines.length - 1];
              const newPosition = {
                lineNumber: selection.startLineNumber + lines.length - 1,
                column: lines.length === 1 ? selection.startColumn + lastLine.length : lastLine.length + 1
              };
              this.editorInstance.setPosition(newPosition);
              // console.log('✓ Text pasted from clipboard');
            }
          }
        } catch (error) {
          console.error('Failed to paste from clipboard:', error);
        }
      });

      // 标记命令已注册
      MonacoEditorComponent.clipboardCommandsRegistered = true;
      console.log('✓ Clipboard commands registered for Monaco editor');
    } catch (error) {
      console.error('Failed to setup clipboard support:', error);
    }
  }

  /**
   * 覆盖 Monaco 编辑器的剪贴板 actions
   */
  private overrideClipboardActions(): void {
    if (!this.editorInstance) return;

    const electronAPI = (window as any).electronAPI;
    if (!electronAPI || !electronAPI.clipboard) {
      return;
    }

    try {
      // 添加键盘快捷键
      this.editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC, async () => {
        const selection = this.editorInstance?.getSelection();
        if (selection && this.editorInstance) {
          const model = this.editorInstance.getModel();
          if (model && !selection.isEmpty()) {
            const text = model.getValueInRange(selection);
            if (text) {
              await electronAPI.clipboard.writeText(text);
              // console.log('✓ Copied (Ctrl+C)');
            }
          }
        }
      });

      this.editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyX, async () => {
        const selection = this.editorInstance?.getSelection();
        if (selection && this.editorInstance) {
          const model = this.editorInstance.getModel();
          if (model && !selection.isEmpty()) {
            const text = model.getValueInRange(selection);
            if (text) {
              await electronAPI.clipboard.writeText(text);
              this.editorInstance.executeEdits('cut', [{
                range: selection,
                text: ''
              }]);
              console.log('✓ Cut (Ctrl+X)');
            }
          }
        }
      });

      this.editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, async () => {
        try {
          const text = await electronAPI.clipboard.readText();
          if (text && this.editorInstance) {
            const selection = this.editorInstance.getSelection();
            if (selection) {
              this.editorInstance.executeEdits('paste', [{
                range: selection,
                text: text
              }]);
              const lines = text.split('\n');
              const lastLine = lines[lines.length - 1];
              const newPosition = {
                lineNumber: selection.startLineNumber + lines.length - 1,
                column: lines.length === 1 ? selection.startColumn + lastLine.length : lastLine.length + 1
              };
              this.editorInstance.setPosition(newPosition);
              // console.log('✓ Pasted (Ctrl+V)');
            }
          }
        } catch (error) {
          console.error('Failed to paste:', error);
        }
      });

      // console.log('✓ Clipboard keyboard shortcuts registered');
    } catch (error) {
      console.error('Failed to override clipboard actions:', error);
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
