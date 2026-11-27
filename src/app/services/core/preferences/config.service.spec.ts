import { EMPTY, of, Subject, throwError } from 'rxjs';
import { API, getServerUrl, getToolWebUrl, setRegistryUrl, setServerUrl, setToolWebUrl } from '../../../configs/api.config';
import {
  ConfigService,
  PROJECT_CONNECTOR_SETTINGS_KEY,
  ProjectPackageConfigStore,
} from './config.service';

describe('ConfigService project SSH connector settings', () => {
  let service: ConfigService;

  beforeEach(() => {
    service = new ConfigService({} as any, {} as any, { isLoggedIn$: EMPTY, authSnapshot$: EMPTY, canUseCloudCompilation: false } as any);
  });

  it('reads normalized SSH settings from a project manifest', () => {
    expect(service.getProjectSshConnectorSettings({
      [PROJECT_CONNECTOR_SETTINGS_KEY]: {
        ssh: {
          host: ' 192.168.1.10 ',
          port: '2222',
          username: ' root ',
          privateKeyPath: ' C:\\keys\\board ',
          autoTrustHostKey: false,
          rememberCredentials: true,
        },
      },
    })).toEqual({
      host: '192.168.1.10',
      port: 2222,
      username: 'root',
      privateKeyPath: 'C:\\keys\\board',
      autoTrustHostKey: false,
      rememberCredentials: true,
    });
  });

  it('persists only credential-free SSH fields and preserves other manifest settings', async () => {
    const packageJson = {
      name: 'linux-board-project',
      [PROJECT_CONNECTOR_SETTINGS_KEY]: {
        serial: { baudRate: 921_600 },
      },
    };
    let writtenPackageJson: any;
    const store: ProjectPackageConfigStore = {
      getPackageJson: () => Promise.resolve(packageJson),
      setPackageJson: value => {
        writtenPackageJson = value;
        return Promise.resolve();
      },
    };

    await service.saveProjectSshConnectorSettings(store, {
      host: 'board.local',
      port: 22,
      username: 'root',
      privateKeyPath: '',
      autoTrustHostKey: true,
      rememberCredentials: true,
      password: 'must-not-be-written',
    } as any);

    expect(writtenPackageJson.name).toBe('linux-board-project');
    expect(writtenPackageJson[PROJECT_CONNECTOR_SETTINGS_KEY].serial).toEqual({
      baudRate: 921_600,
    });
    expect(writtenPackageJson[PROJECT_CONNECTOR_SETTINGS_KEY].ssh).toEqual({
      host: 'board.local',
      port: 22,
      username: '',
      privateKeyPath: '',
      autoTrustHostKey: true,
      rememberCredentials: true,
    });
    expect(writtenPackageJson[PROJECT_CONNECTOR_SETTINGS_KEY].ssh.password).toBeUndefined();
  });

  it('ignores incomplete saved settings', () => {
    expect(service.getProjectSshConnectorSettings({
      [PROJECT_CONNECTOR_SETTINGS_KEY]: {
        ssh: { port: 22, username: 'root' },
      },
    })).toBeNull();
  });

  it('reads credential-free settings for later local credential restoration', () => {
    expect(service.getProjectSshConnectorSettings({
      [PROJECT_CONNECTOR_SETTINGS_KEY]: {
        ssh: {
          host: 'board.local',
          port: 22,
          username: '',
          privateKeyPath: '',
          autoTrustHostKey: true,
          rememberCredentials: true,
        },
      },
    })).toEqual({
      host: 'board.local',
      port: 22,
      username: '',
      privateKeyPath: '',
      autoTrustHostKey: true,
      rememberCredentials: true,
    });
  });

  it('does not persist the username when credential memory is disabled', async () => {
    let writtenPackageJson: any;
    const store: ProjectPackageConfigStore = {
      getPackageJson: () => Promise.resolve({ name: 'linux-board-project' }),
      setPackageJson: value => {
        writtenPackageJson = value;
        return Promise.resolve();
      },
    };

    await service.saveProjectSshConnectorSettings(store, {
      host: 'board.local',
      port: 22,
      username: 'root',
      privateKeyPath: '',
      autoTrustHostKey: true,
      rememberCredentials: false,
    });

    expect(writtenPackageJson[PROJECT_CONNECTOR_SETTINGS_KEY].ssh).toEqual({
      host: 'board.local',
      port: 22,
      username: '',
      privateKeyPath: '',
      autoTrustHostKey: true,
      rememberCredentials: false,
    });
  });
});

