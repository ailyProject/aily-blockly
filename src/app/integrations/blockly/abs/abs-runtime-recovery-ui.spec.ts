import { Subject } from 'rxjs';
import { NgZone } from '@angular/core';
import { HeaderComponent } from '../../../main-window/components/header/header.component';

describe('managed runtime snapshot save and exit choices', () => {
  function fixture() {
    const closed = new Subject<any>();
    const project = { currentProjectPath: '/source', captureCurrentProjectGuard: () => () => project.currentProjectPath === '/source',
      getProjectMode: () => 'blockly', hasUnsavedChanges: jasmine.createSpy().and.rejectWith(new Error('runtime failed')),
      hasBlocklyRuntimeRecovery: () => true, save: jasmine.createSpy().and.resolveTo({ success: false }),
      saveRecoveryAs: jasmine.createSpy().and.resolveTo({ projectSaved: true, recoverySource: { origin: 'runtime-snapshot' } }) };
    const header: any = Object.assign(Object.create(HeaderComponent.prototype), { projectService: project, ngZone: new NgZone({}),
      message: { success: jasmine.createSpy(), error: jasmine.createSpy() },
      selectSaveAsFolder: jasmine.createSpy().and.resolveTo('/new-copy'),
      modal: { create: jasmine.createSpy().and.returnValue({ afterClose: closed }) } });
    return { header, project, closed };
  }

  for (const action of ['close', 'open', 'new']) it(`offers a complete copy before ${action}, without saving the partial source`, async () => {
    const { header, project, closed } = fixture();
    const pending = header.checkUnsavedChanges(action); await Promise.resolve(); await Promise.resolve();
    const data = header.modal.create.calls.mostRecent().args[0].nzData;
    expect(data.buttons.map((button: any) => button.action)).toEqual(['cancel', 'recovery-copy']);
    closed.next({ result: 'recovery-copy' });
    expect(await pending).toBeTrue();
    expect(project.save).not.toHaveBeenCalled();
    expect(project.saveRecoveryAs).toHaveBeenCalledOnceWith('/new-copy', { activation: 'retain-source' });
  });

  for (const outcome of [{ projectSaved: false }, { projectSaved: true, recoverySource: { origin: undefined } }])
    it('does not exit on an unconfirmed or non-snapshot copy', async () => {
      const { header, project, closed } = fixture(); project.saveRecoveryAs.and.resolveTo(outcome);
      const pending = header.checkUnsavedChanges('close'); await Promise.resolve(); await Promise.resolve();
      closed.next({ result: 'recovery-copy' }); expect(await pending).toBeFalse(); expect(project.save).not.toHaveBeenCalled();
    });

  it('cancellation retains the source without writes', async () => {
    const { header, project, closed } = fixture();
    const pending = header.checkUnsavedChanges('close'); await Promise.resolve(); await Promise.resolve();
    closed.next({ result: 'cancel' }); expect(await pending).toBeFalse(); expect(project.saveRecoveryAs).not.toHaveBeenCalled();
  });

  it('offers snapshot protection even when dirty library changes would mask an unsaved-check error', async () => {
    const { header, project, closed } = fixture(); project.hasUnsavedChanges.and.resolveTo(true);
    const pending = header.checkUnsavedChanges('close');
    expect(project.hasUnsavedChanges).not.toHaveBeenCalled();
    expect(header.modal.create.calls.mostRecent().args[0].nzData.buttons.at(-1).action).toBe('recovery-copy');
    closed.next({ result: 'cancel' }); expect(await pending).toBeFalse();
  });

  it('manual saving a full recovery copy does not acknowledge the original source as saved', async () => {
    const { header, project, closed } = fixture();
    const pending = header.saveProjectFromUi('/source'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    closed.next({ result: 'recovery-copy' });
    expect(await pending).toBeFalse(); expect(project.save).toHaveBeenCalledTimes(1);
    expect(project.saveRecoveryAs).toHaveBeenCalledTimes(1);
  });

  it('a late folder choice cannot publish another project snapshot', async () => {
    const { header, project } = fixture();
    header.selectSaveAsFolder.and.callFake(async () => { project.currentProjectPath = '/replacement'; return '/new-copy'; });
    expect(await header.saveRuntimeRecoveryCopyFromUi('/source')).toBeFalse();
    expect(project.saveRecoveryAs).not.toHaveBeenCalled();
  });
});
