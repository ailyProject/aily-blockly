import type { ModalButtonOptions, ModalOptions, NzModalService } from 'ng-zorro-antd/modal';
import { Subject } from 'rxjs';
import { chooseCloudSyncConflictAction, confirmCloudSyncOverwrite } from './cloud-sync-conflict';

function stubModal() {
  const afterClose = new Subject<unknown>();
  const close = jasmine.createSpy('close').and.callFake((result?: unknown) => afterClose.next(result));
  const create = jasmine.createSpy('create').and.returnValue({ afterClose, close });
  const confirm = jasmine.createSpy('confirm').and.returnValue({ afterClose, close });
  return { modal: { create, confirm } as unknown as NzModalService, create, confirm, afterClose };
}

describe('cloud sync conflict dialogs', () => {
  it('offers the three conflict actions and returns the selected new-cloud action', async () => {
    const { modal, create } = stubModal();
    const result = chooseCloudSyncConflictAction(modal, false);
    const options: ModalOptions = create.calls.mostRecent().args[0];
    const buttons = options.nzFooter as ModalButtonOptions[];

    expect(buttons.map(button => button.label)).toEqual(['取消', '另存为新云工程', '覆盖云端']);
    expect(buttons[2].danger).toBeTrue();
    expect(options.nzMaskClosable).toBeFalse();
    buttons[1].onClick?.();

    expect(await result).toBe('save-new');
  });

  it('explains a further update and treats dialog dismissal as cancel', async () => {
    const { modal, create, afterClose } = stubModal();
    const result = chooseCloudSyncConflictAction(modal, true);
    const options: ModalOptions = create.calls.mostRecent().args[0];

    expect(options.nzContent).toContain('又收到新版本');
    expect(options.nzClosable).toBeTrue();
    expect(options.nzKeyboard).toBeTrue();
    afterClose.next(undefined);

    expect(await result).toBe('cancel');
  });

  it('requires a distinct destructive confirmation and focuses cancel by default', async () => {
    const { modal, confirm, afterClose } = stubModal();
    const result = confirmCloudSyncOverwrite(modal);
    const options: ModalOptions = confirm.calls.mostRecent().args[0];

    expect(options.nzAutofocus).toBe('cancel');
    expect(options.nzOkDanger).toBeTrue();
    expect(options.nzOkText).toBe('确认覆盖');
    const approve = options.nzOnOk as () => boolean;
    afterClose.next(approve());

    expect(await result).toBeTrue();
  });

  it('treats dismissal of overwrite confirmation as unconfirmed', async () => {
    const { modal, afterClose } = stubModal();
    const result = confirmCloudSyncOverwrite(modal);
    afterClose.complete();

    expect(await result).toBeFalse();
  });
});
