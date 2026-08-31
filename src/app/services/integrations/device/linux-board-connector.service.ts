import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';

import {
  AilyConnectorService,
  AilyConnectorSession,
  AilyConnectorSessionEvent,
  AilyConnectorTransport,
  AilySshConnectOptions,
} from './aily-connector.service';
import { LogService } from '@core/platform/public-api';
import { ProjectService } from '@domain/project/public-api';
import { SerialService } from '@domain/device/public-api';
import { PYTHON_PROJECT_ENTRY } from '@shared/public-api';

export const LINUX_BOARD_SERIAL_BAUD_RATE = 921_600;

export interface LinuxBoardSshSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  privateKeyPath: string;
}

export interface LinuxBoardConnectorState {
  selectedTransport: AilyConnectorTransport | null;
  endpointLabel: string;
  connected: boolean;
  connecting: boolean;
  busy: boolean;
  running: boolean;
  sessionId: string | null;
}

const DEFAULT_SSH_SETTINGS: LinuxBoardSshSettings = {
  host: '',
  port: 22,
  username: '',
  password: '',
  privateKeyPath: '',
};

const INITIAL_STATE: LinuxBoardConnectorState = {
  selectedTransport: null,
  endpointLabel: '',
  connected: false,
  connecting: false,
  busy: false,
  running: false,
  sessionId: null,
};

@Injectable({ providedIn: 'root' })
export class LinuxBoardConnectorService implements OnDestroy {
  private readonly stateSubject = new BehaviorSubject<LinuxBoardConnectorState>(INITIAL_STATE);
  private readonly connectorEventSubscription: Subscription;
  private sshSettings: LinuxBoardSshSettings = { ...DEFAULT_SSH_SETTINGS };
  private serialPort = '';
  private session: AilyConnectorSession | null = null;
  private sessionTargetKey = '';
  private connectTask: Promise<AilyConnectorSession> | null = null;
  private connectTaskTargetKey = '';
  private disconnectTask: Promise<void> | null = null;
  private stopRequested = false;
  private readonly projectPathSubscription: Subscription;
  private readonly boardChangeSubscription: Subscription;
  private observedProjectPath = '';

  readonly state$ = this.stateSubject.asObservable();

  constructor(
    private readonly connector: AilyConnectorService,
    private readonly serialService: SerialService,
    private readonly logService: LogService,
    private readonly projectService: ProjectService,
  ) {
    this.connectorEventSubscription = this.connector.events$.subscribe(event => {
      this.handleConnectorEvent(event);
    });
    this.observedProjectPath = normalizeLocalProjectPath(this.projectService.currentProjectPath);
    this.projectPathSubscription = this.projectService.currentProjectPath$.subscribe(path => {
      const nextPath = normalizeLocalProjectPath(path);
      const previousPath = this.observedProjectPath;
      this.observedProjectPath = nextPath;
      if (!previousPath || previousPath === nextPath) return;
      this.resetForProjectContextChange('项目已切换，正在断开原开发板会话');
    });
    this.boardChangeSubscription = this.projectService.boardChangeSubject.subscribe(() => {
      this.resetForProjectContextChange('开发板已切换，正在断开原开发板会话');
    });
  }

  get snapshot(): LinuxBoardConnectorState {
    return this.stateSubject.value;
  }

  getSshSettings(): LinuxBoardSshSettings {
    return { ...this.sshSettings, password: '' };
  }

  async connectSsh(
    settings: LinuxBoardSshSettings,
    confirmedHostKey?: string,
  ): Promise<AilyConnectorSession> {
    const normalized = normalizeSshSettings(settings);
    this.assertTargetCanChange();
    if (this.snapshot.running) {
      throw new Error('请先停止正在运行的 Python 程序，再切换连接');
    }

    await this.disconnectIfTargetChanged('ssh', sshTargetKey(normalized));
    this.sshSettings = { ...normalized, password: '' };
    this.patchState({
      selectedTransport: 'ssh',
      endpointLabel: formatSshLabel(normalized),
    });
    try {
      return await this.ensureConnected(undefined, normalized, confirmedHostKey);
    } finally {
      normalized.password = '';
    }
  }

