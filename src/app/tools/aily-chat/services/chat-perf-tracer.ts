/**
 * ChatPerformanceTracer — 可切换的流式对话性能诊断工具
 *
 * 用法：
 *   在浏览器 DevTools Console 中：
 *     ChatPerformanceTracer.enable();             // 开启跟踪
 *     ChatPerformanceTracer.disable();            // 关闭跟踪
 *     ChatPerformanceTracer.dump();                // 打印 bounded 摘要
 *     ChatPerformanceTracer.dump(40);              // 打印最近 40 个事件明细
 *     ChatPerformanceTracer.dumpSlow(5);           // 打印耗时 > 5ms 的摘要
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

interface JankSnapshotEntry {
  label: string;
  t: number;
  data: Record<string, unknown>;
}

interface RenderEventSnapshotEntry {
  label: string;
  t: number;
  data: Record<string, unknown>;
}

export type ChatPerformanceOperationSurface =
  | 'unknown'
  | 'endpoint_stream'
  | 'agent_loop'
  | 'live_transcript'
  | 'terminal_transcript'
  | 'runtime_metadata'
  | 'chat_projection'
  | 'session_list'
  | 'detail_hydration'
  | 'history_save'
  | 'workspace_finalize'
  | 'session_save'
  | 'builder_preprocess'
  | 'editor_operation';

interface OperationSurfaceEntry {
  surface: ChatPerformanceOperationSurface;
  t: number;
  detail?: string;
}

interface EventLoopLagEntry {
  t: number;
  lagMs: number;
  surface: ChatPerformanceOperationSurface;
  detail?: string;
}

export interface ChatPerformanceTraceEntry {
  readonly tag: string;
  readonly phase: 'start' | 'end';
  readonly t: number;
  readonly detail?: string;
}

export interface ChatPerformanceStateSnapshot {
  readonly activeSurface: ChatPerformanceOperationSurface;
  readonly activeSurfaceDetail?: string;
  readonly counters: Record<string, number>;
  readonly recentKeyEvents: readonly ChatPerformanceTraceEntry[];
  readonly recentRenderEvents: readonly Readonly<Record<string, unknown>>[];
  readonly recentJankSnapshots: readonly Readonly<Record<string, unknown>>[];
  readonly recentSurfaceEvents: readonly Readonly<Record<string, unknown>>[];
  readonly recentEventLoopLag: readonly Readonly<Record<string, unknown>>[];
  readonly externalSnapshots: Readonly<Record<string, unknown>>;
  readonly longTasks: {
    readonly count: number;
    readonly totalMs: number;
    readonly maxMs: number;
    readonly recent20TotalMs: number;
    readonly recent20MaxMs: number;
  };
}

const ENTRY_OPEN_TRACE_FLAG = 'aily.chat.traceEntryOpenPerformance';
const DETAIL_DUMP_TRACE_FLAG = 'aily.chat.traceDetailDump';
const JANK_DETAIL_DUMP_TRACE_FLAG = 'aily.chat.traceJankDetailDump';
const ENTRY_OPEN_TRACE_GLOBAL_KEYS = [
  '__AILY_CHAT_TRACE_ENTRY_OPEN_PERFORMANCE__',
  'AILY_CHAT_TRACE_ENTRY_OPEN_PERFORMANCE',
  '__AILY_PERF_TRACE',
  'AILY_PERF_TRACE',
] as const;
const DETAIL_DUMP_TRACE_GLOBAL_KEYS = [
  '__AILY_CHAT_TRACE_DETAIL_DUMP__',
  'AILY_CHAT_TRACE_DETAIL_DUMP',
  '__AILY_PERF_TRACE_DETAIL__',
  'AILY_PERF_TRACE_DETAIL',
] as const;
const JANK_DETAIL_DUMP_TRACE_GLOBAL_KEYS = [
  '__AILY_CHAT_TRACE_JANK_DETAIL_DUMP__',
  'AILY_CHAT_TRACE_JANK_DETAIL_DUMP',
  '__AILY_PERF_TRACE_JANK_DETAIL__',
  'AILY_PERF_TRACE_JANK_DETAIL',
] as const;

const MAX_LOG = 5000;
const log: TraceEntry[] = [];
/** 关键事件独立 buffer — 不被高频 streaming 事件覆盖 */
const KEY_MAX = 500;
const keyLog: TraceEntry[] = [];
const SNAPSHOT_MAX = 80;
const jankSnapshots: JankSnapshotEntry[] = [];
const RENDER_EVENT_MAX = 100;
const renderEventSnapshots: RenderEventSnapshotEntry[] = [];
const SURFACE_SAMPLE_MAX = 300;
const surfaceStack: OperationSurfaceEntry[] = [];
const surfaceEvents: Array<OperationSurfaceEntry & { event: 'enter' | 'exit'; durationMs?: number }> = [];
const EVENT_LOOP_LAG_MAX = 200;
const eventLoopLagSamples: EventLoopLagEntry[] = [];
const counters = new Map<string, number>();
export type ChatPerformanceExternalSnapshotProvider = () => unknown;
const externalSnapshotProviders = new Map<string, ChatPerformanceExternalSnapshotProvider>();
/** 高频标签集 — 这些 tag 不写入 keyLog */
const HIGH_FREQ_TAGS = new Set(['sse_chunk', 'preprocess_rAF_scheduled']);
const JANK_CONTEXT_MIN_INTERVAL_MS = 1000;
let seqId = 0;
let lastJankContextDumpAt = 0;
const printedDetailHints = new Set<string>();
let detailTableSuppressionDepth = 0;
let eventLoopLagSamplerHandle: ReturnType<typeof setInterval> | null = null;
let eventLoopLagLastTick = 0;

