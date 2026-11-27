import { Component, inject } from '@angular/core';
import { NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzMessageService } from 'ng-zorro-antd/message';
import { BaseDialogComponent, DialogButton } from '../base-dialog/base-dialog.component';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { publishProjectText } from '@core/platform/public-api';
import {
  AILY_CLOUD_IGNORE_FILE,
  isValidProjectPackageName,
  normalizeProjectPackageName,
  ProjectService,
} from '@domain/project/public-api';

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
  syncRules = '';
  syncRulesReady = false;
  private originalSyncRules: string | null = null;
  private settingsProject?: { path: string; assertCurrent(): void };
  private destroyed = false;

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
        action: 'save',
        disabled: !this.settingsProject || this.isSubmitting,
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

  ngOnDestroy(): void {
    this.destroyed = true;
  }

  // 加载项目设置
  async loadProjectSettings(): Promise<void> {
    try {
      const path = this.projectService.currentProjectPath;
      if (!path) return;
      const fs = window['fs'];
      const guard = this.projectService.captureCurrentProjectGuard();
      const attachment = () => JSON.stringify(fs.captureProjectAttachment(path));
      const originalAttachment = attachment();
      const assertCurrent = () => {
        if (this.destroyed || !guard() || this.projectService.currentProjectPath !== path || attachment() !== originalAttachment) {
          throw new Error(this.translate.instant('PROJECT_SETTING_DIALOG.ERROR_PROJECT_CHANGED'));
        }
      };
      const packageJson = await this.projectService.getPackageJson(path);
      assertCurrent();
      
      if (packageJson) {
        // 保留所有原始属性,只更新我们需要编辑的字段
        const originalName = String(packageJson.name || '').trim();
        const packageName = normalizeProjectPackageName(originalName);
        this.projectSettings = {
          name: packageName,
          version: packageJson.version || '',
          description: packageJson.description || '',
          nickname: (
            packageJson.nickname != null &&
            String(packageJson.nickname).trim() !== ''
          )
            ? String(packageJson.nickname)
            : originalName || packageName,
          doc_url: packageJson.doc_url || '',
        };
        this.settingsProject = { path, assertCurrent };
        try {
          const rulesFile = window['path'].join(path, AILY_CLOUD_IGNORE_FILE);
          if (fs.existsSync(rulesFile)) {
            if (!fs.lstatSync(rulesFile)._isFile) throw new Error(`${AILY_CLOUD_IGNORE_FILE} must be a regular file`);
            this.originalSyncRules = fs.readFileSync(rulesFile, 'utf8');
          }
          this.syncRules = this.originalSyncRules ?? '';
          this.syncRulesReady = true;
        } catch (error) {
          console.error('读取同步规则失败:', error);
          this.message.error(this.translate.instant('PROJECT_SETTING_DIALOG.ERROR_SYNC_RULES_LOAD'));
        }
      }
    } catch (error) {
      console.error('加载项目设置失败:', error);
      if (!this.destroyed) this.message.error(this.translate.instant('PROJECT_SETTING_DIALOG.ERROR_LOAD_FAILED'));
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
    const project = this.settingsProject;
    if (!project || this.isSubmitting) return;
    // 包名只允许小写；保存前统一规范化，也兼容历史项目中的大写包名。
    this.projectSettings.name = normalizeProjectPackageName(this.projectSettings.name);

    // 项目名称（nickname）：支持中文；空则沿用包名
    const nickTrimmed = (this.projectSettings.nickname ?? '').trim();
    this.projectSettings.nickname =
      nickTrimmed || (this.projectSettings.name ?? '').trim();

    // 验证包名（npm name）
    if (!this.projectSettings.name || this.projectSettings.name.trim() === '') {
      this.message.warning(this.translate.instant('PROJECT_SETTING_DIALOG.WARNING_NAME_EMPTY'));
      return;
    }

    // 验证 name 格式:只能包含小写字母、数字、连字符和下划线
    if (!isValidProjectPackageName(this.projectSettings.name)) {
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

    this.isSubmitting = true;
    let rulesSaved = false;

    try {
      project.assertCurrent();
      const packageJson = await this.projectService.getPackageJson(project.path);
      project.assertCurrent();
      const draft = this.syncRules;
      if (this.syncRulesReady && draft !== (this.originalSyncRules ?? '')) {
        try {
          await publishProjectText(project.path, AILY_CLOUD_IGNORE_FILE, draft, this.originalSyncRules, project.assertCurrent);
          this.originalSyncRules = draft;
          rulesSaved = true;
        } catch (error) {
          console.error('保存同步规则失败:', error);
          if (!this.destroyed) this.message.error(this.translate.instant('PROJECT_SETTING_DIALOG.ERROR_SYNC_RULES_SAVE'));
          return;
        }
      }
      project.assertCurrent();
      
      // 用 projectSettings 中的值覆盖相同的字段
      const updatedPackageJson = {
        ...packageJson,
        ...this.projectSettings
      };
      
      // 保存更新后的完整配置
      await this.projectService.setPackageJson(updatedPackageJson);
      project.assertCurrent();

      // 同步「最近打开」列表中的项目名称 / 昵称（关闭项目后主界面立即显示）
      const pkgName = this.projectSettings.name.trim();
      this.projectService.addRecentlyProject({
        name: pkgName,
        path: project.path,
        nickname: this.projectSettings.nickname || pkgName,
      });
      
      this.message.success(this.translate.instant('PROJECT_SETTING_DIALOG.SUCCESS_SAVE'));
      this.modal.close({ result: 'success', data: this.projectSettings });
    } catch (error) {
      console.error('保存项目设置失败:', error);
      if (!this.destroyed) {
        this.message.error(rulesSaved ? this.translate.instant('PROJECT_SETTING_DIALOG.ERROR_SETTINGS_AFTER_RULES')
          : this.translate.instant('PROJECT_SETTING_DIALOG.ERROR_SAVE_FAILED'));
      }
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
