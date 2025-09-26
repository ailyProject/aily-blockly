import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, SimpleChanges, ViewChild, ElementRef, OnInit, AfterViewInit, OnDestroy, OnChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzMessageService } from 'ng-zorro-antd/message';
import { VsixService } from '../../services/vsix.service';

import * as monaco from 'monaco-editor';
import * as vscode from 'vscode'
import 'vscode/localExtensionHost'
import { initialize } from '@codingame/monaco-vscode-api'
import getBaseServiceOverride from '@codingame/monaco-vscode-base-service-override'
import getExtensionsServiceOverride from '@codingame/monaco-vscode-extensions-service-override'

// 常量定义
const MONACO_CONFIG = {
  TIMEOUTS: {
    EDITOR_INIT_DELAY: 100,
    CLANGD_VERIFY_DELAY: 2000,
    COMPLETION_TEST_DELAY: 2000,
    MANUAL_VERIFY_DELAY: 500,
    RETRY_DELAY: 3000
  },
  API_CHECK: {
    MAX_WAIT_TIME: 10000,
    CHECK_INTERVAL: 200,
    LOG_THRESHOLD: 2000
  },
  VIEW_STATE_RESTORE: {
    MAX_ATTEMPTS: 20,
    RETRY_INTERVAL: 50
  }
} as const;



// 类型定义
interface ExtensionManifest {
  name?: string;
  displayName?: string;
  publisher?: string;
  version?: string;
  contributes?: {
    languages?: Array<{ id: string; }>;
    grammars?: Array<{ language: string; }>;
    themes?: Array<{ label: string; }>;
    commands?: Array<{ command: string; title?: string; }>;
  };
}

