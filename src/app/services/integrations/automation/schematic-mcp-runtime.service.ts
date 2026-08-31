import { Inject, Injectable } from '@angular/core';

import { ConnectionGraphService } from '@domain/schematic/public-api';
import { ElectronService } from '@core/platform/public-api';
import { ProjectService } from '@domain/project/public-api';
import {
  generateConnectionGraphTool,
  generatePinmapTool,
  getCurrentSchematicTool,
  getPinmapSummaryTool,
  getProjectContextTool,
  getSensorPinmapCatalogTool,
  savePinmapTool,
  validateConnectionGraphTool,
  type ConnectionGraphInvocationContext,
} from '../../../integrations/schematic/connection-graph-operations';
import { ConfigService, ThemeService } from '@core/preferences/public-api';
import { TranslateService } from '@ngx-translate/core';
import { AuthService } from '@core/auth/public-api';
import {
  AUTOMATION_UI_PORT,
  type AutomationUiPort,
} from './ports/automation-ui.port';
import {
  BLOCKLY_GENERATED_CODE_PORT,
  type BlocklyGeneratedCodePort,
} from './ports/blockly-generated-code.port';
import {
  SCHEMATIC_PRESENTATION_PORT,
  type SchematicPresentationPort,
} from './ports/schematic-presentation.port';

const CIRCUIT_PAYLOAD_ACK_TIMEOUT_MS = 2_000;
const CIRCUIT_WINDOW_READY_TIMEOUT_MS = 20_000;
const CIRCUIT_WINDOW_READY_PROBE_INTERVAL_MS = 250;

@Injectable({ providedIn: 'root' })
export class SchematicMcpRuntimeService {
  constructor(
    private readonly connectionGraphService: ConnectionGraphService,
    private readonly electronService: ElectronService,
    private readonly projectService: ProjectService,
    @Inject(AUTOMATION_UI_PORT)
    private readonly ui: AutomationUiPort,
    private readonly themeService: ThemeService,
    private readonly translate: TranslateService,
    @Inject(BLOCKLY_GENERATED_CODE_PORT)
    private readonly blocklyGeneratedCode: BlocklyGeneratedCodePort,
    private readonly authService: AuthService,
    @Inject(SCHEMATIC_PRESENTATION_PORT)
    private readonly presentation: SchematicPresentationPort,
    private readonly configService: ConfigService,
  ) {}

  async invoke(method: string, args: Record<string, unknown>): Promise<unknown> {
    switch ((method || '').trim()) {
      case 'get_generated_cpp_code':
        return this.getGeneratedCppCode();
      case 'show_arch':
        return this.showArch(args);
      case 'show_schematic':
        return this.showSchematic(args);
      case 'preview_schematic_components':
        return this.previewSchematicComponents(args);
      case 'notify_schematic_saved':
        return this.notifySchematicSaved(args);
      case 'generate_schematic':
        return generateConnectionGraphTool(this.connectionGraphService, this.projectService, args as any, this.invocationContext());
      case 'get_pinmap_summary':
        return getPinmapSummaryTool(this.connectionGraphService, this.projectService, args as any, this.invocationContext());
      case 'get_component_catalog':
        return getSensorPinmapCatalogTool(this.connectionGraphService, this.projectService, args as any);
      case 'get_project_context':
        return getProjectContextTool(this.connectionGraphService, this.projectService, args as any, this.invocationContext());
      case 'validate_schematic':
        return validateConnectionGraphTool(this.connectionGraphService, this.projectService, args as any, this.invocationContext());
      case 'get_current_schematic':
        return getCurrentSchematicTool(this.connectionGraphService, this.projectService, args as any);
      case 'generate_pinmap':
        return generatePinmapTool(this.connectionGraphService, this.projectService, args as any);
      case 'save_pinmap':
        return savePinmapTool(this.connectionGraphService, this.projectService, args as any, this.invocationContext());
      default:
        return {
          is_error: true,
          content: `不支持的 schematic MCP 方法: ${method || '<empty>'}`,
        };
    }
  }

