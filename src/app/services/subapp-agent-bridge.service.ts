import { Injectable, OnDestroy } from '@angular/core';

import {
  ChildToolAgentDefinition,
  ChildToolConfig,
  getChildToolConfig,
  getChildToolConfigs,
} from '../configs/tool.config';
import { ChildToolHostInfo, ChildToolProcessService } from './child-tool-process.service';
import { MainUiAutomationService } from './main-ui-automation.service';
import {
  SubappActivityService,
  type SubappRuntimeState,
} from './subapp-activity.service';
import { resolveSubappAgentPresentation } from './subapp-agent-presentation';
import { acquireSubappRuntimePresentationLease } from './subapp-runtime-presentation-lease';

interface SubappRpcResponse {
  id?: string | number;
  ok?: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
  details?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

interface SubappRpcChannel {
  toolId: string;
  socket: WebSocket | null;
  socketPromise: Promise<WebSocket> | null;
  expectedSocketCloses: Set<WebSocket>;
  hostInfo: ChildToolHostInfo | null;
  acquired: boolean;
  releasePromise: Promise<void> | null;
  requestSeq: number;
  pending: Map<string, PendingRequest>;
  sessionIds: Set<string>;
  hasUnscopedOwner: boolean;
}

interface ResolvedAgentTool {
  config: ChildToolConfig;
  definition: ChildToolAgentDefinition;
}

interface SubappAgentExecutionContext {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
}

class SubappRpcError extends Error {
  constructor(
    message: string,
    readonly code = 'SUBAPP_RPC_FAILED',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SubappRpcError';
  }
}

@Injectable({ providedIn: 'root' })
export class SubappAgentBridgeService implements OnDestroy {
  private readonly channels = new Map<string, SubappRpcChannel>();

  constructor(
    private readonly childToolProcessService: ChildToolProcessService,
    private readonly mainUiAutomationService: MainUiAutomationService,
    private readonly subappActivityService: SubappActivityService,
  ) {}

