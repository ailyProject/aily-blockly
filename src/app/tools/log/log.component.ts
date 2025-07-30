import { Component, OnDestroy, OnInit, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Datasource, UiScrollModule } from 'ngx-ui-scroll4';
import { LogService, LogOptions } from '../../services/log.service';
import { AnsiPipe } from './ansi.pipe';
import { NzMessageService } from 'ng-zorro-antd/message';
import { UiService } from '../../services/ui.service';

@Component({
  selector: 'app-log',
  imports: [CommonModule, AnsiPipe, UiScrollModule],
  templateUrl: './log.component.html',
  styleUrl: './log.component.scss',
})
export class LogComponent implements OnInit, OnDestroy, AfterViewInit {
  private clickTimeout: any;
  private preventSingleClick = false;
  private isInitialized = false;

  // 虚拟滚动数据源
  datasource = new Datasource<LogOptions>({
    get: (index: number, count: number) => {
      // console.log(`Datasource get called: index=${index}, count=${count}, total=${this.logService.list.length}`);
      const data: LogOptions[] = [];
      const startIndex = Math.max(0, index);
      const endIndex = Math.min(this.logService.list.length, startIndex + count);

      for (let i = startIndex; i < endIndex; i++) {
        if (this.logService.list[i]) {
          data.push(this.logService.list[i]);
        }
      }

      return Promise.resolve(data);
    },

    settings: {
      minIndex: 0,
      startIndex: 0, // 从0开始，确保稳定性
      bufferSize: 30, // 增加缓冲区大小，提高滚动性能
      padding: 0.5, // 增加padding，确保有足够的缓冲
      infinite: false
    }
  });

  get logList() {
    return this.logService.list;
  }

  constructor(
    private logService: LogService,
    private message: NzMessageService,
    private uiService: UiService
  ) { }

  ngOnInit() {
    // 监听日志更新
    this.logService.stateSubject.subscribe((opts) => {
      // console.log('logService stateSubject', opts);
      // console.log(opts.timestamp);
      if (this.isInitialized) {
        // 当有新日志时，重新加载数据源
        this.reloadDatasource();
      }
    });
  }

  ngAfterViewInit() {
    this.initializeAndScrollToBottom();
  }

  private initializeAndScrollToBottom() {
    if (this.logService.list.length > 0) {
      // 如果有日志数据，使用更安全的方式加载并滚动
      // 不要从最后一个索引开始，而是从合理的范围开始
      const startIndex = Math.max(0, this.logService.list.length - 100); // 显示最后100项，避免空白

      const reloadPromise = this.datasource.adapter.reload(startIndex);
      if (reloadPromise && typeof reloadPromise.then === 'function') {
        reloadPromise.then(() => {
          this.isInitialized = true;
          // 等待更长时间确保渲染完成
          setTimeout(() => {
            this.forceScrollToBottom();
          }, 100);
        });
      } else {
        this.isInitialized = true;
        setTimeout(() => {
          this.forceScrollToBottom();
        }, 100);
      }
    } else {
      // 如果没有数据，仍然需要初始化
      const relaxPromise = this.datasource.adapter.relax();
      if (relaxPromise && typeof relaxPromise.then === 'function') {
        relaxPromise.then(() => {
          this.isInitialized = true;
        });
      } else {
        this.isInitialized = true;
      }
    }
  }

  reloadDatasource() {
    // 重新加载整个数据源以确保显示最新数据
    if (this.datasource.adapter && this.logService.list.length > 0) {
      // 从合理的范围开始加载，避免空白屏幕
      const startIndex = Math.max(0, this.logService.list.length - 50); // 显示最后50项

      const reloadPromise = this.datasource.adapter.reload(startIndex);
      if (reloadPromise && typeof reloadPromise.then === 'function') {
        reloadPromise.then(() => {
          // 重新加载后直接使用原生滚动
          setTimeout(() => {
            this.forceScrollToBottom();
          }, 100);
        });
      } else {
        // 如果 reload() 没有返回 Promise，直接滚动到底部
        setTimeout(() => {
          this.forceScrollToBottom();
        }, 100);
      }
    }
  }

  clear() {
    this.logService.clear();
    if (this.datasource.adapter) {
      this.datasource.adapter.reload(0);
    }
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
      });
    }, 100);
    this.message.info('日志内容已发送到AI助手');
  }

  private forceScrollToBottom(): void {
    // 先确保虚拟滚动定位到最后一个元素
    if (this.datasource.adapter && this.logService.list.length > 0) {
      const lastIndex = this.logService.list.length - 1;

      // 使用 reload 方法重新加载并定位到最后一个元素
      const reloadPromise = this.datasource.adapter.reload(lastIndex);
      if (reloadPromise && typeof reloadPromise.then === 'function') {
        reloadPromise.then(() => {
          // 等待虚拟滚动完成后，再进行原生滚动到底部
          setTimeout(() => {
            const viewport = document.querySelector('.log-box');
            if (viewport) {
              viewport.scrollTop = viewport.scrollHeight;
            }
          }, 50);
        });
      } else {
        // 如果 reload() 没有返回 Promise，直接原生滚动
        setTimeout(() => {
          const viewport = document.querySelector('.log-box');
          if (viewport) {
            viewport.scrollTop = viewport.scrollHeight;
          }
        }, 50);
      }
    } else {
      // 如果没有虚拟滚动数据，直接原生滚动
      const viewport = document.querySelector('.log-box');
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    }
  }
}