describe('ConfigService Aily Coder product mode', () => {
  let service: ConfigService;

  beforeEach(() => {
    service = new ConfigService({} as any, {} as any, { isLoggedIn$: EMPTY, authSnapshot$: EMPTY, canUseCloudCompilation: false } as any);
  });

  it('locks the application to Coder without overwriting the shared preference', async () => {
    service.data = {
      coder: { enabled: false },
      developmentModePreference: 'blockly',
    };
    (service as any).runtimeBuildProduct = 'coder';

    expect(service.isCoderEnabled()).toBeTrue();
    expect(service.isCoderProduct()).toBeTrue();
    expect(service.getDevelopmentModePreference()).toBe('coder');
    expect(service.shouldPromptDevelopmentModePreference()).toBeFalse();
    expect(service.getApplicationName()).toBe('aily coder');
    expect(await service.setDevelopmentModePreference('blockly', 'settings')).toBe('coder');
    expect(service.data.developmentModePreference).toBe('blockly');
  });

  it('preserves the existing Blockly fallback for the normal product', () => {
    service.data = {
      coder: { enabled: false },
      developmentModePreference: 'coder',
    };

    expect(service.isCoderEnabled()).toBeFalse();
    expect(service.isCoderProduct()).toBeFalse();
    expect(service.getDevelopmentModePreference()).toBe('blockly');
    expect(service.getApplicationName()).toBe('aily blockly');
  });

  it('keeps the normal product identity when its shared preference is Coder', () => {
    service.data = { coder: { enabled: true }, developmentModePreference: 'coder' };

    expect(service.getDevelopmentModePreference()).toBe('coder');
    expect(service.getApplicationName()).toBe('aily blockly');
  });
});

describe('ConfigService Hub navigation', () => {
  let service: ConfigService;

  beforeEach(() => {
    service = new ConfigService({} as any, {} as any, { isLoggedIn$: EMPTY, authSnapshot$: EMPTY, canUseCloudCompilation: false } as any);
  });

  it('uses the regional Hub and the product identity instead of the development mode', () => {
    service.data = {
      region: 'localhost',
      regions: { localhost: { hub_web: 'http://localhost:4300/' } },
      coder: { enabled: true },
      developmentModePreference: 'coder',
    };

    expect(service.getHubWebUrl('/projects')).toBe('http://localhost:4300/projects?app=ailyblockly');

    (service as any).runtimeBuildProduct = 'coder';
    expect(service.getHubWebUrl('/projects')).toBe('http://localhost:4300/projects?app=ailycoder');
  });

  it('preserves the cloud project identifier when adding the app parameter', () => {
    service.data = { regions: {} };
    const hubUrl = new URL(service.getHubWebUrl(`/publish?cloudProject=${encodeURIComponent('cloud & project')}`));

    expect(hubUrl.origin).toBe('https://hub.aily.pro');
    expect(hubUrl.pathname).toBe('/publish');
    expect(hubUrl.searchParams.get('cloudProject')).toBe('cloud & project');
    expect(hubUrl.searchParams.get('app')).toBe('ailyblockly');
  });
});