  async selectSerialPort(port: string): Promise<void> {
    const normalizedPort = String(port || '').trim();
    if (!normalizedPort) throw new Error('请选择串口');
    this.assertTargetCanChange();
    if (this.snapshot.running) {
      throw new Error('请先停止正在运行的 Python 程序，再切换串口');
    }

    await this.disconnectIfTargetChanged('serial', serialTargetKey(normalizedPort));
    this.serialPort = normalizedPort;
    this.patchState({
      selectedTransport: 'serial',
      endpointLabel: `${normalizedPort} · ${LINUX_BOARD_SERIAL_BAUD_RATE}`,
    });
    this.writeLog(`已选择串口 ${normalizedPort}，波特率 ${LINUX_BOARD_SERIAL_BAUD_RATE}`, 'info');
  }

  async syncAndRunSource(
    source: string,
    projectPath: string,
    expectedTransport: AilyConnectorTransport,
    entry = PYTHON_PROJECT_ENTRY,
  ): Promise<Record<string, unknown>> {
    return this.runExclusive(async () => {
      if (this.snapshot.running) {
        throw new Error('请先停止正在运行的 Python 程序');
      }

      const { session, remoteRoot, normalizedEntry } = await this.syncSourceInternal(
        source,
        projectPath,
        entry,
        expectedTransport,
      );
      const remotePath = `${remoteRoot.replace(/\/$/, '')}/${normalizedEntry}`;
      this.stopRequested = false;
      this.patchState({ running: true });
      this.writeLog(`正在运行 ${remotePath}`, 'doing');
      try {
        const run = await this.connector.request<Record<string, unknown>>(
          session.sessionId,
          'run.file',
          { path: remotePath },
          120_000,
        );
        return {
          state: 'done',
          text: `${normalizedEntry} 已同步并启动`,
          remotePath,
          run,
        };
      } catch (error) {
        this.patchState({ running: false });
        throw error;
      }
    });
  }

  async stop(): Promise<Record<string, unknown>> {
    if (!this.session || !this.snapshot.connected || !this.snapshot.running) {
      return { state: 'warn', text: '当前没有正在运行的 Python 程序' };
    }
    if (this.snapshot.busy) {
      throw new Error('Linux 开发板正在执行其他操作');
    }

    this.patchState({ busy: true });
    this.stopRequested = true;
    try {
      await this.connector.stopPython(this.session.sessionId);
      this.patchState({ running: false });
      this.writeLog('Python 程序已停止', 'done');
      return { state: 'done', text: 'Python 程序已停止' };
    } catch (error) {
      this.stopRequested = false;
      this.writeError('停止 Python 程序失败', error);
      throw error;
    } finally {
      this.patchState({ busy: false });
    }
  }

  async disconnect(): Promise<void> {
    if (this.disconnectTask) return this.disconnectTask;
    const task = this.disconnectInternal();
    this.disconnectTask = task;
    try {
      await task;
    } finally {
      if (this.disconnectTask === task) this.disconnectTask = null;
    }
  }

  ngOnDestroy(): void {
    this.connectorEventSubscription.unsubscribe();
    this.projectPathSubscription.unsubscribe();
    this.boardChangeSubscription.unsubscribe();
    void this.disconnect().catch(() => undefined);
    this.stateSubject.complete();
  }

