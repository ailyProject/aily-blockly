export type SimulatorSessionState =
  | 'idle'
  | 'preflighting'
  | 'ready'
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'unsupported';

export interface SimulationArtifact {
  schemaVersion: 1;
  kind: 'aily-build-artifact';
  artifactId: string;
  target: {
    fqbn: string;
    architecture: string;
    boardId: string;
    mcu?: string;
  };
  build?: {
    source?: {
      path?: string;
      sizeBytes?: number;
      sha256?: string;
    };
  };
  files?: Array<{
    role?: string;
    path?: string;
    sha256?: string;
  }>;
  debug?: {
    sourceMapPath?: string;
    sourceSnapshotPath?: string;
  };
  [key: string]: unknown;
}

export interface SimulationComponent {
  instanceId: string;
  model: { id: string; version: string };
  properties: Record<string, string | number | boolean>;
  capabilities: string[];
  [key: string]: unknown;
}

export interface SimulationManifest {
  schemaVersion: 1;
  kind: 'aily-simulation-manifest';
  sceneId: string;
  sceneRevision: string;
  target: SimulationArtifact['target'];
  components: SimulationComponent[];
  nets: unknown[];
  initialInputs: Record<
    string,
    Record<string, string | number | boolean>
  >;
}

export interface RuntimeEnvelope<T = unknown> {
  protocolVersion: 1;
  direction: 'event';
  type: string;
  sessionId: string;
  sceneRevision: string;
  sequence: number;
  simulationTimeNs: number;
  payload: T;
}

export interface RuntimeCrashEvent {
  runtime: 'qemu';
  reason: 'process-exit' | 'process-error';
  phase: 'starting' | 'running';
  generation: number;
  processId: number | null;
  exitCode: number | null;
  signal: string | null;
  recoverable: boolean;
  message: string;
}

export type DebugSessionState =
  | 'unavailable'
  | 'disconnected'
  | 'connecting'
  | 'stopped'
  | 'running'
  | 'exited'
  | 'error';

export type DebugBreakpointLocation =
  | { kind: 'function'; functionName: string }
  | { kind: 'source'; file: string; line: number }
  | { kind: 'block'; blockId: string; sourceMapRevision: string };

export interface DebugSessionSnapshot {
  state: DebugSessionState;
  reason: string | null;
  frame: {
    level: number;
    address: string | null;
    functionName: string | null;
    location: { file: string; line: number } | null;
    blockId?: string;
  } | null;
  breakpoints: Array<{
    id: number;
    verified: boolean;
    location: DebugBreakpointLocation;
    resolvedLocation: { file: string; line: number } | null;
    resolvedLocations?: Array<{ file: string; line: number }>;
  }>;
  lastError: string | null;
}

export interface DebugBlockCommandResult {
  debug: DebugSessionSnapshot;
  startBlockId: string | null;
  targetBlockId: string | null;
  finalBlockId: string | null;
  steps: number;
  stopReason:
    | 'target-reached'
    | 'different-block'
    | 'other-stop'
    | 'step-limit'
    | 'time-limit';
}

export interface DebugStackFrame {
  level: number;
  address: string | null;
  functionName: string | null;
  location: { file: string; line: number } | null;
  blockId?: string;
}

export interface DebugVariable {
  name: string;
  value: string | null;
  type: string | null;
  scope: 'argument' | 'local';
}

export interface DebugWatch {
  id: number;
  expression: string;
  value: string | null;
  type: string | null;
  available: boolean;
  error: string | null;
}

export interface DebugThread {
  id: number;
  name: string | null;
  state: 'stopped' | 'running' | 'unknown';
  core: number | null;
  frame: DebugStackFrame | null;
}

export type DebugTaskState =
  | 'ready'
  | 'pending'
  | 'suspended'
  | 'delayed'
  | 'waiting-termination'
  | 'unknown';

