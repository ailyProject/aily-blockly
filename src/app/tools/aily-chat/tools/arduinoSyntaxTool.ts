import { ToolUseResult } from "./tools";
import { ArduinoLintService, LintResult, LintError } from "../services/arduino-lint.service";

/**
 * Arduino语法检查工具 - 基于 aily-builder lint 功能
 * 使用新的 aily-builder lint 功能进行代码语法检查
 */
export class ArduinoSyntaxTool {

  private lintService: ArduinoLintService | undefined;

  constructor() {
    // 参照 TodoUpdateService 的模式，直接从全局对象获取服务
    // console.log('🔧 ArduinoSyntaxTool 初始化...');
    
    // 直接从全局对象获取服务实例
    this.lintService = (window as any)['arduinoLintService'];
    
    // if (this.lintService) {
    //   console.log('✅ Arduino Lint Service 获取成功（通过全局对象）');
      
    //   // 测试服务可用性
    //   try {
    //     const isAvailable = this.lintService.isAvailable();
    //     const status = this.lintService.getStatus();
    //     console.log('- 服务可用性:', isAvailable);
    //     console.log('- 服务状态:', status);
    //   } catch (error) {
    //     console.warn('⚠️ 服务测试失败:', error);
    //   }
    // } else {
    //   console.warn('⚠️ 无法从全局对象获取 Arduino Lint Service');
    //   console.log('- 检查 (window as any)[\'arduinoLintService\']:', (window as any)['arduinoLintService']);
    // }
  }

  async use(parameters: {
    code: string;
    timeout?: number;
  }): Promise<ToolUseResult> {
    const { code, timeout = 5000 } = parameters;

    try {
      // console.log('🔍 Arduino语法检查工具启动 (aily-builder lint)...');
      // console.log('- lintService 实例:', !!this.lintService);
      
      if (!code || code.trim().length === 0) {
        return {
          is_error: true,
          content: '❌ 错误：代码内容为空'
        };
      }

      // 检查 lint 服务是否可用
      if (!this.lintService) {
        // console.warn('❌ lintService 实例不存在');
        return {
          is_error: true,
          content: '❌ **Arduino Lint 服务不可用**\n\n可能原因：\n1. 服务未正确注册到全局对象\n2. 服务初始化失败\n\n请检查浏览器控制台获取详细错误信息。'
        };
      }

      // console.log('- 检查服务可用性...');
      const isServiceAvailable = this.lintService.isAvailable();
      // console.log('- 服务可用性结果:', isServiceAvailable);
      
      if (!isServiceAvailable) {
        // console.warn('❌ aily-builder 不可用');
        const status = this.lintService.getStatus();
        // console.log('- 服务状态:', status);
        return {
          is_error: true,
          content: '❌ **aily-builder 不可用**\n\n可能原因：\n1. aily-builder 未正确安装\n2. 路径配置错误\n3. Electron 环境未准备就绪\n\n请检查：\n- window.path 对象是否存在\n- getAilyBuilderPath() 是否返回有效路径\n- aily-builder/index.js 文件是否存在'
        };
      }

      // 执行语法检查
      const result: LintResult = await this.lintService.checkSyntax(code, {
        timeout,
        mode: 'auto',
        format: 'json'
      });

      return this.formatLintResult(result);

    } catch (error: any) {
      console.warn('Arduino语法检查工具执行失败:', error);
      return {
        is_error: true,
        content: `❌ **语法检查执行失败**

错误信息：${error.message}

请检查：
1. 代码格式是否正确
2. aily-builder 是否正确配置
3. 项目依赖是否完整
4. 重试操作`
      };
    }
  }

