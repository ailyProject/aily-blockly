import { ProjectSettingDialogComponent } from './project-setting-dialog.component';
import { sha256Hex } from '../../utils/crypto.utils';

describe('ProjectSettingDialogComponent package names', () => {
  const path = '/projects/demo';
  const rulesPath = `${path}/.ailyignore`;
  let rules: string | null;
  let previousFs: any;
  let previousPath: any;

  beforeEach(() => {
    previousFs = window['fs'];
    previousPath = window['path'];
    rules = 'build/\r\n';
    window['path'] = { join: (...parts: string[]) => parts.join('/') };
    window['fs'] = {
      captureProjectAttachment: (location: string) => ({ location }),
      existsSync: (file: string) => file === rulesPath && rules !== null,
      lstatSync: (file: string) => ({ _isFile: file === rulesPath && rules !== null }),
      readFileSync: (file: string) => file === rulesPath ? rules : null,
      replaceProjectText: jasmine.createSpy('replaceProjectText').and.callFake(async (request, guard) => {
        const expectedHash = rules === null ? null : `sha256:${await sha256Hex(rules)}`;
        guard();
        if (request.expectedHash !== expectedHash) return { status: 'CONFLICT' };
        rules = request.content;
        return { status: 'COMMITTED', hash: `sha256:${await sha256Hex(request.content)}` };
      }),
    };
  });

  afterEach(() => { window['fs'] = previousFs; window['path'] = previousPath; });

  function createComponent(packageJson: Record<string, unknown>): any {
    const component = Object.create(ProjectSettingDialogComponent.prototype) as any;
    component.message = {
      error: jasmine.createSpy('error'),
      success: jasmine.createSpy('success'),
      warning: jasmine.createSpy('warning'),
    };
    component.translate = { instant: (key: string) => key };
    component.modal = { close: jasmine.createSpy('close') };
    component.projectService = {
      currentProjectPath: path,
      captureCurrentProjectGuard: () => () => component.projectService.currentProjectPath === path,
      getPackageJson: jasmine.createSpy('getPackageJson').and.resolveTo(packageJson),
      setPackageJson: jasmine.createSpy('setPackageJson').and.resolveTo(),
      addRecentlyProject: jasmine.createSpy('addRecentlyProject'),
    };
    component.isSubmitting = false;
    component.originalSyncRules = null;
    return component;
  }

  it('shows a lowercase package default while preserving a legacy display name', async () => {
    const component = createComponent({ name: 'MyDemo', version: '1.0.0' });

    await component.loadProjectSettings();

    expect(component.projectSettings.name).toBe('mydemo');
    expect(component.projectSettings.nickname).toBe('MyDemo');
  });

  it('normalizes a package name before validating and saving it', async () => {
    const component = createComponent({ name: 'old_name', version: '1.0.0' });
    await component.loadProjectSettings();
    component.projectSettings = {
      name: '  New_Name  ',
      nickname: '展示名称',
      version: '1.0.0',
      description: '',
      doc_url: '',
    };

    await component.saveSettings();

    expect(component.projectService.setPackageJson).toHaveBeenCalledWith(jasmine.objectContaining({
      name: 'new_name',
      nickname: '展示名称',
    }));
    expect(component.message.warning).not.toHaveBeenCalled();
    expect(window['fs'].replaceProjectText).not.toHaveBeenCalled();
  });

  it('still rejects unsupported package-name punctuation', async () => {
    const component = createComponent({ name: 'old_name', version: '1.0.0' });
    await component.loadProjectSettings();
    component.projectSettings = {
      name: 'New.Name',
      nickname: 'New.Name',
      version: '1.0.0',
      description: '',
      doc_url: '',
    };

    await component.saveSettings();

    expect(component.projectService.setPackageJson).not.toHaveBeenCalled();
    expect(component.message.warning).toHaveBeenCalledWith(
      'PROJECT_SETTING_DIALOG.WARNING_NAME_INVALID_FORMAT',
    );
  });

  it('reads the local rules and writes edits verbatim, including an empty rule file', async () => {
    const component = createComponent({ name: 'demo', version: '1.0.0' });
    await component.loadProjectSettings();
    expect(component.syncRules).toBe('build/\r\n');
    component.syncRules = 'build/\n*.tmp\n!assets/keep.tmp\n\n';
    await component.saveSettings();
    expect(rules).toBe(component.syncRules);
    expect(component.projectService.setPackageJson.calls.mostRecent().args[0].syncRules).toBeUndefined();

    const reopened = createComponent({ name: 'demo', version: '1.0.0' });
    await reopened.loadProjectSettings();
    expect(reopened.syncRules).toBe(component.syncRules);
    reopened.syncRules = '';
    await reopened.saveSettings();
    expect(rules).toBe('');
  });

  it('updates a missing rule file on save and leaves the other settings untouched on conflict', async () => {
    rules = null;
    const component = createComponent({ name: 'demo', version: '1.0.0' });
    await component.loadProjectSettings();
    expect(component.syncRules).toBe('');
    component.syncRules = '*.tmp\n';
    await component.saveSettings();
    expect(rules).toBe('*.tmp\n');

    const stale = createComponent({ name: 'demo', version: '1.0.0' });
    await stale.loadProjectSettings();
    rules = '*.local\n';
    stale.syncRules = 'build/\n';
    await stale.saveSettings();
    expect(rules).toBe('*.local\n');
    expect(stale.projectService.setPackageJson).not.toHaveBeenCalled();
    expect(stale.modal.close).not.toHaveBeenCalled();
  });

  it('omits the old generated header and removes it on save while preserving user comments', async () => {
    const original = '# 云同步忽略规则，语法与 .gitignore 相同。\r\n# 用户注释\r\nbuild/\r\n';
    rules = original;
    const component = createComponent({ name: 'demo', version: '1.0.0' });

    await component.loadProjectSettings();
    expect(component.syncRules).toBe('# 用户注释\r\nbuild/\r\n');
    expect(rules).toBe(original);

    await component.saveSettings();
    expect(rules).toBe('# 用户注释\r\nbuild/\r\n');
  });

  it('rejects saving settings from a dialog after the current project changes', async () => {
    const component = createComponent({ name: 'demo', version: '1.0.0' });
    await component.loadProjectSettings();
    component.projectService.currentProjectPath = '/projects/other';
    component.syncRules = '*.tmp\n';
    await component.saveSettings();

    expect(window['fs'].replaceProjectText).not.toHaveBeenCalled();
    expect(component.projectService.setPackageJson).not.toHaveBeenCalled();
  });
});