  async execute(
    input: Record<string, unknown> = {},
    signal?: AbortSignal,
    context: SubappAgentExecutionContext = {},
  ): Promise<Record<string, unknown>> {
    const requestedToolId = String(input['toolId'] || '');
    const tool = String(input['tool'] || '');
    const ownerSessionId = String(context.sessionId || '').trim();
    let resolved: ResolvedAgentTool | null = null;
    let releasePresentationRuntimeLease: (() => Promise<void>) | null = null;

    try {
      resolved = this.resolveAgentTool(requestedToolId, tool);
      const params = this.record(input['params']);
      const hasExplicitPresentation = Object.prototype.hasOwnProperty.call(params, 'presentUi');
      const activeMode = !hasExplicitPresentation
        && resolved.definition.presentation
        && await this.mainUiAutomationService.isChildAppWindowOpen(resolved.config.id)
        ? 'window' as const
        : undefined;
      const presentationPolicy = resolveSubappAgentPresentation(params, resolved.definition, activeMode);
      this.subappActivityService.recordInvocationStarted({
        sessionId: ownerSessionId,
        toolId: resolved.config.id,
        toolName: tool,
        title: String(resolved.config.app?.name || resolved.config.titleKey || resolved.config.id),
        icon: String(resolved.config.app?.icon || 'fa-light fa-puzzle-piece'),
        toolCallId: String(context.toolCallId || '').trim(),
        presentation: presentationPolicy.activityPresentation,
      });
      this.enforceInputBudget(params, resolved.definition);
      const rpcParams = { ...params };
      delete rpcParams['presentUi'];
      const mapped = this.mapRpc(resolved.definition, rpcParams);
      let presentation: Record<string, unknown> | undefined;

      if (presentationPolicy.uiMode === 'window') {
        // Opening a detached host is asynchronous. Acquire the shared Runtime
        // first so the main renderer and the new window cannot both observe an
        // empty registry and spawn competing processes. The request channel
        // takes its own long-lived lease below; this temporary lease only spans
        // presentation startup and the first RPC.
        releasePresentationRuntimeLease = await acquireSubappRuntimePresentationLease(
          this.childToolProcessService,
          resolved.config.id,
        );
        presentation = await this.mainUiAutomationService.openChildApp({
          toolId: resolved.config.id,
          mode: 'window',
        });
        if (presentation['ok'] !== true) {
          this.subappActivityService.recordInvocationCompleted({
            sessionId: ownerSessionId,
            toolId: resolved.config.id,
            toolName: tool,
            toolCallId: String(context.toolCallId || '').trim(),
            state: 'failed',
            runtimeState: 'unknown',
            error: String(presentation['message'] || `Unable to open subapp: ${resolved.config.id}`),
          });
          return {
            ok: false,
            toolId: resolved.config.id,
            tool,
            error: String(presentation['message'] || `Unable to open subapp: ${resolved.config.id}`),
            presentation,
          };
        }
      }

      const result = await this.request(
        resolved.config.id,
        mapped.method,
        mapped.params,
        mapped.timeoutMs,
        resolved.definition.supportsCancellation === true,
        signal,
        ownerSessionId,
      );
      const response = this.enforceResponseBudget({
        ok: true,
        toolId: resolved.config.id,
        tool,
        result,
        ...(presentation ? { presentation } : {}),
      }, resolved.config.id, tool, resolved.definition);
      this.subappActivityService.recordInvocationCompleted({
        sessionId: ownerSessionId,
        toolId: resolved.config.id,
        toolName: tool,
        toolCallId: String(context.toolCallId || '').trim(),
        state: response['ok'] === true ? 'succeeded' : 'failed',
        runtimeState: 'ready',
        ...(response['ok'] === true ? {} : { error: String(response['error'] || 'Subapp result rejected') }),
      });
      return response;
    } catch (error) {
      const rpcError = error instanceof SubappRpcError
        ? error
        : new SubappRpcError(error instanceof Error ? error.message : String(error));
      const toolId = resolved?.config.id || requestedToolId;
      const response = {
        ok: false,
        ...(toolId ? { toolId } : {}),
        tool,
        error: rpcError.message,
        errorCode: rpcError.code,
        ...(rpcError.details !== undefined ? { details: rpcError.details } : {}),
      };
      if (resolved) {
        this.subappActivityService.recordInvocationCompleted({
          sessionId: ownerSessionId,
          toolId: resolved.config.id,
          toolName: tool,
          toolCallId: String(context.toolCallId || '').trim(),
          state: rpcError.code === 'SUBAPP_RPC_CANCELLED' ? 'cancelled' : 'failed',
          runtimeState: this.runtimeStateAfterError(resolved.config.id, rpcError),
          error: rpcError.message,
        });
      }
      return resolved
        ? this.enforceResponseBudget(response, resolved.config.id, tool, resolved.definition)
        : response;
    } finally {
      await releasePresentationRuntimeLease?.().catch(() => undefined);
    }
  }

  async releaseSession(sessionId: string): Promise<Record<string, unknown>> {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) {
      return { ok: false, error: 'Subapp Agent session release requires a session id' };
    }

