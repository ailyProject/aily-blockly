export type SimulatorSubappTool = 'scene' | 'debugger';

export interface SimulatorSubappSurface {
  schemaVersion: 1;
  kind: 'aily-simulator-subapp-surface';
  state: 'ready';
  tool: SimulatorSubappTool;
  url: string;
  origin: string;
  launchId: string;
  initialization?: 'existing' | 'created-empty' | 'regenerated-v2';
  runtimeSource: string;
  runtimePackId?: string;
  runtimeMode?: string;
}

export type SimulatorSubappFrameState =
  | 'idle'
  | 'acquiring'
  | 'awaiting-shell'
  | 'launching'
  | 'ready'
  | 'recovering'
  | 'closing'
  | 'closed'
  | 'failed';

export interface SimulatorSubappDebugLocationHint {
  schemaVersion: 1;
  kind: 'aily-simulator-subapp-debug-location-hint';
  launchId: string;
  sessionId: string;
  sceneId: string;
  sceneRevision: string;
  sequence: number;
  status: 'available' | 'clear';
  location: { file: string; line: number } | null;
  sourceMapRevision: string | null;
  primaryBlockId: string | null;
  mappings: readonly SimulatorSubappDebugBlockMapping[];
  mappingsTruncated: boolean;
  clearReason: 'not-stopped' | 'mode-exit' | 'artifact-stale' | 'launch-closed' | null;
}

export interface SimulatorSubappDebugBlockMapping {
  blockId: string;
  executionRole: 'statement' | 'value' | 'unknown';
  totalRanges: number;
  ranges: readonly {
    startLine: number;
    endLine: number;
    role: 'generated' | 'executable' | 'support';
    current: boolean;
  }[];
  truncated: boolean;
}

export interface SimulatorSubappProjectSceneGenerationIntent {
  schemaVersion: 1;
  kind: 'aily-simulator-subapp-project-scene-generation-intent';
  launchId: string;
  base: {
    visualRevision: string;
    graphSemanticRevision: string;
    catalogRevision: string;
  };
}

