import { Injectable, OnDestroy } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Buffer } from 'buffer';
import { BehaviorSubject, Subscription } from 'rxjs';

import {
  AilyConnectorService,
  AilyConnectorSession,
  AilyConnectorSessionEvent,
  AilyConnectorTransport,
  AilySshConnectOptions,
} from './aily-connector.service';
import { NoticeService } from '@core/app-shell/public-api';
import { LogService } from '@core/platform/public-api';
import { ConfigService } from '@core/preferences/public-api';
import { ProjectService } from '@domain/project/public-api';
import { SerialService } from '@domain/device/public-api';
import { PYTHON_PROJECT_ENTRY, resolveLinuxBoardExecutionRoute } from '@shared/public-api';

export const LINUX_BOARD_SERIAL_BAUD_RATE = 921_600;

export interface LinuxBoardSshSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  privateKeyPath: string;
  autoTrustHostKey: boolean;
  rememberCredentials: boolean;
}

interface StoredSshCredentials {
  projectPath: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

interface SafeStorageApi {
  isEncryptionAvailable(): boolean;
  encryptStringToBase64?(plainText: string): string;
  decryptStringFromBase64?(encryptedBase64: string): string;
  encryptString?(plainText: string): Uint8Array;
  decryptString?(encrypted: Uint8Array): string;
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
  autoTrustHostKey: true,
  rememberCredentials: true,
};

const SSH_CREDENTIAL_STORAGE_PREFIX = 'aily:linux-board:ssh-credentials:';

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
  private sshCredentialCache: StoredSshCredentials | null = null;
  private serialPort = '';
  private session: AilyConnectorSession | null = null;
  private sessionTargetKey = '';
  private connectTask: Promise<AilyConnectorSession> | null = null;
  private connectTaskTargetKey = '';
  private disconnectTask: Promise<void> | null = null;
  private stopRequested = false;
  private readonly projectPathSubscription: Subscription;
  private readonly projectStateSubscription: Subscription;
  private readonly boardChangeSubscription: Subscription;
  private readonly boardConfigUpdatedSubscription: Subscription;
  private observedProjectPath = '';
  private projectContextRevision = 0;
  private projectContextResetTask: Promise<void> = Promise.resolve();

  readonly state$ = this.stateSubject.asObservable();

  constructor(
    private readonly connector: AilyConnectorService,
    private readonly serialService: SerialService,
    private readonly logService: LogService,
    private readonly noticeService: NoticeService,
    private readonly projectService: ProjectService,
    private readonly configService: ConfigService,
    private readonly translate: TranslateService,
  ) {
    this.connectorEventSubscription = this.connector.events$.subscribe(event => {
      this.handleConnectorEvent(event);
    });
    this.observedProjectPath = normalizeLocalProjectPath(this.projectService.currentProjectPath);
    this.projectPathSubscription = this.projectService.currentProjectPath$.subscribe(path => {
      const nextPath = normalizeLocalProjectPath(path);
      const previousPath = this.observedProjectPath;
      this.observedProjectPath = nextPath;
      if (previousPath === nextPath) return;
      this.projectContextRevision += 1;
      this.projectContextResetTask = this.resetForProjectContextChange(
        this.t('PROJECT_CHANGED_DISCONNECTING'),
      );
    });
    this.projectStateSubscription = this.projectService.stateSubject.subscribe(state => {
      if (state === 'loaded') {
        void this.restoreProjectSshSettings(this.projectContextRevision);
      }
    });
    this.boardChangeSubscription = this.projectService.boardChangeSubject.subscribe(() => {
      this.projectContextRevision += 1;
      const revision = this.projectContextRevision;
      this.projectContextResetTask = this.resetForProjectContextChange(
        this.t('BOARD_CHANGED_DISCONNECTING'),
      );
      void this.restoreProjectSshSettings(revision);
    });
    this.boardConfigUpdatedSubscription = this.projectService.boardConfigUpdatedSubject.subscribe(
      boardConfig => {
        void this.restoreProjectSshSettings(this.projectContextRevision, boardConfig);
      },
    );
  }