export type DebugTaskSnapshotReason =
  | 'ok'
  | 'not-configured'
  | 'symbols-unavailable'
  | 'layout-unsupported'
  | 'bridge-error';

export interface DebugTask {
  /**
   * Ephemeral guest TCB identity. It is valid only for the current debugger
   * generation and must not be persisted in project configuration.
   */
  id: string;
  name: string;
  state: DebugTaskState;
  priority: number | null;
  coreAffinity: number | null;
  runningCore: number | null;
}

export interface DebugTaskSnapshot {
  availability: 'available' | 'unavailable';
  reason: DebugTaskSnapshotReason;
  tasks: DebugTask[];
}

export interface DebugInspectionSnapshot {
  selectedThreadId?: number | null;
  threads?: DebugThread[];
  /**
   * Read-only RTOS metadata. Tasks are not GDB hardware threads and cannot be
   * selected with the hardware-thread debugging command.
   */
  taskSnapshot?: DebugTaskSnapshot;
  selectedFrame: number;
  stack: DebugStackFrame[];
  variables: DebugVariable[];
  watches: DebugWatch[];
}

export interface DebugRegisterSnapshot {
  offset: number;
  total: number;
  registers: Array<{
    number: number;
    name: string;
    value: string | null;
  }>;
}

export interface DebugMemoryCapabilities {
  maxReadBytes: number;
  source: 'artifact-memory-map' | 'legacy-target-profile' | 'unavailable';
  regions: Array<{
    id: string;
    label: string;
    startAddress: string;
    endAddress: string;
    attributes?: 'r' | 'rw' | 'rx' | 'rwx';
  }>;
}

export interface DebugMemoryReadRequest {
  regionId: string;
  address: string;
  length: number;
}

export interface DebugMemoryReadResult extends DebugMemoryReadRequest {
  dataHex: string;
}

export interface DebugVariableTreeNode {
  handle: string | null;
  name: string;
  value: string | null;
  type: string | null;
  depth: number;
  childCount: number;
  hasChildren: boolean;
  expandable: boolean;
  available: boolean;
  error: string | null;
}

export interface DebugVariableTreeSnapshot {
  frameLevel: number;
  maxDepth: number;
  maxChildrenPerPage: number;
  maxTotalNodes: number;
  totalNodes: number;
  truncated: boolean;
  roots: DebugVariableTreeNode[];
}

export interface DebugVariableChildrenPage {
  parentHandle: string;
  offset: number;
  total: number;
  totalNodes: number;
  hasMore: boolean;
  truncated: boolean;
  children: DebugVariableTreeNode[];
}

export interface DebugConfigurationBreakpoint {
  configurationId: number;
  location: DebugBreakpointLocation;
  active: boolean;
}

export interface DebugConfigurationWatch {
  configurationId: number;
  expression: string;
  active: boolean;
}

export interface DebugConfigurationSnapshot {
  revision: number;
  restoreRequired: boolean;
  breakpoints: DebugConfigurationBreakpoint[];
  watches: DebugConfigurationWatch[];
}

export interface DebugConfigurationRestoreReport {
  configuration: DebugConfigurationSnapshot;
  debug: DebugSessionSnapshot;
  breakpoints: Array<{
    configurationId: number;
    location: DebugBreakpointLocation;
    status: 'restored' | 'already-active' | 'failed';
    error: string | null;
  }>;
  watches: Array<{
    configurationId: number;
    expression: string;
    status: 'restored' | 'already-active' | 'failed';
    error: string | null;
  }>;
}

export interface SimulatorSessionView {
  session: {
    sessionId: string;
    state: SimulatorSessionState;
    sceneRevision: string | null;
    sequence: number;
    lastError: string | null;
    runtimeCrash: RuntimeCrashEvent | null;
    recoveryCount: number;
    disposed: boolean;
  };
  runtime: {
    prepared: boolean;
    processId: number | null;
    debugAvailable: boolean;
    debug: DebugSessionSnapshot;
    debugConfiguration: DebugConfigurationSnapshot;
  } | null;
}

