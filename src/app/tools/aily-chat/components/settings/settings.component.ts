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
import { AilyChatConfigService, WorkspaceSecurityOption, ModelConfigOption, AgentToolsConfig } from '../../services/aily-chat-config.service';

/** Agent 类型定义 */
type AgentType = 'mainAgent' | 'schematicAgent';

/** Agent 配置信息 */
interface AgentConfig {
  name: AgentType;
  displayName: string;
  description: string;
}

/** 工具配置 */
interface ToolConfig {
  name: string;
  displayName: string;
  description: string;
  enabled: boolean;
}

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

  // 默认自动保存变更
  autoSaveEdits: boolean = false;

  // Agent 列表配置
  readonly agentConfigs: AgentConfig[] = [
    { name: 'mainAgent', displayName: '主 Agent', description: '处理用户请求的主要Agent' },
    { name: 'schematicAgent', displayName: '连线 Agent', description: '处理电路连线图相关任务的子Agent' }
  ];
  
  // 当前选中的 Agent
  selectedAgent: AgentType = 'mainAgent';

  // 按Agent分类的工具列表配置
  agentToolsMap: Map<AgentType, ToolConfig[]> = new Map();
  agentAllChecked: Map<AgentType, boolean> = new Map();
  agentIndeterminate: Map<AgentType, boolean> = new Map();

  // 安全工作区配置
  workspaceOptions: WorkspaceSecurityOption[] = [];
  allWorkspaceChecked = false;
  workspaceIndeterminate = false;

  // 模型管理
  modelList: ModelConfigOption[] = [];
  allModelsChecked = false;
  modelsIndeterminate = false;
  
  // 添加/编辑模型表单
  newModel = {
    model: '',
    name: '',
    baseUrl: '',
    apiKey: ''
  };
  showAddModelForm = false;
  editingModel: ModelConfigOption | null = null; // 当前正在编辑的模型

  /**
   * 获取当前Agent启用的工具数量
   */
  get enabledToolsCount(): number {
    const tools = this.agentToolsMap.get(this.selectedAgent) || [];
    return tools.filter(t => t.enabled).length;
  }

  /**
   * 获取当前Agent的工具总数
   */
  get totalToolsCount(): number {
    const tools = this.agentToolsMap.get(this.selectedAgent) || [];
    return tools.length;
  }

  /**
   * 获取当前Agent的工具列表
   */
  get currentAgentTools(): ToolConfig[] {
    return this.agentToolsMap.get(this.selectedAgent) || [];
  }

  /**
   * 获取当前Agent是否全选
   */
  get allChecked(): boolean {
    return this.agentAllChecked.get(this.selectedAgent) || false;
  }

  /**
   * 获取当前Agent是否半选
   */
  get indeterminate(): boolean {
    return this.agentIndeterminate.get(this.selectedAgent) || false;
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
    this.autoSaveEdits = this.ailyChatConfigService.autoSaveEdits;
  }

  /**
   * 从配置服务加载安全工作区选项
   */
  private loadWorkspaceOptions() {
    this.workspaceOptions = this.ailyChatConfigService.getWorkspaceSecurityOptions();
    this.updateWorkspaceAllChecked();
  }

  /**
   * 初始化工具列表 - 按Agent分类
   */
  private initializeTools() {
    // 为每个 Agent 初始化工具列表
    for (const agentConfig of this.agentConfigs) {
      const agentName = agentConfig.name;
      
      // 从配置服务获取该 Agent 的已启用/禁用工具列表
      const agentToolsConfig = this.ailyChatConfigService.getAgentToolsConfig(agentName);
      const savedEnabledTools = agentToolsConfig?.enabledTools || [];
      const savedDisabledTools = agentToolsConfig?.disabledTools || [];
      const hasStoredConfig = savedEnabledTools.length > 0 || savedDisabledTools.length > 0;
      
      // 从 TOOLS 常量中筛选出属于该 Agent 的工具
      const agentTools: ToolConfig[] = TOOLS
        .filter(tool => tool.agents && tool.agents.includes(agentName))
        .map(tool => {
          let enabled: boolean;
          if (!hasStoredConfig) {
            // 没有配置时，默认全部启用
            enabled = true;
          } else if (savedEnabledTools.includes(tool.name)) {
            // 明确启用的工具
            enabled = true;
          } else if (savedDisabledTools.includes(tool.name)) {
            // 明确禁用的工具
            enabled = false;
          } else {
            // 新工具（不在启用列表也不在禁用列表），默认启用
            enabled = true;
          }
          
          return {
            name: tool.name,
            displayName: this.formatToolName(tool.name),
            description: typeof tool.description === 'string' ? tool.description : '',
            enabled
          };
        });
      
      this.agentToolsMap.set(agentName, agentTools);
      this.updateAgentAllChecked(agentName);
    }
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
   * 更新指定Agent的全选状态
   */
  private updateAgentAllChecked(agentName: AgentType): void {
    const tools = this.agentToolsMap.get(agentName) || [];
    const enabledCount = tools.filter(t => t.enabled).length;
    this.agentAllChecked.set(agentName, enabledCount === tools.length && tools.length > 0);
    this.agentIndeterminate.set(agentName, enabledCount > 0 && enabledCount < tools.length);
  }

  /**
   * 更新当前选中Agent的全选状态
   */
  updateAllChecked(): void {
    this.updateAgentAllChecked(this.selectedAgent);
  }

  /**
   * 全选/取消全选当前Agent的工具
   */
  onAllCheckedChange(checked: boolean): void {
    const tools = this.agentToolsMap.get(this.selectedAgent) || [];
    tools.forEach(tool => tool.enabled = checked);
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
    this.modelList = [...this.ailyChatConfigService.models].reverse();
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

  /**
   * 关闭模型表单（取消按钮）
   */
  toggleAddModelForm(): void {
    this.showAddModelForm = false;
    this.resetNewModelForm();
  }

  /**
   * 打开添加模型表单（添加按钮）
   */
  openAddModelForm(): void {
    // 如果正在编辑，先重置
    if (this.editingModel) {
      this.resetNewModelForm();
    }
    this.showAddModelForm = true;
  }

  /**
   * 重置添加模型表单
   */
  private resetNewModelForm(): void {
    this.newModel = {
      model: '',
      name: '',
      baseUrl: '',
      apiKey: ''
    };
    this.editingModel = null;
  }

  /**
   * 编辑模型
   */
  editModel(model: ModelConfigOption): void {
    if (!model.isCustom) {
      this.message.warning('不能编辑内置模型');
      return;
    }
    this.editingModel = model;
    this.newModel = {
      model: model.model,
      name: model.name,
      baseUrl: model.baseUrl || '',
      apiKey: model.apiKey || ''
    };
    this.showAddModelForm = true;
  }

  /**
   * 添加或更新自定义模型
   */
  addCustomModel(): void {
    if (!this.newModel.model || !this.newModel.name || !this.newModel.baseUrl || !this.newModel.apiKey) {
      this.message.warning('请填写完整的模型信息');
      return;
    }

    // 编辑模式
    if (this.editingModel) {
      // 如果模型ID变更，检查新ID是否与其他模型冲突
      if (this.newModel.model !== this.editingModel.model && 
          this.modelList.some(m => m.model === this.newModel.model)) {
        this.message.warning('该模型ID已存在');
        return;
      }

      // 更新模型配置
      this.editingModel.model = this.newModel.model;
      this.editingModel.name = this.newModel.name;
      this.editingModel.baseUrl = this.newModel.baseUrl;
      this.editingModel.apiKey = this.newModel.apiKey;

      this.resetNewModelForm();
      this.showAddModelForm = false;
      this.saveModels();
      this.message.success('模型已更新');
      return;
    }

    // 添加模式：检查模型id是否已存在
    if (this.modelList.some(m => m.model === this.newModel.model)) {
      this.message.warning('该模型ID已存在');
      return;
    }

    const newModelConfig: ModelConfigOption = {
      model: this.newModel.model,
      name: this.newModel.name,
      family: 'custom',
      speed: '1x',
      enabled: true,
      isCustom: true,
      baseUrl: this.newModel.baseUrl,
      apiKey: this.newModel.apiKey
    };

    this.modelList.unshift(newModelConfig);
    this.updateModelsAllChecked();
    this.resetNewModelForm();
    this.showAddModelForm = false;
    this.saveModels();
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
      this.saveModels();
      this.message.success('模型已删除');
    }
  }

  /**
   * 立即持久化模型配置
   */
  private saveModels(): void {
    this.ailyChatConfigService.models = this.modelList;
    this.ailyChatConfigService.save();
  }

  onClose() {
    this.close.emit();
  }

  async onSave() {
    // 保存配置
    this.ailyChatConfigService.maxCount = this.maxCount;
    this.ailyChatConfigService.autoSaveEdits = this.autoSaveEdits;

    // 保存每个Agent的工具配置
    for (const agentConfig of this.agentConfigs) {
      const agentName = agentConfig.name;
      const tools = this.agentToolsMap.get(agentName) || [];
      const enabledTools = tools.filter(t => t.enabled).map(t => t.name);
      const disabledTools = tools.filter(t => !t.enabled).map(t => t.name);
      
      this.ailyChatConfigService.setAgentToolsConfig(agentName, {
        enabledTools,
        disabledTools
      });
    }

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