function parseTraceFlag(value: unknown): boolean {
  if (value === true || value === 1) {
    return true;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
  }
  return false;
}

function isEnabled(): boolean {
  try {
    const runtime = globalThis as Record<string, unknown>;
    for (const key of ENTRY_OPEN_TRACE_GLOBAL_KEYS) {
      if (parseTraceFlag(runtime[key])) {
        return true;
      }
    }
    return parseTraceFlag(globalThis.localStorage?.getItem?.(ENTRY_OPEN_TRACE_FLAG));
  } catch {
    return false;
  }
}

function isDetailDumpEnabled(): boolean {
  if (detailTableSuppressionDepth > 0) {
    return false;
  }
  try {
    const runtime = globalThis as Record<string, unknown>;
    for (const key of DETAIL_DUMP_TRACE_GLOBAL_KEYS) {
      if (parseTraceFlag(runtime[key])) {
        return true;
      }
    }
    return parseTraceFlag(globalThis.localStorage?.getItem?.(DETAIL_DUMP_TRACE_FLAG));
  } catch {
    return false;
  }
}

function isJankDetailDumpEnabled(): boolean {
  try {
    const runtime = globalThis as Record<string, unknown>;
    for (const key of JANK_DETAIL_DUMP_TRACE_GLOBAL_KEYS) {
      if (parseTraceFlag(runtime[key])) {
        return true;
      }
    }
    return parseTraceFlag(globalThis.localStorage?.getItem?.(JANK_DETAIL_DUMP_TRACE_FLAG));
  } catch {
    return false;
  }
}

function withSuppressedDetailTables(operation: () => void): void {
  detailTableSuppressionDepth++;
  try {
    operation();
  } finally {
    detailTableSuppressionDepth = Math.max(0, detailTableSuppressionDepth - 1);
  }
}

function shouldPrintDetailTable(count: number | undefined): boolean {
  return typeof count === 'number'
    && Number.isFinite(count)
    && count > 0
    && isDetailDumpEnabled();
}

function printDetailHint(methodName: string): void {
  if (detailTableSuppressionDepth > 0) {
    return;
  }
  if (printedDetailHints.has(methodName)) {
    return;
  }
  printedDetailHints.add(methodName);
  console.log(`[PerfTracer] ${methodName} detail tables are disabled. Set localStorage.${DETAIL_DUMP_TRACE_FLAG} = "1" or global __AILY_PERF_TRACE_DETAIL__ = true for a short sampling window.`);
}

