import { AuthService } from '@core/auth/public-api';
import { TranslateService } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { BoardAuthPromptService } from './board-auth-prompt.service';

describe('BoardAuthPromptService', () => {
  function fixture(state: ReturnType<AuthService['getAuthInitializationState']>, isLoggedIn = false) {
    const auth = {
      getAuthInitializationState: () => state,
      initializeAuth: jasmine.createSpy('initializeAuth').and.resolveTo(),
      isLoggedIn,
      requestLogin: jasmine.createSpy('requestLogin'),
    };
    const message = { warning: jasmine.createSpy('warning') };
    const translate = { instant: (key: string) => key };
    const service = new BoardAuthPromptService(
      auth as unknown as AuthService, message as unknown as NzMessageService, translate as unknown as TranslateService,
    );
    return { auth, message, service };
  }

  it('warns and requests the shared login dialog for a signed-out user', async () => {
    const { auth, message, service } = fixture('signed_out');
    await service.promptIfRequired({ auth: true }, () => true);
    expect(message.warning).toHaveBeenCalledOnceWith('BLOCKLY_EDITOR.BOARD_CLOUD_AUTH_REQUIRED', { nzDuration: 6000 });
    expect(auth.requestLogin).toHaveBeenCalledOnceWith('board-cloud-service');
  });

  it('only treats a boolean true as requiring login', async () => {
    const { auth, message, service } = fixture('idle');
    for (const board of [undefined, {}, { auth: false }, { auth: 'true' }]) {
      await service.promptIfRequired(board, () => true);
    }
    expect(auth.initializeAuth).not.toHaveBeenCalled();
    expect(message.warning).not.toHaveBeenCalled();
    expect(auth.requestLogin).not.toHaveBeenCalled();
  });

  it('waits for authentication and skips the prompt if already signed in', async () => {
    const { auth, message, service } = fixture('checking');
    auth.initializeAuth.and.callFake(async () => { auth.isLoggedIn = true; });
    await service.promptIfRequired({ auth: true }, () => true);
    expect(auth.initializeAuth).toHaveBeenCalledTimes(1);
    expect(message.warning).not.toHaveBeenCalled();
    expect(auth.requestLogin).not.toHaveBeenCalled();
  });

  it('skips a project that was superseded while authentication was initializing', async () => {
    const { auth, message, service } = fixture('checking');
    let current = true;
    auth.initializeAuth.and.callFake(async () => { current = false; });
    await service.promptIfRequired({ auth: true }, () => current);
    expect(message.warning).not.toHaveBeenCalled();
    expect(auth.requestLogin).not.toHaveBeenCalled();
  });
});
