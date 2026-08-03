export const SUBAPP_HOST_PROVIDER_TRANSPORT_VERSION = 1 as const;

export const SUBAPP_HOST_PROVIDER_MESSAGE_TYPES = Object.freeze({
  negotiationRequest: 'aily-subapp-host-provider.negotiation.request',
  catalog: 'aily-subapp-host-provider.catalog',
  invocation: 'aily-subapp-host-provider.invocation',
  result: 'aily-subapp-host-provider.result',
  event: 'aily-subapp-host-provider.event',
  cancel: 'aily-subapp-host-provider.cancel',
  artifactChunkRequest: 'aily-subapp-host-provider.artifact-chunk.request',
  artifactChunkResult: 'aily-subapp-host-provider.artifact-chunk.result',
} as const);

export type SubappHostProviderRecord = Record<string, unknown>;

export interface SubappHostProviderTransport {
  send(message: SubappHostProviderRecord): void | Promise<void>;
  onMessage(
    listener: (message: SubappHostProviderRecord) => void,
  ): () => void;
}

export interface SubappHostProviderInvocationOutcome {
  result: SubappHostProviderRecord;
  subscriptionIds?: readonly string[];
}

export type SubappHostProviderFailureCode =
  | 'capability-unavailable'
  | 'cancelled'
  | 'deadline-exceeded'
  | 'operation-failed';

export interface SubappHostProviderInvocationContext {
  readonly signal: AbortSignal;
  publishEvent(
    subscriptionId: string,
    event: SubappHostProviderRecord,
  ): Promise<boolean>;
}

/**
 * A framework- and product-neutral adapter contract. Domain packages validate
 * payloads and construct results; the dispatcher only owns routing/lifecycle.
 */
export interface SubappHostProviderAdapter {
  readonly provider: string;
  readonly protocolVersions: readonly number[];
  readonly capabilities: readonly string[];
  handleInvocation(
    invocation: SubappHostProviderRecord,
    context: SubappHostProviderInvocationContext,
  ): Promise<SubappHostProviderInvocationOutcome>;
  createFailureResult(
    invocation: SubappHostProviderRecord,
    code: SubappHostProviderFailureCode,
  ): SubappHostProviderRecord;
  readArtifactChunk?(
    request: SubappHostProviderRecord,
    signal: AbortSignal,
  ): Promise<SubappHostProviderRecord>;
  createArtifactChunkFailureResult?(
    request: SubappHostProviderRecord,
    code: Exclude<SubappHostProviderFailureCode, 'capability-unavailable'>,
  ): SubappHostProviderRecord;
  close?(): void | Promise<void>;
}

export interface SubappHostProviderDispatcherOptions {
  hostInstanceId: string;
  adapters: readonly SubappHostProviderAdapter[];
  now?: () => number;
  maxMessageBytes?: number;
  maxActiveInvocations?: number;
  maxActiveArtifactTransfers?: number;
}

interface ActiveInvocation {
  adapter: SubappHostProviderAdapter;
  controller: AbortController;
  generation: number;
  invocation: SubappHostProviderRecord;
  invocationId: string;
  subscriptionIds: Set<string>;
  eventsArmed: boolean;
  pendingEvents: Array<{
    subscriptionId: string;
    event: SubappHostProviderRecord;
    sizeBytes: number;
  }>;
  pendingEventBytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  completed: boolean;
}

interface ActiveArtifactTransfer {
  adapter: SubappHostProviderAdapter;
  controller: AbortController;
  generation: number;
  request: SubappHostProviderRecord;
  timer: ReturnType<typeof setTimeout> | null;
  transferId: string;
  completed: boolean;
}

const PORTABLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ACTIVE_INVOCATIONS = 64;
const DEFAULT_MAX_ACTIVE_ARTIFACT_TRANSFERS = 16;
const MAX_PROVIDERS = 32;
const MAX_CAPABILITIES = 64;
const MAX_PROTOCOL_VERSIONS = 8;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class SubappHostProviderDispatcher {
  private readonly hostInstanceId: string;
  private readonly adapters: readonly SubappHostProviderAdapter[];
  private readonly adaptersByProvider: ReadonlyMap<string, SubappHostProviderAdapter>;
  private readonly artifactAdapter: SubappHostProviderAdapter | null;
  private readonly now: () => number;
  private readonly maxMessageBytes: number;
  private readonly maxActiveInvocations: number;
  private readonly maxActiveArtifactTransfers: number;
  private readonly activeInvocations = new Map<string, ActiveInvocation>();
  private readonly activeSubscriptions = new Map<string, ActiveInvocation>();
  private readonly activeArtifactTransfers = new Map<string, ActiveArtifactTransfer>();
  private transport: SubappHostProviderTransport | null = null;
  private removeTransportListener: (() => void) | null = null;
  private generation = 0;
  private closed = false;

  constructor(options: SubappHostProviderDispatcherOptions) {
    this.hostInstanceId = requirePortableIdentifier(
      options.hostInstanceId,
      'hostInstanceId',
    );
    this.adapters = Object.freeze(
      options.adapters.map((adapter) => validateAdapter(adapter)),
    );
    if (this.adapters.length > MAX_PROVIDERS) {
      throw new RangeError(`Host provider adapter limit is ${MAX_PROVIDERS}.`);
    }
    const adapterEntries = this.adapters.map((adapter) => [
      adapter.provider,
      adapter,
    ] as const);
    if (new Set(adapterEntries.map(([provider]) => provider)).size !== adapterEntries.length) {
      throw new TypeError('Host provider adapters must use unique provider names.');
    }
    this.adaptersByProvider = new Map(adapterEntries);
    const artifactAdapters = this.adapters.filter(
      (adapter) => typeof adapter.readArtifactChunk === 'function',
    );
    if (artifactAdapters.length > 1) {
      throw new TypeError('Only one Host provider adapter may read artifact chunks.');
    }
    this.artifactAdapter = artifactAdapters[0] ?? null;
    this.now = options.now ?? Date.now;
    this.maxMessageBytes = boundedInteger(
      options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
      1024,
      DEFAULT_MAX_MESSAGE_BYTES,
      'maxMessageBytes',
    );
    this.maxActiveInvocations = boundedInteger(
      options.maxActiveInvocations ?? DEFAULT_MAX_ACTIVE_INVOCATIONS,
      1,
      4096,
      'maxActiveInvocations',
    );
    this.maxActiveArtifactTransfers = boundedInteger(
      options.maxActiveArtifactTransfers ?? DEFAULT_MAX_ACTIVE_ARTIFACT_TRANSFERS,
      1,
      1024,
      'maxActiveArtifactTransfers',
    );
  }

  bindTransport(transport: SubappHostProviderTransport): () => void {
    if (this.closed) throw new Error('Host provider dispatcher is closed.');
    if (
      !transport
      || typeof transport.send !== 'function'
      || typeof transport.onMessage !== 'function'
    ) {
      throw new TypeError('Host provider transport is invalid.');
    }
    this.detachTransport();
    this.transport = transport;
    const generation = ++this.generation;
    this.removeTransportListener = transport.onMessage((message) => {
      if (this.closed || generation !== this.generation) return;
      void this.handleMessage(message, generation).catch(() => undefined);
    });
    return () => {
      if (generation === this.generation) this.detachTransport();
    };
  }

  async publishEvent(
    subscriptionIdValue: string,
    event: SubappHostProviderRecord,
  ): Promise<boolean> {
    const subscriptionId = requirePortableIdentifier(
      subscriptionIdValue,
      'subscriptionId',
    );
    const active = this.activeSubscriptions.get(subscriptionId);
    if (
      !active
      || active.completed
      || active.controller.signal.aborted
      || active.generation !== this.generation
    ) {
      return false;
    }
    return await this.publishInvocationEvent(active, subscriptionId, event);
  }

  snapshot(): Readonly<{
    bound: boolean;
    closed: boolean;
    generation: number;
    activeInvocations: number;
    activeSubscriptions: number;
    activeArtifactTransfers: number;
  }> {
    return Object.freeze({
      bound: this.transport !== null,
      closed: this.closed,
      generation: this.generation,
      activeInvocations: this.activeInvocations.size,
      activeSubscriptions: this.activeSubscriptions.size,
      activeArtifactTransfers: this.activeArtifactTransfers.size,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detachTransport();
    await Promise.allSettled(
      this.adapters.map((adapter) => Promise.resolve(adapter.close?.())),
    );
  }

  private async handleMessage(
    rawMessage: SubappHostProviderRecord,
    generation: number,
  ): Promise<void> {
    let message: SubappHostProviderRecord;
    try {
      message = requireBoundedRecord(
        rawMessage,
        this.maxMessageBytes,
        'provider transport message',
      );
    } catch {
      return;
    }
    if (
      message['version'] !== SUBAPP_HOST_PROVIDER_TRANSPORT_VERSION
      || typeof message['type'] !== 'string'
    ) {
      return;
    }
    switch (message['type']) {
      case SUBAPP_HOST_PROVIDER_MESSAGE_TYPES.negotiationRequest:
        await this.handleNegotiation(message, generation);
        break;
      case SUBAPP_HOST_PROVIDER_MESSAGE_TYPES.invocation:
        await this.startInvocation(message, generation);
        break;
      case SUBAPP_HOST_PROVIDER_MESSAGE_TYPES.cancel:
        this.cancelInvocation(message);
        break;
      case SUBAPP_HOST_PROVIDER_MESSAGE_TYPES.artifactChunkRequest:
        await this.startArtifactTransfer(message, generation);
        break;
    }
  }

  private async handleNegotiation(
    message: SubappHostProviderRecord,
    generation: number,
  ): Promise<void> {
    const request = asRecord(message['request']);
    if (!request) return;
    let requestId: string;
    try {
      requestId = requirePortableIdentifier(request['requestId'], 'requestId');
      validateNegotiationRequirements(request['providers']);
    } catch {
      return;
    }
    await this.sendForGeneration(generation, {
      type: SUBAPP_HOST_PROVIDER_MESSAGE_TYPES.catalog,
      version: SUBAPP_HOST_PROVIDER_TRANSPORT_VERSION,
      requestId,
      catalog: {
        schemaVersion: 1,
        kind: 'aily-subapp-host-provider-catalog',
        hostInstanceId: this.hostInstanceId,
        providers: this.adapters.map((adapter) => ({
          provider: adapter.provider,
          protocolVersions: [...adapter.protocolVersions],
          capabilities: [...adapter.capabilities],
        })),
      },
    });
  }

  private async startInvocation(
    message: SubappHostProviderRecord,
    generation: number,
  ): Promise<void> {
    let invocation: SubappHostProviderRecord;
    let invocationId: string;
    let provider: string;
    let capability: string;
    let deadlineUnixMs: number;
    try {
      invocation = requireBoundedRecord(
        message['invocation'],
        this.maxMessageBytes,
        'provider invocation',
      );
      invocationId = requirePortableIdentifier(
        invocation['invocationId'],
        'invocationId',
      );
      provider = requireProviderIdentifier(invocation['provider'], 'provider');
      capability = requireCapability(
        invocation['capability'],
        provider,
        'capability',
      );
      requirePositiveInteger(invocation['protocolVersion'], 'protocolVersion');
      requirePositiveInteger(invocation['providerRevision'], 'providerRevision');
      deadlineUnixMs = requireNonNegativeInteger(
        invocation['deadlineUnixMs'],
        'deadlineUnixMs',
      );
    } catch {
      return;
    }
    if (this.activeInvocations.has(invocationId)) return;
    const adapter = this.adaptersByProvider.get(provider);
    if (!adapter) return;
    if (
      !adapter.capabilities.includes(capability)
      || !adapter.protocolVersions.includes(Number(invocation['protocolVersion']))
    ) {
      await this.sendFailure(
        adapter,
        invocation,
        invocationId,
        'capability-unavailable',
        generation,
      );
      return;
    }
    if (this.activeInvocations.size >= this.maxActiveInvocations) {
      await this.sendFailure(
        adapter,
        invocation,
        invocationId,
        'operation-failed',
        generation,
      );
      return;
    }

    const controller = new AbortController();
    const active: ActiveInvocation = {
      adapter,
      controller,
      generation,
      invocation,
      invocationId,
      subscriptionIds: new Set(),
      eventsArmed: false,
      pendingEvents: [],
      pendingEventBytes: 0,
      timer: null,
      completed: false,
    };
    this.activeInvocations.set(invocationId, active);
    const delay = deadlineUnixMs - this.requireNow();
    if (delay < 0) {
      await this.expireInvocation(active);
      return;
    }
    this.armInvocationDeadline(active, deadlineUnixMs, delay);
    try {
      const outcome = await adapter.handleInvocation(
        invocation,
        {
          signal: controller.signal,
          publishEvent: (subscriptionId, event) => (
            this.publishInvocationEvent(active, subscriptionId, event)
          ),
        },
      );
      if (!this.isActiveInvocation(active)) return;
      const result = requireBoundedRecord(
        outcome?.result,
        this.maxMessageBytes,
        'provider result',
      );
      const subscriptionIds = validateSubscriptionIds(
        outcome?.subscriptionIds ?? [],
      );
      for (const subscriptionId of subscriptionIds) {
        const existing = this.activeSubscriptions.get(subscriptionId);
        if (existing && existing !== active) {
          throw new Error('Host provider subscription ID is already active.');
        }
        active.subscriptionIds.add(subscriptionId);
        this.activeSubscriptions.set(subscriptionId, active);
      }
      if (active.timer) {
        clearTimeout(active.timer);
        active.timer = null;
      }
      await this.sendForGeneration(generation, {
        type: SUBAPP_HOST_PROVIDER_MESSAGE_TYPES.result,
        version: SUBAPP_HOST_PROVIDER_TRANSPORT_VERSION,
        invocationId,
        result,
      });
      if (!this.isActiveInvocation(active)) return;
      if (subscriptionIds.length === 0) {
        this.finishInvocation(active, false);
        return;
      }
      active.eventsArmed = true;
      const pendingEvents = active.pendingEvents.splice(0);
      active.pendingEventBytes = 0;
      for (const pending of pendingEvents) {
        if (!active.subscriptionIds.has(pending.subscriptionId)) continue;
        await this.publishInvocationEvent(
          active,
          pending.subscriptionId,
          pending.event,
        );
      }
    } catch {
      if (!this.isActiveInvocation(active)) return;
      const code = controller.signal.aborted ? 'cancelled' : 'operation-failed';
      this.finishInvocation(active);
      await this.sendFailure(
        adapter,
        invocation,
        invocationId,
        code,
        generation,
      );
    }
  }

  private cancelInvocation(message: SubappHostProviderRecord): void {
    let invocationId: string;
    try {
      invocationId = requirePortableIdentifier(
        message['invocationId'],
        'invocationId',
      );
    } catch {
      return;
    }
    const active = this.activeInvocations.get(invocationId);
    if (active) this.finishInvocation(active);
  }

  private async expireInvocation(active: ActiveInvocation): Promise<void> {
    if (!this.isActiveInvocation(active)) return;
    this.finishInvocation(active);
    await this.sendFailure(
      active.adapter,
      active.invocation,
      active.invocationId,
      'deadline-exceeded',
      active.generation,
    );
  }

  private async sendFailure(
    adapter: SubappHostProviderAdapter,
    invocation: SubappHostProviderRecord,
    invocationId: string,
    code: SubappHostProviderFailureCode,
    generation: number,
  ): Promise<void> {
    let result: SubappHostProviderRecord;
    try {
      result = requireBoundedRecord(
        adapter.createFailureResult(invocation, code),
        this.maxMessageBytes,
        'provider failure result',
      );
    } catch {
      return;
    }
    await this.sendForGeneration(generation, {
      type: SUBAPP_HOST_PROVIDER_MESSAGE_TYPES.result,
      version: SUBAPP_HOST_PROVIDER_TRANSPORT_VERSION,
      invocationId,
      result,
    });
  }

  private async publishInvocationEvent(
    active: ActiveInvocation,
    subscriptionIdValue: string,
    eventValue: SubappHostProviderRecord,
  ): Promise<boolean> {
    let subscriptionId: string;
    let event: SubappHostProviderRecord;
    try {
      subscriptionId = requirePortableIdentifier(
        subscriptionIdValue,
        'subscriptionId',
      );
      event = requireBoundedRecord(
        eventValue,
        this.maxMessageBytes,
        'provider event',
      );
    } catch {
      return false;
    }
    if (
      !this.isActiveInvocation(active)
      || active.controller.signal.aborted
    ) {
      return false;
    }
    if (!active.eventsArmed) {
      const sizeBytes = jsonByteLength(event);
      while (
        active.pendingEvents.length >= 32
        || active.pendingEventBytes + sizeBytes > this.maxMessageBytes
      ) {
        const removed = active.pendingEvents.shift();
        if (!removed) break;
        active.pendingEventBytes -= removed.sizeBytes;
      }
      active.pendingEvents.push({ subscriptionId, event, sizeBytes });
      active.pendingEventBytes += sizeBytes;
      return true;
    }
    if (
      !active.subscriptionIds.has(subscriptionId)
      || this.activeSubscriptions.get(subscriptionId) !== active
    ) {
      return false;
    }
    await this.sendForGeneration(active.generation, {
      type: SUBAPP_HOST_PROVIDER_MESSAGE_TYPES.event,
      version: SUBAPP_HOST_PROVIDER_TRANSPORT_VERSION,
      subscriptionId,
      event,
    });
    return true;
  }

  private async startArtifactTransfer(
    message: SubappHostProviderRecord,
    generation: number,
  ): Promise<void> {
    const adapter = this.artifactAdapter;
    if (
      !adapter?.readArtifactChunk
      || !adapter.createArtifactChunkFailureResult
    ) {
      return;
    }
    let request: SubappHostProviderRecord;
    let transferId: string;
    let deadlineUnixMs: number;
    try {
      request = requireBoundedRecord(
        message['request'],
        this.maxMessageBytes,
        'artifact chunk request',
      );
      transferId = requirePortableIdentifier(
        request['transferId'],
        'transferId',
      );
      deadlineUnixMs = requireNonNegativeInteger(
        request['deadlineUnixMs'],
        'deadlineUnixMs',
      );
    } catch {
      return;
    }
    if (this.activeArtifactTransfers.has(transferId)) return;
    if (this.activeArtifactTransfers.size >= this.maxActiveArtifactTransfers) {
      await this.sendArtifactFailure(
        adapter,
        request,
        transferId,
        'operation-failed',
        generation,
      );
      return;
    }
    const controller = new AbortController();
    const active: ActiveArtifactTransfer = {
      adapter,
      controller,
      generation,
      request,
      timer: null,
      transferId,
      completed: false,
    };
    this.activeArtifactTransfers.set(transferId, active);
    const delay = deadlineUnixMs - this.requireNow();
    if (delay < 0) {
      await this.expireArtifactTransfer(active);
      return;
    }
    this.armArtifactDeadline(active, deadlineUnixMs, delay);
    try {
      const result = requireBoundedRecord(
        await adapter.readArtifactChunk(request, controller.signal),
        this.maxMessageBytes,
        'artifact chunk result',
      );
      if (!this.isActiveArtifactTransfer(active)) return;
      if (active.timer) {
        clearTimeout(active.timer);
        active.timer = null;
      }
      await this.sendForGeneration(generation, {
        type: SUBAPP_HOST_PROVIDER_MESSAGE_TYPES.artifactChunkResult,
        version: SUBAPP_HOST_PROVIDER_TRANSPORT_VERSION,
        transferId,
        result,
      });
      this.finishArtifactTransfer(active, false);
    } catch {
      if (!this.isActiveArtifactTransfer(active)) return;
      const code = controller.signal.aborted ? 'cancelled' : 'operation-failed';
      this.finishArtifactTransfer(active);
      await this.sendArtifactFailure(
        adapter,
        request,
        transferId,
        code,
        generation,
      );
    }
  }

  private async expireArtifactTransfer(
    active: ActiveArtifactTransfer,
  ): Promise<void> {
    if (!this.isActiveArtifactTransfer(active)) return;
    this.finishArtifactTransfer(active);
    await this.sendArtifactFailure(
      active.adapter,
      active.request,
      active.transferId,
      'deadline-exceeded',
      active.generation,
    );
  }

  private armInvocationDeadline(
    active: ActiveInvocation,
    deadlineUnixMs: number,
    knownDelay?: number,
  ): void {
    if (!this.isActiveInvocation(active)) return;
    const delay = knownDelay ?? deadlineUnixMs - this.requireNow();
    if (delay < 0) {
      void this.expireInvocation(active);
      return;
    }
    active.timer = setTimeout(() => {
      if (!this.isActiveInvocation(active)) return;
      const remaining = deadlineUnixMs - this.requireNow();
      if (remaining >= 0) {
        this.armInvocationDeadline(active, deadlineUnixMs, remaining);
        return;
      }
      void this.expireInvocation(active);
    }, Math.min(delay + 1, MAX_TIMER_DELAY_MS));
  }

  private armArtifactDeadline(
    active: ActiveArtifactTransfer,
    deadlineUnixMs: number,
    knownDelay?: number,
  ): void {
    if (!this.isActiveArtifactTransfer(active)) return;
    const delay = knownDelay ?? deadlineUnixMs - this.requireNow();
    if (delay < 0) {
      void this.expireArtifactTransfer(active);
      return;
    }
    active.timer = setTimeout(() => {
      if (!this.isActiveArtifactTransfer(active)) return;
      const remaining = deadlineUnixMs - this.requireNow();
      if (remaining >= 0) {
        this.armArtifactDeadline(active, deadlineUnixMs, remaining);
        return;
      }
      void this.expireArtifactTransfer(active);
    }, Math.min(delay + 1, MAX_TIMER_DELAY_MS));
  }

  private async sendArtifactFailure(
    adapter: SubappHostProviderAdapter,
    request: SubappHostProviderRecord,
    transferId: string,
    code: Exclude<SubappHostProviderFailureCode, 'capability-unavailable'>,
    generation: number,
  ): Promise<void> {
    let result: SubappHostProviderRecord;
    try {
      result = requireBoundedRecord(
        adapter.createArtifactChunkFailureResult?.(request, code),
        this.maxMessageBytes,
        'artifact chunk failure result',
      );
    } catch {
      return;
    }
    await this.sendForGeneration(generation, {
      type: SUBAPP_HOST_PROVIDER_MESSAGE_TYPES.artifactChunkResult,
      version: SUBAPP_HOST_PROVIDER_TRANSPORT_VERSION,
      transferId,
      result,
    });
  }

  private finishInvocation(active: ActiveInvocation, abort = true): void {
    if (active.completed) return;
    active.completed = true;
    if (abort) active.controller.abort();
    if (active.timer) clearTimeout(active.timer);
    this.activeInvocations.delete(active.invocationId);
    for (const subscriptionId of active.subscriptionIds) {
      if (this.activeSubscriptions.get(subscriptionId) === active) {
        this.activeSubscriptions.delete(subscriptionId);
      }
    }
    active.pendingEvents.length = 0;
    active.pendingEventBytes = 0;
  }

  private finishArtifactTransfer(
    active: ActiveArtifactTransfer,
    abort = true,
  ): void {
    if (active.completed) return;
    active.completed = true;
    if (abort) active.controller.abort();
    if (active.timer) clearTimeout(active.timer);
    this.activeArtifactTransfers.delete(active.transferId);
  }

  private isActiveInvocation(active: ActiveInvocation): boolean {
    return !active.completed
      && this.activeInvocations.get(active.invocationId) === active
      && active.generation === this.generation;
  }

  private isActiveArtifactTransfer(active: ActiveArtifactTransfer): boolean {
    return !active.completed
      && this.activeArtifactTransfers.get(active.transferId) === active
      && active.generation === this.generation;
  }

  private async sendForGeneration(
    generation: number,
    message: SubappHostProviderRecord,
  ): Promise<void> {
    const transport = this.transport;
    if (
      !transport
      || this.closed
      || generation !== this.generation
    ) {
      return;
    }
    const bounded = requireBoundedRecord(
      message,
      this.maxMessageBytes,
      'outbound provider transport message',
    );
    await transport.send(bounded);
  }

  private detachTransport(): void {
    this.removeTransportListener?.();
    this.removeTransportListener = null;
    this.transport = null;
    this.generation += 1;
    for (const active of [...this.activeInvocations.values()]) {
      this.finishInvocation(active);
    }
    for (const active of [...this.activeArtifactTransfers.values()]) {
      this.finishArtifactTransfer(active);
    }
  }

  private requireNow(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Host provider dispatcher clock is invalid.');
    }
    return value;
  }
}

function validateAdapter(
  adapter: SubappHostProviderAdapter,
): SubappHostProviderAdapter {
  if (
    !adapter
    || typeof adapter.handleInvocation !== 'function'
    || typeof adapter.createFailureResult !== 'function'
  ) {
    throw new TypeError('Host provider adapter handlers are required.');
  }
  const provider = requireProviderIdentifier(adapter.provider, 'adapter.provider');
  const protocolVersions = validateProtocolVersions(adapter.protocolVersions);
  const capabilities = validateCapabilities(adapter.capabilities, provider);
  if (
    (typeof adapter.readArtifactChunk === 'function')
    !== (typeof adapter.createArtifactChunkFailureResult === 'function')
  ) {
    throw new TypeError(
      'Artifact reader and artifact failure factory must be declared together.',
    );
  }
  const normalized: SubappHostProviderAdapter = {
    provider,
    protocolVersions: Object.freeze(protocolVersions),
    capabilities: Object.freeze(capabilities),
    handleInvocation: (invocation, context) => (
      adapter.handleInvocation(invocation, context)
    ),
    createFailureResult: (invocation, code) => (
      adapter.createFailureResult(invocation, code)
    ),
    ...(typeof adapter.readArtifactChunk === 'function'
      ? {
          readArtifactChunk: (request: SubappHostProviderRecord, signal: AbortSignal) => (
            adapter.readArtifactChunk!(request, signal)
          ),
          createArtifactChunkFailureResult: (
            request: SubappHostProviderRecord,
            code: Exclude<SubappHostProviderFailureCode, 'capability-unavailable'>,
          ) => adapter.createArtifactChunkFailureResult!(request, code),
        }
      : {}),
    ...(typeof adapter.close === 'function'
      ? { close: () => adapter.close!() }
      : {}),
  };
  return Object.freeze(normalized);
}

function validateNegotiationRequirements(value: unknown): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PROVIDERS) {
    throw new TypeError('Provider requirements must be a bounded non-empty array.');
  }
  const providers = new Set<string>();
  for (const candidate of value) {
    const requirement = asRecord(candidate);
    if (!requirement) throw new TypeError('Provider requirement must be an object.');
    const provider = requireProviderIdentifier(
      requirement['provider'],
      'requirement.provider',
    );
    if (providers.has(provider)) {
      throw new TypeError('Provider requirements must be unique.');
    }
    providers.add(provider);
    validateProtocolVersions(requirement['protocolVersions']);
    validateCapabilities(
      requirement['requiredCapabilities'],
      provider,
    );
    validateCapabilities(
      requirement['optionalCapabilities'],
      provider,
    );
  }
}

