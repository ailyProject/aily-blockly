import { Injectable } from '@angular/core';

/**
 * TikToken 精确分词服务
 *
 * 使用 js-tiktoken (纯 JS，无 WASM) 提供精确的 token 计数。
 *
 * 双编码器支持（参考 Copilot 的编码器选择策略）：
 *   - o200k_base：GPT-4o / Claude / DeepSeek / Qwen 等现代模型（默认）
 *   - cl100k_base：GPT-3.5 / GPT-4 / GPT-4-turbo 等 OpenAI 旧模型
 *
 * 加载策略（混合模式）：
 * 1. 优先从本地 assets/tiktoken/ 加载 BPE rank 数据（Electron 离线可用）
 * 2. 失败则回退到 CDN (tiktoken.pages.dev)
 * 3. 加载期间使用启发式估算作为 fallback
 */

// ===== 类型定义 =====

interface TiktokenBPE {
  pat_str: string;
  special_tokens: Record<string, number>;
  bpe_ranks: string;
}

interface TiktokenInstance {
  encode(text: string, allowedSpecial?: Array<string> | 'all', disallowedSpecial?: Array<string> | 'all'): number[];
  decode(tokens: number[]): string;
}

// ===== 编码器名称类型 =====

type TiktokenEncoding = 'o200k_base' | 'cl100k_base';

// ===== 启发式估算 fallback（tiktoken 未就绪时使用） =====

function estimateTokensFallback(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x4E00 && code < 0x9FFF) {
      count += 0.67; // CJK
    } else if (code > 0x7F) {
      count += 0.5;  // 其他非 ASCII
    } else {
      count += 0.25; // ASCII
    }
  }
  return Math.ceil(count);
}

// ===== LRU 缓存 =====

class TokenCountCache {
  private cache = new Map<string, number>();
  private readonly maxSize: number;

  constructor(maxSize = 2000) {
    this.maxSize = maxSize;
  }

  get(key: string): number | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // LRU: 移到末尾
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: number): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // 淘汰最旧的
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }
}

// ===== 主服务 =====

@Injectable({
  providedIn: 'root'
})
export class TiktokenService {

  /** 默认编码名称 */
  private static readonly DEFAULT_ENCODING: TiktokenEncoding = 'o200k_base';

  /**
   * 模型 → 编码器映射（参考 Copilot 双编码器选择策略）
   *
   * Copilot 在 dist/ 中携带了 cl100k_base.tiktoken 和 o200k_base.tiktoken 两份数据，
   * 根据模型名称选择对应编码器。
   *
   * cl100k_base: GPT-3.5, GPT-4, GPT-4-turbo, text-embedding-ada-002
   * o200k_base:  GPT-4o, GPT-4o-mini, Claude, DeepSeek, Qwen, GLM (默认)
   */
  private static readonly MODEL_ENCODING_MAP: Array<{ pattern: string; encoding: TiktokenEncoding }> = [
    { pattern: 'gpt-3.5', encoding: 'cl100k_base' },
    { pattern: 'gpt-4-turbo', encoding: 'cl100k_base' },
    { pattern: 'gpt-4-0', encoding: 'cl100k_base' },       // gpt-4-0314, gpt-4-0613 etc.
    { pattern: 'gpt-4-1', encoding: 'cl100k_base' },       // gpt-4-1106 etc.
    { pattern: 'text-embedding', encoding: 'cl100k_base' },
    // 其他所有模型默认使用 o200k_base（GPT-4o, Claude, DeepSeek, Qwen, GLM...）
  ];

  /** 编码器资源配置 */
  /** 编码器资源配置（localPath 与 angular.json assets output 对应） */
  private static readonly ENCODING_CONFIGS: Record<TiktokenEncoding, { localPath: string; cdnUrl: string }> = {
    'o200k_base': {
      localPath: 'aily-chat/tiktoken/o200k_base.json',
      cdnUrl: 'https://tiktoken.pages.dev/js/o200k_base.json',
    },
    'cl100k_base': {
      localPath: 'aily-chat/tiktoken/cl100k_base.json',
      cdnUrl: 'https://tiktoken.pages.dev/js/cl100k_base.json',
    },
  };

