import { Component, ChangeDetectorRef } from '@angular/core';
import { ActionState, UiService } from '../../../services/ui.service';
import { FOOTER_BTNS, IMenuItem } from '../../../configs/menu.config';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';

@Component({
  selector: 'app-footer',
  imports: [NzToolTipModule],
  templateUrl: './footer.component.html',
  styleUrl: './footer.component.scss'
})
export class FooterComponent {
  actionData: ActionState | null;
  timer;

  FOOTER_BTNS = FOOTER_BTNS;

  constructor(
    private uiService: UiService,
    private cd: ChangeDetectorRef
  ) {
    this.uiService.stateSubject.subscribe((state: ActionState) => {
      this.changeState(state);
    });
    // 其他窗口通过electron侧改变主窗口状态
    window['ipcRenderer'].on('state-update', (event, state: ActionState) => {
      this.changeState(state);
    });
  }

  changeState(e: ActionState) {
    this.actionData = e;
    this.cd.detectChanges();
    // 默认超时设置10秒, warn 和 error 不超时 
    if (!this.actionData.timeout && this.actionData.state === 'loading' || this.actionData.state === 'done') {
      this.actionData.timeout = 10000;
    }
    if (this.actionData.timeout) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.actionData = null;
        this.cd.detectChanges();
      }, this.actionData.timeout);
    }
  }

  async process(item: IMenuItem) {
    switch (item.action) {
      case 'log-open':
        this.uiService.turnBottomSider('log');
        break;
      case 'terminal-open':
        this.uiService.turnBottomSider('terminal');
        break;
      default:
        console.log('未处理的操作:', item.action);
        break;
    }
  }

  isButtonActive(item: IMenuItem): boolean {
    switch (item.action) {
      case 'log-open':
        return this.uiService.terminalIsOpen && this.uiService.currentBottomTab === 'log';
      case 'terminal-open':
        return this.uiService.terminalIsOpen && this.uiService.currentBottomTab === 'terminal';
      default:
        return false;
    }
  }
}
