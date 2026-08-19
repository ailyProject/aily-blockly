import { ActionService } from '../../../services/action.service';
import { CodeEditorProProjectService } from './code-editor-pro-project.service';

describe('CodeEditorProProjectService', () => {
  it('waits for the iframe save-all bridge before reporting project save success', async () => {
    const actions = new ActionService();
    const project = {
      currentProjectPath: '/tmp/project',
      copyPackageJsonToTemp: jasmine.createSpy('copyPackageJsonToTemp').and.resolveTo(true),
    };
    const service = new CodeEditorProProjectService(actions, project as never);
    const saveAll = jasmine.createSpy('saveAll').and.resolveTo({ ok: true });
    service.registerPersistenceBridge({
      saveAll,
      hasUnsavedChanges: async () => true,
    });
    service.init();

    const feedback = await new Promise<{ success: boolean }>(resolve => {
      actions.dispatch('project-save', { path: '/tmp/project' }, result => resolve(result), 1000);
    });

    expect(feedback.success).toBeTrue();
    expect(saveAll).toHaveBeenCalled();
    expect(project.copyPackageJsonToTemp).toHaveBeenCalledWith('/tmp/project');
    service.destroy();
  });

  it('reports failure instead of allowing shutdown when save-all fails', async () => {
    const actions = new ActionService();
    const project = {
      currentProjectPath: '/tmp/project',
      copyPackageJsonToTemp: jasmine.createSpy('copyPackageJsonToTemp'),
    };
    const service = new CodeEditorProProjectService(actions, project as never);
    service.registerPersistenceBridge({
      saveAll: async () => ({ ok: false, message: 'disk full' }),
      hasUnsavedChanges: async () => true,
    });
    service.init();

    const feedback = await new Promise<{ success: boolean; error?: string }>(resolve => {
      actions.dispatch('project-save', { path: '/tmp/project' }, result => resolve(result), 1000);
    });

    expect(feedback.success).toBeFalse();
    expect(feedback.error).toBe('disk full');
    expect(project.copyPackageJsonToTemp).not.toHaveBeenCalled();
    service.destroy();
  });
});