export interface SimulatorSubappFrameAdapterOptions {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  frame: Pick<HTMLIFrameElement, 'contentWindow' | 'src'>;
  acquireSurface(): Promise<unknown>;
  releaseSurface(): Promise<unknown>;
  onStateChange?(state: SimulatorSubappFrameState, error: Error | null): void;
  onDebugLocationHint?(event: SimulatorSubappDebugLocationHint): void;
  onProjectSceneGenerationIntent?(
    event: SimulatorSubappProjectSceneGenerationIntent,
  ): void;
  requestId?(): string;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  requestId: string;
  operation: 'launch' | 'close';
  launchId: string;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReadyWaiter {
  resolve(): void;
  reject(error: Error): void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const LAUNCH_ID_PATTERN = /^launch-v1-[a-f0-9]{64}$/;
const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Parent-side adapter for the independent Simulator Subapp fixed shell.
 *
 * Its cross-frame authority is deliberately limited to an opaque launchId.
 * Project paths, connection graphs, firmware handles, Gateway grants and
 * runtime commands stay on Electron IPC or inside the Subapp origin.
 */
export class SimulatorSubappFrameAdapter {
  private readonly window: SimulatorSubappFrameAdapterOptions['window'];
  private readonly frame: SimulatorSubappFrameAdapterOptions['frame'];
  private readonly acquireSurface: SimulatorSubappFrameAdapterOptions['acquireSurface'];
  private readonly releaseSurface: SimulatorSubappFrameAdapterOptions['releaseSurface'];
  private readonly onStateChange?: SimulatorSubappFrameAdapterOptions['onStateChange'];
  private readonly onDebugLocationHint?: SimulatorSubappFrameAdapterOptions['onDebugLocationHint'];
  private readonly onProjectSceneGenerationIntent?:
    SimulatorSubappFrameAdapterOptions['onProjectSceneGenerationIntent'];
  private readonly createRequestId: () => string;
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  private currentState: SimulatorSubappFrameState = 'idle';
  private surface: SimulatorSubappSurface | null = null;
  private pending: PendingRequest | null = null;
  private readyWaiter: ReadyWaiter | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private surfaceOwned = false;
  private listenerAttached = false;
  private closing = false;
  private recoveryTask: Promise<void> | null = null;

  constructor(options: SimulatorSubappFrameAdapterOptions) {
    if (!options.window || !options.frame) {
      throw new TypeError('Simulator Subapp frame adapter requires a window and iframe.');
    }
    if (
      typeof options.acquireSurface !== 'function'
      || typeof options.releaseSurface !== 'function'
    ) {
      throw new TypeError('Simulator Subapp frame adapter requires surface lifecycle callbacks.');
    }
    this.window = options.window;
    this.frame = options.frame;
    this.acquireSurface = options.acquireSurface;
    this.releaseSurface = options.releaseSurface;
    this.onStateChange = options.onStateChange;
    this.onDebugLocationHint = options.onDebugLocationHint;
    this.onProjectSceneGenerationIntent = options.onProjectSceneGenerationIntent;
    this.createRequestId = options.requestId ?? defaultRequestId;
    this.handshakeTimeoutMs = requireTimeout(
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      'handshakeTimeoutMs',
    );
    this.requestTimeoutMs = requireTimeout(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
  }

  get state(): SimulatorSubappFrameState {
    return this.currentState;
  }

  start(): Promise<void> {
    if (this.currentState !== 'idle') {
      throw new Error('Simulator Subapp frame adapter has already started.');
    }
    this.attachListener();
    return this.acquireAndNavigate('acquiring');
  }

  async close(): Promise<void> {
    if (this.currentState === 'closed' || this.closing) return;
    this.closing = true;
    this.setState('closing');
    this.clearHandshakeTimer();

    if (this.currentStateBeforeClosingWasReady() && this.surface && this.frame.contentWindow) {
      await this.sendRequest('close').catch(() => undefined);
    }

    this.generation += 1;
    this.rejectPending(new Error('Simulator Subapp frame adapter is closing.'));
    this.rejectReadyWaiter(new Error('Simulator Subapp frame adapter is closing.'));
    await this.releaseCurrentSurface().catch(() => undefined);
    this.surface = null;
    this.frame.src = 'about:blank';
    this.detachListener();
    this.closing = false;
    this.setState('closed');
  }

  private stateBeforeClosing: SimulatorSubappFrameState = 'idle';

  private currentStateBeforeClosingWasReady(): boolean {
    return this.stateBeforeClosing === 'ready';
  }

  private setState(state: SimulatorSubappFrameState, error: Error | null = null): void {
    if (state === 'closing') this.stateBeforeClosing = this.currentState;
    this.currentState = state;
    this.onStateChange?.(state, error);
  }

  private attachListener(): void {
    if (this.listenerAttached) return;
    this.listenerAttached = true;
    this.window.addEventListener('message', this.handleMessage as EventListener);
  }

  private detachListener(): void {
    if (!this.listenerAttached) return;
    this.listenerAttached = false;
    this.window.removeEventListener('message', this.handleMessage as EventListener);
  }

  private acquireAndNavigate(
    state: 'acquiring' | 'recovering',
  ): Promise<void> {
    const generation = ++this.generation;
    this.setState(state);
    const ready = new Promise<void>((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
    });

    void this.acquireSurface().then(
      async (value) => {
        let surface: SimulatorSubappSurface;
        try {
          surface = validateSurface(value);
        } catch (error) {
          this.fail(asError(error));
          return;
        }
        if (generation !== this.generation || this.closing) {
          await this.releaseSurface().catch(() => undefined);
          return;
        }
        this.surface = surface;
        this.surfaceOwned = true;
        this.setState('awaiting-shell');
        this.handshakeTimer = setTimeout(() => {
          this.fail(new Error('Simulator Subapp shell handshake timed out.'));
        }, this.handshakeTimeoutMs);
        this.frame.src = surface.url;
      },
      (error) => this.fail(asError(error)),
    );
    return ready;
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    const surface = this.surface;
    if (
      !surface
      || event.source !== this.frame.contentWindow
      || event.origin !== surface.origin
    ) {
      return;
    }

    if (isShellReadyEvent(event.data)) {
      if (this.currentState === 'awaiting-shell') {
        this.clearHandshakeTimer();
        this.setState('launching');
        void this.sendRequest('launch').then(
          () => {
            if (this.closing) return;
            this.setState('ready');
            this.resolveReadyWaiter();
          },
          (error) => this.fail(asError(error)),
        );
      } else if (this.currentState === 'ready' && !this.recoveryTask) {
        this.recoveryTask = this.recoverAfterReload().finally(() => {
          this.recoveryTask = null;
        });
      }
      return;
    }

    const response = validateMatchingResponse(event.data, this.pending);
    if (response) {
      const pending = this.pending!;
      this.pending = null;
      clearTimeout(pending.timer);
      if ('errorCode' in response) {
        pending.reject(new Error(
          `Simulator Subapp shell ${pending.operation} failed (${response.errorCode}).`,
        ));
      } else {
        pending.resolve();
      }
      return;
    }

    const hint = validateDebugLocationHint(event.data, surface.launchId);
    if (hint) {
      this.onDebugLocationHint?.(hint);
      return;
    }
    const generationIntent = validateProjectSceneGenerationIntent(
      event.data,
      surface.launchId,
    );
    if (generationIntent) {
      this.onProjectSceneGenerationIntent?.(generationIntent);
    }
  };

  private async recoverAfterReload(): Promise<void> {
    if (this.closing) return;
    this.setState('recovering');
    this.generation += 1;
    this.rejectPending(new Error('Simulator Subapp shell reloaded.'));
    await this.releaseCurrentSurface().catch(() => undefined);
    if (this.closing) return;
    this.surface = null;
    await this.acquireAndNavigate('recovering').catch(() => undefined);
  }

  private sendRequest(operation: 'launch' | 'close'): Promise<void> {
    const surface = this.surface;
    const target = this.frame.contentWindow;
    if (!surface || !target) {
      return Promise.reject(new Error('Simulator Subapp shell frame is unavailable.'));
    }
    if (this.pending) {
      return Promise.reject(new Error('A Simulator Subapp shell request is already pending.'));
    }
    const requestId = requirePortableId(this.createRequestId(), 'requestId', 128);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.requestId !== requestId) return;
        this.pending = null;
        reject(new Error(`Simulator Subapp shell ${operation} timed out.`));
      }, this.requestTimeoutMs);
      this.pending = {
        requestId,
        operation,
        launchId: surface.launchId,
        resolve,
        reject,
        timer,
      };
      target.postMessage({
        schemaVersion: 1,
        kind: 'aily-simulator-subapp-shell-request',
        requestId,
        operation,
        launchId: surface.launchId,
      }, surface.origin);
    });
  }

  private fail(error: Error): void {
    if (this.closing || this.currentState === 'closed') return;
    this.clearHandshakeTimer();
    this.rejectPending(error);
    this.rejectReadyWaiter(error);
    this.setState('failed', error);
    void this.releaseCurrentSurface().catch(() => undefined);
  }

  private async releaseCurrentSurface(): Promise<void> {
    if (!this.surfaceOwned) return;
    this.surfaceOwned = false;
    await this.releaseSurface();
  }

  private clearHandshakeTimer(): void {
    if (!this.handshakeTimer) return;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private resolveReadyWaiter(): void {
    const waiter = this.readyWaiter;
    this.readyWaiter = null;
    waiter?.resolve();
  }

  private rejectReadyWaiter(error: Error): void {
    const waiter = this.readyWaiter;
    this.readyWaiter = null;
    waiter?.reject(error);
  }
}