  /** 长文本分段阈值（超过此长度时分段编码，避免阻塞主线程） */
  private static readonly CHUNK_THRESHOLD = 50000;

  /** 分段大小 */
  private static readonly CHUNK_SIZE = 20000;

  /** 缓存 key 截断长度（避免超长文本作为 key） */
  private static readonly CACHE_KEY_MAX_LENGTH = 500;

  /** 长文本阈值：超过此长度优先使用 Worker 异步计数（避免阻塞主线程） */
  private static readonly WORKER_OFFLOAD_THRESHOLD = 10000;

  /** tiktoken 实例（懒加载） */
  private encoder: TiktokenInstance | null = null;

  /** 当前编码器名称 */
  private currentEncoding: TiktokenEncoding = TiktokenService.DEFAULT_ENCODING;

  /** 加载状态 */
  private loadingPromise: Promise<void> | null = null;
  private loadFailed = false;

  /** 已加载的编码器缓存（避免切换模型时重复加载） */
  private encoderCache = new Map<TiktokenEncoding, TiktokenInstance>();

  /** token 计数缓存（参考 Copilot BPETokenizer 的 5000 项 LRU 缓存） */
  private cache = new TokenCountCache(5000);

  // ==================== Web Worker 异步计数（参考 Copilot TokenizerProvider） ====================

  /** Worker 实例 */
  private worker: Worker | null = null;
  /** Worker 是否就绪 */
  private workerReady = false;
  /** Worker 请求 ID 计数器 */
  private workerRequestId = 0;
  /** Worker 待处理的 Promise 回调 */
  private pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  /** 统计信息 */
  private stats = {
    exactCount: 0,
    fallbackCount: 0,
    cacheHits: 0,
  };

  constructor() {
    // 立即触发后台加载
    this.ensureLoaded();
  }

  // ==================== 公共接口 ====================

  /**
   * 计算文本的 token 数
   *
   * - tiktoken 已加载时返回精确值
   * - 未加载时使用启发式估算（误差约 ±15%）
   * - 短文本走 LRU 缓存
   */
  countTokens(text: string): number {
    if (!text) return 0;

    // 缓存查找（仅对短文本缓存，长文本直接计算）
    if (text.length <= TiktokenService.CACHE_KEY_MAX_LENGTH) {
      const cached = this.cache.get(text);
      if (cached !== undefined) {
        this.stats.cacheHits++;
        return cached;
      }
    }

    let count: number;
    if (this.encoder) {
      count = this.encodeCount(text);
      this.stats.exactCount++;
    } else {
      count = estimateTokensFallback(text);
      this.stats.fallbackCount++;
    }

    // 缓存结果
    if (text.length <= TiktokenService.CACHE_KEY_MAX_LENGTH) {
      this.cache.set(text, count);
    }

    return count;
  }

  /**
   * 编码文本为 token 数组
   * 仅在 tiktoken 已加载时有效，否则返回空数组
   */
  encode(text: string): number[] {
    if (!text || !this.encoder) return [];
    return this.encoder.encode(text);
  }

  /**
   * 解码 token 数组为文本
   */
  decode(tokens: number[]): string {
    if (!tokens || !this.encoder) return '';
    return this.encoder.decode(tokens);
  }

  /**
   * tiktoken 是否已就绪（精确模式）
   */
  get isReady(): boolean {
    return this.encoder !== null;
  }

