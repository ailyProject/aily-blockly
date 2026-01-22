import { Component, OnDestroy, OnInit, AfterViewInit, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ScrollingModule, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { CdkAutoSizeVirtualScroll } from '@angular/cdk-experimental/scrolling';
import { LogService, LogOptions } from '../../services/log.service';
import { AnsiPipe } from './ansi.pipe';
import { NzMessageService } from 'ng-zorro-antd/message';
import { UiService } from '../../services/ui.service';
import { ProjectService } from '../../services/project.service';
import { ElectronService } from '../../services/electron.service';
import { stripAnsi } from 'fancy-ansi';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-log',
  imports: [CommonModule, AnsiPipe, ScrollingModule, CdkAutoSizeVirtualScroll],
  templateUrl: './log.component.html',
  styleUrl: './log.component.scss',
})
export class LogComponent implements OnInit, AfterViewInit, OnDestroy {
  private clickTimeout: any;
  private preventSingleClick = false;
  private subscription: Subscription = new Subscription();

  // 虚拟滚动视口引用
  @ViewChild(CdkVirtualScrollViewport) viewport!: CdkVirtualScrollViewport;

  // 日志列表 - 使用属性而非 getter，以便 CDK 正确检测变化
  logList: LogOptions[] = [];

  // 每项的估算高度（用于初始渲染）
  readonly minBufferPx = 200;
  readonly maxBufferPx = 400;

  constructor(
    private logService: LogService,
    private message: NzMessageService,
    private uiService: UiService,
    private projectService: ProjectService,
    private electronService: ElectronService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit() {
    // 初始化日志列表
    this.logList = this.logService.list;
  }

  ngAfterViewInit() {
    // 初始化时检查视口尺寸
    setTimeout(() => {
      if (this.viewport) {
        this.viewport.checkViewportSize();
      }
    }, 100);

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

  // 滚动到底部，使用多次尝试确保内容完全渲染
  scrollToBottom() {
    // 取消之前的滚动请求
    if (this.scrollTimeoutId) {
      clearTimeout(this.scrollTimeoutId);
    }

    const doScroll = (attempts = 0) => {
      if (!this.viewport) return;

      const element = this.viewport.elementRef.nativeElement;
      this.viewport.checkViewportSize();
      
      const scrollHeight = element.scrollHeight;
      const currentScroll = element.scrollTop + element.clientHeight;
      
      // 滚动到底部
      element.scrollTo({
        top: scrollHeight,
        behavior: attempts === 0 ? 'auto' : 'smooth'
      });

      // 如果还没到底部且尝试次数不超过3次，继续尝试
      if (attempts < 3 && scrollHeight > currentScroll + 10) {
        this.scrollTimeoutId = setTimeout(() => doScroll(attempts + 1), 100);
      }
    };

    // 等待变更检测和渲染完成后再滚动
    this.scrollTimeoutId = setTimeout(() => {
      requestAnimationFrame(() => {
        doScroll(0);
      });
    }, 50);
  }

  private scrollTimeoutId: any;

  // 处理日志更新
  private handleLogUpdate() {
    // 给每个日志项添加唯一 id
    this.logService.list.forEach((item, index) => {
      if (item['id'] === undefined) {
        item['id'] = index;
      }
    });
    // 更新引用以触发变更检测
    this.logList = [...this.logService.list];
    this.cdr.detectChanges();
    // 滚动到底部
    this.scrollToBottom();
  }

  clear() {
    this.logService.clear();
    this.logList = [];
    this.cdr.detectChanges();
  }

  // trackBy 函数，用于优化虚拟滚动性能
  trackByFn(index: number, item: LogOptions): number {
    return item['id'] ?? index;
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
    const cleanDetail = this.cleanLogContent(item.detail);
    setTimeout(() => {
      window.sendToAilyChat(`运行日志：\n${cleanDetail}`, {
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
