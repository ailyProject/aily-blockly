import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { LogService } from './log.service';

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

export interface NoticeOptions {
  title?: string,
  text?: string,
  state?: string,
  showProgress?: boolean,
  progress?: number,
  setTimeout?: number,
  stop?: Function,
  detail?: string,
  showDetail?: boolean,
  timestamp?: number,
  sendToLog?: boolean,
}
