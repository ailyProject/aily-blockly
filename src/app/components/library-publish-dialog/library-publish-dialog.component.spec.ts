import zhCN from '../../../../public/i18n/zh_cn/zh_cn.json';
import { LibraryPublishDialogComponent, LibraryPublishSubmitResult } from './library-publish-dialog.component';

function createDialog(submitPublish: jasmine.Spy): any {
  const dialog = Object.create(LibraryPublishDialogComponent.prototype) as any;
  Object.assign(dialog, {
    data: { submitPublish },
    modal: { close: jasmine.createSpy('close') },
    message: { error: jasmine.createSpy('error'), warning: jasmine.createSpy('warning') },
    translate: {
      instant: (key: string, params: Record<string, unknown> = {}) => {
        const text = key.split('.').reduce((value: any, part) => value?.[part], zhCN) || key;
        return text.replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => String(params[name] ?? ''));
      },
    },
    packageName: '@aily-project/lib-test',
    version: '1.0.0',
    nickname: '测试库',
    description: '',
    author: '',
    keywords: '',
    prDescription: '',
    hardwareTestConfirmed: true,
    saveToLocalPackageJson: false,
    isSubmitting: false,
    submitErrorMessage: '',
  });
  spyOn(dialog, 'validatePackageNameField').and.returnValue(true);
  spyOn(dialog, 'validateVersionField').and.returnValue(true);
  spyOn(dialog, 'focusPublishField');
  return dialog;
}

describe('LibraryPublishDialogComponent submission', () => {
  it('keeps normalized failures inline and replaces the previous failure on retry', async () => {
    const submitPublish = jasmine.createSpy('submitPublish').and.rejectWith({
      errorCode: 'GITHUB_REQUEST_FAILED',
      errorArgs: { githubRequestId: 'ABCD:1234' },
      message: 'GitHub 请求失败',
    });
    const dialog = createDialog(submitPublish);

    await dialog.publish();

    expect(dialog.submitErrorMessage).toBe('发布失败：GitHub 请求失败 (GITHUB_REQUEST_FAILED; GitHub Request ID: ABCD:1234)');
    expect(dialog.isSubmitting).toBeFalse();
    expect(dialog.modal.close).not.toHaveBeenCalled();
    expect(dialog.message.error).not.toHaveBeenCalled();

    submitPublish.and.rejectWith({ errorCode: 'LIBRARY_VERSION_EXISTS', message: '当前版本已经存在' });
    await dialog.publish();

    expect(dialog.submitErrorMessage).toBe('发布失败：当前版本已经存在 (LIBRARY_VERSION_EXISTS)');
    expect(dialog.isSubmitting).toBeFalse();
    expect(dialog.modal.close).not.toHaveBeenCalled();
    expect(dialog.message.error).not.toHaveBeenCalled();
  });

  it('blocks duplicate submits and closing while pending, then closes on success', async () => {
    let finishSubmit!: (result: LibraryPublishSubmitResult) => void;
    const submitPublish = jasmine.createSpy('submitPublish').and.returnValue(
      new Promise<LibraryPublishSubmitResult>(resolve => { finishSubmit = resolve; }),
    );
    const dialog = createDialog(submitPublish);
    dialog.submitErrorMessage = '上次失败';

    const pending = dialog.publish();
    expect(dialog.isSubmitting).toBeTrue();
    expect(dialog.submitErrorMessage).toBe('');
    expect(dialog.buttons.find(button => button.action === 'cancel').disabled).toBeTrue();
    await dialog.publish();
    dialog.onCloseDialog();
    dialog.onButtonClick('cancel');
    expect(submitPublish).toHaveBeenCalledTimes(1);
    expect(dialog.modal.close).not.toHaveBeenCalled();

    finishSubmit({ success: true });
    await pending;

    expect(dialog.isSubmitting).toBeFalse();
    expect(dialog.modal.close).toHaveBeenCalledOnceWith({
      result: 'success',
      data: submitPublish.calls.mostRecent().args[0],
    });
  });

  it('focuses the package name only when an unsuccessful result contains a conflict', async () => {
    const submitPublish = jasmine.createSpy('submitPublish').and.resolveTo({ success: false });
    const dialog = createDialog(submitPublish);

    await dialog.publish();

    expect(dialog.focusPublishField).not.toHaveBeenCalled();
    expect(dialog.submitErrorMessage).toBe('');
    expect(dialog.isSubmitting).toBeFalse();
    expect(dialog.modal.close).not.toHaveBeenCalled();

    submitPublish.and.resolveTo({
      success: false,
      packageNameConflictMessage: '库名已被占用',
      packageNameConflictValue: dialog.packageName,
    });
    await dialog.publish();

    expect(dialog.packageNameConflictMessage).toBe('库名已被占用');
    expect(dialog.focusPublishField).toHaveBeenCalledOnceWith('packageName', true);
    expect(dialog.isSubmitting).toBeFalse();
    expect(dialog.message.error).not.toHaveBeenCalled();
  });
});
