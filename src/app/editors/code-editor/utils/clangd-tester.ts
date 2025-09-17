/**
 * clangd 插件测试工具类
 */
export class ClangdTester {
  
  /**
   * 检查clangd插件是否正确加载
   */
  static checkClangdStatus(): void {
    console.log('🔍 检查clangd插件状态...');
    
    // 1. 检查Monaco实例
    const monaco = (window as any).monaco;
    if (!monaco) {
      console.error('❌ Monaco编辑器未初始化');
      return;
    }
    
    // 2. 检查支持的语言
    const languages = monaco.languages.getLanguages();
    const cppLanguages = languages.filter((lang: any) => 
      ['cpp', 'c', 'objective-c', 'objective-cpp'].includes(lang.id)
    );
    
    console.log('✅ 支持的C++相关语言:', cppLanguages.map((l: any) => l.id));
    
    // 3. 检查语言服务提供者
    cppLanguages.forEach((lang: any) => {
      const providers = {
        completion: monaco.languages.getCompletionItemProviders?.(lang.id),
        hover: monaco.languages.getHoverProviders?.(lang.id),
        definition: monaco.languages.getDefinitionProviders?.(lang.id),
        signature: monaco.languages.getSignatureHelpProviders?.(lang.id)
      };
      
      console.log(`📋 ${lang.id} 语言服务:`, {
        completion: providers.completion ? '✅' : '❌',
        hover: providers.hover ? '✅' : '❌', 
        definition: providers.definition ? '✅' : '❌',
        signature: providers.signature ? '✅' : '❌'
      });
    });
  }
  
  /**
   * 测试代码补全功能
   */
  static async testCompletion(editor: any): Promise<void> {
    if (!editor) {
      console.error('❌ 编辑器实例不可用');
      return;
    }
    
    const model = editor.getModel();
    if (!model) {
      console.error('❌ 编辑器模型不可用');
      return;
    }
    
    console.log('🧪 测试代码补全...');
    
    // 设置测试代码
    const testCode = `#include <vector>
std::vector<int> vec;
vec.`;
    
    model.setValue(testCode);
    
    // 设置光标位置到 vec. 后面
    const position = { lineNumber: 3, column: 5 };
    editor.setPosition(position);
    
    // 尝试触发补全
    try {
      const monaco = (window as any).monaco;
      const completions = await monaco.languages.getCompletionItemProviders('cpp');
      if (completions && completions.length > 0) {
        console.log('✅ 找到补全提供者，数量:', completions.length);
        
        // 手动触发补全
        editor.trigger('test', 'editor.action.triggerSuggest', {});
        console.log('💡 已触发补全建议，请检查编辑器中是否出现补全列表');
      } else {
        console.warn('⚠️ 未找到C++补全提供者');
      }
    } catch (error) {
      console.error('❌ 测试补全时出错:', error);
    }
  }
  
  /**
   * 检查VSCode API状态
   */
  static checkVSCodeAPI(): void {
    console.log('🔍 检查VSCode API状态...');
    
    const vscode = (window as any).vscode;
    if (typeof vscode === 'undefined') {
      console.error('❌ VSCode API 未定义');
      return;
    }
    
    console.log('✅ VSCode API 可用');
    console.log('📋 可用的API模块:', Object.keys(vscode));
    
    // 检查关键API
    const keyAPIs = ['languages', 'commands', 'workspace', 'window'];
    keyAPIs.forEach(api => {
      if (vscode[api]) {
        console.log(`✅ vscode.${api} 可用`);
        if (api === 'languages') {
          console.log('📋 languages API方法:', Object.keys(vscode.languages));
        }
      } else {
        console.warn(`⚠️ vscode.${api} 不可用`);
      }
    });
  }
  
  /**
   * 综合测试报告
   */
  static generateReport(): void {
    console.log('\n📊 === clangd插件状态报告 ===');
    
    this.checkVSCodeAPI();
    console.log('\n');
    this.checkClangdStatus();
    
    console.log('\n💡 测试建议:');
    console.log('1. 在C++文件中输入 std::vector<int> v; v. 然后按Ctrl+Space');
    console.log('2. 悬停在变量名上查看类型信息');
    console.log('3. 右键查看上下文菜单选项');
    console.log('4. 使用F12跳转到定义（如果支持）');
    
    console.log('\n=== 报告结束 ===\n');
  }
}

// 导出到全局作用域以便在控制台中使用
if (typeof window !== 'undefined') {
  (window as any).ClangdTester = ClangdTester;
}