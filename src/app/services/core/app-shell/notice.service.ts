import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { LogService } from '@core/platform/public-api';
import type { NoticeOptions } from '@shared/public-api';

export type { NoticeOptions } from '@shared/public-api';

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

  updateOwned(owner: string, opts: NoticeOptions): boolean {
    if (!owner) return false;
    this.ownedNotices.set(owner, opts);
    if (this.data?.state === 'doing' && this.owner !== owner) return false;
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
    this.stateSubject.next(opts);

    const sendToLog = opts.sendToLog ?? true;
    if (writeLog && sendToLog && opts.detail) {
      this.logService.update({
        title: opts.title,
        detail: opts.detail,
        state: opts.state,
      })
    }
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