function validateSurface(value: unknown): SimulatorSubappSurface {
  const record = requireRecord(value, 'Simulator Subapp surface');
  requireOnlyKeys(record, [
    'schemaVersion',
    'kind',
    'state',
    'tool',
    'url',
    'origin',
    'launchId',
    'initialization',
    'runtimeSource',
    'runtimePackId',
    'runtimeMode',
  ]);
  if (
    record['schemaVersion'] !== 1
    || record['kind'] !== 'aily-simulator-subapp-surface'
    || record['state'] !== 'ready'
    || (record['tool'] !== 'scene' && record['tool'] !== 'debugger')
  ) {
    throw new TypeError('Simulator Subapp surface identity is invalid.');
  }
  const origin = requireLoopbackOrigin(record['origin']);
  if (typeof record['url'] !== 'string' || record['url'].length > 2_048) {
    throw new TypeError('Simulator Subapp surface URL is invalid.');
  }
  const url = new URL(record['url']);
  if (
    url.origin !== origin
    || url.protocol !== 'http:'
    || url.username
    || url.password
    || url.hash
  ) {
    throw new TypeError('Simulator Subapp surface URL is outside its origin.');
  }
  requireLaunchId(record['launchId']);
  if (
    record['initialization'] !== undefined
    && record['initialization'] !== 'existing'
    && record['initialization'] !== 'created-empty'
    && record['initialization'] !== 'regenerated-v2'
  ) {
    throw new TypeError('Simulator Subapp surface initialization is invalid.');
  }
  requireBoundedString(record['runtimeSource'], 'runtimeSource', 4_096);
  if (record['runtimePackId'] !== undefined) {
    requireBoundedString(record['runtimePackId'], 'runtimePackId', 256);
  }
  if (record['runtimeMode'] !== undefined) {
    requireBoundedString(record['runtimeMode'], 'runtimeMode', 128);
  }
  return value as SimulatorSubappSurface;
}

