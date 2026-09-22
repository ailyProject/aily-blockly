import {
  ConfigService,
  PROJECT_CONNECTOR_SETTINGS_KEY,
  ProjectPackageConfigStore,
} from './config.service';

describe('ConfigService project SSH connector settings', () => {
  let service: ConfigService;

  beforeEach(() => {
    service = new ConfigService({} as any, {} as any);
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
    service = new ConfigService({} as any, {} as any);
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
