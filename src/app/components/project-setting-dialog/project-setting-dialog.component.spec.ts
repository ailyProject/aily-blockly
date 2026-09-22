import { ProjectSettingDialogComponent } from './project-setting-dialog.component';

describe('ProjectSettingDialogComponent package names', () => {
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
      currentProjectPath: '/projects/demo',
      getPackageJson: jasmine.createSpy('getPackageJson').and.resolveTo(packageJson),
      setPackageJson: jasmine.createSpy('setPackageJson').and.resolveTo(),
      addRecentlyProject: jasmine.createSpy('addRecentlyProject'),
    };
    component.isSubmitting = false;
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
  });

  it('still rejects unsupported package-name punctuation', async () => {
    const component = createComponent({ name: 'old_name', version: '1.0.0' });
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
});