interface ExtensionData {
  manifest: ExtensionManifest;
}

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
  private static isVSCodeAPIReady = false; // 添加API就绪标志
  private static globalDisposables: monaco.IDisposable[] = []; // 全局资源清理
  private timeoutIds: number[] = []; // 追踪所有timeout ID

  /**
   * 初始化 Monaco VSCode API（使用示例代码的方式）
   */
  static async initializeMonacoVSCodeAPI(): Promise<void> {
    // 检查是否已经初始化过
    if (window.__MONACO_VSCODE_API_INITIALIZED__) {
      console.log('✅ Monaco VSCode API 已经初始化过，跳过重复初始化');
      // 确保内部标志也是正确的
      MonacoEditorComponent.isMonacoInitialized = true;
      return;
    }

    // 检查是否正在初始化中
    if (window.__MONACO_VSCODE_API_INITIALIZING__) {
      console.log('🔄 Monaco VSCode API 正在初始化中，等待完成...');
      await window.__MONACO_VSCODE_API_INITIALIZING__;
      return;
    }

    // 设置初始化进行中的标志
    const initPromise = (async (): Promise<void> => {
      try {
        console.log('🚀 开始初始化 Monaco VSCode API...');

        // 首先调用 monaco-vscode-api 的 initialize() 来初始化服务
        // console.log('🔄 调用 initialize() 初始化 monaco-vscode-api 服务...');
        await initialize({
          // 添加必要的服务覆盖
          ...getBaseServiceOverride(), // 基本服务，包含必要的核心功能
          ...getExtensionsServiceOverride(), // 扩展服务，支持VSCode扩展
        });
        console.log('✅ monaco-vscode-api 服务初始化完成');

        // 等待VSCode API准备就绪（优化后的方法）
        await MonacoEditorComponent.waitForVSCodeAPIReady();

        console.log('✅ LocalExtensionHost已导入，API应该可用');

        // 检查VSCode API是否可用
        if (typeof vscode !== 'undefined') {
          console.log('✅ VSCode API 模块已加载');
          const availableApis = Object.keys(vscode).filter(key => typeof vscode[key] === 'object');
          console.log('✅ 可用的API:', availableApis);

          // 检查关键的语言服务API
          if (vscode.languages && typeof vscode.languages.registerCompletionItemProvider === 'function') {
            console.log('✅ vscode.languages API 可用');
            const languageMethods = Object.keys(vscode.languages).filter(key => typeof vscode.languages[key] === 'function');
            console.log('✅ 语言API方法:', languageMethods.slice(0, 5), '...'); // 只显示前5个，避免日志过多
          } else {
            console.warn('⚠️ vscode.languages API 不可用');
          }

          if (vscode.commands && typeof vscode.commands.registerCommand === 'function') {
            console.log('✅ vscode.commands API 可用');
          } else {
            console.warn('⚠️ vscode.commands API 不可用');
          }
        } else {
          console.error('❌ VSCode API 模块未加载');
        }

        // 设置全局初始化标志
        window.__MONACO_VSCODE_API_INITIALIZED__ = true;
        MonacoEditorComponent.isMonacoInitialized = true;

        console.log('✅ Monaco VSCode API 初始化成功完成');

      } catch (error: any) {
        console.error('❌ Monaco VSCode API 初始化失败:', error);

        // 检查是否是版本冲突错误
        if (error?.message?.includes('Another version of monaco-vscode-api has already been loaded')) {
          console.warn('⚠️ 检测到 monaco-vscode-api 版本冲突，尝试使用现有初始化...');
          // 如果是版本冲突，仍然设置为已初始化状态，避免重复尝试
          window.__MONACO_VSCODE_API_INITIALIZED__ = true;
          MonacoEditorComponent.isMonacoInitialized = true;
          return;
        }

        throw error;
      } finally {
        // 清理初始化进行中的标志
        window.__MONACO_VSCODE_API_INITIALIZING__ = undefined;
      }
    })();

    // 设置当前的初始化 Promise
    window.__MONACO_VSCODE_API_INITIALIZING__ = initPromise;

    // 等待初始化完成
    await initPromise;
  }  /**
   * 等待VSCode API完全准备就绪
   */
  static async waitForVSCodeAPIReady(): Promise<void> {
    // 如果已经确认API准备就绪，直接返回
    if (MonacoEditorComponent.isVSCodeAPIReady) {
      return;
    }

    const maxWaitTime = 10000; // 最大等待10秒
    const checkInterval = 200; // 每200ms检查一次，提高响应性
    let waitedTime = 0;

    return new Promise((resolve, reject) => {
      const checkReady = () => {
        try {
          // 检查VSCode API是否完全准备就绪
          if (typeof vscode !== 'undefined' &&
            vscode.languages &&
            vscode.commands &&
            typeof vscode.languages.registerCompletionItemProvider === 'function' &&
            typeof vscode.commands.registerCommand === 'function') {

            // 额外检查：尝试调用一个简单的API来确保服务真正可用
            try {
              // 检查服务是否真正初始化
              const testDisposable = vscode.commands.registerCommand('test.api.ready', () => { });
              testDisposable.dispose(); // 立即清理测试命令

              console.log('✅ VSCode API已完全准备就绪，所有服务可用');
              MonacoEditorComponent.isVSCodeAPIReady = true;
              resolve();
              return;
            } catch (testError) {
              console.log('🔄 VSCode API存在但服务尚未完全初始化...');
            }
          }
        } catch (error) {
          // API还未准备好，继续等待
          console.log('🔄 VSCode API检查失败，继续等待...');
        }

        waitedTime += checkInterval;
        if (waitedTime >= maxWaitTime) {
          console.warn('⚠️ VSCode API准备超时，但仍然继续执行...');
          MonacoEditorComponent.isVSCodeAPIReady = true; // 即使超时也设置标志，避免重复等待
          resolve(); // 即使超时也继续执行，避免阻塞
        } else {
          // 只在前几次检查时输出日志，避免刷屏
          if (waitedTime <= 2000) {
            console.log(`🔄 等待VSCode API准备就绪... (${waitedTime}ms)`);
          }
          setTimeout(checkReady, checkInterval);
        }
      };

      checkReady();
    });
  }

  /**
   * 注册 VSIX 扩展到 Monaco（使用 VSCode API）
   */
  static async registerVsixExtension(extensionData: ExtensionData): Promise<void> {
    try {
      console.log(`Registering VSIX extension: ${extensionData.manifest.name}`);

      // 检查VSCode API是否准备就绪
      if (typeof vscode === 'undefined') {
        console.error('❌ VSCode API 未定义，无法注册扩展');
        return;
      }

      // 只在API未准备就绪时才等待
      if (!MonacoEditorComponent.isVSCodeAPIReady) {
        await MonacoEditorComponent.waitForVSCodeAPIReady();
      }

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

      // 处理命令 - 添加安全检查和更好的错误处理
      if (manifest.contributes?.commands && vscode.commands) {
        console.log(`🔄 开始注册 ${manifest.contributes.commands.length} 个命令...`);
        for (const command of manifest.contributes.commands) {
          try {
            console.log(`Registering command: ${command.command}`);

            // 检查命令是否已经注册，避免重复注册
            const existingCommands = await vscode.commands.getCommands();
            if (existingCommands.includes(command.command)) {
              console.log(`⚠️ 命令 ${command.command} 已存在，跳过注册`);
              continue;
            }

            // 使用 VSCode API 注册命令
            const disposable = vscode.commands.registerCommand(command.command, (...args: any[]) => {
              console.log(`Executing command: ${command.command}`, args);
              // 这里可以添加命令的具体实现
              // 例如：处理 clangd 的 inlayHints.toggle 命令
              if (command.command === 'clangd.inlayHints.toggle') {
                console.log('执行 clangd inlay hints 切换命令');
                // 添加具体的 inlay hints 切换逻辑
              }
            });

            console.log(`✅ 成功注册命令: ${command.command}`);

            // 保存 disposable 以便后续清理，防止内存泄漏
            MonacoEditorComponent.globalDisposables.push(disposable);

          } catch (commandError) {
            console.error(`❌ Failed to register command ${command.command}:`, commandError);
            // 检查是否是 "Default api is not ready yet" 错误
            if (commandError.message && commandError.message.includes('Default api is not ready yet')) {
              console.error('💡 提示：VSCode API 服务尚未完全初始化');
              console.log('🔄 尝试延迟重试注册命令...');

              // 延迟重试一次
              const retryTimeoutId = setTimeout(async () => {
                try {
                  console.log(`🔄 重试注册命令: ${command.command}`);
                  const retryDisposable = vscode.commands.registerCommand(command.command, (...args: any[]) => {
                    console.log(`Executing command (retry): ${command.command}`, args);
                    if (command.command === 'clangd.inlayHints.toggle') {
                      console.log('执行 clangd inlay hints 切换命令');
                    }
                  });
                  MonacoEditorComponent.globalDisposables.push(retryDisposable);
                  console.log(`✅ 重试成功注册命令: ${command.command}`);
                } catch (retryError) {
                  console.error(`❌ 重试失败: ${command.command}`, retryError);
                }
              }, 3000); // 3秒后重试
              // 注意：这里是静态方法，无法访问实例属性，所以不能直接保存timeout ID
            }
          }
        }
        console.log(`✅ 命令注册完成`);
      } else {
        if (!manifest.contributes?.commands) {
          console.log('📝 该扩展没有定义命令');
        } else if (!vscode.commands) {
          console.error('❌ vscode.commands API 不可用');
        }
      }

      // 处理补全提供者等 - 添加安全检查
      if (manifest.contributes?.languages && vscode.languages) {
        for (const language of manifest.contributes.languages) {
          try {
            // 示例：注册补全提供者
            const completionDisposable = vscode.languages.registerCompletionItemProvider(language.id, {
              provideCompletionItems: (document: any, position: any) => {
                console.log(`Providing completions for ${language.id} at position:`, position);
                // 返回补全项
                return [];
              }
            });
            // 保存disposable以便清理
            MonacoEditorComponent.globalDisposables.push(completionDisposable);
            console.log(`✅ 成功为语言 ${language.id} 注册补全提供者`);
          } catch (providerError) {
            console.warn(`Failed to register completion provider for ${language.id}:`, providerError);
          }
        }
      }

      console.log(`Successfully processed extension: ${extensionData.manifest.name}`);
    } catch (error) {
      console.error('Failed to register VSIX extension:', error);
      // 不再抛出错误，而是记录并继续
    }
  }

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

  /** 需要清理的资源列表 */
  private disposables: monaco.IDisposable[] = [];

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
    try {
      // 确保 Monaco VSCode API 已初始化
      await MonacoEditorComponent.initializeMonacoVSCodeAPI();
    } catch (error) {
      console.error('初始化Monaco VSCode API失败:', error);
      this.message.error('编辑器初始化失败，可能会影响某些功能');
      // 不阻断组件初始化，允许基本功能继续工作
    }
  }

  async ngAfterViewInit(): Promise<void> {
    try {
      // 等待DOM完全渲染后初始化编辑器
      const timeoutId = setTimeout(async () => {
        try {
          await this.initializeMonacoEditor();
        } catch (error) {
          console.error('初始化Monaco编辑器失败:', error);
          this.message.error('编辑器初始化失败，请刷新页面重试');
        }
      }, 100) as unknown as number;
      this.timeoutIds.push(timeoutId);
    } catch (error) {
      console.error('ngAfterViewInit失败:', error);
      this.message.error('组件初始化失败');
    }
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
    // 清理实例级别的disposables
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];

    // 清理所有timeout
    this.timeoutIds.forEach(id => clearTimeout(id));
    this.timeoutIds = [];

    // 清理编辑器实例
    if (this.editorInstance) {
      this.editorInstance.dispose();
      this.editorInstance = null;
    }
  }

  onCodeChange(newCode: string): void {
    this.codeChange.emit(newCode);
  }

  /**
   * 初始化 Monaco Editor
   */
  private async initializeMonacoEditor(): Promise<void> {
    try {
      console.log('Initializing Monaco Editor...');

      // 创建编辑器实例时禁用可能触发WebWorker的功能
      this.editorInstance = monaco.editor.create(this.monacoContainer.nativeElement, {
        value: this.code,
        language: 'cpp',
        theme: 'vs-dark',
        lineNumbers: 'on',
        ...this.options
      });

      // 监听内容变化
      const onDidChangeContent = this.editorInstance.onDidChangeModelContent(() => {
        const value = this.editorInstance?.getValue() || '';
        this.onCodeChange(value);
      });
      this.disposables.push(onDidChangeContent);

      // 编辑器初始化完成后的设置
      this.editorInitialized(this.editorInstance);

      console.log('Monaco Editor initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Monaco Editor:', error);
    }
  }

  editorInitialized(editor: monaco.editor.IStandaloneCodeEditor): void {
    this.editorInstance = editor;

    // 在编辑器初始化后设置Tab键处理
    if (editor) {
      // 添加自定义右键菜单项
      this.setupContextMenu(editor);

      // 配置 VSIX 扩展支持
      this.setupVsixExtensions(editor);
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
   * 设置 VSIX 扩展支持
   * @param editor Monaco编辑器实例
   */
  private async setupVsixExtensions(editor: monaco.editor.IStandaloneCodeEditor): Promise<void> {
    try {
      console.log('📝 [Monaco] 正在为Moanco编辑器设置VSIX扩展...');

      // 首先确保VSCode API已初始化
      if (!MonacoEditorComponent.isMonacoInitialized) {
        console.log('📝 [Monaco] VSCode API未初始化，先进行初始化...');
        await MonacoEditorComponent.initializeMonacoVSCodeAPI();
      }

      // 再次等待API准备就绪
      console.log('📝 [Monaco] 等待VSCode API准备就绪...');
      await MonacoEditorComponent.waitForVSCodeAPIReady();

      // 额外的安全等待时间，确保所有服务完全初始化
      console.log('📝 [Monaco] 等待额外的服务初始化时间...');
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 首先初始化所有可用的扩展
      await this.vsixService.initializeAllExtensions();

      // 获取所有已加载的扩展
      const loadedExtensions = this.vsixService.getLoadedExtensions();
      console.log(`✅ [Monaco] 找到 ${loadedExtensions.length} 个已加载的扩展`);

      // 使用新的扩展注册方式
      for (const extensionData of loadedExtensions) {
        try {
          console.log(`📝 [Monaco] 尝试注册扩展: ${extensionData.manifest.name}`);
          await MonacoEditorComponent.registerVsixExtension(extensionData);
          console.log(`✅ [Monaco] 成功注册扩展: ${extensionData.manifest.name}`);
        } catch (error) {
          console.error(`❌ [Monaco] 注册扩展失败 ${extensionData.manifest.name}:`, error);
          // 继续处理其他扩展，不中断流程
        }
      }

      // 延迟验证clangd扩展，给API更多时间准备
      const timeoutId = setTimeout(async () => {
        await this.verifyClangdExtension();
      }, MONACO_CONFIG.TIMEOUTS.CLANGD_VERIFY_DELAY) as unknown as number;
      this.timeoutIds.push(timeoutId);

      console.log('✅ [Monaco] VSIX扩展设置完成');
    } catch (error) {
      console.error('❌ [Monaco] 设置VSIX扩展失败:', error);
      // 不抛出错误，允许编辑器继续正常工作
    }
  }

  /**
   * 验证clangd扩展是否生效
   */
  private async verifyClangdExtension(): Promise<boolean> {
    console.log('=== 开始检验clangd扩展是否生效 ===');

    try {
      // 1. 检查扩展是否已加载
      const loadedExtensions = this.vsixService.getLoadedExtensions();
      const clangdExtension = loadedExtensions.find(ext =>
        ext.manifest.name?.toLowerCase().includes('clangd') ||
        ext.manifest.displayName?.toLowerCase().includes('clangd') ||
        ext.manifest.publisher?.toLowerCase().includes('clangd')
      );

      if (!clangdExtension) {
        console.error('❌ clangd扩展未找到在已加载的扩展中');
        console.log('已加载的扩展:', loadedExtensions.map(ext => ext.manifest.name));
        return false;
      }

      console.log('✅ clangd扩展已加载:', {
        name: clangdExtension.manifest.name,
        version: clangdExtension.manifest.version,
        publisher: clangdExtension.manifest.publisher
      });

      // 2. 检查语言支持
      const languages = clangdExtension.manifest.contributes?.languages;
      if (languages && languages.length > 0) {
        console.log('✅ 支持的语言:', languages.map(l => l.id));
      } else {
        console.warn('⚠️ 未发现语言支持定义');
      }

      // 3. 检查命令注册
      const commands = clangdExtension.manifest.contributes?.commands;
      if (commands && commands.length > 0) {
        console.log('✅ 注册的命令:', commands.map(c => c.command));
      } else {
        console.warn('⚠️ 未发现命令定义');
      }

      // 4. 检查VSCode API中的语言服务（安全检查）
      try {
        if (typeof vscode !== 'undefined' && vscode.languages) {
          console.log('✅ VSCode API语言服务可用');

          // 测试是否可以获取当前编辑器的语言
          if (this.editorInstance) {
            const model = this.editorInstance.getModel();
            if (model) {
              const languageId = model.getLanguageId();
              console.log('✅ 当前编辑器语言ID:', languageId);

              // 检查是否为C++相关语言
              if (['cpp', 'c', 'objective-c', 'objective-cpp'].includes(languageId)) {
                console.log('✅ 当前正在编辑C++相关文件，clangd应该可以提供支持');

                // 尝试触发补全测试
                this.testCompletionProvider();
              }
            }
          }
        } else {
          console.warn('⚠️ VSCode API不可用，稍后重试...');
          // 等待一段时间后重试
          const timeoutId = setTimeout(() => this.verifyClangdExtension(), 3000) as unknown as number;
          this.timeoutIds.push(timeoutId);
          return false;
        }
      } catch (apiError) {
        console.warn('⚠️ 检查VSCode API时出错:', apiError);
      }

      // 5. 检查Monaco编辑器的语言注册情况
      if (this.monacoInstance && this.monacoInstance.languages) {
        const registeredLanguages = this.monacoInstance.languages.getLanguages();
        const cppLanguages = registeredLanguages.filter(lang =>
          ['cpp', 'c'].includes(lang.id)
        );
        console.log('✅ Monaco中注册的C++相关语言:', cppLanguages.map(l => l.id));
      }

      console.log('=== clangd扩展检验完成 ===');
      return true;

    } catch (error) {
      console.error('❌ 检验clangd扩展时出错:', error);
      return false;
    }
  }

  /**
   * 测试补全提供器是否工作
   */
  private testCompletionProvider(): void {
    if (!this.editorInstance || !this.monacoInstance) return;

    const timeoutId = setTimeout(() => {
      try {
        const model = this.editorInstance.getModel();
        const position = this.editorInstance.getPosition();

        if (model && position) {
          // 尝试触发补全
          this.editorInstance.trigger('keyboard', 'editor.action.triggerSuggest', {});
          console.log('📝 已尝试触发代码补全，请检查是否有补全建议出现');
        }
      } catch (error) {
        console.warn('测试补全提供器时出错:', error);
      }
    }, 2000) as unknown as number;
    this.timeoutIds.push(timeoutId);
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

  /**
   * 手动检验clangd插件功能 - 可通过组件方法调用
   */
  public async manualVerifyClangd(): Promise<void> {
    console.log('🔍 手动检验clangd插件功能...');

    // 1. 设置测试C++代码
    const testCode = `#include <iostream>
#include <vector>
#include <string>

class TestClass {
public:
    void testMethod() {
        std::vector<int> vec;
        vec.push_back(42);
        vec. // 在这里应该有补全提示
        
        std::string str = "hello";
        str. // 在这里也应该有补全提示
    }
};

int main() {
    TestClass test;
    test. // 测试自定义类的补全
    return 0;
}`;

    // 2. 设置编辑器内容为C++代码
    if (this.editorInstance) {
      this.editorInstance.setValue(testCode);

      // 3. 设置光标到补全测试位置
      const timeoutId = setTimeout(() => {
        const model = this.editorInstance.getModel();
        if (model) {
          // 设置光标到 vec. 后面
          const position = { lineNumber: 9, column: 13 };
          this.editorInstance.setPosition(position);
          this.editorInstance.focus();

          console.log('📍 已设置测试代码和光标位置');
          console.log('💡 请尝试以下操作来验证clangd功能：');
          console.log('1. 在 vec. 后按 Ctrl+Space 触发补全');
          console.log('2. 在 str. 后按 Ctrl+Space 触发补全');
          console.log('3. 在 test. 后按 Ctrl+Space 触发补全');
          console.log('4. 悬停在变量上查看类型信息');
          console.log('5. 右键查看上下文菜单选项');
        }
      }, 500) as unknown as number;
      this.timeoutIds.push(timeoutId);
    }
  }

  /**
   * 检查Monaco编辑器的语言服务提供者
   */
  public checkLanguageProviders(): void {
    if (!this.monacoInstance) {
      console.error('Monaco实例不可用');
      return;
    }

    console.log('🔍 检查语言服务提供者...');

    const languages = ['cpp', 'c', 'objective-c', 'objective-cpp'];

    languages.forEach(langId => {
      try {
        // 检查语言是否已注册
        const registeredLanguages = this.monacoInstance.languages.getLanguages();
        const langExists = registeredLanguages.some(lang => lang.id === langId);
        console.log(`${langId} 语言注册状态:`, langExists ? '✅ 已注册' : '❌ 未注册');

        if (langExists) {
          console.log(`${langId} 语言支持可用`);
        }

      } catch (error) {
        console.warn(`检查 ${langId} 语言服务时出错:`, error);
      }
    });

    // 显示所有已注册的语言
    const allLanguages = this.monacoInstance.languages.getLanguages();
    console.log('所有已注册的语言:', allLanguages.map(lang => lang.id));
  }

  /**
   * 检查当前VSCode API状态
   */
  public checkVSCodeAPIStatus(): void {
    console.log('\n🔍 === VSCode API状态检查 ===');

    if (typeof vscode === 'undefined') {
      console.error('❌ VSCode API 未定义');
      console.log('💡 建议：确保已正确导入 @codingame/monaco-vscode-extension-api');
      return;
    }

    console.log('✅ VSCode API 已定义');

    // 检查各个API模块
    const apiChecks = [
      { name: 'languages', api: vscode.languages },
      { name: 'commands', api: vscode.commands },
      { name: 'workspace', api: vscode.workspace },
      { name: 'window', api: vscode.window }
    ];

    apiChecks.forEach(check => {
      if (check.api) {
        console.log(`✅ vscode.${check.name} 可用`);
        if (check.name === 'languages') {
          console.log('   - 方法:', Object.keys(check.api).filter(key => typeof check.api[key] === 'function'));
        }
      } else {
        console.error(`❌ vscode.${check.name} 不可用`);
      }
    });

    // 测试languages API的关键方法
    if (vscode.languages) {
      try {
        const testResult = vscode.languages.registerCompletionItemProvider;
        console.log('✅ registerCompletionItemProvider 方法可用:', typeof testResult);
      } catch (error) {
        console.error('❌ 无法访问 registerCompletionItemProvider:', error);
      }
    }

    console.log('=== VSCode API检查完成 ===\n');
  }

  /**
   * 强制重新初始化VSCode API和扩展
   */
  public async forceReinitialize(): Promise<void> {
    console.log('🔄 强制重新初始化VSCode API和扩展...');

    // 重置所有初始化标志（包括全局的）
    MonacoEditorComponent.isMonacoInitialized = false;
    MonacoEditorComponent.isVSCodeAPIReady = false;
    window.__MONACO_VSCODE_API_INITIALIZED__ = false;
    window.__MONACO_VSCODE_API_INITIALIZING__ = undefined;

    try {
      // 重新初始化VSCode API
      await MonacoEditorComponent.initializeMonacoVSCodeAPI();

      // 重新设置扩展
      if (this.editorInstance) {
        await this.setupVsixExtensions(this.editorInstance);
      }

      console.log('✅ 强制重新初始化完成');
    } catch (error) {
      console.error('❌ 强制重新初始化失败:', error);
      // 如果是版本冲突错误，提供友好的提示
      if (error.message && error.message.includes('Another version of monaco-vscode-api has already been loaded')) {
        console.warn('💡 提示：检测到版本冲突。建议重新安装依赖或重启应用程序。');
      }
    }
  }

}