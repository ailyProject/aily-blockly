import { Injectable } from '@angular/core';
import { ProjectService } from './project.service';
import { ActionState } from './ui.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NoticeService } from '../services/notice.service';
import { CmdOutput, CmdService } from './cmd.service';
import { ActionService } from './action.service';

@Injectable({
  providedIn: 'root'
})
export class BuilderService {

  constructor(
    private actionService: ActionService,
  ) { }

  /*
   * 开始编译
   */
  async build() {
    new Promise<void>((resolve, reject) => {
      this.actionService.dispatch('compile-begin', {}, result => {
        if (result.success) {
          resolve()
        } else {
          reject()
        }
      });

    })
  }

  /*
   * 取消当前编译过程
   */
  cancel() {
    this.actionService.dispatch('compile-cancel', {}, result => {
      if (result.success) {
      } else {
      }
    });
  }
}
