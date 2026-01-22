import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { ChatService } from '../../services/chat.service';
import { ConfigService } from '../../../../services/config.service';

export interface AilyLibraryData {
  type: 'aily-library';
  library?: any;
  dependencies?: string[];
  metadata?: any;
  raw?: string;
  content?: string;
}

@Component({
  selector: 'app-aily-library-viewer',
  standalone: true,
  imports: [
    CommonModule,
    NzToolTipModule,
  ],
  templateUrl: './aily-library-viewer.component.html',
  styleUrls: ['./aily-library-viewer.component.scss']
})
export class AilyLibraryViewerComponent implements OnInit, OnDestroy {
  @Input() data: AilyLibraryData | null = null;

  showRaw = false;
  errorMessage = '';
  libraryPackageName;
  libraryInfo: any = null;
  dependencies: string[] = [];
  canInstall = false;
  isLoading = true;  // 默认为 true，等待数据
  
  // 重试相关
  private retryCount = 0;
  private readonly MAX_RETRY = 3;
  private retryTimer: any = null;

  ngOnInit() {
    this.processData();
    this.canInstall = this.checkCanInstall();
  }

  ngOnDestroy() {
    // 清理资源
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  constructor(
    private chatService: ChatService,
    private configService: ConfigService
  ) { }

  /**
   * 设置组件数据（由指令调用）
   */
  setData(data: AilyLibraryData): void {
    this.data = data;
    this.processData();
  }

  /**
   * 处理数据
   */
  private processData(): void {
    if (!this.data) {
      // 没有数据时保持 loading 状态
      this.isLoading = true;
      this.errorMessage = '';
      return;
    }

    try {
      this.libraryPackageName = this.data.library?.name;
      
      if (!this.libraryPackageName) {
        // 没有名称时保持 loading
        this.isLoading = true;
        this.errorMessage = '';
        return;
      }
      
      this.libraryInfo = this.configService.libraryDict[this.libraryPackageName] || null;
      
      if (this.libraryInfo) {
        // 成功加载
        this.isLoading = false;
        this.errorMessage = '';
        this.retryCount = 0;
      } else {
        // 未找到，尝试重试（可能 ConfigService 还在加载）
        this.scheduleRetry();
      }
    } catch (error) {
      console.warn('Error processing library data:', error);
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
      this.errorMessage = '库加载失败';
    }
  }

  /**
   * 安装库
   */
  installLibrary(): void {
    try {
      if (!this.libraryInfo?.name) {
        throw new Error('没有可安装的包信息');
      }

      // 这里需要根据实际的应用架构来实现
      // 可能需要通过服务来调用安装功能

      console.log('安装库包:', this.libraryInfo.name);
      // 可以添加成功提示
      this.chatService.sendTextToChat(`安装库包: ${this.libraryInfo.name}`, { sender: 'library', type: 'install', autoSend: true });
    } catch (error) {
      console.warn('安装失败:', error);
      this.errorMessage = `安装失败: ${error.message}`;
    }
  }

  /**
   * 查看文档
   */
  viewDocumentation(): void {
    if (this.libraryInfo?.url) {
      window.open(this.libraryInfo.url, '_blank');
    }
  }

  /**
   * 检查是否可以安装
   */
  private checkCanInstall(): boolean {
    return typeof window !== 'undefined' &&
      this.libraryInfo?.package &&
      window.location?.pathname.includes('blockly');
  }

  logDetail() {
    console.log('状态详情:', this.libraryInfo);
  }
}
