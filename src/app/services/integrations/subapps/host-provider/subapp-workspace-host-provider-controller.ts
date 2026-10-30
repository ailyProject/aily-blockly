import type {
  SubappHostProviderProductOpenContext,
  SubappHostProviderProductSession,
} from './subapp-host-provider-product-registry.service';

import type { SubappHostProviderRecord } from './subapp-host-provider-dispatcher';

export interface WorkspaceProviderRuntime {
  toolId: string;
  streamId: string;
  running: boolean;
  hostInfo?: { packagePath?: string } | null;
  messagePort?: { maxMessageBytes?: number } | null;
}

export interface WorkspaceProviderControllerPort {
  bindMessageController(input: { toolId: string; streamId: string; bindingId: string }): Promise<{
    success: boolean;
    negotiationRequest?: SubappHostProviderRecord | null;
  }>;

  unbindMessageController(input: { toolId: string; streamId: string; bindingId: string }): Promise<unknown>;

  sendMessage(input: {
    toolId: string; streamId: string; bindingId: string; message: SubappHostProviderRecord;
  }): Promise<{ success: boolean }>;
}

interface Binding {
  readonly runtime: WorkspaceProviderRuntime;
  readonly scope: string | null;
  readonly bindingId: string;
  readonly pending: SubappHostProviderRecord[];

  overflowed: boolean;
  closing: boolean;
  sessionClosed: boolean;
  cleanup: Promise<void> | null;
  initialized: Promise<void>;
  session: SubappHostProviderProductSession | null;

  listener: ((message: SubappHostProviderRecord) => void) | null;
}

/** A passive, single workspace callback owner. It never acquires or starts a Runtime. */
export class SubappWorkspaceHostProviderController {
  private readonly bindings = new Map<string, Binding>();
  private runtimes: readonly WorkspaceProviderRuntime[] = [];
  private scope: string | null = null;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private sequence = 0;

  constructor(private readonly options: {
    port: WorkspaceProviderControllerPort;

    registry: {
      hasRegistration(toolId: string): boolean;
      open(context: SubappHostProviderProductOpenContext): Promise<SubappHostProviderProductSession | null>;
    };

    instanceId: string;

    onError?: (toolId: string) => void;
  }) {}

  update(scope: string | null, runtimes: readonly WorkspaceProviderRuntime[]): Promise<void> {
    if (this.closed) return this.tail;

    this.scope = scope;
    this.runtimes = runtimes.map(runtime => ({ ...runtime }));
    this.tail = this.tail.catch(() => undefined).then(() => this.reconcile());
    return this.tail;
  }

  receive(event: { toolId: string; streamId: string; message: SubappHostProviderRecord }): void {
    const binding = this.bindings.get(event.toolId);

    if (!binding || binding.runtime.streamId !== event.streamId || !this.matches(binding)) return;

    if (binding.listener) binding.listener(event.message);
    else if (binding.pending.length < 8) binding.pending.push(event.message);
    else { binding.overflowed = true; binding.pending.length = 0; }
  }

  snapshot(): readonly { toolId: string; streamId: string; scope: string | null; ready: boolean }[] {
    return [...this.bindings.values()].map(binding => ({
      toolId: binding.runtime.toolId, streamId: binding.runtime.streamId,
      scope: binding.scope, ready: binding.session !== null && this.matches(binding),
    }));
  }

  close(): Promise<void> {
    this.closed = true;
    for (const binding of this.bindings.values()) binding.closing = true;
    // Each binding joins its own opening/cleanup. One retained product must
    // not postpone another tool's independently confirmed release.
    const cleanup = this.releaseAll([...this.bindings.values()]);
    this.tail = this.tail.catch(() => undefined).then(async () => {
      const failures = await cleanup;
      if (failures.length) throw new AggregateError(failures, 'Workspace Provider cleanup remains unconfirmed.');
    });

    return this.tail;
  }

  private desired(): readonly WorkspaceProviderRuntime[] {
    return this.closed ? [] : this.runtimes.filter(runtime => runtime.running
      && runtime.streamId && runtime.messagePort
      && this.options.registry.hasRegistration(runtime.toolId));
  }