  get snapshot(): LinuxBoardConnectorState {
    return this.stateSubject.value;
  }

  getSshSettings(): LinuxBoardSshSettings {
    const settings = { ...this.sshSettings, password: '' };
    if (!settings.rememberCredentials) return settings;

    const projectPath = normalizeLocalProjectPath(this.projectService.currentProjectPath);
    const credentials = this.readStoredSshCredentials(
      projectPath,
      settings,
    ) || this.readCachedSshCredentials(
      projectPath,
      settings,
    );
    return credentials
      ? { ...settings, username: credentials.username, password: credentials.password }
      : settings;
  }

  async connectSsh(settings: LinuxBoardSshSettings): Promise<AilyConnectorSession> {
    const normalized = this.normalizeSshSettings(settings);
    const projectPath = normalizeLocalProjectPath(this.projectService.currentProjectPath);
    this.assertTargetCanChange();
    if (this.snapshot.running) {
      throw new Error(this.t('STOP_PYTHON_BEFORE_SWITCH_CONNECTION'));
    }

    await this.disconnectIfTargetChanged('ssh', sshTargetKey(normalized));
    this.sshSettings = {
      ...normalized,
      username: normalized.rememberCredentials ? normalized.username : '',
      password: '',
    };
    this.patchState({
      selectedTransport: 'ssh',
      endpointLabel: formatSshLabel(normalized),
    });
    try {
      const session = await this.ensureConnected(undefined, normalized);
      if (projectPath === normalizeLocalProjectPath(this.projectService.currentProjectPath)) {
        this.persistSshCredentials(projectPath, normalized);
        try {
          await this.configService.saveProjectSshConnectorSettings(
            this.projectService,
            normalized,
          );
        } catch (error) {
          this.writeError(this.t('SSH_SETTINGS_SAVE_FAILED'), error);
        }
      }
      return session;
    } finally {
      normalized.password = '';
    }
  }

  async selectSerialPort(port: string): Promise<void> {
    const normalizedPort = String(port || '').trim();
    if (!normalizedPort) throw new Error(this.t('SELECT_SERIAL_PORT'));
    this.assertTargetCanChange();
    if (this.snapshot.running) {
      throw new Error(this.t('STOP_PYTHON_BEFORE_SWITCH_SERIAL'));
    }

    await this.disconnectIfTargetChanged('serial', serialTargetKey(normalizedPort));
    this.serialPort = normalizedPort;
    this.patchState({
      selectedTransport: 'serial',
      endpointLabel: `${normalizedPort} · ${LINUX_BOARD_SERIAL_BAUD_RATE}`,
    });
    this.writeLog(this.t('SERIAL_SELECTED', {
      port: normalizedPort,
      baudRate: LINUX_BOARD_SERIAL_BAUD_RATE,
    }), 'info');
  }

