import { Component, EventEmitter, Output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzCheckboxModule } from 'ng-zorro-antd/checkbox';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { TOOLS } from '../../tools/tools';
import { ElectronService } from '../../../../services/electron.service';

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
  ],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss'
})
export class AilyChatSettingsComponent implements OnInit {

  @Output() close = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>(); // 保存成功事件

  // API 配置
  useCustomApiKey: boolean = false; // 是否使用自有 API Key
  maxCount: number = 100; // 最大循环次数
  baseUrl: string = ''; // API Base URL
  apiKey: string = ''; // API Key

  // 工具列表配置
  availableTools: Array<{name: string, displayName: string, description: string, enabled: boolean}> = [];
  allChecked = false;
  indeterminate = false;

  // 安全工作区配置
  workspaceOptions = [
    { name: 'project', displayName: '项目文件', enabled: true },
    { name: 'library', displayName: '库文件', enabled: true }
  ];
  allWorkspaceChecked = false;
  workspaceIndeterminate = false;

  /**
   * 获取启用的工具数量
   */
  get enabledToolsCount(): number {
    return this.availableTools.filter(t => t.enabled).length;
  }

  constructor(
    private message: NzMessageService,
    private electronService: ElectronService
  ) {
  }

  ngOnInit() {
    this.initializeTools();
    this.updateWorkspaceAllChecked();
  }

  /**
   * 初始化工具列表
   */
  private initializeTools() {
    // 从 TOOLS 常量中读取所有工具
    this.availableTools = TOOLS.map(tool => ({
      name: tool.name,
      displayName: this.formatToolName(tool.name),
      description: typeof tool.description === 'string' ? tool.description : '',
      enabled: true // 默认全部启用
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

  onClose() {
    this.close.emit();
  }

  async onSave() {
    // TODO: 实现保存逻辑，保存启用的工具列表和工作区配置
    const enabledTools = this.availableTools.filter(t => t.enabled).map(t => t.name);
    const enabledWorkspaces = this.workspaceOptions.filter(w => w.enabled).map(w => w.name);
    console.log('已启用的工具:', enabledTools);
    console.log('已启用的工作区:', enabledWorkspaces);
    this.message.success('设置已保存');
    this.saved.emit();
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
