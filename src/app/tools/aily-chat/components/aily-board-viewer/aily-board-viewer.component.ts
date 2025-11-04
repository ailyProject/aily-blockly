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

  get resourceUrl() {
    return this.configService.data.resource[0];
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
    console.log('Processing board data:', this.data);
    if (!this.data) {
      this.errorMessage = '没有可显示的开发板数据';
      return;
    }

    try {
      this.boardPackageName = this.data.board.name;
      this.boardInfo = this.configService.boardDict[this.boardPackageName] || null;
      this.errorMessage = '';
    } catch (error) {
      console.warn('Error processing board data:', error);
      this.errorMessage = `数据处理失败: ${error.message}`;
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
    console.log('Installing board:', this.boardInfo.name);
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
    console.log('状态详情:', this.boardInfo);
  }
}