  async syncAndRunSource(
    source: string,
    projectPath: string,
    expectedTransport: AilyConnectorTransport,
    entry = PYTHON_PROJECT_ENTRY,
  ): Promise<Record<string, unknown>> {
    return this.runExclusive(async () => {
      if (this.snapshot.running) {
        throw new Error(this.t('STOP_PYTHON_BEFORE_RUN'));
      }

      const { session, remoteRoot, normalizedEntry } = await this.syncSourceInternal(
        source,
        projectPath,
        entry,
        expectedTransport,
      );
      const remotePath = `${remoteRoot.replace(/\/$/, '')}/${normalizedEntry}`;
      this.stopRequested = false;
      this.writeLog(this.t('RUNNING_FILE', { path: remotePath }), 'doing');
      try {
        const run = await this.connector.request<Record<string, unknown>>(
          session.sessionId,
          'run.file',
          { path: remotePath },
          120_000,
        );
        return {
          state: 'done',
          text: this.t('SYNCED_AND_STARTED', { entry: normalizedEntry }),
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
      return { state: 'warn', text: this.t('NO_RUNNING_PYTHON') };
    }
    if (this.snapshot.busy) {
      throw new Error(this.t('LINUX_BOARD_BUSY'));
    }

    this.patchState({ busy: true });
    this.stopRequested = true;
    try {
      await this.connector.stopPython(this.session.sessionId);
      this.patchState({ running: false });
      this.writeLog(this.t('PYTHON_STOPPED'), 'done');
      return { state: 'done', text: this.t('PYTHON_STOPPED') };
    } catch (error) {
      this.stopRequested = false;
      this.writeError(this.t('STOP_PYTHON_FAILED'), error);
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
    this.projectStateSubscription.unsubscribe();
    this.boardChangeSubscription.unsubscribe();
    this.boardConfigUpdatedSubscription.unsubscribe();
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
    if (typeof source !== 'string') throw new Error(this.t('INVALID_PYTHON_SOURCE'));
    if (!projectPath) throw new Error(this.t('INVALID_PROJECT_PATH'));
    if (entry !== PYTHON_PROJECT_ENTRY) {
      throw new Error(this.t('PYTHON_ENTRY_REQUIRED', { entry: PYTHON_PROJECT_ENTRY }));
    }
    const normalizedEntry = PYTHON_PROJECT_ENTRY;

    const session = await this.ensureConnected(expectedTransport);
    const remoteRoot = this.defaultRemoteRoot(session, projectPath);
    this.writeLog(this.t('SYNCING_FILE', {
      entry: normalizedEntry,
      remoteRoot,
    }), 'doing');
    await this.connector.syncProject(
      session.sessionId,
      remoteRoot,
      [{ path: normalizedEntry, dataBase64: encodeUtf8Base64(source) }],
    );
    this.writeLog(this.t('FILE_SYNCED', {
      entry: normalizedEntry,
      remoteRoot,
    }), 'done');
    return { session, remoteRoot, normalizedEntry };
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.snapshot.busy) {
      throw new Error(this.t('LINUX_BOARD_BUSY'));
    }
    this.patchState({ busy: true });
    try {
      return await operation();
    } catch (error) {
      this.writeError(this.t('LINUX_BOARD_OPERATION_FAILED'), error);
      throw error;
    } finally {
      this.patchState({ busy: false });
    }
  }

  private async ensureConnected(
    expectedTransport?: AilyConnectorTransport,
    sshOverride?: LinuxBoardSshSettings,
  ): Promise<AilyConnectorSession> {
    if (this.disconnectTask) await this.disconnectTask;
    const target = this.resolveSelectedTarget(sshOverride);
    if (expectedTransport && target.transport !== expectedTransport) {
      throw new Error(
        this.t('CONNECTOR_MISMATCH', {
          expected: expectedTransport,
          selected: target.transport,
        }),
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
        throw new Error(this.t('TARGET_CHANGING'));
      }
      return this.connectTask;
    }

    this.patchState({ connecting: true });
    this.writeLog(this.t('CONNECTING_TARGET', { target: target.label }), 'doing');
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
      this.writeLog(this.t('CONNECTED_TARGET', { target: target.label }), 'done');
      return session;
    })().catch(error => {
      this.clearSessionState();
      this.writeError(this.t('CONNECT_TARGET_FAILED', { target: target.label }), error);
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
      this.writeLog(this.t('CONNECTION_DISCONNECTED'), 'info');
    } catch (error) {
      this.writeError(this.t('DISCONNECT_FAILED'), error);
      throw error;
    }
  }

  private resolveSelectedTarget(sshOverride?: LinuxBoardSshSettings):
    | { transport: 'ssh'; key: string; label: string; options: AilySshConnectOptions }
    | { transport: 'serial'; key: string; label: string; port: string } {
    if (this.snapshot.selectedTransport === 'ssh') {
      const settings = this.normalizeSshSettings(sshOverride || this.sshSettings);
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
          hostKeyPolicy: settings.autoTrustHostKey ? 'accept-any' : 'trust-on-first-use',
        },
      };
    }

    const selectedPort = String(this.serialService.currentPort || this.serialPort || '').trim();
    const selectedPortType = this.serialService.currentPortInfo?.type || 'serial';
    if (!selectedPort || selectedPortType !== 'serial') {
      throw new Error(this.t('SELECT_CONNECTION'));
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
      throw new Error(this.t('SWITCH_BUSY'));
    }
    if (this.snapshot.connecting || this.connectTask) {
      throw new Error(this.t('SWITCH_CONNECTING'));
    }
    if (this.disconnectTask) {
      throw new Error(this.t('SWITCH_DISCONNECTING'));
    }
  }

