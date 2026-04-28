import { Component, Input, OnInit, OnDestroy, OnChanges, SimpleChanges, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatService } from '../../../services/chat.service';
import { ConfigService } from '../../../../../services/config.service';

@Component({
  selector: 'x-aily-library-viewer',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './x-aily-library-viewer.component.html',
  styleUrls: ['./x-aily-library-viewer.component.scss'],
})
export class XAilyLibraryViewerComponent implements OnInit, OnDestroy, OnChanges {
  @Input() data: { name?: string; library?: { name?: string } } | null = null;

  isLoading = false;
  errorMessage = '';
  libraryInfo: any = null;
  private retryTimer: any = null;
  private retryCount = 0;
  private readonly MAX_RETRY = 3;

  constructor(
    private cdr: ChangeDetectorRef,
    private chatService: ChatService,
    private configService: ConfigService,
  ) {}

  ngOnInit(): void {
    this.tryLoad();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data']) this.tryLoad();
  }

  private tryLoad(): void {
    const name = this.data?.name || this.data?.library?.name;
    if (name) this.loadLibraryInfo(name);
  }

  ngOnDestroy(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private loadLibraryInfo(name: string): void {
    this.isLoading = true;
    this.errorMessage = '';
    this.libraryInfo = this.configService.libraryDict?.[name] || null;
    if (this.libraryInfo) {
      this.isLoading = false;
      this.retryCount = 0;
    } else {
      this.scheduleRetry(() => this.loadLibraryInfo(name));
    }
    this.cdr.markForCheck();
  }

  installLibrary(): void {
    if (!this.libraryInfo?.name) return;
    this.chatService.sendTextToChat(`安装库包: ${this.libraryInfo.name}`, { sender: 'library', type: 'install', autoSend: true });
  }

  openUrl(url: string): void {
    if (url) window.open(url, '_blank');
  }

  private scheduleRetry(fn: () => void): void {
    if (this.retryCount < this.MAX_RETRY) {
      this.retryCount++;
      this.retryTimer = setTimeout(() => { this.retryCount = 0; fn(); }, 300 * this.retryCount);
    } else {
      this.isLoading = false;
      this.errorMessage = '扩展库信息加载失败';
      this.retryCount = 0;
      this.cdr.markForCheck();
    }
  }

  logDetail() {
    console.log('状态详情:', this.libraryInfo);
  }
}
