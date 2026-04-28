import { Component, OnDestroy, OnInit, AfterViewInit, ElementRef, ChangeDetectorRef, viewChild, viewChildren, effect, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { injectVirtualizer } from '@tanstack/angular-virtual';
import { LogService, LogOptions } from '../../services/log.service';
import { AnsiPipe } from './ansi.pipe';
import { NzMessageService } from 'ng-zorro-antd/message';
import { UiService } from '../../services/ui.service';
import { ProjectService } from '../../services/project.service';
import { ElectronService } from '../../services/electron.service';
import { stripAnsi } from 'fancy-ansi';
import { Subscription } from 'rxjs';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-log',
  imports: [CommonModule, AnsiPipe, TranslateModule],
  templateUrl: './log.component.html',
  styleUrl: './log.component.scss',
})
export class LogComponent implements OnInit, AfterViewInit, OnDestroy {
  private clickTimeout: any;
  private preventSingleClick = false;
  private subscription: Subscription = new Subscription();

  // 滚动容器引用
  scrollElement = viewChild<ElementRef<HTMLDivElement>>('scrollElement');

  // 虚拟行元素引用（用于动态测量高度）
  virtualRows = viewChildren<ElementRef<HTMLDivElement>>('virtualRow');

  // 日志列表
  logList: LogOptions[] = [];

  // 日志数量 signal，用于驱动 virtualizer 响应式更新
  logCount = signal(0);

  // TanStack 虚拟化器
  virtualizer = injectVirtualizer(() => ({
    scrollElement: this.scrollElement(),
    count: this.logCount(),
    estimateSize: () => 30,
    overscan: 5,
  }));

  constructor(
    private logService: LogService,
    private message: NzMessageService,
    private uiService: UiService,
    private projectService: ProjectService,
    private electronService: ElectronService,
    private cdr: ChangeDetectorRef,
    private translate: TranslateService
  ) {
    // 当虚拟行元素变化时，动态测量每个元素的实际高度
    effect(() => {
      const rows = this.virtualRows();
      untracked(() => {
        for (const row of rows) {
          this.virtualizer.measureElement(row.nativeElement);
        }
      });
    });
  }

  ngOnInit() {
    // 初始化日志列表
    this.logList = [...this.logService.list];
    this.logCount.set(this.logList.length);
  }

  ngAfterViewInit() {
    // 监听日志更新
    this.subscription.add(
      this.logService.stateSubject.subscribe(() => {
        this.handleLogUpdate();
      })
    );

    if (this.logService.list.length > 0) {
      this.scrollToBottom();
    }
  }

  // 滚动到底部
  scrollToBottom() {
    if (this.scrollTimeoutId) {
      clearTimeout(this.scrollTimeoutId);
    }
    this.scrollTimeoutId = setTimeout(() => {
      const count = this.logCount();
      if (count > 0) {
        this.virtualizer.scrollToIndex(count - 1, { align: 'end' });
      }
    }, 30);
  }

  private scrollTimeoutId: any;

  // 处理日志更新
  private handleLogUpdate() {
    this.logList = [...this.logService.list];
    this.logCount.set(this.logList.length);
    this.cdr.detectChanges();
    // 滚动到底部
    this.scrollToBottom();
  }

  clear() {
    this.logService.clear();
    this.logList = [];
    this.logCount.set(0);
    this.cdr.detectChanges();
  }

  ngOnDestroy() {
    if (this.clickTimeout) {
      clearTimeout(this.clickTimeout);
    }
    if (this.scrollTimeoutId) {
      clearTimeout(this.scrollTimeoutId);
    }
    this.subscription.unsubscribe();
  }

  // 处理点击事件，区分单击和双击
  handleClick(item: any, event: MouseEvent) {
    console.log('click event:', item);

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

  // 清理日志内容：去除 ANSI 格式化字符和每行开头的状态标识
  private cleanLogContent(text: string): string {
    if (!text) return '';
    // 先去除 ANSI 格式化字符
    let cleaned = stripAnsi(text);
    // 再去除每行开头的状态标识，如 [ERROR]、[INFO]、[WARN] 等
    cleaned = cleaned.replace(/^\s*\[(ERROR|INFO|WARN|WARNING|DEBUG|TRACE|FATAL)\]\s*/gim, '');
    return cleaned;
  }

  // 单击复制日志内容到剪切板
  async copyLogItemToClipboard(item: any) {
    try {
      const logContent = this.cleanLogContent(item.detail);
      await navigator.clipboard.writeText(logContent);
      this.message.success(this.translate.instant('LOG.COPIED_TO_CLIPBOARD'));
    } catch (err) {
      console.error('复制到剪切板失败:', err);
    }
  }

  // 双击打开AI助手并发送日志内容
  async copyLogItemToChat(item: any) {
    const cleanDetail = this.cleanLogContent(item.detail);
    this.uiService.openAndSendToChat(`log:\n${cleanDetail}`, {
      sender: 'LogComponent',
      type: 'log'
    });
    this.message.info(this.translate.instant('LOG.SENT_TO_AI'));
  }

  async exportData() {
    if (this.logService.list.length === 0) {
      this.message.warning(this.translate.instant('LOG.NO_DATA_TO_EXPORT'));
      return;
    }

    // 弹出保存对话框
    const folderPath = await window['ipcRenderer'].invoke('select-folder-saveAs', {
      title: this.translate.instant('LOG.EXPORT_TITLE'),
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
        { name: this.translate.instant('LOG.TEXT_FILE'), extensions: ['txt'] },
        { name: this.translate.instant('LOG.ALL_FILES'), extensions: ['*'] }
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
    this.message.success(this.translate.instant('LOG.EXPORT_SUCCESS') + folderPath);
  }

}
