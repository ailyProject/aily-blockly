/**
 * ChatKernelEvent — Chat 内核事件类型定义
 *
 * 参考 Copilot 的 ChatResponsePart 设计，定义 Chat 逻辑层向 UI 层推送的事件类型。
 * ChatViewAdapter 消费这些事件，批量/节流后更新 Angular 绑定的 ViewModel。
 *
 * 设计原则：
 *   - 事件是纯数据（no Angular 依赖）
 *   - 单向流：Kernel → Adapter → UI
 *   - 类型化联合 (discriminated union)，通过 `type` 字段分发
 */

import { ToolCallState, ToolCallInfo } from './chat-types';

// ==================== 流式文本事件 ====================

export interface StreamingChunkEvent {
  type: 'streaming_chunk';
  /** 追加的文本内容 */
  content: string;
  /** 消息角色 */
  role: string;
  /** 消息来源 (mainAgent / subAgent 名称) */
  source?: string;
}

export interface MessageDoneEvent {
  type: 'message_done';
  /** 标记完成的消息来源 */
  source?: string;
}

// ==================== 工具调用事件 ====================

export interface ToolCallStateEvent {
  type: 'tool_call_state';
  /** 工具调用状态信息 */
  toolCallInfo: ToolCallInfo;
  /** 消息来源 */
  source?: string;
}

// ==================== 状态变更事件 ====================

export interface StatusChangeEvent {
  type: 'status_change';
  isWaiting?: boolean;
  isCompleted?: boolean;
}

// ==================== 直接消息追加 ====================

export interface AppendMessageEvent {
  type: 'append_message';
  role: string;
  content: string;
  source?: string;
}

// ==================== 消息内容替换 ====================

export interface ReplaceContentEvent {
  type: 'replace_content';
  /** 目标消息索引（从末尾开始搜索） */
  targetRole: string;
  /** 正则模式 */
  pattern: string;
  /** 替换文本 */
  replacement: string;
}

// ==================== 截断消息 ====================

export interface TruncateContentEvent {
  type: 'truncate_content';
  /** 截断位置 */
  endIndex: number;
}

// ==================== 批量历史加载 ====================

export interface HistoryLoadEvent {
  type: 'history_load';
  /** 完整的消息列表（替换当前 list） */
  messages: Array<{ role: string; content: string; state: 'doing' | 'done'; source?: string; modelName?: string }>;
}

// ==================== 联合类型 ====================

export type ChatKernelEvent =
  | StreamingChunkEvent
  | MessageDoneEvent
  | ToolCallStateEvent
  | StatusChangeEvent
  | AppendMessageEvent
  | ReplaceContentEvent
  | TruncateContentEvent
  | HistoryLoadEvent;
