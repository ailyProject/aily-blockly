import { Injectable } from '@angular/core';

import { ConnectionGraphService } from './connection-graph.service';
import { ElectronService } from './electron.service';
import { ProjectService } from './project.service';
import { UiService } from './ui.service';
import {
  generateConnectionGraphTool,
  generatePinmapTool,
  getCurrentSchematicTool,
  getPinmapSummaryTool,
  getProjectContextTool,
  getSensorPinmapCatalogTool,
  savePinmapTool,
  validateConnectionGraphTool,
} from '../tools/aily-chat/tools/connectionGraphTool';
import type { ToolUseResult } from '../tools/aily-chat/core/tool-types';
import { AilyHost } from '../tools/aily-chat/core/host';
import { ThemeService } from './theme.service';
import { TranslateService } from '@ngx-translate/core';

@Injectable({ providedIn: 'root' })
export class SchematicMcpRuntimeService {
  constructor(
    private readonly connectionGraphService: ConnectionGraphService,
    private readonly electronService: ElectronService,
    private readonly projectService: ProjectService,
    private readonly uiService: UiService,
    private readonly themeService: ThemeService,
    private readonly translate: TranslateService,
  ) {}

  async invoke(method: string, args: Record<string, unknown>): Promise<unknown> {
    switch ((method || '').trim()) {
      case 'get_generated_cpp_code':
        return this.getGeneratedCppCode();
      case 'preview_schematic_components':
        return this.previewSchematicComponents(args);
      case 'notify_schematic_saved':
        return this.notifySchematicSaved(args);
      case 'generate_schematic':
        return generateConnectionGraphTool(this.connectionGraphService, this.projectService, args as any);
      case 'get_pinmap_summary':
        return getPinmapSummaryTool(this.connectionGraphService, this.projectService, args as any);
      case 'get_component_catalog':
        return getSensorPinmapCatalogTool(this.connectionGraphService, this.projectService, args as any);
      case 'get_project_context':
        return getProjectContextTool(this.connectionGraphService, this.projectService, args as any);
      case 'validate_schematic':
        return validateConnectionGraphTool(this.connectionGraphService, this.projectService, args as any);
      case 'get_current_schematic':
        return getCurrentSchematicTool(this.connectionGraphService, this.projectService, args as any);
      case 'generate_pinmap':
        return generatePinmapTool(this.connectionGraphService, this.projectService, args as any);
      case 'save_pinmap':
        return savePinmapTool(this.connectionGraphService, this.projectService, args as any);
      default:
        return {
          is_error: true,
          content: `不支持的 schematic MCP 方法: ${method || '<empty>'}`,
        };
    }
  }

  private async getGeneratedCppCode(): Promise<{ ok: boolean; cppCode?: string; error?: string }> {
    try {
      const cppCode = AilyHost.get().editor?.getGeneratedCode?.() || '';
      return { ok: true, cppCode };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  private async previewSchematicComponents(args: Record<string, unknown>): Promise<{ ok: boolean; windowOpened?: boolean; previewUpdated?: boolean; error?: string }> {
    try {
      const projectValidation = this.validateTargetProject(args['targetProjectPath']);
      if (projectValidation) {
        return projectValidation;
      }

      const payload = {
        componentConfigs: args['componentConfigs'] || {},
        components: Array.isArray(args['components']) ? args['components'] : [],
        connections: Array.isArray(args['connections']) ? args['connections'] : [],
        ...(typeof args['autoRoutingMode'] === 'boolean'
          ? { autoRoutingMode: args['autoRoutingMode'] }
          : {}),
        ...(typeof args['autoSave'] === 'boolean'
          ? { autoSave: args['autoSave'] }
          : {}),
      };

      const windowOpened = await this.ensureCircuitWindowOpen(payload);
      let previewUpdated = false;

      if (this.connectionGraphService.hasActiveIframe) {
        await this.connectionGraphService.iframeApi.receiveData(payload);
        previewUpdated = true;
      }
      if (typeof window !== 'undefined' && window['ipcRenderer']) {
        window['ipcRenderer'].send('iframe-message-connection-graph', {
          type: 'generate-graph-updated',
          data: payload,
        });
      }
      this.connectionGraphService.emitNotice?.({
        title: 'AI生成中',
        text: '硬件组件已就绪，正在生成连线方案...',
        state: 'doing',
        showProgress: false,
      });
      return { ok: true, windowOpened, previewUpdated };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  private async notifySchematicSaved(args: Record<string, unknown>): Promise<{ ok: boolean; saved: boolean; windowUpdated?: boolean; error?: string }> {
    try {
      const projectValidation = this.validateTargetProject(args['targetProjectPath']);
      if (projectValidation) {
        return {
          ok: false,
          saved: false,
          error: projectValidation.error,
        };
      }

      const jsonData = args['jsonData'] as any;
      let windowUpdated = false;
      const boardPackagePath = await this.projectService.getBoardPackagePath();
      if (boardPackagePath && jsonData) {
        const componentConfigs = this.connectionGraphService.getComponentConfigs(boardPackagePath, jsonData);
        const payload = {
          componentConfigs,
          components: jsonData.components || [],
          connections: jsonData.connections || [],
          theme: 'dark',
        };
        await this.ensureCircuitWindowOpen(payload);
        if (this.connectionGraphService.hasActiveIframe) {
          await this.connectionGraphService.iframeApi.receiveData(payload);
          windowUpdated = true;
        }
        if (this.electronService.isElectron && window['ipcRenderer']) {
          window['ipcRenderer'].send('iframe-message-connection-graph', {
            type: 'generate-graph-updated',
            data: payload,
          });
        }
      }
      this.connectionGraphService.emitNotice?.({
        title: 'AI生成中',
        text: '✅ 连线图已生成完成',
        state: 'done',
        setTimeout: 3000,
      });
      return { ok: true, saved: true, windowUpdated };
    } catch (error: any) {
      return { ok: false, saved: false, error: error?.message || String(error) };
    }
  }

  private validateTargetProject(targetProjectPath: unknown): { ok: false; error: string } | null {
    const target = typeof targetProjectPath === 'string' ? targetProjectPath.trim().replace(/\\/g, '/') : '';
    const current = typeof this.projectService.currentProjectPath === 'string'
      ? this.projectService.currentProjectPath.trim().replace(/\\/g, '/')
      : '';
    if (!target || !current) {
      return { ok: false, error: '当前没有打开 Blockly 项目' };
    }
    if (target !== current) {
      return { ok: false, error: `当前打开项目不匹配: ${this.projectService.currentProjectPath}` };
    }
    return null;
  }

  private buildCircuitWindowUrl(): string {
    return `https://tool.aily.pro/connection-graph?type=json&theme=${this.themeService.theme()}&lang=${this.translate.currentLang}`;
  }

  private buildCircuitWindowPath(): string {
    return `iframe?url=${encodeURIComponent(this.buildCircuitWindowUrl())}`;
  }

  private async ensureCircuitWindowOpen(initialData: unknown): Promise<boolean> {
    const windowPath = this.buildCircuitWindowPath();
    const focused = await Promise.resolve(window['subWindow']?.focus?.(windowPath) ?? false).catch(() => false);
    if (focused) {
      return true;
    }
    this.uiService.openWindow({
      title: this.translate.instant('FLOAT_SIDER.CIRCUIT') || '电路连接',
      path: windowPath,
      data: initialData ?? null,
      width: 900,
      height: 700,
    });
    return true;
  }
}
