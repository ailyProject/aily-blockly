import type { IMenuItem } from '../../configs/menu.config';
import { Injectable, Injector } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { NoticeService, WorkflowService } from '@core/app-shell/public-api';
import { LogService } from '@core/platform/public-api';
import { ProjectService, type CoderExecutionPort } from '@domain/project/public-api';
import { BuilderService, CompileService, BUILD_APPLICATION_PORT } from '@domain/build/public-api';
import { SerialService, UploaderService, DEVICE_APPLICATION_PORT, selectSerialPort } from '@domain/device/public-api';
import { NpmService, DEPENDENCY_APPLICATION_PORT } from '@domain/dependencies/public-api';
import { BuildApplicationAdapter } from '../build/build-application.adapter';
import { DeviceApplicationAdapter } from '../device/device-application.adapter';
import { DependencyApplicationAdapter } from '../dependencies/dependency-application.adapter';
import { _UploaderService } from '../../editors/blockly-editor/services/uploader.service';
import { _BuilderService } from '../../editors/blockly-editor/services/builder.service';
import type { NoticeOptions } from '@shared/public-api';

export interface CoderProjectRunState {
  build: IMenuItem['state'];
  upload: IMenuItem['state'];
  notice?: NoticeOptions | null;
}

export interface CoderProjectSession {
  injector: Injector;
  project: ProjectService;
  serial: SerialService;
  notice: NoticeService;
  log: LogService;
  busy: 'build' | 'upload' | null;
  editorReady: boolean;
  builderObserved?: boolean;
  state: CoderProjectRunState;
}

/** Independent service instances own processes, cancellation, progress and selected devices. */
@Injectable({ providedIn: 'root' })
export class CoderProjectRuntimeService implements CoderExecutionPort {
  private readonly sessions = new Map<string, CoderProjectSession>();
  private readonly uploadDevices = new Map<string, string>();
  readonly states$ = new BehaviorSubject<ReadonlyMap<string, CoderProjectRunState>>(new Map());
  private activePath = '';

  constructor(
    private readonly injector: Injector,
    private readonly projects: ProjectService,
    private readonly serial: SerialService,
    private readonly notices: NoticeService,
    private readonly logs: LogService,
  ) {
    projects.currentProjectPath$.subscribe(path => {
      if (this.key(path) === this.key(this.activePath)) return;
      const previous = this.sessions.get(this.key(this.activePath));
      if (previous) this.capturePort(previous);
      this.activePath = path;
      if (!path || projects.getProjectMode(path) !== 'coder') return;
      const session = this.getSession(path);
      this.serial.currentPort = session.serial.currentPort;
      this.serial.currentPortInfo = session.serial.currentPortInfo;
      this.logs.list = session.log.list;
      this.notices.clear();
      if (session.state.notice) this.notices.update({ ...session.state.notice, sendToLog: false });
    });
    projects.coderOperationsSubject.subscribe(() => this.publish());
    projects.coderProjects$.subscribe(open => {
      const paths = new Set(open.map(project => this.key(project.path)));
      for (const [key, session] of this.sessions) {
        if (!paths.has(key) && !session.busy) {
          (session.injector as Injector & { destroy?: () => void }).destroy?.();
          this.sessions.delete(key);
        }
      }
    });
  }

