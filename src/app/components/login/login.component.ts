import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject, takeUntil } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ElectronService } from '../../services/electron.service';
import sha256 from 'crypto-js/sha256';

@Component({
  selector: 'app-login',
  imports: [
    NzButtonModule,
    CommonModule,
    FormsModule,
    NzIconModule,
    NzInputModule,
    TranslateModule,
  ],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent {
  private destroy$ = new Subject<void>();

  showWeChatLogin = false;
  showPhoneLogin = true;

  isWaiting = false;
  inputUsername = '';
  inputPassword = '';

  constructor(
    private authService: AuthService,
    private message: NzMessageService,
    private electronService: ElectronService,
    private translate: TranslateService
  ) {
    // 监听登录状态
    this.authService.isLoggedIn$
      .pipe(takeUntil(this.destroy$))
      .subscribe(isLoggedIn => {
        // 如果登录成功且当前在GitHub登录等待状态，关闭弹窗
        if (isLoggedIn) {
          // this.message.success('登录成功');
          // this.modal.close();
        }
      });
  }

  onCloseDialog(): void {
    // this.modal.close({ result: 'cancel' });
  }

  mode = '';
  select(mode) {
    this.mode = mode;
  }

  onButtonClick(action: string): void {
    if (action === 'cancel') {
      // this.modal.close({ result: 'cancel' });
    } else if (action === 'agree') {
      // this.modal.close({ result: 'agree' });
    }
  }


  /**
   * 执行实际的GitHub登录流程
   */
  async loginByGithub() {
    try {
      // 直接通过 HTTP 请求启动 GitHub OAuth 流程
      this.authService.startGitHubOAuth().subscribe({
        next: (response) => {
          // 使用 ElectronService 在系统浏览器中打开授权页面
          if (this.electronService.isElectron) {
            this.electronService.openUrl(response.authorization_url);
            this.message.info(this.translate.instant('LOGIN.REDIRECTING_GITHUB'));
          } else {
            // 如果不在 Electron 环境中，使用 window.open 作为降级方案
            window.open(response.authorization_url, '_blank');
            this.message.info(this.translate.instant('LOGIN.REDIRECTING_GITHUB'));
          }
        },
        error: (error) => {
          console.error('启动 GitHub OAuth 失败:', error);
          this.message.error(this.translate.instant('LOGIN.GITHUB_LOGIN_FAILED'));
        }
      });
    } catch (error) {
      console.error('GitHub 登录出错:', error);
      this.message.error(this.translate.instant('LOGIN.GITHUB_ERROR'));
    }
  }

  async loginByPhone() {
    if (!this.inputUsername || !this.inputPassword) {
      this.message.warning(this.translate.instant('LOGIN.ENTER_CREDENTIALS'));
      return;
    }

    this.isWaiting = true;

    try {
      const loginData = {
        username: this.inputUsername,
        password: sha256(this.inputPassword).toString()
      };

      this.authService.login(loginData).subscribe({
        next: (response) => {
          if (response.status === 200 && response.data) {
            this.message.success(this.translate.instant('LOGIN.LOGIN_SUCCESS'));
          } else {
            this.message.error(response.message || this.translate.instant('LOGIN.LOGIN_FAILED'));
          }
        },
        error: (error) => {
          console.error('登录错误:', error);
          this.message.error(this.translate.instant('LOGIN.LOGIN_NETWORK_ERROR'));
        },
        complete: () => {
          this.isWaiting = false;
        }
      });
    } catch (error) {
      console.error('登录过程中出错:', error);
      this.message.error(this.translate.instant('LOGIN.LOGIN_FAILED'));
      this.isWaiting = false;
    }
  }
}
