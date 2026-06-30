import { Component, Input, OnInit, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Aily Blockly 查看器组件
 * 用于显示 Blockly 积木代码和相关信息
 */
@Component({
  selector: 'app-aily-blockly-viewer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './aily-blockly-viewer.component.html',
  styleUrls: ['./aily-blockly-viewer.component.scss']
})
export class AilyBlocklyViewerComponent implements OnInit, OnChanges {
  @Input() data: any;

  blocklyData: any = null;
  showRawData = false;
  errorMessage = '';
  rawDataString = '';

  ngOnInit() {
    this.processData();
  }

  ngOnChanges(changes: SimpleChanges) {
    // if (changes['data']) {
    //   this.processData();
    // }
  }

  /**
   * 处理输入数据
   */
  processData() {
    this.errorMessage = '';
    this.blocklyData = null;
    this.rawDataString = '';

    if (!this.data) {
      this.errorMessage = '没有提供数据';
      return;
    }

    try {
      // 如果data已经是对象，直接使用
      if (typeof this.data === 'object') {
        this.blocklyData = this.data;
      } else if (typeof this.data === 'string') {
        // 尝试解析JSON字符串
        this.blocklyData = JSON.parse(this.data);
      }

      // 存储原始数据字符串用于显示
      this.rawDataString = typeof this.data === 'string' ? 
        this.data : 
        JSON.stringify(this.data, null, 2);

      // 验证数据结构
      if (!this.isValidBlocklyData(this.blocklyData)) {
        this.errorMessage = '数据格式不正确，缺少必要的 Blockly 字段';
      }
    } catch (error) {
      this.errorMessage = '数据解析失败: ' + (error as Error).message;
      this.rawDataString = String(this.data);
    }
  }

  /**
   * 验证是否为有效的 Blockly 数据
   */
  isValidBlocklyData(data: any): boolean {
    if (!data || typeof data !== 'object') {
      return false;
    }

    // 检查必要字段
    return data.hasOwnProperty('blocks') || 
           data.hasOwnProperty('xml') || 
           data.hasOwnProperty('workspace') ||
           data.hasOwnProperty('code') ||
           data.hasOwnProperty('title');
  }

  /**
   * 切换原始数据显示
   */
  toggleRawData() {
    this.showRawData = !this.showRawData;
  }

  /**
   * 导入 Blockly 代码
   */
  importBlockly() {
    if (!this.blocklyData) {
      alert('没有可导入的数据');
      return;
    }

    try {
      // 这里应该调用实际的 Blockly 导入服务
      // 暂时使用 alert 提示
      alert('Blockly 代码导入功能需要集成到具体的 Blockly 服务中');
    } catch (error) {
      alert('导入失败: ' + (error as Error).message);
    }
  }

  /**
   * 复制数据到剪贴板
   */
  async copyToClipboard() {
    try {
      const textToCopy = this.showRawData ? 
        this.rawDataString : 
        JSON.stringify(this.blocklyData, null, 2);

      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(textToCopy);
      } else {
        // 降级方案
        const textArea = document.createElement('textarea');
        textArea.value = textToCopy;
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      
      alert('已复制到剪贴板');
    } catch (error) {
      alert('复制失败: ' + (error as Error).message);
    }
  }

  /**
   * 获取 Blockly 标题
   */
  getBlocklyTitle(): string {
    if (!this.blocklyData) return '未知项目';
    
    return this.blocklyData.title || 
           this.blocklyData.name || 
           this.blocklyData.projectName || 
           '未命名 Blockly 项目';
  }

  /**
   * 获取 Blockly 描述
   */
  getBlocklyDescription(): string {
    if (!this.blocklyData) return '无数据';

    if (this.blocklyData.description) {
      return this.blocklyData.description;
    }

    const blockCount = this.getBlockCount();
    const workspaceInfo = this.getWorkspaceSummary();

    return `包含 ${blockCount} 个积木块${workspaceInfo !== '无工作区信息' ? '，' + workspaceInfo : ''}`;
  }

  /**
   * 获取积木块数量
   */
  getBlockCount(): number {
    if (!this.blocklyData) return 0;

    // 从不同可能的字段中获取积木块数量
    if (this.blocklyData.blockCount !== undefined) {
      return this.blocklyData.blockCount;
    }

    if (this.blocklyData.blocks && Array.isArray(this.blocklyData.blocks)) {
      return this.blocklyData.blocks.length;
    }

    if (this.blocklyData.xml && typeof this.blocklyData.xml === 'string') {
      // 简单统计XML中的block标签数量
      const matches = this.blocklyData.xml.match(/<block/g);
      return matches ? matches.length : 0;
    }

    return 0;
  }

  /**
   * 获取工作区摘要信息
   */
  getWorkspaceSummary(): string {
    if (!this.blocklyData) return '无工作区信息';

    const info: string[] = [];

    if (this.blocklyData.workspace) {
      const workspace = this.blocklyData.workspace;
      
      if (workspace.variables && workspace.variables.length > 0) {
        info.push(`${workspace.variables.length} 个变量`);
      }
      
      if (workspace.procedures && workspace.procedures.length > 0) {
        info.push(`${workspace.procedures.length} 个函数`);
      }
    }

    if (this.blocklyData.variables && Array.isArray(this.blocklyData.variables)) {
      info.push(`${this.blocklyData.variables.length} 个变量`);
    }

    if (this.blocklyData.functions && Array.isArray(this.blocklyData.functions)) {
      info.push(`${this.blocklyData.functions.length} 个函数`);
    }

    return info.length > 0 ? info.join('，') : '无工作区信息';
  }

  /**
   * 获取项目类型
   */
  getProjectType(): string {
    if (!this.blocklyData) return '未知';

    return this.blocklyData.type || 
           this.blocklyData.projectType || 
           this.blocklyData.category || 
           'Blockly 项目';
  }

  /**
   * 获取难度级别
   */
  getDifficulty(): string {
    if (!this.blocklyData) return '';

    return this.blocklyData.difficulty || 
           this.blocklyData.level || 
           '';
  }

  /**
   * 获取难度颜色
   */
  getDifficultyColor(difficulty: string): string {
    const colorMap: Record<string, string> = {
      简单: 'green',
      中等: 'orange',
      困难: 'red',
      初级: 'green',
      中级: 'orange',
      高级: 'red',
      easy: 'green',
      medium: 'orange',
      hard: 'red',
      beginner: 'green',
      intermediate: 'orange',
      advanced: 'red',
    };

    return colorMap[difficulty.toLowerCase()] || 'blue';
  }

  /**
   * 获取标签列表
   */
  getTags(): string[] {
    if (!this.blocklyData) return [];

    if (Array.isArray(this.blocklyData.tags)) {
      return this.blocklyData.tags;
    }

    if (typeof this.blocklyData.tags === 'string') {
      return this.blocklyData.tags.split(',').map(tag => tag.trim());
    }

    if (Array.isArray(this.blocklyData.keywords)) {
      return this.blocklyData.keywords;
    }

    return [];
  }

  /**
   * 获取作者信息
   */
  getAuthor(): string {
    if (!this.blocklyData) return '';

    return this.blocklyData.author || 
           this.blocklyData.creator || 
           this.blocklyData.by || 
           '';
  }

  /**
   * 获取创建时间
   */
  getCreatedTime(): string {
    if (!this.blocklyData) return '';

    const timeField = this.blocklyData.createdAt || 
                     this.blocklyData.createTime || 
                     this.blocklyData.timestamp ||
                     this.blocklyData.date;

    if (!timeField) return '';

    try {
      const date = new Date(timeField);
      return date.toLocaleString('zh-CN');
    } catch {
      return String(timeField);
    }
  }

  /**
   * 检查是否有预览图
   */
  hasPreview(): boolean {
    return !!(this.blocklyData && (
      this.blocklyData.preview || 
      this.blocklyData.image || 
      this.blocklyData.thumbnail ||
      this.blocklyData.screenshot
    ));
  }

  /**
   * 获取预览图URL
   */
  getPreviewUrl(): string {
    if (!this.blocklyData) return '';

    return this.blocklyData.preview || 
           this.blocklyData.image || 
           this.blocklyData.thumbnail ||
           this.blocklyData.screenshot ||
           '';
  }

  /**
   * 检查是否有代码
   */
  hasCode(): boolean {
    return !!(this.blocklyData && (
      this.blocklyData.code || 
      this.blocklyData.generatedCode ||
      this.blocklyData.xml
    ));
  }

  /**
   * 获取生成的代码
   */
  getGeneratedCode(): string {
    if (!this.blocklyData) return '';

    return this.blocklyData.code || 
           this.blocklyData.generatedCode ||
           this.blocklyData.sourceCode ||
           '';
  }

  /**
   * 获取XML代码
   */
  getXmlCode(): string {
    if (!this.blocklyData) return '';

    return this.blocklyData.xml || '';
  }
}
