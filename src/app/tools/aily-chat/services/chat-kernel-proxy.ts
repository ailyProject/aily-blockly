/**
 * ChatKernelProxy — 主线程侧 SSE Worker 代理
 *
 * 封装 chat-sse.worker.ts 的通信细节，
 * 向 ChatService 提供与原生 fetch 相同的 Observable<any> 接口。
 *
 * 参考：
 *   - Copilot: Extension Host ↔ Renderer 之间的 IPC 代理层
 *   - tiktoken.service.ts 的 Worker 管理模式（pendingRequests Map + id 关联）
 *   - async-json-stringify.ts 的降级策略（Worker 不可用时 isReady=false）
 *
 * 降级策略：
 *   Worker 不可用时（CSP 限制、浏览器不支持、创建失败），
 *   isReady 返回 false，调用方自动回退到主线程直接 fetch。
 */

import { Observable } from 'rxjs';

export class ChatKernelProxy {

  private worker: Worker | null = null;
  private _unavailable = false;
  private _nextId = 0;

  /** 活跃请求回调映射：id → { next, complete, error } */
  private _pending = new Map<number, {
    next: (data: any) => void;
    complete: () => void;
    error: (err: any) => void;
  }>();

  /** Worker 是否就绪（创建成功且未出错） */
  get isReady(): boolean {
    return !this._unavailable && !!this.worker;
  }

  // ==================== 生命周期 ====================

  /**
   * 初始化 Worker（惰性：首次 sseFetch 调用时也会自动触发）
   */
  init(): void {
    if (this._unavailable || this.worker) return;

    try {
      this.worker = new Worker(
        new URL('../workers/chat-sse.worker.ts', import.meta.url),
        { type: 'module' }
      );

      this.worker.onmessage = (event: MessageEvent) => this._onMessage(event.data);

      this.worker.onerror = (err) => {
        console.warn('[ChatKernelProxy] Worker 运行时错误，降级为主线程模式:', err.message);
        this._unavailable = true;
        this._terminateWorker();
        // 拒绝所有待处理请求，让调用方 Observable 触发 error
        for (const [, cb] of this._pending) {
          cb.error({ name: 'WorkerError', message: 'SSE Worker terminated unexpectedly' });
        }
        this._pending.clear();
      };
    } catch (e) {
      console.warn('[ChatKernelProxy] Worker 创建失败，降级为主线程模式:', e);
      this._unavailable = true;
    }
  }

  /**
   * 销毁 Worker 并清理所有待处理请求
   */
  terminate(): void {
    this._terminateWorker();
    for (const [, cb] of this._pending) {
      cb.error({ name: 'WorkerTerminated', message: 'SSE Worker was terminated' });
    }
    this._pending.clear();
  }

  // ==================== 公共接口 ====================

  /**
   * 发起 SSE 请求（Worker 线程中执行 JSON.stringify + fetch + SSE 解析）
   *
   * Worker 内部处理：
   *   - body 对象 → JSON.stringify（替代 asyncJsonStringify）
   *   - fetch(url, { method, headers, body }) 请求
   *   - response.body.getReader() + TextDecoder + JSON.parse 流式解析
   *   - 瞬态网络错误自动重试（502/503/504）
   *
   * @param url     完整 API URL（含 sessionId 路径）
   * @param method  'GET' | 'POST'
   * @param headers 请求头（含 Authorization，由调用方预先解析 token）
   * @param body    POST body 对象（Worker 内部 JSON.stringify，可选）
   * @returns Observable<any> — 与 ChatService.chatRequest() / streamConnect() 相同的事件流接口
   */
  sseFetch(
    url: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body?: any
  ): Observable<any> {
    // 确保 Worker 已初始化
    this.init();

    if (!this.worker) {
      return new Observable(observer => {
        observer.error({ name: 'WorkerUnavailable', message: 'SSE Worker is not available' });
      });
    }

    const id = ++this._nextId;

    return new Observable(observer => {
      this._pending.set(id, {
        next: (data: any) => observer.next(data),
        complete: () => observer.complete(),
        error: (err: any) => observer.error(err),
      });

      // ★ 性能优化：用 TextEncoder 将 body 序列化为 ArrayBuffer，
      // 通过 Transferable 零拷贝传给 Worker（避免 structured clone 深拷贝嵌套对象）。
      // 主线程 JSON.stringify 仍然是同步的，但比 structured clone 深度遍历快
      // （JSON.stringify 是 V8 内置 C++ 实现，structured clone 需遍历每个属性）。
      let bodyBuf: ArrayBuffer | undefined;
      if (body != null) {
        const encoder = new TextEncoder();
        const arr = encoder.encode(JSON.stringify(body));
        bodyBuf = arr.buffer;
      }

      // 发送 fetch 命令到 Worker（bodyBuf 通过 Transferable 零拷贝传输）
      const msg: any = {
        type: 'sse_fetch',
        id,
        url,
        method,
        headers,
        body: bodyBuf,
        bodyPreSerialized: true,
      };
      this.worker!.postMessage(msg, bodyBuf ? [bodyBuf] : []);

      // 取消订阅时通知 Worker 中止请求
      return () => {
        this._pending.delete(id);
        this.worker?.postMessage({ type: 'sse_abort', id });
      };
    });
  }

  // ==================== 内部方法 ====================

  private _onMessage(event: any): void {
    const cb = this._pending.get(event.id);
    if (!cb) return;

    switch (event.type) {
      case 'sse_data':
        cb.next(event.data);
        break;

      case 'sse_complete':
        cb.complete();
        this._pending.delete(event.id);
        break;

      case 'sse_error':
        cb.error(event.error);
        this._pending.delete(event.id);
        break;
    }
  }

  private _terminateWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
