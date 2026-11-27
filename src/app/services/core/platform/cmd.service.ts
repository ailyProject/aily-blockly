import { Injectable } from '@angular/core';
import { lastValueFrom, Observable, Subject } from 'rxjs';
import { LogService } from './log.service';
import { isCmdTerminalOutput, type CmdOutput } from './cmd-output';

export type { CmdOutput, CmdPhysicalTerminal } from './cmd-output';
export { isCmdTerminalOutput } from './cmd-output';

declare const electronAPI: any;

export interface CmdOptions {
  command?: string;

  args?: string[];

  cwd?: string;

  env?: { [key: string]: string };
  streamId?: string;
  shellProfile?: boolean;
  forwardStdout?: boolean;
  /** Bind a build marker to this registered command's confirmed tree cancellation. */
  buildWorkspace?: string;
  /** Advisory preprocess keeps observing until the host releases ownership. */
  backgroundPreprocess?: boolean;
  /** Observe the original native process even if its close notification is lost. */
  observeExit?: boolean;
  /** Experimental full-delivery request; only the host compile entry may attest it. */
  buildDeliveryRequest?: string;
  /** Upload only the Artifact whose simulation was verified, without rebuilding. */
  expectedArtifactId?: string;
  projectPath?: string;
  projectSessionId?: string;
  signal?: AbortSignal;
  /** Renderer-only observer scoped to this command; never serialized over IPC. */
  onOutput?: (output: CmdOutput) => void;
}

interface QueuedTask {
  command: string;
  cwd?: string;
  silent: boolean;
  options?: Partial<CmdOptions>;

  removeAbortListener: () => void;
  resolve: (value: CmdOutput) => void;
  reject: (reason?: any) => void;

  subject: Subject<CmdOutput>;
}

@Injectable({
  providedIn: 'root'
})

export class CmdService {
  private subjects = new Map<string, Subject<CmdOutput>>();
  private taskQueue: QueuedTask[] = [];
  private isProcessingQueue = false;

  constructor(
    private logService: LogService
  ) { }