describe('ConfigService ZIP download sources', () => {
  const domestic = 'https://blockly.yiyu.pro';
  const r2 = 'https://rs1.aily.pro';
  let previousProcess: any;
  let previousIpc: any;
  let previousUrls: { server: string; registry: string; tool: string };
  let mainEnv: Record<string, string>;
  let invoke: jasmine.Spy;

  function service(region = 'cn', http: any = {}): ConfigService {
    const result = new ConfigService(http, {} as any,
      { isLoggedIn$: EMPTY, authSnapshot$: EMPTY, canUseCloudCompilation: false } as any);
    result.data = {
      region,
      official_region: region === 'eu' ? 'eu' : 'cn',
      resource_source: 'auto',
      resource_sources: [{ key: 'primary', url: r2 }, { key: 'mirror', url: domestic }],
      download_region_order: { cn: ['cn', 'eu'], eu: ['eu', 'cn'] },
      regions: {
        cn: { resource: domestic, api_server: 'https://api.yiyu.pro', official: true },
        eu: { resource: r2, api_server: 'https://api.aily.pro', official: true },
        localhost: { resource: 'http://localhost:4874', api_server: 'http://localhost:3000', official: false },
      },
    };
    return result;
  }

  function expectOrder(urls: string[]): void {
    expect(window['process'].env['AILY_ZIP_URL']).toBe(urls[0]);
    expect(JSON.parse(window['process'].env['AILY_ZIP_URLS']!)).toEqual(urls);
    expect(mainEnv['AILY_ZIP_URL']).toBe(urls[0]);
    expect(JSON.parse(mainEnv['AILY_ZIP_URLS'])).toEqual(urls);
  }

  beforeEach(() => {
    previousProcess = window['process'];
    previousIpc = window['ipcRenderer'];
    previousUrls = { server: getServerUrl(), registry: API.projectList.split('/-/')[0], tool: getToolWebUrl() };
    mainEnv = {};
    window['process'] = { env: {} } as any;
    invoke = jasmine.createSpy('invoke').and.callFake(async (channel: string, payload: any) => {
      expect(channel).toBe('env-set');
      mainEnv[payload.key] = payload.value;
    });
    window['ipcRenderer'] = { invoke };
  });

  afterEach(() => {
    window['process'] = previousProcess;
    window['ipcRenderer'] = previousIpc;
    setServerUrl(previousUrls.server);
    setRegistryUrl(previousUrls.registry);
    setToolWebUrl(previousUrls.tool);
  });

  for (const region of ['cn', 'eu']) {
    it(`synchronizes ${region} ZIP order independently of the current JSON source`, async () => {
      const config = service(region);
      await config.applyResourceSourceRuntimeSelection();

      expectOrder(region === 'cn' ? [domestic, r2] : [r2, domestic]);
      expect(config.getCurrentResourceUrl()).toBe(r2);
    });
  }

  it('uses the new order mapping and falls back for a missing or invalid region entry', async () => {
    const config = service();
    config.data.download_region_order = { cn: [' eu ', 'cn'] };
    await config.applyResourceSourceRuntimeSelection();
    expectOrder([r2, domestic]);

    config.data.download_region_order = { eu: ['eu', 'cn'] };
    await config.applyResourceSourceRuntimeSelection();
    expectOrder([domestic, r2]);

    config.data.download_region_order.cn = [];
    await config.applyResourceSourceRuntimeSelection();
    expectOrder([domestic, r2]);
  });

  it('keeps manual source selection in either region', async () => {
    for (const region of ['cn', 'eu']) {
      const config = service(region);
      config.data.resource_source = 'primary';
      await config.applyResourceSourceRuntimeSelection();
      expectOrder([r2]);
    }
  });

  it('publishes the new ZIP order before an allowed region switch finishes', async () => {
    for (const target of ['cn', 'eu']) {
      const config = service(target);
      config.data.region = 'localhost';
      await config.applyResourceSourceRuntimeSelection();
      expectOrder([r2, domestic]);

      await config.setRegion(target);
      expect(window['process'].env['AILY_REGION']).toBe(target);
      expect(mainEnv['AILY_REGION']).toBe(target);
      expectOrder(target === 'cn' ? [domestic, r2] : [r2, domestic]);
    }
  });

  it('does not let an old window JSON response overwrite newer ZIP settings', async () => {
    const response = new Subject<unknown[]>();
    const get = jasmine.createSpy('get').and.callFake((url: string) =>
      url.startsWith(r2) ? throwError(() => new Error('source unavailable')) : response);
    spyOn(console, 'warn');
    const oldWindow = service('eu', { get });
    const request = (oldWindow as any).fetchResourceJsonOrThrow('/boards.json');
    await Promise.resolve();
    expect(get.calls.count()).toBe(2);

    const currentWindow = service('cn');
    await currentWindow.applyResourceSourceRuntimeSelection();
    const writesBeforeResponse = invoke.calls.count();
    response.next([]);
    response.complete();
    await request;

    expect(invoke.calls.count()).toBe(writesBeforeResponse);
    expectOrder([domestic, r2]);
    expect(oldWindow.getCurrentResourceUrl()).toBe(domestic);
    get.and.returnValue(of([]));
    await (oldWindow as any).fetchResourceJsonOrThrow('/boards.json');
    expect(get.calls.mostRecent().args[0]).toBe(`${domestic}/boards.json`);
  });

  it('retains source filtering and the relative order of extra sources', async () => {
    const config = service();
    config.data.resource_sources = [
      { key: 'extra-a', url: 'https://extra-a.example.test' },
      { key: 'primary', url: r2, enabled: false },
      { key: 'mirror', url: `${domestic}/` },
      { key: 'duplicate', url: domestic },
      { key: 'extra-b', url: 'https://extra-b.example.test' },
    ];
    await config.applyResourceSourceRuntimeSelection();
    expectOrder([domestic, 'https://extra-a.example.test', 'https://extra-b.example.test']);
  });

  it('keeps localhost only in the existing legacy resource fallback', async () => {
    const config = service();
    config.data.resource_sources = [];
    await config.applyResourceSourceRuntimeSelection();
    expectOrder([domestic, r2, 'http://localhost:4874']);
  });
});

