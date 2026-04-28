/**
 * Aily Chat - 共享类型定义
 *
 * 从 aily-chat.component.ts 提取的公共接口和枚举，
 * 供 ChatEngineService、Component 及其他服务共享。
 */

export interface Tool {
  name: string;
  description: string;
  input_schema: { [key: string]: any };
  agents?: string[];
}

export interface ResourceItem {
  type: 'file' | 'folder' | 'url' | 'block';
  path?: string;
  url?: string;
  name: string;
  /** block 类型时存储 formatted 上下文信息（LLM 友好文本） */
  blockContext?: string;
  /** block 类型时存储关联的 blockId */
  blockId?: string;
}

export interface ChatMessage {
  role: string;
  content: string;
  state: 'doing' | 'done';
  /** 消息来源，mainAgent 为主Agent，其他值为子Agent名称 */
  source?: string;
  /** 该消息对应的模型名称（创建时快照） */
  modelName?: string;
}

export enum ToolCallState {
  DOING = 'doing',
  DONE = 'done',
  WARN = 'warn',
  ERROR = 'error',
  /** 等待用户审批（工具执行前拦截） */
  PENDING_APPROVAL = 'pending_approval'
}

export interface ToolCallInfo {
  id: string;
  name: string;
  state: ToolCallState;
  text: string;
  args?: any;
}