function isShellReadyEvent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return exactKeys(value, ['schemaVersion', 'kind'])
    && value['schemaVersion'] === 1
    && value['kind'] === 'aily-simulator-subapp-shell-ready';
}

function validateMatchingResponse(
  value: unknown,
  pending: PendingRequest | null,
): { ok: true } | { ok: false; errorCode: string } | null {
  if (!pending || !isRecord(value) || value['schemaVersion'] !== 1) return null;
  if (
    value['requestId'] !== pending.requestId
    || value['operation'] !== pending.operation
  ) {
    return null;
  }
  if (value['kind'] === 'aily-simulator-subapp-shell-success') {
    if (
      !exactKeys(value, [
        'schemaVersion', 'kind', 'requestId', 'operation', 'launchId', 'state',
      ])
      || value['launchId'] !== pending.launchId
      || value['state'] !== (pending.operation === 'launch' ? 'ready' : 'closed')
    ) {
      return null;
    }
    return { ok: true };
  }
  if (value['kind'] === 'aily-simulator-subapp-shell-failure') {
    if (
      !exactKeys(value, [
        'schemaVersion', 'kind', 'requestId', 'operation', 'errorCode',
      ])
      || ![
        'invalid-request',
        'duplicate-request',
        'shell-busy',
        'launch-not-found',
        'launch-failed',
        'close-failed',
        'shell-closed',
      ].includes(String(value['errorCode']))
    ) {
      return null;
    }
    return { ok: false, errorCode: String(value['errorCode']) };
  }
  return null;
}

function validateDebugLocationHint(
  value: unknown,
  launchId: string,
): SimulatorSubappDebugLocationHint | null {
  if (!isRecord(value)) return null;
  if (
    !exactKeys(value, [
      'schemaVersion',
      'kind',
      'launchId',
      'sessionId',
      'sceneId',
      'sceneRevision',
      'sequence',
      'status',
      'location',
      'sourceMapRevision',
      'primaryBlockId',
      'mappings',
      'mappingsTruncated',
      'clearReason',
    ])
    || value['schemaVersion'] !== 1
    || value['kind'] !== 'aily-simulator-subapp-debug-location-hint'
    || value['launchId'] !== launchId
    || !isPortableId(value['sessionId'], 128)
    || !isPortableId(value['sceneId'], 128)
    || !isSha256(value['sceneRevision'])
    || !Number.isSafeInteger(value['sequence'])
    || Number(value['sequence']) < 1
    || (value['status'] !== 'available' && value['status'] !== 'clear')
    || (value['sourceMapRevision'] !== null && !isSha256(value['sourceMapRevision']))
    || (value['primaryBlockId'] !== null && !isBlockId(value['primaryBlockId']))
    || !Array.isArray(value['mappings'])
    || value['mappings'].length > 8
    || typeof value['mappingsTruncated'] !== 'boolean'
    || ![
      null,
      'not-stopped',
      'mode-exit',
      'artifact-stale',
      'launch-closed',
    ].includes(value['clearReason'] as null | string)
  ) {
    return null;
  }
  const location = value['location'];
  if (
    location !== null
    && (
      !isRecord(location)
      || !exactKeys(location, ['file', 'line'])
      || typeof location['file'] !== 'string'
      || location['file'].length === 0
      || location['file'].length > 512
      || /[\u0000-\u001f\u007f]/.test(location['file'])
      || isAbsolutePortablePath(location['file'])
      || !Number.isSafeInteger(location['line'])
      || Number(location['line']) < 1
    )
  ) {
    return null;
  }
  const blockIds = validateDebugMappings(value['mappings']);
  if (!blockIds) return null;
  if (
    (value['status'] === 'available' && (
      location === null
      || value['clearReason'] !== null
      || (value['mappings'].length > 0 && value['sourceMapRevision'] === null)
      || (
        value['mappings'].length > 0
        && (
          value['primaryBlockId'] === null
          || !blockIds.has(String(value['primaryBlockId']))
        )
      )
      || (value['mappings'].length === 0 && value['primaryBlockId'] !== null)
    ))
    || (value['status'] === 'clear' && (
      location !== null
      || value['sourceMapRevision'] !== null
      || value['primaryBlockId'] !== null
      || value['mappings'].length !== 0
      || value['mappingsTruncated'] !== false
      || value['clearReason'] === null
    ))
  ) {
    return null;
  }
  return value as unknown as SimulatorSubappDebugLocationHint;
}

