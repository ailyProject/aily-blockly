import { Component, EventEmitter, Output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzCheckboxModule } from 'ng-zorro-antd/checkbox';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { TOOLS } from '../../tools/tools';
import { ElectronService } from '../../../../services/electron.service';
import { AilyChatConfigService, WorkspaceSecurityOption, ModelConfigOption, ApiKeyConfig } from '../../services/aily-chat-config.service';

@Component({
  selector: 'aily-chat-settings',
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzInputModule,
    NzCheckboxModule,
    NzToolTipModule,
    NzSwitchModule,
    NzSelectModule,
  ],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss'
})
export class AilyChatSettingsComponent implements OnInit {

  @Output() close = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>(); // 保存成功事件

  // 最大循环次数
  maxCount: number = 100;

  // API配置管理
  apiKeysList: ApiKeyConfig[] = [];
  showAddApiKeyForm = false;
  newApiKey = {
    name: '',
    baseUrl: '',
    apiKey: ''
  };

  // 工具列表配置
  availableTools: Array<{name: string, displayName: string, description: string, enabled: boolean}> = [];
  allChecked = false;
  indeterminate = false;

  // 安全工作区配置
  workspaceOptions: WorkspaceSecurityOption[] = [];
  allWorkspaceChecked = false;
  workspaceIndeterminate = false;

  // 模型管理
  modelList: ModelConfigOption[] = [];
  allModelsChecked = false;
  modelsIndeterminate = false;
  
  // 添加模型表单
  newModel = {
    model: '',
    name: '',
    family: '',
    speed: '1x',
    apiKeyId: null as string | null
  };
  showAddModelForm = false;

  /**
   * 获取启用的工具数量
   */
  get enabledToolsCount(): number {
    return this.availableTools.filter(t => t.enabled).length;
  }

  /**
   * 获取启用的模型数量
   */
  get enabledModelsCount(): number {
    return this.modelList.filter(m => m.enabled).length;
  }

  constructor(
    private message: NzMessageService,
    private electronService: ElectronService,
    private ailyChatConfigService: AilyChatConfigService
  ) {
  }

  ngOnInit() {
    this.loadAllConfig();
    this.initializeTools();
    this.loadWorkspaceOptions();
    this.loadModelList();
  }

  /**
   * 加载所有配置
   */
  private loadAllConfig() {
    // 加载配置
    this.maxCount = this.ailyChatConfigService.maxCount;
    
    // 加载API配置
    this.apiKeysList = [...this.ailyChatConfigService.apiKeys];
  }

  /**
   * 从配置服务加载安全工作区选项
   */
  private loadWorkspaceOptions() {
    this.workspaceOptions = this.ailyChatConfigService.getWorkspaceSecurityOptions();
    this.updateWorkspaceAllChecked();
  }

  /**
   * 初始化工具列表
   */
  private initializeTools() {
    // 从配置服务获取已启用的工具列表
    const savedEnabledTools = this.ailyChatConfigService.enabledTools;
    const hasStoredConfig = savedEnabledTools && savedEnabledTools.length > 0;
    
    // 从 TOOLS 常量中读取所有工具
    this.availableTools = TOOLS.map(tool => ({
      name: tool.name,
      displayName: this.formatToolName(tool.name),
      description: typeof tool.description === 'string' ? tool.description : '',
      // 如果有存储的配置，则根据配置设置启用状态；否则默认全部启用
      enabled: hasStoredConfig ? savedEnabledTools.includes(tool.name) : true
    }));
    this.updateAllChecked();
  }

