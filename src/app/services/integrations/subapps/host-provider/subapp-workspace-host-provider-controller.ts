import type {
  SubappHostProviderProductOpenContext,
  SubappHostProviderProductSession,
} from './subapp-host-provider-product-registry.service';
import type { SubappHostProviderRecord } from './subapp-host-provider-dispatcher';

export interface WorkspaceProviderRuntime {
  toolId: string;
  streamId: string;
  running: boolean;
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
    this.tail = this.tail.then(() => this.reconcile());
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
    this.tail = this.tail.then(async () => {
      for (const binding of [...this.bindings.values()]) await this.release(binding);
    });
    return this.tail;
  }

  private desired(): readonly WorkspaceProviderRuntime[] {
    return this.closed ? [] : this.runtimes.filter(runtime => runtime.running
      && runtime.streamId && runtime.messagePort
      && this.options.registry.hasRegistration(runtime.toolId));
  }

  private matches(binding: Binding): boolean {
    return !binding.overflowed && binding.scope === this.scope && this.desired().some(runtime =>
      runtime.toolId === binding.runtime.toolId && runtime.streamId === binding.runtime.streamId);
  }

  private async reconcile(): Promise<void> {
    for (const binding of [...this.bindings.values()]) {
      if (!this.matches(binding)) await this.release(binding);
    }
    for (const runtime of this.desired()) {
      if (this.bindings.has(runtime.toolId)) continue;
      const binding: Binding = {
        runtime, scope: this.scope, bindingId: `${this.options.instanceId}:${++this.sequence}`,
        pending: [], overflowed: false, session: null, listener: null,
      };
      this.bindings.set(runtime.toolId, binding);
      try {
        const result = await this.options.port.bindMessageController({
          toolId: runtime.toolId, streamId: runtime.streamId, bindingId: binding.bindingId,
        });
        if (!result.success) throw new Error('Host Provider controller binding was rejected.');
        if (result.negotiationRequest) binding.pending.push(result.negotiationRequest);
        if (!this.matches(binding)) { await this.release(binding); continue; }
        binding.session = await this.options.registry.open({
          toolId: runtime.toolId, hostInstanceId: this.options.instanceId,
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
              const sent = await this.options.port.sendMessage({
                toolId: runtime.toolId, streamId: runtime.streamId,
                bindingId: binding.bindingId, message,
              });
              if (!sent.success) throw new Error('Host Provider controller transport was rejected.');
            },
          },
        });
        if (!binding.session || !this.matches(binding)) await this.release(binding);
      } catch {
        await this.release(binding);
        this.options.onError?.(runtime.toolId);
      }
    }
  }

  private async release(binding: Binding): Promise<void> {
    if (this.bindings.get(binding.runtime.toolId) !== binding) return;
    try { await binding.session?.close(); }
    catch { this.options.onError?.(binding.runtime.toolId); }
    finally {
      binding.listener = null;
      binding.pending.length = 0;
      this.bindings.delete(binding.runtime.toolId);
      try {
        await this.options.port.unbindMessageController({
          toolId: binding.runtime.toolId, streamId: binding.runtime.streamId,
          bindingId: binding.bindingId,
        });
      } catch { this.options.onError?.(binding.runtime.toolId); }
    }
  }
}
