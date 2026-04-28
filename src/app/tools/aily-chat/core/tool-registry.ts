/**
 * Aily Tool Registry - 工具注册中心
 *
 * 单例模式，所有工具通过 ToolRegistry.register() 自注册。
 * 替代原来 tools.ts 中的 TOOLS 数组 + component 中的 switch/case。
 *
 * 使用方法：
 *   1. 工具文件末尾调用 ToolRegistry.register(new XxxTool());
 *   2. 在 core/register-all.ts 中 import 工具文件触发注册
 *   3. 通过 ToolRegistry.execute() 统一调度（替代 switch/case）
 */

import { IAilyTool, ToolContext, ToolSchema, ToolUseResult } from './tool-types';

class ToolRegistryImpl {
  private tools = new Map<string, IAilyTool>();

  /**
   * 注册一个工具
   */
  register(tool: IAilyTool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] 工具 "${tool.name}" 已注册，将被覆盖`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * 获取指定名称的工具
   */
  get(name: string): IAilyTool | undefined {
    return this.tools.get(name);
  }

  /**
   * 判断工具是否已注册
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 获取所有已注册工具
   */
  getAll(): IAilyTool[] {
    return [...this.tools.values()];
  }

  /**
   * 获取指定 Agent 可用的工具列表
   */
  getToolsForAgent(agentName: string): IAilyTool[] {
    return [...this.tools.values()].filter(
      t => t.schema.agents.includes(agentName)
    );
  }

  /**
   * 获取指定 Agent 可用的工具 schema 列表（发送给 LLM）
   */
  getSchemasForAgent(agentName: string): ToolSchema[] {
    return this.getToolsForAgent(agentName).map(t => t.schema);
  }

  /**
   * 获取所有工具的 schema 列表
   */
  getAllSchemas(): ToolSchema[] {
    return [...this.tools.values()].map(t => t.schema);
  }

  /**
   * 统一执行工具（替代 switch/case）
   *
   * @param name 工具名称（支持 mcp_ 前缀，自动去除查找注册表）
   * @param args 工具参数
   * @param ctx  工具上下文
   * @returns 执行结果
   */
  async execute(name: string, args: any, ctx: ToolContext): Promise<ToolUseResult> {
    // 去除 mcp_ 前缀
    const cleanName = name.startsWith('mcp_') ? name.substring(4) : name;

    const tool = this.tools.get(cleanName);
    if (!tool) {
      return {
        is_error: true,
        content: `未知工具: ${cleanName}`,
      };
    }

    try {
      return await tool.invoke(args, ctx);
    } catch (error: any) {
      console.error(`[ToolRegistry] 工具 "${cleanName}" 执行异常:`, error);
      return {
        is_error: true,
        content: `工具执行出错: ${error.message || '未知错误'}`,
      };
    }
  }

  /**
   * 获取工具开始执行时的显示文本
   */
  getStartText(name: string, args?: any): string {
    const cleanName = name.startsWith('mcp_') ? name.substring(4) : name;
    const tool = this.tools.get(cleanName);
    if (tool?.getStartText) {
      return tool.getStartText(args);
    }
    return `执行工具: ${cleanName}`;
  }

  /**
   * 获取工具执行完成后的显示文本
   */
  getResultText(name: string, args?: any, result?: ToolUseResult): string {
    const cleanName = name.startsWith('mcp_') ? name.substring(4) : name;
    const tool = this.tools.get(cleanName);

    if (result?.is_error) {
      if (tool?.getResultText) {
        return tool.getResultText(args, result);
      }
      return `${cleanName} 执行失败`;
    }

    if (tool?.getResultText) {
      return tool.getResultText(args, result);
    }
    return `${cleanName} 执行成功`;
  }

  /**
   * 获取已注册工具数量
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * 获取所有已注册工具名称
   */
  getToolNames(): string[] {
    return [...this.tools.keys()];
  }
}

/** 全局单例 */
export const ToolRegistry = new ToolRegistryImpl();