  private handleConnectorEvent(message: AilyConnectorSessionEvent): void {
    if (message.type === 'connector.stderr') {
      this.writeError(this.t('OUTPUT_ERROR'), message.error?.message || this.t('UNKNOWN_ERROR'));
      return;
    }
    if (message.type === 'connector.crashed') {
      if (this.session) {
        this.writeError(
          this.t('CONNECTOR_STOPPED'),
          message.error || this.t('PROCESS_EXITED'),
        );
      }
      this.clearSessionState();
      return;
    }
    if (!this.session || message.sessionId !== this.session.sessionId) return;

    const event = message.event;
    if (!event) return;
    if (event.type === 'run.output' && typeof event.text === 'string' && event.text) {
      this.logService.update({ title: this.t('PYTHON_OUTPUT'), detail: event.text });
      return;
    }
    if (event.type === 'diagnostic.stderr' && typeof event.text === 'string' && event.text) {
      this.writeError(this.t('OUTPUT_ERROR'), event.text);
      return;
    }
    if (event.type === 'run.started' || event.type === 'run.start') {
      this.patchState({ running: true });
      this.writeLog(this.t('PYTHON_STARTED'), 'doing');
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
      if (isError) {
        const errorMessage = this.connectorEventErrorMessage(event);
        if (errorMessage) this.writeError(this.t('PYTHON_ENDED_ABNORMALLY'), errorMessage);
        else this.writeLog(this.t('PYTHON_ENDED_ABNORMALLY'), 'error');
      } else {
        this.writeLog(this.t('PYTHON_ENDED'), 'done');
      }
      return;
    }
    if (event.type === 'connector.outputDropped') {
      this.writeLog(this.t('OUTPUT_DROPPED'), 'warn');
      return;
    }
    if (event.type === 'device.error') {
      this.writeError(
        this.t('CONNECTION_ERROR'),
        {
          code: event['code'],
          message: event['message'] || this.t('UNKNOWN_ERROR'),
        },
      );
      return;
    }
    if (event.type === 'driver.protocolDesync' || event.type.endsWith('.error')) {
      this.writeError(
        this.t('RUNTIME_ERROR'),
        {
          code: event['code'] || (event.type === 'driver.protocolDesync' ? 'PROTOCOL_DESYNC' : ''),
          message: this.connectorEventErrorMessage(event) || event.type,
        },
      );
      return;
    }
    if (event.type === 'device.disconnected') {
      this.writeLog(this.t('BOARD_DISCONNECTED'), 'warn');
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
    this.sshCredentialCache = null;
    this.serialPort = '';
    this.patchState({
      selectedTransport: null,
      endpointLabel: '',
    });
  }

  private resetForProjectContextChange(detail: string): Promise<void> {
    this.sshSettings.password = '';
    if (!this.session && !this.connectTask) {
      this.clearSelectedTarget();
      return Promise.resolve();
    }
    this.writeLog(detail, 'info');
    return this.disconnect()
      .then(() => this.clearSelectedTarget())
      .catch(() => undefined);
  }

  private async restoreProjectSshSettings(revision: number, boardConfig?: unknown): Promise<void> {
    await this.projectContextResetTask;
    const projectPath = normalizeLocalProjectPath(this.projectService.currentProjectPath);
    if (
      revision !== this.projectContextRevision
      || !projectPath
      || projectPath !== this.observedProjectPath
    ) {
      return;
    }

    let packageJson: any;
    try {
      packageJson = await this.projectService.getPackageJson();
      boardConfig ??= await this.projectService.getBoardJson();
    } catch {
      return;
    }
    if (
      revision !== this.projectContextRevision
      || projectPath !== normalizeLocalProjectPath(this.projectService.currentProjectPath)
    ) {
      return;
    }
    const route = resolveLinuxBoardExecutionRoute(packageJson, boardConfig);
    if (!route?.connectors.includes('ssh')) return;

    const saved = this.configService.getProjectSshConnectorSettings(
      packageJson,
    );
    if (!saved) return;

    const normalized = this.normalizeSshSettings({ ...saved, password: '' }, false);
    const credentials = normalized.rememberCredentials
      ? this.readStoredSshCredentials(projectPath, normalized)
      : null;
    const restored = credentials
      ? { ...normalized, username: credentials.username }
      : normalized;
    this.sshSettings = restored;
    this.patchState({
      selectedTransport: 'ssh',
      endpointLabel: formatSshLabel(restored),
    });
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
    if (state === 'error') {
      this.publishError(detail, `[Connector] ${detail}`);
      return;
    }
    this.logService.update({
      title: this.t('TITLE'),
      detail: `[Connector] ${detail}`,
      state,
    });
  }

  private writeError(title: string, error: unknown): void {
    const message = this.localizedErrorMessage(error);
    const text = `${title}: ${message}`;
    this.publishError(text, `[Connector] ${text}`);
  }

  private publishError(text: string, detail: string): void {
    this.noticeService.update({
      title: this.t('TITLE'),
      text,
      detail,
      state: 'error',
      setTimeout: 600_000,
    });
  }

  private connectorEventErrorMessage(event: AilyConnectorSessionEvent['event']): string {
    if (!event) return '';
    for (const value of [event['message'], event.text, event['reason']]) {
      const text = String(value || '').trim();
      if (text) return text;
    }
    const error = event['error'];
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object' && typeof error['message'] === 'string') {
      return error['message'].trim();
    }
    const payload = event['payload'];
    if (typeof payload === 'string') return payload.trim();
    if (payload && typeof payload === 'object') {
      try {
        return JSON.stringify(payload);
      } catch {
        return '';
      }
    }
    const exitCode = event['code'] ?? event['exitCode'];
    return exitCode === undefined ? '' : this.t('EXIT_CODE', { code: String(exitCode) });
  }

