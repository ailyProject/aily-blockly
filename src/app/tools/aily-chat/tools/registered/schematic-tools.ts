/**
 * 已注册工具 - 连线图 / Schematic 类
 */

import { IAilyTool, ToolContext, ToolUseResult } from '../../core/tool-types';
import { ToolRegistry } from '../../core/tool-registry';
import {
  generateConnectionGraphTool as generateSchematicHandler,
  getPinmapSummaryTool as getPinmapSummaryHandler,
  getSensorPinmapCatalogTool as getComponentCatalogHandler,
  getProjectContextTool as getProjectContextHandler,
  validateConnectionGraphTool as validateSchematicHandler,
  generatePinmapTool as generatePinmapHandler,
  savePinmapTool as savePinmapHandler,
  getCurrentSchematicTool as getCurrentSchematicHandler,
  applySchematicTool as applySchematicHandler,
} from '../connectionGraphTool';
import { TOOLS as LEGACY_TOOLS } from '../tools';

function findLegacySchema(name: string): any {
  return (LEGACY_TOOLS as any[]).find(t => t.name === name);
}

// ============================
// generate_schematic
// ============================

class GenerateSchematicTool implements IAilyTool {
  readonly name = 'generate_schematic';
  readonly schema = findLegacySchema('generate_schematic');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.connectionGraph) return { is_error: true, content: '连线图服务不可用' };
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用' };
    ctx.host.connectionGraph.emitNotice?.({ title: 'AI生成中', text: '正在准备硬件组件引脚信息...', state: 'doing', showProgress: false });
    return generateSchematicHandler(ctx.host.connectionGraph as any, ctx.host.project as any, args);
  }

  getStartText(): string {
    return '分析引脚信息，准备连线方案...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '连线方案生成失败';
    return '连线方案生成完成';
  }
}

// ============================
// get_pinmap_summary
// ============================

class GetPinmapSummaryTool implements IAilyTool {
  readonly name = 'get_pinmap_summary';
  readonly schema = findLegacySchema('get_pinmap_summary');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.connectionGraph) return { is_error: true, content: '连线图服务不可用' };
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用' };
    return getPinmapSummaryHandler(ctx.host.connectionGraph as any, ctx.host.project as any, args);
  }

  getStartText(): string {
    return '获取引脚摘要信息...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '引脚摘要获取失败';
    return '引脚摘要获取成功';
  }
}

// ============================
// get_component_catalog
// ============================

class GetComponentCatalogTool implements IAilyTool {
  readonly name = 'get_component_catalog';
  readonly schema = findLegacySchema('get_component_catalog');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.connectionGraph) return { is_error: true, content: '连线图服务不可用' };
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用' };
    return getComponentCatalogHandler(ctx.host.connectionGraph as any, ctx.host.project as any, args);
  }

  getStartText(): string {
    return '扫描项目组件目录...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '组件目录获取失败';
    return '组件目录获取完成';
  }
}

// ============================
// get_project_context
// ============================

class GetProjectContextTool implements IAilyTool {
  readonly name = 'get_project_context';
  readonly schema = findLegacySchema('get_project_context');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.connectionGraph) return { is_error: true, content: '连线图服务不可用' };
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用' };
    ctx.host.connectionGraph.emitNotice?.({ title: 'AI生成中', text: '正在分析项目和组件信息...', state: 'doing', showProgress: false });
    return getProjectContextHandler(ctx.host.connectionGraph as any, ctx.host.project as any, args || {});
  }

  getStartText(): string {
    return '获取项目上下文和组件目录...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '项目上下文获取失败';
    return '项目上下文和组件目录获取完成';
  }
}

// ============================
// validate_schematic
// ============================

class ValidateSchematicTool implements IAilyTool {
  readonly name = 'validate_schematic';
  readonly schema = findLegacySchema('validate_schematic');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.connectionGraph) return { is_error: true, content: '连线图服务不可用' };
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用' };
    ctx.host.connectionGraph.emitNotice?.({ title: 'AI生成中', text: '正在验证并保存连线图...', state: 'doing', showProgress: false });
    return validateSchematicHandler(ctx.host.connectionGraph as any, ctx.host.project as any, args);
  }

  getStartText(): string {
    return '验证连线配置安全性...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '连线配置验证失败';
    return '连线配置验证完成';
  }
}

// ============================
// generate_pinmap
// ============================

class GeneratePinmapTool implements IAilyTool {
  readonly name = 'generate_pinmap';
  readonly schema = findLegacySchema('generate_pinmap');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.connectionGraph) return { is_error: true, content: '连线图服务不可用' };
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用' };
    ctx.host.connectionGraph.emitNotice?.({ title: 'AI生成中', text: '正在生成引脚配置...', state: 'doing', showProgress: false });
    return generatePinmapHandler(ctx.host.connectionGraph as any, ctx.host.project as any, args);
  }

  getStartText(): string {
    return '获取 pinmap 生成参考信息...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return 'Pinmap 参考信息获取失败';
    return 'Pinmap 参考信息获取完成';
  }
}

// ============================
// save_pinmap
// ============================

class SavePinmapTool implements IAilyTool {
  readonly name = 'save_pinmap';
  readonly schema = findLegacySchema('save_pinmap');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.connectionGraph) return { is_error: true, content: '连线图服务不可用' };
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用' };
    ctx.host.connectionGraph.emitNotice?.({ title: 'AI生成中', text: '正在保存引脚配置...', state: 'doing', showProgress: false });
    return savePinmapHandler(ctx.host.connectionGraph as any, ctx.host.project as any, args);
  }

  getStartText(): string {
    return '保存 pinmap 配置...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return 'Pinmap 配置保存失败';
    return 'Pinmap 配置保存成功';
  }
}

// ============================
// get_current_schematic
// ============================

class GetCurrentSchematicTool implements IAilyTool {
  readonly name = 'get_current_schematic';
  readonly schema = findLegacySchema('get_current_schematic');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.connectionGraph) return { is_error: true, content: '连线图服务不可用' };
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用' };
    return getCurrentSchematicHandler(ctx.host.connectionGraph as any, ctx.host.project as any, args || {});
  }

  getStartText(): string {
    return '读取当前连线图...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '当前连线图获取失败';
    return '当前连线图获取完成';
  }
}

// ============================
// apply_schematic (已废弃，功能已合并到 validate_schematic)
// ============================

class ApplySchematicTool implements IAilyTool {
  readonly name = 'apply_schematic';
  readonly schema = findLegacySchema('apply_schematic');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    // 已废弃：直接转发到 validate_schematic，它已包含保存 + 刷新功能
    if (!ctx.host?.connectionGraph) return { is_error: true, content: '连线图服务不可用' };
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用' };
    return validateSchematicHandler(ctx.host.connectionGraph as any, ctx.host.project as any, args);
  }

  getStartText(): string {
    return '验证并保存连线图...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '连线图验证保存失败';
    return '连线图验证并保存完成';
  }
}

// ============================
// 注册
// ============================

ToolRegistry.register(new GenerateSchematicTool());
ToolRegistry.register(new GetPinmapSummaryTool());
ToolRegistry.register(new GetComponentCatalogTool());
ToolRegistry.register(new ValidateSchematicTool());
ToolRegistry.register(new GeneratePinmapTool());
ToolRegistry.register(new SavePinmapTool());
ToolRegistry.register(new GetCurrentSchematicTool());
ToolRegistry.register(new ApplySchematicTool());
ToolRegistry.register(new GetProjectContextTool());
