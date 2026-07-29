import { Component, ElementRef, inject, ViewChild } from '@angular/core';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { AuthService, LoginRequest, RegisterRequest } from '../../services/auth.service';
import { Subject, takeUntil } from 'rxjs';
import { ElectronService } from '../../services/electron.service';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzMessageService } from 'ng-zorro-antd/message';
import { LoginComponent } from '../../components/login/login.component';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzProgressModule } from 'ng-zorro-antd/progress';
import { NzInputModule } from 'ng-zorro-antd/input';
import { UiService } from '../../services/ui.service';
import { NzToolTipModule } from "ng-zorro-antd/tooltip";
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { resolveTranslatedApiErrorMessage } from '../../utils/api-error.utils';
import { ToolI18nService } from '../../services/tool-i18n.service';
import {
  AuthQuotaStateService,
  type AuthQuotaInfo,
} from '../aily-chat/services/auth-quota-state.service';
import { formatQuotaResetMetaLabel } from '../aily-chat/services/chat-quota-reset-label';

@Component({
  selector: 'app-user-center',
  imports: [
    FormsModule,
    CommonModule,
    ToolContainerComponent,
    LoginComponent,
    NzButtonModule,
    NzProgressModule,
    NzInputModule,
    NzToolTipModule,
    TranslateModule
  ],
  templateUrl: './user-center.component.html',
  styleUrl: './user-center.component.scss'
})
export class UserCenterComponent {
  currentUrl = '/user/settings';
  windowInfo = 'USER_CENTER.TITLE';
  @ViewChild('menuBox') menuBox: ElementRef;
  @ViewChild('nicknameInput') nicknameInput?: ElementRef<HTMLInputElement>;

  private destroy$ = new Subject<void>();
  private message = inject(NzMessageService);
  private authService = inject(AuthService);
  private authQuotaStateService = inject(AuthQuotaStateService);
  private electronService = inject(ElectronService);
  private translate = inject(TranslateService);

  userInfo = {
    username: '',
    password: '',
    email: ''
  }

  isWaiting = false;
  isRegistering = false;
  currentUser: any = null;
  isGitHubAuthWaiting = false;
  isEditingNickname = false;
  editedNickname = '';
  nicknameSaving = false;
  nicknameError = '';
  quotaUsagePercent = 0;

  benefits: any = null;
  authQuotaInfo: AuthQuotaInfo | null = null;

  constructor(
    private uiService: UiService,
    private toolI18n: ToolI18nService
  ) {

  }

  async ngOnInit() {
    await this.toolI18n.load('user-center');

    const wasLoggedInBeforeSync = this.authService.isLoggedIn;

    // 首先检查并同步登录状态
    await this.checkAndSyncAuthStatus();
    this.authQuotaStateService.syncAuthSnapshotFromHost();

    let previousLoginState = this.authService.isLoggedIn;

    // 监听登录状态
    this.authService.isLoggedIn$
      .pipe(takeUntil(this.destroy$))
      .subscribe(isLoggedIn => {
        if (isLoggedIn && !previousLoginState) {
          this.refreshMe();
          this.refreshBenefits();
        }
        previousLoginState = isLoggedIn;
      });

    this.authService.authSnapshot$
      .pipe(takeUntil(this.destroy$))
      .subscribe((authSnapshot) => {
        this.authQuotaStateService.acceptAuthSnapshot(authSnapshot);
      });

    this.authQuotaStateService.quotaInfo$
      .pipe(takeUntil(this.destroy$))
      .subscribe((quotaInfo) => {
        this.authQuotaInfo = quotaInfo;
      });

    // 监听用户信息
    this.authService.userInfo$
      .pipe(takeUntil(this.destroy$))
      .subscribe(userInfo => {
        // console.log('UserCenterComponent - 接收到用户信息更新: ', userInfo);
        this.currentUser = userInfo;
        this.calculateQuotaUsagePercent();
      });

    if (this.authService.isLoggedIn) {
      if (wasLoggedInBeforeSync) {
        this.refreshMe();
      }
      this.refreshBenefits();
    }

    // 由于app.component已经设置了全局OAuth监听器，这里不需要再设置
    // 但是我们可以监听AuthService的登录状态变化来处理UI状态
  }