function printJankDetailHint(): void {
  const hintKey = 'dumpJankContext:jank-detail';
  if (printedDetailHints.has(hintKey)) {
    return;
  }
  printedDetailHints.add(hintKey);
  console.log(`[PerfTracer] dumpJankContext detail tables are disabled. Set localStorage.${JANK_DETAIL_DUMP_TRACE_FLAG} = "1" or global __AILY_PERF_TRACE_JANK_DETAIL__ = true for a short sampling window.`);
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

function pushSurfaceEvent(entry: OperationSurfaceEntry & { event: 'enter' | 'exit'; durationMs?: number }): void {
  surfaceEvents.push(entry);
  if (surfaceEvents.length > SURFACE_SAMPLE_MAX) {
    surfaceEvents.splice(0, surfaceEvents.length - SURFACE_SAMPLE_MAX);
  }
}

function pushEventLoopLagSample(entry: EventLoopLagEntry): void {
  eventLoopLagSamples.push(entry);
  if (eventLoopLagSamples.length > EVENT_LOOP_LAG_MAX) {
    eventLoopLagSamples.splice(0, eventLoopLagSamples.length - EVENT_LOOP_LAG_MAX);
  }
}

function currentSurfaceEntry(): OperationSurfaceEntry | undefined {
  return surfaceStack.length > 0 ? surfaceStack[surfaceStack.length - 1] : undefined;
}

function normalizeSurface(surface: ChatPerformanceOperationSurface | string): ChatPerformanceOperationSurface {
  switch (surface) {
    case 'endpoint_stream':
    case 'agent_loop':
    case 'live_transcript':
    case 'terminal_transcript':
    case 'runtime_metadata':
    case 'chat_projection':
    case 'session_list':
    case 'detail_hydration':
    case 'history_save':
    case 'workspace_finalize':
    case 'session_save':
    case 'builder_preprocess':
    case 'editor_operation':
      return surface;
    default:
      return 'unknown';
  }
}

function normalizeExternalSnapshotName(name: string): string {
  return String(name ?? '')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 80);
}

