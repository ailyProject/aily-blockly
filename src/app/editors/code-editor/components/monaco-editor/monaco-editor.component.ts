import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, SimpleChanges, ViewChild, OnInit, AfterViewInit, OnDestroy, OnChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzCodeEditorModule, NzCodeEditorComponent } from 'ng-zorro-antd/code-editor';
import { NzMessageService } from 'ng-zorro-antd/message';
import { VsixService } from '../../services/vsix.service';
import { ClangdTester } from '../../utils/clangd-tester';

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
  private static isVSCodeAPIReady = false; // 添加API就绪标志

  /**
   * 初始化 Monaco VSCode API（使用示例代码的方式）
   */
  static async initializeMonacoVSCodeAPI(): Promise<void> {
    if (MonacoEditorComponent.isMonacoInitialized) {
      return;
    }

    try {
      console.log('Initializing Monaco VSCode API with localExtensionHost...');
      
      // 使用正确的monaco-vscode-api初始化方式
      // 首先确保导入了必要的模块
      await import('@codingame/monaco-vscode-extension-api/localExtensionHost');
      
      // 等待一小段时间让API初始化
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 等待VSCode API准备就绪
      await MonacoEditorComponent.waitForVSCodeAPIReady();
      
      console.log('✅ LocalExtensionHost已导入，API应该可用');
      
      // 检查VSCode API是否可用
      if (typeof vscode !== 'undefined') {
        console.log('✅ VSCode API 模块已加载');
        console.log('✅ 可用的API:', Object.keys(vscode));
        
        // 检查关键的语言服务API
        if (vscode.languages) {
          console.log('✅ vscode.languages API 可用');
          console.log('✅ 语言API方法:', Object.keys(vscode.languages));
        } else {
          console.warn('⚠️ vscode.languages API 不可用');
        }
        
        if (vscode.commands) {
          console.log('✅ vscode.commands API 可用');
        } else {
          console.warn('⚠️ vscode.commands API 不可用');
        }
      } else {
        console.error('❌ VSCode API 模块未加载');
      }
      
      MonacoEditorComponent.isMonacoInitialized = true;
      console.log('Monaco VSCode API initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Monaco VSCode API:', error);
      throw error;
    }
  }

  /**
   * 等待VSCode API完全准备就绪
   */
  static async waitForVSCodeAPIReady(): Promise<void> {
    // 如果已经确认API准备就绪，直接返回
    if (MonacoEditorComponent.isVSCodeAPIReady) {
      return;
    }

    const maxWaitTime = 10000; // 最大等待10秒
    const checkInterval = 500; // 每500ms检查一次
    let waitedTime = 0;

    return new Promise((resolve, reject) => {
      const checkReady = () => {
        try {
          // 尝试访问vscode.languages来检查API是否准备就绪
          if (typeof vscode !== 'undefined' && 
              vscode.languages && 
              typeof vscode.languages.registerCompletionItemProvider === 'function') {
            console.log('✅ VSCode API已准备就绪');
            MonacoEditorComponent.isVSCodeAPIReady = true; // 设置标志
            resolve();
            return;
          }
        } catch (error) {
          // API还未准备好，继续等待
        }

        waitedTime += checkInterval;
        if (waitedTime >= maxWaitTime) {
          console.warn('⚠️ VSCode API准备超时，继续执行...');
          MonacoEditorComponent.isVSCodeAPIReady = true; // 即使超时也设置标志，避免重复等待
          resolve(); // 即使超时也继续执行，避免阻塞
        } else {
          // 只在前几次检查时输出日志，避免刷屏
          if (waitedTime <= 1500) {
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
  static async registerVsixExtension(extensionData: any): Promise<void> {
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

      // 处理命令 - 添加安全检查
      if (manifest.contributes?.commands && vscode.commands) {
        for (const command of manifest.contributes.commands) {
          try {
            console.log(`Registering command: ${command.command}`);
            // 使用 VSCode API 注册命令
            vscode.commands.registerCommand(command.command, (...args: any[]) => {
              console.log(`Executing command: ${command.command}`, args);
              // 这里可以添加命令的具体实现
            });
          } catch (commandError) {
            console.warn(`Failed to register command ${command.command}:`, commandError);
          }
        }
      }

      // 处理补全提供者等 - 添加安全检查
      if (manifest.contributes?.languages && vscode.languages) {
        for (const language of manifest.contributes.languages) {
          try {
            // 示例：注册补全提供者
            vscode.languages.registerCompletionItemProvider(language.id, {
              provideCompletionItems: (document: any, position: any) => {
                console.log(`Providing completions for ${language.id} at position:`, position);
                // 返回补全项
                return [];
              }
            });
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

      // 首先确保VSCode API已初始化
      if (!MonacoEditorComponent.isMonacoInitialized) {
        console.log('VSCode API未初始化，先进行初始化...');
        await MonacoEditorComponent.initializeMonacoVSCodeAPI();
      }

      // 再次等待API准备就绪
      console.log('等待VSCode API准备就绪...');
      await MonacoEditorComponent.waitForVSCodeAPIReady();

      // 首先初始化所有可用的扩展
      await this.vsixService.initializeAllExtensions();

      // 获取所有已加载的扩展
      const loadedExtensions = this.vsixService.getLoadedExtensions();
      console.log(`Found ${loadedExtensions.length} loaded extensions`);

      // 使用新的扩展注册方式
      for (const extensionData of loadedExtensions) {
        try {
          console.log(`尝试注册扩展: ${extensionData.manifest.name}`);
          await MonacoEditorComponent.registerVsixExtension(extensionData);
          console.log(`Successfully registered extension: ${extensionData.manifest.name}`);
        } catch (error) {
          console.error(`Failed to register extension ${extensionData.manifest.name}:`, error);
          // 继续处理其他扩展，不中断流程
        }
      }

      // 延迟验证clangd扩展，给API更多时间准备
      setTimeout(async () => {
        await this.verifyClangdExtension();
      }, 2000);

      console.log('VSIX extensions setup completed for Monaco editor');
    } catch (error) {
      console.error('Failed to setup VSIX extensions:', error);
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
          setTimeout(() => this.verifyClangdExtension(), 3000);
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
    
    setTimeout(() => {
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
    }, 2000);
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
      setTimeout(() => {
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
      }, 500);
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
        // 检查补全提供者
        const hasCompletion = this.monacoInstance.languages.getCompletionItemProviders?.(langId);
        console.log(`${langId} 补全提供者:`, hasCompletion ? '✅ 已注册' : '❌ 未注册');
        
        // 检查悬停提供者
        const hasHover = this.monacoInstance.languages.getHoverProviders?.(langId);
        console.log(`${langId} 悬停提供者:`, hasHover ? '✅ 已注册' : '❌ 未注册');
        
        // 检查语言配置
        const langConfig = this.monacoInstance.languages.getLanguageConfiguration?.(langId);
        console.log(`${langId} 语言配置:`, langConfig ? '✅ 已配置' : '❌ 未配置');
        
      } catch (error) {
        console.warn(`检查 ${langId} 语言服务时出错:`, error);
      }
    });
  }

  /**
   * 生成完整的clangd状态报告
   */
  public generateClangdReport(): void {
    console.log('\n📊 === 完整的clangd状态报告 ===');
    
    // 使用测试工具生成报告
    ClangdTester.generateReport();
    
    // 检查语言提供者
    this.checkLanguageProviders();
    
    // 如果有编辑器实例，进行实际测试
    if (this.editorInstance) {
      console.log('\n🧪 进行实际编辑器测试...');
      ClangdTester.testCompletion(this.editorInstance);
    }
    
    console.log('\n=== 报告结束 ===\n');
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
    
    // 重置初始化标志
    MonacoEditorComponent.isMonacoInitialized = false;
    MonacoEditorComponent.isVSCodeAPIReady = false; // 重置API准备标志
    
    try {
      // 重新初始化VSCode API
      await MonacoEditorComponent.initializeMonacoVSCodeAPI();
      
      // 重新设置扩展
      if (this.editorInstance) {
        await this.setupVsixExtensions(this.editorInstance);
      }
      
      console.log('✅ 重新初始化完成');
    } catch (error) {
      console.error('❌ 重新初始化失败:', error);
    }
  }

}