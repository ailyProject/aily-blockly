import type { ChildAppHostController, ChildAppHostRegistryService } from '../../services/integrations/subapps/child-app-host-registry.service';
import { subappRegisteredAgentError, type SubappRegisteredAgentRequest } from '../../services/integrations/subapps/models/subapp-registered-agent';

export interface WebToolLifecycleHost {
  readonly agentRequest?: SubappRegisteredAgentRequest;
  close(): Promise<void>;
  snapshot(): unknown;
}

/** Register the original close operation and an optional borrowed Agent port.
 * The existing registry owns discovery/control; the product owns cleanup.
 * An unconfirmed close keeps this exact registration available for retry,
 * including when Angular has already destroyed the presentation. */
export function registerWebToolLifecycle(
  registry: Pick<ChildAppHostRegistryService, 'register'>,
  identity: Readonly<{ toolId: string; instanceId: string }>,
  host: WebToolLifecycleHost,
) {
  const closeHost = host.close.bind(host), snapshotHost = host.snapshot.bind(host);
  const agent = host.agentRequest?.bind(host), agentLifetime = new AbortController();
  let closed = false, closing: Promise<Record<string, unknown>> | null = null;
  let unregister: () => void;
  const status = () => ({ status: closed ? 'closed' : 'web', closing: !closed && closing !== null,
    product: snapshotHost(), retainedCleanupResponsibility: !closed,
    WorkerPhysicalExitConfirmed: false, NodeBusinessACK: false, MainBusinessACK: false });

  function close(): Promise<Record<string, unknown>> {
    if (closed) return Promise.resolve({ ok: true, closeSettled: true, ...status() });
    if (closing) return closing;
    agentLifetime.abort(subappRegisteredAgentError('SUBAPP_WEB_REVOKED', 'The original Web presentation is closing.'));
    const task = Promise.resolve().then(closeHost).then(() => {
      // Never retire the registration merely because its DOM/port disappeared.
      unregister(); closed = true;
      return { ok: true, closeSettled: true, ...status() };
    }).catch(error => ({ ok: false, closeSettled: false,
      message: error instanceof Error ? error.message : String(error), ...status() }))
      .finally(() => { if (closing === task) closing = null; });
    closing = task;
    return task;
  }

  const unsupported = async () => ({ ok: false, message: 'This Web presentation supports status and close lifecycle actions only.' });
  const controller: ChildAppHostController = { status, close,
    ...(agent ? { agentRequest: (async (method, params, signal, timeoutMs, context) => {
      const current = AbortSignal.any([signal, agentLifetime.signal]);
      const check = () => {
        if (agentLifetime.signal.aborted || closed) throw subappRegisteredAgentError('SUBAPP_WEB_REVOKED', 'The original Web presentation was revoked.');
        if (current.aborted) throw subappRegisteredAgentError('SUBAPP_RPC_CANCELLED', 'The Web Agent request was cancelled.');
      };
      check();
      const value = await agent(method, params, current, timeoutMs, context);
      check(); return value;
    }) satisfies SubappRegisteredAgentRequest } : {}),
    prepareUpdate: unsupported, restart: unsupported, detach: unsupported, embed: unsupported };
  unregister = registry.register(identity.toolId, controller, {
    instanceId: identity.instanceId, surface: 'default', primary: true,
  });
  return Object.freeze({ close, snapshot: status });
}