function snapshotExternalSnapshots(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, provider] of externalSnapshotProviders.entries()) {
    try {
      result[name] = provider();
    } catch (error) {
      result[name] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return result;
}

export class ChatPerformanceTracer {

  // ─── 动态扩展方法（Console 调用） ───
  static startLongTaskObserver: () => void;
  static stopLongTaskObserver: () => void;
  static dumpLongTasks: (count?: number) => void;
  static dumpJankContext: (count?: number) => void;
  static dumpPerformanceStateSummary: () => void;

  // ─── 核心 API ───

  static isEnabled(): boolean {
    return isEnabled();
  }

  static currentSurface(): ChatPerformanceOperationSurface {
    return currentSurfaceEntry()?.surface ?? 'unknown';
  }

  static registerExternalSnapshotProvider(
    name: string,
    provider: ChatPerformanceExternalSnapshotProvider,
  ): { dispose(): void } {
    const normalizedName = normalizeExternalSnapshotName(name);
    if (!normalizedName || typeof provider !== 'function') {
      return { dispose: () => undefined };
    }
    externalSnapshotProviders.set(normalizedName, provider);
    return {
      dispose: () => {
        if (externalSnapshotProviders.get(normalizedName) === provider) {
          externalSnapshotProviders.delete(normalizedName);
        }
      },
    };
  }

  static enterSurface(
    surface: ChatPerformanceOperationSurface | string,
    detail?: string,
  ): { dispose(): void } {
    const normalizedSurface = normalizeSurface(surface);
    const entry: OperationSurfaceEntry = {
      surface: normalizedSurface,
      t: performance.now(),
      ...(detail ? { detail } : {}),
    };
    surfaceStack.push(entry);
    this.increment(`surface.${normalizedSurface}.enter`);
    pushSurfaceEvent({ ...entry, event: 'enter' });

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        const now = performance.now();
        const stackIndex = surfaceStack.lastIndexOf(entry);
        if (stackIndex >= 0) {
          surfaceStack.splice(stackIndex, 1);
        }
        const durationMs = now - entry.t;
        this.increment(`surface.${normalizedSurface}.exit`);
        this.recordDuration(
          `surface_${normalizedSurface}`,
          durationMs,
          detail,
          { slowThresholdMs: 24 },
        );
        pushSurfaceEvent({
          surface: normalizedSurface,
          t: now,
          ...(detail ? { detail } : {}),
          event: 'exit',
          durationMs: +durationMs.toFixed(1),
        });
      },
    };
  }

  static runWithSurface<T>(
    surface: ChatPerformanceOperationSurface | string,
    operation: () => T,
    detail?: string,
  ): T {
    const scope = this.enterSurface(surface, detail);
    try {
      const result = operation();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        return (result as PromiseLike<unknown>).then(
          value => {
            scope.dispose();
            return value;
          },
          error => {
            scope.dispose();
            throw error;
          },
        ) as T;
      }
      scope.dispose();
      return result;
    } catch (error) {
      scope.dispose();
      throw error;
    }
  }

  static startEventLoopLagSampler(options: {
    readonly intervalMs?: number;
    readonly thresholdMs?: number;
  } = {}): void {
    this.enable();
    if (eventLoopLagSamplerHandle) {
      return;
    }
    const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs! > 0
      ? Math.max(50, Math.floor(options.intervalMs!))
      : 250;
    const thresholdMs = Number.isFinite(options.thresholdMs) && options.thresholdMs! > 0
      ? Math.max(16, Math.floor(options.thresholdMs!))
      : 50;
    eventLoopLagLastTick = performance.now();
    eventLoopLagSamplerHandle = setInterval(() => {
      const now = performance.now();
      const lagMs = now - eventLoopLagLastTick - intervalMs;
      eventLoopLagLastTick = now;
      if (lagMs < thresholdMs) {
        return;
      }
      const surface = currentSurfaceEntry();
      const activeSurface = surface?.surface ?? 'unknown';
      this.increment(`eventLoopLag.${activeSurface}.count`);
      this.increment(`eventLoopLag.${activeSurface}.totalMs`, Math.round(lagMs));
      pushEventLoopLagSample({
        t: now,
        lagMs: +lagMs.toFixed(1),
        surface: activeSurface,
        ...(surface?.detail ? { detail: surface.detail } : {}),
      });
      this.recordJankSnapshot('event_loop_lag', {
        lagMs: +lagMs.toFixed(1),
        surface: activeSurface,
        detail: surface?.detail,
      });
    }, intervalMs);
  }

  static stopEventLoopLagSampler(): void {
    if (!eventLoopLagSamplerHandle) {
      return;
    }
    clearInterval(eventLoopLagSamplerHandle);
    eventLoopLagSamplerHandle = null;
    eventLoopLagLastTick = 0;
  }

  static enable(): void {
    try {
      (globalThis as Record<string, unknown>)['__AILY_PERF_TRACE'] = true;
      globalThis.localStorage?.setItem?.(ENTRY_OPEN_TRACE_FLAG, '1');
    } catch {}
  }

  static enableDetailDump(): void {
    try {
      (globalThis as Record<string, unknown>)['__AILY_PERF_TRACE_DETAIL'] = true;
      globalThis.localStorage?.setItem?.(DETAIL_DUMP_TRACE_FLAG, '1');
    } catch {}
  }

  static enableJankDetailDump(): void {
    try {
      (globalThis as Record<string, unknown>)['__AILY_PERF_TRACE_JANK_DETAIL'] = true;
      globalThis.localStorage?.setItem?.(JANK_DETAIL_DUMP_TRACE_FLAG, '1');
    } catch {}
  }

  static disableJankDetailDump(): void {
    try {
      (globalThis as Record<string, unknown>)['__AILY_PERF_TRACE_JANK_DETAIL'] = false;
      globalThis.localStorage?.removeItem?.(JANK_DETAIL_DUMP_TRACE_FLAG);
    } catch {}
  }

  static disableDetailDump(): void {
    try {
      (globalThis as Record<string, unknown>)['__AILY_PERF_TRACE_DETAIL'] = false;
      globalThis.localStorage?.removeItem?.(DETAIL_DUMP_TRACE_FLAG);
    } catch {}
  }

  static disable(): void {
    try {
      (globalThis as Record<string, unknown>)['__AILY_PERF_TRACE'] = false;
      globalThis.localStorage?.removeItem?.(ENTRY_OPEN_TRACE_FLAG);
    } catch {}
  }

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

  static increment(counter: string, delta = 1): void {
    if (!isEnabled() || typeof counter !== 'string' || counter.trim().length === 0) {
      return;
    }
    const normalizedDelta = Number.isFinite(delta) ? delta : 1;
    counters.set(counter, (counters.get(counter) ?? 0) + normalizedDelta);
  }

  static recordDuration(
    tag: string,
    durationMs: number,
    detail?: string,
    options: { readonly slowThresholdMs?: number; readonly counterPrefix?: string } = {},
  ): void {
    if (!isEnabled() || typeof tag !== 'string' || tag.trim().length === 0 || !Number.isFinite(durationMs)) {
      return;
    }

    const normalizedTag = tag.trim();
    const prefix = options.counterPrefix || `duration.${normalizedTag}`;
    this.increment(`${prefix}.count`);
    this.increment(`${prefix}.totalMs`, Math.max(0, Math.round(durationMs)));

    const slowThresholdMs = Number.isFinite(options.slowThresholdMs) ? options.slowThresholdMs! : 16;
    if (durationMs >= slowThresholdMs) {
      this.increment(`${prefix}.slow`);
      this.mark(
        `SLOW ${normalizedTag}`,
        `${durationMs.toFixed(1)}ms${detail ? ` ${detail}` : ''}`,
      );
    }
  }

  static recordJankSnapshot(label: string, data: Record<string, unknown>): void {
    if (!isEnabled() || typeof label !== 'string' || label.trim().length === 0) {
      return;
    }
    const activeSurface = currentSurfaceEntry();
    jankSnapshots.push({
      label: label.trim(),
      t: performance.now(),
      data: sanitizeSnapshotData({
        activeSurface: activeSurface?.surface ?? 'unknown',
        ...(activeSurface?.detail ? { activeSurfaceDetail: activeSurface.detail } : {}),
        ...data,
      }),
    });
    if (jankSnapshots.length > SNAPSHOT_MAX) {
      jankSnapshots.splice(0, jankSnapshots.length - SNAPSHOT_MAX);
    }
  }

  static recordRenderEvent(label: string, data: Record<string, unknown>): void {
    if (!isEnabled() || typeof label !== 'string' || label.trim().length === 0) {
      return;
    }

    renderEventSnapshots.push({
      label: label.trim(),
      t: performance.now(),
      data: sanitizeSnapshotData(data),
    });
    if (renderEventSnapshots.length > RENDER_EVENT_MAX) {
      renderEventSnapshots.splice(0, renderEventSnapshots.length - RENDER_EVENT_MAX);
    }
  }

  static snapshotCounters(): Record<string, number> {
    return Object.fromEntries(counters.entries());
  }

  static snapshotEntries(options: { readonly keyOnly?: boolean; readonly tags?: readonly string[] } = {}): readonly ChatPerformanceTraceEntry[] {
    const source = options.keyOnly ? keyLog : log;
    const tagFilter = Array.isArray(options.tags) && options.tags.length > 0
      ? new Set(options.tags)
      : null;

    return source
      .filter(entry => !tagFilter || tagFilter.has(entry.tag))
      .map(entry => ({
        tag: entry.tag,
        phase: entry.phase,
        t: entry.t,
        ...(entry.detail ? { detail: entry.detail } : {}),
      }));
  }

  static snapshotRenderEvents(): readonly Readonly<Record<string, unknown>>[] {
    return renderEventSnapshots.map(entry => ({
      label: entry.label,
      t: entry.t,
      ...entry.data,
    }));
  }

  static snapshotPerformanceState(): ChatPerformanceStateSnapshot {
    const activeSurface = currentSurfaceEntry();
    return {
      activeSurface: activeSurface?.surface ?? 'unknown',
      ...(activeSurface?.detail ? { activeSurfaceDetail: activeSurface.detail } : {}),
      counters: this.snapshotCounters(),
      recentKeyEvents: this.snapshotEntries({ keyOnly: true }).slice(-80),
      recentRenderEvents: this.snapshotRenderEvents().slice(-80),
      recentJankSnapshots: jankSnapshots.slice(-80).map(entry => ({
        label: entry.label,
        t: entry.t,
        ...entry.data,
      })),
      recentSurfaceEvents: surfaceEvents.slice(-80).map(entry => ({
        surface: entry.surface,
        event: entry.event,
        t: entry.t,
        ...(entry.detail ? { detail: entry.detail } : {}),
        ...(typeof entry.durationMs === 'number' ? { durationMs: entry.durationMs } : {}),
      })),
      recentEventLoopLag: eventLoopLagSamples.slice(-80).map(entry => ({
        surface: entry.surface,
        lagMs: entry.lagMs,
        t: entry.t,
        ...(entry.detail ? { detail: entry.detail } : {}),
      })),
      externalSnapshots: snapshotExternalSnapshots(),
      longTasks: summarizeLongTasks(),
    };
  }

  // ─── 输出与调试 ───

  /** 打印最近的全部事件日志 */
  static dump(count?: number): void {
    if (log.length === 0) { console.log('[PerfTracer] 无记录'); return; }
    const recent = log.slice(-120);
    const first = recent[0];
    const last = recent[recent.length - 1];
    console.log(
      `[PerfTracer] events: count=${log.length}, recent=${recent.length}, span=${first && last ? (last.t - first.t).toFixed(1) : '0.0'}ms`,
    );

    if (!shouldPrintDetailTable(count)) {
      printDetailHint('dump');
      return;
    }

    const safeCount = Math.max(1, Math.min(Math.floor(count), 40));
    const entries = log.slice(-safeCount);

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
  static dumpKey(count?: number): void {
    if (keyLog.length === 0) { console.log('[PerfTracer] 无关键事件'); return; }
    const recent = keyLog.slice(-80);
    const first = recent[0];
    const last = recent[recent.length - 1];
    console.log(
      `[PerfTracer] key events: count=${keyLog.length}, recent=${recent.length}, span=${first && last ? (last.t - first.t).toFixed(1) : '0.0'}ms`,
    );

    if (!shouldPrintDetailTable(count)) {
      printDetailHint('dumpKey');
      return;
    }

    const safeCount = Math.max(1, Math.min(Math.floor(count), 40));
    const entries = keyLog.slice(-safeCount);

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
    const totalMs = slow.reduce((sum, entry) => sum + entry.ms, 0);
    console.log(
      `[PerfTracer] slow spans: count=${slow.length}, total=${totalMs.toFixed(1)}ms, max=${slow[0]?.ms.toFixed(1) ?? '0.0'}ms`,
    );
    if (!isDetailDumpEnabled()) {
      printDetailHint('dumpSlow');
      return;
    }
    const top = slow.slice(0, 10);
    console.table(top);
  }

  static dumpCounters(): void {
    const entries = [...counters.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([counter, value]) => ({ counter, value }));

    if (entries.length === 0) {
      console.log('[PerfTracer] 无计数器记录');
      return;
    }

    console.log(`[PerfTracer] counters: count=${entries.length}, top=${Math.min(entries.length, 20)}`);
    if (!isDetailDumpEnabled()) {
      printDetailHint('dumpCounters');
      return;
    }
    console.table(entries.slice(0, 20));
  }

  static dumpJankSnapshots(count = 20): void {
    if (jankSnapshots.length === 0) {
      console.log('[PerfTracer] 无渲染快照');
      return;
    }

    const safeCount = Math.max(1, Math.min(Math.floor(count), 40));
    const snapshots = jankSnapshots.slice(-safeCount);
    const first = snapshots[0];
    const rows = snapshots.map((entry) => ({
      'Δms': +(entry.t - first.t).toFixed(2),
      label: entry.label,
      ...entry.data,
    }));
    console.log(`[PerfTracer] jank snapshots: count=${jankSnapshots.length}, showing=${snapshots.length}`);
    if (!isDetailDumpEnabled()) {
      printDetailHint('dumpJankSnapshots');
      return;
    }
    console.table(rows);
  }

  static dumpRecentRenderEvents(count = 40): void {
    if (renderEventSnapshots.length === 0) {
      console.log('[PerfTracer] 无 render event 摘要');
      return;
    }

    const safeCount = Math.max(1, Math.min(Math.floor(count), RENDER_EVENT_MAX));
    const events = renderEventSnapshots.slice(-safeCount);
    const first = events[0];
    const rows = events.map((entry) => ({
      'Δms': +(entry.t - first.t).toFixed(2),
      label: entry.label,
      ...entry.data,
    }));
    console.log(`[PerfTracer] recent render events: count=${renderEventSnapshots.length}, showing=${events.length}`);
    if (!isDetailDumpEnabled()) {
      printDetailHint('dumpRecentRenderEvents');
      return;
    }
    console.table(rows);
  }

  /** 清空日志 */
  static reset(): void {
    log.length = 0;
    keyLog.length = 0;
    jankSnapshots.length = 0;
    renderEventSnapshots.length = 0;
    surfaceStack.length = 0;
    surfaceEvents.length = 0;
    eventLoopLagSamples.length = 0;
    counters.clear();
    printedDetailHints.clear();
    lastJankContextDumpAt = 0;
    seqId = 0;
  }
}

