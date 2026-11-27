import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { LogService } from '@core/platform/public-api';
import type { NoticeOptions } from '@shared/public-api';

export type { NoticeOptions } from '@shared/public-api';

/** Let the renderer paint before synchronous toolchain or firmware checks.
 * A minimized window may stop producing frames after the visibility check. */
export function yieldForNoticePaint(): Promise<void> {
  if (typeof document === 'undefined' || document.hidden || !document.querySelector('app-notification')) return Promise.resolve();
  return new Promise(resolve => {
    const fallback = window.setTimeout(() => {
      window.cancelAnimationFrame(frame);
      resolve();
    }, 64);
    const frame = window.requestAnimationFrame(() => {
      window.clearTimeout(fallback);
      window.setTimeout(resolve, 0);
    });
  });
}

@Injectable({
  providedIn: 'root'
})
export class NoticeService {

  data: NoticeOptions;
  private owner: string | undefined;
  private readonly ownedNotices = new Map<string, NoticeOptions>();

  stateSubject = new Subject<NoticeOptions>();

  // noticeList: NoticeOptions[] = [];

  constructor(
    private logService: LogService
  ) { }

  /** Restore live ownership after editor recreation or a temporary error.
   * Completed/legacy notices are not replayed and active tasks keep priority. */
  restoreOwnedPresentation(): boolean {
    let next: [string, NoticeOptions] | undefined;
    if (this.data?.state === 'doing') {
      if (!this.owner || this.ownedNotices.get(this.owner) !== this.data) return false;
      next = [this.owner, this.data];
    } else {
      next = [...this.ownedNotices.entries()].reverse().find(([, notice]) => notice.state === 'doing');
    }
    if (!next) return false;
    this.owner = next[0];
    this.publish(next[1], false);
    return true;
  }

  update(opts: NoticeOptions) {
    this.owner = undefined;
    this.publish(opts);
  }

  /** Only retire this preparation notice if no progress, error or other task has replaced it. */
  beginPreparation(opts: NoticeOptions, visible = true) {
    if (this.data?.state === 'doing') return undefined;
    const notice = { ...opts, preparationId: crypto.randomUUID() };
    this.update(notice);
    return {
      painted: visible ? yieldForNoticePaint() : Promise.resolve(),
      close: () => { if (this.data === notice) this.clear(); },
    };
  }

  updateOwned(owner: string, opts: NoticeOptions): boolean {
    if (!owner) return false;
    this.ownedNotices.set(owner, opts);
    const keepsPanel = this.data?.state === 'doing' && (!this.data.preparationId || !!this.data.stop);
    if (keepsPanel && this.owner !== owner) return false;
    this.owner = owner;
    this.publish(opts);
    return true;
  }

  clearOwned(owner: string): boolean {
    this.ownedNotices.delete(owner);
    if (!owner || this.owner !== owner) return false;
    this.clear();
    return true;
  }

  private publish(opts: NoticeOptions, writeLog = true): void {
    this.data = opts;
    opts['showDetail'] = false;

    const sendToLog = opts.sendToLog ?? true;
    if (writeLog && sendToLog && opts.detail) {
      opts.logTarget = this.logService.update({
        title: opts.title,
        detail: opts.detail,
        state: opts.state,
        mergeKey: `notice-${crypto.randomUUID()}`,
      });
    } else if (writeLog && opts.detail && !opts.logTarget) {
      // 流式输出已经写入日志时，保留通知出现时的记录，而不是点击时的尾部。
      const clean = (text: string | undefined) => (text || '').replace(/\x1b\[[\d;]*m/g, '').trim();
      const details = [clean(opts.detail), clean(opts.text)].filter(Boolean);
      opts.logTarget = [...(this.logService.list || [])].reverse().find(item => {
        const detail = clean(item.detail);
        return !!detail && details.some(expected => expected.includes(detail) || detail.includes(expected));
      });
    }
    this.stateSubject.next(opts);
  }

  clear() {
    this.owner = undefined;
    this.data = null;
    this.stateSubject.next(null);
    // A temporary compiler/download notice must not consume another owner's
    // still-current presentation. Settled owners explicitly withdraw theirs.
    const pending = [...this.ownedNotices.entries()].reverse();
    const next = pending.find(([, notice]) => notice.state === 'doing') ?? pending[0];
    if (next) {
      this.owner = next[0];
      this.publish(next[1]);
    }
  }
}
