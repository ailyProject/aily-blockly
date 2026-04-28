import { Component, Input, OnInit, OnDestroy, OnChanges, SimpleChanges, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatService } from '../../../services/chat.service';
import { ConfigService } from '../../../../../services/config.service';

@Component({
  selector: 'x-aily-board-viewer',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './x-aily-board-viewer.component.html',
  styleUrls: ['./x-aily-board-viewer.component.scss'],
})
export class XAilyBoardViewerComponent implements OnInit, OnDestroy, OnChanges {
  @Input() data: { name?: string; board?: { name?: string } } | null = null;

  isLoading = false;
  errorMessage = '';
  boardInfo: any = null;
  private retryTimer: any = null;

  get resourceUrl() {
    return this.configService.getCurrentResourceUrl();
  }
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
    const name = this.data?.name || this.data?.board?.name;
    if (name) this.loadBoardInfo(name);
  }

  ngOnDestroy(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private loadBoardInfo(name: string): void {
    this.isLoading = true;
    this.errorMessage = '';
    this.boardInfo = this.configService.boardDict?.[name] || null;
    if (this.boardInfo) {
      this.isLoading = false;
      this.retryCount = 0;
    } else {
      this.scheduleRetry(() => this.loadBoardInfo(name));
    }
    this.cdr.markForCheck();
  }

  installBoard(): void {
    if (!this.boardInfo?.name) return;
    this.chatService.sendTextToChat(`安装开发板: ${this.boardInfo.name}`, { sender: 'board', type: 'install', autoSend: true });
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
      this.errorMessage = '开发板信息加载失败';
      this.retryCount = 0;
      this.cdr.markForCheck();
    }
  }

  logDetail() {
    console.log('状态详情:', this.boardInfo);
  }
}