  private matches(binding: Binding): boolean {
    return !binding.closing && !binding.overflowed && binding.scope === this.scope && this.desired().some(runtime =>
      runtime.toolId === binding.runtime.toolId && runtime.streamId === binding.runtime.streamId);
  }

  private async reconcile(): Promise<void> {
    const failures = await this.releaseAll([...this.bindings.values()].filter(binding => !this.matches(binding)));
    for (const runtime of this.desired()) {
      if (this.closed) break;
      if (this.bindings.has(runtime.toolId)) continue;
      let initialized!: () => void;
      const binding: Binding = {
        runtime, scope: this.scope, bindingId: `${this.options.instanceId}:${++this.sequence}`,
        pending: [], overflowed: false, closing: false, sessionClosed: false, cleanup: null, session: null, listener: null,
        initialized: new Promise<void>(resolve => { initialized = resolve; }),
      };

      this.bindings.set(runtime.toolId, binding);

      try {
        const result = await this.options.port.bindMessageController({
          toolId: runtime.toolId, streamId: runtime.streamId, bindingId: binding.bindingId,
        });

        if (!result.success) throw new Error('Host Provider controller binding was rejected.');
        if (result.negotiationRequest) binding.pending.push(result.negotiationRequest);
        if (this.matches(binding)) binding.session = await this.options.registry.open({
          toolId: runtime.toolId, hostInstanceId: this.options.instanceId,
          ...(runtime.hostInfo?.packagePath ? { runtimePackagePath: runtime.hostInfo.packagePath } : {}),
          transport: {
            onMessage: listener => {
              binding.listener = listener;

              queueMicrotask(() => {
                if (binding.listener !== listener || !this.matches(binding)) {
                  binding.pending.length = 0;

                  return;
                }

                for (const message of binding.pending.splice(0)) listener(message);
              });

              return () => { if (binding.listener === listener) binding.listener = null; };
            },
            send: async message => {
              if (this.bindings.get(runtime.toolId) !== binding) throw new Error('Workspace Provider binding is retired.');
              const sent = await this.options.port.sendMessage({
                toolId: runtime.toolId, streamId: runtime.streamId,
                bindingId: binding.bindingId, message,
              });

              if (!sent.success) throw new Error('Host Provider controller transport was rejected.');
            },
          },
        });
      } catch {
        this.options.onError?.(runtime.toolId);
      } finally { initialized(); }
      if (!binding.session || !this.matches(binding)) {
        try { await this.release(binding); } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Workspace Provider cleanup remains unconfirmed.');
  }

  private async releaseAll(bindings: readonly Binding[]): Promise<unknown[]> {
    const results = await Promise.allSettled(bindings.map(binding => this.release(binding)));
    return results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  }

  private release(binding: Binding): Promise<void> {
    if (this.bindings.get(binding.runtime.toolId) !== binding) return Promise.resolve();
    if (binding.cleanup) return binding.cleanup;
    binding.closing = true;
    binding.listener = null;
    binding.pending.length = 0;
    const cleanup = Promise.resolve().then(async () => {
      await binding.initialized;
      if (!binding.sessionClosed) {
        await binding.session?.close();
        binding.sessionClosed = true;
      }
      const result = await this.options.port.unbindMessageController({
        toolId: binding.runtime.toolId, streamId: binding.runtime.streamId,
        bindingId: binding.bindingId,
      });
      const ack = result && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, unknown> : null;
      const originalBindingAbsent = ack?.['success'] === false
        && typeof ack['reason'] === 'string'
        && ['not-found', 'stale-session', 'stale-binding'].includes(ack['reason']);
      if (ack?.['success'] !== true && !originalBindingAbsent) {
        throw new Error('Workspace Provider unbind remains unconfirmed.');
      }
      if (this.bindings.get(binding.runtime.toolId) === binding) this.bindings.delete(binding.runtime.toolId);
    }).catch(error => { this.options.onError?.(binding.runtime.toolId); throw error; })
      .finally(() => { if (binding.cleanup === cleanup) binding.cleanup = null; });
    binding.cleanup = cleanup;
    return cleanup;
  }
}