  private key(path: string): string { return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
  private isActive(path: string): boolean { return this.key(path) === this.key(this.projects.currentProjectPath); }

  getState(path: string): CoderProjectRunState {
    return this.sessions.get(this.key(path))?.state || { build: 'default', upload: 'default' };
  }

  getSession(path: string): CoderProjectSession {
    const key = this.key(path);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const project = this.projects.getCoderProjectContext(path);
    const serial = Object.assign(Object.create(this.serial), { currentPort: null, currentPortInfo: null }) as SerialService;
    const child = Injector.create({ parent: this.injector, providers: [
      { provide: ProjectService, useValue: project },
      { provide: SerialService, useValue: serial },
      WorkflowService, NoticeService, LogService, NpmService, CompileService, BuilderService, UploaderService, _UploaderService,
      // Coder never uses the Blockly generator/cache. Its legacy uploader status is local.
      { provide: _BuilderService, useValue: { isUploading: false } },
      { provide: BUILD_APPLICATION_PORT, useClass: BuildApplicationAdapter },
      { provide: DEVICE_APPLICATION_PORT, useClass: DeviceApplicationAdapter },
      { provide: DEPENDENCY_APPLICATION_PORT, useClass: DependencyApplicationAdapter },
    ] });
    const session: CoderProjectSession = {
      injector: child, project, serial, notice: child.get(NoticeService), log: child.get(LogService),
      busy: null, editorReady: false, state: { build: 'default', upload: 'default' },
    };
    this.sessions.set(key, session);
    session.notice.stateSubject.subscribe(notice => {
      session.state = { ...session.state, notice };
      this.publish();
      if (this.isActive(path)) notice ? this.notices.update({ ...notice, sendToLog: false }) : this.notices.clear();
    });
    session.log.stateSubject.subscribe(log => {
      if (this.isActive(path)) { this.logs.list = session.log.list; this.logs.stateSubject.next(log); }
    });
    return session;
  }

  private capturePort(session: CoderProjectSession): void {
    session.serial.currentPort = this.serial.currentPort;
    session.serial.currentPortInfo = this.serial.currentPortInfo ? { ...this.serial.currentPortInfo } : null;
  }

  private publish(): void {
    this.states$.next(new Map([...this.sessions].map(([path, session]) => [path, session.state])));
  }

  private async run(path: string, kind: 'build' | 'upload', execute: (session: CoderProjectSession) => Promise<any>): Promise<any> {
    const session = this.getSession(path);
    if (session.busy) throw new Error(`工程正在${session.busy === 'build' ? '编译' : '上传'}: ${path}`);
    session.busy = kind;
    session.state = { ...session.state, [kind]: 'doing' };
    const finish = this.projects.beginCoderOperation(kind, path);
    this.publish();
    try {
      await session.project.syncCurrentBoardConfig();
      if (!session.builderObserved) {
        session.builderObserved = true;
        session.injector.get(BuilderService).buildFinishedSubject.subscribe(event => {
          session.state = { ...session.state, build: event.success ? 'done' : event.result?.state === 'warn' ? 'warn' : 'error' };
          this.publish();
        });
      }
      const result = await execute(session);
      session.state = { ...session.state, [kind]: result?.state || 'done' };
      return result;
    } catch (error: any) {
      session.state = { ...session.state, [kind]: error?.state || 'error' };
      throw error;
    } finally {
      finish();
      session.busy = null;
      this.publish();
    }
  }

  build(path: string, options: { preprocessOnly?: boolean; clearCache?: boolean } = {}): Promise<any> {
    return this.run(path, 'build', async session => {
      const builder = session.injector.get(BuilderService);
      if (options.clearCache) await builder.clearBuildCache(path);
      return builder.build(path, options);
    });
  }

  async resolvePort(path: string, requestedPort?: string) {
    const session = this.getSession(path);
    if (this.isActive(path)) this.capturePort(session);
    await session.project.syncCurrentBoardConfig();
    const ports = await this.serial.getSerialPorts();
    const selection = selectSerialPort(ports, { requestedPort, currentPort: session.serial.currentPort, boardConfig: session.project.currentBoardConfig });
    return { session, ports, selection };
  }

  upload(path: string, port?: string): Promise<any> {
    return this.run(path, 'upload', async session => {
      if (this.isActive(path)) this.capturePort(session);
      const uploader = session.injector.get(UploaderService);
      let device = '';
      if (uploader.requiresLocalPort()) {
        const { selection } = await this.resolvePort(path, port);
        if (!selection.selected) throw new Error(selection.message);
        session.serial.currentPort = selection.selected.name;
        session.serial.currentPortInfo = { ...selection.selected };
        device = `${selection.selected.type || 'serial'}:${selection.selected.name}`;
        if (this.uploadDevices.has(device)) throw new Error(`设备正在被其他工程上传占用: ${selection.selected.name}`);
        this.uploadDevices.set(device, path);
        if (this.isActive(path)) {
          this.serial.currentPort = session.serial.currentPort;
          this.serial.currentPortInfo = session.serial.currentPortInfo;
        }
      }
      try { return await uploader.upload(); }
      finally { if (device) this.uploadDevices.delete(device); }
    });
  }

  cancel(path: string, kind: 'build' | 'upload'): void {
    const session = this.sessions.get(this.key(path));
    if (!session) return;
    if (kind === 'upload' || session.busy === 'upload') session.injector.get(UploaderService).cancel();
    else session.injector.get(BuilderService).cancel();
  }
}
