import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class LogService {

  list: LogOptions[] = [];

  stateSubject = new Subject<LogOptions>();

  private readonly MAX_LOG_SIZE = 10000;
  // 超出此阈值才触发清理，避免每条都执行清理，每 500 条触发一次
  private readonly CLEANUP_THRESHOLD = this.MAX_LOG_SIZE + 500;

  constructor() { }

  /**
   * 使用提供的选项更新日志状态。
   * @param opts - 要更新和发送的日志选项。
   */
  update(opts: LogOptions) {
    // 过滤掉无效的日志条目
    if (!opts.title && !opts.detail) return;
    if (opts.title === 'undefined') opts.title = '';
    if (opts.detail === 'undefined') opts.detail = '';

    opts['timestamp'] = Date.now();
    // opts['showDetail'] = false;
    this.list.push(opts);
    if (this.list.length > this.CLEANUP_THRESHOLD) {
      this.list.splice(0, this.list.length - this.MAX_LOG_SIZE);
    }
    this.stateSubject.next(opts);
  }

  clear() {
    this.list = [];
  }
}

export interface LogOptions {
  id?: number;
  title?: string;
  detail?: string;
  state?: string;
  timestamp?: number;
}