  private async getGeneratedCppCode(): Promise<{ ok: boolean; cppCode?: string; error?: string }> {
    try {
      const cppCode = this.blocklyGeneratedCode.getReusableGeneratedCode() || '';
      return { ok: true, cppCode };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  private invocationContext(): ConnectionGraphInvocationContext {
    return {
      getAuthToken: () => this.authService.getToken(),
      getGeneratedCode: () => this.blocklyGeneratedCode.getReusableGeneratedCode() || '',
    };
  }

  private async showArch(args: Record<string, unknown>): Promise<{ ok: boolean; opened?: boolean; error?: string }> {
    const projectValidation = this.validateTargetProject(args['targetProjectPath']);
    if (projectValidation) {
      return projectValidation;
    }
    if (!this.electronService.isElectron) {
      return { ok: false, error: `架构图仅支持在 ${this.configService.getApplicationName()} 桌面端查看` };
    }

    const archPath = this.electronService.pathJoin(this.projectService.currentProjectPath, 'arch.md');
    if (!this.electronService.exists(archPath)) {
      return { ok: false, error: '当前项目没有架构图' };
    }

    try {
      const content = this.electronService.readFile(archPath).trim();
      const blockMatch = content.match(/```mermaid\s*([\s\S]*?)```/);
      const code = (blockMatch?.[1] || content).trim();
      if (!code) {
        return { ok: false, error: '当前项目的架构图为空' };
      }

      return await this.presentation.showArchitectureDiagram(code);
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  private async showSchematic(args: Record<string, unknown>): Promise<{ ok: boolean; opened?: boolean; error?: string }> {
    const projectValidation = this.validateTargetProject(args['targetProjectPath']);
    if (projectValidation) {
      return projectValidation;
    }
    if (!this.electronService.isElectron) {
      return { ok: false, error: `电路连接仅支持在 ${this.configService.getApplicationName()} 桌面端查看` };
    }

    try {
      const boardPackagePath = await this.projectService.getBoardPackagePath();
      if (!boardPackagePath) {
        return { ok: false, error: '当前项目没有可用的开发板引脚配置' };
      }
      const payload = this.connectionGraphService.buildPayload(
        boardPackagePath,
        this.projectService.currentProjectPath,
      );
      if (!payload?.connections?.length) {
        return { ok: false, error: '当前项目没有已保存的电路连接' };
      }

      const circuitWindow = await this.ensureCircuitWindowOpen(payload);
      if (!circuitWindow.ready) {
        return {
          ok: false,
          opened: circuitWindow.opened,
          error: '等待电路连接窗口加载完成超时',
        };
      }
      const applied = await this.pushCircuitPayload(payload);
      if (!applied) {
        return {
          ok: false,
          opened: true,
          error: '电路连接窗口未确认应用连线图',
        };
      }

      return { ok: true, opened: true };
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

      const circuitWindow = await this.ensureCircuitWindowOpen(payload);
      if (!circuitWindow.ready) {
        return {
          ok: false,
          windowOpened: circuitWindow.opened,
          previewUpdated: false,
          error: '等待电路连接窗口加载完成超时',
        };
      }

      const windowOpened = circuitWindow.opened;
      const previewUpdated = await this.pushCircuitPayload(payload);

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
        const circuitWindow = await this.ensureCircuitWindowOpen(payload);
        if (!circuitWindow.ready) {
          return {
            ok: false,
            saved: true,
            windowUpdated: false,
            error: '等待电路连接窗口加载完成超时',
          };
        }
        windowUpdated = await this.pushCircuitPayload(payload);
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

  private buildCircuitWindowPath(windowUrl = this.buildCircuitWindowUrl()): string {
    return `iframe?url=${encodeURIComponent(windowUrl)}`;
  }

  private async pushCircuitPayload(payload: unknown): Promise<boolean> {
    if (this.connectionGraphService.hasActiveIframe) {
      await this.connectionGraphService.iframeApi.receiveData(payload);
      return true;
    }

    if (!this.electronService.isElectron || typeof window === 'undefined' || !window['ipcRenderer']) {
      return false;
    }

    const ipcRenderer = window['ipcRenderer'];
    const channel = 'iframe-message-connection-graph';
    const messageId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise<boolean>((resolve) => {
      const finish = (applied: boolean) => {
        clearTimeout(timeoutId);
        ipcRenderer.removeListener?.(channel, handler);
        resolve(applied);
      };
      const handler = (_event: unknown, message: { type?: string; data?: unknown }) => {
        if (message?.type !== 'generate-graph-applied') return;

        const data = message.data as { messageId?: string; applied?: boolean } | undefined;
        if (data?.messageId !== messageId) return;

        finish(data.applied === true);
      };
      const timeoutId = setTimeout(() => finish(false), CIRCUIT_PAYLOAD_ACK_TIMEOUT_MS);

      ipcRenderer.on(channel, handler);
      ipcRenderer.send(channel, {
        type: 'generate-graph-updated',
        data: { messageId, payload },
      });
    });
  }

  private async ensureCircuitWindowOpen(
    initialData: unknown,
  ): Promise<{ opened: boolean; ready: boolean }> {
    if (this.connectionGraphService.hasActiveIframe) {
      return { opened: true, ready: true };
    }

    const windowUrl = this.buildCircuitWindowUrl();
    const windowPath = this.buildCircuitWindowPath(windowUrl);
    const readyPromise = this.waitForCircuitWindowReady(windowUrl);
    const focused = await Promise.resolve(window['subWindow']?.focus?.(windowPath) ?? false).catch(() => false);
    if (!focused) {
      this.ui.openWindow({
        title: this.translate.instant('FLOAT_SIDER.CIRCUIT') || '电路连接',
        path: windowPath,
        data: initialData ?? null,
        width: 900,
        height: 700,
      });
    }

    return {
      opened: true,
      ready: await readyPromise,
    };
  }

  private waitForCircuitWindowReady(windowUrl: string): Promise<boolean> {
    if (!this.electronService.isElectron || typeof window === 'undefined' || !window['ipcRenderer']) {
      return Promise.resolve(false);
    }

    const ipcRenderer = window['ipcRenderer'];
    const channel = 'iframe-message-connection-graph';
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let probeIntervalId: ReturnType<typeof setInterval> | null = null;

      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (probeIntervalId !== null) clearInterval(probeIntervalId);
        ipcRenderer.removeListener?.(channel, handler);
        resolve(ready);
      };
      const handler = (_event: unknown, message: { type?: string; data?: unknown }) => {
        if (message?.type !== 'connection-graph-ready') return;

        const data = message.data as {
          requestId?: string;
          url?: string;
          ready?: boolean;
        } | undefined;
        if (data?.url !== windowUrl || data.ready !== true) return;
        if (data.requestId && data.requestId !== requestId) return;

        finish(true);
      };
      const probe = () => {
        ipcRenderer.send(channel, {
          type: 'connection-graph-ready-request',
          data: { requestId, url: windowUrl },
        });
      };
      const timeoutId = setTimeout(
        () => finish(false),
        CIRCUIT_WINDOW_READY_TIMEOUT_MS,
      );

      ipcRenderer.on(channel, handler);
      probe();
      probeIntervalId = setInterval(
        probe,
        CIRCUIT_WINDOW_READY_PROBE_INTERVAL_MS,
      );
    });
  }
}
