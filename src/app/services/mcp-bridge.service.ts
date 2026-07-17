import { Injectable, NgZone } from '@angular/core';

import { ProjectService } from './project.service';
import { SchematicMcpRuntimeService } from './schematic-mcp-runtime.service';

type McpBridgePayload = {
  requestId?: string;
  namespace?: string;
  method?: string;
  args?: Record<string, unknown>;
  targetProjectPath?: string;
};

@Injectable({ providedIn: 'root' })
export class McpBridgeService {
  private initialized = false;

  constructor(
    private readonly projectService: ProjectService,
    private readonly schematicRuntime: SchematicMcpRuntimeService,
    private readonly ngZone: NgZone,
  ) {}

  ensureInitialized(): void {
    if (this.initialized || typeof window === 'undefined') {
      return;
    }

    const electronApi = (window as any)['electronAPI'];
    const ipcRenderer = window['ipcRenderer'] || electronApi?.ipcRenderer;
    if (!ipcRenderer?.on || !ipcRenderer?.send) {
      return;
    }

    ipcRenderer.on('mcp:request', (_event: unknown, payload: McpBridgePayload) => {
      void this.handleIpcPayload(ipcRenderer, payload);
    });
    this.initialized = true;
  }

  private async handleIpcPayload(ipcRenderer: any, payload: McpBridgePayload): Promise<void> {
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
    const respond = (result: Record<string, unknown>) => {
      ipcRenderer.send('mcp:response', {
        requestId,
        ...result,
      });
    };

    if (!requestId) {
      respond({
        ok: false,
        errorCode: 'MCP_BRIDGE_MISSING_REQUEST_ID',
        message: '缺少 requestId',
      });
      return;
    }

    try {
      const result = await this.ngZone.run(() => this.execute(payload));
      respond({ ok: true, result });
    } catch (error) {
      respond({
        ok: false,
        errorCode: 'MCP_BRIDGE_EXECUTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async execute(payload: McpBridgePayload): Promise<unknown> {
    const namespace = typeof payload?.namespace === 'string' ? payload.namespace.trim() : '';
    switch (namespace) {
      case 'schematic':
        return this.executeSchematic(payload);
      default:
        throw new Error(`Unsupported MCP bridge namespace: ${namespace || '<empty>'}`);
    }
  }

  private async executeSchematic(payload: McpBridgePayload): Promise<unknown> {
    const args = this.normalizeArgs(payload?.args);
    const targetProjectPath = this.normalizePath(payload?.targetProjectPath);
    const currentProjectPath = this.normalizePath(this.projectService.currentProjectPath);

    if (targetProjectPath && currentProjectPath && targetProjectPath !== currentProjectPath) {
      return {
        ok: false,
        error: `当前打开项目不匹配: ${this.projectService.currentProjectPath}`,
      };
    }

    const method = typeof payload?.method === 'string' ? payload.method.trim() : '';
    return this.schematicRuntime.invoke(method, {
      ...args,
      targetProjectPath,
    });
  }

  private normalizeArgs(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private normalizePath(value: unknown): string {
    return typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
  }
}
