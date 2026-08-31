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

  stateSubject = new Subject<NoticeOptions>();

  // noticeList: NoticeOptions[] = [];

  constructor(
    private logService: LogService
  ) { }

  update(opts: NoticeOptions) {
    opts['showDetail'] = false;
    this.stateSubject.next(opts);

    const sendToLog = opts.sendToLog ?? true;
    if (sendToLog && opts.detail) {
      this.logService.update({
        title: opts.title,
        detail: opts.detail,
        state: opts.state,
      })
    }
  }

  clear() {
    this.stateSubject.next(null);
  }
}
