import { Component, inject } from '@angular/core';
import { NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzMessageService } from 'ng-zorro-antd/message';
import { BaseDialogComponent, DialogButton } from '../base-dialog/base-dialog.component';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ProjectService } from '../../services/project.service';

interface ProjectSettings {
  name: string;
  version: string;
  description: string;
  nickname: string;
  doc_url: string;
  dependencies?: Record<string, string>;
  projectConfig?: Record<string, string>;
  [key: string]: any; // 允许其他任意属性
}

@Component({
  selector: 'app-project-setting-dialog',
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzInputModule,
    TranslateModule,
    BaseDialogComponent
  ],
  templateUrl: './project-setting-dialog.component.html',
  styleUrl: './project-setting-dialog.component.scss'
})
export class ProjectSettingDialogComponent {
  readonly modal = inject(NzModalRef);

  // 项目设置数据
  projectSettings: ProjectSettings = {
    name: '',
    version: '',
    description: '',
    nickname: '',
    doc_url: ''
  };

  // 提交状态
  isSubmitting: boolean = false;

  // 配置对话框按钮
  get buttons(): DialogButton[] {
    return [
      {
        text: 'PROJECT_SETTING_DIALOG.CLOSE',
        type: 'default',
        action: 'close'
      },
      {
        text: 'PROJECT_SETTING_DIALOG.SAVE',
        type: 'primary',
        action: 'save'
      }
    ];
  }

  constructor(
    private message: NzMessageService,
    private projectService: ProjectService,
    private translate: TranslateService
  ) { }

  async ngOnInit(): Promise<void> {
    await this.loadProjectSettings();
  }

  // 加载项目设置
  async loadProjectSettings(): Promise<void> {
    try {
      const packageJson = await this.projectService.getPackageJson();
      
      if (packageJson) {
        // 保留所有原始属性,只更新我们需要编辑的字段
        this.projectSettings = {
          name: packageJson.name || '',
          version: packageJson.version || '',
          description: packageJson.description || '',
          nickname: packageJson.nickname || '',
          doc_url: packageJson.doc_url || '',
        };
      }
    } catch (error) {
      console.error('加载项目设置失败:', error);
      this.message.error(this.translate.instant('PROJECT_SETTING_DIALOG.ERROR_LOAD_FAILED'));
    }
  }

  onCloseDialog(): void {
    this.modal.close({ result: 'cancel' });
  }

  onButtonClick(action: string): void {
    if (action === 'close') {
      this.modal.close({ result: 'cancel' });
    } else if (action === 'save') {
      this.saveSettings();
    }
  }

  // 保存设置
  async saveSettings(): Promise<void> {
    // 验证基本信息
    if (!this.projectSettings.name || this.projectSettings.name.trim() === '') {
      this.message.warning(this.translate.instant('PROJECT_SETTING_DIALOG.WARNING_NAME_EMPTY'));
      return;
    }

    // 验证 name 格式:只能包含小写字母、数字、连字符和下划线
    const namePattern = /^[a-z0-9_-]+$/;
    if (!namePattern.test(this.projectSettings.name.trim())) {
      this.message.warning(this.translate.instant('PROJECT_SETTING_DIALOG.WARNING_NAME_INVALID_FORMAT'));
      return;
    }

    if (!this.projectSettings.version || this.projectSettings.version.trim() === '') {
      this.message.warning(this.translate.instant('PROJECT_SETTING_DIALOG.WARNING_VERSION_EMPTY'));
      return;
    }

    // 验证 version 格式:必须符合语义化版本规范 (x.y.z)
    const versionPattern = /^\d+\.\d+\.\d+$/;
    if (!versionPattern.test(this.projectSettings.version.trim())) {
      this.message.warning(this.translate.instant('PROJECT_SETTING_DIALOG.WARNING_VERSION_INVALID_FORMAT'));
      return;
    }

    // 验证 doc_url 格式:如果不为空则必须是有效的 URL
    if (this.projectSettings.doc_url && this.projectSettings.doc_url.trim() !== '') {
      try {
        new URL(this.projectSettings.doc_url.trim());
      } catch {
        this.message.warning(this.translate.instant('PROJECT_SETTING_DIALOG.WARNING_DOC_URL_INVALID_FORMAT'));
        return;
      }
    }

    console.log(this.projectSettings);
    

    this.isSubmitting = true;

    try {
      // 先读取完整的 package.json
      const packageJson = await this.projectService.getPackageJson();
      
      // 用 projectSettings 中的值覆盖相同的字段
      const updatedPackageJson = {
        ...packageJson,
        ...this.projectSettings
      };
      
      // 保存更新后的完整配置
      await this.projectService.setPackageJson(updatedPackageJson);
      
      this.message.success(this.translate.instant('PROJECT_SETTING_DIALOG.SUCCESS_SAVE'));
      this.modal.close({ result: 'success', data: this.projectSettings });
    } catch (error) {
      console.error('保存项目设置失败:', error);
      this.message.error(this.translate.instant('PROJECT_SETTING_DIALOG.ERROR_SAVE_FAILED'));
    } finally {
      this.isSubmitting = false;
    }
  }

  // 同步数组数据到对象
  private syncArrayToObject(): void {
    // 清空并重新构建 dependencies
    this.projectSettings.dependencies = {};
    this.dependenciesArray.forEach(dep => {
      if (dep.key && dep.key.trim() !== '') {
        this.projectSettings.dependencies[dep.key.trim()] = dep.value.trim();
      }
    });

    // 清空并重新构建 projectConfig
    this.projectSettings.projectConfig = {};
    this.projectConfigArray.forEach(config => {
      if (config.key && config.key.trim() !== '') {
        this.projectSettings.projectConfig[config.key.trim()] = config.value.trim();
      }
    });
  }

  // 获取依赖项数组用于显示
  get dependenciesArray(): Array<{ key: string; value: string }> {
    return Object.entries(this.projectSettings.dependencies).map(([key, value]) => ({
      key,
      value
    }));
  }

  // 获取项目配置数组用于显示
  get projectConfigArray(): Array<{ key: string; value: string }> {
    return Object.entries(this.projectSettings.projectConfig).map(([key, value]) => ({
      key,
      value
    }));
  }

  // 添加项目配置
  addProjectConfig(): void {
    if (!this.projectSettings.projectConfig) {
      this.projectSettings.projectConfig = {};
    }
    // 添加一个临时的键值对,使用时间戳确保唯一性
    const tempKey = `new_config_${Date.now()}`;
    // 重建对象,将新项添加到最前面
    this.projectSettings.projectConfig = {
      [tempKey]: '',
      ...this.projectSettings.projectConfig
    };
  }

  // 删除项目配置
  deleteProjectConfig(index: number): void {
    const configArray = this.projectConfigArray;
    if (index >= 0 && index < configArray.length) {
      const keyToDelete = configArray[index].key;
      delete this.projectSettings.projectConfig[keyToDelete];
    }
  }

  // 添加依赖项
  addDependency(): void {
    if (!this.projectSettings.dependencies) {
      this.projectSettings.dependencies = {};
    }
    // 添加一个临时的键值对
    const tempKey = `new_dependency_${Date.now()}`;
    // 重建对象,将新项添加到最前面
    this.projectSettings.dependencies = {
      [tempKey]: '',
      ...this.projectSettings.dependencies
    };
  }

  // 删除依赖项
  deleteDependency(index: number): void {
    const depArray = this.dependenciesArray;
    if (index >= 0 && index < depArray.length) {
      const keyToDelete = depArray[index].key;
      delete this.projectSettings.dependencies[keyToDelete];
    }
  }
}
