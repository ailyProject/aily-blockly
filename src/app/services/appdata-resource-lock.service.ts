import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class AppDataResourceLockService {
  private tail: Promise<void> = Promise.resolve();
  private queuedCount = 0;

  async runExclusive<T>(label: string, task: () => Promise<T> | T): Promise<T> {
    return this.runWithLocalWriteQueue(label, 'write', task);
  }

  async runShared<T>(label: string, task: () => Promise<T> | T): Promise<T> {
    return this.runWithFileLock(label, 'read', task);
  }

  private async runWithLocalWriteQueue<T>(label: string, mode: 'read' | 'write', task: () => Promise<T> | T): Promise<T> {
    const queuedAt = Date.now();
    const previous = this.tail.catch(() => undefined);
    let release!: () => void;

    this.queuedCount += 1;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    this.queuedCount = Math.max(0, this.queuedCount - 1);

    try {
      return await this.runWithFileLock(label, mode, task, Date.now() - queuedAt);
    } finally {
      release();
    }
  }

  private async runWithFileLock<T>(label: string, mode: 'read' | 'write', task: () => Promise<T> | T, localWaitMs = 0): Promise<T> {
    const startedAt = Date.now();
    let fileLockToken: string | undefined;

    this.trace('LOCAL_LOCK_ACQUIRED', {
      label,
      mode,
      waitMs: localWaitMs,
      queuedCount: this.queuedCount
    });

    try {
      const fileLock = await this.acquireFileLock(label, mode);
      fileLockToken = fileLock.token;
      this.trace('FILE_LOCK_ACQUIRED', {
        label,
        mode,
        token: fileLockToken,
        waitMs: fileLock.waitMs
      });

      return await task();
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

  private async acquireFileLock(label: string, mode: 'read' | 'write'): Promise<{ token: string; waitMs: number }> {
    if (!window['ipcRenderer']?.invoke) {
      return { token: '', waitMs: 0 };
    }

    const result = await window['ipcRenderer'].invoke('appdata-resource-lock-acquire', {
      label,
      mode,
      timeoutMs: 30 * 60 * 1000
    });

    if (!result?.ok) {
      throw new Error(result?.error || 'APPDATA_RESOURCE_LOCK_FAILED');
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
      await window['ipcRenderer'].invoke('appdata-resource-lock-release', { token });
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
