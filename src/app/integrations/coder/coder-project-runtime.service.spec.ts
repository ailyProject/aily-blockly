import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, of, Subject } from 'rxjs';
import { NzMessageService } from 'ng-zorro-antd/message';
import { TranslateService } from '@ngx-translate/core';
import { NoticeService } from '@core/app-shell/public-api';
import { CmdService, CrossPlatformCmdService, ElectronService, LogService, PlatformService } from '@core/platform/public-api';
import { ConfigService } from '@core/preferences/public-api';
import { ProjectService, CODER_EXECUTION_PORT } from '@domain/project/public-api';
import {
  BUILD_ACTION_PORT,
  CoderBuildInfoService,
  CompileValidationService,
} from '@domain/build/public-api';
import { SerialService, UploaderService } from '@domain/device/public-api';
import { CoderProjectRuntimeService } from './coder-project-runtime.service';

describe('Coder concurrent process integration', () => {
  let runtime: CoderProjectRuntimeService;
  let project: any;
  let serial: any;
  let commands: { command: string; output: Subject<any>; id: string }[];
  let killed: string[];
  let originals: any;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  beforeEach(() => {
    originals = { path: window['path'], fs: window['fs'], cmd: window['cmd'] };
    window['path'] = { join: (...parts: string[]) => parts.join('/'), isExists: () => true,
      getAilyBuilderPath: () => '/builder', getAilyChildPath: () => '/child', getAppDataPath: () => '/appdata' };
    window['fs'] = { existsSync: () => true, appendFileSync: () => {}, mkdirSync: () => {}, readFileSync: (path: string) => path.endsWith('package.json')
      ? JSON.stringify({ type: 'coder', entry: 'src/main.cpp', dependencies: { '@aily-project/board-uno': '1' } }) : 'void setup() {}\nvoid loop() {}',
      writeFileSync: jasmine.createSpy('write') };
    commands = []; killed = [];
    spyOn(CmdService.prototype, 'run').and.callFake((command: string) => {
      const output = new Subject<any>(); const id = `process-${commands.length}`;
      commands.push({ command, output, id }); return output;
    });
    spyOn(CmdService.prototype, 'kill').and.callFake(async (id: string) => { killed.push(id); return true; });
    const contexts = new Map<string, any>();
    project = {
      currentProjectPath: '/a', currentProjectPath$: new BehaviorSubject('/a'),
      coderProjects$: new BehaviorSubject([{ path: '/a' }, { path: '/b' }]),
      coderProjects: [{ path: '/a' }, { path: '/b' }],
      coderOperationsSubject: new BehaviorSubject(new Map()),
      getProjectMode: () => 'coder',
      beginCoderOperation: () => () => {},
      getCoderProjectContext(path: string) {
        if (!contexts.has(path)) contexts.set(path, {
          currentProjectPath: path, isCoderProjectContext: true,
          coderProjects: project.coderProjects, currentBoardConfig: {}, boardChangeSubject: new Subject(),
          isAilyCodeProject: () => true, beginCoderOperation: () => () => {},
          syncCurrentBoardConfig: async () => true,
        });
        return contexts.get(path);
      },
    };
    serial = { currentPort: null, currentPortInfo: null,
      getSerialPorts: async () => [{ name: '/dev/A', type: 'serial' }, { name: '/dev/B', type: 'serial' }] };
    TestBed.configureTestingModule({ providers: [
      CoderProjectRuntimeService, NoticeService, LogService, CmdService,
      { provide: CODER_EXECUTION_PORT, useExisting: CoderProjectRuntimeService },
      { provide: ProjectService, useValue: project }, { provide: SerialService, useValue: serial },
      { provide: BUILD_ACTION_PORT, useValue: { hasListener: () => false, dispatchWithFeedback: () => of({ success: true }) } },
      { provide: CrossPlatformCmdService, useValue: {} },
      { provide: ElectronService, useValue: { pathJoin: (...parts: string[]) => parts.join('/'), isWindowFocused: () => true } },
      { provide: PlatformService, useValue: { za7: '/7z' } },
      { provide: ConfigService, useValue: { data: {} } },
      { provide: NzMessageService, useValue: { warning: () => {}, error: () => {} } },
      { provide: TranslateService, useValue: { instant: (key: string) => key } },
      { provide: CompileValidationService, useValue: { triggerAfterSuccessfulCompile: () => {} } },
      { provide: CoderBuildInfoService, useValue: {
        updateCodeHash: async (path: string) => `hash:${path}`,
        saveBuildInfo: async () => {},
      } },
    ] });
    runtime = TestBed.inject(CoderProjectRuntimeService);
  });
  afterEach(() => { TestBed.resetTestingModule(); Object.assign(window, originals); });

  function started(command: typeof commands[number]): void { command.output.next({ type: 'stdout', data: 'running\n', streamId: command.id }); }
  function finish(command: typeof commands[number]): void { command.output.next({ type: 'close', code: 0, streamId: command.id }); command.output.complete(); }

  it('records command and RPC failures in the owning project without leaking across tabs', async () => {
    (CmdService.prototype.run as jasmine.Spy).and.callThrough();
    const callbacks = new Map<string, (data: any) => void>();
    window['cmd'] = {
      onData: (id: string, callback: (data: any) => void) => {
        callbacks.set(id, callback); return () => callbacks.delete(id);
      },
      run: async () => ({ success: true }),
    };
    const a = runtime.getSession('/a'); const b = runtime.getSession('/b');
    const visible = TestBed.inject(LogService);
    a.injector.get(CmdService).run('npm install', '/a', false).subscribe();
    const [id, callback] = [...callbacks.entries()][0];
    callback({ type: 'stderr', data: 'dependency install failed', streamId: id });
    // Finish A after switching to B: the failure must remain attached to A.
    project.currentProjectPath = '/b'; project.currentProjectPath$.next('/b');
    callback({ type: 'close', code: 1, streamId: id });
    a.notice.update({ title: 'Library preparation failed', detail: 'Unknown Aily Coder Agent method: coder.library.materialize', state: 'error' });
    expect((await visible.readPage()).entries).toEqual([]);
    expect(b.log.list).toEqual([]);
    project.currentProjectPath = '/a'; project.currentProjectPath$.next('/a');
    const entries = (await visible.readPage()).entries;
    expect(entries.map(entry => entry.detail)).toEqual([
      'npm install', 'npm install\ndependency install failed',
      'Unknown Aily Coder Agent method: coder.library.materialize',
    ]);
    project.currentProjectPath = ''; project.currentProjectPath$.next('');
    expect((await visible.readPage()).entries).toEqual([]);
  });

  it('starts both real compile pipelines before either finishes and cancels only the addressed process', async () => {
    const a = runtime.build('/a').catch(error => error);
    const b = runtime.build('/b');
    await tick();
    expect(commands.length).toBe(2);
    expect(commands[0].command).toContain('/a/sketch/build-config.json');
    expect(commands[1].command).toContain('/b/sketch/build-config.json');
    commands.forEach(started);
    project.currentProjectPath = '/b'; project.currentProjectPath$.next('/b');
    runtime.cancel('/a', 'build');
    await a;
    expect(killed).toEqual([commands[0].id]);
    expect(runtime.getState('/b').build).toBe('doing');
    finish(commands[1]); await tick();
    expect(commands[2].command).toContain('/b/sketch/build-config.json');
    started(commands[2]); finish(commands[2]);
    expect((await b).state).toBe('done');
    expect(runtime.getState('/a').build).toBe('warn');
    expect(runtime.getState('/b').build).toBe('done');
  });

  it('lets separate devices upload concurrently, rejects a shared port, and releases the lease after failure', async () => {
    const pending: Record<string, { resolve: (value: any) => void; reject: (value: any) => void }> = {};
    for (const path of ['/a', '/b']) {
      const session = runtime.getSession(path);
      const get = session.injector.get.bind(session.injector);
      spyOn(session.injector, 'get').and.callFake(((token: any, ...args: any[]) => token === UploaderService ? {
        requiresLocalPort: () => true,
        upload: () => new Promise((resolve, reject) => { pending[path] = { resolve, reject }; }),
      } : get(token, ...args)) as any);
    }
    const a = runtime.upload('/a', '/dev/A'); await tick();
    await expectAsync(runtime.upload('/b', '/dev/A')).toBeRejectedWithError(/设备正在被其他工程/);
    const b = runtime.upload('/b', '/dev/B').catch(error => error); await tick();
    expect(Object.keys(pending)).toEqual(['/a', '/b']);
    pending['/b'].reject(new Error('upload failed')); await b;
    expect(runtime.getState('/a').upload).toBe('doing');
    const retry = runtime.upload('/b', '/dev/B'); await tick();
    pending['/b'].resolve({ state: 'done' }); await retry;
    pending['/a'].resolve({ state: 'done' }); await a;
    expect(runtime.getState('/a').upload).toBe('done');
    expect(runtime.getState('/b').upload).toBe('done');
  });

  it('restores each project device selection and notification on activation', () => {
    const a = runtime.getSession('/a'); const b = runtime.getSession('/b');
    serial.currentPort = '/dev/A'; serial.currentPortInfo = { name: '/dev/A', type: 'serial' };
    b.serial.currentPort = '/dev/B'; b.serial.currentPortInfo = { name: '/dev/B', type: 'serial' };
    a.notice.update({ title: 'A build', text: 'A progress', state: 'doing', progress: 20 });
    b.notice.update({ title: 'B upload', text: 'B progress', state: 'doing', progress: 60 });
    const shown: any[] = []; TestBed.inject(NoticeService).stateSubject.subscribe(value => shown.push(value));
    project.currentProjectPath = '/b'; project.currentProjectPath$.next('/b');
    expect(serial.currentPort).toBe('/dev/B'); expect(shown.at(-1).title).toBe('B upload');
    project.currentProjectPath = '/a'; project.currentProjectPath$.next('/a');
    expect(serial.currentPort).toBe('/dev/A'); expect(shown.at(-1).title).toBe('A build');
  });

  it('shows each completed build once across project switches, including a background completion', () => {
    const a = runtime.getSession('/a'); const b = runtime.getSession('/b');
    const shown: any[] = [];
    TestBed.inject(NoticeService).stateSubject.subscribe(value => shown.push(value));

    a.notice.update({ title: 'A completed', state: 'done', setTimeout: 600000 });
    b.notice.update({ title: 'B completed', state: 'done', setTimeout: 600000 });
    expect(shown.filter(value => value?.title === 'A completed').length).toBe(1);
    expect(shown.filter(value => value?.title === 'B completed').length).toBe(0);

    project.currentProjectPath = '/b'; project.currentProjectPath$.next('/b');
    expect(shown.at(-1)?.title).toBe('B completed');
    project.currentProjectPath = '/a'; project.currentProjectPath$.next('/a');
    expect(shown.at(-1)).toBeNull();
    project.currentProjectPath = '/b'; project.currentProjectPath$.next('/b');
    expect(shown.at(-1)).toBeNull();
    expect(shown.filter(value => value?.title === 'A completed').length).toBe(1);
    expect(shown.filter(value => value?.title === 'B completed').length).toBe(1);

    b.notice.update({ title: 'B rebuilt', state: 'done', setTimeout: 600000 });
    expect(shown.at(-1)?.title).toBe('B rebuilt');
  });

  it('restores a running build after switching away and shows its completion once', () => {
    const a = runtime.getSession('/a'); runtime.getSession('/b');
    const shown: any[] = [];
    TestBed.inject(NoticeService).stateSubject.subscribe(value => shown.push(value));
    a.notice.update({ title: 'A building', state: 'doing', progress: 35 });
    project.currentProjectPath = '/b'; project.currentProjectPath$.next('/b');
    project.currentProjectPath = '/a'; project.currentProjectPath$.next('/a');
    expect(shown.at(-1)?.title).toBe('A building');
    a.notice.update({ title: 'A completed', state: 'done' });
    expect(shown.at(-1)?.title).toBe('A completed');
    project.currentProjectPath = '/b'; project.currentProjectPath$.next('/b');
    project.currentProjectPath = '/a'; project.currentProjectPath$.next('/a');
    expect(shown.at(-1)).toBeNull();
    expect(shown.filter(value => value?.title === 'A completed').length).toBe(1);
  });
});
