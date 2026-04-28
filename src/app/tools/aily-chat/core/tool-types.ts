/**
 * Aily Tool System - 核心类型定义
 *
 * 所有工具必须实现 IAilyTool 接口，通过 ToolRegistry 自注册。
 * 每个工具文件自包含：schema + handler + 显示文本逻辑。
 */

// ============================
// 工具执行结果
// ============================

export interface ToolUseResult {
  is_error: boolean;
  content: string;
  details?: string;
  metadata?: any;
  warning?: boolean;
}

// ============================
// 工具上下文 (依赖注入)
// ============================

import { IAilyHostAPI } from './host-api';

/**
 * ToolContext 是工具执行时可访问的服务集合。
 * 在不同的运行环境（Electron GUI / CLI / MCP Server）中提供不同的实现。
 * 工具不应直接引用 Angular 服务，而是通过此上下文按需获取。
 *
 * 迁移路径：工具应逐步从 ctx.projectService 等旧字段迁移到 ctx.host.project 等新接口。
 * 旧字段将在全部迁移完成后移除。
 */
export interface ToolContext {
  /**
   * 宿主环境 API — 工具通过此接口访问文件系统、项目、编辑器等外部能力。
   */
  host?: IAilyHostAPI;
  /** 安全上下文 */
  securityContext?: any;
  /** 当前会话 ID */
  sessionId?: string;

  /** 编辑 checkpoint 记录器（可选），工具写文件前调用以支持回滚 */
  editCheckpoint?: {
    recordEdit(filePath: string, type: 'create' | 'modify' | 'delete'): void;
    /** 重新计算并推送当前摘要到面板（工具写盘后调用） */
    publishCurrentSummary(): void;
  };

  /** 中止信号，工具在长时间操作中应定期检查 signal.aborted */
  abortSignal?: AbortSignal;

  /** 通用获取方法，用于获取未列出的服务 */
  getService?<T>(name: string): T | undefined;
}

// ============================
// 工具 Schema (发送给 LLM)
// ============================

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  agents: string[];
}

// ============================
// 核心工具接口
// ============================

/**
 * 所有 Aily 工具必须实现此接口。
 *
 * 一个工具文件自包含以下所有职责：
 * - schema: 工具定义（名称、描述、JSON Schema），发送给 LLM
 * - invoke: 执行逻辑
 * - getStartText: 工具开始执行时的 UI 显示文本
 * - getResultText: 工具执行完成后的 UI 显示文本
 */
export interface IAilyTool {
  /** 工具唯一名称（必须与 schema.name 相同） */
  readonly name: string;

  /** 工具 schema 定义（发送给 LLM） */
  readonly schema: ToolSchema;

  /**
   * 工具是否需要特定环境才能运行。
   * - 'gui': 仅在 Electron GUI 中可用 (如 Blockly 操作)
   * - 'cli': 仅在 CLI 中可用
   * - 'any': 任何环境 (默认)
   */
  readonly environment?: 'gui' | 'cli' | 'any';

  /**
   * UI 显示模式。
   * - 'toolCall': 使用 startToolCall / completeToolCall 流程 (默认)
   * - 'appendMessage': 使用 appendMessage + aily-state 块流程 (搜索/硬件/schematic 类工具)
   * - 'silent': 不显示任何 UI 状态 (ask_approval 等)
   */
  readonly displayMode?: 'toolCall' | 'appendMessage' | 'silent';

  /**
   * 执行工具
   * @param args LLM 传入的参数
   * @param ctx 工具上下文（提供服务依赖）
   * @returns 执行结果
   */
  invoke(args: any, ctx: ToolContext): Promise<ToolUseResult>;

  /**
   * 工具开始执行时的 UI 显示文本（可选）
   * 对应原来 generateToolStartText 中的 case
   */
  getStartText?(args: any): string;

  /**
   * 工具执行完成后的 UI 显示文本（可选）
   * 对应原来 generateToolResultText 中的 case
   */
  getResultText?(args: any, result?: ToolUseResult): string;
}

// ============================
// 工具执行回调 (UI 层使用)
// ============================

/**
 * 工具执行过程中的回调，供 UI 层订阅状态变化。
 * Component 通过实现这些回调来更新 UI，而不是将 UI 逻辑混入工具。
 */
export interface ToolExecutionCallbacks {
  /** 工具开始执行 */
  onToolStart?(toolCallId: string, toolName: string, displayText: string, args?: any): void;
  /** 工具执行完成 */
  onToolEnd?(toolCallId: string, toolName: string, state: string, displayText: string, result?: ToolUseResult): void;
  /** 追加消息到聊天列表 */
  appendMessage?(role: string, content: string): void;
}