  /**
   * 检查并同步认证状态
   */
  private async checkAndSyncAuthStatus(): Promise<void> {
    try {
      await this.authService.checkAndSyncAuthStatus();
    } catch (error) {
      console.warn('同步认证状态失败:', error);
    }
  }

  refreshMe() {
    this.authService.refreshMe().then(() => {
      // console.log('Auth token refreshed.');
      this.calculateQuotaUsagePercent();
    }).catch((error) => {
      console.warn('刷新用户信息失败:', error);
    });
  }
  refreshBenefits() {
    if (!this.authService.isLoggedIn) return;
    this.authService.getBenefits()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          if (res.status === 200 && res.data) {
            this.benefits = res.data;
          }
        },
        error: (err) => {
          console.warn('获取权益信息失败:', err);
        }
      });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  async onRegister() {
    if (!this.userInfo.username || !this.userInfo.password || !this.userInfo.email) {
      this.message.warning(this.t('USER_CENTER.REGISTER_INCOMPLETE', '请填写完整的注册信息'));
      return;
    }

    this.isWaiting = true;

    try {
      const registerData: RegisterRequest = {
        username: this.userInfo.username,
        password: this.userInfo.password,
        email: this.userInfo.email
      };

      this.authService.register(registerData).subscribe({
        next: (response) => {
          this.message.success(this.t('USER_CENTER.REGISTER_SUCCESS', '注册成功'));
          this.isRegistering = false;
          // 清空密码，保留用户名用于登录
          this.userInfo.password = '';
          this.userInfo.email = '';
        },
        error: (error) => {
          console.warn('注册错误:', error);
          this.message.error(this.getAuthErrorMessage(error, this.t('USER_CENTER.REGISTER_FAILED_NETWORK', '注册失败，请检查网络连接')));
        },
        complete: () => {
          this.isWaiting = false;
        }
      });
    } catch (error) {
      console.warn('注册过程中出错:', error);
      this.message.error(this.getAuthErrorMessage(error, this.t('USER_CENTER.REGISTER_FAILED', '注册失败')));
      this.isWaiting = false;
    }
  }

  private getAuthErrorMessage(error: unknown, fallback: string): string {
    return resolveTranslatedApiErrorMessage(error, this.translate, {
      fallbackMessage: fallback,
    });
  }

  async onLogout() {
    this.isWaiting = true;
    try {
      await this.authService.logout();
      this.message.success(this.t('USER_CENTER.LOGOUT_SUCCESS', '已退出登录'));
    } catch (error) {
      console.warn('退出登录失败:', error);
      this.message.error(this.t('USER_CENTER.LOGOUT_FAILED', '退出登录失败'));
    } finally {
      this.isWaiting = false;
    }
  }

  toggleRegisterMode() {
    this.isRegistering = !this.isRegistering;
    // 清空表单
    this.userInfo = {
      username: '',
      password: '',
      email: ''
    };
  }

  more() {
    this.message.warning(this.t('USER_CENTER.SERVICE_UNAVAILABLE', '服务暂不可用'));
  }

  close() {
    this.uiService.closeTool('user-center');
  }

  onStartNicknameEdit(event?: Event): void {
    if (this.nicknameSaving) {
      return;
    }
    event?.preventDefault?.();
    event?.stopPropagation?.();
    this.isEditingNickname = true;
    this.nicknameError = '';
    this.editedNickname = this.displayNickname;
    setTimeout(() => {
      this.nicknameInput?.nativeElement?.focus();
      this.nicknameInput?.nativeElement?.select();
    });
  }

  onCancelNicknameEdit(event?: Event): void {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    this.isEditingNickname = false;
    this.nicknameSaving = false;
    this.nicknameError = '';
    this.editedNickname = '';
  }

  async onSaveNickname(): Promise<void> {
    if (!this.isEditingNickname || this.nicknameSaving) {
      return;
    }

    const nextNickname = this.editedNickname.trim();
    if (!nextNickname) {
      this.nicknameError = this.t('USER_CENTER.NICKNAME_REQUIRED', '昵称不能为空');
      this.message.warning(this.nicknameError);
      setTimeout(() => {
        this.nicknameInput?.nativeElement?.focus();
      });
      return;
    }

    if (nextNickname === this.displayNickname) {
      this.isEditingNickname = false;
      this.editedNickname = '';
      return;
    }

    this.nicknameSaving = true;
    this.nicknameError = '';

    try {
      await this.submitNicknameChange(nextNickname);
      this.currentUser = {
        ...this.currentUser,
        nickname: nextNickname
      };
      this.message.success(this.t('USER_CENTER.NICKNAME_SAVED', '昵称修改已保存'));
      this.isEditingNickname = false;
      this.editedNickname = '';
    } catch (error) {
      console.error('昵称更新失败:', error);
      this.nicknameError = this.t('USER_CENTER.NICKNAME_UPDATE_FAILED', '昵称更新失败，请稍后重试');
      this.message.error(this.nicknameError);
    } finally {
      this.nicknameSaving = false;
    }
  }

  async onNicknameBlur(): Promise<void> {
    if (this.nicknameSaving) {
      return;
    }
    await this.onSaveNickname();
  }

  private async submitNicknameChange(nextNickname: string): Promise<void> {
    (await this.authService.changeNickname(nextNickname)).subscribe({
      next: async (response) => {
        if (response.status === 200) {
          // 昵称修改成功
          await this.authService.refreshMe();
        } else {
          throw new Error(this.t('USER_CENTER.NICKNAME_SERVER_ERROR', '昵称修改失败，服务器返回错误'));
        }
      },
      error: (error) => {
        console.error('昵称修改请求失败:', error);
        throw error;
      }
    });
  }

  get displayNickname(): string {
    return (this.currentUser?.nickname || this.currentUser?.login || '').trim();
  }

  get displayPlanName(): string {
    const subscriptionPlan = this.currentUser?.subscription_plan;
    return subscriptionPlan?.display_name || subscriptionPlan?.name || 'Free';
  }

  get displayPlanEndDate(): string {
    const subscriptionPlan = this.currentUser?.subscription_plan;
    if (subscriptionPlan?.name?.toLowerCase() === 'free') {
      return '';
    }
    const endDate = subscriptionPlan?.end_date;
    if (!endDate) {
      return '';
    }
    const parsed = new Date(endDate);
    if (Number.isNaN(parsed.getTime())) {
      return String(endDate);
    }
    const lang = this.translate.currentLang || this.translate.defaultLang || 'en';
    const locale = lang.replace(/_/g, '-');
    return parsed.toLocaleDateString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }

  get displayAiCallsResetDate(): string {
    if (this.benefits?.ai_calls?.unlimited) {
      return '';
    }
    const resetDate = this.benefits?.ai_calls?.resetDate;
    if (!resetDate) {
      return '';
    }
    const parsed = new Date(resetDate);
    if (Number.isNaN(parsed.getTime())) {
      return String(resetDate);
    }
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${pad(parsed.getMonth() + 1)}/${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
  }

  get isProPlanSubscriber(): boolean {
    const subscriptionPlan = this.currentUser?.subscription_plan;
    const planName = `${subscriptionPlan?.name || ''} ${subscriptionPlan?.display_name || ''}`.trim().toLowerCase();
    return planName.includes('pro');
  }

  get quotaRemainingPercent(): number {
    return Math.max(0, 100 - this.quotaUsagePercent);
  }

  get aiAvailableValue(): string {
    if (this.authQuotaInfo) {
      const unlimited = this.authQuotaInfo.unlimited === true || this.authQuotaInfo.quota < 0;
      if (unlimited) {
        return '♾️';
      }

      const remaining = Math.max(0, this.authQuotaInfo.remaining);
      const quota = Math.max(0, this.authQuotaInfo.quota);
      const unitSuffix = this.authQuotaInfo.usageUnit === 'interactions' ? '次' : ' tokens';
      return `${remaining}/${quota}${unitSuffix}`;
    }

    return this.benefits?.ai_calls?.unlimited
      ? '♾️'
      : `${this.benefits?.ai_calls?.used ?? 0}/${this.benefits?.ai_calls?.total ?? 0}`;
  }

  get aiAvailableMeta(): string | null {
    if (!this.authQuotaInfo) {
      return null;
    }

    return formatQuotaResetMetaLabel(this.authQuotaInfo.resetTime) ?? null;
  }

  private calculateQuotaUsagePercent(): void {
    // console.log('=== 开始计算配额使用百分比 ===');
    // console.log('currentUser 完整对象:', JSON.stringify(this.currentUser, null, 2));
    // console.log('currentUser?.quota:', this.currentUser?.quota);

    const total = this.currentUser?.quota?.total_token ?? 0;
    const used = this.currentUser?.quota?.used_token ?? 0;

    // console.log('提取的值 - total:', total, 'used:', used);
    // console.log('total 类型:', typeof total, 'used 类型:', typeof used);

    if (!total || total <= 0) {
      this.quotaUsagePercent = 0;
      // console.log('总配额为0或无效，设置使用百分比为0');
      return;
    }
    const percent = (used / total) * 100;
    // 保留2位小数，不四舍五入到整数
    this.quotaUsagePercent = Math.max(0, Math.min(100, Number(percent.toFixed(2))));
    // console.log('计算得到的使用百分比:', this.quotaUsagePercent, '(used/total*100 =', used, '/', total, '*100)');
    // console.log('=== 计算完成 ===');
  }

  /**
   * 点击头像时触发 SSO 跳转
   */
  async onAvatarClick(): Promise<void> {
    this.openUserCenterPage(this.currentUrl);
  }

  private openUserCenterPage(path?: string): void {
    if (!this.authService.isLoggedIn) {
      return;
    }

    try {
      // 显示加载提示
      const loadingMessage = this.message.loading(this.t('USER_CENTER.GENERATING_LOGIN_LINK', '正在生成登录链接...'), { nzDuration: 0 });

      // 生成 SSO Token
      this.authService.generateSSOToken(path).subscribe({
        next: (response) => {
          loadingMessage.messageId && this.message.remove(loadingMessage.messageId);

          // 使用 Electron 打开浏览器
          this.electronService.openUrl(response.target_url);
          this.message.success(this.t('USER_CENTER.BROWSER_OPENED', '已打开浏览器，正在跳转...'));
        },
        error: (error) => {
          loadingMessage.messageId && this.message.remove(loadingMessage.messageId);
          console.error('生成 SSO Token 失败:', error);

          if (error.status === 401) {
            this.message.error(this.t('USER_CENTER.LOGIN_EXPIRED', '登录已过期，请重新登录'));
          } else if (error.status === 500) {
            this.message.error(this.t('USER_CENTER.SSO_SERVER_ERROR', '服务器错误，无法生成登录链接'));
          } else {
            this.message.error(this.t('USER_CENTER.SSO_NETWORK_FAILED', '网络连接失败，无法自动跳转'));
          }
        }
      });
    } catch (error) {
      console.error('SSO 跳转失败:', error);
      this.message.error(this.t('USER_CENTER.SSO_REDIRECT_FAILED', '跳转失败，请稍后重试'));
    }
  }

  private t(key: string, fallback: string): string {
    const translated = this.translate.instant(key);
    return translated === key ? fallback : translated;
  }


  OpenUrl(url?: string) {
    // this.message.warning('测试版期间免费使用，无需购买');
    // return;
    this.openUserCenterPage(url);
  }
}