  /**
   * 是否正在加载
   */
  get isLoading(): boolean {
    return this.loadingPromise !== null && !this.encoder && !this.loadFailed;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * 等待 tiktoken 加载完成
   * 可用于需要精确 token 计数的场景
   */
  async waitForReady(): Promise<boolean> {
    await this.ensureLoaded();
    return this.encoder !== null;
  }

  /**
   * P11: 根据模型名称切换编码器
   *
   * 参考 Copilot 双编码器策略：
   *   - GPT-3.5/4 → cl100k_base
   *   - GPT-4o/Claude/DeepSeek/Qwen → o200k_base
   *
   * 切换时优先使用缓存的编码器实例（热切换），
   * 未缓存时异步加载新编码器。
   *
   * @param modelName 模型名称（如 'gpt-4o', 'claude-3-sonnet' 等）
   */
  async switchEncoderForModel(modelName: string | null): Promise<void> {
    const targetEncoding = this.resolveEncoding(modelName);
    if (targetEncoding === this.currentEncoding && this.encoder) {
      return; // 已经是正确的编码器
    }

    // 优先从缓存中获取
    const cached = this.encoderCache.get(targetEncoding);
    if (cached) {
      this.encoder = cached;
      this.currentEncoding = targetEncoding;
      this.cache.clear(); // 编码器切换后缓存失效
      console.log(`[TikToken] 编码器热切换: ${this.currentEncoding} → ${targetEncoding}（缓存命中）`);
      return;
    }

    // 缓存未命中，加载新编码器
    const previousEncoding = this.currentEncoding;
    this.currentEncoding = targetEncoding;
    this.loadFailed = false;
    this.loadingPromise = null;
    await this.ensureLoaded();

    if (this.encoder) {
      console.log(`[TikToken] 编码器切换: ${previousEncoding} → ${targetEncoding}`);
    }
  }

  /**
   * 获取当前使用的编码器名称
   */
  get encodingName(): TiktokenEncoding {
    return this.currentEncoding;
  }

  /**
   * 根据模型名称解析应使用的编码器
   */
  private resolveEncoding(modelName: string | null): TiktokenEncoding {
    if (!modelName) return TiktokenService.DEFAULT_ENCODING;
    const lower = modelName.toLowerCase();
    for (const { pattern, encoding } of TiktokenService.MODEL_ENCODING_MAP) {
      if (lower.includes(pattern)) return encoding;
    }
    return TiktokenService.DEFAULT_ENCODING;
  }

  // ==================== 异步计数接口（Worker 卸载） ====================

  /**
   * 异步计算文本的 token 数
   *
   * 参考 Copilot TokenizerProvider 的 Worker 异步架构：
   *   - 短文本（< WORKER_OFFLOAD_THRESHOLD）：同步计算（走缓存 + 主线程编码）
   *   - 长文本：Worker 可用时卸载到后台线程，否则回退同步
   *
   * @param text 要计数的文本
   * @returns token 数
   */
  async countTokensAsync(text: string): Promise<number> {
    if (!text) return 0;

    // 短文本直接同步计算（缓存 + 主线程，不值得 Worker 通信开销）
    if (text.length < TiktokenService.WORKER_OFFLOAD_THRESHOLD) {
      return this.countTokens(text);
    }

    // 长文本优先使用 Worker
    if (this.workerReady && this.worker) {
      return this.sendWorkerRequest('countTokens', { text });
    }

    // Worker 不可用，回退同步
    return this.countTokens(text);
  }

  /**
   * 批量异步计算多条文本的 token 数
   *
   * 参考 Copilot: 在渲染提示词时会一次性计算所有组件的 token 数，
   * 批量发送到 Worker 减少通信开销。
   *
   * @param items 要计数的项，每项包含 id 和 text
   * @returns id → token 数 的映射
   */
  async countBatchAsync(items: Array<{ id: string; text: string }>): Promise<Map<string, number>> {
    if (!items || items.length === 0) return new Map();

    // Worker 可用时批量处理
    if (this.workerReady && this.worker) {
      const results: Record<string, number> = await this.sendWorkerRequest('countBatch', { items });
      return new Map(Object.entries(results));
    }

    // Worker 不可用，回退同步计算
    const map = new Map<string, number>();
    for (const item of items) {
      map.set(item.id, this.countTokens(item.text));
    }
    return map;
  }

  /**
   * Worker 是否就绪
   */
  get isWorkerReady(): boolean {
    return this.workerReady;
  }

  // ==================== 内部方法 ====================

  /**
   * 使用 tiktoken 编码并计算 token 数
   * 长文本分段编码，避免阻塞
   */
  private encodeCount(text: string): number {
    if (!this.encoder) return estimateTokensFallback(text);

    // 短文本直接编码
    if (text.length <= TiktokenService.CHUNK_THRESHOLD) {
      return this.encoder.encode(text).length;
    }

    // 长文本分段编码
    let total = 0;
    for (let i = 0; i < text.length; i += TiktokenService.CHUNK_SIZE) {
      const chunk = text.substring(i, i + TiktokenService.CHUNK_SIZE);
      total += this.encoder.encode(chunk).length;
    }
    return total;
  }

  /**
   * 确保 tiktoken 编码器已加载（幂等）
   */
  private ensureLoaded(): Promise<void> {
    if (this.encoder) return Promise.resolve();
    if (this.loadFailed) return Promise.resolve();
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = this.loadEncoder();
    return this.loadingPromise;
  }

  /**
   * 加载 tiktoken 编码器
   * 混合模式：本地 assets 优先，CDN 回退
   */
  private async loadEncoder(): Promise<void> {
    try {
      // 动态 import js-tiktoken/lite（tree-shaking 友好）
      const { Tiktoken } = await import('js-tiktoken/lite');

      let rankData: TiktokenBPE | null = null;
      const config = TiktokenService.ENCODING_CONFIGS[this.currentEncoding];

      // 1. 尝试从本地 assets 加载
      try {
        rankData = await this.fetchRankData(config.localPath);
        console.log(`[TikToken] ${this.currentEncoding} BPE rank 数据已从本地加载`);
      } catch {
        console.log(`[TikToken] 本地加载 ${this.currentEncoding} 失败，回退到 CDN...`);
      }

      // 2. 回退到 CDN
      if (!rankData) {
        try {
          rankData = await this.fetchRankData(config.cdnUrl);
          console.log(`[TikToken] ${this.currentEncoding} BPE rank 数据已从 CDN 加载`);
        } catch (err) {
          console.warn(`[TikToken] ${this.currentEncoding} CDN 加载也失败:`, err);
        }
      }

      if (!rankData) {
        console.warn(`[TikToken] 无法加载 ${this.currentEncoding} BPE rank 数据，将持续使用启发式估算`);
        this.loadFailed = true;
        return;
      }

      // 3. 创建编码器实例并缓存
      const encoder = new Tiktoken(rankData);
      this.encoder = encoder;
      this.encoderCache.set(this.currentEncoding, encoder);
      this.loadFailed = false;
      this.cache.clear(); // 编码器变更后清空 token 缓存

      console.log(`[TikToken] ${this.currentEncoding} 编码器已就绪（精确模式）`);

      // 4. 初始化 Web Worker（非阻塞，失败不影响主流程）
      this.initWorker(rankData);
    } catch (err) {
      console.warn('[TikToken] 编码器加载失败:', err);
      this.loadFailed = true;
    } finally {
      this.loadingPromise = null;
    }
  }

  /**
   * 获取 BPE rank 数据
   */
  private async fetchRankData(url: string): Promise<TiktokenBPE> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  // ==================== Web Worker 管理 ====================

  /**
   * 初始化 Web Worker
   * 将 BPE rank 数据发送给 Worker，让它也创建自己的 Tiktoken 实例
   */
  private initWorker(rankData: TiktokenBPE): void {
    try {
      this.worker = new Worker(
        new URL('../workers/tiktoken.worker.ts', import.meta.url),
        { type: 'module' }
      );

      this.worker.addEventListener('message', (event: MessageEvent) => {
        const { id, result, error } = event.data;
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          if (error) {
            pending.reject(new Error(error));
          } else {
            pending.resolve(result);
          }
        }
      });

      this.worker.addEventListener('error', (error) => {
        console.warn('[TikToken Worker] 错误:', error.message);
        this.workerReady = false;
        // 拒绝所有待处理请求
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error('Worker error'));
          this.pendingRequests.delete(id);
        }
      });

      // 发送初始化消息
      this.sendWorkerRequest('init', { rankData }).then(
        () => {
          this.workerReady = true;
          console.log('[TikToken Worker] 已就绪（异步模式）');
        },
        (err) => {
          console.warn('[TikToken Worker] 初始化失败:', err);
          this.workerReady = false;
        }
      );
    } catch (err) {
      console.warn('[TikToken Worker] 创建失败（不影响同步计数）:', err);
    }
  }

  /**
   * 发送请求到 Worker 并等待响应
   */
  private sendWorkerRequest(type: string, payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not available'));
        return;
      }
      const id = ++this.workerRequestId;
      this.pendingRequests.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }
}
