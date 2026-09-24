import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class AppDataResourceLockService {
  private tail: Promise<void> = Promise.resolve();
  private queuedCount = 0;

  async runExclusive<T>(label: string, task: (token: string) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    return this.runWithBudget(label, 'write', task, signal);
  }

  async runShared<T>(label: string, task: (token: string) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    return this.runWithBudget(label, 'read', task, signal);
  }

  private async runWithBudget<T>(label: string, mode: 'read' | 'write', task: (token: string) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const timeoutMs = 5000;
    const wait = new AbortController();
    const deadline = Date.now() + timeoutMs;
    const cancel = () => wait.abort(new Error('APPDATA_RESOURCE_LOCK_CANCELLED'));
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => wait.abort(new Error('APPDATA_RESOURCE_LOCK_TIMEOUT')), timeoutMs);
    const stopWaiting = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    };
    const entered = (token: string) => {
      // The deadline covers acquisition only; a running build keeps its lease.
      stopWaiting();
      return task(token);
    };
    try {
      return mode === 'write'
        ? await this.runWithLocalWriteQueue(label, entered, wait.signal, deadline)
        : await this.runWithFileLock(label, mode, entered, 0, wait.signal, timeoutMs);
    } finally { stopWaiting(); }
  }

  private async runWithLocalWriteQueue<T>(label: string, task: (token: string) => Promise<T> | T, signal: AbortSignal, deadline: number): Promise<T> {
    if (signal.aborted) throw signal.reason;
    const queuedAt = Date.now();
    const previous = this.tail;
    let release!: () => void;

    this.queuedCount += 1;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    let entered = false;
    let cancel: (() => void) | undefined;
    try {
      await Promise.race([previous, new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener('abort', cancel, { once: true });
      })]);
      entered = true;
      this.queuedCount -= 1;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('APPDATA_RESOURCE_LOCK_TIMEOUT');
      return await this.runWithFileLock(label, 'write', task, Date.now() - queuedAt, signal, remaining);
    } finally {
      if (cancel) signal!.removeEventListener('abort', cancel);
      if (!entered) this.queuedCount -= 1;
      // A cancelled queued entry must not let later writers overtake its predecessor.
      void previous.then(release);
    }
  }

  private async runWithFileLock<T>(label: string, mode: 'read' | 'write', task: (token: string) => Promise<T> | T, localWaitMs: number, signal: AbortSignal, timeoutMs: number): Promise<T> {
    const startedAt = Date.now();
    let fileLockToken: string | undefined;

    this.trace('LOCAL_LOCK_ACQUIRED', {
      label,
      mode,
      waitMs: localWaitMs,
      queuedCount: this.queuedCount
    });

    try {
      const fileLock = await this.acquireFileLock(label, mode, signal, timeoutMs);
      fileLockToken = fileLock.token;
      this.trace('FILE_LOCK_ACQUIRED', {
        label,
        mode,
        token: fileLockToken,
        waitMs: fileLock.waitMs
      });

      if (signal.aborted) throw signal.reason;
      return await task(fileLockToken);
    } finally {
      if (fileLockToken) {
        await this.releaseFileLock(fileLockToken, label);
      }

      this.trace('LOCAL_LOCK_RELEASED', {
        label,
        mode,
        durationMs: Date.now() - startedAt,
        queuedCount: this.queuedCount
      });
    }
  }

  private async acquireFileLock(label: string, mode: 'read' | 'write', signal: AbortSignal, timeoutMs: number): Promise<{ token: string; waitMs: number }> {
    if (signal.aborted) throw signal.reason;
    if (!window['ipcRenderer']?.invoke) {
      throw new Error('APPDATA_RESOURCE_LOCK_UNAVAILABLE: Restart the desktop host.');
    }

    const requestId = crypto.randomUUID();
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => {
        void window['ipcRenderer'].invoke('appdata-resource-lock-cancel', { requestId }).catch(() => {});
        reject(signal.reason);
      };
      signal.addEventListener('abort', cancel, { once: true });
    });
    const acquisition = window['ipcRenderer'].invoke('appdata-resource-lock-acquire', {
      label, mode, requestId, timeoutMs,
    });
    let result: any;
    try {
      result = await Promise.race([acquisition, cancelled]);
    } catch (error) {
      // IPC may deliver a grant after the caller's deadline. Return that token
      // without ever running its cancelled task.
      void acquisition.then((late: any) => {
        if (late?.ok && typeof late.token === 'string') return this.releaseFileLock(late.token, label);
      }).catch(() => {});
      throw error;
    } finally { signal.removeEventListener('abort', cancel); }

    if (!result?.ok || typeof result.token !== 'string' || !result.token) {
      throw new Error(result?.error || 'APPDATA_RESOURCE_LOCK_FAILED');
    }
    if (result.commandHandoff !== true || (mode === 'write' && result.writerCommandHandoff !== true)) {
      await this.releaseFileLock(result.token, label);
      throw new Error('APPDATA_RESOURCE_LOCK_UNAVAILABLE: Restart the updated desktop host.');
    }

    return {
      token: result.token,
      waitMs: result.waitMs || 0
    };
  }

  private async releaseFileLock(token: string, label: string): Promise<void> {
    if (!token || !window['ipcRenderer']?.invoke) {
      return;
    }

    try {
      const result = await window['ipcRenderer'].invoke('appdata-resource-lock-release', { token });
      if (!result?.ok) throw new Error(result?.error || 'APPDATA_RESOURCE_LOCK_RELEASE_FAILED');
      this.trace(result.retainedByCommand ? 'FILE_LOCK_RETAINED' : 'FILE_LOCK_RELEASED', { label, token });
    } catch (error) {
      this.trace('FILE_LOCK_RELEASE_FAILED', {
        label,
        token,
        error: error?.message || String(error)
      });
    }
  }

  private trace(event: string, data: any): void {
    try {
      if (window['ipcRenderer']?.invoke) {
        void window['ipcRenderer']
          .invoke('log-info', `[PROC_TRACE][APPDATA_LOCK_${event}] ${JSON.stringify(data)}`)
          .catch(() => {});
      }
    } catch {
      // 资源锁日志不能影响业务流程
    }
  }
}
