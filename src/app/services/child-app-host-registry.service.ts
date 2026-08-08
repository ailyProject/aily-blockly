import { Injectable } from '@angular/core';

export type ChildAppHostAction = 'status' | 'prepareUpdate' | 'restart' | 'close' | 'detach' | 'embed';

export interface ChildAppWindowPlacement {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  displayId?: string | number;
  relativeToDisplay?: boolean;
  clampToWorkArea?: boolean;
  applyInitialBounds?: boolean;
}

export interface ChildAppHostRegistrationOptions {
  instanceId?: string;
  surface?: string;
  primary?: boolean;
}

export interface ChildAppHostControlOptions extends ChildAppWindowPlacement {
  instanceId?: string;
}

export interface ChildAppHostController {
  status(): Record<string, unknown>;
  prepareUpdate(): Promise<Record<string, unknown>>;
  restart(): Promise<Record<string, unknown>>;
  close(): Promise<Record<string, unknown>>;
  detach(options?: ChildAppWindowPlacement): Promise<Record<string, unknown>>;
  embed(): Promise<Record<string, unknown>>;
}

interface ChildAppHostRegistration {
  instanceId: string;
  surface: string;
  primary: boolean;
  controller: ChildAppHostController;
}

@Injectable({ providedIn: 'root' })
export class ChildAppHostRegistryService {
  private readonly controllers = new Map<string, Map<string, ChildAppHostRegistration>>();
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

  register(
    toolId: string,
    controller: ChildAppHostController,
    options: ChildAppHostRegistrationOptions = {},
  ): () => void {
    const id = this.normalizeToolId(toolId);
    if (!id) {
      throw new Error('Child app tool id is required');
    }

    const instanceId = this.normalizeInstanceId(options.instanceId);
    const registrations = this.controllers.get(id) || new Map<string, ChildAppHostRegistration>();
    const registration: ChildAppHostRegistration = {
      instanceId,
      surface: String(options.surface || 'default').trim() || 'default',
      primary: options.primary ?? instanceId === 'default',
      controller,
    };
    registrations.set(instanceId, registration);
    this.controllers.set(id, registrations);

    return () => {
      const currentRegistrations = this.controllers.get(id);
      if (currentRegistrations?.get(instanceId) === registration) {
        currentRegistrations.delete(instanceId);
        if (currentRegistrations.size === 0) {
          this.controllers.delete(id);
        }
      }
    };
  }

  has(toolId: string, instanceId?: string): boolean {
    const registrations = this.controllers.get(this.normalizeToolId(toolId));
    if (!registrations) return false;
    return instanceId === undefined
      ? registrations.size > 0
      : registrations.has(this.normalizeInstanceId(instanceId));
  }

  getStatus(toolId: string, instanceId?: string): Record<string, unknown> | null {
    const registration = this.resolveRegistration(toolId, instanceId);
    return registration
      ? {
          instanceId: registration.instanceId,
          surface: registration.surface,
          ...registration.controller.status(),
        }
      : null;
  }

  list(toolId?: string): Array<{ toolId: string; instanceId: string; surface: string; primary: boolean }> {
    const normalizedToolId = toolId === undefined ? '' : this.normalizeToolId(toolId);
    const entries = normalizedToolId
      ? [[normalizedToolId, this.controllers.get(normalizedToolId)] as const]
      : Array.from(this.controllers.entries());

    return entries.flatMap(([id, registrations]) =>
      Array.from(registrations?.values() || []).map(registration => ({
        toolId: id,
        instanceId: registration.instanceId,
        surface: registration.surface,
        primary: registration.primary,
      })));
  }

  async control(
    toolId: string,
    action: ChildAppHostAction,
    options: ChildAppHostControlOptions = {},
  ): Promise<Record<string, unknown>> {
    const id = this.normalizeToolId(toolId);
    const registration = this.resolveRegistration(id, options.instanceId);
    if (!registration) {
      return { ok: false, message: `子应用宿主未打开或尚未就绪: ${id || toolId}` };
    }
    const controller = registration.controller;

    switch (action) {
      case 'status':
        return {
          ok: true,
          toolId: id,
          instanceId: registration.instanceId,
          surface: registration.surface,
          ...controller.status(),
        };
      case 'prepareUpdate':
        return controller.prepareUpdate();
      case 'restart':
        return controller.restart();
      case 'close':
        return controller.close();
      case 'detach':
        return controller.detach(options);
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
    return this.control(toolId, action, payload as ChildAppHostControlOptions);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private normalizeToolId(value: string): string {
    return String(value || '').trim();
  }

  private normalizeInstanceId(value?: string): string {
    return String(value || 'default').trim() || 'default';
  }

  private resolveRegistration(toolId: string, instanceId?: string): ChildAppHostRegistration | null {
    const registrations = this.controllers.get(this.normalizeToolId(toolId));
    if (!registrations?.size) return null;

    if (instanceId !== undefined) {
      return registrations.get(this.normalizeInstanceId(instanceId)) || null;
    }

    return Array.from(registrations.values()).find(registration => registration.primary)
      || registrations.values().next().value
      || null;
  }
}
