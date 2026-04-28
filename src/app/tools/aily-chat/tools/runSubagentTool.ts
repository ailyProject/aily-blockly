/**
 * run_subagent 通用工具 — 泛化子代理调度
 *
 * 参考 Copilot 的 runSubagent 设计：
 * - 从绑死 `run_schematicAgent` 泛化为动态子代理调度
 * - 通过 agent 参数选择目标子代理
 * - 支持注册新的子代理而无需修改工具代码
 * - 保持向后兼容：`run_schematicAgent` 作为内部映射
 *
 * 与现有系统的集成：
 * - SubagentSessionService 已支持按 agentName 分发
 * - 后端已有 agent 路由机制
 * - 本工具仅改变前端 LLM 交互层的工具定义方式
 */

import { ToolUseResult } from './tools';

// ============================
// 类型定义
// ============================

export interface SubagentDefinition {
  /** 子代理名称（与后端注册的一致，如 "schematicAgent"） */
  name: string;
  /** 人类可读名称（用于显示） */
  displayName: string;
  /** 功能描述（用于帮助 LLM 选择） */
  description: string;
  /** 使用场景列表 */
  useCases: string[];
  /** 调用前建议获取的上下文（提示 LLM） */
  suggestedContext?: string;
}

export interface RunSubagentArgs {
  /** 目标子代理名称 */
  agent: string;
  /** 交给子代理的具体任务描述 */
  task: string;
  /** 相关上下文信息 */
  context?: string;
}

// ============================
// 子代理注册表（模块级配置）
// ============================

const _agentRegistry = new Map<string, SubagentDefinition>();

/**
 * 注册一个子代理定义
 */
export function registerSubagent(def: SubagentDefinition): void {
  _agentRegistry.set(def.name, def);
}

/**
 * 获取所有已注册子代理
 */
export function getRegisteredSubagents(): SubagentDefinition[] {
  return [..._agentRegistry.values()];
}

/**
 * 获取指定子代理定义
 */
export function getSubagentDefinition(name: string): SubagentDefinition | undefined {
  return _agentRegistry.get(name);
}

// ============================
// 内置子代理注册
// ============================

// 注册 schematicAgent（现有接线图子代理）
registerSubagent({
  name: 'schematicAgent',
  displayName: '接线图代理',
  description: '为用户生成开发板与电子模块的可视化接线图（电路原理图）。子代理会独立运行，使用专属工具集完成接线图的生成和编辑，完成后返回结果。',
  useCases: [
    '用户要求生成、更新或修改接线图/电路图',
    '涉及开发板引脚连线的可视化需求',
  ],
  suggestedContext: '调用前应先通过 get_context 和 get_project_info 获取当前项目信息',
});

// ============================
// 动态生成工具 Schema
// ============================

/**
 * 生成 run_subagent 工具的 description，包含所有已注册子代理的信息
 * 每次调用时动态生成，确保反映最新的注册状态
 */
export function buildRunSubagentDescription(): string {
  const agents = getRegisteredSubagents();
  if (agents.length === 0) {
    return '启动子代理执行独立任务。当前没有可用的子代理。';
  }

  const agentDescriptions = agents.map(a => {
    const useCases = a.useCases.map(u => `  - ${u}`).join('\n');
    const ctxHint = a.suggestedContext ? `\n  注意: ${a.suggestedContext}` : '';
    return `**${a.name}** (${a.displayName}): ${a.description}\n  适用场景:\n${useCases}${ctxHint}`;
  }).join('\n\n');

  return `启动子代理执行独立任务。子代理拥有专属工具集，可以自主完成特定领域的工作。

可用子代理:
${agentDescriptions}

如果返回结果不完整或不符合预期，可以继续调用该工具与子代理进行多轮交互。`;
}

/**
 * 生成 run_subagent 的 JSON Schema
 */
export function buildRunSubagentSchema(): any {
  const agents = getRegisteredSubagents();
  const agentNames = agents.map(a => a.name);

  return {
    name: 'run_subagent',
    description: buildRunSubagentDescription(),
    input_schema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: agentNames.length > 0 ? agentNames : undefined,
          description: `目标子代理名称。可选值: ${agentNames.join(', ')}`,
        },
        task: {
          type: 'string',
          description: '交给子代理的具体任务描述',
        },
        context: {
          type: 'string',
          description: '相关上下文信息（项目信息、代码片段等）',
        },
      },
      required: ['agent', 'task'],
    },
    agents: ['mainAgent'],
  };
}

// ============================
// 参数校验（供 registered 层调用）
// ============================

/**
 * 校验 run_subagent 参数并映射为后端可识别的 SubagentToolCallRequest
 * 返回 null 如果校验通过，返回错误 ToolUseResult 如果失败
 */
export function validateRunSubagentArgs(args: RunSubagentArgs): ToolUseResult | null {
  if (!args?.agent) {
    const available = getRegisteredSubagents().map(a => a.name).join(', ');
    return {
      is_error: true,
      content: `缺少必要参数 agent。可用子代理: ${available}`,
    };
  }

  if (!args?.task) {
    return { is_error: true, content: '缺少必要参数 task（任务描述）' };
  }

  const def = getSubagentDefinition(args.agent);
  if (!def) {
    const available = getRegisteredSubagents().map(a => `${a.name} (${a.displayName})`).join(', ');
    return {
      is_error: true,
      content: `未知的子代理 "${args.agent}"。可用子代理: ${available}`,
    };
  }

  return null; // 校验通过
}
