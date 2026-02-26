import { Component, Input, OnInit, OnDestroy, OnChanges, SimpleChanges, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatService } from '../../../services/chat.service';
import { ConfigService } from '../../../../../services/config.service';

@Component({
  selector: 'x-aily-library-viewer',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ac-card ac-library">
      @if (isLoading) {
        <div class="ac-card-loading"><i class="fa-light fa-spinner-third ac-spin"></i> 加载中...</div>
      } @else if (libraryInfo) {
        <div class="ac-card-header">
          <i class="fa-light fa-books ac-card-icon"></i>
          <div class="ac-card-title">
            <strong>{{ libraryInfo.nickname || libraryInfo.name }}</strong>
            @if (libraryInfo.version) { <span class="ac-badge">v{{ libraryInfo.version }}</span> }
          </div>
          @if (libraryInfo.tested != null) {
            <span class="ac-tag" [attr.data-tested]="libraryInfo.tested">
              {{ libraryInfo.tested ? '✅ 已测试' : '⚠️ 未测试' }}
            </span>
          }
        </div>
        @if (libraryInfo.description) { <p class="ac-card-desc">{{ libraryInfo.description }}</p> }
        <div class="ac-card-meta">
          <span>📦 {{ libraryInfo.name }}</span>
          @if (libraryInfo.author) { <span>👤 {{ libraryInfo.author }}</span> }
        </div>
        @if (libraryInfo.keywords?.length) {
          <div class="ac-tags">
            @for (tag of libraryInfo.keywords; track tag) {
              <span class="ac-keyword">{{ tag }}</span>
            }
          </div>
        }
        <div class="ac-card-actions">
          <button class="ac-action-btn" (click)="installLibrary()">
            <i class="fa-light fa-download"></i> 安装扩展库
          </button>
          @if (libraryInfo.url) {
            <button class="ac-action-btn ac-action-link" (click)="openUrl(libraryInfo.url)">
              <i class="fa-light fa-arrow-up-right-from-square"></i> 查看文档
            </button>
          }
        </div>
      } @else {
        <div class="ac-card-err"><i class="fa-light fa-triangle-exclamation"></i> 扩展库信息加载失败</div>
      }
    </div>
  `,
  styles: [`
    .ac-card {
      border-radius: 5px; padding: 5px 10px; margin: 4px 0;
      background-color: #3a3a3a; color: #ccc; min-height: 60px;
    }
    .ac-card:hover { background-color: #3f3f3f; }
    .ac-card-loading {
      display: flex; justify-content: center; align-items: center; min-height: 50px;
      gap: 10px; color: #888; font-size: 13px;
    }
    .ac-card-err {
      display: flex; justify-content: center; align-items: center; min-height: 50px;
      color: #999; font-size: 13px;
    }
    .ac-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .ac-card-icon { font-size: 18px; color: #888; flex-shrink: 0; }
    .ac-card-title { flex: 1; display: flex; align-items: baseline; gap: 6px; }
    .ac-card-title strong { font-size: 14px; color: #d4d4d4; }
    .ac-badge {
      font-size: 11px; padding: 1px 5px; border-radius: 3px;
      background: rgba(24,144,255,.15); color: #91caff;
    }
    .ac-tag {
      font-size: 11px; padding: 2px 6px; border-radius: 3px;
      background: rgba(255,255,255,.08); color: #a5a5a5;
    }
    .ac-tag[data-tested="true"]  { background: rgba(143,195,31,.15); color: #95de64; }
    .ac-tag[data-tested="false"] { background: rgba(212,160,23,.15); color: #ffd666; }
    .ac-card-desc { font-size: 12px; color: #888; margin: 0 0 8px 0; line-height: 1.6; white-space: pre-wrap; }
    .ac-card-meta { display: flex; gap: 12px; font-size: 12px; color: #666; margin-bottom: 8px; }
    .ac-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
    .ac-keyword {
      font-size: 11px; padding: 1px 6px; border-radius: 3px;
      background: rgba(255,255,255,.06); color: #777;
    }
    .ac-card-actions { display: flex; gap: 6px; }
    .ac-action-btn {
      font-size: 12px; padding: 3px 10px; border-radius: 4px;
      cursor: pointer; border: 1px solid #505050;
      background: #3a3c3f; color: #a5a5a5;
      display: inline-flex; align-items: center; gap: 4px;
      transition: all 0.2s;
    }
    .ac-action-btn:hover { border-color: #1890ff; color: #91caff; background: rgba(24,144,255,.1); }
    .ac-action-link { background: none; border-color: transparent; color: #818992; }
    .ac-action-link:hover { background: none !important; border-color: transparent !important; color: #1890ff !important; }
    @keyframes ac-spin { to { transform: rotate(360deg); } }
    .ac-spin { animation: ac-spin 0.8s linear infinite; display: inline-block; }
  `],
})
export class XAilyLibraryViewerComponent implements OnInit, OnDestroy, OnChanges {
  @Input() data: { name?: string; library?: { name?: string } } | null = null;

  isLoading = false;
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
      this.retryCount = 0;
      this.cdr.markForCheck();
    }
  }
}
