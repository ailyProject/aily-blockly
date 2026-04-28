import { Injectable } from '@angular/core';
import { lastValueFrom, Observable, Subject } from 'rxjs';
import { LogService } from './log.service';

declare const electronAPI: any;

export interface CmdOutput {
  type: 'stdout' | 'stderr' | 'close' | 'error';
  data?: string;
  code?: number;
  signal?: string;
  error?: string;
  streamId: string;
  /** close 事件时附带的累积 stderr 输出 */
  stderr?: string;
  /** close 事件时附带的累积 stdout 输出 */
  stdout?: string;
}

export interface CmdOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: { [key: string]: string };
  streamId?: string;
}

interface QueuedTask {
  command: string;
  cwd?: string;
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
    const streamId = `cmd_${Date.now()}_${Math.random()}`;
    const subject = new Subject<CmdOutput>();
    this.subjects.set(streamId, subject);
    const cmdOptions: CmdOptions = {
      command,
      args: args || [],
      ...options,
      streamId
    };
    // 累积 stderr/stdout 输出，在 close 事件时附加到返回数据中
    const MAX_COLLECTED_SIZE = 2000;
    let collectedStderr = '';
    let collectedStdout = '';

    // 注册数据监听器
    const removeListener = window['cmd'].onData(streamId, (data: CmdOutput) => {
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

      // close 事件时，将累积的 stderr/stdout 附加到事件对象上
      if (data.type === 'close') {
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

      subject.next(data);

      // 如果是关闭或错误事件，完成Observable
      if (data.type === 'close' || data.type === 'error') {
        subject.complete();
        this.subjects.delete(streamId);
        removeListener();
      }
    });

    // 执行命令
    window['cmd'].run(cmdOptions).then((result: any) => {
      if (!result.success) {
        subject.error(new Error(result.error));
        this.subjects.delete(streamId);
        removeListener();
      }
    }).catch((error: any) => {
      subject.error(error);
      this.subjects.delete(streamId);
      removeListener();
    });

    return subject.asObservable();
  }
  /**
   * 快速执行命令（支持队列顺序执行）
   * @param command 命令字符串
   * @param cwd 工作目录
   * @param useQueue 是否使用队列（默认为true）
   */
  run(command: string, cwd?: string, useQueue: boolean = true, silent: boolean = false): Observable<CmdOutput> {
    if (!useQueue) {
      // 直接执行，不使用队列
      return this.executeCommand(command, cwd, silent);
    }

    // 使用队列机制
    const subject = new Subject<CmdOutput>();

    return new Observable<CmdOutput>((observer) => {
      const task: QueuedTask = {
        command,
        cwd,
        resolve: (value: CmdOutput) => {
          observer.next(value);
          if (value.type === 'close' || value.type === 'error') {
            observer.complete();
          }
        },
        reject: (reason: any) => {
          observer.error(reason);
        },
        subject
      };

      this.taskQueue.push(task);
      this.processQueue();
    });
  }

  /**
   * 直接执行命令（不使用队列）
   * @param command 命令字符串
   * @param cwd 工作目录
   */
  private executeCommand(command: string, cwd?: string, silent: boolean = false): Observable<CmdOutput> {
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
    return this.spawn(cmd, args, { cwd }, silent);
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

        try {
          // console.log(`Processing queued command: ${task.command}`);

          // 执行命令并等待完成
          const observable = this.executeCommand(task.command, task.cwd);

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
          console.error(`Error processing queued command: ${task.command}`, error);
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
  async runAsync(command: string, cwd?: string, useQueue: boolean = true, silent: boolean = false): Promise<CmdOutput> {
    return lastValueFrom(this.run(command, cwd, useQueue, silent))
  }

  /**
   * 终止命令执行
   * @param streamId 流ID
   */
  async kill(streamId: string): Promise<boolean> {
    const subject = this.subjects.get(streamId);
    if (subject) {
      const result = await window['cmd'].kill(streamId);
      // console.log(`Kill command ${streamId}:`, result);
      if (result.success) {
        subject.complete();
        this.subjects.delete(streamId);
      }
      return result.success;
    }
    return false;
  }

  /**
   * 按进程名终止命令执行
   */
  async killByName(processName: string): Promise<boolean> {
    const result = await window['cmd'].killByName(processName);
    // console.log(`Kill process by name ${processName}:`, result);
    return result.success;
  }

  /**
   * 清空队列
   */
  clearQueue(): void {
    this.taskQueue.forEach(task => {
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