// 这个函数用于通过electron端控制终端

import { Injectable } from '@angular/core';
import { UiService } from '../../services/ui.service';

@Injectable({
  providedIn: 'root'
})
export class TerminalService {

  isLocked = false;

  currentPid;

  constructor(
  ) { }

  async create(opts) {
    const { pid } = await window['terminal'].init({
      cols: 120,
      rows: 200,
      cwd: opts.cwd
    })
    this.currentPid = pid;
  }

  close() {
    window['terminal'].close({ pid: this.currentPid });
  }

  resize(opts) {
    window['terminal'].resize({ pid: this.currentPid, cols: opts.cols, rows: opts.rows });
  }

  send(input: string) {
    window['terminal'].sendInput({ pid: this.currentPid, input });
  }

  // sendCmd(cmd: string) {
  //   window['terminal'].sendInput({ pid: this.currentPid, input: cmd + '\r' });
  // }

  async sendCmd(input: string): Promise<any> {
    return new Promise(async (resolve, reject) => {
      window['terminal'].sendInputAsync({ pid: this.currentPid, input: input + '\r' })
        .then(output => {
          resolve(output);
        })
        .catch(err => {
          console.error('执行错误:', err);
        });
    });
  }
}
