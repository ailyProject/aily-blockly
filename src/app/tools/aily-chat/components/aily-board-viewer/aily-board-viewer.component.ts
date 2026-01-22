import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { ConfigService } from '../../../../services/config.service';
import { ChatService } from '../../services/chat.service';


export interface AilyBoardData {
  type: 'aily-board';
  board?: any;
  config?: any;
  metadata?: any;
  raw?: string;
  content?: string;
}

@Component({
  selector: 'app-aily-board-viewer',
  standalone: true,
  imports: [
    CommonModule,
    NzToolTipModule,
  ],
  templateUrl: './aily-board-viewer.component.html',
  styleUrls: ['./aily-board-viewer.component.scss']
})
export class AilyBoardViewerComponent implements OnInit, OnDestroy {
  @Input() data: AilyBoardData | null = null;
  boardPackageName;
  boardInfo: any = null;
  errorMessage = '';
  showRaw = false;
  isLoading = true;  // 默认为 true，等待数据
  
  // 重试相关
  private retryCount = 0;
  private readonly MAX_RETRY = 3;
  private retryTimer: any = null;

  get resourceUrl() {
    return this.configService.getCurrentResourceUrl();
  }

  constructor(
    private configService: ConfigService,
    private chatService: ChatService
  ) { }

  ngOnInit() {
    this.processData();
  }

  ngOnDestroy() {
    // 清理资源
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * 设置组件数据（由指令调用）
   */
  setData(data: AilyBoardData): void {
    this.data = data;
    this.processData();
  }

  /**
   * 处理数据
   */
  private processData(): void {
    // console.log('Processing board data:', this.data);
    if (!this.data) {
      // 没有数据时保持 loading 状态
      this.isLoading = true;
      this.errorMessage = '';
      return;
    }

    try {
      this.boardPackageName = this.data.board?.name;
      
      if (!this.boardPackageName) {
        // 没有名称时保持 loading
        this.isLoading = true;
        this.errorMessage = '';
        return;
      }
      
      this.boardInfo = this.configService.boardDict[this.boardPackageName] || null;
      
      if (this.boardInfo) {
        // 成功加载
        this.isLoading = false;
        this.errorMessage = '';
        this.retryCount = 0;
      } else {
        // 未找到，尝试重试（可能 ConfigService 还在加载）
        this.scheduleRetry();
      }
    } catch (error) {
      console.warn('Error processing board data:', error);
      this.scheduleRetry();
    }
  }

  /**
   * 安排重试
   */
  private scheduleRetry(): void {
    if (this.retryCount < this.MAX_RETRY) {
      this.retryCount++;
      this.isLoading = true;
      this.errorMessage = '';
      this.retryTimer = setTimeout(() => {
        this.processData();
      }, 300 * this.retryCount);
    } else {
      // 超过重试次数，显示错误
      this.isLoading = false;
      this.errorMessage = '开发板加载失败';
    }
  }

  // /**
  //  * 获取开发板图片URL
  //  */
  // getBoardImageUrl(): string {
  //   if (!this.boardInfo?.img) return '';

  //   // 如果是完整URL，直接返回
  //   if (this.boardInfo.img.startsWith('http')) {
  //     return this.boardInfo.img;
  //   }

  //   // 否则拼接资源路径
  //   return `${this.resourceUrl}/boards/${this.boardInfo.img}`;
  // }

  // /**
  //  * 获取品牌标志URL
  //  */
  // getBrandLogoUrl(): string {
  //   if (!this.boardInfo?.brand) return '';

  //   return `./brand/${this.boardInfo.brand.toLowerCase()}/logo.png`;
  // }

  /**
   * 切换显示原始数据
   */
  // toggleRawData(): void {
  //   this.showRaw = !this.showRaw;
  // }

  /**
   * 安装开发板
   */
  installBoard(): void {
    if (!this.boardInfo?.name) return;

    // 实现开发板安装逻辑
    // console.log('Installing board:', this.boardInfo.name);
    this.chatService.sendTextToChat(`安装开发板: ${this.boardInfo.name}`, { sender: 'board', type: 'install', autoSend: true });
  }

  /**
   * 查看开发板详情
   */
  viewBoardDetails(): void {
    if (!this.boardInfo?.url) return;
    window.open(this.boardInfo.url, '_blank');
  }

  logDetail() {
    // console.log('状态详情:', this.boardInfo);
  }
}
