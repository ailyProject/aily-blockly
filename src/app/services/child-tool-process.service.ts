import { Injectable, OnDestroy } from '@angular/core';
import { ChildToolConfig, getChildToolConfig } from '../configs/tool.config';
import { ConfigService } from './config.service';
import { ProjectService } from './project.service';
import { appendProjectLog, type ProjectLogLevel } from '../utils/project-log.utils';
import { BehaviorSubject, distinctUntilChanged, map, type Observable } from 'rxjs';
import { classifyRecordedChildToolRuntimeEntry } from './child-tool-runtime-entry';

export interface ChildToolHostInfo {
  url: string;
  origin?: string;
  wsUrl?: string;
  persistent?: boolean;
  shutdownUrl?: string;
  port?: number;
  pid?: number;
  apiServer?: string;
  /** Package-relative Node entry used to start this Runtime. */
  entry?: string;
  /** Absolute package root used as cwd for this Runtime. */
  packagePath?: string;
}

export type ChildToolRuntimeState = 'unknown' | 'starting' | 'ready' | 'stopped' | 'error';

export interface ChildToolRuntimeSnapshot {
  toolId: string;
  state: ChildToolRuntimeState;
  running: boolean;
  refCount: number;
  hostInfo: ChildToolHostInfo | null;
  error?: string;
  updatedAt: number;
}

export interface ChildToolProcessMessageEvent {
  toolId: string;
  streamId: string;
  message: Record<string, unknown>;
}

interface ChildToolBackendMessage {
  event?: string;
  data?: any;
}

interface ChildToolSession {
  leaseId: string;
  streamId: string;
  stdoutBuffer: string;
  stderrBuffer: string;
  removeListener: (() => void) | null;
  startPromise: Promise<ChildToolHostInfo> | null;
  readyResolve: ((value: ChildToolHostInfo) => void) | null;
  readyReject: ((reason?: any) => void) | null;
  running: boolean;
  hostInfo: ChildToolHostInfo | null;
  refCount: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  expectedStopReason: 'release' | 'restart' | 'shutdown' | null;
}

@Injectable({
  providedIn: 'root'
})
export class ChildToolProcessService implements OnDestroy {
  private sessions = new Map<string, ChildToolSession>();
  private readonly releaseGraceMs = 15000;
  private readonly runtimeSnapshots = new Map<string, ChildToolRuntimeSnapshot>();
  private readonly runtimeStatesSubject = new BehaviorSubject<readonly ChildToolRuntimeSnapshot[]>([]);
  private readonly processMessageListeners = new Map<
    string,
    Set<(message: Record<string, unknown>) => void>
  >();
  private removeProcessMessageListener: (() => void) | null = null;
  readonly runtimeStates$ = this.runtimeStatesSubject.asObservable();

  constructor(
    private configService: ConfigService,
    private projectService: ProjectService,
  ) {}

  async acquire(toolId: string): Promise<ChildToolHostInfo> {
    const config = this.requireConfig(toolId);
    if (config.runtime?.processMessagePort) {
      if (
        !window['childToolSession']?.sendMessage
        || !window['childToolSession']?.onMessage
      ) {
        throw new Error('Electron child tool process message bridge is not available');
      }
      this.ensureProcessMessageListener();
    }
    const session = this.ensureSession(config.id);
    this.cancelReleaseTimer(session);
    session.refCount += 1;
    this.publishRuntimeState(
      config.id,
      session.running && session.hostInfo ? 'ready' : 'starting',
      session,
    );

    try {
      const hostInfo = await this.startSession(config, session);
      this.publishRuntimeState(config.id, 'ready', session);
      return hostInfo;
    } catch (error) {
      session.refCount = Math.max(0, session.refCount - 1);
      this.publishRuntimeState(config.id, 'error', session, error);
      throw error;
    }
  }

