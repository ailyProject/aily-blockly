import { Inject, Injectable, OnDestroy } from '@angular/core';

import {
  ChildToolAgentDefinition,
  ChildToolAgentLifecycleRequestConfig,
  ChildToolConfig,
  getChildToolConfig,
  getChildToolConfigs,
} from '../../../configs/tool.config';
import { ChildToolHostInfo, ChildToolProcessService } from './child-tool-process.service';
import {
  SUBAPP_AUTOMATION_PORT,
  type SubappAutomationPort,
} from './ports/subapp-automation.port';
import {
  SubappActivityService,
  type SubappRuntimeState,
} from './subapp-activity.service';
import { resolveSubappAgentPresentation } from './models/subapp-agent-presentation';
import { acquireSubappRuntimePresentationLease } from './models/subapp-runtime-presentation-lease';
import { AILY_CODER_EDITOR_SUBAPP_ID } from '../../../configs/required-subapp.config';
import { SubappOwnerRequests } from './models/subapp-owner-requests';
import { SubappAgentOwnerLeases } from './models/subapp-agent-owner-leases';
import { sendSubappLifecycleRequest } from './models/subapp-lifecycle-request';
import { SubappOwnerGuard } from './models/subapp-owner-guard';
import { invokeNativeSubappAgent } from './models/subapp-native-agent';

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
  lastWsUrl: string;
  acquired: boolean;
  releasePromise: Promise<void> | null;
  lifecycleTail: Promise<unknown>;
  pendingOwnerReleases: number;
  disposed: boolean;
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
  ownerLeaseId?: string;
  turnId?: string;
  toolCallId?: string;
  workspaceRoot?: string;
  developmentMode?: 'blockly' | 'coder';
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
  private readonly ownerRequests = new SubappOwnerRequests();
  private readonly ownerGuard = new SubappOwnerGuard();
  private readonly ownerLeases = new SubappAgentOwnerLeases(lease => this.releaseSession(lease.ownerLeaseId, lease.sessionId));

  constructor(
    private readonly childToolProcessService: ChildToolProcessService,
    @Inject(SUBAPP_AUTOMATION_PORT)
    private readonly automation: SubappAutomationPort,
    private readonly subappActivityService: SubappActivityService,
  ) {}

  async execute(
    input: Record<string, unknown> = {},
    signal?: AbortSignal,
    context: SubappAgentExecutionContext = {},
  ): Promise<Record<string, unknown>> {
    const requestedToolId = String(input['toolId'] || '');
    const tool = String(input['tool'] || '');
    const activitySessionId = String(context.sessionId || '').trim();
    const ownerSessionId = String(context.ownerLeaseId || activitySessionId).trim();
    const invocation = this.ownerRequests.start(ownerSessionId, signal, String(context.toolCallId || ''));
    signal = invocation.signal;
    let resolved: ResolvedAgentTool | null = null;
    let nativeCleanupError: string | undefined;
    let releasePresentationRuntimeLease: (() => Promise<void>) | null = null;

    try {
      if (context.ownerLeaseId) this.ownerLeases.require(ownerSessionId, activitySessionId, context.toolCallId);
      this.throwIfCancelled(signal);
      resolved = this.resolveAgentTool(requestedToolId, tool);
      const nativeBatch = resolved.config.runtime?.headless === true;
      if (nativeBatch && !context.ownerLeaseId) throw new SubappRpcError('A live Agent owner lease is required for native batch tools.', 'SUBAPP_SESSION_REQUIRED');
      if (nativeBatch) invocation.waitForCleanup();
      const params = this.record(input['params']);
      const hasExplicitPresentation = Object.prototype.hasOwnProperty.call(params, 'presentUi');
      const activeMode = (!nativeBatch || resolved.config.runtime?.observer) && !hasExplicitPresentation
        && resolved.config.app?.extension !== true
        && resolved.definition.presentation
        && await this.automation.isChildAppWindowOpen(resolved.config.id)
        ? 'window' as const
        : undefined;
      this.throwIfCancelled(signal);
      const presentationPolicy = (nativeBatch && !resolved.config.runtime?.observer) || resolved.config.app?.extension === true
        ? { uiMode: 'none' as const, activityPresentation: undefined }
        : resolveSubappAgentPresentation(params, resolved.definition, activeMode);
      this.subappActivityService.recordInvocationStarted({
        sessionId: activitySessionId,
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
        releasePresentationRuntimeLease = nativeBatch ? null : await acquireSubappRuntimePresentationLease(
          this.childToolProcessService,
          resolved.config.id,
        );
        this.throwIfCancelled(signal);
        presentation = await this.automation.openChildApp({
          toolId: resolved.config.id,
          mode: 'window',
        });
        if (presentation['ok'] !== true) {
          this.subappActivityService.recordInvocationCompleted({
            sessionId: activitySessionId,
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

      const result = nativeBatch
        ? await invokeNativeSubappAgent(resolved.config.id, mapped.method, mapped.params, mapped.timeoutMs, this.ownerGuard, ownerSessionId, signal,
          resolved.config.runtime?.observer ? { sessionId: activitySessionId } : undefined)
        : await this.request(
        resolved.config.id,
        mapped.method,
        mapped.params,
        mapped.timeoutMs,
        resolved.definition.supportsCancellation === true,
        signal,
        ownerSessionId,
        context,
      );
      const response = this.enforceResponseBudget({
        ok: true,
        toolId: resolved.config.id,
        tool,
        result,
        ...(presentation ? { presentation } : {}),
      }, resolved.config.id, tool, resolved.definition);
      const nativeOutcome = nativeBatch ? (result as { outcome?: string } | null)?.outcome : undefined;
      this.subappActivityService.recordInvocationCompleted({
        sessionId: activitySessionId,
        toolId: resolved.config.id,
        toolName: tool,
        toolCallId: String(context.toolCallId || '').trim(),
        state: nativeOutcome === 'cancelled' ? 'cancelled'
          : ['failed', 'error'].includes(nativeOutcome || '') ? 'failed'
          : response['ok'] === true ? 'succeeded' : 'failed',
        runtimeState: nativeBatch ? 'stopped' : 'ready',
        ...(response['ok'] === true ? {} : { error: String(response['error'] || 'Subapp result rejected') }),
      });
      return response;
    } catch (error) {
      const rpcError = error instanceof SubappRpcError
        ? error
        : new SubappRpcError(error instanceof Error ? error.message : String(error),
          (error as { code?: string })?.code || 'SUBAPP_RPC_FAILED', (error as { details?: unknown })?.details);
      if (resolved?.config.runtime?.headless && /CLEANUP|STOP_UNCONFIRMED/.test(rpcError.code)) nativeCleanupError = rpcError.message;
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
          sessionId: activitySessionId,
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
      invocation.finish(nativeCleanupError);
      await releasePresentationRuntimeLease?.().catch(() => undefined);
    }
  }

  /** Host dependency installation uses the same Runtime and mutation lock as library installs. */
  async materializeCoderProjectLibraries(workspaceRoot: string): Promise<void> {
    const sessionId = `coder-dependencies-${Date.now()}-${Math.random()}`;
    try {
      const result = await this.request(
        AILY_CODER_EDITOR_SUBAPP_ID,
        'coder.library.materialize',
        {},
        300000,
        true,
        undefined,
        sessionId,
        { workspaceRoot, developmentMode: 'coder' },
      ) as { ok?: boolean; ready?: boolean; sourceReady?: boolean; dependencyIssues?: Array<{ name: string; constraint?: string; requiredBy: string; reason: string }> };
      // Opening/installing a project prepares sources before its SDK may exist.
      // Missing Arduino dependencies must remain repairable from that project;
      // library install/search expose the separate full readiness report.
      if (result?.ok !== true || (result.sourceReady !== true && result.ready !== true)) {
        if (result?.dependencyIssues?.length) {
          throw new SubappRpcError('Coder 库依赖尚未完整：' + result.dependencyIssues.map(issue =>
            `${issue.requiredBy} → ${issue.name}${issue.constraint ? ` (${issue.constraint})` : ''}: ${issue.reason}`).join('; '),
          'CODER_LIBRARY_DEPENDENCIES_INCOMPLETE', { dependencyIssues: result.dependencyIssues });
        }
        throw new Error('Coder dependency library sources are not ready');
      }
    } catch (error) {
      if (error instanceof SubappRpcError && error.code === 'SUBAPP_TOOL_METHOD_NOT_FOUND') {
        throw new SubappRpcError(
          '当前运行的 Aily Coder 编辑器版本不支持依赖库准备。请更新 Aily Coder 编辑器；如果已更新，请保存工程并重新启动 Aily Coder 后重试。\n' + error.message,
          'CODER_RUNTIME_UPDATE_REQUIRED',
          error.details,
        );
      }
      throw error;
    } finally {
      await this.releaseSession(sessionId);
    }
  }

  async manageOwnerLease(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = String(input['action'] || '');
    const ownerLeaseId = String(input['ownerLeaseId'] || '');
    const sessionId = String(input['sessionId'] || '').trim();
    try {
      if (action === 'release') return await this.ownerLeases.release(ownerLeaseId, sessionId);
      if (action === 'cancel') {
        const requestId = String(input['requestId'] || '');
        this.ownerLeases.cancel(ownerLeaseId, sessionId, requestId);
        this.ownerRequests.cancel(ownerLeaseId, requestId);
        return { ok: true, cancelled: true };
      }
      if (action !== 'acquire' && action !== 'renew') throw new SubappRpcError('Unknown owner lease action', 'SUBAPP_OWNER_ACTION_INVALID');
      const lease = action === 'acquire' ? this.ownerLeases.acquire(sessionId) : this.ownerLeases.renew(ownerLeaseId, sessionId);
      return { ok: true, ...lease, ttlMs: this.ownerLeases.ttlMs, heartbeatMs: this.ownerLeases.heartbeatMs };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error),
        errorCode: (error as { code?: string })?.code || 'SUBAPP_OWNER_FAILED' };
    }
  }

  async releaseSession(sessionId: string, activitySessionId = sessionId): Promise<Record<string, unknown>> {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) {
      return { ok: false, error: 'Subapp Agent session release requires a session id' };
    }

    const releasedTools: string[] = [];
    const retainedTools: string[] = [];
    const cleanupErrors: Array<{ toolId: string; error: string }> = [];
    const pendingInvocations = this.ownerRequests.release(normalizedSessionId);
    const cleanups: Promise<unknown>[] = [];
    for (const [toolId, channel] of [...this.channels.entries()]) {
      if (!channel.sessionIds.delete(normalizedSessionId)) continue;
      channel.pendingOwnerReleases++;
      // Serialize lifecycle callbacks, not normal RPC calls. A new owner may
      // register during cleanup, but its work waits until cleanup has settled.
      const cleanup = channel.lifecycleTail.then(async () => {
        await channel.socketPromise?.catch(() => undefined);
        const lifecycle = getChildToolConfig(toolId)?.agent?.lifecycle;
        const notify = async (request: ChildToolAgentLifecycleRequestConfig | undefined, owner: string) => {
          if (!request) return;
          try {
            if (owner && await this.ownerGuard.release(toolId, owner)) return;
            const timeoutMs = this.boundedNumber(request.timeoutMs, 5000, 100, 30000);
            if (channel.socket?.readyState === WebSocket.OPEN) {
              await this.request(toolId, request.method, { ...(request.params || {}) },
                timeoutMs, false, undefined, owner, {}, false);
            } else if (channel.lastWsUrl) {
              // Other windows may still own this Runtime after our socket was
              // lost. Cleanup may reconnect to that endpoint, but never spawn.
              await sendSubappLifecycleRequest(channel.lastWsUrl, request.method, { ...(request.params || {}) },
                { actor: 'agent', actorId: 'subapp-agent-host', ...(owner ? { sessionId: owner } : {}) }, timeoutMs);
            }
          } catch (error) {
            cleanupErrors.push({ toolId, error: error instanceof Error ? error.message : String(error) });
          }
        };
        await notify(lifecycle?.ownerRelease, normalizedSessionId);
        channel.pendingOwnerReleases--;
        if (channel.pendingOwnerReleases) {
          retainedTools.push(toolId);
          return;
        }
        if (!channel.sessionIds.size && !channel.hasUnscopedOwner) await notify(lifecycle?.sessionRelease, '');
        if (channel.sessionIds.size || channel.hasUnscopedOwner) {
          retainedTools.push(toolId);
          return;
        }
        this.closeChannel(channel, new SubappRpcError(
          `Subapp Agent session released: ${normalizedSessionId}`, 'SUBAPP_SESSION_RELEASED',
          { toolId, sessionId: normalizedSessionId },
        ));
        await this.releaseChannel(channel);
        // A new request may have registered while process release was awaiting.
        if (!channel.sessionIds.size && !channel.hasUnscopedOwner && this.channels.get(toolId) === channel) {
          this.channels.delete(toolId);
        }
        releasedTools.push(toolId);
      });
      channel.lifecycleTail = cleanup.catch(() => undefined);
      cleanups.push(cleanup.catch(error => {
        cleanupErrors.push({ toolId, error: error instanceof Error ? error.message : String(error) });
      }));
    }
    await Promise.all([...cleanups, pendingInvocations.then(errors => {
      cleanupErrors.push(...errors.map(error => ({ toolId: 'native-batch', error })));
    })]);

    if (!this.ownerLeases.hasSession(activitySessionId)) {
      this.subappActivityService.releaseSession(
        activitySessionId, cleanupErrors.map(item => `${item.toolId}: ${item.error}`).join('; '),
      );
    }

    return {
      ok: cleanupErrors.length === 0,
      sessionId: normalizedSessionId,
      releasedTools,
      retainedTools,
      ...(cleanupErrors.length ? { cleanupErrors } : {}),
    };
  }

  ngOnDestroy(): void {
    void this.ownerGuard.close().catch(error => console.warn('[subapp-owner] Guard disposal failed', error));
    this.ownerLeases.stop();
    this.ownerRequests.stop();
    for (const channel of this.channels.values()) {
      channel.disposed = true;
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

  private throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new SubappRpcError('Subapp Agent request was cancelled', 'SUBAPP_RPC_CANCELLED');
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
    executionContext: SubappAgentExecutionContext = {},
    trackLease = true,
  ): Promise<unknown> {
    const requestScope = trackLease ? this.ownerRequests.start(ownerSessionId, signal) : null;
    signal = requestScope?.signal || signal;
    try {
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
        await channel.lifecycleTail;
      }
      if (signal?.aborted) throw new SubappRpcError('Subapp Agent request was cancelled', 'SUBAPP_RPC_CANCELLED');
      // Lifecycle callbacks must never restart a dead Runtime merely to clean it.
      const socket = trackLease ? await this.ensureSocket(channel) : channel.socket;
      const ownerContext = trackLease && !signal?.aborted ? await this.ownerGuard.track(toolId, ownerSessionId) : {};
      if (signal?.aborted) throw new SubappRpcError('Subapp Agent request was cancelled', 'SUBAPP_RPC_CANCELLED');
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new SubappRpcError('Subapp Runtime connection is not open', 'SUBAPP_RUNTIME_CLOSED');
      }
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
            ...ownerContext,
            ...(ownerSessionId ? { sessionId: ownerSessionId } : {}),
            ...(String(executionContext.toolCallId || '').trim()
              ? { toolCallId: String(executionContext.toolCallId).trim() }
              : {}),
            ...(String(executionContext.workspaceRoot || '').trim()
              ? { workspaceRoot: String(executionContext.workspaceRoot).trim() }
              : {}),
            ...(executionContext.developmentMode === 'coder' || executionContext.developmentMode === 'blockly'
              ? { developmentMode: executionContext.developmentMode }
              : {}),
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
      return await response;
    } finally {
      requestScope?.finish();
    }
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
        lastWsUrl: '',
        acquired: false,
        releasePromise: null,
        lifecycleTail: Promise.resolve(),
        pendingOwnerReleases: 0,
        disposed: false,
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
    if (channel.disposed) throw new SubappRpcError('Subapp Agent bridge stopped', 'SUBAPP_BRIDGE_STOPPED');
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
      if (channel.disposed) throw firstError;
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
    if (channel.disposed) {
      await this.releaseChannel(channel);
      throw new SubappRpcError('Subapp Agent bridge stopped', 'SUBAPP_BRIDGE_STOPPED');
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
    channel.lastWsUrl = wsUrl;

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
        if (channel.disposed) {
          socket.close();
          reject(new SubappRpcError('Subapp Agent bridge stopped', 'SUBAPP_BRIDGE_STOPPED'));
          return;
        }
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
        if (!opened) {
          if (!settled) {
            settled = true;
            reject(new SubappRpcError('Subapp Runtime closed before connecting', 'SUBAPP_RUNTIME_CLOSED'));
          }
          return;
        }
        const expected = channel.expectedSocketCloses.delete(socket);
        if (channel.socket !== socket) return;
        channel.socket = null;
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
        sessionId: this.ownerLeases.sessionId(sessionId),
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
