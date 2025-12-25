import { Component, Input, OnInit, inject, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { ModelStoreService, ModelDetail } from '../model-store.service';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NzSkeletonModule } from 'ng-zorro-antd/skeleton';
import { ElectronService } from '../../../services/electron.service';
import { UiService } from '../../../services/ui.service';
import { SerialService } from '../../../services/serial.service';
import { TranslateModule } from '@ngx-translate/core';
import {
  SupportBoardInfo,
  getSupportedBoards,
  getTaskDescription,
  getModelFormatDescription,
  getPrecisionDescription,
  formatFileSize
} from '../model-constants';


@Component({
  selector: 'app-model-detail',
  standalone: true,
  imports: [
    CommonModule,
    NzButtonModule,
    NzSpinModule,
    NzSkeletonModule,
    TranslateModule
  ],
  templateUrl: './model-detail.component.html',
  styleUrl: './model-detail.component.scss'
})
export class ModelDetailComponent implements OnInit {
  @Input() id: string = '';
  @Output() close = new EventEmitter<void>();
  @Output() deploy = new EventEmitter<ModelDetail>();

  private modelStoreService = inject(ModelStoreService);
  private sanitizer = inject(DomSanitizer);

  modelDetail: ModelDetail | null = null;
  supportedBoards: SupportBoardInfo[] = [];

  constructor(
    private electronService: ElectronService,
    private uiService: UiService,
    private serialService: SerialService
  ) { }

  ngOnInit(): void {
    if (this.id) {
      this.loadModelDetail();
    }
  }

  loadModelDetail(): void {
    this.modelStoreService.getModelDetail(this.id).subscribe({
      next: (data) => {
        this.modelDetail = data;
      },
      error: (error) => {
        console.error('加载模型详情失败:', error);
      }
    });
  }

  getSafeHtml(html: string): SafeHtml {
    return this.sanitizer.sanitize(1, html) || '';
  }

  // 获取支持的开发板列表
  getSupportedBoards(): SupportBoardInfo[] {
    if (!this.modelDetail?.uniform_types) return [];
    return getSupportedBoards(this.modelDetail.uniform_types);
  }

  // 获取任务类型描述
  getTaskDescription(): string {
    if (!this.modelDetail?.task) return '-';
    return getTaskDescription(this.modelDetail.task);
  }

  // 获取模型格式
  getModelFormat(): string {
    if (!this.modelDetail?.model_format) return '-';
    return getModelFormatDescription(this.modelDetail.model_format);
  }

  // 获取精度描述
  getPrecision(): string {
    if (!this.modelDetail?.precision) return '-';
    return getPrecisionDescription(this.modelDetail.precision);
  }

  // 格式化文件大小
  getFormattedSize(): string {
    if (!this.modelDetail?.model_size) return '-';
    return formatFileSize(this.modelDetail.model_size);
  }

  /**
   * 部署或测试模型
   * @param modelDetail 模型详情数据
   * @param mode 'deploy' 部署模式 | 'test' 测试模式
   */
  onDeploy(modelDetail: ModelDetail, mode: 'deploy' | 'test' = 'deploy'): void {
    if (!modelDetail) {
      console.error('模型数据为空或未启用，无法部署');
      return;
    }

    // 1. 保存模型数据到 localStorage（跨窗口传递）
    localStorage.setItem('current_model_deploy', JSON.stringify(modelDetail));

    // 2. 保存当前串口信息
    if (this.serialService.currentPort) {
      localStorage.setItem('current_model_deploy_port', this.serialService.currentPort);
    }

    // 3. 根据模型作者决定模型类型，生成对应路由
    const modelType = this.getModelTypeRoute(modelDetail);

    // 4. 构建路由路径
    let routePath: string;
    if (mode === 'test') {
      // 测试模式：跳转到独立测试页面
      routePath = `model-deploy/${modelType}/test`;
    } else {
      // 部署模式：跳转到部署步骤 - deploy 步骤
      routePath = `model-deploy/${modelType}/deploy`;
    }

    // 5. 打开新窗口，路由到对应页面
    const title = mode === 'test'
      ? `模型测试 - ${modelDetail.name}`
      : `模型部署 - ${modelDetail.name}`;

    this.uiService.openWindow({
      path: routePath, // 动态路由：model-deploy/sscma/deploy 或 model-deploy/sscma/test
      title,
      alwaysOnTop: true,
      width: mode === 'test' ? 900 : 1020,
      height: 640
    });
  }

  /**
   * 根据模型信息决定路由类型
   * @param modelDetail 模型详情
   * @returns 路由类型名称（用于 URL）
   */
  private getModelTypeRoute(modelDetail: ModelDetail): string {
    // 根据 author_name 判断
    if (modelDetail.author_name === 'SenseCraft AI' || modelDetail.author_name === 'Seeed Studio') {
      return 'sscma';
    }

    // 根据 uniform_types 判断
    if (modelDetail.uniform_types?.includes('xiao_esp32s3')) {
      return 'sscma';
    }

    // 未来扩展示例：
    // if (modelDetail.author_name === 'ChipIntelli') {
    //   return 'chipintelli';
    // }

    // 默认返回 sscma
    return 'sscma';
  }

  onClose(): void {
    this.close.emit();
  }
}
