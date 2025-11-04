import { Component, OnDestroy, OnInit, AfterViewInit, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Datasource, SizeStrategy, UiScrollModule } from 'ngx-ui-scroll';
import { LogService, LogOptions } from '../../services/log.service';
import { AnsiPipe } from './ansi.pipe';
import { NzMessageService } from 'ng-zorro-antd/message';
import { UiService } from '../../services/ui.service';
import { ProjectService } from '../../services/project.service';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-log',
  imports: [CommonModule, AnsiPipe, UiScrollModule],
  templateUrl: './log.component.html',
  styleUrl: './log.component.scss',
})
export class LogComponent {
  private clickTimeout: any;
  private preventSingleClick = false;

  // 虚拟滚动数据源
  datasource;

  // = new Datasource<LogOptions>({
  //   get: (index: number, count: number) => {
  //     console.log(`Datasource get called: index=${index}, count=${count}, total=${this.logService.list.length}`);
  //     const data: LogOptions[] = [];
  //     const startIndex = Math.max(0, index);
  //     const endIndex = Math.min(this.logService.list.length, startIndex + count);

  //     for (let i = startIndex; i < endIndex; i++) {
  //       if (this.logService.list[i]) {
  //         this.logService.list[i]['id'] = i; // 确保每个日志项都有唯一的 ID
  //         data.push(this.logService.list[i]);
  //       }
  //     }

  //     console.log(`Datasource returning ${data.length} items for range [${startIndex}, ${endIndex})`);

  //     return Promise.resolve(data);
  //   },

  //   settings: {
  //     minIndex: 0,
  //     startIndex: 0,
  //     bufferSize: 30, // 减少缓冲区大小，降低内存使用
  //     padding: 0.3, // 适中的 padding 值
  //     sizeStrategy: SizeStrategy.Frequent
  //   }
  // });

  get logList() {
    return this.logService.list;
  }

  constructor(
    private logService: LogService,
    private message: NzMessageService,
    private uiService: UiService,
    private projectService: ProjectService,
    private electronService: ElectronService
  ) { }

  ngOnInit() {
    let startIndex = 0;
    if (this.logService.list.length > 0) {
      startIndex = this.logService.list.length - 1;
    }

    this.datasource = new Datasource<LogOptions>({
      get: (index: number, count: number) => {
        // console.log(`Datasource get called: index=${index}, count=${count}, total=${this.logService.list.length}`);
        const data: LogOptions[] = [];
        const startIndex = Math.max(0, index);
        const endIndex = Math.min(this.logService.list.length, startIndex + count);

        for (let i = startIndex; i < endIndex; i++) {
          if (this.logService.list[i]) {
            this.logService.list[i]['id'] = i; // 确保每个日志项都有唯一的 ID
            data.push(this.logService.list[i]);
          }
        }
        return Promise.resolve(data);
      },

      settings: {
        minIndex: 0,
        startIndex,
        bufferSize: 30, // 增加缓冲区大小,提升滚动流畅度
        padding: 0.5, // 适中的 padding 值
        itemSize: 24,
        sizeStrategy: SizeStrategy.Average
      }
    });
  }

  ngAfterViewInit() {
    // 监听日志更新
    this.logService.stateSubject.subscribe((opts) => {
      this.handleLogUpdate();
    });

    if (this.logService.list.length > 0) {
      this.scrollToBottom();
    }
  }

  @ViewChild('logBox', { static: false }) logBoxRef!: ElementRef<HTMLDivElement>;
  scrollToBottom() {
    setTimeout(() => {
      requestAnimationFrame(() => {
        if (this.logBoxRef) {
          const element = this.logBoxRef.nativeElement;
          // 使用 scrollTo 方法实现平滑滚动
          element.scrollTo({
            top: element.scrollHeight,
            behavior: 'auto'
          });
        }
      });
    }, 100);
  }

  // 处理日志更新的新方法
  private handleLogUpdate() {
    const currentLogCount = this.logService.list.length;

    // 如果日志被清空
    if (currentLogCount === 0) {
      if (this.datasource.adapter) {
        this.datasource.adapter.reload(0);
      }
      return;
    }
    const startIndex = currentLogCount - 1;
    this.datasource.adapter.reload(startIndex).then(() => {
      this.scrollToBottom();
    });
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
    // this.lastLogCount = 0;
  }

  // 处理点击事件，区分单击和双击
  handleClick(item: any, event: MouseEvent) {
    console.log('单击事件:', item);

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

  async exportData() {
    if (this.logService.list.length === 0) {
      this.message.warning('没有日志数据可以导出');
      return;
    }

    // 弹出保存对话框
    const folderPath = await window['ipcRenderer'].invoke('select-folder-saveAs', {
      title: '导出日志数据',
      path: this.projectService.currentProjectPath,
      suggestedName: 'log_' + new Date().toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).replace(/[/,:]/g, '_').replace(/\s/g, '_') + '.txt',
      filters: [
        { name: '文本文件', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });

    if (!folderPath) {
      return;
    }

    // 准备要写入的内容
    let fileContent = '';

    for (const item of this.logService.list) {
      const timeString = new Date(item.timestamp).toLocaleTimeString();
      fileContent += `[${timeString}] ${item.detail || ''}\n`;
    }

    // 写入文件
    this.electronService.writeFile(folderPath, fileContent);
    this.message.success('日志数据已成功导出到' + folderPath);
  }

}
