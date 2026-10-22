/** 两种编辑器共用的云编译进度；事件只更新界面，成功状态仍以主进程校验后的结果为准。 */
export interface CloudBuildProgressEvent {
  requestId?: string;
  jobId?: string;
  stage?: string;
  progress?: number;
  attempt?: number;
  log?: string;
  stream?: string;
}

interface CloudBuildProgressCallbacks {
  isCurrent: () => boolean;
  log: (text: string, stream: 'stdout' | 'stderr') => void;
  progress: (event: CloudBuildProgressEvent) => void;
  /** 注册本次任务的切换动作；返回 false 表示任务已结束或不再属于当前调用。 */
  localSwitch?: (requestSwitch: () => boolean) => void;
}

export const CLOUD_BUILD_LOCAL_REQUESTED = 'CLOUD_BUILD_LOCAL_REQUESTED';

interface CloudBuildRunResult {
  success?: boolean;
  reused?: boolean;
  state?: string;
  text?: string;
  artifactPath?: string;
  fullStdErr?: string;
}

interface CloudBuildProgressBridge {
  run: (request: { requestId: string; [option: string]: unknown }) => Promise<CloudBuildRunResult>;
  cancel: (request: { requestId: string }) => unknown;
  onProgress: (listener: (event: CloudBuildProgressEvent) => void) => (() => void) | void;
}

const CLOUD_BUILD_STAGES = [
  'capturing', 'uploading', 'queued', 'dispatching', 'preparing', 'resources',
  'analyzing', 'compiling', 'finalizing', 'downloading', 'verifying', 'reconnecting', 'complete',
] as const;
type CloudBuildStage = typeof CLOUD_BUILD_STAGES[number];

const PIPELINE_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  capturing: [2, 5], uploading: [5, 10], queued: [10, 10], dispatching: [12, 12],
  preparing: [12, 25], resources: [12, 25], analyzing: [25, 40],
  compiling: [25, 88], finalizing: [88, 94], succeeded: [94, 94],
  downloading: [94, 98], verifying: [98, 99], complete: [100, 100],
};
const LOCAL_PREPARATION = [0, 2] as const;

function overallProgress(stage: string | undefined, value: number, hasJob: boolean): number | undefined {
  // 把各阶段自身的百分比映射到整个流程；下载和签名校验结束前不能显示 100%。
  const range = stage === 'preparing' && !hasJob ? LOCAL_PREPARATION : stage && PIPELINE_RANGES[stage];
  return range ? range[0] + (range[1] - range[0]) * value / 100 : undefined;
}

export function cloudBuildProgressPresentation(event: CloudBuildProgressEvent, translate: (key: string) => string) {
  const stage = CLOUD_BUILD_STAGES.includes(event.stage as CloudBuildStage) ? event.stage as CloudBuildStage : 'compiling';
  const key = `CLOUD_BUILD.STAGES.${stage.toUpperCase()}`;
  const text = translate(key);
  return {
    text: text && text !== key ? text : translate('SETTINGS.FIELDS.CLOUD_COMPILATION'),
    progress: typeof event.progress === 'number' && Number.isFinite(event.progress)
      ? Math.max(0, Math.min(100, event.progress)) : 0,
  };
}

/** 状态立即刷新，日志短暂合并，避免大量编译输出阻塞界面和进度更新。 */
export class CloudBuildProgressBuffer {
  private logs: Array<{ text: string; stream: 'stdout' | 'stderr' }> = [];
  private chars = 0;
  private stage: string | undefined;
  private percent = 0;
  private overallPercent = 0;
  private attempt: number | undefined;
  private hasStatus = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private hasPresented = false;

  constructor(private readonly options: CloudBuildProgressCallbacks) {}

