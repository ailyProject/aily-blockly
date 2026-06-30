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
  closable?: boolean,
  icon?: string,
  isCancellationNotice?: boolean,
  /** 错误通知上的「重试」动作（例如 Aily Code npm install 失败后再跑一次） */
  onRetry?: () => void,
}
