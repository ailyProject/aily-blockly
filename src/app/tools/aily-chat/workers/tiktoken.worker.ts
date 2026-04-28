/**
 * Tiktoken Web Worker
 *
 * 将 CPU 密集的 BPE token 编码卸载到后台线程，
 * 避免大文本（如长工具返回结果）阻塞 UI 主线程。
 *
 * 协议（Worker ↔ 主线程）：
 *   请求: { id, type, payload }
 *   响应: { id, type, result?, error? }
 *
 * 参考 Copilot: TokenizerProvider 在 Worker 中运行 BPETokenizer，
 * 通过 postMessage 传递计数请求/结果。
 */

/// <reference lib="webworker" />

// ===== 类型定义 =====

interface TiktokenBPE {
  pat_str: string;
  special_tokens: Record<string, number>;
  bpe_ranks: string;
}

interface TiktokenInstance {
  encode(text: string): number[];
}

interface TiktokenWorkerRequest {
  id: number;
  type: 'init' | 'countTokens' | 'countBatch';
  payload: any;
}

interface TiktokenWorkerResponse {
  id: number;
  type: string;
  result?: any;
  error?: string;
}

// ===== 启发式 fallback =====

function estimateTokensFallback(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x4E00 && code < 0x9FFF) {
      count += 0.67;
    } else if (code > 0x7F) {
      count += 0.5;
    } else {
      count += 0.25;
    }
  }
  return Math.ceil(count);
}

// ===== Worker 状态 =====

let encoder: TiktokenInstance | null = null;

/** 分段编码避免单次 encode 过大 */
const CHUNK_SIZE = 20000;

function encodeCount(text: string): number {
  if (!encoder) return estimateTokensFallback(text);
  if (text.length <= 50000) {
    return encoder.encode(text).length;
  }
  let total = 0;
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    total += encoder.encode(text.substring(i, i + CHUNK_SIZE)).length;
  }
  return total;
}

// ===== 消息处理 =====

addEventListener('message', async (event: MessageEvent<TiktokenWorkerRequest>) => {
  const { id, type, payload } = event.data;
  const respond = (result?: any, error?: string) => {
    (postMessage as any)({ id, type, result, error });
  };

  try {
    switch (type) {
      case 'init': {
        // payload: { rankData: TiktokenBPE }
        const { Tiktoken } = await import('js-tiktoken/lite');
        encoder = new Tiktoken(payload.rankData);
        respond(true);
        break;
      }

      case 'countTokens': {
        // payload: { text: string }
        const count = encoder
          ? encodeCount(payload.text)
          : estimateTokensFallback(payload.text);
        respond(count);
        break;
      }

      case 'countBatch': {
        // payload: { items: Array<{ id: string, text: string }> }
        const results: Record<string, number> = {};
        for (const item of payload.items) {
          results[item.id] = encoder
            ? encodeCount(item.text)
            : estimateTokensFallback(item.text);
        }
        respond(results);
        break;
      }

      default:
        respond(undefined, `Unknown message type: ${type}`);
    }
  } catch (err: any) {
    respond(undefined, err?.message || String(err));
  }
});
