import { Injectable } from '@angular/core';

export type ChildAppHostAction = 'status' | 'restart' | 'close' | 'detach' | 'embed';

export interface ChildAppHostController {
  status(): Record<string, unknown>;
  restart(): Promise<Record<string, unknown>>;
  close(): Promise<Record<string, unknown>>;
  detach(): Promise<Record<string, unknown>>;
  embed(): Promise<Record<string, unknown>>;
}

@Injectable({ providedIn: 'root' })
export class ChildAppHostRegistryService {
  private readonly controllers = new Map<string, ChildAppHostController>();
  private removeCommandListener: (() => void) | null = null;

  constructor() {
    this.ensureInitialized();
  }

  ensureInitialized(): void {
    if (this.removeCommandListener || typeof window === 'undefined') {
      return;
    }

    const api = (window as any)['childAppHost'] || (window as any).electronAPI?.childAppHost;
    if (!api?.onCommand) {
      return;
    }

    this.removeCommandListener = api.onCommand((command: unknown, requestId: string) => {
      void this.executeCommand(command)
        .then(result => api.respond?.(requestId, result))
        .catch(error => api.respond?.(requestId, {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }));
    });
  }

  register(toolId: string, controller: ChildAppHostController): () => void {
    const id = this.normalizeToolId(toolId);
    if (!id) {
      throw new Error('Child app tool id is required');
    }

    this.controllers.set(id, controller);
    return () => {
      if (this.controllers.get(id) === controller) {
        this.controllers.delete(id);
      }
    };
  }

  has(toolId: string): boolean {
    return this.controllers.has(this.normalizeToolId(toolId));
  }

  getStatus(toolId: string): Record<string, unknown> | null {
    return this.controllers.get(this.normalizeToolId(toolId))?.status() || null;
  }

  async control(toolId: string, action: ChildAppHostAction): Promise<Record<string, unknown>> {
    const id = this.normalizeToolId(toolId);
    const controller = this.controllers.get(id);
    if (!controller) {
      return { ok: false, message: `子应用宿主未打开或尚未就绪: ${id || toolId}` };
    }

    switch (action) {
      case 'status':
        return { ok: true, toolId: id, ...controller.status() };
      case 'restart':
        return controller.restart();
      case 'close':
        return controller.close();
      case 'detach':
        return controller.detach();
      case 'embed':
        return controller.embed();
      default:
        return { ok: false, message: `不支持的子应用宿主动作: ${String(action)}` };
    }
  }

  private async executeCommand(command: unknown): Promise<Record<string, unknown>> {
    const payload = this.asRecord(command);
    const toolId = typeof payload['toolId'] === 'string' ? payload['toolId'] : '';
    const action = typeof payload['action'] === 'string' ? payload['action'] as ChildAppHostAction : 'status';
    return this.control(toolId, action);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private normalizeToolId(value: string): string {
    return String(value || '').trim();
  }
}