  private async syncSourceInternal(
    source: string,
    projectPath: string,
    entry: string,
    expectedTransport: AilyConnectorTransport,
  ): Promise<{
    session: AilyConnectorSession;
    remoteRoot: string;
    normalizedEntry: string;
  }> {
    if (typeof source !== 'string') throw new Error('Python 源代码无效');
    if (!projectPath) throw new Error('当前项目路径无效');
    if (entry !== PYTHON_PROJECT_ENTRY) {
      throw new Error(`Python 入口文件必须为 ${PYTHON_PROJECT_ENTRY}`);
    }
    const normalizedEntry = PYTHON_PROJECT_ENTRY;

    const session = await this.ensureConnected(expectedTransport);
    const remoteRoot = this.defaultRemoteRoot(session, projectPath);
    this.writeLog(`正在同步 ${normalizedEntry} 到 ${remoteRoot}`, 'doing');
    await this.connector.syncProject(
      session.sessionId,
      remoteRoot,
      [{ path: normalizedEntry, dataBase64: encodeUtf8Base64(source) }],
    );
    this.writeLog(`${normalizedEntry} 已同步到 ${remoteRoot}`, 'done');
    return { session, remoteRoot, normalizedEntry };
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.snapshot.busy) {
      throw new Error('Linux 开发板正在执行其他操作');
    }
    this.patchState({ busy: true });
    try {
      return await operation();
    } catch (error) {
      this.writeError('Linux 开发板操作失败', error);
      throw error;
    } finally {
      this.patchState({ busy: false });
    }
  }

  private async ensureConnected(
    expectedTransport?: AilyConnectorTransport,
    sshOverride?: LinuxBoardSshSettings,
    confirmedHostKey?: string,
  ): Promise<AilyConnectorSession> {
    if (this.disconnectTask) await this.disconnectTask;
    const target = this.resolveSelectedTarget(sshOverride, confirmedHostKey);
    if (expectedTransport && target.transport !== expectedTransport) {
      throw new Error(
        `board.json requires the ${expectedTransport} connector, but ${target.transport} is selected`,
      );
    }
    if (
      this.session
      && this.sessionTargetKey === target.key
      && this.connector.sessions.has(this.session.sessionId)
    ) {
      return this.session;
    }
    if (this.session) {
      await this.disconnectActiveSession(true);
    }
    if (this.connectTask) {
      if (this.connectTaskTargetKey !== target.key) {
        throw new Error('连接目标正在切换，请稍后重试');
      }
      return this.connectTask;
    }

    this.patchState({ connecting: true });
    this.writeLog(`正在连接 ${target.label}`, 'doing');
    const task = (async () => {
      await this.connector.waitForReady();
      const session = target.transport === 'ssh'
        ? await this.connector.connectSsh(target.options)
        : await this.connector.connectSerial({
          port: target.port,
          baudRate: LINUX_BOARD_SERIAL_BAUD_RATE,
          allowRawConsole: false,
        });

      this.session = session;
      this.sessionTargetKey = target.key;
      this.patchState({
        connected: true,
        connecting: false,
        sessionId: session.sessionId,
        endpointLabel: target.label,
      });
      this.writeLog(`已连接 ${target.label}`, 'done');
      return session;
    })().catch(error => {
      this.clearSessionState();
      this.writeError(`连接 ${target.label} 失败`, error);
      throw error;
    }).finally(() => {
      if (this.connectTask === task) {
        this.connectTask = null;
        this.connectTaskTargetKey = '';
      }
      this.patchState({ connecting: false });
    });
    this.connectTaskTargetKey = target.key;
    this.connectTask = task;
    return task;
  }

  private async disconnectInternal(): Promise<void> {
    const pendingConnect = this.connectTask;
    if (pendingConnect) {
      await pendingConnect.catch(() => undefined);
    }
    await this.disconnectActiveSession(false);
  }

  private async disconnectActiveSession(preserveBusy: boolean): Promise<void> {
    const session = this.session;
    if (!session || !this.connector.sessions.has(session.sessionId)) {
      this.clearSessionState(preserveBusy);
      return;
    }
    try {
      await this.connector.disconnect(session.sessionId);
      if (this.session?.sessionId === session.sessionId) {
        this.clearSessionState(preserveBusy);
      }
      this.writeLog('连接已断开', 'info');
    } catch (error) {
      this.writeError('断开 Linux 开发板失败', error);
      throw error;
    }
  }

  private resolveSelectedTarget(
    sshOverride?: LinuxBoardSshSettings,
    confirmedHostKey?: string,
  ):
    | { transport: 'ssh'; key: string; label: string; options: AilySshConnectOptions }
    | { transport: 'serial'; key: string; label: string; port: string } {
    if (this.snapshot.selectedTransport === 'ssh') {
      const settings = normalizeSshSettings(sshOverride || this.sshSettings);
      return {
        transport: 'ssh',
        key: sshTargetKey(settings),
        label: formatSshLabel(settings),
        options: {
          host: settings.host,
          port: settings.port,
          username: settings.username,
          ...(settings.password ? { password: settings.password } : {}),
          ...(settings.privateKeyPath ? { privateKeyPath: settings.privateKeyPath } : {}),
          hostKeyPolicy: 'strict',
          ...(confirmedHostKey ? { hostKey: confirmedHostKey } : {}),
        },
      };
    }

    const selectedPort = String(this.serialService.currentPort || this.serialPort || '').trim();
    const selectedPortType = this.serialService.currentPortInfo?.type || 'serial';
    if (!selectedPort || selectedPortType !== 'serial') {
      throw new Error('请从 Header 端口菜单选择 Linux 开发板串口，或打开 SSH 连接设置');
    }
    this.serialPort = selectedPort;
    const label = `${selectedPort} · ${LINUX_BOARD_SERIAL_BAUD_RATE}`;
    this.patchState({ selectedTransport: 'serial', endpointLabel: label });
    return {
      transport: 'serial',
      key: serialTargetKey(selectedPort),
      label,
      port: selectedPort,
    };
  }

  private async disconnectIfTargetChanged(
    transport: AilyConnectorTransport,
    targetKey: string,
  ): Promise<void> {
    if (!this.session) return;
    if (this.session.transport === transport && this.sessionTargetKey === targetKey) return;
    await this.disconnect();
  }

  private assertTargetCanChange(): void {
    if (this.snapshot.busy) {
      throw new Error('Linux 开发板正在执行其他操作，请稍后再切换连接');
    }
    if (this.snapshot.connecting || this.connectTask) {
      throw new Error('Linux 开发板正在连接，请稍后再切换连接');
    }
    if (this.disconnectTask) {
      throw new Error('Linux 开发板正在断开连接，请稍后再切换连接');
    }
  }

  private handleConnectorEvent(message: AilyConnectorSessionEvent): void {
    if (message.type === 'connector.crashed') {
      if (this.session) {
        this.writeError('Aily Connector 已停止', message.error?.message || '连接进程异常退出');
      }
      this.clearSessionState();
      return;
    }
    if (!this.session || message.sessionId !== this.session.sessionId) return;

    const event = message.event;
    if (!event) return;
    if (event.type === 'run.output' && typeof event.text === 'string' && event.text) {
      this.logService.update({ title: 'Python 输出', detail: event.text });
      return;
    }
    if (event.type === 'diagnostic.stderr' && typeof event.text === 'string' && event.text) {
      this.logService.update({
        title: 'Linux 开发板',
        detail: `[stderr] ${event.text}`,
        state: 'error',
      });
      return;
    }
    if (event.type === 'run.started' || event.type === 'run.start') {
      this.patchState({ running: true });
      this.writeLog('Python 程序已启动', 'doing');
      return;
    }
    if (
      event.type === 'run.finished'
      || event.type === 'run.exited'
      || event.type === 'run.stopped'
      || event.type === 'run.error'
    ) {
      const wasStopRequested = this.stopRequested;
      this.stopRequested = false;
      this.patchState({ running: false });
      const exitCode = event['code'] ?? event['exitCode'];
      const isError = event.type === 'run.error'
        || (typeof exitCode === 'number' && exitCode !== 0)
        || (!wasStopRequested && Boolean(event['signal']));
      if (wasStopRequested) return;
      this.writeLog(
        isError ? 'Python 程序异常结束' : 'Python 程序已结束',
        isError ? 'error' : 'done',
      );
      return;
    }
    if (event.type === 'connector.outputDropped') {
      this.writeLog('程序输出过快，部分日志已丢弃', 'warn');
      return;
    }
    if (event.type === 'device.error') {
      this.writeError('Linux 开发板连接错误', event['message'] || '未知错误');
      return;
    }
    if (event.type === 'device.disconnected') {
      this.writeLog('Linux 开发板已断开', 'warn');
      this.clearSessionState();
    }
  }

  private clearSessionState(preserveBusy = false): void {
    this.session = null;
    this.sessionTargetKey = '';
    this.stopRequested = false;
    this.patchState({
      connected: false,
      connecting: false,
      busy: preserveBusy ? this.snapshot.busy : false,
      running: false,
      sessionId: null,
    });
  }

  private clearSelectedTarget(): void {
    this.sshSettings = { ...DEFAULT_SSH_SETTINGS };
    this.serialPort = '';
    this.patchState({
      selectedTransport: null,
      endpointLabel: '',
    });
  }

  private resetForProjectContextChange(detail: string): void {
    this.sshSettings.password = '';
    if (!this.session && !this.connectTask) {
      this.clearSelectedTarget();
      return;
    }
    this.writeLog(detail, 'info');
    void this.disconnect()
      .then(() => this.clearSelectedTarget())
      .catch(() => undefined);
  }

  private defaultRemoteRoot(session: AilyConnectorSession, projectPath: string): string {
    const capabilities = session.capabilities || {};
    const workspace = typeof capabilities['writableWorkspace'] === 'string'
      ? capabilities['writableWorkspace']
      : '/tmp/aily-runtime';
    const normalizedProjectPath = normalizeLocalProjectPath(projectPath);
    const projectName = (normalizedProjectPath.split(/[\\/]/).filter(Boolean).pop() || 'project')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .slice(0, 64) || 'project';
    return `${workspace.replace(/\/$/, '')}/projects/${projectName}-${stablePathHash(normalizedProjectPath)}`;
  }

  private patchState(patch: Partial<LinuxBoardConnectorState>): void {
    this.stateSubject.next({ ...this.stateSubject.value, ...patch });
  }

  private writeLog(detail: string, state?: string): void {
    this.logService.update({
      title: 'Linux 开发板',
      detail: `[Connector] ${detail}`,
      state,
    });
  }

  private writeError(title: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error || '未知错误');
    this.logService.update({
      title: 'Linux 开发板',
      detail: `[Connector] ${title}: ${message}`,
      state: 'error',
    });
  }
}