  /**
   * 格式化 lint 检查结果
   */
  private formatLintResult(result: LintResult): ToolUseResult {
    if (result.success) {
      return {
        is_error: false,
        content: `✅ **代码语法检查通过**

🔍 检查工具：aily-builder lint
⏱️ 检查耗时：${result.executionTime}ms
📝 检查结果：无语法错误${result.warnings && result.warnings.length > 0 ? `，但有 ${result.warnings.length} 个警告` : ''}`
      };
    }

    // 有错误的情况
    const errorCount = result.errors ? result.errors.length : 0;
    let content = `❌ **发现 ${errorCount} 个语法错误**\n\n`;

    // 显示错误详情
    if (result.errors) {
      result.errors.forEach((error, index) => {
        content += `**错误 ${index + 1}：**\n`;
        content += `📍 位置：第 ${error.line} 行，第 ${error.column} 列\n`;
        content += `📝 错误：${error.message}\n`;
        content += '\n';
      });
    }

    // 显示警告
    if (result.warnings && result.warnings.length > 0) {
      content += `⚠️ **${result.warnings.length} 个警告：**\n\n`;
      result.warnings.forEach((warning, index) => {
        content += `**警告 ${index + 1}：**\n`;
        content += `📍 位置：第 ${warning.line} 行，第 ${warning.column} 列\n`;
        content += `📝 内容：${warning.message}\n\n`;
      });
    }

    // 生成修复建议
    const suggestions = this.generateFixSuggestions(result.errors || []);
    if (suggestions.length > 0) {
      content += `💡 **修复建议：**\n`;
      suggestions.forEach((suggestion, index) => {
        content += `${index + 1}. ${suggestion}\n`;
      });
      content += '\n';
    }

    content += `🔍 检查工具：aily-builder lint\n`;
    content += `⏱️ 检查耗时：${result.executionTime}ms`;

    return {
      is_error: true,
      content
    };
  }

  /**
   * 生成修复建议
   */
  private generateFixSuggestions(errors: LintError[]): string[] {
    const suggestions: string[] = [];
    const seenSuggestions = new Set<string>();

    for (const error of errors) {
      let suggestion = '';

      if (error.message.includes('was not declared in this scope')) {
        const varMatch = error.message.match(/'([^']+)' was not declared/);
        if (varMatch) {
          const varName = varMatch[1];
          suggestion = `变量 \`${varName}\` 未声明，请在使用前声明，例如：\`float ${varName};\``;
        }
      } else if (error.message.includes("expected ')' before")) {
        suggestion = '括号不匹配，请检查是否缺少右括号 `)`';
      } else if (error.message.includes("expected ';' before")) {
        suggestion = '缺少分号，请在语句末尾添加 `;`';
      } else if (error.message.includes('unexpected')) {
        suggestion = '语法错误，请检查代码结构是否正确';
      }

      if (suggestion && !seenSuggestions.has(suggestion)) {
        suggestions.push(suggestion);
        seenSuggestions.add(suggestion);
      }
    }

    return suggestions;
  }

  /**
   * 快速检查代码是否有未声明变量
   * 用于AI生成代码后的快速验证
   */
  async quickCheck(code: string): Promise<{ hasErrors: boolean; errors: string[] }> {
    try {
      if (!this.lintService || !this.lintService.isAvailable()) {
        return {
          hasErrors: true,
          errors: ['lint服务不可用']
        };
      }

      const result = await this.lintService.checkSyntax(code, {
        timeout: 2000,
        mode: 'fast',
        format: 'json'
      });

      if (!result.success) {
        // 提取未声明变量错误
        const undeclaredVars = result.errors
          ? result.errors
              .filter(error => error.message.includes('was not declared in this scope'))
              .map(error => {
                const match = error.message.match(/'([^']+)' was not declared/);
                return match ? match[1] : '';
              })
              .filter(Boolean)
          : [];

        return {
          hasErrors: true,
          errors: undeclaredVars.length > 0 ? undeclaredVars : ['存在语法错误']
        };
      }

      return {
        hasErrors: false,
        errors: []
      };
    } catch (error) {
      console.warn('快速检查失败:', error);
      return {
        hasErrors: true,
        errors: ['检查失败']
      };
    }
  }
}

// 导出工具实例
export const arduinoSyntaxTool = new ArduinoSyntaxTool();