  async release(toolId: string): Promise<void> {
    const config = getChildToolConfig(toolId);
    const session = this.sessions.get(toolId);
    if (!config || !session) return;

    session.refCount = Math.max(0, session.refCount - 1);
    this.publishRuntimeState(
      config.id,
      session.running && session.hostInfo ? 'ready' : 'stopped',
      session,
    );
    if (session.refCount === 0) {
      this.scheduleRelease(config, session);
    }
  }

  async restart(toolId: string): Promise<ChildToolHostInfo> {
    const config = this.requireConfig(toolId);
    const session = this.ensureSession(config.id);
    this.cancelReleaseTimer(session);
    this.publishRuntimeState(config.id, 'starting', session);
    try {
      await this.forceStopSession(config, session, 'restart');
      const hostInfo = await this.startSession(config, session);
      this.publishRuntimeState(config.id, 'ready', session);
      return hostInfo;
    } catch (error) {
      this.publishRuntimeState(config.id, 'error', session, error);
      throw error;
    }
  }

  async stop(toolId: string): Promise<void> {
    const config = getChildToolConfig(toolId);
    const session = this.sessions.get(toolId);
    if (config && session) {
      this.cancelReleaseTimer(session);
      await this.stopSession(config, session, 'shutdown');
      this.sessions.delete(toolId);
      this.publishRuntimeState(config.id, 'stopped', session);
      return;
    }
    await window['childToolSession']?.stop?.(config?.id || toolId);
    this.publishRuntimeState(config?.id || toolId, 'stopped');
  }

  async forceStop(toolId: string): Promise<void> {
    const config = getChildToolConfig(toolId);
    const normalizedToolId = config?.id || toolId;
    const session = this.sessions.get(normalizedToolId);
    if (config && session) {
      this.cancelReleaseTimer(session);
      await this.forceStopSession(config, session, 'shutdown');
      this.sessions.delete(normalizedToolId);
      this.publishRuntimeState(normalizedToolId, 'stopped', session);
      return;
    }

    const result = await window['childToolSession']?.stop?.(normalizedToolId);
    if (result?.success !== true && result?.reason !== 'not-found') {
      throw new Error(`${normalizedToolId} related process tree could not be stopped`);
    }
    this.publishRuntimeState(normalizedToolId, 'stopped');
  }

  async stopAll(): Promise<void> {
    const entries = Array.from(this.sessions.entries());
    for (const [toolId, session] of entries) {
      const config = getChildToolConfig(toolId);
      if (config) {
        this.cancelReleaseTimer(session);
        await this.stopSession(config, session, 'shutdown');
      }
      this.sessions.delete(toolId);
      this.publishRuntimeState(toolId, 'stopped', session);
    }
  }

  observeRuntime(toolId: string): Observable<ChildToolRuntimeSnapshot> {
    const id = String(toolId || '').trim();
    return this.runtimeStates$.pipe(
      map(() => this.getRuntimeSnapshot(id)),
      distinctUntilChanged((previous, current) =>
        previous.state === current.state
        && previous.running === current.running
        && previous.refCount === current.refCount
        && previous.hostInfo?.url === current.hostInfo?.url
        && previous.error === current.error),
    );
  }

  getRuntimeSnapshot(toolId: string): ChildToolRuntimeSnapshot {
    const id = String(toolId || '').trim();
    return this.runtimeSnapshots.get(id) || {
      toolId: id,
      state: 'unknown',
      running: false,
      refCount: 0,
      hostInfo: null,
      updatedAt: 0,
    };
  }