function validateProjectSceneGenerationIntent(
  value: unknown,
  launchId: string,
): SimulatorSubappProjectSceneGenerationIntent | null {
  if (!isRecord(value)) return null;
  if (
    !exactKeys(value, ['schemaVersion', 'kind', 'launchId', 'base'])
    || value['schemaVersion'] !== 1
    || value['kind'] !== 'aily-simulator-subapp-project-scene-generation-intent'
    || value['launchId'] !== launchId
    || !isRecord(value['base'])
    || !exactKeys(value['base'], [
      'visualRevision', 'graphSemanticRevision', 'catalogRevision',
    ])
    || !isSha256(value['base']['visualRevision'])
    || !isSha256(value['base']['graphSemanticRevision'])
    || !isSha256(value['base']['catalogRevision'])
  ) {
    return null;
  }
  return value as unknown as SimulatorSubappProjectSceneGenerationIntent;
}

function validateDebugMappings(value: unknown[]): Set<string> | null {
  const blockIds = new Set<string>();
  for (const mapping of value) {
    if (
      !isRecord(mapping)
      || !exactKeys(mapping, [
        'blockId', 'executionRole', 'totalRanges', 'ranges', 'truncated',
      ])
      || !isBlockId(mapping['blockId'])
      || blockIds.has(mapping['blockId'])
      || (
        mapping['executionRole'] !== 'statement'
        && mapping['executionRole'] !== 'value'
        && mapping['executionRole'] !== 'unknown'
      )
      || !Number.isSafeInteger(mapping['totalRanges'])
      || Number(mapping['totalRanges']) < 0
      || !Array.isArray(mapping['ranges'])
      || mapping['ranges'].length > 24
      || typeof mapping['truncated'] !== 'boolean'
      || Number(mapping['totalRanges']) < mapping['ranges'].length
      || mapping['truncated'] !== (
        Number(mapping['totalRanges']) > mapping['ranges'].length
      )
    ) {
      return null;
    }
    blockIds.add(mapping['blockId']);
    const rangeIds = new Set<string>();
    for (const range of mapping['ranges']) {
      if (
        !isRecord(range)
        || !exactKeys(range, ['startLine', 'endLine', 'role', 'current'])
        || !Number.isSafeInteger(range['startLine'])
        || Number(range['startLine']) < 1
        || !Number.isSafeInteger(range['endLine'])
        || Number(range['endLine']) < Number(range['startLine'])
        || (
          range['role'] !== 'generated'
          && range['role'] !== 'executable'
          && range['role'] !== 'support'
        )
        || typeof range['current'] !== 'boolean'
      ) {
        return null;
      }
      const rangeId = `${range['role']}:${range['startLine']}:${range['endLine']}`;
      if (rangeIds.has(rangeId)) return null;
      rangeIds.add(rangeId);
    }
  }
  return blockIds;
}

function requireLoopbackOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new TypeError('Simulator Subapp origin is invalid.');
  }
  const url = new URL(value);
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.origin !== value
    || url.username
    || url.password
  ) {
    throw new TypeError('Simulator Subapp origin must be an HTTP loopback origin.');
  }
  return url.origin;
}

function requireLaunchId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !LAUNCH_ID_PATTERN.test(value)) {
    throw new TypeError('Simulator Subapp launchId is invalid.');
  }
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError('Simulator Subapp surface contains unsupported fields.');
  }
}

function requireBoundedString(
  value: unknown,
  label: string,
  maximumLength: number,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    throw new TypeError(`Simulator Subapp ${label} is invalid.`);
  }
}

function requirePortableId(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (!isPortableId(value, maximumLength)) {
    throw new TypeError(`Simulator Subapp ${label} is invalid.`);
  }
  return value;
}

function isPortableId(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && PORTABLE_ID_PATTERN.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isBlockId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isAbsolutePortablePath(value: string): boolean {
  return value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.split(/[\\/]+/).includes('..');
}

function requireTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
    throw new RangeError(`${label} must be an integer in 100..60000.`);
  }
  return value;
}

function defaultRequestId(): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `blockly-shell-${random}`;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value || 'Unknown error'));
}
