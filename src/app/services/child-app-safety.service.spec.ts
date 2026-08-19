import { Subject } from 'rxjs';

import { ChildAppSafetyService } from './child-app-safety.service';

describe('ChildAppSafetyService', () => {
  function createService(options: {
    registrations?: Array<{ toolId: string }>;
    language?: string;
    confirm?: boolean;
  } = {}) {
    const modal = {
      confirm: jasmine.createSpy('confirm').and.callFake((config: Record<string, any>) => {
        if (options.confirm === false) config['nzOnCancel']?.();
        else config['nzOnOk']?.();
        return { afterClose: new Subject<void>() };
      }),
    };
    const translate = {
      currentLang: options.language || 'zh_cn',
      defaultLang: 'zh_cn',
      instant: jasmine.createSpy('instant').and.callFake((key: string, params?: Record<string, string>) => {
        if (params?.['apps']) return `${key}:${params['apps']}`;
        if (params?.['names']) return `${key}:${params['names']}`;
        return key;
      }),
    };
    const registry = {
      list: jasmine.createSpy('list').and.returnValue(options.registrations || []),
    };
    return {
      service: new ChildAppSafetyService(modal as never, translate as never, registry as never),
      modal,
    };
  }

  it('collects embedded and standalone child apps without duplicates', () => {
    const { service } = createService({ registrations: [{ toolId: 'aily-chat-react' }] });

    expect(service.collectActiveChildAppIds([
      '/child-tool/aily-chat-react',
      '/child-tool/network-debugger?standalone=true',
    ])).toEqual(['aily-chat-react', 'network-debugger']);
  });

  it('uses the shared warning style and Aily Chat display name for logout', async () => {
    const { service, modal } = createService();

    const result = await service.confirmInterruption('logout', ['aily-chat-react']);

    expect(result).toBeTrue();
    expect(modal.confirm).toHaveBeenCalledWith(jasmine.objectContaining({
      nzClassName: 'subapp-service-confirm-modal',
      nzTitle: 'COMMON.SAFE_LOGOUT_CLOSE_APPS_TITLE',
      nzContent: 'COMMON.SAFE_LOGOUT_CLOSE_APPS_DESC:Aily Chat',
      nzOkDanger: true,
      nzMaskClosable: false,
      nzZIndex: 1200,
    }));
  });

  it('uses locale-aware separators and resolves cancellation', async () => {
    const { service, modal } = createService({ language: 'en', confirm: false });

    const result = await service.confirmInterruption(
      'region-switch',
      ['aily-chat-react', 'unknown-tool'],
    );

    expect(result).toBeFalse();
    expect(modal.confirm.calls.mostRecent().args[0].nzContent)
      .toBe('SETTINGS.FIELDS.REGION_CLOSE_APPS_DESC:Aily Chat, unknown-tool');
  });

  it('does not show an application-update warning without active child apps', async () => {
    const { service, modal } = createService();

    expect(await service.confirmInterruption('application-update', [])).toBeTrue();
    expect(modal.confirm).not.toHaveBeenCalled();
  });

  it('runs registered work preparation hooks and aborts on an unsafe result', async () => {
    const { service } = createService();
    const calls: string[] = [];
    service.registerPreparationHook('legacy-chat', async () => {
      calls.push('legacy-chat');
      return { ok: false, message: 'turn did not settle' };
    });
    service.registerPreparationHook('later-hook', async () => {
      calls.push('later-hook');
      return { ok: true };
    });

    await expectAsync(service.prepareRegisteredWork()).toBeRejectedWithError('turn did not settle');
    expect(calls).toEqual(['legacy-chat']);
  });
});