  private persistSshCredentials(projectPath: string, settings: LinuxBoardSshSettings): void {
    if (!settings.rememberCredentials) {
      this.sshCredentialCache = null;
      if (projectPath) localStorage.removeItem(sshCredentialStorageKey(projectPath));
      return;
    }
    if (!projectPath) return;

    const storageKey = sshCredentialStorageKey(projectPath);
    const credentials: StoredSshCredentials = {
      projectPath,
      host: settings.host,
      port: settings.port,
      username: settings.username,
      password: settings.password,
    };
    // Keep the just-validated credentials available when this dialog is reopened in the
    // current app session, even if the OS credential store is temporarily unavailable.
    this.sshCredentialCache = { ...credentials };

    const safeStorage = (window as any).electronAPI?.safeStorage as SafeStorageApi | undefined;
    if (!safeStorage) {
      localStorage.removeItem(storageKey);
      this.writeLog(this.t('SECURE_STORAGE_UNAVAILABLE'), 'warn');
      return;
    }

    try {
      if (!safeStorage.isEncryptionAvailable()) {
        localStorage.removeItem(storageKey);
        this.writeLog(this.t('SECURE_STORAGE_UNAVAILABLE'), 'warn');
        return;
      }
      const encryptedBase64 = encryptSafeStorageValue(
        safeStorage,
        JSON.stringify(credentials),
      );
      localStorage.setItem(storageKey, encryptedBase64);
    } catch (error) {
      localStorage.removeItem(storageKey);
      this.writeError(this.t('CREDENTIAL_SAVE_FAILED'), error);
    }
  }

