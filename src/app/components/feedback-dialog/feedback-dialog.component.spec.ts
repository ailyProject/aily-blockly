import { TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { BehaviorSubject, of } from 'rxjs';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { NzMessageService } from 'ng-zorro-antd/message';
import { TranslateService } from '@ngx-translate/core';

import { AuthService } from '@core/auth/public-api';
import { ConfigService } from '@core/preferences/public-api';
import { ElectronService, LogService } from '@core/platform/public-api';
import { SerialService } from '@domain/device/public-api';
import { ProjectService } from '@domain/project/public-api';
import packageJson from '../../../../package.json';
import { FeedbackDialogComponent } from './feedback-dialog.component';
import { sanitizeDiagnosticText } from './feedback-diagnostics.utils';
import { FeedbackService } from './feedback.service';

describe('FeedbackDialogComponent diagnostics submission', () => {
  let feedbackService: jasmine.SpyObj<FeedbackService>;
  let message: jasmine.SpyObj<NzMessageService>;
  let modal: jasmine.SpyObj<NzModalRef>;
  let projectService: {
    currentProjectPath: string;
    currentBoardConfig: unknown;
    getPackageJson: jasmine.Spy;
    getBoardModule: jasmine.Spy;
    getBoardPackageJson: jasmine.Spy;
  };
  let logService: { list: unknown[] };
  let serialService: { currentPort: unknown };
  let authUserInfo: BehaviorSubject<any>;
  let authService: {
    currentUser: any;
    userInfo$: BehaviorSubject<any>;
    isAuthenticated: boolean;
    getAuthInitializationState: jasmine.Spy;
    getAuthSnapshot: jasmine.Spy;
  };
  let configService: { isCnRegion: boolean };
  let translate: {
    currentLang: string;
    defaultLang: string;
    instant: jasmine.Spy;
  };
  let previousPlatform: unknown;
  let previousPath: unknown;
  let previousFs: unknown;

  beforeEach(async () => {
    previousPlatform = (window as any).platform;
    previousPath = (window as any).path;
    previousFs = (window as any).fs;
    (window as any).platform = { type: 'win32' };
    localStorage.removeItem('feedback_dialog_draft');

    feedbackService = jasmine.createSpyObj<FeedbackService>('FeedbackService', [
      'submitFeedback',
      'uploadImage',
    ]);
    feedbackService.submitFeedback.and.returnValue(of({ status: 201 }));
    message = jasmine.createSpyObj<NzMessageService>('NzMessageService', [
      'warning',
      'success',
      'error',
      'loading',
      'remove',
    ]);
    modal = jasmine.createSpyObj<NzModalRef>('NzModalRef', ['close']);
    projectService = {
      currentProjectPath: 'C:\\Users\\tester\\private-project',
      currentBoardConfig: { name: 'Test Board' },
      getPackageJson: jasmine.createSpy('getPackageJson').and.resolveTo({}),
      getBoardModule: jasmine.createSpy('getBoardModule').and.resolveTo('@aily-project/board-test'),
      getBoardPackageJson: jasmine.createSpy('getBoardPackageJson').and.resolveTo({ version: '1.2.3' }),
    };
    logService = { list: [] };
    serialService = { currentPort: 'COM7' };
    authUserInfo = new BehaviorSubject<any>(null);
    authService = {
      currentUser: null,
      userInfo$: authUserInfo,
      isAuthenticated: true,
      getAuthInitializationState: jasmine.createSpy('getAuthInitializationState').and.returnValue('authenticated'),
      getAuthSnapshot: jasmine.createSpy('getAuthSnapshot').and.returnValue({ plan: 'Pro' }),
    };
    configService = { isCnRegion: true };
    translate = {
      currentLang: 'zh-CN',
      defaultLang: 'en',
      instant: jasmine.createSpy('instant').and.callFake((key: string, params?: { name?: string }) => (
        key === 'FEEDBACK_DIALOG.LIBRARY_ISSUE_CONTENT'
          ? `Library: ${params?.name || ''}\nDetails:`
          : key
      )),
    };

    await TestBed.configureTestingModule({
      imports: [FeedbackDialogComponent, NoopAnimationsModule],
      providers: [
        { provide: NzMessageService, useValue: message },
        { provide: NzModalRef, useValue: modal },
        { provide: NZ_MODAL_DATA, useValue: null },
        { provide: ElectronService, useValue: { openUrl: jasmine.createSpy('openUrl') } },
        { provide: ProjectService, useValue: projectService },
        { provide: LogService, useValue: logService },
        { provide: SerialService, useValue: serialService },
        { provide: ConfigService, useValue: configService },
        { provide: AuthService, useValue: authService },
        { provide: TranslateService, useValue: translate },
      ],
    }).overrideComponent(FeedbackDialogComponent, {
      set: {
        template: '',
        providers: [{ provide: FeedbackService, useValue: feedbackService }],
      },
    }).compileComponents();
  });

  afterEach(() => {
    localStorage.removeItem('feedback_dialog_draft');
    if (previousPlatform === undefined) {
      delete (window as any).platform;
    } else {
      (window as any).platform = previousPlatform;
    }
    if (previousPath === undefined) {
      delete (window as any).path;
    } else {
      (window as any).path = previousPath;
    }
    if (previousFs === undefined) {
      delete (window as any).fs;
    } else {
      (window as any).fs = previousFs;
    }
  });

  it('submits feature feedback with one environment timestamp and no private fields in content', async () => {
    const component = createComponent();
    component.feedbackType = 'feature';
    component.feedbackTitle = '  Feature title  ';
    component.feedbackContent = 'Please add a useful feature.';
    component.email = 'private@example.com';

    await component.submitFeedback();

    const payload = submittedPayload();
    expect(payload.label).toBe('feature');
    expect(payload.title).toBe('Feature title');
    expect(payload.email).toBe('private@example.com');
    expect(payload.content).toContain(`| Software Version | ${packageJson.version}-cn |`);
    expect(payload.content).toContain('| OS | win32 |');
    expect(payload.content).toContain('| UI Language | zh-CN |');
    expect(payload.content).toContain('| Account Status Code | 101 |');
    expect(payload.content).toContain(`| Feedback Time | ${payload.timestamp} |`);
    expect(payload.content.match(new RegExp(escapeRegExp(payload.timestamp), 'g'))?.length).toBe(1);
    expect(payload.content).not.toContain('## Diagnostics');
    expect(payload.content).not.toContain('private@example.com');
    expect(Object.prototype.hasOwnProperty.call(payload, 'userAgent')).toBeFalse();
  });

  it('does not read an account snapshot before authentication is complete', () => {
    authService.getAuthInitializationState.and.returnValue('signed_out');
    authService.getAuthSnapshot.and.throwError('snapshot must not be read');
    const component = createComponent();

    expect(component.getBasicInfo('2026-09-02T08:00:00.000Z')).toContain('| Account Status Code | 000 |');
    expect(authService.getAuthSnapshot).not.toHaveBeenCalled();
  });

  it('keeps library context out of the user description and clears an untouched legacy template', async () => {
    const libraryName = '@aily-project/lib-arduino-fft';
    const component = createComponent();
    (component as any).data = {
      feedbackType: 'library',
      feedbackLibraryName: libraryName,
      feedbackContent: `Library: ${libraryName}\nDetails:`,
    };

    component.ngOnInit();

    expect(component.feedbackType).toBe('library');
    expect(component.feedbackLibraryName).toBe(libraryName);
    expect(component.feedbackContent).toBe('');

    component.feedbackTitle = 'Library feedback';
    await component.submitFeedback();
    expect(feedbackService.submitFeedback).not.toHaveBeenCalled();

    component.feedbackType = 'bug';
    component.feedbackContent = `Library: ${libraryName}\nDetails:`;
    (component as any).clearUntouchedLegacyLibraryTemplate();
    expect(component.feedbackContent).toBe('');
  });

  it('preserves a user-written draft when library context is applied', () => {
    const draftContent = 'The FFT result is incorrect for this input.';
    localStorage.setItem('feedback_dialog_draft', JSON.stringify({
      feedbackType: 'bug',
      feedbackTitle: 'Draft title',
      feedbackContent: draftContent,
    }));
    const component = createComponent();
    (component as any).data = {
      feedbackType: 'library',
      feedbackLibraryName: '@aily-project/lib-arduino-fft',
    };

    component.ngOnInit();

    expect(component.feedbackType).toBe('library');
    expect(component.feedbackContent).toBe(draftContent);
  });

  it('keeps an edited legacy template but does not infer a library from arbitrary prose', () => {
    const libraryName = '@aily-project/lib-arduino-fft';
    const component = createComponent();
    (component as any).data = {
      feedbackType: 'library',
      feedbackContent: `Library: ${libraryName}\nDetails:\nThe FFT output is incorrect.`,
    };

    component.ngOnInit();

    expect(component.feedbackContent).toContain('The FFT output is incorrect.');
    expect((component as any).getFeedbackLibraryName()).toBe(libraryName);

    component.feedbackLibraryName = '';
    component.feedbackContent = 'Compile error: partitions.csv is missing.';
    expect((component as any).getFeedbackLibraryName()).toBe('');
  });

  it('reports only supported project modes and keeps the legacy Arduino default', () => {
    const component = createComponent();
    const readProjectMode = (value: unknown) => (
      (component as any).readProjectMode(value, projectService.currentProjectPath)
    );

    expect(readProjectMode({ devmode: ' MicroPython ' })).toBe('micropython');
    expect(readProjectMode({ devmode: 'python' })).toBe('python');
    expect(readProjectMode({})).toBe('arduino');
    expect(readProjectMode({ devmode: 'private-customer-mode' })).toBeNull();
  });

  it('reports malformed project metadata as unavailable instead of empty', () => {
    const component = createComponent();
    const libraryName = '@aily-project/lib-alpha';

    expect((component as any).readDirectLibraries({ dependencies: [] })).toBeNull();
    expect((component as any).countDirectDependencies({ dependencies: 'invalid' })).toBeNull();
    expect((component as any).readBuildUploadParameters({ projectConfig: [] })).toBeNull();
    expect((component as any).readLibrarySource({
      dependencies: { [libraryName]: '1.2.3' },
      ailyLocalLibrarySources: [],
    }, libraryName)).toBeNull();
  });

  it('submits the visible email value after prefill is edited or cleared', async () => {
    authService.currentUser = { email: 'prefilled@example.com' };

    const edited = createComponent();
    edited.ngOnInit();
    expect(edited.email).toBe('prefilled@example.com');
    edited.email = 'edited@example.com';
    prepareValidFeedback(edited);
    await edited.submitFeedback();
    expect(submittedPayload().email).toBe('edited@example.com');
    expect(submittedPayload().content).not.toContain('edited@example.com');

    const cleared = createComponent();
    cleared.ngOnInit();
    expect(cleared.email).toBe('prefilled@example.com');
    cleared.email = '';
    prepareValidFeedback(cleared);
    await cleared.submitFeedback();
    expect(submittedPayload().email).toBe('');
    expect(submittedPayload().content).not.toContain('prefilled@example.com');
  });

  it('keeps the library title unchanged and reports local, registry, and unknown sources with diagnostic paths', async () => {
    const libraryName = '@aily-project/lib-alpha';
    const localPath = 'local-libraries/private-alpha';

    projectService.getPackageJson.and.resolveTo({
      name: 'private-project',
      dependencies: { [libraryName]: 'file:./local-libraries/alpha' },
      ailyLocalLibrarySources: { [libraryName]: localPath },
    });
    logService.list = [{
      title: 'Library operation',
      detail: `${libraryName} failed in ${localPath} for private-project`,
      state: 'error',
      timestamp: Date.now(),
    }];
    let component = createComponent();
    prepareValidFeedback(component, 'library');
    component.feedbackTitle = '  Library title  ';
    component.feedbackLibraryName = libraryName;
    await component.submitFeedback();
    let payload = submittedPayload();
    expect(payload.title).toBe('Library title');
    expect(payload.title).not.toContain(`[${libraryName}]`);
    expect(payload.content).toContain('| Source | local |');
    expect(payload.content).toContain('| Version | null |');
    expect(payload.content).toContain(localPath);
    expect(payload.content).toContain('private-project');

    projectService.getPackageJson.and.resolveTo({ dependencies: { [libraryName]: '^1.2.3' } });
    component = createComponent();
    prepareValidFeedback(component, 'library');
    component.feedbackLibraryName = libraryName;
    await component.submitFeedback();
    payload = submittedPayload();
    expect(payload.content).toContain('| Source | registry |');

    projectService.getPackageJson.and.resolveTo({});
    component = createComponent();
    prepareValidFeedback(component, 'library');
    component.feedbackLibraryName = libraryName;
    await component.submitFeedback();
    payload = submittedPayload();
    expect(payload.content).toContain('| Version | null |');
    expect(payload.content).toContain('| Source | null |');
  });

  it('uses only whitelisted build metadata, library dependencies, terminal OTA state, and safe ports', async () => {
    const uploadTime = Date.parse('2026-09-02T08:30:00.000Z');
    projectService.getPackageJson.and.resolveTo({
      dependencies: {
        '@aily-project/board-test': '1.0.0',
        '@aily-project/lib-alpha': '^1.2.3',
        lodash: '^4.17.21',
      },
      buildInfo: {
        lastBuildStatus: 'success',
        lastBuildTime: '2026-09-02T08:00:00.000Z',
        lastBuildDuration: 1.25,
        lastBuildCode: 'private-build-code-hash',
      },
      projectConfig: {
        CDCOnBoot: 'cdc',
        UploadSpeed: 921600,
        wifiPassword: 'private-wifi-password',
        networkOtaTargets: { privateHost: 'private-host' },
      },
    });
    logService.list = [{ detail: '[WiFi OTA] upload completed', state: 'done', timestamp: uploadTime }];
    const component = createComponent();
    spyOn(component as any, 'readProjectDiagnosticLogs').and.resolveTo({
      compile: { status: 'none', content: null, truncated: false },
      upload: {
        status: 'ok',
        content: `[${formatProjectLogTimestamp(uploadTime)}] [INFO] [upload] [WiFi OTA] upload completed`,
        truncated: false,
      },
    });
    prepareValidFeedback(component, 'build&upload');

    await component.submitFeedback();

    let content = String(submittedPayload().content);
    expect(content).toContain('| Board | Test Board |');
    expect(content).toContain('| Board Package | @aily-project/board-test |');
    expect(content).toContain('| Board Package Version | 1.2.3 |');
    expect(content).toContain('| Port | COM7 |');
    expect(content).toContain('"name": "@aily-project/lib-alpha"');
    expect(content).toContain('"version": "^1.2.3"');
    expect(content).not.toContain('lodash');
    expect(content).toContain('"status": "success"');
    expect(content).toContain('"durationSeconds": 1.25');
    expect(content).toContain('"CDCOnBoot": "cdc"');
    expect(content).toContain('"UploadSpeed": 921600');
    expect(content).not.toContain('private-wifi-password');
    expect(content).not.toContain('private-host');
    expect(content).toContain(`"Last Upload Result Time": "${new Date(uploadTime).toISOString()}"`);
    expect(content).not.toContain('private-build-code-hash');

    serialService.currentPort = 'network-ota:private-host:65280:/sketch';
    const unsafePortComponent = createComponent();
    prepareValidFeedback(unsafePortComponent, 'build&upload');
    await unsafePortComponent.submitFeedback();
    content = String(submittedPayload().content);
    expect(content).toContain('| Port | null |');

    serialService.currentPort = '/dev/ttyUSB0';
    const posixPortComponent = createComponent();
    prepareValidFeedback(posixPortComponent, 'build&upload');
    await posixPortComponent.submitFeedback();
    content = String(submittedPayload().content);
    expect(content).toContain('| Port | /dev/ttyUSB0 |');

    for (const serialBearingPort of [
      '/dev/tty.usbserial-A50285BI',
      '/dev/cu.usbserial-PRIVATE123',
    ]) {
      serialService.currentPort = serialBearingPort;
      const serialBearingPortComponent = createComponent();
      prepareValidFeedback(serialBearingPortComponent, 'build&upload');
      await serialBearingPortComponent.submitFeedback();
      content = String(submittedPayload().content);
      expect(content).toContain('| Port | null |');
      expect(content).not.toContain(serialBearingPort);
    }
  });

  it('does not publish repository or path dependency specifications as versions', async () => {
    projectService.getPackageJson.and.resolveTo({
      dependencies: {
        '@aily-project/lib-alpha': 'git+ssh://git@private.example/team/lib.git#private-token',
      },
    });
    const component = createComponent();
    prepareValidFeedback(component, 'build&upload');

    await component.submitFeedback();

    const content = String(submittedPayload().content);
    expect(content).toContain('"name": "@aily-project/lib-alpha"');
    expect(content).toContain('"version": null');
    expect(content).not.toContain('private.example');
    expect(content).not.toContain('private-token');
  });

  it('does not reuse an older OTA terminal state after newer project upload activity', async () => {
    const uploadTime = Date.parse('2026-09-02T08:30:00.000Z');
    logService.list = [
      { detail: '[WiFi OTA] upload completed', state: 'done', timestamp: uploadTime },
      { detail: 'ordinary serial upload activity', state: 'doing', timestamp: uploadTime + 1_000 },
    ];
    const component = createComponent();
    spyOn(component as any, 'readProjectDiagnosticLogs').and.resolveTo({
      compile: { status: 'none', content: null, truncated: false },
      upload: {
        status: 'ok',
        content: sanitizeDiagnosticText([
          `[${formatProjectLogTimestamp(uploadTime)}] [INFO] [upload] [WiFi OTA] upload completed`,
          `[${formatProjectLogTimestamp(uploadTime + 1_000)}] [DEBUG] [upload] Writing private-firmware.bin`,
        ].join('\n')),
        truncated: false,
      },
    });
    prepareValidFeedback(component, 'build&upload');

    await component.submitFeedback();

    expect(submittedPayload().content).toContain('"Last Upload Result": null');
    expect(submittedPayload().content).toContain('"Last Upload Result Time": null');
  });

  it('keeps explicit OTA result evidence when the older public upload log is dropped', async () => {
    const uploadTime = Date.parse('2026-09-02T08:30:00.000Z');
    const detail = '[WiFi OTA] upload completed';
    logService.list = [{ detail, state: 'done', timestamp: uploadTime }];
    const component = createComponent();
    spyOn(component as any, 'readProjectDiagnosticLogs').and.resolveTo({
      compile: {
        status: 'ok',
        content: '[2026-09-02 08:31:00.000] [ERROR] [compile] newer compile output',
        truncated: true,
      },
      upload: {
        status: 'ok',
        content: '[truncated; latest content retained]',
        truncated: true,
      },
      uploadEvidence: {
        latestTimestamp: uploadTime,
        latestOtaEntry: { timestamp: uploadTime, detail },
      },
    });
    prepareValidFeedback(component, 'build&upload');

    await component.submitFeedback();

    const content = String(submittedPayload().content);
    expect(content).toContain('"Last Upload Result": {');
    expect(content).toContain('"status": "success"');
    expect(content).toContain(`"Last Upload Result Time": "${new Date(uploadTime).toISOString()}"`);
  });

  it('finds the latest abnormal process event even when it is outside the raw context tail', async () => {
    const crashLine = '[2026-09-02 09:00:00.000] [error] [ProcessHealth][RendererGone] {"reason":"crashed","exitCode":7}';
    const readTailLines = jasmine.createSpy('readTailLines').and.callFake(async (
      _filePath: string,
      options: { filterPattern?: string },
    ) => options.filterPattern ? [crashLine] : Array.from({ length: 401 }, (_, index) => `normal ${index}`));
    (window as any).path = {
      getAppDataPath: () => '/isolated/appdata',
      join: (...parts: string[]) => parts.join('/'),
    };
    (window as any).fs = {
      existsSync: () => true,
      readTailLines,
    };
    const component = createComponent();

    const crash = await (component as any).readLatestCrashDiagnostic();

    expect(crash.reason).toBe('crashed');
    expect(crash.exitCode).toBe(7);
    expect(crash.context).toBe(crashLine);
    expect(readTailLines).toHaveBeenCalledWith('/isolated/appdata/logs/app.log', {
      maxLines: 32 * 1024,
      filterPattern: '\\[ProcessHealth\\]\\[(?:RendererGone|ChildGone)\\]',
    });
    expect(readTailLines).toHaveBeenCalledWith('/isolated/appdata/logs/app.log', { maxLines: 401 });
  });

  it('sanitizes the complete app-log window before selecting crash context lines', async () => {
    const crashLine = '[2026-09-02 09:00:00.000] [error] [ProcessHealth][RendererGone] {"reason":"crashed","exitCode":7}';
    const privateSourceLines = Array.from({ length: 4 }, (_, index) => `private_source_line_${index + 1}();`);
    (window as any).path = {
      getAppDataPath: () => '/isolated/appdata',
      join: (...parts: string[]) => parts.join('/'),
    };
    (window as any).fs = {
      existsSync: () => true,
      readTailLines: async (_filePath: string, options: { filterPattern?: string }) => (
        options.filterPattern
          ? [crashLine]
          : ['sourceCode:', ...privateSourceLines, crashLine]
      ),
    };
    const component = createComponent();

    const crash = await (component as any).readLatestCrashDiagnostic();

    expect(crash.context).toBe(crashLine);
    expect(privateSourceLines.some((line) => crash.context.includes(line))).toBeFalse();
  });

  it('uses a custom user home when sanitizing a crash context username with spaces', async () => {
    const crashLine = '[2026-09-02 09:00:00.000] [error] [ProcessHealth][RendererGone] {"reason":"crashed","exitCode":7}';
    const privatePathLine = '[2026-09-02 09:00:00.001] [error] failed at D:\\Profiles\\Alice Smith\\project';
    (window as any).path = {
      getAppDataPath: () => 'D:\\ApplicationData\\aily-project',
      getUserHome: () => 'D:\\Profiles\\Alice Smith',
      join: (...parts: string[]) => parts.join('\\'),
    };
    (window as any).fs = {
      existsSync: () => true,
      readTailLines: async (_filePath: string, options: { filterPattern?: string }) => (
        options.filterPattern ? [crashLine] : [crashLine, privatePathLine]
      ),
    };
    const component = createComponent();

    const crash = await (component as any).readLatestCrashDiagnostic();

    expect(crash.context).toContain('failed at D:\\Profiles\\[USER]\\project');
    expect(crash.context).not.toContain('Alice Smith');
  });

  it('uses a custom user home when sanitizing diagnostic blocks', () => {
    const getUserHome = jasmine.createSpy('getUserHome').and.returnValue('D:\\Profiles\\Alice Smith');
    (window as any).path = {
      getUserHome,
    };
    const component = createComponent();

    const sanitized = (component as any).sanitizeBlock(
      'compile failed at D:\\Profiles\\Alice Smith\\project\\src\\main.cpp',
      [],
    );

    expect(sanitized).toBe('compile failed at D:\\Profiles\\[USER]\\project\\src\\main.cpp');

    getUserHome.and.throwError('home unavailable');
    expect((component as any).sanitizeBlock('compile failed', [])).toBe('compile failed');
  });

  it('submits null diagnostics and clears loading when project, board, and port getters fail', async () => {
    projectService.getPackageJson.and.callFake(async () => {
      throw new Error('package unavailable');
    });
    projectService.getBoardModule.and.callFake(async () => {
      throw new Error('board module unavailable');
    });
    projectService.getBoardPackageJson.and.callFake(async () => {
      throw new Error('board package unavailable');
    });
    Object.defineProperty(projectService, 'currentProjectPath', {
      configurable: true,
      get: () => {
        throw new Error('project path unavailable');
      },
    });
    Object.defineProperty(projectService, 'currentBoardConfig', {
      configurable: true,
      get: () => {
        throw new Error('board unavailable');
      },
    });
    Object.defineProperty(serialService, 'currentPort', {
      configurable: true,
      get: () => {
        throw new Error('port unavailable');
      },
    });
    const component = createComponent();
    prepareValidFeedback(component, 'build&upload');

    await component.submitFeedback();

    const payload = submittedPayload();
    expect(feedbackService.submitFeedback).toHaveBeenCalled();
    expect(payload.content).toContain('| Board | null |');
    expect(payload.content).toContain('| Board Package | null |');
    expect(payload.content).toContain('| Board Package Version | null |');
    expect(payload.content).toContain('| Port | null |');
    expect(payload.content).toContain('### Libraries\n\n```json\nnull\n```');
    expect(payload.content).toContain('### Parameters\n\n```json\nnull\n```');
    expect(component.isSubmitting).toBeFalse();
  });

  function createComponent(): FeedbackDialogComponent {
    return TestBed.createComponent(FeedbackDialogComponent).componentInstance;
  }

  function prepareValidFeedback(component: FeedbackDialogComponent, type = 'feature'): void {
    component.feedbackType = type;
    component.feedbackTitle = 'Feedback title';
    component.feedbackContent = 'Feedback content is long enough.';
  }

  function submittedPayload(): any {
    return feedbackService.submitFeedback.calls.mostRecent().args[0];
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function formatProjectLogTimestamp(timestamp: number): string {
    const value = new Date(timestamp);
    const pad = (part: number, length = 2) => String(part).padStart(length, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} `
      + `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${pad(value.getMilliseconds(), 3)}`;
  }
});
