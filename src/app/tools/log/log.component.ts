import { Component, OnDestroy, OnInit, AfterViewInit, ElementRef, ChangeDetectorRef, viewChild, viewChildren, effect, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { injectVirtualizer } from '@tanstack/angular-virtual';
import { LogService, LogOptions, ElectronService } from '@core/platform/public-api';
import { AnsiPipe } from './ansi.pipe';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzInputModule } from 'ng-zorro-antd/input';
import { UiService } from '@core/app-shell/public-api';
import { ProjectService } from '@domain/project/public-api';
import { stripAnsi } from 'fancy-ansi';
import { Subscription } from 'rxjs';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ToolI18nService } from '@core/preferences/public-api';
import type { NoticeLogTarget } from '@shared/public-api';

@Component({
  selector: 'app-log',
  imports: [CommonModule, FormsModule, AnsiPipe, NzSwitchModule, NzInputModule, TranslateModule],
  templateUrl: './log.component.html',
  styleUrl: './log.component.scss',
})
export class LogComponent implements OnInit, AfterViewInit, OnDestroy {
  private clickTimeout: any;
  private preventSingleClick = false;
  private subscription: Subscription = new Subscription();
  private readVersion = 0;
  private generation = 0;
  private nextOffset = 0;
  private beforeOffset = 0;
  private hasMoreHistory = false;
  private readingNew = false;
  private readingOlder = false;
  private pendingNew = false;
  private readErrorShown = false;
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxVisible = 5000;
  private initialization?: Promise<void>;
  private destroyed = false;
  private revealVersion = 0;
  private revealing = false;
  private focusedLog?: NoticeLogTarget;

  // 滚动容器引用
  scrollElement = viewChild<ElementRef<HTMLDivElement>>('scrollElement');

  // 虚拟行元素引用（用于动态测量高度）
  virtualRows = viewChildren<ElementRef<HTMLDivElement>>('virtualRow');

  // 日志列表
  logList: LogOptions[] = [];

  // 只显示 error 类型日志
  showOnlyErrors = false;

  logSearchKeyword = '';
  showSearchToolbar = false;

  // 日志数量 signal，用于驱动 virtualizer 响应式更新
  logCount = signal(0);

