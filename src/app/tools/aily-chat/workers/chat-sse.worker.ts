/**
 * Chat SSE Worker — SSE 流式请求的物理线程隔离
 *
 * 将以下 CPU 密集操作从主线程移至 Worker 线程：
 *   1. JSON.stringify(payload) — 替代 asyncJsonStringify 的独立 Worker
 *   2. fetch() + response body reading — 网络 I/O
 *   3. TextDecoder + line split + JSON.parse — SSE 流解析
 *
 * 参考架构：
 *   - Copilot Extension Host 的进程隔离：Renderer 只做 UI，所有 I/O 在 ExtHost
 *   - tiktoken.worker.ts 的消息协议模式
 *   - async-json-stringify.ts 的 Worker 降级策略
 *
 * 协议：见 chat-kernel-protocol.ts
 */

/// <reference lib="webworker" />

// ===== 活跃请求管理 =====

const activeRequests = new Map<number, AbortController>();

// ===== 错误处理辅助（从 ChatService 移植，Worker 环境无 Angular 依赖） =====

async function readErrorBody(response: Response): Promise<any> {
  try {
    const rawText = await response.clone().text();
    if (!rawText) return null;
    try { return JSON.parse(rawText); } catch { return { message: rawText, detail: rawText }; }
  } catch { return null; }
}

function extractErrorMessage(errorBody: any): string {
  if (!errorBody) return '';
  if (typeof errorBody === 'string') return errorBody.trim();
  if (typeof errorBody !== 'object') return '';
  const candidate =
    errorBody.message ?? errorBody.msg ?? errorBody.detail ??
    errorBody.error_description ?? errorBody.error?.message ?? errorBody.error;
  return typeof candidate === 'string' ? candidate.trim() : '';
}

function extractErrorCode(errorBody: any): string | number | undefined {
  if (!errorBody || typeof errorBody !== 'object') return undefined;
  return errorBody.code ?? errorBody.error?.code ?? errorBody.data?.code;
}

function normalizeHttpError(response: Response, errorBody: any): any {
  const detail = extractErrorMessage(errorBody);
  const code = extractErrorCode(errorBody);
  return {
    name: 'HttpRequestError',
    status: response.status,
    statusCode: response.status,
    code,
    message: detail || `HTTP error! Status: ${response.status}`,
    detail,
    response: { status: response.status, statusText: response.statusText },
  };
}

/** 判断是否为可重试的瞬态网络错误（与 ChatService 逻辑一致） */
function isTransientNetworkError(err: any): boolean {
  if (!err) return false;
  const status = err.status ?? err.statusCode;
  if (status === 502 || status === 503 || status === 504) return true;
  if (err instanceof TypeError && /network/i.test(err.message || '')) return true;
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('failed to fetch') || msg.includes('network') || msg.includes('econnreset')) return true;
  // 流读取中途断连（HTTP 200 但 body 未完整传输）
  if (
    msg.includes('err_incomplete_chunked_encoding') ||
    msg.includes('premature close') ||
    msg.includes('err_content_length_mismatch') ||
    msg.includes('err_connection_closed') ||
    msg.includes('err_http2_protocol_error')
  ) return true;
  return false;
}

// ===== 核心 SSE 处理 =====

async function handleFetch(cmd: any): Promise<void> {
  const abortCtrl = new AbortController();
  activeRequests.set(cmd.id, abortCtrl);

  const MAX_RETRIES = 3;
  const RETRY_INITIAL_DELAY = 3000;
  const RETRY_BASE_DELAY = 2000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (abortCtrl.signal.aborted) return;

    try {
      // ★ 性能优化：如果主线程通过 Transferable 传来 ArrayBuffer，直接解码为字符串；
      // 否则在 Worker 中序列化（降级路径）
      let body: string | undefined;
      if (cmd.bodyPreSerialized) {
        if (cmd.body instanceof ArrayBuffer) {
          body = new TextDecoder().decode(cmd.body);
        } else {
          body = cmd.body as string | undefined;
        }
      } else {
        body = cmd.body != null ? JSON.stringify(cmd.body) : undefined;
      }

      const response = await fetch(cmd.url, {
        method: cmd.method,
        headers: cmd.headers,
        body,
        signal: abortCtrl.signal,
      });

      if (abortCtrl.signal.aborted) return;

      if (!response.ok) {
        const errorBody = await readErrorBody(response);
        const normalizedErr = normalizeHttpError(response, errorBody);

        // 瞬态 HTTP 错误自动重试（502/503/504）
        if (isTransientNetworkError(normalizedErr) && attempt < MAX_RETRIES) {
          const delay = attempt === 0
            ? RETRY_INITIAL_DELAY
            : RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
          console.warn(`[SSE Worker] HTTP ${response.status} 瞬态错误，${delay}ms 后第 ${attempt + 1} 次重试`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        (postMessage as any)({ type: 'sse_error', id: cmd.id, error: normalizedErr });
        return;
      }

      // ===== SSE 流解析（TextDecoder + line split + JSON.parse） =====
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (!abortCtrl.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (abortCtrl.signal.aborted) break;
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              (postMessage as any)({ type: 'sse_data', id: cmd.id, data: msg });

              if (msg.type === 'TaskCompleted') {
                (postMessage as any)({ type: 'sse_complete', id: cmd.id });
                return;
              }
            } catch {
              // 跳过不可解析的行（与 ChatService 行为一致）
            }
          }
        }

        // 处理缓冲区中剩余的内容
        if (!abortCtrl.signal.aborted && buffer.trim()) {
          try {
            const msg = JSON.parse(buffer);
            (postMessage as any)({ type: 'sse_data', id: cmd.id, data: msg });
          } catch {
            // 忽略不完整的最后一行
          }
        }

        if (!abortCtrl.signal.aborted) {
          (postMessage as any)({ type: 'sse_complete', id: cmd.id });
        }
      } catch (readError: any) {
        if (readError?.name === 'AbortError' || abortCtrl.signal.aborted) return;
        // 流读取中途断连（如 ERR_INCOMPLETE_CHUNKED_ENCODING）→ 向外抛给重试循环
        throw readError;
      }

      return; // 请求成功，退出重试循环

    } catch (fetchError: any) {
      if (fetchError?.name === 'AbortError' || abortCtrl.signal.aborted) return;

      // 瞬态网络错误自动重试（如 TypeError: network）
      if (isTransientNetworkError(fetchError) && attempt < MAX_RETRIES) {
        const delay = attempt === 0
          ? RETRY_INITIAL_DELAY
          : RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
        console.warn(`[SSE Worker] 网络错误，${delay}ms 后第 ${attempt + 1} 次重试:`, fetchError.message);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      (postMessage as any)({
        type: 'sse_error', id: cmd.id,
        error: { name: fetchError.name, message: fetchError.message },
      });
      return;
    }
  }
}

function handleAbort(cmd: any): void {
  const ctrl = activeRequests.get(cmd.id);
  if (ctrl) {
    ctrl.abort();
    activeRequests.delete(cmd.id);
  }
}

// ===== 消息入口 =====

addEventListener('message', (event: MessageEvent) => {
  const cmd = event.data;
  switch (cmd.type) {
    case 'sse_fetch':
      handleFetch(cmd).finally(() => activeRequests.delete(cmd.id));
      break;
    case 'sse_abort':
      handleAbort(cmd);
      break;
  }
});
