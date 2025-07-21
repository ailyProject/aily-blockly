import { Component, ViewChild, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SimplebarAngularComponent, SimplebarAngularModule } from 'simplebar-angular';
import { LogService } from '../../services/log.service';
import { AnsiPipe } from './ansi.pipe';
import { NzMessageService } from 'ng-zorro-antd/message';
import { UiService } from '../../services/ui.service';

@Component({
  selector: 'app-log',
  imports: [CommonModule, SimplebarAngularModule, AnsiPipe],
  templateUrl: './log.component.html',
  styleUrl: './log.component.scss',
})
export class LogComponent implements OnDestroy {
  @ViewChild(SimplebarAngularComponent) simplebar: SimplebarAngularComponent;
  private clickTimeout: any;
  private preventSingleClick = false;

  get logList() {
    return this.logService.list;
  }

  options = {
    autoHide: true,
    clickOnTrack: true,
    scrollbarMinSize: 50,
  };

  constructor(
    private logService: LogService,
    private message: NzMessageService,
    private uiService: UiService
  ) { }

  ngAfterViewInit() {
    setTimeout(() => this.scrollToBottom(), 100);
    this.logService.stateSubject.subscribe((opts) => {
      console.log('logService stateSubject', opts);
      console.log(opts.timestamp);
      setTimeout(() => this.scrollToBottom(), 100);
    });
  }

  clear() {
    this.logService.clear();
  }

  ngOnDestroy() {
    if (this.clickTimeout) {
      clearTimeout(this.clickTimeout);
    }
  }

  // 处理点击事件，区分单击和双击
  handleClick(item: any, event: MouseEvent) {
    this.clickTimeout = setTimeout(() => {
      if (!this.preventSingleClick) {
        this.copyLogItemToClipboard(item);
      }
      this.preventSingleClick = false;
    }, 250);
  }

  // 处理双击事件
  handleDoubleClick(item: any, event: MouseEvent) {
    this.preventSingleClick = true;
    if (this.clickTimeout) {
      clearTimeout(this.clickTimeout);
    }
    this.copyLogItemToChat(item);
  }

  // 单击复制日志内容到剪切板
  async copyLogItemToClipboard(item: any) {
    try {
      const logContent = `${item.detail}`;
      await navigator.clipboard.writeText(logContent);
      this.message.success('日志内容已复制到剪切板');
    } catch (err) {
      console.error('复制到剪切板失败:', err);
    }
  }

  // 双击打开AI助手并发送日志内容
  async copyLogItemToChat(item: any) {
    // 这里可以实现将日志内容发送到AI助手的逻辑
    // 例如，调用一个服务方法来处理这个操作
    this.uiService.openTool("aily-chat");
    setTimeout(() => {
      window.sendToAilyChat(`运行日志：\n${item.detail}`, {
        sender: 'LogComponent',
        type: 'log'
        // cover: true 是默认值，可以省略
      });
    }, 100);
    this.message.info('日志内容已发送到AI助手');
  }

  private scrollToBottom(): void {
    if (this.simplebar?.SimpleBar) {
      this.simplebar.SimpleBar.getScrollElement().scrollTop = this.simplebar.SimpleBar.getScrollElement().scrollHeight;
    }
  }
}
