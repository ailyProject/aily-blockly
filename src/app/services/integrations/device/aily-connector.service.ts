import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Subject, Subscription } from 'rxjs';

import { UiService } from '@core/app-shell/public-api';
import { SubappResourceLifecycleService } from '@integration/subapps/public-api';

export type AilyConnectorTransport = 'ssh' | 'serial';

export interface AilyConnectorSession {
  sessionId: string;
  transport: AilyConnectorTransport;
  status: Record<string, unknown>;
  capabilities: Record<string, unknown> | null;
}

export interface AilyConnectorSessionEvent {
  sessionId?: string;
  transport?: AilyConnectorTransport;
  sequence?: number;
  event?: {
    type: string;
    text?: string;
    data?: Uint8Array;
    [key: string]: unknown;
  };
  type?: string;
  error?: { code: string; message: string };
}

export interface AilySshConnectOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  hostKeyPolicy?: 'accept-any' | 'trust-on-first-use';
}

export interface AilySerialConnectOptions {
  port: string;
  baudRate?: number;
  allowRawConsole?: boolean;
}

export interface AilyProjectSyncFile {
  path: string;
  dataBase64: string;
}

interface ConnectorPreloadApi {
  waitForReady(): Promise<{ version: string; protocolVersion: number }>;
  connect(options: {
    transport: AilyConnectorTransport;
    endpoint: Record<string, unknown>;
    credentials?: Record<string, unknown>;
  }): Promise<AilyConnectorSession>;
  request<T = unknown>(options: {
    sessionId: string;
    operation: string;
    payload?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<T>;
  disconnect(options: { sessionId: string }): Promise<{ disconnected: boolean }>;
  onEvent(callback: (event: AilyConnectorSessionEvent) => void): () => void;
}

interface SerialConnectorLease {
  port: string;
  operationId: string;
}

@Injectable({ providedIn: 'root' })
export class AilyConnectorService implements OnDestroy {
  private readonly sessionMap = new Map<string, AilyConnectorSession>();
  private readonly eventSubject = new Subject<AilyConnectorSessionEvent>();
  private readonly serialLeases = new Map<string, SerialConnectorLease>();
  private readonly lastEventSequences = new Map<string, number>();
  private readonly externalSerialReleaseTasks = new Map<string, Promise<void>>();
  private removeEventListener: (() => void) | null = null;
  private resourceSignalSubscription: Subscription | null = null;
  private serialLeaseSequence = 0;

  readonly events$ = this.eventSubject.asObservable();

  constructor(
    private readonly zone: NgZone,
    private readonly uiService: UiService,
    private readonly subappResourceLifecycle: SubappResourceLifecycleService,
    private readonly translate: TranslateService,
  ) {
    this.resourceSignalSubscription = this.uiService.actionSubject.subscribe(action => {
      this.handleExternalSerialResourceSignal(action as Record<string, unknown>);
    });
    const api = this.api;
    if (!api) return;
    this.removeEventListener = api.onEvent(event => {
      this.zone.run(() => this.handleEvent(event as AilyConnectorSessionEvent));
    });
  }

  get sessions(): ReadonlyMap<string, AilyConnectorSession> {
    return this.sessionMap;
  }

  waitForReady(): Promise<{ version: string; protocolVersion: number }> {
    return this.requireApi().waitForReady();
  }

  async connectSsh(options: AilySshConnectOptions): Promise<AilyConnectorSession> {
    const credentials = {
      ...(options.password !== undefined ? { password: options.password } : {}),
    };
    try {
      const session = await this.requireApi().connect({
        transport: 'ssh',
        endpoint: {
          host: options.host,
          port: options.port ?? 22,
          username: options.username,
          ...(options.privateKeyPath ? { privateKeyPath: options.privateKeyPath } : {}),
          hostKeyPolicy: options.hostKeyPolicy ?? 'trust-on-first-use',
        },
        credentials,
      }) as AilyConnectorSession;
      this.addSession(session);
      return session;
    } finally {
      credentials.password = undefined;
    }
  }

  async connectSerial(options: AilySerialConnectOptions): Promise<AilyConnectorSession> {
    const port = String(options.port || '').trim();
    if (!port) throw new Error(this.t('SERIAL_PORT_REQUIRED'));

    const lease: SerialConnectorLease = {
      port,
      operationId: this.createSerialLeaseOperationId(port),
    };
    try {
      await this.sendSerialResourceSignal('serial-monitor:disconnect', lease);
    } catch (error) {
      await this.resumeSerialLease(lease, 'failed');
      throw error;
    }

    let session: AilyConnectorSession;
    try {
      session = await this.requireApi().connect({
        transport: 'serial',
        endpoint: {
          port,
          baudRate: options.baudRate ?? 115200,
          allowRawConsole: options.allowRawConsole !== false,
        },
      }) as AilyConnectorSession;
    } catch (error) {
      await this.resumeSerialLease(lease, 'failed');
      throw error;
    }

    this.serialLeases.set(session.sessionId, lease);
    this.addSession(session);
    return session;
  }

  request<T = unknown>(
    sessionId: string,
    operation: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    this.requireKnownSession(sessionId);
    return this.requireApi().request<T>({
      sessionId,
      operation,
      payload,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  syncProject(
    sessionId: string,
    remoteRoot: string,
    files: readonly AilyProjectSyncFile[],
  ): Promise<Record<string, unknown>> {
    return this.request(sessionId, 'project.sync', {
      remoteRoot,
      files: [...files],
      deleteExtraneous: false,
    }, 4 * 60 * 60 * 1_000);
  }

  stopPython(sessionId: string): Promise<Record<string, unknown>> {
    return this.request(sessionId, 'run.stop');
  }

  async disconnect(sessionId: string): Promise<void> {
    this.requireKnownSession(sessionId);
    await this.requireApi().disconnect({ sessionId });
    this.removeSession(sessionId);
    await this.releaseSerialLease(sessionId, 'success');
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.sessions.keys(), sessionId => this.disconnect(sessionId)));
    await this.releaseAllSerialLeases('success');
  }

  ngOnDestroy(): void {
    this.resourceSignalSubscription?.unsubscribe();
    this.resourceSignalSubscription = null;
    this.removeEventListener?.();
    this.removeEventListener = null;
    void this.disconnectAll();
    this.eventSubject.complete();
  }

  private get api(): ConnectorPreloadApi | null {
    return (
      window as unknown as { electronAPI?: { connector?: ConnectorPreloadApi } }
    ).electronAPI?.connector || null;
  }

  private requireApi(): ConnectorPreloadApi {
    const api = this.api;
    if (!api) throw new Error(this.t('ELECTRON_ONLY'));
    return api;
  }

  private requireKnownSession(sessionId: string): AilyConnectorSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(this.t('SESSION_NOT_CONNECTED'));
    return session;
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.translate.instant(`AILY_CONNECTOR.${key}`, params);
  }

  private addSession(session: AilyConnectorSession): void {
    this.sessionMap.set(session.sessionId, session);
    this.lastEventSequences.set(session.sessionId, 0);
  }

  private removeSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.sessionMap.delete(sessionId);
    this.lastEventSequences.delete(sessionId);
  }

  private handleEvent(event: AilyConnectorSessionEvent): void {
    if (event.type === 'connector.crashed') {
      this.sessionMap.clear();
      this.lastEventSequences.clear();
      void this.releaseAllSerialLeases('failed');
    }
    if (event.sessionId && Number.isInteger(event.sequence)) {
      const sequence = event.sequence as number;
      const previous = this.lastEventSequences.get(event.sessionId) || 0;
      if (sequence <= previous) return;
      this.lastEventSequences.set(event.sessionId, sequence);
    }
    if (event.event?.type === 'device.disconnected' && event.sessionId) {
      this.removeSession(event.sessionId);
      void this.releaseSerialLease(event.sessionId, 'disconnected');
    }
    this.eventSubject.next(event);
  }

  private createSerialLeaseOperationId(port: string): string {
    this.serialLeaseSequence += 1;
    const normalizedPort = port.replace(/[^a-z0-9_.-]+/gi, '-');
    return `linux-connector-${normalizedPort}-${Date.now()}-${this.serialLeaseSequence}`;
  }

  private handleExternalSerialResourceSignal(action: Record<string, unknown>): void {
    if (action['action'] !== 'signal' || action['type'] !== 'tool') return;
    if (action['data'] !== 'serial-monitor:disconnect') return;
    const payload = action['payload'] as Record<string, unknown> | undefined;
    if (!payload || payload['source'] === 'aily-connector') return;
    const port = String(payload['port'] || '').trim().toLowerCase();
    if (!port) return;

    const tasks = Array.from(this.serialLeases.entries())
      .filter(([, lease]) => lease.port.toLowerCase() === port)
      .map(([sessionId]) => this.releaseForExternalSerialOwner(sessionId));
    if (tasks.length === 0) return;
    const release = Promise.all(tasks).then(() => undefined);
    if (Array.isArray(payload['waitFor'])) {
      (payload['waitFor'] as Promise<void>[]).push(release);
    }
  }

  private releaseForExternalSerialOwner(sessionId: string): Promise<void> {
    const active = this.externalSerialReleaseTasks.get(sessionId);
    if (active) return active;
    const task = (async () => {
      const session = this.sessions.get(sessionId);
      if (!session || session.transport !== 'serial') return;
      this.serialLeases.delete(sessionId);
      try {
        await this.requireApi().disconnect({ sessionId });
      } finally {
        this.removeSession(sessionId);
        this.eventSubject.next({
          sessionId,
          transport: 'serial',
          event: {
            type: 'device.disconnected',
            reason: 'SERIAL_RESOURCE_HANDOFF',
          },
        });
      }
    })().finally(() => {
      this.externalSerialReleaseTasks.delete(sessionId);
    });
    this.externalSerialReleaseTasks.set(sessionId, task);
    return task;
  }

  private async releaseSerialLease(sessionId: string, outcome: string): Promise<void> {
    const lease = this.serialLeases.get(sessionId);
    if (!lease) return;
    this.serialLeases.delete(sessionId);
    await this.resumeSerialLease(lease, outcome, sessionId);
  }

  private async releaseAllSerialLeases(outcome: string): Promise<void> {
    const leases = Array.from(this.serialLeases, ([sessionId, lease]) => ({ sessionId, lease }));
    this.serialLeases.clear();
    await Promise.allSettled(
      leases.map(({ sessionId, lease }) => this.resumeSerialLease(lease, outcome, sessionId)),
    );
  }

  private async resumeSerialLease(
    lease: SerialConnectorLease,
    outcome: string,
    sessionId?: string,
  ): Promise<void> {
    await this.sendSerialResourceSignal('serial-monitor:connect', lease, {
      outcome,
      ...(sessionId ? { sessionId } : {}),
    });
  }

  private async sendSerialResourceSignal(
    signal: 'serial-monitor:disconnect' | 'serial-monitor:connect',
    lease: SerialConnectorLease,
    lifecycle: Record<string, unknown> = {},
  ): Promise<void> {
    const waitFor: Promise<void>[] = [];
    const payload: Record<string, unknown> = {
      port: lease.port,
      portType: 'serial',
      waitFor,
      reason: 'linux-connector',
      restore: true,
      operationId: lease.operationId,
      source: 'aily-connector',
      ...lifecycle,
    };
    const subappLifecycleTask = this.subappResourceLifecycle.handleSignal(signal, payload);
    if (subappLifecycleTask) waitFor.push(subappLifecycleTask);
    this.uiService.sendToolSignal(signal, payload);

    if (waitFor.length > 0) {
      try {
        await Promise.all(waitFor);
      } catch (error) {
        if (signal === 'serial-monitor:disconnect') throw error;
        console.warn('[AilyConnector] Failed to restore a serial resource subscriber:', error);
      }
    }

    // Match the uploader handoff: Windows can retain an exclusive serial
    // handle briefly after node-serialport reports that close completed.
    if (signal === 'serial-monitor:disconnect') {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}