    const releasedTools: string[] = [];
    const retainedTools: string[] = [];
    const cleanupErrors: Array<{ toolId: string; error: string }> = [];
    for (const [toolId, channel] of [...this.channels.entries()]) {
      if (!channel.sessionIds.delete(normalizedSessionId)) continue;
      if (channel.sessionIds.size > 0 || channel.hasUnscopedOwner) {
        retainedTools.push(toolId);
        continue;
      }

      const config = getChildToolConfig(toolId);
      const cleanup = config?.agent?.lifecycle?.sessionRelease;
      if (cleanup && channel.acquired) {
        try {
          await this.request(
            toolId,
            cleanup.method,
            { ...(cleanup.params || {}) },
            this.boundedNumber(cleanup.timeoutMs, 5000, 100, 30000),
            false,
            undefined,
            '',
            false,
          );
        } catch (error) {
          cleanupErrors.push({
            toolId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.closeChannel(channel, new SubappRpcError(
        `Subapp Agent session released: ${normalizedSessionId}`,
        'SUBAPP_SESSION_RELEASED',
        { toolId, sessionId: normalizedSessionId },
      ));
      await this.releaseChannel(channel);
      if (this.channels.get(toolId) === channel) this.channels.delete(toolId);
      releasedTools.push(toolId);
    }

    this.subappActivityService.releaseSession(
      normalizedSessionId,
      cleanupErrors.map(item => `${item.toolId}: ${item.error}`).join('; '),
    );

    return {
      ok: cleanupErrors.length === 0,
      sessionId: normalizedSessionId,
      releasedTools,
      retainedTools,
      ...(cleanupErrors.length ? { cleanupErrors } : {}),
    };
  }

  ngOnDestroy(): void {
    for (const channel of this.channels.values()) {
      this.closeChannel(channel, new SubappRpcError(
        'Subapp Agent bridge stopped',
        'SUBAPP_BRIDGE_STOPPED',
      ));
      if (channel.acquired) {
        void this.releaseChannel(channel);
      }
    }
    this.channels.clear();
  }

  private resolveAgentTool(requestedToolId: string, toolName: string): ResolvedAgentTool {
    if (!toolName) {
      throw new SubappRpcError('Subapp Agent tool name is required', 'SUBAPP_TOOL_REQUIRED');
    }
    const configs = requestedToolId
      ? [getChildToolConfig(requestedToolId)].filter((value): value is ChildToolConfig => Boolean(value))
      : Object.values(getChildToolConfigs());
    const matches = configs.flatMap(config => {
      const definition = config.agent?.tools.find(candidate => candidate.name === toolName);
      return definition ? [{ config, definition }] : [];
    });

    if (!matches.length) {
      throw new SubappRpcError(
        `Unknown installed subapp Agent tool: ${toolName}`,
        'SUBAPP_TOOL_NOT_FOUND',
        requestedToolId ? { toolId: requestedToolId, tool: toolName } : { tool: toolName },
      );
    }
    if (matches.length > 1) {
      throw new SubappRpcError(
        `Subapp Agent tool name is ambiguous: ${toolName}`,
        'SUBAPP_TOOL_AMBIGUOUS',
        { tool: toolName, toolIds: matches.map(match => match.config.id) },
      );
    }
    const resolved = matches[0];
    if (resolved.config.agent?.protocolVersion !== 1) {
      throw new SubappRpcError(
        `Unsupported subapp Agent protocol version: ${resolved.config.agent?.protocolVersion}`,
        'SUBAPP_AGENT_PROTOCOL_UNSUPPORTED',
        { toolId: resolved.config.id, protocolVersion: resolved.config.agent?.protocolVersion },
      );
    }
    if (resolved.config.agent.transport !== 'aily-child-rpc') {
      throw new SubappRpcError(
        `Unsupported subapp Agent transport: ${resolved.config.agent.transport}`,
        'SUBAPP_AGENT_TRANSPORT_UNSUPPORTED',
        { toolId: resolved.config.id, transport: resolved.config.agent.transport },
      );
    }
    return resolved;
  }

  private mapRpc(
    definition: ChildToolAgentDefinition,
    params: Record<string, unknown>,
  ): { method: string; params: Record<string, unknown>; timeoutMs: number } {
    const rpc = definition.rpc || {};
    let method = String(rpc.method || '');
    const nextParams = { ...params };

    if (!method && rpc.actionParam && rpc.methods) {
      const action = String(nextParams[rpc.actionParam] || '');
      method = String(rpc.methods[action] || '');
      if (!method) {
        throw new SubappRpcError(
          `Unsupported action for ${definition.name}: ${action || '(empty)'}`,
          'SUBAPP_TOOL_ACTION_UNSUPPORTED',
          { tool: definition.name, action, allowedActions: Object.keys(rpc.methods) },
        );
      }
      delete nextParams[rpc.actionParam];
    }
    if (!method) {
      throw new SubappRpcError(
        `Subapp Agent tool has no RPC mapping: ${definition.name}`,
        'SUBAPP_TOOL_RPC_MISSING',
      );
    }

    const defaultTimeoutMs = this.boundedNumber(definition.timeoutMs, 15_000, 1, 10 * 60_000);
    const maxTimeoutMs = this.boundedNumber(
      definition.maxTimeoutMs,
      Math.max(defaultTimeoutMs, 60_000),
      defaultTimeoutMs,
      10 * 60_000,
    );
    const operationTimeoutMs = Number(nextParams['timeoutMs']);
    const timeoutMs = Number.isFinite(operationTimeoutMs) && operationTimeoutMs > 0
      ? Math.min(maxTimeoutMs, Math.max(defaultTimeoutMs, Math.round(operationTimeoutMs) + 5_000))
      : defaultTimeoutMs;
    return { method, params: nextParams, timeoutMs };
  }

  private async request(
    toolId: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    supportsCancellation: boolean,
    signal?: AbortSignal,
    ownerSessionId = '',
    trackLease = true,
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw new SubappRpcError('Subapp Agent request was cancelled', 'SUBAPP_RPC_CANCELLED', { method });
    }
    const channel = this.ensureChannel(toolId);
    if (trackLease) {
      if (ownerSessionId) {
        channel.sessionIds.add(ownerSessionId);
      } else {
        channel.hasUnscopedOwner = true;
      }
    }
    const socket = await this.ensureSocket(channel);
    const id = `agent-${Date.now()}-${++channel.requestSeq}`;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = channel.pending.get(id);
        pending?.removeAbortListener?.();
        channel.pending.delete(id);
        if (supportsCancellation) this.sendCancellation(channel, socket, id, method);
        reject(new SubappRpcError(
          `Subapp Runtime request timed out after ${timeoutMs} ms`,
          'SUBAPP_RPC_TIMEOUT',
          { toolId, method, timeoutMs },
        ));
      }, timeoutMs);
      const pending: PendingRequest = { resolve, reject, timer };
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          channel.pending.delete(id);
          if (supportsCancellation) this.sendCancellation(channel, socket, id, method);
          reject(new SubappRpcError(
            'Subapp Agent request was cancelled',
            'SUBAPP_RPC_CANCELLED',
            { toolId, method },
          ));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        pending.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
      channel.pending.set(id, pending);
    });