export interface SceneCompileResult {
  manifest: SimulationManifest | null;
  report: {
    supported: boolean;
    boardModel: string | null;
    componentCount: number;
    connectionCount: number;
    netCount: number;
    blockers: Array<{ code: string; message: string }>;
    warnings: Array<{ code: string; message: string }>;
    capabilities: Array<{
      id: string;
      status: 'supported' | 'render-only' | 'unsupported';
      detail: string;
      references: string[];
    }>;
  };
}

export interface SimulatorGatewayConnection {
  baseUrl: string;
  accessToken: string;
}

export class SimulatorGatewayError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SimulatorGatewayError';
  }
}

export class SimulatorGatewayClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;

  constructor(connection: SimulatorGatewayConnection) {
    const baseUrl = new URL(connection.baseUrl);
    if (
      baseUrl.protocol !== 'http:'
      || (
        baseUrl.hostname !== '127.0.0.1'
        && baseUrl.hostname !== 'localhost'
        && baseUrl.hostname !== '[::1]'
      )
    ) {
      throw new Error('Simulator Gateway 必须使用本机 HTTP loopback 地址。');
    }
    if (connection.accessToken.length < 32) {
      throw new Error('Simulator Gateway Token 长度不足。');
    }
    this.baseUrl = baseUrl.origin;
    this.accessToken = connection.accessToken;
  }

  compileScene(
    artifact: SimulationArtifact,
    connectionGraph: unknown,
    sceneId?: string,
    signal?: AbortSignal,
  ): Promise<SceneCompileResult> {
    return this.requestJson('POST', '/v1/scenes/compile', {
      artifact,
      connectionGraph,
      ...(sceneId ? { sceneId } : {}),
    }, signal);
  }

  createSession(
    request: {
      sessionId: string;
      artifactDirectory: string;
      artifact: SimulationArtifact;
      manifest: SimulationManifest;
    },
    signal?: AbortSignal,
  ): Promise<SimulatorSessionView> {
    return this.requestJson(
      'POST',
      '/v1/sessions',
      request,
      signal,
    );
  }

  command(
    sessionId: string,
    command: 'start' | 'pause' | 'resume' | 'reset' | 'stop',
    signal?: AbortSignal,
  ): Promise<SimulatorSessionView> {
    return this.requestJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/${command}`,
      {},
      signal,
    );
  }

  recover(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SimulatorSessionView> {
    return this.requestJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/recover`,
      {},
      signal,
    );
  }

  invokeDeviceAction(
    sessionId: string,
    request: {
      instanceId: string;
      action: string;
      parameters?: Record<string, string | number | boolean>;
    },
    signal?: AbortSignal,
  ): Promise<{
    instanceId: string;
    action: string;
    changed: boolean;
    state: Record<string, string | number | boolean>;
  }> {
    return this.requestJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/actions`,
      request,
      signal,
    );
  }

  writeUartInput(
    sessionId: string,
    request: {
      uart: number;
      dataEncoding: 'base64';
      dataByteLength: number;
      dataBase64: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    uart: number;
    acceptedBytes: number;
  }> {
    return this.requestJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/uart`,
      request,
      signal,
    );
  }

  connectDebugger(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<DebugSessionSnapshot> {
    return this.requestJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/connect`,
      {},
      signal,
    );
  }

  getDebugConfiguration(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<DebugConfigurationSnapshot> {
    return this.requestJson(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/configuration`,
      undefined,
      signal,
    );
  }

  restoreDebugConfiguration(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<DebugConfigurationRestoreReport> {
    return this.requestJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/configuration/restore`,
      {},
      signal,
    );
  }

  removePendingDebugConfiguration(
    sessionId: string,
    kind: 'breakpoints' | 'watches',
    configurationId: number,
    signal?: AbortSignal,
  ): Promise<DebugConfigurationSnapshot> {
    return this.requestJson(
      'DELETE',
      `/v1/sessions/${encodeURIComponent(sessionId)}`
        + `/debug/configuration/${kind}/${configurationId}`,
      undefined,
      signal,
    );
  }

  addDebugBreakpoint(
    sessionId: string,
    location: DebugBreakpointLocation,
    signal?: AbortSignal,
  ): Promise<DebugSessionSnapshot> {
    return this.requestJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/breakpoints`,
      { location },
      signal,
    );
  }

  removeDebugBreakpoint(
    sessionId: string,
    breakpointId: number,
    signal?: AbortSignal,
  ): Promise<DebugSessionSnapshot> {
    return this.requestJson(
      'DELETE',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/breakpoints/${breakpointId}`,
      undefined,
      signal,
    );
  }

  inspectDebugger(
    sessionId: string,
    frameLevel = 0,
    maxFrames = 20,
    signal?: AbortSignal,
    threadId?: number,
  ): Promise<DebugInspectionSnapshot> {
    return this.requestJson(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/inspection`
        + `?frame=${frameLevel}&maxFrames=${maxFrames}`
        + (threadId === undefined ? '' : `&threadId=${threadId}`),
      undefined,
      signal,
    );
  }

  readDebugRegisters(
    sessionId: string,
    offset = 0,
    limit = 32,
    signal?: AbortSignal,
  ): Promise<DebugRegisterSnapshot> {
    return this.requestJson(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/registers`
        + `?offset=${offset}&limit=${limit}`,
      undefined,
      signal,
    );
  }

  getDebugMemoryCapabilities(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<DebugMemoryCapabilities> {
    return this.requestJson(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/memory`,
      undefined,
      signal,
    );
  }

  readDebugMemory(
    sessionId: string,
    request: DebugMemoryReadRequest,
    signal?: AbortSignal,
  ): Promise<DebugMemoryReadResult> {
    return this.requestJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/memory/read`,
      request,
      signal,
    );
  }

  listDebugVariables(
    sessionId: string,
    frameLevel = 0,
    limit = 32,
    signal?: AbortSignal,
  ): Promise<DebugVariableTreeSnapshot> {
    return this.requestJson(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/variables`
        + `?frame=${frameLevel}&limit=${limit}`,
      undefined,
      signal,
    );
  }

  expandDebugVariable(
    sessionId: string,
    handle: string,
    offset = 0,
    limit = 32,
    signal?: AbortSignal,
  ): Promise<DebugVariableChildrenPage> {
    return this.requestJson(
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/variables`
        + `/${encodeURIComponent(handle)}/children`
        + `?offset=${offset}&limit=${limit}`,
      undefined,
      signal,
    );
  }

  addDebugWatch(
    sessionId: string,
    expression: string,
    signal?: AbortSignal,
  ): Promise<DebugWatch> {
    return this.requestJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/watches`,
      { expression },
      signal,
    );
  }

  async removeDebugWatch(
    sessionId: string,
    watchId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/watches/${watchId}`,
      undefined,
      signal,
    );
  }

  commandDebugger(
    sessionId: string,
    command:
      | 'continue'
      | 'interrupt'
      | 'step-into'
      | 'step-over'
      | 'disconnect',
    signal?: AbortSignal,
  ): Promise<DebugSessionSnapshot> {
    return this.requestJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/${command}`,
      {},
      signal,
    );
  }

  runDebuggerToBlock(
    sessionId: string,
    target: {
      blockId: string;
      sourceMapRevision: string;
    },
    signal?: AbortSignal,
  ): Promise<DebugBlockCommandResult> {
    return this.requestJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/run-to-block`,
      target,
      signal,
    );
  }

  stepDebuggerToBlock(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<DebugBlockCommandResult> {
    return this.requestJson(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/debug/step-block`,
      {},
      signal,
    );
  }

  async deleteSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      undefined,
      signal,
    );
  }

  async streamEvents(
    sessionId: string,
    options: {
      signal: AbortSignal;
      onEvent(event: RuntimeEnvelope): void | Promise<void>;
      afterSequence?: number;
      expectedSceneRevision?: string;
      onDiscardedEvent?(event: {
        reason: 'duplicate' | 'late';
        sequence: number;
        lastAcceptedSequence: number;
      }): void;
      onSequenceGap?(gap: {
        expectedSequence: number;
        receivedSequence: number;
        resync: boolean;
      }): void;
      reconnect?: boolean;
    },
  ): Promise<number> {
    let afterSequence = options.afterSequence;
    let sceneRevision = options.expectedSceneRevision;
    let lastSimulationTimeNs: number | undefined;
    if (
      sceneRevision !== undefined
      && !isLowercaseSha256(sceneRevision)
    ) {
      throw new SimulatorGatewayError(
        400,
        'invalid_scene_revision',
        'expectedSceneRevision 必须是小写 SHA-256 哈希。',
      );
    }
    let reconnectDelay = 250;
    while (!options.signal.aborted) {
      try {
        const query = afterSequence === undefined
          ? ''
          : `?after=${afterSequence}`;
        const response = await fetch(this.url(
          `/v1/sessions/${encodeURIComponent(sessionId)}/events${query}`,
        ), {
          method: 'GET',
          headers: this.headers(false),
          cache: 'no-store',
          signal: options.signal,
        });
        await requireSuccessfulResponse(response);
        if (!response.body) {
          throw new SimulatorGatewayError(
            502,
            'missing_event_stream',
            'Gateway 未返回事件流。',
          );
        }
        reconnectDelay = 250;
        for await (const event of parseSseEvents(
          response.body,
          options.signal,
        )) {
          const envelope = requireRuntimeEnvelope(event.data, sessionId);
          requireMatchingSseSequence(event.id, envelope.sequence);
          if (sceneRevision === undefined) {
            sceneRevision = envelope.sceneRevision;
          } else if (envelope.sceneRevision !== sceneRevision) {
            throw new SimulatorGatewayError(
              409,
              'scene_revision_mismatch',
              'Gateway 事件的连线图 revision 在同一 Session 内发生了变化。',
            );
          }
          if (
            afterSequence !== undefined
            && envelope.sequence <= afterSequence
          ) {
            options.onDiscardedEvent?.({
              reason: envelope.sequence === afterSequence
                ? 'duplicate'
                : 'late',
              sequence: envelope.sequence,
              lastAcceptedSequence: afterSequence,
            });
            continue;
          }
          if (
            afterSequence !== undefined
            && envelope.sequence > afterSequence + 1
          ) {
            const resync = envelope.type === 'stream.resync';
            options.onSequenceGap?.({
              expectedSequence: afterSequence + 1,
              receivedSequence: envelope.sequence,
              resync,
            });
            if (!resync) {
              throw new SimulatorGatewayError(
                502,
                'event_sequence_gap',
                `Gateway 事件序号从 ${afterSequence} 跳到了 ${envelope.sequence}。`,
              );
            }
          }
          if (
            lastSimulationTimeNs !== undefined
            && envelope.simulationTimeNs < lastSimulationTimeNs
          ) {
            throw new SimulatorGatewayError(
              502,
              'simulation_time_regression',
              'Gateway 仿真时间发生了倒退。',
            );
          }
          await options.onEvent(envelope);
          afterSequence = envelope.sequence;
          lastSimulationTimeNs = envelope.simulationTimeNs;
        }
        if (options.reconnect === false) break;
      } catch (error) {
        if (options.signal.aborted || isAbortError(error)) break;
        if (
          options.reconnect === false
          || (
            error instanceof SimulatorGatewayError
            && error.statusCode >= 400
            && error.statusCode < 500
          )
        ) {
          throw error;
        }
      }
      await abortableDelay(reconnectDelay, options.signal);
      reconnectDelay = Math.min(5_000, reconnectDelay * 2);
    }
    return afterSequence ?? 0;
  }

  private async requestJson<T>(
    method: string,
    pathname: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.request(method, pathname, body, signal);
    return await response.json() as T;
  }

  private async request(
    method: string,
    pathname: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await fetch(this.url(pathname), {
      method,
      headers: this.headers(body !== undefined),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
    await requireSuccessfulResponse(response);
    return response;
  }

  private headers(json: boolean): Headers {
    const headers = new Headers({
      Authorization: `Bearer ${this.accessToken}`,
      Accept: 'application/json',
    });
    if (json) headers.set('Content-Type', 'application/json');
    return headers;
  }

  private url(pathname: string): string {
    return new URL(pathname, `${this.baseUrl}/`).toString();
  }
}

async function* parseSseEvents(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ id: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = block.split('\n');
        const ids = lines
          .filter((line) => line.startsWith('id:'))
          .map((line) => line.slice(3).replace(/^ /, ''));
        const id = ids[ids.length - 1] ?? '';
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield { id, data };
        boundary = buffer.indexOf('\n\n');
      }
      if (result.done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function requireRuntimeEnvelope(
  data: string,
  sessionId: string,
): RuntimeEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new SimulatorGatewayError(
      502,
      'invalid_event',
      'Gateway 返回了无效事件。',
    );
  }
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
  ) {
    throw new SimulatorGatewayError(
      502,
      'invalid_event',
      'Gateway 返回了无效事件结构。',
    );
  }
  const envelope = value as Partial<RuntimeEnvelope>;
  if (
    envelope.protocolVersion !== 1
    || envelope.direction !== 'event'
    || typeof envelope.type !== 'string'
    || envelope.sessionId !== sessionId
    || !isLowercaseSha256(envelope.sceneRevision)
    || !Number.isSafeInteger(envelope.sequence)
    || Number(envelope.sequence) < 1
    || !Number.isSafeInteger(envelope.simulationTimeNs)
    || Number(envelope.simulationTimeNs) < 0
    || !Object.prototype.hasOwnProperty.call(envelope, 'payload')
  ) {
    throw new SimulatorGatewayError(
      502,
      'invalid_event',
      'Gateway 事件协议不匹配。',
    );
  }
  return envelope as RuntimeEnvelope;
}