  /**
   * 格式化工具名称为更友好的显示名称
   */
  private formatToolName(name: string): string {
    return name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * 更新全选状态
   */
  updateAllChecked(): void {
    const enabledCount = this.availableTools.filter(t => t.enabled).length;
    this.allChecked = enabledCount === this.availableTools.length;
    this.indeterminate = enabledCount > 0 && enabledCount < this.availableTools.length;
  }

  /**
   * 全选/取消全选
   */
  onAllCheckedChange(checked: boolean): void {
    this.availableTools.forEach(tool => tool.enabled = checked);
    this.updateAllChecked();
  }

  /**
   * 单个工具勾选变化
   */
  onToolCheckedChange(): void {
    this.updateAllChecked();
  }

  /**
   * 更新安全工作区全选状态
   */
  updateWorkspaceAllChecked(): void {
    const enabledCount = this.workspaceOptions.filter(w => w.enabled).length;
    this.allWorkspaceChecked = enabledCount === this.workspaceOptions.length;
    this.workspaceIndeterminate = enabledCount > 0 && enabledCount < this.workspaceOptions.length;
  }

  /**
   * 安全工作区全选/取消全选
   */
  onAllWorkspaceCheckedChange(checked: boolean): void {
    this.workspaceOptions.forEach(option => option.enabled = checked);
    this.updateWorkspaceAllChecked();
  }

  /**
   * 单个工作区选项勾选变化
   */
  onWorkspaceCheckedChange(): void {
    this.updateWorkspaceAllChecked();
  }

  // ==================== 模型管理方法 ====================

  /**
   * 加载模型列表
   */
  private loadModelList() {
    this.modelList = [...this.ailyChatConfigService.models];
    this.updateModelsAllChecked();
  }

  /**
   * 更新模型全选状态
   */
  updateModelsAllChecked(): void {
    const enabledCount = this.modelList.filter(m => m.enabled).length;
    this.allModelsChecked = enabledCount === this.modelList.length;
    this.modelsIndeterminate = enabledCount > 0 && enabledCount < this.modelList.length;
  }

  /**
   * 模型全选/取消全选
   */
  onAllModelsCheckedChange(checked: boolean): void {
    this.modelList.forEach(model => model.enabled = checked);
    this.updateModelsAllChecked();
  }

  /**
   * 单个模型勾选变化
   */
  onModelCheckedChange(): void {
    this.updateModelsAllChecked();
  }

  // ==================== API密钥管理方法 ====================

  /**
   * 显示/隐藏添加API密钥表单
   */
  toggleAddApiKeyForm(): void {
    this.showAddApiKeyForm = !this.showAddApiKeyForm;
    if (!this.showAddApiKeyForm) {
      this.resetNewApiKeyForm();
    }
  }

  /**
   * 重置添加API密钥表单
   */
  private resetNewApiKeyForm(): void {
    this.newApiKey = {
      name: '',
      baseUrl: '',
      apiKey: ''
    };
  }

  /**
   * 添加API密钥
   */
  addApiKey(): void {
    if (!this.newApiKey.name || !this.newApiKey.baseUrl || !this.newApiKey.apiKey) {
      this.message.warning('请填写完整的API密钥信息');
      return;
    }

    // 检查名称是否已存在
    if (this.apiKeysList.some(k => k.name === this.newApiKey.name)) {
      this.message.warning('该配置名称已存在');
      return;
    }

    const newApiKeyConfig = this.ailyChatConfigService.addApiKey(this.newApiKey);
    this.apiKeysList.push(newApiKeyConfig);
    this.resetNewApiKeyForm();
    this.showAddApiKeyForm = false;
    this.message.success('API密钥已添加');
  }

  /**
   * 删除API密钥
   */
  removeApiKey(apiKeyId: string): void {
    const apiKey = this.apiKeysList.find(k => k.id === apiKeyId);
    if (!apiKey) {
      return;
    }

    // 检查是否有关联的模型
    const associatedModels = this.modelList.filter(m => m.apiKeyId === apiKeyId);
    if (associatedModels.length > 0) {
      this.message.warning(`该API密钥有${associatedModels.length}个关联模型，无法删除`);
      return;
    }

    if (this.ailyChatConfigService.removeApiKey(apiKeyId)) {
      this.apiKeysList = this.apiKeysList.filter(k => k.id !== apiKeyId);
      this.message.success('API密钥已删除');
    }
  }

  /**
   * 切换API密钥启用状态
   */
  toggleApiKeyEnabled(apiKeyId: string): void {
    const apiKey = this.apiKeysList.find(k => k.id === apiKeyId);
    if (apiKey) {
      apiKey.enabled = !apiKey.enabled;
      this.ailyChatConfigService.toggleApiKeyEnabled(apiKeyId);

      this.modelList.forEach(model => {
        if (model.apiKeyId === apiKeyId) {
          model.enabled = apiKey.enabled;
        }
      });
      this.updateModelsAllChecked();
    }
  }

  /**
   * 检查API密钥是否有效
   */
  isApiKeyValid(apiKeyId: string): boolean {
    return this.ailyChatConfigService.isApiKeyValid(apiKeyId);
  }

  /**
   * 获取API密钥显示名称
   */
  getApiKeyName(apiKeyId: string): string {
    return this.ailyChatConfigService.getApiKeyName(apiKeyId);
  }

  /**
   * 显示/隐藏添加模型表单
   */
  toggleAddModelForm(): void {
    // 检查是否有配置API密钥
    if (!this.showAddModelForm && this.apiKeysList.length === 0) {
      this.message.warning('请先配置API密钥');
      return;
    }

    this.showAddModelForm = !this.showAddModelForm;
    if (!this.showAddModelForm) {
      this.resetNewModelForm();
    }
  }

  /**
   * 重置添加模型表单
   */
  private resetNewModelForm(): void {
    this.newModel = {
      model: '',
      name: '',
      family: '',
      speed: '1x',
      apiKeyId: null
    };
  }

  /**
   * 添加自定义模型
   */
  addCustomModel(): void {
    if (!this.newModel.model || !this.newModel.name || !this.newModel.family || !this.newModel.apiKeyId) {
      this.message.warning('请填写完整的模型信息');
      return;
    }

    // 检查模型id是否已存在
    if (this.modelList.some(m => m.model === this.newModel.model)) {
      this.message.warning('该模型id已存在');
      return;
    }

    const newModelConfig: ModelConfigOption = {
      model: this.newModel.model,
      name: this.newModel.name,
      family: this.newModel.family,
      speed: this.newModel.speed,
      enabled: true,
      isCustom: true,
      apiKeyId: this.newModel.apiKeyId
    };

    this.modelList.push(newModelConfig);
    this.updateModelsAllChecked();
    this.resetNewModelForm();
    this.showAddModelForm = false;
    this.message.success('模型已添加');
  }

  /**
   * 删除模型（只能删除自定义模型）
   */
  removeModel(model: ModelConfigOption): void {
    if (!model.isCustom) {
      this.message.warning('不能删除内置模型');
      return;
    }

    const index = this.modelList.findIndex(m => m.model === model.model);
    if (index !== -1) {
      this.modelList.splice(index, 1);
      this.updateModelsAllChecked();
      this.message.success('模型已删除');
    }
  }

  onClose() {
    this.close.emit();
  }

  async onSave() {
    // 保存配置
    this.ailyChatConfigService.maxCount = this.maxCount;

    // 保存API配置
    this.ailyChatConfigService.apiKeys = this.apiKeysList;

    // 保存启用的工具列表
    const enabledTools = this.availableTools.filter(t => t.enabled).map(t => t.name);
    this.ailyChatConfigService.enabledTools = enabledTools;

    // 保存安全工作区配置
    this.ailyChatConfigService.updateFromWorkspaceOptions(this.workspaceOptions);

    // 保存模型配置
    this.ailyChatConfigService.models = this.modelList;

    // 保存到文件
    const success = this.ailyChatConfigService.save();
    if (success) {
      this.message.success('设置已保存');
      this.saved.emit();
    } else {
      this.message.error('保存设置失败');
    }
  }

  /**
   * 打开帮助链接
   */
  openHelpUrl(type: 'maxCount' | 'workspace' | 'tools' | 'apiKey') {
    const helpUrls = {
      maxCount: 'https://example.com/help/max-count',
      workspace: 'https://example.com/help/workspace',
      tools: 'https://example.com/help/tools',
      apiKey: 'https://example.com/help/api-key'
    };

    // https://aily.pro/doc/ai-usage-guide
    this.electronService.openUrl('https://aily.pro/doc/ai-usage-guide');
  }
}