describe('ConfigService project compile backend startup', () => {
  it('waits for remembered cloud credentials before a project captures its dependency settings', async () => {
    let releaseAuth!: () => void;
    let started!: () => void;
    const authStarted = new Promise<void>(resolve => { started = resolve; });
    const auth = {
      isLoggedIn$: EMPTY,
      canUseCloudCompilation: false,
      getAuthInitializationState: () => 'checking',
      initializeAuth: jasmine.createSpy().and.callFake(() => {
        started();
        return new Promise<void>(resolve => { releaseAuth = resolve; });
      }),
    };
    const service = new ConfigService({} as any, {} as any, auth as any);
    spyOn(service, 'init').and.callFake(async () => {
      service.data = { compile: { backend: 'cloud' }, region: 'cn', build_flavor: 'cn' };
    });
    const ready = service.initializeProjectCompileBackend();
    await authStarted;
    expect(auth.initializeAuth).toHaveBeenCalledOnceWith('identity');
    expect(service.getCompileBackend()).toBe('local');
    auth.canUseCloudCompilation = true;
    releaseAuth();
    await ready;
    expect(service.getCompileBackend()).toBe('cloud');
  });

  it('allows local projects to load independently of startup authentication', async () => {
    const auth = {
      isLoggedIn$: EMPTY,
      canUseCloudCompilation: false,
      getAuthInitializationState: () => 'checking',
      initializeAuth: jasmine.createSpy(),
    };
    const service = new ConfigService({} as any, {} as any, auth as any);
    spyOn(service, 'init').and.callFake(async () => {
      service.data = { compile: { backend: 'local' }, region: 'cn', build_flavor: 'cn' };
    });
    await service.initializeProjectCompileBackend();
    expect(auth.initializeAuth).not.toHaveBeenCalled();
  });
});