function requireMatchingSseSequence(
  id: string,
  envelopeSequence: number,
): void {
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new SimulatorGatewayError(
      502,
      'invalid_event_id',
      'Gateway SSE 事件缺少有效 id。',
    );
  }
  const sequence = Number(id);
  if (!Number.isSafeInteger(sequence) || sequence !== envelopeSequence) {
    throw new SimulatorGatewayError(
      502,
      'event_id_mismatch',
      'Gateway SSE id 与事件 envelope 序号不一致。',
    );
  }
}

function isLowercaseSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

async function requireSuccessfulResponse(response: Response): Promise<void> {
  if (response.ok) return;
  let code = 'gateway_error';
  let message = `Gateway 请求失败（HTTP ${response.status}）。`;
  try {
    const body = await response.json() as {
      error?: { code?: unknown; message?: unknown };
    };
    if (typeof body.error?.code === 'string') code = body.error.code;
    if (typeof body.error?.message === 'string') message = body.error.message;
  } catch {
    // Keep the HTTP fallback.
  }
  throw new SimulatorGatewayError(response.status, code, message);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function decodeGatewayBase64(payload: unknown): string {
  if (
    typeof payload !== 'object'
    || payload === null
    || Array.isArray(payload)
  ) {
    return '';
  }
  const dataBase64 = (payload as { dataBase64?: unknown }).dataBase64;
  if (typeof dataBase64 !== 'string') return '';
  const binary = atob(dataBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeGatewayBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 1) {
    binary += String.fromCharCode(bytes[offset]!);
  }
  return btoa(binary);
}