  private readStoredSshCredentials(
    projectPath: string,
    settings: LinuxBoardSshSettings,
  ): StoredSshCredentials | null {
    if (!projectPath || !settings.host) return null;
    const storageKey = sshCredentialStorageKey(projectPath);
    const encrypted = localStorage.getItem(storageKey);
    if (!encrypted) return null;

    const safeStorage = (window as any).electronAPI?.safeStorage as SafeStorageApi | undefined;
    if (!safeStorage) return null;
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const decrypted = decryptSafeStorageValue(safeStorage, encrypted);
      const credentials = JSON.parse(decrypted) as Partial<StoredSshCredentials>;
      if (!sshCredentialsMatch(credentials, projectPath, settings)) return null;
      this.sshCredentialCache = { ...(credentials as StoredSshCredentials) };
      return { ...this.sshCredentialCache };
    } catch {
      localStorage.removeItem(storageKey);
      return null;
    }
  }

  private readCachedSshCredentials(
    projectPath: string,
    settings: LinuxBoardSshSettings,
  ): StoredSshCredentials | null {
    return sshCredentialsMatch(this.sshCredentialCache, projectPath, settings)
      ? { ...this.sshCredentialCache as StoredSshCredentials }
      : null;
  }

  private normalizeSshSettings(
    settings: LinuxBoardSshSettings,
    requireUsername = true,
  ): LinuxBoardSshSettings {
    const host = String(settings?.host || '').trim();
    const username = String(settings?.username || '').trim();
    const port = Number(settings?.port || 22);
    if (!host) throw new Error(this.t('SSH_HOST_REQUIRED'));
    if (requireUsername && !username) throw new Error(this.t('SSH_USERNAME_REQUIRED'));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(this.t('SSH_PORT_INVALID'));
    }
    return {
      host,
      port,
      username,
      password: String(settings?.password || ''),
      privateKeyPath: String(settings?.privateKeyPath || '').trim(),
      autoTrustHostKey: settings?.autoTrustHostKey !== false,
      rememberCredentials: settings?.rememberCredentials !== false,
    };
  }

  private localizedErrorMessage(error: unknown): string {
    const code = typeof error === 'object' && error
      ? String((error as { code?: unknown }).code || '')
      : '';
    const errorCodeKeys: Record<string, string> = {
      OPERATION_TIMEOUT: 'REQUEST_TIMEOUT',
      CONNECT_TIMEOUT: 'CONNECT_TIMEOUT',
      SESSION_CLOSED: 'SESSION_CLOSED',
      RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
      INVALID_ENDPOINT: 'INVALID_ENDPOINT',
      AUTH_FAILED: 'AUTH_FAILED',
      HOST_KEY_UNKNOWN: 'HOST_KEY_UNKNOWN',
      HOST_KEY_CHANGED: 'HOST_KEY_CHANGED',
      KNOWN_HOST_STORE_CORRUPT: 'KNOWN_HOST_STORE_CORRUPT',
      SHELL_NOT_DETECTED: 'SHELL_NOT_DETECTED',
      PYTHON3_NOT_FOUND: 'PYTHON3_NOT_FOUND',
      CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
      RUN_ALREADY_ACTIVE: 'RUN_ALREADY_ACTIVE',
      RUN_START_FAILED: 'RUN_START_FAILED',
      RUN_STOP_FAILED: 'RUN_STOP_FAILED',
      FILE_TRANSFER_FAILED: 'FILE_TRANSFER_FAILED',
      DIRECTORY_TOO_LARGE: 'DIRECTORY_TOO_LARGE',
      AUTOSTART_PERMISSION_DENIED: 'AUTOSTART_PERMISSION_DENIED',
      PREVIEW_UNAVAILABLE: 'PREVIEW_UNAVAILABLE',
      PROTOCOL_DESYNC: 'PROTOCOL_DESYNC',
    };
    const errorCodeKey = errorCodeKeys[code];
    if (errorCodeKey) return this.t(errorCodeKey);

    const message = error instanceof Error
      ? error.message
      : (typeof error === 'object' && error && 'message' in error
        ? String((error as { message?: unknown }).message || '')
        : String(error || ''));
    const knownMessages: Record<string, string> = {
      'aily-connector package entry was not found': 'PACKAGE_NOT_FOUND',
      'aily-connector does not provide the required Linux board capabilities': 'CAPABILITIES_MISSING',
      'aily-connector daemon readiness timed out': 'READY_TIMEOUT',
      'aily-connector daemon is not connected': 'DAEMON_NOT_CONNECTED',
      'aily-connector daemon sent an incompatible protocol message': 'PROTOCOL_INCOMPATIBLE',
      'aily-connector daemon protocol is incompatible': 'PROTOCOL_INCOMPATIBLE',
      'aily-connector is unavailable': 'CONNECTOR_UNAVAILABLE',
      'Invalid aily-connector IPC response': 'INVALID_IPC_RESPONSE',
      'Aily Connector request failed': 'REQUEST_FAILED',
      'Aily Connector stopped unexpectedly': 'PROCESS_EXITED',
    };
    const key = knownMessages[message];
    if (key) return this.t(key);
    if (/^aily-connector request timed out:/i.test(message)) return this.t('REQUEST_TIMEOUT');
    if (/^aily-connector daemon exited/i.test(message)) return this.t('PROCESS_EXITED');
    return message || this.t('UNKNOWN_ERROR');
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.translate.instant(`AILY_CONNECTOR.${key}`, params);
  }
}