  push(event: CloudBuildProgressEvent): void {
    if (this.disposed) return;
    const hadPresented = this.hasPresented;
    const log = typeof event.log === 'string' ? event.log : '';
    const hasLog = log.length > 0;
    const hasPercent = typeof event.progress === 'number' && Number.isFinite(event.progress);
    const attempt = Number.isSafeInteger(event.attempt) && event.attempt! >= 0 ? event.attempt : undefined;
    const staleAttempt = attempt !== undefined && this.attempt !== undefined && attempt < this.attempt;
    // 重放日志可能携带旧阶段；只有明确的状态事件才能推进阶段，重试前的状态不能覆盖当前任务。
    if (!staleAttempt && (hasPercent || (!hasLog && typeof event.stage === 'string')) && this.options.isCurrent()) {
      const stage = typeof event.stage === 'string' ? event.stage : this.stage;
      const newAttempt = attempt !== undefined && this.attempt !== undefined && attempt > this.attempt;
      const incoming = hasPercent ? Math.max(0, Math.min(100, event.progress!)) : newAttempt ? 0 : this.percent;
      const percent = !newAttempt && stage === this.stage ? Math.max(this.percent, incoming) : incoming;
      this.attempt = attempt ?? this.attempt;
      if (!this.hasStatus || newAttempt || stage !== this.stage || percent !== this.percent) {
        this.stage = stage;
        this.percent = percent;
        this.hasStatus = true;
        this.hasPresented = true;
        const overall = overallProgress(stage, percent, !!event.jobId);
        this.overallPercent = newAttempt ? overall ?? 0 : Math.max(this.overallPercent, overall ?? this.overallPercent);
        this.options.progress({ requestId: event.requestId, jobId: event.jobId,
          stage: stage === 'succeeded' ? 'finalizing' : stage, progress: this.overallPercent, attempt: this.attempt });
      }
    }
    if (hasLog) {
      // 限制积压的日志量；大消息直接刷新，避免长编译任务持续占用内存。
      if (this.chars + log.length > 65536 || this.logs.length >= 64) this.flush();
      this.logs.push({ text: log, stream: event.stream === 'stderr' ? 'stderr' : 'stdout' });
      this.chars += log.length;
    }
    if (!this.logs.length) return;
    if (!hadPresented || this.chars >= 65536 || this.logs.length >= 64) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 50);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const logs = this.logs;
    this.logs = []; this.chars = 0;
    if (!logs.length) return;
    if (this.disposed || !this.options.isCurrent()) return;
    this.hasPresented = true;
    let group: { text: string; stream: 'stdout' | 'stderr' } | undefined;
    for (const item of logs) {
      if (group?.stream === item.stream) group.text += `\n${item.text}`;
      else { if (group) this.options.log(group.text, group.stream); group = { ...item }; }
    }
    if (group) this.options.log(group.text, group.stream);
  }

  dispose(): void {
    this.flush();
    this.disposed = true;
  }
}

/** 只复用云任务的桥接与进度生命周期；源码准备、取消等待和结果发布仍由各编辑器管理。 */
export async function runCloudBuildWithProgress(
  request: { requestId: string; [option: string]: unknown },
  bridge: CloudBuildProgressBridge | undefined,
  callbacks: CloudBuildProgressCallbacks,
): Promise<CloudBuildRunResult> {
  if (typeof bridge?.run !== 'function' || typeof bridge?.cancel !== 'function' || typeof bridge?.onProgress !== 'function') {
    throw new Error('Cloud build bridge is unavailable; restart the desktop application.');
  }
  let switching = false;
  let settled = false;
  let cancellation: Promise<{ error?: unknown }> | undefined;
  const buffer = new CloudBuildProgressBuffer({ ...callbacks, isCurrent: () => !switching && callbacks.isCurrent() });
  // Keep this invocation's raw output independently of the throttled UI buffer.
  // Compiler diagnostics can arrive on stdout (e.g. Ninja), not just stderr.
  const logs: string[] = [];
  let unsubscribe: (() => void) | void = undefined;
  try {
    unsubscribe = bridge.onProgress(event => {
      if (event?.requestId === request.requestId && !switching && callbacks.isCurrent()) {
        if (typeof event.log === 'string' && event.log) logs.push(event.log);
        buffer.push(event);
      }
    });
    const running = bridge.run(request);
    callbacks.localSwitch?.(() => {
      if (settled || switching || !callbacks.isCurrent()) return false;
      switching = true;
      cancellation = Promise.resolve().then(() => bridge.cancel({ requestId: request.requestId }))
        .then(() => ({}), error => ({ error }));
      return true;
    });
    let result: CloudBuildRunResult;
    let failure: unknown;
    try { result = await running; } catch (error) { failure = error; }
    settled = true;
    if (switching) {
      // 等云请求释放工作区以及取消回执，两者完成前绝不能启动本地编译。
      const cancelled = await cancellation;
      if (cancelled?.error) throw cancelled.error;
      if (callbacks.isCurrent()) throw Object.assign(new Error('Continue this build locally.'), { code: CLOUD_BUILD_LOCAL_REQUESTED });
      throw failure || Object.assign(new Error('Cloud build was cancelled or replaced.'), { code: 'CANCELLED' });
    }
    if (failure) throw failure;
    if (result?.success === false) {
      throw Object.assign(new Error(result.text || 'Cloud compilation failed.'), result);
    }
    return result;
  } catch (error) {
    if (error?.code === CLOUD_BUILD_LOCAL_REQUESTED) throw error;
    const message = error?.message || String(error);
    const output = [error?.fullStdErr, ...logs].filter(text => typeof text === 'string' && text).join('\n');
    // contextBridge may reject with a plain object; retain its code and message.
    throw Object.assign(new Error(message), error, {
      fullStdErr: output ? (output.includes(message) ? output : `${output}\n${message}`) : message,
    });
  } finally {
    settled = true;
    await cancellation;
    try { if (typeof unsubscribe === 'function') unsubscribe(); }
    finally { buffer.dispose(); }
  }
}
