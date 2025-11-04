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

  ngOnInit() {
    this.processData();
    this.canInstall = this.checkCanInstall();
  }

  ngOnDestroy() {
    // 清理资源
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
      this.errorMessage = '没有可显示的数据';
      return;
    }

    try {
      this.libraryPackageName = this.data.library.name;
      this.libraryInfo = this.configService.libraryDict[this.libraryPackageName];
      this.errorMessage = '';
    } catch (error) {
      console.warn('Error processing library data:', error);
      this.errorMessage = `数据处理失败: ${error.message}`;
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
