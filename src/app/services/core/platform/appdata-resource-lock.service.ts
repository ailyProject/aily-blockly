import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class AppDataResourceLockService {
  private tail: Promise<void> = Promise.resolve();
  private queuedCount = 0;

  async runExclusive<T>(label: string, task: (token: string) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    return this.runWithLocalWriteQueue(label, task, signal);
  }

  async runShared<T>(label: string, task: (token: string) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    return this.runWithFileLock(label, 'read', task, 0, signal);
  }

  private async runWithLocalWriteQueue<T>(label: string, task: (token: string) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('APPDATA_RESOURCE_LOCK_CANCELLED');
    const queuedAt = Date.now();
    const previous = this.tail.catch(() => undefined);
    let release!: () => void;

    this.queuedCount += 1;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    let entered = false;
    let cancel: (() => void) | undefined;
    try {
      await (signal ? Promise.race([previous, new Promise<never>((_, reject) => {
        cancel = () => reject(new Error('APPDATA_RESOURCE_LOCK_CANCELLED'));
        signal.addEventListener('abort', cancel, { once: true });
      })]) : previous);
      entered = true;
      this.queuedCount -= 1;
      return await this.runWithFileLock(label, 'write', task, Date.now() - queuedAt, signal);
    } finally {
      if (cancel) signal!.removeEventListener('abort', cancel);
      if (!entered) this.queuedCount -= 1;
      // A cancelled queued entry must not let later writers overtake its predecessor.
      void previous.then(release);
    }
  }

  private async runWithFileLock<T>(label: string, mode: 'read' | 'write', task: (token: string) => Promise<T> | T, localWaitMs = 0, signal?: AbortSignal): Promise<T> {
    const startedAt = Date.now();
    let fileLockToken: string | undefined;

    this.trace('LOCAL_LOCK_ACQUIRED', {
      label,
      mode,
      waitMs: localWaitMs,
      queuedCount: this.queuedCount
    });

    try {
      const fileLock = await this.acquireFileLock(label, mode, signal);
      fileLockToken = fileLock.token;
      this.trace('FILE_LOCK_ACQUIRED', {
        label,
        mode,
        token: fileLockToken,
        waitMs: fileLock.waitMs
      });

      if (signal?.aborted) throw new Error('APPDATA_RESOURCE_LOCK_CANCELLED');
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

  private async acquireFileLock(label: string, mode: 'read' | 'write', signal?: AbortSignal): Promise<{ token: string; waitMs: number }> {
    if (signal?.aborted) throw new Error('APPDATA_RESOURCE_LOCK_CANCELLED');
    if (!window['ipcRenderer']?.invoke) {
      throw new Error('APPDATA_RESOURCE_LOCK_UNAVAILABLE: Restart the desktop host.');
    }

    const requestId = crypto.randomUUID();
    const cancel = () => { void window['ipcRenderer'].invoke('appdata-resource-lock-cancel', { requestId }).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    let result: any;
    try {
      result = await window['ipcRenderer'].invoke('appdata-resource-lock-acquire', {
        label, mode, requestId, timeoutMs: 30 * 60 * 1000,
      });
    } finally { signal?.removeEventListener('abort', cancel); }

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
      this.trace('FILE_LOCK_RELEASED', { label, token });
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
