import { BlocklyEditorComponent } from './blockly-editor.component';
import { BlocklyWorkspaceEditGate } from './services/blockly-workspace-edit-lease';

describe('package watcher board reload acknowledgement', () => {
  it('allows disposal for recovery after a quarantined edit has actually stopped', () => {
    const gate = new BlocklyWorkspaceEditGate(), edit = gate.acquire();
    edit.quarantine('needs reopen');
    expect(gate.busy).toBeTrue();
    edit.release();
    expect(gate.blocked).toBeTrue(); expect(gate.busy).toBeFalse();
  });

  it('rejects the waiting switch and never publishes completion if reload was denied', async () => {
    const component: any = Object.create(BlocklyEditorComponent.prototype);
    const error = Object.assign(new Error('reload rejected'), { code: 'PROJECT_RELOAD_REJECTED' });
    component.pendingBoardDependencyReload = {
      projectPath: '/project', addedBoardNames: ['@aily-project/board-new'], previousBoardNames: [], attempts: 0,
    };
    component.watchedPackageJsonProjectPath = '/project';
    component.isBoardPackageReady = () => true;
    component.stopPackageJsonDependencyWatch = () => {};
    component.copyProjectPackageJsonToTemp = () => {};
    component.startPackageJsonDependencyWatch = jasmine.createSpy('restart');
    component.message = { success: () => {}, error: () => {} };
    component.projectService = {
      reloadAfterBoardSwitch: jasmine.createSpy('reload').and.rejectWith(error),
      boardChangeSubject: { next: jasmine.createSpy('changed') },
      resolveBoardSwitchReload: jasmine.createSpy('resolve'),
      rejectBoardSwitchReload: jasmine.createSpy('reject'),
    };
    await component.reloadProjectAfterBoardDependencyChange('/project');
    expect(component.projectService.rejectBoardSwitchReload).toHaveBeenCalledOnceWith(error);
    expect(component.projectService.resolveBoardSwitchReload).not.toHaveBeenCalled();
    expect(component.projectService.boardChangeSubject.next).not.toHaveBeenCalled();
    expect(component.startPackageJsonDependencyWatch).toHaveBeenCalledOnceWith('/project');
    expect(component.boardDependencyReloadInProgress).toBeFalse();
  });
});
