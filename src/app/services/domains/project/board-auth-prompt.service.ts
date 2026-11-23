import { Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { AuthService } from '@core/auth/public-api';

@Injectable({ providedIn: 'root' })
export class BoardAuthPromptService {
  constructor(
    private readonly auth: AuthService,
    private readonly message: NzMessageService,
    private readonly translate: TranslateService,
  ) {}

  async promptIfRequired(boardPackage: unknown, canPrompt: () => boolean): Promise<void> {
    if (!boardPackage || typeof boardPackage !== 'object'
      || (boardPackage as Record<string, unknown>)['auth'] !== true) return;

    const authState = this.auth.getAuthInitializationState();
    if (authState === 'idle' || authState === 'checking') await this.auth.initializeAuth();
    if (this.auth.isLoggedIn || !canPrompt()) return;

    this.message.warning(this.translate.instant('BLOCKLY_EDITOR.BOARD_CLOUD_AUTH_REQUIRED'), { nzDuration: 6000 });
    this.auth.requestLogin('board-cloud-service');
  }
}
