import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { NzStepsModule } from 'ng-zorro-antd/steps';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { ModelProjectService, RecentModelProject } from '../../services/model-project.service';
import { NzMessageService } from 'ng-zorro-antd/message';

@Component({
  selector: 'app-model-train',
  imports: [
    CommonModule,
    SubWindowComponent,
    TranslateModule,
    NzStepsModule,
    NzButtonModule
  ],
  templateUrl: './model-train.component.html',
  styleUrl: './model-train.component.scss'
})
export class ModelTrainComponent {

  constructor(
    private router: Router,
    private modelProjectService: ModelProjectService,
    private message: NzMessageService
  ) { }

  currentStep = 0;

  // 获取最近打开的模型训练项目
  get recentProjects(): RecentModelProject[] {
    return this.modelProjectService.recentProjects;
  }

  nextStep(){
    this.currentStep += 1;
  }

  close(){
    
  }

  // 进入视觉模型训练页面
  goToVisionTrain() {
    this.router.navigate(['/model-train/vision']);
  }

  // 进入音频模型训练页面（暂未实现）
  goToAudioTrain() {
    // TODO: 实现音频模型训练
    console.log('音频模型训练功能开发中...');
  }

  // 打开项目（选择文件夹）
  async openProject() {
    const projectPath = await this.modelProjectService.selectProjectFolder();
    
    if (!projectPath) {
      return;
    }

    this.openProjectByPath(projectPath);
  }

  // 通过路径打开项目
  openProjectByPath(projectPath: string) {
    // 读取项目元数据
    const meta = this.modelProjectService.loadProjectMeta(projectPath);
    
    if (!meta) {
      this.message.error('无法读取项目信息，请确认选择的是有效的模型训练项目文件夹');
      // 如果项目无效，从最近列表中移除
      this.modelProjectService.removeRecentProject(projectPath);
      return;
    }

    // 根据 modelType 跳转到对应的训练页面
    switch (meta.modelType) {
      case 'classification':
        this.router.navigate(['/model-train/vision/classification'], {
          queryParams: { projectPath: projectPath }
        });
        break;
      case 'detection':
        this.router.navigate(['/model-train/vision/detection'], {
          queryParams: { projectPath: projectPath }
        });
        break;
      case 'segmentation':
        this.message.warning('语义分割模型功能即将推出');
        break;
      case 'pose':
        this.message.warning('姿态估计模型功能即将推出');
        break;
      default:
        this.message.error(`未知的模型类型: ${meta.modelType}`);
    }
  }

  // 从最近项目列表打开项目
  openRecentProject(project: RecentModelProject) {
    this.openProjectByPath(project.path);
  }

  // 获取模型类型的显示名称
  getModelTypeName(modelType: string): string {
    const names: { [key: string]: string } = {
      'classification': '分类识别',
      'detection': '目标检测',
      'segmentation': '语义分割',
      'pose': '姿态估计'
    };
    return names[modelType] || modelType;
  }
}
