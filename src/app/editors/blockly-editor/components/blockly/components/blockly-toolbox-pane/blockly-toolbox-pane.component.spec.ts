import { BlocklyToolboxPaneComponent } from './blockly-toolbox-pane.component';
import zhCn from '../../../../../../../../public/i18n/zh_cn/zh_cn.json';
import { of, Subject, throwError } from 'rxjs';

describe('BlocklyToolboxPaneComponent library publishing', () => {
  const item = { libraryName: '@aily-project/lib-test', libraryPath: '/libraries/lib-test', name: 'Test' };
  const result = {
    packageJsonPatch: { name: item.libraryName },
    localPackageJsonPatch: { name: item.libraryName },
    prDescription: '',
    saveToLocalPackageJson: false,
  };

  function createComponent(): any {
    const component = Object.create(BlocklyToolboxPaneComponent.prototype) as any;
    component.translate = {
      instant: (key: string, args: Record<string, unknown> = {}) => {
        const value = key.split('.').reduce((entry, part) => entry?.[part], zhCn as any) || key;
        return value.replace(/{{(\w+)}}/g, (_, name) => String(args[name] ?? ''));
      },
    };
    component.message = { error: jasmine.createSpy('error'), warning: jasmine.createSpy('warning') };
    component.showLibrarySubmissionSuccessMessage = jasmine.createSpy('success');
    component.submitLibraryRequest = jasmine.createSpy('submitLibraryRequest').and.resolveTo();
    return component;
  }

  it('keeps validation and GitHub conflicts out of the package-name conflict branch', async () => {
    const component = createComponent();
    const error = { status: 400, errorCode: 'invalid_package_name', message: 'Invalid package name' };
    component.submitLibraryRequest.and.rejectWith(error);

    await expectAsync(component.submitPublishFromDialog(item, result)).toBeRejectedWith(error);
    expect(component.isPackageNameUnavailableError({ status: 409, errorCode: 'github_fork_unavailable' })).toBeFalse();
    expect(component.showLibrarySubmissionSuccessMessage).not.toHaveBeenCalled();
  });

  it('shows an occupied name on the field without retrying or replacing it with an object', async () => {
    const component = createComponent();
    component.submitLibraryRequest.and.rejectWith({
      status: 409,
      errorCode: 'library_submission_package_name_occupied',
      submittedByCurrentUser: false,
    });

    const response = await component.submitPublishFromDialog(item, result);

    expect(response.success).toBeFalse();
    expect(response.packageNameConflictValue).toBe(item.libraryName);
    expect(response.packageNameConflictMessage).toContain('已被其他用户发布或占用');
    expect(component.submitLibraryRequest).toHaveBeenCalledTimes(1);
    expect(component.message.error).not.toHaveBeenCalled();
  });

  it('resubmits an existing own submission only after confirmation', async () => {
    const component = createComponent();
    const error = {
      status: 409, errorCode: 'library_submission_already_submitted',
      submittedByCurrentUser: true, submission: { id: 1 }, sameContent: true,
    };
    component.submitLibraryRequest.and.callFake(async (_item, confirmed) => {
      if (!confirmed) throw error;
    });
    component.confirmExistingLibrarySubmission = jasmine.createSpy('confirm').and.resolveTo(false);

    expect(await component.submitPublishFromDialog(item, result)).toEqual({ success: false });
    expect(component.submitLibraryRequest).toHaveBeenCalledTimes(1);

    component.confirmExistingLibrarySubmission.and.resolveTo(true);
    expect(await component.submitPublishFromDialog(item, result)).toEqual({ success: true });
    expect(component.submitLibraryRequest).toHaveBeenCalledWith(item, true, result.packageJsonPatch, '');
    expect(component.showLibrarySubmissionSuccessMessage).toHaveBeenCalledTimes(1);
  });

  it('retries GitHub authorization once and preserves a subsequent failure', async () => {
    const component = createComponent();
    const error = { status: 403, errorCode: 'github_repo_scope_required', message: 'Missing repo permission' };
    component.submitLibraryRequest.and.rejectWith(error);
    component.promptGithubBindForLibrarySubmission = jasmine.createSpy('bind').and.resolveTo(true);

    await expectAsync(component.submitPublishFromDialog(item, result)).toBeRejectedWith(error);

    expect(component.promptGithubBindForLibrarySubmission).toHaveBeenCalledTimes(1);
    expect(component.submitLibraryRequest).toHaveBeenCalledTimes(2);
  });

  it('reports an accepted submission even if saving local metadata fails', async () => {
    const component = createComponent();
    component.saveLibraryMetadataToLocalPackage = jasmine.createSpy('save').and.throwError('Permission denied');

    expect(await component.submitPublishFromDialog(item, { ...result, saveToLocalPackageJson: true }))
      .toEqual({ success: true });

    expect(component.submitLibraryRequest).toHaveBeenCalledTimes(1);
    expect(component.showLibrarySubmissionSuccessMessage).toHaveBeenCalledTimes(1);
    expect(component.message.warning).toHaveBeenCalledOnceWith(
      '库提交已受理，但本地信息保存失败：Permission denied。请检查本地文件，无需重复发布。',
      { nzDuration: 10000 },
    );
  });

  it('locks the entry during readiness checks and reports a check failure once', async () => {
    const component = createComponent();
    let rejectReadiness: (error: unknown) => void;
    component.uploadingLibraryNames = new Set();
    component.cdr = { markForCheck: jasmine.createSpy('markForCheck') };
    component.ensureLibrarySubmissionReady = jasmine.createSpy('ready').and.returnValue(
      new Promise((_, reject) => { rejectReadiness = reject; }),
    );
    component.openLibraryPublishDialog = jasmine.createSpy('open');

    const uploading = component.uploadLibrary(item);
    await component.uploadLibrary(item);
    rejectReadiness({ message: 'Unable to check authorization' });
    await uploading;

    expect(component.ensureLibrarySubmissionReady).toHaveBeenCalledTimes(1);
    expect(component.openLibraryPublishDialog).not.toHaveBeenCalled();
    expect(component.message.error).toHaveBeenCalledOnceWith(
      '发布失败：Unable to check authorization', { nzDuration: 8000 },
    );
    expect(component.uploadingLibraryNames.size).toBe(0);
  });

  it('preserves permission-check and OAuth startup failures for the publishing error display', async () => {
    const component = createComponent();
    const error = { status: 503, message: 'GitHub permission service unavailable' };
    component.authService = {
      getGithubPermissions: () => throwError(() => error),
      githubBindCompleted$: new Subject(),
      startGitHubLibraryPrSubmitOAuth: () => throwError(() => error),
    };
    component.openLibraryPublishConfirmDialog = jasmine.createSpy('confirm').and.resolveTo(true);

    await expectAsync(component.hasGithubLibraryPrPermission()).toBeRejectedWith(error);
    await expectAsync(component.promptGithubBindForLibrarySubmission()).toBeRejectedWith(error);

    expect(component.message.error).not.toHaveBeenCalled();
  });

  it('does not start OAuth or resubmit when the user cancels GitHub authorization', async () => {
    const component = createComponent();
    component.submitLibraryRequest.and.rejectWith({ errorCode: 'github_repo_scope_required' });
    component.openLibraryPublishConfirmDialog = jasmine.createSpy('confirm').and.resolveTo(false);
    component.authService = {
      startGitHubLibraryPrSubmitOAuth: jasmine.createSpy('startOAuth'),
      getGithubPermissions: jasmine.createSpy('permissions'),
    };

    expect(await component.submitPublishFromDialog(item, result)).toEqual({ success: false });

    expect(component.submitLibraryRequest).toHaveBeenCalledTimes(1);
    expect(component.authService.startGitHubLibraryPrSubmitOAuth).not.toHaveBeenCalled();
    expect(component.authService.getGithubPermissions).not.toHaveBeenCalled();
    expect(component.showLibrarySubmissionSuccessMessage).not.toHaveBeenCalled();
    expect(component.message.error).not.toHaveBeenCalled();
  });

  it('preserves a permission-check failure after OAuth completion without resubmitting', async () => {
    jasmine.clock().install();
    try {
      const component = createComponent();
      const error = { status: 503, message: 'GitHub permission service unavailable' };
      const completed = new Subject<void>();
      let resolveStarted: () => void;
      const started = new Promise<void>(resolve => { resolveStarted = resolve; });
      component.submitLibraryRequest.and.rejectWith({ errorCode: 'github_repo_scope_required' });
      component.openLibraryPublishConfirmDialog = jasmine.createSpy('confirm').and.resolveTo(true);
      component.electronService = { openUrl: jasmine.createSpy('openUrl') };
      component.message.info = jasmine.createSpy('info');
      component.authService = {
        githubBindCompleted$: completed,
        getGithubPermissions: jasmine.createSpy('permissions').and.returnValue(throwError(() => error)),
        startGitHubLibraryPrSubmitOAuth: jasmine.createSpy('startOAuth').and.callFake(() => {
          resolveStarted();
          return of({ authorization_url: 'https://github.example/authorize' });
        }),
      };

      const submitting = component.submitPublishFromDialog(item, result);
      await started;
      const rejection = expectAsync(submitting).toBeRejectedWith(error);
      completed.next();
      await rejection;
      jasmine.clock().tick(5 * 60 * 1000);
      completed.next();

      expect(component.electronService.openUrl).toHaveBeenCalledOnceWith('https://github.example/authorize');
      expect(component.authService.getGithubPermissions).toHaveBeenCalledTimes(1);
      expect(completed.observers.length).toBe(0);
      expect(component.submitLibraryRequest).toHaveBeenCalledTimes(1);
      expect(component.showLibrarySubmissionSuccessMessage).not.toHaveBeenCalled();
      expect(component.message.error).not.toHaveBeenCalled();
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('reports an OAuth timeout and ignores a late completion event', async () => {
    jasmine.clock().install();
    try {
      const component = createComponent();
      const completed = new Subject<void>();
      let resolveStarted: () => void;
      const started = new Promise<void>(resolve => { resolveStarted = resolve; });
      component.submitLibraryRequest.and.rejectWith({ errorCode: 'github_not_bound' });
      component.openLibraryPublishConfirmDialog = jasmine.createSpy('confirm').and.resolveTo(true);
      component.electronService = { openUrl: jasmine.createSpy('openUrl') };
      component.message.info = jasmine.createSpy('info');
      component.authService = {
        githubBindCompleted$: completed,
        getGithubPermissions: jasmine.createSpy('permissions'),
        startGitHubLibraryPrSubmitOAuth: jasmine.createSpy('startOAuth').and.callFake(() => {
          resolveStarted();
          return of({ authorization_url: 'https://github.example/authorize' });
        }),
      };

      const submitting = component.submitPublishFromDialog(item, result);
      await started;
      const rejection = expectAsync(submitting).toBeRejectedWithError('GitHub 授权等待超时，请重新发布并完成授权。');
      jasmine.clock().tick(5 * 60 * 1000);
      await rejection;
      completed.next();

      expect(completed.observers.length).toBe(0);
      expect(component.authService.getGithubPermissions).not.toHaveBeenCalled();
      expect(component.submitLibraryRequest).toHaveBeenCalledTimes(1);
      expect(component.showLibrarySubmissionSuccessMessage).not.toHaveBeenCalled();
    } finally {
      jasmine.clock().uninstall();
    }
  });
});