  // TanStack 虚拟化器
  virtualizer = injectVirtualizer(() => ({
    scrollElement: this.scrollElement(),
    count: this.logCount(),
    getItemKey: index => this.logList[index]?.seq ?? this.logList[index]?.mergeKey ?? this.logList[index]?.offset ?? index,
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
    private translate: TranslateService,
    private toolI18n: ToolI18nService
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
    this.initialization = this.initTool();
  }

  private async initTool(): Promise<void> {
    await this.toolI18n.load('log');
    await this.reloadTail();
  }

  ngAfterViewInit() {
    // 监听日志更新
    this.subscription.add(
      this.logService.stateSubject.subscribe(item => {
        if (!item.title && !item.detail) {
          void this.reloadTail();
        } else {
          this.scheduleReadNew();
        }
      })
    );
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

  /** 打开通知对应的日志，并保留相邻输出作为上下文。 */
  async reveal(target?: NoticeLogTarget): Promise<void> {
    const request = ++this.revealVersion;
    await this.initialization;
    if (this.destroyed || request !== this.revealVersion) return;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (this.scrollTimeoutId) clearTimeout(this.scrollTimeoutId);
    this.logSearchKeyword = '';
    this.showOnlyErrors = false;
    this.focusedLog = target;
    const version = ++this.readVersion;
    this.revealing = true;
    try {
      let page = await this.logService.readPage({ mode: 'tail', limit: 500 });
      if (version !== this.readVersion) return;
      const nextOffset = page.nextOffset;
      let entries = page.entries;
      let index = target ? entries.findIndex(item => this.matchesTarget(item, target)) : -1;
      // 目标可能已离开最近 500 条预览，逐页向前查找；内存窗口仍有界。
      while (target && index < 0 && page.hasMore && page.beforeOffset > 0) {
        const previousOffset = page.beforeOffset;
        page = await this.logService.readPage({
          mode: 'before', beforeOffset: previousOffset, generation: page.generation, limit: 500,
        });
        if (version !== this.readVersion) return;
        if (page.reset) { await this.reloadTail(); return; }
        entries = [...page.entries, ...entries].slice(0, this.maxVisible);
        index = entries.findIndex(item => this.matchesTarget(item, target));
        if (page.beforeOffset >= previousOffset) break;
      }
      if (target && index < 0) {
        // 清空后旧通知不再有对应记录，正常显示当前日志，不重新写入旧错误。
        this.focusedLog = undefined;
        await this.reloadTail();
        return;
      }
      this.generation = page.generation;
      this.beforeOffset = page.beforeOffset;
      this.nextOffset = nextOffset;
      this.hasMoreHistory = page.hasMore;
      this.logList = entries;
      this.logCount.set(entries.length);
      this.virtualizer.measure();
      this.readErrorShown = false;
      this.cdr.detectChanges();
      if (index < 0) this.scrollToBottom();
      else this.scrollToLog(index, version);
    } catch (error) {
      if (version === this.readVersion) this.reportReadError(error);
    } finally {
      if (version === this.readVersion) this.revealing = false;
    }
  }

  private scrollToLog(index: number, version: number, attempt = 0): void {
    this.scrollTimeoutId = setTimeout(() => {
      if (version !== this.readVersion) return;
      // 变高行首次进入视口后才获得真实高度，重新定位以消除估高及滚动补偿的偏移。
      this.virtualizer.scrollToIndex(index, { align: 'start' });
      if (attempt < 8) this.scrollToLog(index, version, attempt + 1);
    }, 30);
  }

  private matchesTarget(item: LogOptions, target: NoticeLogTarget): boolean {
    if (target.mergeKey) return item.mergeKey === target.mergeKey;
    const detail = item.previewTruncated ? item.detail?.replace(/…$/, '') : item.detail;
    return item.timestamp === target.timestamp && item.title === target.title
      && (detail === target.detail || (!!detail && !!target.detail
        && (detail.startsWith(target.detail) || target.detail.startsWith(detail))));
  }

  isFocusedLog(item: LogOptions): boolean {
    return !!this.focusedLog && this.matchesTarget(item, this.focusedLog);
  }

  private normalizeSearchText(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
  }

  private readOptions() {
    return {
      errorsOnly: this.showOnlyErrors,
      keyword: this.normalizeSearchText(this.logSearchKeyword),
      limit: 500,
    };
  }

  private async reloadTail(): Promise<void> {
    this.revealing = false;
    const version = ++this.readVersion;
    try {
      const page = await this.logService.readPage({ mode: 'tail', ...this.readOptions() });
      if (version !== this.readVersion) return;
      this.generation = page.generation;
      this.beforeOffset = page.beforeOffset;
      this.nextOffset = page.nextOffset;
      this.hasMoreHistory = page.hasMore;
      this.logList = page.entries;
      this.readErrorShown = false;
      this.logCount.set(this.logList.length);
      this.cdr.detectChanges();
      if (this.normalizeSearchText(this.logSearchKeyword)) this.scrollToTop();
      else this.scrollToBottom();
    } catch (error) {
      this.reportReadError(error);
      if (version === this.readVersion) {
        this.logList = [];
        this.logCount.set(0);
        this.cdr.detectChanges();
      }
    }
  }

  private scheduleReadNew(): void {
    if (this.readTimer) return;
    this.readTimer = setTimeout(() => {
      this.readTimer = null;
      void this.readNew();
    }, 80);
  }

  private async readNew(): Promise<void> {
    if (this.revealing) { this.scheduleReadNew(); return; }
    if (this.readingNew) {
      this.pendingNew = true;
      return;
    }
    this.readingNew = true;
    const version = this.readVersion;
    try {
      let hasMore = true;
      let pages = 0;
      while (hasMore && version === this.readVersion && pages++ < 20) {
        const previousOffset = this.nextOffset;
        const page = await this.logService.readPage({
          mode: 'after', afterOffset: this.nextOffset, generation: this.generation, ...this.readOptions(),
        });
        if (version !== this.readVersion) return;
        if (page.reset) { await this.reloadTail(); return; }
        this.nextOffset = page.nextOffset;
        this.readErrorShown = false;
        if (page.entries.length) {
          const element = this.scrollElement()?.nativeElement;
          const shouldFollow = !!element && element.scrollHeight - element.scrollTop - element.clientHeight < 48;
          this.logList = [...this.logList, ...page.entries].slice(-this.maxVisible);
          this.logCount.set(this.logList.length);
          this.cdr.detectChanges();
          if (shouldFollow && !this.focusedLog && !this.normalizeSearchText(this.logSearchKeyword)) this.scrollToBottom();
        }
        hasMore = page.hasMore && page.nextOffset > previousOffset;
      }
      if (hasMore) this.pendingNew = true;
    } catch (error) {
      this.reportReadError(error);
    } finally {
      this.readingNew = false;
      if (this.pendingNew) {
        this.pendingNew = false;
        this.scheduleReadNew();
      }
    }
  }

  onLogScroll(): void {
    const element = this.scrollElement()?.nativeElement;
    if (element && element.scrollTop < 48 && this.hasMoreHistory && !this.revealing && !this.readingOlder && this.logList.length < this.maxVisible) {
      void this.readOlder();
    }
  }

  private async readOlder(): Promise<void> {
    if (this.logList.length >= this.maxVisible) return;
    this.readingOlder = true;
    const version = this.readVersion;
    try {
      const page = await this.logService.readPage({
        mode: 'before', beforeOffset: this.beforeOffset, generation: this.generation,
        ...this.readOptions(), limit: Math.min(500, this.maxVisible - this.logList.length),
      });
      if (version !== this.readVersion) return;
      if (page.reset) { await this.reloadTail(); return; }
      this.beforeOffset = page.beforeOffset;
      this.readErrorShown = false;
      this.hasMoreHistory = page.hasMore && page.entries.length > 0;
      if (page.entries.length) {
        this.logList = [...page.entries, ...this.logList];
        this.logCount.set(this.logList.length);
        this.cdr.detectChanges();
        this.virtualizer.scrollToIndex(page.entries.length, { align: 'start' });
      }
    } catch (error) {
      this.reportReadError(error);
    } finally {
      this.readingOlder = false;
    }
  }

  private reportReadError(error: unknown): void {
    console.error('读取底部日志失败:', error);
    if (!this.readErrorShown) {
      this.readErrorShown = true;
      this.message.error(String(error));
    }
  }

  onErrorFilterChange(showOnlyErrors: boolean) {
    this.focusedLog = undefined;
    this.showOnlyErrors = showOnlyErrors;
    void this.reloadTail();
  }

  onLogSearchChange(keyword: string) {
    this.focusedLog = undefined;
    this.logSearchKeyword = keyword || '';
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.reloadTail();
    }, 180);
  }

  toggleSearchToolbar() {
    this.showSearchToolbar = !this.showSearchToolbar;
    this.cdr.detectChanges();
  }

  private scrollToTop() {
    if (this.scrollTimeoutId) {
      clearTimeout(this.scrollTimeoutId);
    }
    this.scrollTimeoutId = setTimeout(() => {
      if (this.logCount() > 0) {
        this.virtualizer.scrollToIndex(0, { align: 'start' });
      }
    }, 30);
  }

  async clear() {
    this.focusedLog = undefined;
    try {
      await this.logService.clear();
      this.logList = [];
      this.logCount.set(0);
      this.cdr.detectChanges();
      await this.reloadTail();
    } catch (error) {
      console.error('清空底部日志失败:', error);
      this.message.error(String(error));
    }
  }

  ngOnDestroy() {
    this.destroyed = true;
    if (this.clickTimeout) {
      clearTimeout(this.clickTimeout);
    }
    if (this.scrollTimeoutId) {
      clearTimeout(this.scrollTimeoutId);
    }
    if (this.readTimer) clearTimeout(this.readTimer);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.readVersion++;
    this.subscription.unsubscribe();
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

  // 清理日志内容：去除 ANSI 格式化字符和每行开头的状态标识
  private cleanLogContent(text: string): string {
    if (!text) return '';
    // 先去除 ANSI 格式化字符
    let cleaned = stripAnsi(text);
    cleaned = this.applyBackspaceControl(cleaned);
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    cleaned = cleaned.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
    // 再去除每行开头的状态标识，如 [ERROR]、[INFO]、[WARN] 等
    cleaned = cleaned.replace(/^\s*\[(ERROR|INFO|WARN|WARNING|DEBUG|TRACE|FATAL)\]\s*/gim, '');
    return cleaned;
  }

  private applyBackspaceControl(text: string): string {
    if (!text.includes('\b')) {
      return text;
    }

    const output: string[] = [];
    for (const char of text) {
      if (char === '\b') {
        const previousChar = output[output.length - 1];
        if (previousChar && previousChar !== '\n' && previousChar !== '\r') {
          output.pop();
        }
      } else {
        output.push(char);
      }
    }
    return output.join('');
  }

  // 单击复制日志内容到剪切板
  async copyLogItemToClipboard(item: LogOptions) {
    try {
      const fullItem = await this.logService.readEntry(item, this.generation);
      const logContent = this.cleanLogContent(fullItem.detail);
      await this.electronService.clipboardWriteText(logContent);
      this.message.success(this.translate.instant('LOG.COPIED_TO_CLIPBOARD'));
    } catch (err) {
      console.error('复制到剪切板失败:', err);
    }
  }

  // 双击打开AI助手并发送日志内容
  async copyLogItemToChat(item: LogOptions) {
    try {
      const fullItem = await this.logService.readEntry(item, this.generation);
      const cleanDetail = this.cleanLogContent(fullItem.detail);
      this.uiService.openAndSendToChat(`log:\n${cleanDetail}`, {
        sender: 'LogComponent',
        type: 'log'
      });
      this.message.info(this.translate.instant('LOG.SENT_TO_AI'));
    } catch (error) {
      console.error('读取完整日志失败:', error);
      this.message.error(String(error));
    }
  }

  async exportData() {
    let preview;
    try {
      preview = await this.logService.readPage({ mode: 'tail', limit: 1 });
    } catch (error) {
      console.error('检查底部日志导出内容失败:', error);
      this.message.error(String(error));
      return;
    }
    if (preview.entries.length === 0) {
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

    try {
      await this.logService.exportText(folderPath);
      this.message.success(this.translate.instant('LOG.EXPORT_SUCCESS') + folderPath);
    } catch (error) {
      console.error('导出底部日志失败:', error);
      this.message.error(String(error));
    }
  }

}