function validateProtocolVersions(value: unknown): number[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_PROTOCOL_VERSIONS
  ) {
    throw new TypeError('Protocol versions must be a bounded non-empty array.');
  }
  const versions = value.map((entry) => requirePositiveInteger(
    entry,
    'protocolVersion',
  ));
  if (new Set(versions).size !== versions.length) {
    throw new TypeError('Protocol versions must be unique.');
  }
  return versions.sort((left, right) => left - right);
}

function validateCapabilities(value: unknown, provider: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) {
    throw new TypeError('Capabilities must be a bounded array.');
  }
  const capabilities = value.map((entry) => (
    requireCapability(entry, provider, 'capability')
  ));
  if (new Set(capabilities).size !== capabilities.length) {
    throw new TypeError('Capabilities must be unique.');
  }
  return capabilities.sort();
}

function validateSubscriptionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) {
    throw new TypeError('Subscription IDs must be a bounded array.');
  }
  const ids = value.map((entry) => (
    requirePortableIdentifier(entry, 'subscriptionId')
  ));
  if (new Set(ids).size !== ids.length) {
    throw new TypeError('Subscription IDs must be unique.');
  }
  return ids;
}

function requireBoundedRecord(
  value: unknown,
  maxBytes: number,
  label: string,
): SubappHostProviderRecord {
  const record = asRecord(value);
  if (!record) throw new TypeError(`${label} must be an object.`);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(record);
  } catch {
    throw new TypeError(`${label} must be JSON serializable.`);
  }
  if (
    serialized === undefined
    || new TextEncoder().encode(serialized).byteLength > maxBytes
  ) {
    throw new RangeError(`${label} exceeds the byte limit.`);
  }
  return JSON.parse(serialized) as SubappHostProviderRecord;
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function asRecord(value: unknown): SubappHostProviderRecord | null {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    ? value as SubappHostProviderRecord
    : null;
}

function requireProviderIdentifier(value: unknown, label: string): string {
  return requirePortableIdentifier(value, label).toLowerCase();
}

function requirePortableIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  const normalized = value.trim();
  if (
    normalized.length < 1
    || normalized.length > MAX_IDENTIFIER_LENGTH
    || !PORTABLE_IDENTIFIER_PATTERN.test(normalized)
  ) {
    throw new TypeError(`${label} must be a portable identifier.`);
  }
  return normalized;
}

function requireCapability(
  value: unknown,
  provider: string,
  label: string,
): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_IDENTIFIER_LENGTH
    || !CAPABILITY_PATTERN.test(value)
    || !value.startsWith(`${provider}.`)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return Number(value);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return Number(value);
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be in ${minimum}..${maximum}.`);
  }
  return value;
}
