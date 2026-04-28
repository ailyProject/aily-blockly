/**
 * ChatKernel Worker Protocol — Worker ↔ 主线程消息协议
 *
 * 定义 SSE Worker（chat-sse.worker.ts）与主线程（ChatKernelProxy）之间的
 * 双向消息类型。使用 discriminated union 实现类型安全的消息分发。
 *
 * 设计参考：
 *   - Copilot Extension Host ↔ Renderer 的 IPC 通道
 *   - tiktoken.worker.ts 的 id 关联模式
 *
 * 数据流：
 *   Main    ─── sse_fetch ──►  Worker    （发起 SSE 请求）
 *   Main    ─── sse_abort ──►  Worker    （取消请求）
 *   Worker  ─── sse_data  ──►  Main      （已解析的 SSE 事件）
 *   Worker  ─── sse_complete ► Main      （流正常结束）
 *   Worker  ─── sse_error ──► Main      （流异常结束）
 */

// ==================== Main → Worker 命令 ====================

export interface SSEFetchCommand {
  type: 'sse_fetch';
  /** 请求关联 ID（Proxy 分配） */
  id: number;
  /** 完整 API URL */
  url: string;
  /** HTTP 方法 */
  method: 'GET' | 'POST';
  /** 请求头（含 Authorization） */
  headers: Record<string, string>;
  /** POST body 对象 — Worker 内部执行 JSON.stringify（替代 asyncJsonStringify） */
  body?: any;
}

export interface SSEAbortCommand {
  type: 'sse_abort';
  /** 要取消的请求 ID */
  id: number;
}

export type WorkerCommand = SSEFetchCommand | SSEAbortCommand;

// ==================== Worker → Main 事件 ====================

export interface SSEDataEvent {
  type: 'sse_data';
  /** 请求关联 ID */
  id: number;
  /** 已解析的 SSE 事件对象（JSON.parse 结果） */
  data: any;
}

export interface SSECompleteEvent {
  type: 'sse_complete';
  /** 请求关联 ID */
  id: number;
}

export interface SSEErrorEvent {
  type: 'sse_error';
  /** 请求关联 ID */
  id: number;
  /** 规范化的错误对象 */
  error: WorkerHttpError;
}

/** Worker 向主线程报告的 HTTP 错误（与 ChatService 的错误格式兼容） */
export interface WorkerHttpError {
  name?: string;
  message: string;
  status?: number;
  statusCode?: number;
  code?: string | number;
  detail?: string;
  response?: { status: number; statusText: string };
}

export type WorkerEvent = SSEDataEvent | SSECompleteEvent | SSEErrorEvent;
