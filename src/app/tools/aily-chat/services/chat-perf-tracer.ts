/**
 * ChatPerformanceTracer — 可切换的流式对话性能诊断工具
 *
 * 用法：
 *   在浏览器 DevTools Console 中：
 *     (window as any).__AILY_PERF_TRACE = true;   // 开启跟踪
 *     (window as any).__AILY_PERF_TRACE = false;  // 关闭跟踪
 *     ChatPerformanceTracer.dump();                // 打印最近 200 个事件
 *     ChatPerformanceTracer.dumpSlow(5);           // 打印耗时 > 5ms 的事件
 *     ChatPerformanceTracer.reset();               // 清空日志
 *
 * 诊断重点：
 *   - SSE 事件到达时间
 *   - doFlush / flushNow 延迟
 *   - x-dialog preprocess rAF 延迟
 *   - tool 执行耗时
 *   - startChatTurn 各阶段耗时
 */

interface TraceEntry {
  tag: string;
  phase: 'start' | 'end';
  t: number;            // performance.now()
  detail?: string;
}

const MAX_LOG = 5000;
const log: TraceEntry[] = [];
/** 关键事件独立 buffer — 不被高频 streaming 事件覆盖 */
const KEY_MAX = 500;
const keyLog: TraceEntry[] = [];
/** 高频标签集 — 这些 tag 不写入 keyLog */
const HIGH_FREQ_TAGS = new Set(['sse_chunk', 'preprocess_rAF_scheduled']);
let seqId = 0;

function isEnabled(): boolean {
  try { return !!(globalThis as any).__AILY_PERF_TRACE; } catch { return false; }
}

function isHighFreq(tag: string): boolean {
  if (HIGH_FREQ_TAGS.has(tag)) return true;
  // doFlush / preprocess_rAF_exec 带有 [id] 前缀
  const inner = tag.includes('] ') ? tag.slice(tag.indexOf('] ') + 2) : tag;
  return inner === 'doFlush' || inner === 'preprocess_rAF_exec';
}

function pushEntry(entry: TraceEntry): void {
  log.push(entry);
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
  if (!isHighFreq(entry.tag)) {
    keyLog.push(entry);
    if (keyLog.length > KEY_MAX) keyLog.splice(0, keyLog.length - KEY_MAX);
  }
}

export class ChatPerformanceTracer {

  // ─── 动态扩展方法（Console 调用） ───
  static startLongTaskObserver: () => void;
  static stopLongTaskObserver: () => void;
  static dumpLongTasks: () => void;

  // ─── 核心 API ───

  /** 开始一个命名 span，返回 spanId */
  static begin(tag: string, detail?: string): number {
    if (!isEnabled()) return -1;
    const id = ++seqId;
    pushEntry({ tag: `[${id}] ${tag}`, phase: 'start', t: performance.now(), detail });
    return id;
  }

  /** 结束一个命名 span */
  static end(spanId: number, tag: string, detail?: string): void {
    if (!isEnabled() || spanId < 0) return;
    pushEntry({ tag: `[${spanId}] ${tag}`, phase: 'end', t: performance.now(), detail });
  }

  /** 打点（无 start/end 对） */
  static mark(tag: string, detail?: string): void {
    if (!isEnabled()) return;
    pushEntry({ tag, phase: 'start', t: performance.now(), detail });
  }

  // ─── 输出与调试 ───

  /** 打印最近的全部事件日志 */
  static dump(count = 500): void {
    const entries = log.slice(-count);
    if (entries.length === 0) { console.log('[PerfTracer] 无记录'); return; }

    const t0 = entries[0].t;
    const rows = entries.map(e => ({
      '∆ms': +(e.t - t0).toFixed(2),
      'phase': e.phase,
      'tag': e.tag,
      'detail': e.detail || '',
    }));
    console.table(rows);
  }

  /**
   * 打印关键事件（工具调用、startChatTurn 阶段、LONG_TASK 等）
   * 不含高频 streaming 事件（sse_chunk / doFlush / preprocess），定位卡顿首选
   */
  static dumpKey(count = 200): void {
    const entries = keyLog.slice(-count);
    if (entries.length === 0) { console.log('[PerfTracer] 无关键事件'); return; }

    const t0 = entries[0].t;
    const rows = entries.map(e => ({
      '∆ms': +(e.t - t0).toFixed(2),
      'phase': e.phase,
      'tag': e.tag,
      'detail': e.detail || '',
    }));
    console.table(rows);
  }

  /** 打印 超过阈值（ms）的 span */
  static dumpSlow(thresholdMs = 3): void {
    const starts = new Map<string, number>();
    const slow: Array<{ tag: string; ms: number; detail?: string }> = [];

    for (const e of log) {
      if (e.phase === 'start') { starts.set(e.tag, e.t); }
      else if (e.phase === 'end') {
        const s = starts.get(e.tag);
        if (s !== undefined) {
          const ms = e.t - s;
          if (ms >= thresholdMs) { slow.push({ tag: e.tag, ms: +ms.toFixed(2), detail: e.detail }); }
          starts.delete(e.tag);
        }
      }
    }

    if (slow.length === 0) { console.log(`[PerfTracer] 无 > ${thresholdMs}ms 的 span`); return; }
    slow.sort((a, b) => b.ms - a.ms);
    console.table(slow);
  }

  /** 清空日志 */
  static reset(): void { log.length = 0; keyLog.length = 0; seqId = 0; }
}

// 暴露到全局方便 Console 调用
try { (globalThis as any).ChatPerformanceTracer = ChatPerformanceTracer; } catch {}

/**
 * LongTaskObserver — 使用 PerformanceObserver 捕获 > 50ms 的 long task
 * 需要浏览器支持 PerformanceObserver + 'longtask' entry type
 *
 * 用法：
 *   ChatPerformanceTracer.startLongTaskObserver();   // 开始监听
 *   ChatPerformanceTracer.stopLongTaskObserver();    // 停止
 *   ChatPerformanceTracer.dumpLongTasks();           // 打印捕获的长任务
 */
let longTaskObserver: PerformanceObserver | null = null;
const longTasks: Array<{ start: number; duration: number; name: string }> = [];

ChatPerformanceTracer.startLongTaskObserver = function(): void {
  if (longTaskObserver) return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({
          start: entry.startTime,
          duration: entry.duration,
          name: entry.name || 'self',
        });
        if (isEnabled()) {
          ChatPerformanceTracer.mark('LONG_TASK', `${entry.duration.toFixed(1)}ms`);
        }
        // keep last 200
        if (longTasks.length > 200) longTasks.splice(0, longTasks.length - 200);
      }
    });
    longTaskObserver.observe({ type: 'longtask', buffered: true });
    console.log('[PerfTracer] LongTask observer started');
  } catch (e) {
    console.warn('[PerfTracer] LongTask observer not supported:', e);
  }
};

ChatPerformanceTracer.stopLongTaskObserver = function(): void {
  if (longTaskObserver) {
    longTaskObserver.disconnect();
    longTaskObserver = null;
    console.log('[PerfTracer] LongTask observer stopped');
  }
};

ChatPerformanceTracer.dumpLongTasks = function(): void {
  if (longTasks.length === 0) { console.log('[PerfTracer] 无 long task 记录'); return; }
  console.table(longTasks.map(t => ({
    'start(ms)': +t.start.toFixed(1),
    'duration(ms)': +t.duration.toFixed(1),
    'name': t.name,
  })));
};
