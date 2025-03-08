import { Component, ChangeDetectorRef } from '@angular/core';
import { ActionState, UiService } from '../../../services/ui.service';

@Component({
  selector: 'app-footer',
  imports: [],
  templateUrl: './footer.component.html',
  styleUrl: './footer.component.scss'
})
export class FooterComponent {
  actionData: ActionState | null;
  timer;

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
    // 默认超时设置12秒, warn 和 error 不超时 
    if (!this.actionData.timeout && this.actionData.state === 'loading' || this.actionData.state === 'done') {
      this.actionData.timeout = 12000;
    }
    if (this.actionData.timeout) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.actionData = null;
        this.cd.detectChanges();
      }, this.actionData.timeout);
    }
  }
}