  /**
   * 执行命令并返回Observable
   * @param options 命令选项
   * @returns Observable<CmdOutput>
   */
  spawn(command: string, args?: string[], options?: Partial<CmdOptions>, silent: boolean = false): Observable<CmdOutput> {
    const { signal, onOutput, observeExit, ...processOptions } = options || {};
    if (signal?.aborted) return new Observable(observer => observer.error(cancelledCommandError()));

    const requestedStreamId = typeof options?.streamId === 'string' ? options.streamId.trim() : '';
    const streamId = requestedStreamId || `cmd_${Date.now()}_${Math.random()}`;
    const subject = new Subject<CmdOutput>();

    this.subjects.set(streamId, subject);

    const cmdOptions: CmdOptions = {
      command,
      args: args || [],
      ...processOptions,
      streamId
    };
    // 累积 stderr/stdout 输出，在物理终态时附加到返回数据中
    const MAX_COLLECTED_SIZE = 2000;
    let collectedStderr = '';
    let collectedStdout = '';
    let settled = false;
    let removeListener: (() => void) | undefined;
    let observation: ReturnType<typeof setTimeout> | undefined;
    let exitObserved = false;
    let dispatched = false;
    const onAbort = () => {
      if (dispatched && observeExit && typeof window['cmd'].kill === 'function') {
        void window['cmd'].kill(streamId).catch(() => undefined);
      }
      subject.error(cancelledCommandError());
    };
    const cleanup = () => {
      if (settled) return;

      settled = true;

      signal?.removeEventListener('abort', onAbort);
      removeListener?.();
      clearTimeout(observation);
      if (this.subjects.get(streamId) === subject) this.subjects.delete(streamId);
    };

    subject.subscribe({ error: cleanup, complete: cleanup });

    // 注册数据监听器
    const receive = (data: CmdOutput): void => {
      if (settled || signal?.aborted) return;
      if (observeExit && data.streamId !== streamId) return;
      if (observeExit && processOptions.backgroundPreprocess && data.type === 'close' && data.ownershipReleased === false) return;
      // 累积 stderr/stdout 数据
      if (data.type === 'stderr' && data.data) {
        collectedStderr += data.data;

        if (collectedStderr.length > MAX_COLLECTED_SIZE) {
          collectedStderr = collectedStderr.slice(-MAX_COLLECTED_SIZE);
        }
      } else if (data.type === 'stdout' && data.data) {
        collectedStdout += data.data;

        if (collectedStdout.length > MAX_COLLECTED_SIZE) {
          collectedStdout = collectedStdout.slice(-MAX_COLLECTED_SIZE);
        }
      }

      // 物理终态时，将累积的 stderr/stdout 附加到事件对象上
      if (isCmdTerminalOutput(data)) {
        data.stderr = collectedStderr;
        data.stdout = collectedStdout;

        // 命令以非零退出码结束且有 stderr 时，自动写入日志面板
        // 跳过 taskkill/pkill 等进程清理命令（找不到进程时返回非零是正常的）
        const lowerCmd = command.toLowerCase();
        const isCleanupCmd = lowerCmd === 'taskkill' || lowerCmd === 'pkill' || lowerCmd === 'kill' || lowerCmd === 'killall';

        if (data.code !== 0 && collectedStderr && !isCleanupCmd && !silent) {
          const fullCmd = [command, ...(args || [])].join(' ');

          this.logService.update({
            title: `命令执行失败`,
            detail: `${fullCmd}\n${collectedStderr}`,
            state: 'error'
          });
        }
      }

      try { onOutput?.(data); }
      catch (error) { console.warn('Command output observer failed:', error); }
      subject.next(data);

      // 如果是关闭或错误事件，完成Observable
      if (isCmdTerminalOutput(data) || data.type === 'error') {
        subject.complete();
      }
    };
    removeListener = window['cmd'].onData(streamId, receive);
    const observe = () => {
      if (!observeExit || settled || typeof window['cmd'].status !== 'function') return;
      observation = setTimeout(async () => {
        try {
          const status = await window['cmd'].status(streamId);
          if (status?.streamId === streamId && status.state === 'exited'
            && (Number.isInteger(status.code) || typeof status.signal === 'string')) {
            // Status and streamed output take separate IPC paths. Give the
            // original close and its preceding output one more poll interval
            // to arrive before falling back to status-only recovery.
            if (exitObserved) {
              receive({ type: 'close', streamId, code: status.code, signal: status.signal ?? undefined,
                ownershipReleased: status.ownershipReleased === true, recovered: true });
            }
            exitObserved = true;
          } else {
            exitObserved = false;
          }
        } catch { /* Retain the event subscription and observe the original again. */ }
        observe();
      }, 500);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    if (signal?.aborted) {
      onAbort();

      return subject.asObservable();
    }

    // 执行命令
    dispatched = true;
    window['cmd'].run(cmdOptions).then((result: any) => {
      if (settled) return;

      if (!result.success) {
        subject.error(Object.assign(new Error(result.error), {
          ...(typeof result.code === 'string' ? { code: result.code } : {}),
          ...(result.buildOutcome === 'not-started' ? { buildOutcome: result.buildOutcome } : {}),
        }));
      }
    }).catch((error: any) => {
      if (settled) return;

      subject.error(error);
    });
    observe();

    return subject.asObservable();
  }

  /**
   * 快速执行命令（支持队列顺序执行）
   * @param command 命令字符串
   * @param cwd 工作目录
   * @param useQueue 是否使用队列（默认为true）
   */
  run(command: string, cwd?: string, useQueue: boolean = true, silent: boolean = false, options?: Partial<CmdOptions>): Observable<CmdOutput> {
    if (!useQueue) {
      // 直接执行，不使用队列
      return this.executeCommand(command, cwd, silent, options);
    }

    // 使用队列机制
    const subject = new Subject<CmdOutput>();

    return new Observable<CmdOutput>((observer) => {
      const signal = options?.signal;

      if (signal?.aborted) {
        observer.error(cancelledCommandError());

        return;
      }

      const task: QueuedTask = {
        command,
        cwd,
        silent,
        options,
        removeAbortListener: () => signal?.removeEventListener('abort', onAbort),
        resolve: (value: CmdOutput) => {
          observer.next(value);

          if (isCmdTerminalOutput(value) || value.type === 'error') {
            observer.complete();
          }
        },
        reject: (reason: any) => {
          observer.error(reason);
        },
        subject
      };

      const onAbort = () => {
        const index = this.taskQueue.indexOf(task);

        if (index < 0) return;

        this.taskQueue.splice(index, 1);
        task.reject(cancelledCommandError());
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.taskQueue.push(task);
      this.processQueue();

      return task.removeAbortListener;
    });
  }

  /**
   * 直接执行命令（不使用队列）
   * @param command 命令字符串
   * @param cwd 工作目录
   */
  private executeCommand(command: string, cwd?: string, silent: boolean = false, options?: Partial<CmdOptions>): Observable<CmdOutput> {
    if (options?.signal?.aborted) return new Observable(observer => observer.error(cancelledCommandError()));

    // console.log(`run command: ${command}`);
    if (!silent) {
      this.logService.update({
        title: '执行命令',
        detail: command,
        state: 'info'
      });
    }

    const parts = parseCommand(command);
    const cmd = parts[0];
    const args = parts.slice(1);

    return this.spawn(cmd, args, { ...options, cwd: cwd ?? options?.cwd }, silent);
  }

  /**
   * 处理队列中的任务
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.taskQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.taskQueue.length > 0) {
        const task = this.taskQueue.shift()!;

        task.removeAbortListener();

        try {
          // console.log(`Processing queued command: ${task.command}`);

          // 执行命令并等待完成
          const observable = this.executeCommand(task.command, task.cwd, task.silent, {
            observeExit: true, ...task.options,
          });

          await new Promise<void>((resolve, reject) => {
            observable.subscribe({
              next: (output) => {
                task.resolve(output);
              },
              error: (error) => {
                task.reject(error);
                reject(error);
              },
              complete: () => {
                resolve();
              }
            });
          });
        } catch (error) {
          if (!task.options?.signal?.aborted) console.error(`Error processing queued command: ${task.command}`, error);

          task.reject(error);
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * 异步执行命令并等待完成
   * @param command 命令字符串
   * @param cwd 工作目录
   * @param useQueue 是否使用队列（默认为true）
   * @returns Promise<{success: boolean, output: string, error?: string}>
   */
  async runAsync(command: string, cwd?: string, useQueue: boolean = true, silent: boolean = false, options?: Partial<CmdOptions>): Promise<CmdOutput> {
    return lastValueFrom(this.run(command, cwd, useQueue, silent, options))
  }

  async runAsyncChecked(command: string, cwd?: string, useQueue: boolean = true, silent: boolean = false, options?: Partial<CmdOptions>): Promise<CmdOutput> {
    const result = await this.runAsync(command, cwd, useQueue, silent, options);

    if (result.type === 'error' || (result.code ?? 0) !== 0 || result.signal) {
      throw new Error(result.error || result.stderr || result.stdout || `Command failed with exit code ${result.code ?? 'unknown'}: ${command}`);
    }

    return result;
  }

  /**
   * 终止命令执行
   * @param streamId 流ID
   */
  async kill(streamId: string, waitMs?: number): Promise<boolean> {
    const subject = this.subjects.get(streamId);
    // The stream may close before main confirms that its process tree has stopped.
    let timer: number | undefined;
    try {
      const stop = window['cmd'].kill(streamId);
      const result = waitMs === undefined ? await stop : await Promise.race([
        stop,
        new Promise<undefined>(resolve => { timer = window.setTimeout(() => resolve(undefined), waitMs); }),
      ]);
      if (result?.success) subject?.complete();
      return result?.success === true;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 按进程名终止命令执行
   */
  async killByName(processName: string): Promise<boolean> {
    console.warn(`Refusing to kill process by name: ${processName}`);

    return false;
  }

  /**
   * 清空队列
   */
  clearQueue(): void {
    this.taskQueue.forEach(task => {
      task.removeAbortListener();
      task.reject(new Error('Queue cleared'));
    });

    this.taskQueue = [];
  }

  /**
   * 获取队列长度
   */
  getQueueLength(): number {
    return this.taskQueue.length;
  }

  /**
   * 检查是否正在处理队列
   */
  isProcessing(): boolean {
    return this.isProcessingQueue;
  }

  /**
   * 向进程发送输入
   * @param streamId 流ID
   * @param input 输入内容
   */
  async sendInput(streamId: string, input: string): Promise<boolean> {
    const result = await window['cmd'].input(streamId, input);

    return result.success;
  }
}

function cancelledCommandError(): Error {
  return Object.assign(new Error('Project command was cancelled.'), { name: 'AbortError', code: 'PROJECT_COMMAND_CANCELLED' });
}

function parseCommand(command: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if ((char === '"' || char === "'") && !inQuotes) {
      // 开始引号，进入引号模式并添加引号字符
      inQuotes = true;
      quoteChar = char;
      current += char;
    } else if (char === quoteChar && inQuotes) {
      // 结束引号，退出引号模式并添加引号字符
      inQuotes = false;
      quoteChar = '';
      current += char;
    } else if (char === ' ' && !inQuotes) {
      // 只有在非引号状态下的空格才作为分隔符
      if (current.length > 0) {
        result.push(current);

        current = '';
      }
    } else {
      // 添加普通字符（引号内的空格也会被添加）
      current += char;
    }
  }

  // 添加最后一个参数
  if (current.length > 0) {
    result.push(current);
  }

  return result;
}