  onMessage(
    toolId: string,
    listener: (message: Record<string, unknown>) => void,
  ): () => void {
    const config = this.requireConfig(toolId);
    if (!config.runtime?.processMessagePort) {
      throw new Error(`Child tool does not declare a process message port: ${toolId}`);
    }
    if (typeof listener !== 'function') {
      throw new TypeError('Child tool process message listener must be a function');
    }
    this.ensureProcessMessageListener();
    let listeners = this.processMessageListeners.get(config.id);
    if (!listeners) {
      listeners = new Set();
      this.processMessageListeners.set(config.id, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.processMessageListeners.delete(config.id);
    };
  }

  async sendMessage(toolId: string, message: Record<string, unknown>): Promise<void> {
    const config = this.requireConfig(toolId);
    if (!config.runtime?.processMessagePort) {
      throw new Error(`Child tool does not declare a process message port: ${toolId}`);
    }
    const session = this.sessions.get(config.id);
    if (!session?.running || !session.streamId) {
      throw new Error(`Child tool process message port is not ready: ${toolId}`);
    }
    const result = await window['childToolSession']?.sendMessage?.({
      toolId: config.id,
      streamId: session.streamId,
      leaseId: session.leaseId,
      message,
    });
    if (!result?.success) {
      throw new Error(
        `Child tool process message failed: ${result?.reason || 'message-port-unavailable'}`,
      );
    }
  }

  ngOnDestroy(): void {
    this.removeProcessMessageListener?.();
    this.removeProcessMessageListener = null;
    this.processMessageListeners.clear();
    void this.stopAll();
  }

  private requireConfig(toolId: string): ChildToolConfig {
    const config = getChildToolConfig(toolId);
    if (!config) {
      throw new Error(`Child tool is not registered: ${toolId}`);
    }
    return config;
  }

  private ensureSession(toolId: string): ChildToolSession {
    let session = this.sessions.get(toolId);
    if (!session) {
      session = {
        leaseId: this.createLeaseId(toolId),
        streamId: '',
        stdoutBuffer: '',
        stderrBuffer: '',
        removeListener: null,
        startPromise: null,
        readyResolve: null,
        readyReject: null,
        running: false,
        hostInfo: null,
        refCount: 0,
        releaseTimer: null,
        expectedStopReason: null
      };
      this.sessions.set(toolId, session);
    }
    return session;
  }

  private scheduleRelease(config: ChildToolConfig, session: ChildToolSession): void {
    if (session.releaseTimer) {
      return;
    }

    this.log(config, 'release scheduled', {
      graceMs: this.releaseGraceMs,
      port: session.hostInfo?.port,
      pid: session.hostInfo?.pid
    });

    session.releaseTimer = setTimeout(() => {
      session.releaseTimer = null;
      if (session.refCount > 0) {
        return;
      }

      void this.stopSession(config, session, 'release').finally(() => {
        if (session.refCount === 0) {
          this.sessions.delete(config.id);
        }
      });
    }, this.releaseGraceMs);
  }

  private cancelReleaseTimer(session: ChildToolSession): void {
    if (!session.releaseTimer) {
      return;
    }

    clearTimeout(session.releaseTimer);
    session.releaseTimer = null;
  }

  private async startSession(config: ChildToolConfig, session: ChildToolSession): Promise<ChildToolHostInfo> {
    if (session.running && session.hostInfo) {
      return session.hostInfo;
    }

    if (!session.startPromise) {
      session.startPromise = this.startOrAcquireSession(config, session);
    }

    const startPromise = session.startPromise;
    try {
      return await startPromise;
    } finally {
      if (session.startPromise === startPromise) {
        session.startPromise = null;
      }
    }
  }

  private async startOrAcquireSession(
    config: ChildToolConfig,
    session: ChildToolSession,
  ): Promise<ChildToolHostInfo> {
    const sharedHostInfo = await this.acquireSharedSession(config, session);
    if (sharedHostInfo) {
      return sharedHostInfo;
    }

    return await this.startServer(config, session);
  }

  private async stopSession(
    config: ChildToolConfig,
    session: ChildToolSession,
    reason: 'release' | 'restart' | 'shutdown' = 'release'
  ): Promise<void> {
    const streamId = session.streamId;
    if (!streamId && !session.running) {
      this.publishRuntimeState(config.id, reason === 'restart' ? 'starting' : 'stopped', session);
      return;
    }

    session.expectedStopReason = reason;
    try {
      this.rejectReady(session, new Error(`${config.id} startup stopped: ${reason}`));
      if (streamId) {
        const result = await window['childToolSession']?.release?.({
          toolId: config.id,
          streamId,
          leaseId: session.leaseId,
        });
        if (!result?.success && result?.reason !== 'lease-not-found') {
          await window['cmd']?.kill?.(streamId);
        }
      }
    } finally {
      this.handleClose(session);
      this.publishRuntimeState(config.id, reason === 'restart' ? 'starting' : 'stopped', session);
    }
  }

  private async forceStopSession(
    config: ChildToolConfig,
    session: ChildToolSession,
    reason: 'restart' | 'shutdown'
  ): Promise<void> {
    const streamId = session.streamId;
    session.expectedStopReason = reason;
    this.rejectReady(session, new Error(`${config.id} startup stopped: ${reason}`));

    const stopGlobally = () => reason === 'restart'
      ? window['childToolSession']?.restart?.(config.id)
      : window['childToolSession']?.stop?.(config.id);

    let result: any;
    try {
      result = await stopGlobally();
    } catch (error) {
      this.logError(config, 'global process-tree stop failed', error);
    }

    if (result?.success !== true && result?.reason !== 'not-found' && streamId) {
      await window['cmd']?.kill?.(streamId);
      try {
        result = await stopGlobally();
      } catch (error) {
        this.logError(config, 'global process-tree stop verification failed', error);
      }
    }

    if (result?.success !== true && result?.reason !== 'not-found') {
      session.expectedStopReason = null;
      throw new Error(`${config.id} related process tree could not be stopped`);
    }

    this.handleClose(session);
    this.publishRuntimeState(config.id, reason === 'restart' ? 'starting' : 'stopped', session);
  }

  private async acquireSharedSession(config: ChildToolConfig, session: ChildToolSession): Promise<ChildToolHostInfo | null> {
    const sharedSession = await window['childToolSession']?.acquire?.({
      toolId: config.id,
      leaseId: session.leaseId,
    });
    const hostInfo = sharedSession?.hostInfo as ChildToolHostInfo | undefined;
    if (!hostInfo?.url) {
      return null;
    }

    const selectedApiServer = this.selectedApiServerFor(config);
    const sharedApiServer = this.normalizeApiServer(hostInfo.apiServer);
    if (selectedApiServer && sharedApiServer !== selectedApiServer) {
      this.log(config, 'discard shared session with stale service region', {
        selectedApiServer,
        sharedApiServer: sharedApiServer || null,
        streamId: String(sharedSession.streamId || ''),
      });
      await window['childToolSession']?.restart?.(config.id);
      return null;
    }

    if (await this.sharedSessionUsesStaleEntry(config, hostInfo, String(sharedSession.streamId || ''))) {
      this.log(config, 'discard shared session with stale package entry', {
        expectedEntry: config.entry || 'index.js',
        packagePath: config.packagePath || null,
        streamId: String(sharedSession.streamId || ''),
      });
      await window['childToolSession']?.restart?.(config.id);
      return null;
    }

    session.streamId = String(sharedSession.streamId || '');
    session.hostInfo = hostInfo;
    session.running = true;
    this.publishRuntimeState(config.id, 'ready', session);
    this.log(config, 'shared session acquired', this.sanitizeHostInfo(hostInfo));
    return hostInfo;
  }

  private async sharedSessionUsesStaleEntry(
    config: ChildToolConfig,
    hostInfo: ChildToolHostInfo,
    streamId: string,
  ): Promise<boolean> {
    const expectedEntry = String(config.entry || 'index.js').replace(/\\/g, '/');
    const recordedEntry = String(hostInfo.entry || '').replace(/\\/g, '/');
    const recordedPackagePath = String(hostInfo.packagePath || '').replace(/\\/g, '/');
    const expectedPackagePath = String(config.packagePath || '').replace(/\\/g, '/');
    const recordedEntryState = classifyRecordedChildToolRuntimeEntry({
      expectedEntry,
      expectedPackagePath,
      recordedEntry,
      recordedPackagePath,
    });
    if (recordedEntryState === 'stale') return true;
    // Modern registrations carry both canonical fields. Trust that metadata:
    // Electron's process inventory may expose only `command: "node"`, without
    // argv, so applying the legacy command-string fallback here would falsely
    // restart a healthy shared Runtime every time another renderer attaches.
    if (recordedEntryState === 'current') return false;

    try {
      const listed = await window['childToolSession']?.list?.();
      const rows = Array.isArray(listed) ? listed : [];
      const row = rows.find((item: any) => String(item?.toolId || '') === config.id
        || String(item?.streamId || '') === streamId);
      const command = String(row?.command || '').replace(/\\/g, '/');
      if (!command) return false;
      // Older persistent Runtimes were started as .../server/index.js before the
      // package-root index.js supervisor entry. Reuse would keep a dead UI.
      if (command.includes(`/${expectedEntry} `) || command.endsWith(`/${expectedEntry}`)) {
        return false;
      }
      if (expectedEntry === 'index.js' && /\/server\/index\.js(?:\s|$)/.test(command)) {
        return true;
      }
      if (expectedPackagePath && !command.includes(expectedPackagePath)) {
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private async startServer(config: ChildToolConfig, session: ChildToolSession): Promise<ChildToolHostInfo> {
    const cmd = window['cmd'];
    const pathApi = window['path'];
    const fsApi = window['fs'];

    if (!cmd?.run || !cmd?.onData) {
      throw new Error('Electron command bridge is not available');
    }
    if (
      config.runtime?.processMessagePort
      && (
        !window['childToolSession']?.sendMessage
        || !window['childToolSession']?.onMessage
      )
    ) {
      throw new Error('Electron child tool process message bridge is not available');
    }
    this.ensureProcessMessageListener();

    if (!pathApi?.getAilyChildPath || !pathApi?.join) {
      throw new Error('Aily child path API is not available');
    }

    const childPath = pathApi.getAilyChildPath();
    const childDir = config.childDir || pathApi.join('tools', config.id);
    const projectPath = config.packagePath || pathApi.join(childPath, childDir);
    const scriptPath = pathApi.join(projectPath, config.entry || 'index.js');
    const uiPath = pathApi.join(projectPath, config.uiIndex || pathApi.join('ui', 'index.html'));
    const hostApiServer = this.normalizeApiServer(this.configService.getCurrentApiServer());
    if (this.requiresSelectedApiServer(config) && !hostApiServer) {
      throw new Error(`${config.id} requires the API server selected by the host service-region dialog`);
    }

    this.log(config, 'resolve paths', {
      childPath,
      childDir,
      projectPath,
      scriptPath,
      uiPath
    });

    if (fsApi?.existsSync && !fsApi.existsSync(scriptPath)) {
      const message = `${config.id} backend was not found: ${scriptPath}`;
      this.logError(config, 'backend missing', message);
      throw new Error(message);
    }

    if (fsApi?.existsSync && !fsApi.existsSync(uiPath)) {
      const message = `${config.id} UI was not found: ${uiPath}`;
      this.logError(config, 'UI missing', message);
      throw new Error(message);
    }

    const streamId = `child_tool_${config.id.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    session.streamId = streamId;
    session.expectedStopReason = null;
    session.stdoutBuffer = '';
    session.stderrBuffer = '';
    this.log(config, 'spawn server', {
      command: 'node',
      args: [scriptPath, 'serve', '--host', '127.0.0.1', '--port', '0'],
      cwd: projectPath,
      streamId
    });

    const readyPromise = new Promise<ChildToolHostInfo>((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.readyResolve = null;
        session.readyReject = null;
        const reason = `${config.id} server did not report ready${this.formatBufferedStderr(session)}`;
        this.logError(config, 'ready timeout', reason);
        reject(new Error(reason));
      }, config.startupTimeoutMs || 8000);

      session.readyResolve = value => {
        clearTimeout(timeout);
        resolve(value);
      };
      session.readyReject = reason => {
        clearTimeout(timeout);
        reject(reason);
      };
    });

    session.removeListener = cmd.onData(streamId, (output: any) => {
      this.handleProcessOutput(config, session, streamId, output);
    });

    try {
      const result = await cmd.run({
        command: 'node',
        args: [scriptPath, 'serve', '--host', '127.0.0.1', '--port', '0'],
        cwd: projectPath,
        streamId,
        shellProfile: false,
        ...(config.runtime?.processMessagePort
          ? { messagePort: config.runtime.processMessagePort }
          : {}),
        env: {
          AILY_CHILD_TOOL: '1',
          AILY_CHILD_TOOL_ID: config.id,
          ...(config.env || {}),
          ...(hostApiServer ? { AILY_API_SERVER: hostApiServer } : {})
        }
      });

      if (!result?.success) {
        const message = result?.error || `Failed to start ${config.id} server`;
        this.logError(config, 'spawn failed', {
          message,
          result
        });
        throw new Error(message);
      }

      const hostInfo = await readyPromise;
      if (session.streamId !== streamId) {
        throw new Error(`${config.id} startup was superseded before registration`);
      }
      const registeredHostInfo: ChildToolHostInfo = {
        ...hostInfo,
        ...(hostApiServer ? { apiServer: hostApiServer } : {}),
        entry: config.entry || 'index.js',
        packagePath: projectPath,
      };
      session.hostInfo = registeredHostInfo;
      const registered = await window['childToolSession']?.register?.({
        toolId: config.id,
        hostInfo: registeredHostInfo,
        streamId,
        leaseId: session.leaseId,
      });
      if (registered && registered.success !== true) {
        throw new Error(`${config.id} Runtime registration failed: ${registered.reason || 'unknown error'}`);
      }
      this.log(config, 'server ready promise resolved', this.sanitizeHostInfo(registeredHostInfo));
      return registeredHostInfo;
    } catch (error) {
      this.rejectReady(session, error);
      await readyPromise.catch(() => undefined);
      await this.cleanupFailedStart(config, session, streamId);
      throw error;
    }
  }

  private async cleanupFailedStart(
    config: ChildToolConfig,
    session: ChildToolSession,
    streamId: string,
  ): Promise<void> {
    this.log(config, 'failed startup cleanup', { streamId });
    try {
      await window['childToolSession']?.unregister?.({
        toolId: config.id,
        streamId,
      });
    } catch {
      // Registration may not have happened yet.
    }
    try {
      await window['cmd']?.kill?.(streamId);
    } finally {
      if (session.streamId === streamId) {
        this.handleClose(session);
        this.publishRuntimeState(config.id, 'error', session, `${config.id} failed to start`);
      }
    }
  }

  private handleProcessOutput(
    config: ChildToolConfig,
    session: ChildToolSession,
    streamId: string,
    output: any,
  ): void {
    if (!output) return;
    if (session.streamId !== streamId) {
      this.log(config, 'ignored stale backend event', {
        streamId,
        type: output.type,
      });
      return;
    }

    if (output.type === 'stdout' && output.data) {
      this.consumeStdout(config, session, output.data);
      return;
    }

    if (output.type === 'stderr' && output.data) {
      session.stderrBuffer += String(output.data);
      this.logError(config, 'stderr', this.tailText(String(output.data)));
      return;
    }

    if (output.type === 'error') {
      const reason = output.error || `${config.id} server process error`;
      this.logError(config, 'process error', reason);
      this.rejectReady(session, reason);
      this.handleClose(session);
      this.publishRuntimeState(config.id, 'error', session, reason);
      return;
    }

    if (output.type === 'close') {
      const expectedStopReason = session.expectedStopReason;
      const reason = `${config.id} server closed with code ${output.code ?? 'unknown'}${this.formatBufferedStderr(session)}`;
      const details = {
        code: output.code,
        signal: output.signal,
        expectedStopReason,
        reason
      };

      if (expectedStopReason) {
        this.logExpectedStop(config, details);
        this.rejectReady(session, reason);
      } else if (session.readyReject || (session.running && session.refCount > 0)) {
        this.logError(config, 'process closed', details);
        this.rejectReady(session, reason);
      } else {
        this.log(config, 'process closed', details);
      }
      this.handleClose(session);
      this.publishRuntimeState(
        config.id,
        expectedStopReason === 'restart'
          ? 'starting'
          : expectedStopReason
            ? 'stopped'
            : 'error',
        session,
        expectedStopReason ? undefined : reason,
      );
      void window['childToolSession']?.unregister?.({
        toolId: config.id,
        streamId
      });
    }
  }

  private consumeStdout(config: ChildToolConfig, session: ChildToolSession, chunk: string): void {
    session.stdoutBuffer += chunk;
    const lines = session.stdoutBuffer.split(/\r?\n/);
    session.stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.handleBackendMessage(config, session, JSON.parse(trimmed));
      } catch {
        this.log(config, 'stdout', trimmed);
      }
    }
  }

  private handleBackendMessage(config: ChildToolConfig, session: ChildToolSession, message: ChildToolBackendMessage): void {
    if (message.event === 'ready' && message.data?.url) {
      session.hostInfo = message.data as ChildToolHostInfo;
      session.running = true;
      this.publishRuntimeState(config.id, 'ready', session);
      this.log(config, 'backend event: ready', this.sanitizeHostInfo(session.hostInfo));
      this.resolveReady(session, session.hostInfo);
      return;
    }

    if (message.event === 'fatal') {
      const error = message.data?.message || `${config.id} server fatal error`;
      this.logError(config, 'backend event: fatal', error);
      this.publishRuntimeState(config.id, 'error', session, error);
      this.rejectReady(session, error);
      return;
    }

    if (message.event) {
      this.log(config, `backend event: ${message.event}`, message.data || {});
    }
  }

  private resolveReady(session: ChildToolSession, value: ChildToolHostInfo): void {
    const resolve = session.readyResolve;
    session.readyResolve = null;
    session.readyReject = null;
    resolve?.(value);
  }

  private rejectReady(session: ChildToolSession, reason: any): void {
    const reject = session.readyReject;
    session.readyResolve = null;
    session.readyReject = null;
    reject?.(reason instanceof Error ? reason : new Error(String(reason)));
  }

  private handleClose(session: ChildToolSession): void {
    if (session.removeListener) {
      session.removeListener();
      session.removeListener = null;
    }

    session.running = false;
    session.streamId = '';
    session.stdoutBuffer = '';
    session.stderrBuffer = '';
    session.hostInfo = null;
    session.expectedStopReason = null;
  }

  private ensureProcessMessageListener(): void {
    if (this.removeProcessMessageListener) return;
    const onMessage = window['childToolSession']?.onMessage;
    if (typeof onMessage !== 'function') return;
    this.removeProcessMessageListener = onMessage(
      (event: ChildToolProcessMessageEvent) => {
        const toolId = String(event?.toolId || '').trim();
        const streamId = String(event?.streamId || '').trim();
        const session = this.sessions.get(toolId);
        if (
          !toolId
          || !streamId
          || !session?.running
          || session.streamId !== streamId
          || !event.message
          || typeof event.message !== 'object'
          || Array.isArray(event.message)
        ) {
          return;
        }
        for (const listener of this.processMessageListeners.get(toolId) || []) {
          try {
            listener(event.message);
          } catch (error) {
            const config = getChildToolConfig(toolId);
            if (config) {
              this.logError(config, 'process message listener failed', error);
            }
          }
        }
      },
    );
  }

  private createLeaseId(toolId: string): string {
    const normalizedToolId = String(toolId || 'child-tool').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${normalizedToolId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private publishRuntimeState(
    toolId: string,
    state: ChildToolRuntimeState,
    session?: ChildToolSession,
    error?: unknown,
  ): void {
    const id = String(toolId || '').trim();
    if (!id) return;

    const snapshot: ChildToolRuntimeSnapshot = {
      toolId: id,
      state,
      running: !!session?.running,
      refCount: session?.refCount || 0,
      hostInfo: session?.hostInfo ? { ...session.hostInfo } : null,
      error: error == null
        ? undefined
        : error instanceof Error
          ? error.message
          : String(error),
      updatedAt: Date.now(),
    };
    this.runtimeSnapshots.set(id, snapshot);
    this.runtimeStatesSubject.next(Array.from(this.runtimeSnapshots.values()));
  }

  private log(config: ChildToolConfig, stage: string, details?: any): void {
    const serializedDetails = this.stringifyLogDetails(details);
    console.info(`[child-tool:${config.id}] ${stage}`, serializedDetails);
    this.appendChildToolLog(config.id, `${stage} ${serializedDetails}`, stage === 'stdout' ? 'DEBUG' : 'INFO');
  }

  private logError(config: ChildToolConfig, stage: string, details?: any): void {
    const serializedDetails = this.stringifyLogDetails(details);
    console.error(`[child-tool:${config.id}] ${stage}`, serializedDetails);
    this.appendChildToolLog(config.id, `${stage} ${serializedDetails}`, 'ERROR');
  }

  private logExpectedStop(config: ChildToolConfig, details: any): void {
    const serializedDetails = this.stringifyLogDetails(details);
    this.appendChildToolLog(config.id, `process stopped ${serializedDetails}`, 'DEBUG');
  }

  private sanitizeHostInfo(info: ChildToolHostInfo | any): any {
    if (!info || typeof info !== 'object') return info;

    return {
      ...info,
      url: this.sanitizeUrl(info.url),
      wsUrl: this.sanitizeUrl(info.wsUrl),
      shutdownUrl: this.sanitizeUrl(info.shutdownUrl)
    };
  }

  private sanitizeUrl(url: any): any {
    if (typeof url !== 'string' || !url) return url;

    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has('token')) {
        parsed.searchParams.set('token', '<redacted>');
      }
      return parsed.toString();
    } catch {
      return url.replace(/([?&]token=)[^&]+/g, '$1<redacted>');
    }
  }

  private formatBufferedStderr(session: ChildToolSession): string {
    const stderr = this.tailText(session.stderrBuffer).trim();
    return stderr ? `: ${stderr}` : '';
  }

  private tailText(value: string, maxLength = 4000): string {
    const text = String(value || '');
    return text.length > maxLength ? `...${text.slice(-maxLength)}` : text;
  }

  private selectedApiServerFor(config: ChildToolConfig): string {
    return this.requiresSelectedApiServer(config)
      ? this.normalizeApiServer(this.configService.getCurrentApiServer())
      : '';
  }

  private requiresSelectedApiServer(config: ChildToolConfig): boolean {
    return config.runtime?.apiServer === 'required'
      || config.id === 'aily-chat'
      || config.id === 'aily-chat-react';
  }

  private normalizeApiServer(value: unknown): string {
    return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  }

  private appendChildToolLog(source: string, message: string, level: ProjectLogLevel): void {
    appendProjectLog(this.projectService.currentProjectPath, source, level, message);
  }

  private stringifyLogDetails(details: any): string {
    if (details == null || details === '') {
      return '';
    }
    if (typeof details === 'string') {
      return details;
    }
    try {
      return JSON.stringify(details);
    } catch {
      return String(details);
    }
  }
}