function normalizeSshSettings(settings: LinuxBoardSshSettings): LinuxBoardSshSettings {
  const host = String(settings?.host || '').trim();
  const username = String(settings?.username || '').trim();
  const port = Number(settings?.port || 22);
  if (!host) throw new Error('请输入 SSH 地址');
  if (!username) throw new Error('请输入 SSH 用户名');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SSH 端口必须是 1 到 65535 之间的整数');
  }
  return {
    host,
    port,
    username,
    password: String(settings?.password || ''),
    privateKeyPath: String(settings?.privateKeyPath || '').trim(),
  };
}

function formatSshLabel(settings: LinuxBoardSshSettings): string {
  return `SSH ${settings.username}@${settings.host}:${settings.port}`;
}

function sshTargetKey(settings: LinuxBoardSshSettings): string {
  return `ssh:${settings.username}@${settings.host.toLowerCase()}:${settings.port}:${settings.privateKeyPath}`;
}

function serialTargetKey(port: string): string {
  return `serial:${port.toLowerCase()}:${LINUX_BOARD_SERIAL_BAUD_RATE}`;
}

function normalizeLocalProjectPath(projectPath: string): string {
  return String(projectPath || '').trim().replace(/[\\/]+$/, '');
}

function stablePathHash(value: string): string {
  let hash = 0x811c9dc5;
  const normalized = /^[A-Za-z]:[\\/]/.test(value) ? value.toLowerCase() : value;
  for (const character of normalized) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
