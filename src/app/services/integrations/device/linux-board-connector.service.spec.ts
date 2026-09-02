import { Buffer } from 'buffer';
import { BehaviorSubject, Subject } from 'rxjs';

import { ConfigService, PROJECT_CONNECTOR_SETTINGS_KEY } from '@core/preferences/public-api';
import { LinuxBoardConnectorService, LinuxBoardSshSettings } from './linux-board-connector.service';

describe('LinuxBoardConnectorService SSH credential persistence', () => {
  const projectPath = 'C:\\Projects\\linux-board';
  const settings: LinuxBoardSshSettings = {
    host: 'board.local',
    port: 22,
    username: 'root',
    password: 'secret',
    privateKeyPath: '',
    autoTrustHostKey: true,
    rememberCredentials: true,
  };

  let previousElectronApi: unknown;
  let services: LinuxBoardConnectorService[];
  let encryptedValues: Map<string, string>;
  let encryptedSequence: number;

  beforeEach(() => {
    previousElectronApi = (window as any).electronAPI;
    services = [];
    encryptedValues = new Map<string, string>();
    encryptedSequence = 0;
    (window as any).electronAPI = {
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptStringToBase64: (plainText: string) => {
          const encrypted = `encrypted-${++encryptedSequence}`;
          encryptedValues.set(encrypted, plainText);
          return encrypted;
        },
        decryptStringFromBase64: (encrypted: string) => {
          const plainText = encryptedValues.get(encrypted);
          if (plainText === undefined) throw new Error('Unknown encrypted value');
          return plainText;
        },
      },
    };
    localStorage.clear();
  });

  afterEach(() => {
    for (const service of services) service.ngOnDestroy();
    localStorage.clear();
    (window as any).electronAPI = previousElectronApi;
  });

  it('restores the remembered username and password after recreating the service', async () => {
    const project = createProjectStore(projectPath);
    const firstService = createService(project);

    await firstService.connectSsh({ ...settings });

    expect(localStorage.length).toBe(1);
    expect(project.packageJson[PROJECT_CONNECTOR_SETTINGS_KEY].ssh).toEqual({
      host: 'board.local',
      port: 22,
      username: '',
      privateKeyPath: '',
      autoTrustHostKey: true,
      rememberCredentials: true,
    });

    const restoredService = createService(project);
    await (restoredService as any).restoreProjectSshSettings(0, {
      mode: ['python'],
      connector: ['ssh'],
    });

    expect(restoredService.getSshSettings()).toEqual(settings);
  });

  it('removes stored credentials when credential memory is disabled', async () => {
    const project = createProjectStore(projectPath);
    const service = createService(project);

    await service.connectSsh({ ...settings });
    expect(localStorage.length).toBe(1);

    await service.connectSsh({ ...settings, rememberCredentials: false });

    expect(localStorage.length).toBe(0);
    expect(service.getSshSettings().username).toBe('');
    expect(service.getSshSettings().password).toBe('');
  });

  it('keeps credentials available when the dialog is immediately reopened', async () => {
    (window as any).electronAPI.safeStorage.encryptStringToBase64 = () => {
      throw new Error('safeStorage is temporarily unavailable');
    };
    const project = createProjectStore(projectPath);
    const service = createService(project);

    await service.connectSsh({ ...settings });

    expect(localStorage.length).toBe(0);
    expect(service.getSshSettings()).toEqual(settings);
    expect(service.getSshSettings()).toEqual(settings);
  });

  it('saves credentials through the legacy preload API until Electron restarts', async () => {
    const legacyValues = new Map<string, string>();
    (window as any).electronAPI.safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (plainText: string) => {
        const encrypted = new TextEncoder().encode(plainText);
        legacyValues.set(Buffer.from(encrypted).toString('base64'), plainText);
        return encrypted;
      },
      decryptString: (encrypted: Uint8Array) => {
        const encryptedBase64 = Buffer.from(encrypted).toString('base64');
        const plainText = legacyValues.get(encryptedBase64);
        if (plainText === undefined) throw new Error('Unknown encrypted value');
        return plainText;
      },
    };
    const project = createProjectStore(projectPath);
    const service = createService(project);

    await service.connectSsh({ ...settings });

    expect(localStorage.length).toBe(1);
    expect(service.getSshSettings()).toEqual(settings);
  });

  function createService(project: ReturnType<typeof createProjectStore>): LinuxBoardConnectorService {
    const events = new Subject<any>();
    const sessions = new Map<string, any>();
    const connector = {
      events$: events.asObservable(),
      sessions,
      waitForReady: jasmine.createSpy('waitForReady').and.resolveTo({
        version: 'test',
        protocolVersion: 1,
      }),
      connectSsh: jasmine.createSpy('connectSsh').and.callFake(async () => {
        const session = {
          sessionId: `session-${sessions.size + 1}`,
          transport: 'ssh',
          status: {},
          capabilities: {},
        };
        sessions.set(session.sessionId, session);
        return session;
      }),
      disconnect: jasmine.createSpy('disconnect').and.callFake(async (sessionId: string) => {
        sessions.delete(sessionId);
      }),
    };
    const configService = new ConfigService({} as any, {} as any);
    const service = new LinuxBoardConnectorService(
      connector as any,
      { currentPort: '', currentPortInfo: null } as any,
      { update: jasmine.createSpy('logUpdate') } as any,
      { update: jasmine.createSpy('noticeUpdate') } as any,
      project as any,
      configService,
      { instant: (key: string) => key } as any,
    );
    services.push(service);
    return service;
  }
});

function createProjectStore(projectPath: string) {
  const currentProjectPath$ = new BehaviorSubject(projectPath);
  let packageJson: any = { devmode: 'python' };
  return {
    currentProjectPath: projectPath,
    currentProjectPath$: currentProjectPath$.asObservable(),
    stateSubject: new BehaviorSubject('default'),
    boardChangeSubject: new Subject<void>(),
    boardConfigUpdatedSubject: new Subject<unknown>(),
    get packageJson() {
      return packageJson;
    },
    getPackageJson: () => Promise.resolve(packageJson),
    setPackageJson: (value: any) => {
      packageJson = value;
      return Promise.resolve();
    },
    getBoardJson: () => Promise.resolve({
      mode: ['python'],
      connector: ['ssh'],
    }),
  };
}