function sanitizeSnapshotData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (typeof value === 'string') {
      result[key] = value.length > 160 ? `${value.slice(0, 157)}...` : value;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
      result[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      result[key] = value.slice(0, 8).map((entry) => String(entry)).join(',');
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

// 暴露到全局方便 Console 调用，以及供 aily-lex 这类跨包路径做轻量归因。
try {
  (globalThis as any).ChatPerformanceTracer = ChatPerformanceTracer;
  (globalThis as any).__AILY_CHAT_PERFORMANCE__ = {
    isEnabled: () => ChatPerformanceTracer.isEnabled(),
    enterSurface: (
      surface: ChatPerformanceOperationSurface | string,
      detail?: string,
    ) => ChatPerformanceTracer.enterSurface(surface, detail),
    increment: (counter: string, delta?: number) => ChatPerformanceTracer.increment(counter, delta),
    mark: (tag: string, detail?: string) => ChatPerformanceTracer.mark(tag, detail),
    recordDuration: (
      tag: string,
      durationMs: number,
      detail?: string,
      options?: { readonly slowThresholdMs?: number; readonly counterPrefix?: string },
    ) => ChatPerformanceTracer.recordDuration(tag, durationMs, detail, options),
    snapshotPerformanceState: () => ChatPerformanceTracer.snapshotPerformanceState(),
  };
} catch {}

/**
 * LongTaskObserver — 使用 PerformanceObserver 捕获 > 50ms 的 long task
 * 需要浏览器支持 PerformanceObserver + 'longtask' entry type
 *
 * 用法：
 *   ChatPerformanceTracer.startLongTaskObserver();   // 开始监听
 *   ChatPerformanceTracer.stopLongTaskObserver();    // 停止
 *   ChatPerformanceTracer.dumpLongTasks();           // 打印长任务摘要
 *   ChatPerformanceTracer.dumpLongTasks(40);         // 打印最近 40 条长任务明细
 */
let longTaskObserver: PerformanceObserver | null = null;
const longTasks: Array<{ start: number; duration: number; name: string; attribution?: string }> = [];

function summarizeLongTasks(): ChatPerformanceStateSnapshot['longTasks'] {
  if (longTasks.length === 0) {
    return {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      recent20TotalMs: 0,
      recent20MaxMs: 0,
    };
  }
  const recent = longTasks.slice(-20);
  return {
    count: longTasks.length,
    totalMs: +longTasks.reduce((sum, task) => sum + task.duration, 0).toFixed(1),
    maxMs: +longTasks.reduce((max, task) => Math.max(max, task.duration), 0).toFixed(1),
    recent20TotalMs: +recent.reduce((sum, task) => sum + task.duration, 0).toFixed(1),
    recent20MaxMs: +recent.reduce((max, task) => Math.max(max, task.duration), 0).toFixed(1),
  };
}

ChatPerformanceTracer.startLongTaskObserver = function(): void {
  ChatPerformanceTracer.enable();
  ChatPerformanceTracer.startEventLoopLagSampler();
  if (longTaskObserver) return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const attribution = formatLongTaskAttribution(entry);
        longTasks.push({
          start: entry.startTime,
          duration: entry.duration,
          name: entry.name || 'self',
          ...(attribution ? { attribution } : {}),
        });
        if (isEnabled()) {
          ChatPerformanceTracer.mark('LONG_TASK', `${entry.duration.toFixed(1)}ms${attribution ? ` ${attribution}` : ''}`);
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
  ChatPerformanceTracer.stopEventLoopLagSampler();
};

ChatPerformanceTracer.dumpPerformanceStateSummary = function(): void {
  const snapshot = ChatPerformanceTracer.snapshotPerformanceState();
  const counters = snapshot.counters ?? {};
  const counterKeys = Object.keys(counters);
  const externalSnapshots = snapshot.externalSnapshots ?? {};
  const externalKeys = Object.keys(externalSnapshots);
  const hostLifecycle = externalSnapshots['host_item_lifecycle'] as Record<string, unknown> | undefined;
  console.log(
    '[PerfTracer] performance state:',
    {
      activeSurface: snapshot.activeSurface,
      activeSurfaceDetail: snapshot.activeSurfaceDetail ?? '',
      counters: counterKeys.length,
      recentKeyEvents: snapshot.recentKeyEvents.length,
      recentRenderEvents: snapshot.recentRenderEvents.length,
      recentJankSnapshots: snapshot.recentJankSnapshots.length,
      recentSurfaceEvents: snapshot.recentSurfaceEvents.length,
      recentEventLoopLag: snapshot.recentEventLoopLag.length,
      externalSnapshots: externalKeys.join(','),
      hostItemLifecycle: hostLifecycle
        ? {
          runningItemCount: hostLifecycle['runningItemCount'],
          hotItemCount: hostLifecycle['hotItemCount'],
          turnCount: hostLifecycle['turnCount'],
        }
        : undefined,
      longTasks: snapshot.longTasks,
    },
  );
};

ChatPerformanceTracer.dumpLongTasks = function(count?: number): void {
  if (longTasks.length === 0) { console.log('[PerfTracer] 无 long task 记录'); return; }
  const allTotalDurationMs = longTasks.reduce((sum, task) => sum + task.duration, 0);
  const allMaxDurationMs = longTasks.reduce((max, task) => Math.max(max, task.duration), 0);
  const recent = longTasks.slice(-20);
  const recentTotalDurationMs = recent.reduce((sum, task) => sum + task.duration, 0);
  const recentMaxDurationMs = recent.reduce((max, task) => Math.max(max, task.duration), 0);
  console.log(
    `[PerfTracer] long tasks: count=${longTasks.length}, total=${allTotalDurationMs.toFixed(1)}ms, max=${allMaxDurationMs.toFixed(1)}ms, recent20Total=${recentTotalDurationMs.toFixed(1)}ms, recent20Max=${recentMaxDurationMs.toFixed(1)}ms`,
  );

  if (!shouldPrintDetailTable(count)) {
    printDetailHint('dumpLongTasks');
    return;
  }

  const safeCount = Math.max(1, Math.min(Math.floor(count), 40));
  const tasks = longTasks.slice(-safeCount);
  console.log(`[PerfTracer] long tasks detail: showing ${tasks.length}/${longTasks.length}`);
  console.table(tasks.map(t => ({
    'start(ms)': +t.start.toFixed(1),
    'duration(ms)': +t.duration.toFixed(1),
    'name': t.name,
    'attribution': t.attribution || '',
  })));
};

ChatPerformanceTracer.dumpJankContext = function(count = 0): void {
  const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
  if (now - lastJankContextDumpAt < JANK_CONTEXT_MIN_INTERVAL_MS) {
    console.log('[PerfTracer] jank context skipped: throttled');
    return;
  }
  lastJankContextDumpAt = now;
  console.log('[PerfTracer] jank context');
  const runDump = () => {
    ChatPerformanceTracer.dumpPerformanceStateSummary();
    ChatPerformanceTracer.dumpLongTasks(count);
    ChatPerformanceTracer.dumpJankSnapshots(Math.min(count, 20));
    ChatPerformanceTracer.dumpRecentRenderEvents(Math.min(count, 100));
    ChatPerformanceTracer.dumpCounters();
    ChatPerformanceTracer.dumpKey(count);
    ChatPerformanceTracer.dumpSlow(8);
  };
  if (isJankDetailDumpEnabled()) {
    runDump();
  } else {
    withSuppressedDetailTables(runDump);
    if (count > 0) {
      printJankDetailHint();
    }
  }
};

function formatLongTaskAttribution(entry: PerformanceEntry): string | undefined {
  const raw = entry as PerformanceEntry & {
    attribution?: Array<{
      name?: string;
      entryType?: string;
      containerType?: string;
      containerName?: string;
      containerId?: string;
      containerSrc?: string;
    }>;
  };
  const attribution = Array.isArray(raw.attribution) ? raw.attribution : [];
  if (!attribution.length) {
    return undefined;
  }
  return attribution
    .slice(0, 4)
    .map((item) => [
      item.name || item.entryType || '',
      item.containerType || '',
      item.containerName || item.containerId || item.containerSrc || '',
    ].filter(Boolean).join(':'))
    .filter(Boolean)
    .join('|') || undefined;
}