    try {
      socket.send(JSON.stringify({
        id,
        method,
        params,
        context: {
          actor: 'agent',
          actorId: 'subapp-agent-host',
        },
      }));
    } catch (error) {
      const pending = channel.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pending.removeAbortListener?.();
        channel.pending.delete(id);
        pending.reject(new SubappRpcError(
          error instanceof Error ? error.message : String(error),
          'SUBAPP_RPC_SEND_FAILED',
          { toolId, method },
        ));
      }
    }
    return response;
  }

  private ensureChannel(toolId: string): SubappRpcChannel {
    let channel = this.channels.get(toolId);
    if (!channel) {
      channel = {
        toolId,
        socket: null,
        socketPromise: null,
        expectedSocketCloses: new Set(),
        hostInfo: null,
        acquired: false,
        releasePromise: null,
        requestSeq: 0,
        pending: new Map(),
        sessionIds: new Set(),
        hasUnscopedOwner: false,
      };
      this.channels.set(toolId, channel);
    }
    return channel;
  }

  private async ensureSocket(channel: SubappRpcChannel): Promise<WebSocket> {
    if (channel.socket?.readyState === WebSocket.OPEN) return channel.socket;
    if (channel.socketPromise) return channel.socketPromise;

    channel.socketPromise = this.openSocketWithRetry(channel);
    try {
      return await channel.socketPromise;
    } finally {
      channel.socketPromise = null;
    }
  }

  private async openSocketWithRetry(channel: SubappRpcChannel): Promise<WebSocket> {
    try {
      return await this.openSocket(channel);
    } catch (firstError) {
      await this.resetChannelForReconnect(channel);
      try {
        return await this.openSocket(channel);
      } catch (secondError) {
        if (secondError instanceof SubappRpcError) {
          throw new SubappRpcError(secondError.message, secondError.code, {
            ...this.record(secondError.details),
            reconnectAttempted: true,
            initialError: firstError instanceof Error ? firstError.message : String(firstError),
          });
        }
        throw secondError;
      }
    }
  }

  private async openSocket(channel: SubappRpcChannel): Promise<WebSocket> {
    if (channel.releasePromise) await channel.releasePromise;
    if (!channel.acquired) {
      channel.hostInfo = await this.childToolProcessService.acquire(channel.toolId);
      channel.acquired = true;
    }
    const wsUrl = channel.hostInfo?.wsUrl;
    if (!wsUrl) {
      channel.hostInfo = null;
      await this.releaseChannel(channel);
      throw new SubappRpcError(
        `Subapp Runtime did not provide a WebSocket endpoint: ${channel.toolId}`,
        'SUBAPP_RUNTIME_ENDPOINT_MISSING',
        { toolId: channel.toolId },
      );
    }

    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      let settled = false;
      let opened = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new SubappRpcError(
          `Timed out while connecting to subapp Runtime: ${channel.toolId}`,
          'SUBAPP_RUNTIME_CONNECT_TIMEOUT',
          { toolId: channel.toolId },
        ));
      }, 15_000);

      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        opened = true;
        channel.socket = socket;
        this.recordChannelRuntimeState(channel, 'ready');
        resolve(socket);
      });
      socket.addEventListener('message', event => this.handleMessage(channel, event));
      socket.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.close();
        reject(new SubappRpcError(
          `Failed to connect to subapp Runtime: ${channel.toolId}`,
          'SUBAPP_RUNTIME_CONNECT_FAILED',
          { toolId: channel.toolId },
        ));
      });
      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        if (!opened) return;
        const expected = channel.expectedSocketCloses.delete(socket);
        if (channel.socket === socket) channel.socket = null;
        channel.hostInfo = null;
        if (channel.acquired) void this.releaseChannel(channel);
        const closeError = new SubappRpcError(
          `Subapp Runtime connection closed: ${channel.toolId}`,
          'SUBAPP_RUNTIME_CLOSED',
          { toolId: channel.toolId },
        );
        this.rejectPending(channel, closeError);
        if (!expected) {
          this.recordChannelRuntimeState(channel, 'error', closeError.message);
        }
      });
    });
  }

  private sendCancellation(
    channel: SubappRpcChannel,
    socket: WebSocket,
    requestId: string,
    method: string,
  ): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({
        id: `cancel-${requestId}`,
        method: 'runtime.request.cancel',
        params: { requestId },
        context: {
          actor: 'agent',
          actorId: 'subapp-agent-host',
          cancelledMethod: method,
        },
      }));
    } catch {
      // The local request is already settled; the close handler will recover the channel.
    }
  }

  private async resetChannelForReconnect(channel: SubappRpcChannel): Promise<void> {
    const socket = channel.socket;
    channel.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      channel.expectedSocketCloses.add(socket);
      socket.close();
    }
    channel.hostInfo = null;
    await this.releaseChannel(channel);
  }

  private async releaseChannel(channel: SubappRpcChannel): Promise<void> {
    if (channel.releasePromise) {
      await channel.releasePromise;
      return;
    }
    if (!channel.acquired) return;
    channel.acquired = false;
    const releasePromise = this.childToolProcessService.release(channel.toolId);
    channel.releasePromise = releasePromise;
    try {
      await releasePromise;
    } finally {
      if (channel.releasePromise === releasePromise) channel.releasePromise = null;
    }
  }

  private handleMessage(channel: SubappRpcChannel, event: MessageEvent): void {
    let message: SubappRpcResponse;
    try {
      message = JSON.parse(String(event.data)) as SubappRpcResponse;
    } catch {
      return;
    }
    if (message.id === undefined || message.id === null) return;

    const id = String(message.id);
    const pending = channel.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    channel.pending.delete(id);

    if (message.ok === true) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new SubappRpcError(
      message.error || 'Subapp Runtime request failed',
      message.errorCode || 'SUBAPP_RPC_FAILED',
      message.details,
    ));
  }

  private closeChannel(channel: SubappRpcChannel, reason: SubappRpcError): void {
    const socket = channel.socket;
    channel.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      channel.expectedSocketCloses.add(socket);
      socket.close();
    }
    this.rejectPending(channel, reason);
  }

  private recordChannelRuntimeState(
    channel: SubappRpcChannel,
    state: SubappRuntimeState,
    error = '',
  ): void {
    for (const sessionId of channel.sessionIds) {
      this.subappActivityService.recordRuntimeState({
        sessionId,
        toolId: channel.toolId,
        state,
        ...(error ? { error } : {}),
      });
    }
  }

  private rejectPending(channel: SubappRpcChannel, reason: SubappRpcError): void {
    for (const request of channel.pending.values()) {
      clearTimeout(request.timer);
      request.removeAbortListener?.();
      request.reject(reason);
    }
    channel.pending.clear();
  }

  private enforceInputBudget(
    params: Record<string, unknown>,
    definition: ChildToolAgentDefinition,
  ): void {
    const maxInputBytes = this.boundedNumber(
      definition.maxInputBytes,
      1024 * 1024,
      1024,
      16 * 1024 * 1024,
    );
    const inputBytes = this.byteLength(params);
    if (inputBytes > maxInputBytes) {
      throw new SubappRpcError(
        `Subapp Agent input exceeded the ${maxInputBytes}-byte budget`,
        'SUBAPP_INPUT_TOO_LARGE',
        { tool: definition.name, inputBytes, maxInputBytes },
      );
    }
  }

  private enforceResponseBudget(
    response: Record<string, unknown>,
    toolId: string,
    tool: string,
    definition: ChildToolAgentDefinition,
  ): Record<string, unknown> {
    const maxOutputBytes = this.boundedNumber(
      definition.maxOutputBytes,
      48 * 1024,
      1024,
      1024 * 1024,
    );
    const serializedBytes = this.byteLength(response);
    if (serializedBytes <= maxOutputBytes) return response;

    const result = this.record(response['result']);
    return {
      ok: false,
      toolId,
      tool,
      error: `Subapp Runtime result exceeded the ${maxOutputBytes}-byte tool budget`,
      errorCode: 'SUBAPP_RESULT_TOO_LARGE',
      details: {
        serializedBytes,
        maxOutputBytes,
        evidence: result['evidence'],
      },
    };
  }

  private record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private runtimeStateAfterError(toolId: string, error: SubappRpcError): SubappRuntimeState {
    const channel = this.channels.get(toolId);
    if (channel?.socket?.readyState === WebSocket.OPEN) return 'ready';
    if (
      error.code.startsWith('SUBAPP_RUNTIME_')
      || error.code === 'SUBAPP_RPC_CONNECT_FAILED'
      || error.code === 'SUBAPP_RPC_CLOSED'
      || error.code === 'SUBAPP_RPC_SEND_FAILED'
    ) {
      return 'error';
    }
    return 'unknown';
  }

  private boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
  }

  private byteLength(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }
}
