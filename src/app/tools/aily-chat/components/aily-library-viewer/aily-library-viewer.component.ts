import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzCardModule } from 'ng-zorro-antd/card';
import { NzListModule } from 'ng-zorro-antd/list';

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
      if (this.data.metadata?.isRawText) {
        this.parseRawContent();
      } else {
        this.libraryInfo = this.data.library || {};
        this.dependencies = this.data.dependencies || [];
      }
      this.errorMessage = '';
    } catch (error) {
      console.error('Error processing library data:', error);
      this.errorMessage = `数据处理失败: ${error.message}`;
    }
  }

  /**
   * 解析原始内容
   */
  private parseRawContent(): void {
    try {
      const content = this.data?.content || this.data?.raw || '';
      if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
        const parsed = JSON.parse(content);
        this.libraryInfo = parsed.library || parsed;
        this.dependencies = parsed.dependencies || [];
      } else {
        throw new Error('无法解析的内容格式');
      }
    } catch (error) {
      this.showRaw = true;
      this.errorMessage = '无法解析库数据，显示原始内容';
    }
  }

  /**
   * 切换显示模式
   */
  toggleView(): void {
    this.showRaw = !this.showRaw;
  }

  /**
   * 格式化显示数据
   */
  formatData(): string {
    if (this.data?.content || this.data?.raw) {
      return this.data.content || this.data.raw || '';
    }
    return JSON.stringify(this.data, null, 2);
  }

  /**
   * 复制到剪贴板
   */
  async copyToClipboard(): Promise<void> {
    try {
      const content = this.showRaw ? this.formatData() : JSON.stringify(this.libraryInfo, null, 2);
      await navigator.clipboard.writeText(content);
      console.log('库配置已复制到剪贴板');
    } catch (error) {
      console.error('复制失败:', error);
    }
  }

  /**
   * 安装库
   */
  installLibrary(): void {
    try {
      if (!this.libraryInfo?.package) {
        throw new Error('没有可安装的包信息');
      }

      // 这里需要根据实际的应用架构来实现
      // 可能需要通过服务来调用安装功能
      
      console.log('安装库包:', this.libraryInfo.package);
      // 可以添加成功提示
    } catch (error) {
      console.error('安装失败:', error);
      this.errorMessage = `安装失败: ${error.message}`;
    }
  }

  /**
   * 查看文档
   */
  viewDocumentation(): void {
    if (this.libraryInfo?.documentation) {
      window.open(this.libraryInfo.documentation, '_blank');
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
}