function formatSshLabel(settings: LinuxBoardSshSettings): string {
  return `SSH ${settings.username}@${settings.host}:${settings.port}`;
}

function sshTargetKey(settings: LinuxBoardSshSettings): string {
  const hostKeyPolicy = settings.autoTrustHostKey ? 'accept-any' : 'trust-on-first-use';
  return `ssh:${settings.username}@${settings.host.toLowerCase()}:${settings.port}:${settings.privateKeyPath}:${hostKeyPolicy}`;
}

function serialTargetKey(port: string): string {
  return `serial:${port.toLowerCase()}:${LINUX_BOARD_SERIAL_BAUD_RATE}`;
}

function normalizeLocalProjectPath(projectPath: string): string {
  return String(projectPath || '').trim().replace(/[\\/]+$/, '');
}

function sshCredentialStorageKey(projectPath: string): string {
  return `${SSH_CREDENTIAL_STORAGE_PREFIX}${stablePathHash(projectPath)}`;
}

function sshCredentialsMatch(
  credentials: Partial<StoredSshCredentials> | null,
  projectPath: string,
  settings: LinuxBoardSshSettings,
): credentials is StoredSshCredentials {
  return Boolean(
    credentials
    && credentials.projectPath === projectPath
    && String(credentials.host || '').trim().toLowerCase() === settings.host.toLowerCase()
    && Number(credentials.port) === settings.port
    && typeof credentials.username === 'string'
    && typeof credentials.password === 'string',
  );
}

function encryptSafeStorageValue(safeStorage: SafeStorageApi, plainText: string): string {
  if (safeStorage.encryptStringToBase64) {
    return safeStorage.encryptStringToBase64(plainText);
  }
  if (safeStorage.encryptString) {
    return Buffer.from(safeStorage.encryptString(plainText)).toString('base64');
  }
  throw new Error('Safe storage encryption API is unavailable');
}

function decryptSafeStorageValue(safeStorage: SafeStorageApi, encryptedBase64: string): string {
  if (safeStorage.decryptStringFromBase64) {
    return safeStorage.decryptStringFromBase64(encryptedBase64);
  }
  if (safeStorage.decryptString) {
    return safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64'));
  }
  throw new Error('Safe storage decryption API is unavailable');
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
