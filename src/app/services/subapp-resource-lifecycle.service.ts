import { Injectable } from '@angular/core';

import {
  getChildToolConfig,
  type ChildToolRuntimeResourceLifecycleConfig,
} from '../configs/tool.config';
import {
  toHostResourceLifecycleRequest,
  type HostResourceLifecycleRequest,
} from './subapp-resource-lifecycle-adapter';

interface ChildToolSessionSnapshot {
  toolId?: string;
  streamId?: string;
  running?: boolean;
  hostInfo?: {
    wsUrl?: string;
  } | null;
}

interface RuntimeRpcResponse {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
}

@Injectable({ providedIn: 'root' })
export class SubappResourceLifecycleService {
  private requestSequence = 0;

  handleSignal(
    signal: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> | null {
    const request = toHostResourceLifecycleRequest(signal, payload);
    return request ? this.handleRequest(request) : null;
  }

  async handleRequest(request: HostResourceLifecycleRequest): Promise<void> {
    const sessions = await this.readRunningSessions();
    const targets = sessions.flatMap(session => {
      const toolId = String(session.toolId || '').trim();
      const lifecycle = getChildToolConfig(toolId)?.runtime?.resourceLifecycle;
      if (!toolId || !lifecycle || !lifecycle.resources.includes(request.resource.kind)) {
        return [];
      }
      const wsUrl = String(session.hostInfo?.wsUrl || '').trim();
      return wsUrl ? [{ toolId, wsUrl, lifecycle }] : [];
    });

    if (targets.length === 0) {
      console.info('[SubappResourceLifecycle] no active Runtime matched', {
        action: request.action,
        resource: request.resource,
        operationId: request.operationId,
      });
      return;
    }

    const settled = await Promise.allSettled(targets.map(target => this.invokeTarget(target, request)));
    const failures = settled.flatMap((result, index) => result.status === 'rejected'
      ? [{
          toolId: targets[index].toolId,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }]
      : []);
    console.info('[SubappResourceLifecycle] operation completed', {
      action: request.action,
      resource: request.resource,
      operationId: request.operationId,
      targets: targets.map(target => target.toolId),
      failures,
    });
    if (failures.length > 0) {
      throw new Error(failures.map(item => `${item.toolId}: ${item.error}`).join('; '));
    }
  }

  private async readRunningSessions(): Promise<ChildToolSessionSnapshot[]> {
    const sessions = await window['childToolSession']?.list?.();
    return Array.isArray(sessions)
      ? sessions.filter(session => session?.running === true && session?.hostInfo?.wsUrl)
      : [];
  }

  private invokeTarget(
    target: {
      toolId: string;
      wsUrl: string;
      lifecycle: ChildToolRuntimeResourceLifecycleConfig;
    },
    request: HostResourceLifecycleRequest,
  ): Promise<unknown> {
    const method = request.action === 'suspend'
      ? target.lifecycle.suspendMethod
      : target.lifecycle.resumeMethod;
    const timeoutMs = this.resolveTimeout(target.lifecycle, request);
    const requestId = `host-resource-${Date.now()}-${++this.requestSequence}`;
    const wsUrl = this.validateRuntimeUrl(target.wsUrl);

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      let settled = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // The request is already settled.
        }
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } else {
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        finish(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      socket.addEventListener('open', () => {
        try {
          socket.send(JSON.stringify({
            id: requestId,
            method,
            params: request,
            context: {
              actor: 'host',
              actorId: 'subapp-resource-lifecycle',
            },
          }));
        } catch (error) {
          finish(error);
        }
      });
      socket.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        let response: RuntimeRpcResponse;
        try {
          response = JSON.parse(event.data) as RuntimeRpcResponse;
        } catch {
          return;
        }
        if (String(response.id || '') !== requestId) return;
        if (response.ok === false) {
          finish(new Error(
            `${response.errorCode ? `${response.errorCode}: ` : ''}${response.error || `${method} failed`}`,
          ));
          return;
        }
        finish(undefined, response.result);
      });
      socket.addEventListener('error', () => {
        finish(new Error(`Unable to connect to ${target.toolId} Runtime`));
      });
      socket.addEventListener('close', () => {
        finish(new Error(`${target.toolId} Runtime connection closed before ${method} completed`));
      });
    });
  }

  private resolveTimeout(
    lifecycle: ChildToolRuntimeResourceLifecycleConfig,
    request: HostResourceLifecycleRequest,
  ): number {
    const configured = this.boundedNumber(
      lifecycle.timeoutMs,
      request.action === 'resume' ? 150000 : 30000,
      100,
      10 * 60 * 1000,
    );
    if (request.action !== 'resume') return configured;
    const requested = Number(request.maxWaitMs || 0) + Number(request.settleMs || 0) + 5000;
    return Math.min(10 * 60 * 1000, Math.max(configured, requested));
  }

  private validateRuntimeUrl(value: string): string {
    const url = new URL(value);
    const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
    if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || !loopbackHosts.has(url.hostname)) {
      throw new Error(`Refusing non-local Subapp Runtime URL: ${url.origin}`);
    }
    return url.toString();
  }

  private boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
  }
}
