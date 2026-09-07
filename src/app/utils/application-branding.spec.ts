import { HeaderComponent } from '../main-window/components/header/header.component';
import { GuideComponent } from '../pages/guide/guide.component';
import { ConfigService } from '@core/preferences/public-api';
import { AppStoreComponent } from '../tools/app-store/app-store.component';
import { SettingsComponent } from '../windows/settings/settings.component';

function createConfig(product: 'blockly' | 'coder'): ConfigService {
  const config = new ConfigService({} as any, {} as any);
  (config as any).runtimeBuildProduct = product;
  config.data = { coder: { enabled: true }, developmentModePreference: 'blockly' };
  return config;
}

describe('application product branding', () => {
  for (const product of ['blockly', 'coder'] as const) {
    it(`shows the ${product} name before opening and after closing a project`, () => {
      const header = Object.create(HeaderComponent.prototype) as any;
      header.configService = createConfig(product);
      header.projectService = {
        currentProjectPath: '',
        currentPackageData: { name: 'aily blockly' },
      };
      expect(header.projectTitle).toBe(`aily ${product}`);

      header.projectService.currentProjectPath = '/projects/demo';
      header.projectService.currentPackageData = { name: 'demo', nickname: '示例项目' };
      expect(header.projectTitle).toBe('示例项目');

      header.projectService.currentPackageData = { name: 'demo' };
      expect(header.projectTitle).toBe('demo');

      header.projectService.currentProjectPath = '';
      header.projectService.currentPackageData = { name: '' };
      expect(header.projectTitle).toBe(`aily ${product}`);
    });

    it(`restores the ${product} home title after configuration initialization`, async () => {
      const guide = Object.create(GuideComponent.prototype) as any;
      guide.configService = createConfig('blockly');
      spyOn(guide.configService, 'init').and.callFake(async () => {
        guide.configService.runtimeBuildProduct = product;
      });
      guide.electronService = { setTitle: jasmine.createSpy('setTitle') };
      spyOn(guide, 'loadSponsors');
      spyOn(guide, 'checkFirstLaunch');

      await guide.ngOnInit();

      expect(guide.applicationName).toBe(`aily ${product}`);
      expect(guide.coderProduct).toBe(product === 'coder');
      expect(guide.electronService.setTitle).toHaveBeenCalledWith(`aily ${product}`);
    });

    it(`passes the ${product} name to both extension restart translations`, () => {
      const store = Object.create(AppStoreComponent.prototype) as any;
      store.configService = createConfig(product);
      store.modal = { info: jasmine.createSpy('info') };
      store.translate = { instant: jasmine.createSpy('instant').and.returnValue('translated') };

      store.showExtensionClientRestartInfo({ name: 'Test Extension' });

      const params = { name: 'Test Extension', applicationName: `aily ${product}` };
      expect(store.translate.instant).toHaveBeenCalledWith('APP_STORE.RESTART_CLIENT_TITLE', params);
      expect(store.translate.instant).toHaveBeenCalledWith('APP_STORE.RESTART_CLIENT_HINT', params);
    });
  }

  it('allows clicking the Coder button without saving or switching the shared preference', async () => {
    const settings = Object.create(SettingsComponent.prototype) as any;
    settings.configService = createConfig('coder');
    const save = spyOn(settings.configService, 'save').and.resolveTo();
    settings.coderDependencyState = { installed: true, installing: false };
    settings.requiredSubapps = {
      ensureInstalled: jasmine.createSpy('ensureInstalled').and.resolveTo({ installedNow: false }),
    };

    await settings.onDevelopmentModePreferenceChange('coder');
    await settings.onDevelopmentModePreferenceChange('coder');
    await settings.onDevelopmentModePreferenceChange('blockly');

    expect(settings.developmentModePreference).toBe('coder');
    expect(settings.configService.data.developmentModePreference).toBe('blockly');
    expect(save).not.toHaveBeenCalled();
  });

  it('does not overwrite another page title when the guide closes during initialization', async () => {
    const guide = Object.create(GuideComponent.prototype) as any;
    guide.configService = createConfig('coder');
    spyOn(guide.configService, 'init').and.resolveTo();
    guide.electronService = { setTitle: jasmine.createSpy('setTitle') };
    spyOn(guide, 'loadSponsors');
    spyOn(guide, 'checkFirstLaunch');
    spyOn(guide, 'stopSponsorCarousel');

    const initialization = guide.ngOnInit();
    guide.ngOnDestroy();
    await initialization;

    expect(guide.electronService.setTitle).not.toHaveBeenCalled();
    expect(guide.loadSponsors).not.toHaveBeenCalled();
  });

});
