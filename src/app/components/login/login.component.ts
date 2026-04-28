import { CommonModule } from '@angular/common';
import { Component, ViewChild, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MarkdownDialogComponent } from '../../main-window/components/markdown-dialog/markdown-dialog.component';
import { Subject, takeUntil, interval, Subscription } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { ConfigService } from '../../services/config.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ElectronService } from '../../services/electron.service';
import { AltchaComponent } from './altcha/altcha.component';

@Component({
  selector: 'app-login',
  imports: [
    NzButtonModule,
    CommonModule,
    FormsModule,
    NzIconModule,
    NzInputModule,
    NzModalModule,
    TranslateModule,
    AltchaComponent,
  ],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent implements OnDestroy {
  private destroy$ = new Subject<void>();

  @ViewChild(AltchaComponent) altchaComponent!: AltchaComponent;

  isWaiting = false;
  
  // 控制组件显隐：未登录时显示，已登录时隐藏
  showLogin = true;

  // 微信扫码登录相关属性
  wechatQrcodeUrl: string | null = null;
  wechatTicket: string | null = null;
  wechatStatus: 'loading' | 'pending' | 'confirmed' | 'expired' | 'error' = 'loading';
  wechatStatusMessage: string = '';
  wechatCheckSubscription: Subscription | null = null;
  wechatQrcodeCountdown = 60; // 二维码 60s 倒计时
  private wechatQrcodeTimer: ReturnType<typeof setInterval> | null = null;

  // 登录时绑定微信相关
  loginBindMode = false;
  pendingWechatBindTicket: string | null = null;
  loginBindQrTicket: string | null = null;
  loginBindQrcodeUrl: string | null = null;
  loginBindStatus: 'loading' | 'pending' | 'scanned' | 'confirmed' | 'expired' | 'error' = 'loading';
  loginBindStatusMessage = '';
  private loginBindCheckSub: Subscription | null = null;

  // 微信登录后邮箱绑定相关
  emailBindMode = false;
  emailBindTicket: string | null = null;
  emailBindEmail = '';
  emailBindCode = '';
  emailBindIsSendingCode = false;
  emailBindCountdown = 0;
  emailBindIsSubmitting = false;
  private emailBindCountdownTimer: ReturnType<typeof setInterval> | null = null;


  // 协议文档路径：中文(zh_cn/zh_hk)用 zh 版本，其他语言用英文
  private getUserAgreementUrl(): string {
    const base = this.configService.getCurrentResourceUrl();
    const lang = this.translate.currentLang || this.translate.defaultLang || 'en';
    const isZh = lang === 'zh_cn' || lang === 'zh_hk' || lang === 'zh-CN' || lang === 'zh-HK';
    const file = isZh ? 'agreement/TERMS-zh.md' : 'agreement/TERMS.md';
    return `${base}/${file}`;
  }
  private getPrivacyPolicyUrl(): string {
    const base = this.configService.getCurrentResourceUrl();
    const lang = this.translate.currentLang || this.translate.defaultLang || 'en';
    const isZh = lang === 'zh_cn' || lang === 'zh_hk' || lang === 'zh-CN' || lang === 'zh-HK';
    const file = isZh ? 'agreement/PRIVACY-zh.md' : 'agreement/PRIVACY.md';
    return `${base}/${file}`;
  }

  // 邮箱登录相关
  inputEmail = '';
  inputCode = '';
  inviteCode = '';
  isSendingCode = false;
  codeSent = false;
  countdown = 0;
  private countdownTimer: any = null;

  constructor(
    private authService: AuthService,
    private configService: ConfigService,
    private message: NzMessageService,
    private electronService: ElectronService,
    private translate: TranslateService,
    private http: HttpClient,
    private cdr: ChangeDetectorRef,
    private modal: NzModalService,
  ) {
    // 监听登录状态，控制组件显隐
    this.authService.isLoggedIn$
      .pipe(takeUntil(this.destroy$))
      .subscribe((isLoggedIn) => {
        const wasHidden = !this.showLogin;
        this.showLogin = !isLoggedIn;
        // 退出登录后组件重新显示时，若当前在微信扫码模式则刷新二维码
        if (this.showLogin && wasHidden && this.mode === 'wechat') {
          this.refreshWeChatQrcode();
        }
        setTimeout(() => this.cdr.detectChanges());
      });

    // 监听 GitHub OAuth 需要绑定微信的信号
    this.authService.needsWechatBind$
      .pipe(takeUntil(this.destroy$))
      .subscribe((pendingTicket) => {
        setTimeout(() => {
          this.message.info('请先绑定微信后再继续登录');
          this.enterLoginBindMode(pendingTicket);
          this.cdr.detectChanges();
        });
      });
  }

  get showWeChatLogin(): boolean {
    return this.getCurrentRegionKey() === 'cn';
  }

  get isZhLang(): boolean {
    const lang = this.translate.currentLang || this.translate.defaultLang || 'en';
    return lang === 'zh_cn' || lang === 'zh_hk' || lang === 'zh-CN' || lang === 'zh-HK';
  }

  private getCurrentRegionKey(): string {
    return (this.configService.data?.region || 'cn').toLowerCase();
  }

  mode = 'mail'; // 默认选中邮箱登录
  select(mode) {
    this.mode = mode;
    // 当选择微信登录时，若已勾选协议则初始化二维码
    if (mode === 'wechat') {
      this.initWeChatLogin();
    } else {
      // 切换到其他登录方式时，清理微信登录状态
      this.cleanupWeChatLogin();
    }
  }

  /**
   * 初始化微信扫码登录
   */
  initWeChatLogin() {
    this.wechatStatus = 'loading';
    this.wechatQrcodeUrl = null;
    this.wechatTicket = null;
    this.wechatStatusMessage = '';

    // 获取二维码
    this.authService.getWeChatQrcode(this.inviteCode || undefined).subscribe({
      next: (response) => {
        if (response.status === 200 && response.data) {
          this.wechatTicket = response.data.ticket;
          this.wechatQrcodeUrl = response.data.qrcode_url;
          this.wechatStatus = 'pending';
          this.wechatStatusMessage = this.translate.instant('LOGIN.WECHAT_SCAN') || '请使用微信扫码登录';

          this.cdr.detectChanges();
          
          // 开始 60s 倒计时，到期自动刷新
          this.startWeChatQrcodeCountdown();
          // 开始轮询检查扫码状态
          this.startWeChatStatusCheck();
        } else {
          this.wechatStatus = 'error';
          this.wechatStatusMessage = response.message || this.translate.instant('LOGIN.WECHAT_QRCODE_FAILED') || '获取二维码失败';
          this.message.error(this.wechatStatusMessage);
        }
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error('获取微信二维码失败:', error);
        this.wechatStatus = 'error';
        this.wechatStatusMessage = this.translate.instant('LOGIN.WECHAT_QRCODE_FAILED') || '获取二维码失败';
        this.message.error(this.wechatStatusMessage);
        this.cdr.detectChanges();
      }
    });
  }

  /**
   * 开始轮询检查微信扫码状态
   */
  startWeChatStatusCheck() {
    // 先清理之前的订阅
    this.cleanupWeChatStatusCheck();

    if (!this.wechatTicket) {
      return;
    }

    // 每2秒检查一次扫码状态
    this.wechatCheckSubscription = interval(2000).pipe(
      takeUntil(this.destroy$)
    ).subscribe(() => {
      if (!this.wechatTicket) {
        return;
      }

      this.authService.checkWeChatStatus(this.wechatTicket).subscribe({
        next: (response) => {
          if (response.status === 200 && response.data) {
            const status = response.data.status;

            if (status === 'pending') {
              // 等待扫码
              this.wechatStatus = 'pending';
              // this.wechatStatusMessage = response.data.message || this.translate.instant('LOGIN.WECHAT_WAITING') || '等待扫码';
            } else if (status === 'confirmed') {
              // 扫码成功，登录成功
              this.wechatStatus = 'confirmed';
              this.clearWeChatQrcodeTimer();
              this.cleanupWeChatStatusCheck();
              
              // 处理登录成功
              if (response.data.access_token) {
                this.authService.handleWeChatOAuthSuccess({
                  access_token: response.data.access_token,
                  refresh_token: response.data.refresh_token,
                  user: response.data.user
                }).then(() => {
                  this.message.success(
                    response.data.is_new_user 
                      ? (this.translate.instant('LOGIN.WECHAT_REGISTER_SUCCESS') || '注册成功')
                      : (this.translate.instant('LOGIN.LOGIN_SUCCESS') || '登录成功')
                  );
                }).catch((error) => {
                  console.error('处理微信登录成功数据失败:', error);
                  this.message.error(this.translate.instant('LOGIN.LOGIN_FAILED') || '登录失败');
                });
              }
            } else if (status === 'needs_email_bind' || status === 'unbound') {
              // 需要绑定邮箱
              this.clearWeChatQrcodeTimer();
              this.cleanupWeChatStatusCheck();
              this.emailBindMode = true;
              this.emailBindTicket = this.wechatTicket;
              this.wechatStatus = 'pending';
              this.cdr.detectChanges();
              setTimeout(() => {
                this.message.info(response.data.message || '当前微信需要补全邮箱后继续登录。');
              });
            } else if (status === 'expired') {
              // 二维码已过期
              this.wechatStatus = 'expired';
              this.wechatStatusMessage = response.data.message || this.translate.instant('LOGIN.WECHAT_EXPIRED') || '二维码已过期，请刷新';
              this.clearWeChatQrcodeTimer();
              this.cleanupWeChatStatusCheck();
              this.message.warning(this.wechatStatusMessage);
            }
          }
        },
        error: (error) => {
          console.error('检查微信扫码状态失败:', error);
          // 如果是404错误，说明ticket不存在或已过期
          if (error.status === 404) {
            this.wechatStatus = 'expired';
            this.wechatStatusMessage = this.translate.instant('LOGIN.WECHAT_EXPIRED') || '二维码已过期，请刷新';
            this.clearWeChatQrcodeTimer();
            this.cleanupWeChatStatusCheck();
            this.message.warning(this.wechatStatusMessage);
          }
        }
      });
    });
  }

  /**
   * 开始二维码 60s 倒计时，到期自动刷新
   */
  private startWeChatQrcodeCountdown() {
    this.clearWeChatQrcodeTimer();
    this.wechatQrcodeCountdown = 60;
    this.wechatQrcodeTimer = setInterval(() => {
      this.wechatQrcodeCountdown--;
      if (this.wechatQrcodeCountdown <= 0) {
        this.clearWeChatQrcodeTimer();
        this.refreshWeChatQrcode();
      }
    }, 1000);
  }

  /**
   * 清理二维码倒计时
   */
  private clearWeChatQrcodeTimer() {
    if (this.wechatQrcodeTimer) {
      clearInterval(this.wechatQrcodeTimer);
      this.wechatQrcodeTimer = null;
    }
  }

  /**
   * 清理微信扫码状态检查
   */
  cleanupWeChatStatusCheck() {
    if (this.wechatCheckSubscription) {
      this.wechatCheckSubscription.unsubscribe();
      this.wechatCheckSubscription = null;
    }
  }

  /**
   * 清理微信登录状态
   */
  cleanupWeChatLogin() {
    this.clearWeChatQrcodeTimer();
    this.cleanupWeChatStatusCheck();
    this.wechatQrcodeUrl = null;
    this.wechatTicket = null;
    this.wechatStatus = 'loading';
    this.wechatStatusMessage = '';
  }

  /**
   * 刷新微信二维码
   */
  refreshWeChatQrcode() {
    this.cleanupWeChatLogin();
    this.initWeChatLogin();
  }

  /**
   * 弹窗预览用户协议
   */
  showUserAgreement(): void {
    this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: { padding: '0' },
      nzContent: MarkdownDialogComponent,
      nzWidth: '500px',
      nzData: {
        title: this.translate.instant('LOGIN.USER_AGREEMENT'),
        docUrl: this.getUserAgreementUrl(),
        buttons: [
          { text: 'LOGIN.MODAL_CLOSE', type: 'default', action: 'close' }
        ]
      },
      nzMaskClosable: false,
    });
  }

  /**
   * 弹窗预览隐私政策
   */
  showPrivacyPolicy(): void {
    this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: { padding: '0' },
      nzWidth: '500px',
      nzContent: MarkdownDialogComponent,
      nzData: {
        title: this.translate.instant('LOGIN.PRIVACY_POLICY'),
        docUrl: this.getPrivacyPolicyUrl(),
        buttons: [{ text: 'LOGIN.MODAL_CLOSE', type: 'default', action: 'close' }],
      },
      nzMaskClosable: false,
    });
  }



  /**
   * 执行 altcha 隐式验证
   * @returns Promise<string | null> 返回验证 token，验证失败返回 null
   */
  private async verifyAltcha(): Promise<string | null> {
    if (!this.altchaComponent) {
      // 如果 altcha 组件不存在，允许继续（向后兼容）
      return null;
    }

    try {
      const token = await this.altchaComponent.triggerVerification();
      return token;
    } catch (error) {
      console.error('Altcha 验证失败:', error);
      this.message.error(
        this.translate.instant('LOGIN.VERIFICATION_FAILED') ||
          '验证失败，请重试',
      );
      return null;
    }
  }

  /**
   * 执行实际的GitHub登录流程
   */
  async loginByGithub() {
    try {
      const altchaToken = await this.verifyAltcha();
      if (altchaToken === null) {
        return;
      }

      // 直接通过 HTTP 请求启动 GitHub OAuth 流程
      this.authService.startGitHubOAuth(this.inviteCode || undefined).subscribe({
        next: (response) => {
          // 使用 ElectronService 在系统浏览器中打开授权页面
          if (this.electronService.isElectron) {
            this.electronService.openUrl(response.authorization_url);
            this.message.info(
              this.translate.instant('LOGIN.REDIRECTING_GITHUB'),
            );
          } else {
            // 如果不在 Electron 环境中，使用 window.open 作为降级方案
            window.open(response.authorization_url, '_blank');
            this.message.info(
              this.translate.instant('LOGIN.REDIRECTING_GITHUB'),
            );
          }
        },
        error: (error) => {
          console.error('启动 GitHub OAuth 失败:', error);
          this.message.error(
            this.translate.instant('LOGIN.GITHUB_LOGIN_FAILED'),
          );
        },
      });
    } catch (error) {
      console.error('GitHub 登录出错:', error);
      this.message.error(this.translate.instant('LOGIN.GITHUB_ERROR'));
    }
  }

  /**
   * 发送邮箱验证码
   */
  async sendVerificationCode() {
    if (!this.inputEmail) {
      this.message.warning(this.translate.instant('LOGIN.ENTER_EMAIL'));
      return;
    }

    // 简单的邮箱格式验证
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(this.inputEmail)) {
      this.message.warning(this.translate.instant('LOGIN.INVALID_EMAIL'));
      return;
    }

    const altchaToken = await this.verifyAltcha();
    if (altchaToken === null) {
      return;
    }

    try {
      this.authService.sendEmailCode(this.inputEmail, altchaToken).subscribe({
        next: (response) => {
          if (response.status === 200) {
            this.isSendingCode = true;
            this.codeSent = true;
            this.cdr.detectChanges();
            this.message.success(this.translate.instant('LOGIN.CODE_SENT'));
            this.startCountdown();
          } else {
            this.message.error(
              response.message ||
                this.translate.instant('LOGIN.CODE_SEND_FAILED'),
            );
          }
        },
        error: (error) => {
          console.error('发送验证码错误:', error);
          this.message.error(this.translate.instant('LOGIN.CODE_SEND_FAILED'));
        },
        complete: () => {
        },
      });
    } catch (error) {
      console.error('发送验证码过程中出错:', error);
      this.message.error(this.translate.instant('LOGIN.CODE_SEND_FAILED'));
    }
  }

  /**
   * 开始倒计时
   */
  private startCountdown() {
    this.countdown = 60;
    this.countdownTimer = setInterval(() => {
      this.countdown--;
      this.cdr.detectChanges();
      if (this.countdown <= 0) {
        this.clearCountdown();
        this.cdr.detectChanges();
      }
    }, 1000);
  }

  /**
   * 清除倒计时
   */
  private clearCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.countdown = 0;
    this.isSendingCode = false;
  }

  /**
   * 邮箱验证码登录
   */
  async loginByEmail() {
    if (!this.inputEmail) {
      this.message.warning(this.translate.instant('LOGIN.ENTER_EMAIL'));
      return;
    }

    if (!this.inputCode) {
      this.message.warning(this.translate.instant('LOGIN.ENTER_CODE'));
      return;
    }

    if (!this.codeSent) {
      this.message.warning(this.translate.instant('LOGIN.CODE_SENDING'));
      return;
    }

    this.isWaiting = true;

    try {
      this.authService.loginByEmail(this.inputEmail, this.inputCode, this.inviteCode).subscribe({
        next: (response) => {
          if (response.status === 200 && response.data) {
            // 检查是否需要绑定微信
            if ((response.data as any).status === 'needs_wechat_bind' && (response.data as any).pending_ticket) {
              this.message.info((response.data as any).message || '请先绑定微信后再继续登录');
              this.enterLoginBindMode((response.data as any).pending_ticket);
              this.isWaiting = false;
              this.cdr.detectChanges();
              return;
            }
            this.clearCountdown();
            this.inputEmail = '';
            this.inputCode = '';
            this.inviteCode = '';
            this.codeSent = false;
            this.message.success(this.translate.instant('LOGIN.LOGIN_SUCCESS'));
          } else {
            this.message.error(
              response.message || this.translate.instant('LOGIN.LOGIN_FAILED'),
            );
          }
        },
        error: (error) => {
          console.error('邮箱登录错误:', error);
          this.message.error(
            this.translate.instant('LOGIN.LOGIN_NETWORK_ERROR'),
          );
        },
        complete: () => {
          this.isWaiting = false;
        },
      });
    } catch (error) {
      console.error('邮箱登录过程中出错:', error);
      this.message.error(this.translate.instant('LOGIN.LOGIN_FAILED'));
      this.isWaiting = false;
    }
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    this.cleanupWeChatLogin();
    this.cleanupLoginBind();
    this.cleanupEmailBind();
    this.clearCountdown();
  }

  // ==================== 登录时绑定微信 ====================

  /**
   * 进入登录绑定微信模式
   */
  enterLoginBindMode(pendingTicket: string): void {
    this.loginBindMode = true;
    this.pendingWechatBindTicket = pendingTicket;
    this.cleanupWeChatLogin();
    this.initWeChatLoginBind(pendingTicket);
  }

  /**
   * 退出登录绑定微信模式
   */
  exitLoginBindMode(): void {
    this.cleanupLoginBind();
    this.loginBindMode = false;
    this.pendingWechatBindTicket = null;
    this.loginBindQrTicket = null;
    this.loginBindQrcodeUrl = null;
    this.loginBindStatus = 'loading';
    this.loginBindStatusMessage = '';
    this.mode = 'mail';
    this.cdr.detectChanges();
  }

  /**
   * 获取登录绑定微信的二维码
   */
  initWeChatLoginBind(pendingTicket: string): void {
    this.loginBindStatus = 'loading';
    this.loginBindQrcodeUrl = null;
    this.loginBindQrTicket = null;
    this.loginBindStatusMessage = '';

    this.authService.getWeChatLoginBindQrcode(pendingTicket).subscribe({
      next: (response) => {
        if (response.status === 200 && response.data) {
          this.loginBindQrTicket = response.data.ticket;
          this.loginBindQrcodeUrl = response.data.qrcode_url;
          this.loginBindStatus = 'pending';
          this.loginBindStatusMessage = this.translate.instant('LOGIN.WECHAT_BIND_SCAN') || '请使用微信扫码绑定';
          this.startWeChatLoginBindCheck();
        } else {
          this.loginBindStatus = 'error';
          this.loginBindStatusMessage = response.message || '获取二维码失败';
          this.message.error(this.loginBindStatusMessage);
        }
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error('获取登录绑定二维码失败:', error);
        this.loginBindStatus = 'error';
        this.loginBindStatusMessage = '获取二维码失败';
        this.message.error(this.loginBindStatusMessage);
        this.cdr.detectChanges();
      },
    });
  }

  /**
   * 开始轮询登录绑定状态
   */
  startWeChatLoginBindCheck(): void {
    this.stopLoginBindCheck();
    if (!this.loginBindQrTicket) return;

    this.loginBindCheckSub = interval(2000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        if (!this.loginBindQrTicket) return;

        this.authService.checkWeChatLoginBindStatus(this.loginBindQrTicket).subscribe({
          next: (response) => {
            if (response.status !== 200 || !response.data) return;

            const data = response.data;
            if (data.status === 'pending') {
              // still waiting
            } else if (data.status === 'scanned') {
              this.loginBindStatus = 'scanned';
              this.loginBindStatusMessage = '已扫码，正在处理...';
              this.cdr.detectChanges();
            } else if (data.status === 'confirmed') {
              this.loginBindStatus = 'confirmed';
              this.cleanupLoginBind();

              this.authService.handleWeChatOAuthSuccess({
                access_token: data.access_token!,
                refresh_token: data.refresh_token,
                user: data.user,
              }).then(() => {
                this.message.success(
                  data.is_new_user
                    ? (this.translate.instant('LOGIN.WECHAT_REGISTER_SUCCESS') || '注册成功')
                    : (this.translate.instant('LOGIN.LOGIN_SUCCESS') || '登录成功')
                );
                this.loginBindMode = false;
                this.cdr.detectChanges();
              }).catch((err) => {
                console.error('处理微信绑定登录成功数据失败:', err);
                this.message.error(this.translate.instant('LOGIN.LOGIN_FAILED') || '登录失败');
              });
            } else if (data.status === 'needs_merge_confirm') {
              // 暂停轮询，等待用户确认合并
              this.stopLoginBindCheck();
              const mergeInfo = (data as any).merge_info;
              const ticket = this.loginBindQrTicket!;
              this.modal.confirm({
                nzClassName: 'merge-confirm-modal',
                nzTitle: '发现已有账号',
                nzContent: `检测到微信账号「${mergeInfo?.wechat_nickname || '未知'}」与邮箱账号「${mergeInfo?.email || '未知'}」可以合并。合并后微信将绑定到邮箱账号，原微信账号将被停用。是否确认合并？`,
                nzOkText: '确认合并',
                nzCancelText: '取消',
                nzOnOk: () => {
                  this.authService.confirmWechatMerge(ticket, 'login_bind').subscribe({
                    next: (mergeResponse) => {
                      if (mergeResponse.status === 200 && mergeResponse.data && 'access_token' in mergeResponse.data) {
                        this.loginBindStatus = 'confirmed';
                        this.cleanupLoginBind();
                        this.authService.handleWeChatOAuthSuccess({
                          access_token: mergeResponse.data.access_token,
                          refresh_token: mergeResponse.data.refresh_token,
                          user: mergeResponse.data.user,
                        }).then(() => {
                          this.message.success(this.translate.instant('LOGIN.LOGIN_SUCCESS') || '登录成功');
                          this.loginBindMode = false;
                          this.cdr.detectChanges();
                        }).catch(() => {
                          this.message.error(this.translate.instant('LOGIN.LOGIN_FAILED') || '登录失败');
                        });
                      } else {
                        this.message.error('合并失败，请重试');
                        // 恢复轮询以便用户重试
                        this.startWeChatLoginBindCheck();
                      }
                    },
                    error: (err) => {
                      const msg = err?.error?.messages || err?.error?.message || '合并失败，请重试';
                      this.message.error(msg);
                      this.startWeChatLoginBindCheck();
                    },
                  });
                },
                nzOnCancel: () => {
                  // 用户取消，继续轮询（后端 Redis 中状态依旧，或用户可重新扫码）
                  this.startWeChatLoginBindCheck();
                },
              });
              this.cdr.detectChanges();
            } else if (data.status === 'error') {
              this.loginBindStatus = 'error';
              this.loginBindStatusMessage = data.message || '绑定失败';
              this.cleanupLoginBind();
              this.message.error(this.loginBindStatusMessage);
              this.cdr.detectChanges();
            }
          },
          error: (error) => {
            if (error.status === 404) {
              this.loginBindStatus = 'expired';
              this.loginBindStatusMessage = '二维码已过期，请重试';
              this.cleanupLoginBind();
              this.cdr.detectChanges();
            }
          },
        });
      });
  }

  /**
   * 刷新登录绑定二维码
   */
  refreshLoginBindQrcode(): void {
    if (this.pendingWechatBindTicket) {
      this.cleanupLoginBind();
      this.initWeChatLoginBind(this.pendingWechatBindTicket);
    }
  }

  private stopLoginBindCheck(): void {
    if (this.loginBindCheckSub) {
      this.loginBindCheckSub.unsubscribe();
      this.loginBindCheckSub = null;
    }
  }

  private cleanupLoginBind(): void {
    this.stopLoginBindCheck();
  }

  // ==================== 微信登录后邮箱绑定 ====================

  /**
   * 退出邮箱绑定模式
   */
  exitEmailBindMode(): void {
    this.cleanupEmailBind();
    this.emailBindMode = false;
    this.emailBindTicket = null;
    this.emailBindEmail = '';
    this.emailBindCode = '';
    this.emailBindIsSendingCode = false;
    this.emailBindCountdown = 0;
    this.emailBindIsSubmitting = false;
    this.mode = 'mail';
    this.cdr.detectChanges();
  }

  /**
   * 邮箱绑定 - 发送验证码
   */
  async sendEmailBindCode(): Promise<void> {
    if (!this.emailBindEmail) {
      this.message.warning(this.translate.instant('LOGIN.ENTER_EMAIL'));
      return;
    }
    if (this.emailBindIsSendingCode || this.emailBindCountdown > 0) {
      return;
    }

    const altchaToken = await this.verifyAltcha();
    if (altchaToken === null) {
      return;
    }

    this.authService.sendEmailCode(this.emailBindEmail, altchaToken).subscribe({
      next: (response) => {
        if (response.status === 200) {
          this.emailBindIsSendingCode = true;
          this.cdr.detectChanges();
          this.message.success(this.translate.instant('LOGIN.CODE_SENT'));
          this.startEmailBindCountdown();
        } else {
          this.message.error(response.message || this.translate.instant('LOGIN.CODE_SEND_FAILED'));
        }
      },
      error: () => {
        this.message.error(this.translate.instant('LOGIN.CODE_SEND_FAILED'));
      },
    });
  }

  /**
   * 邮箱绑定 - 提交绑定
   */
  submitEmailBind(): void {
    if (!this.emailBindEmail || !this.emailBindCode || !this.emailBindTicket) {
      this.message.warning('请填写邮箱和验证码');
      return;
    }

    this.emailBindIsSubmitting = true;
    this.cdr.detectChanges();

    this.authService.completeWechatEmailBindLogin(
      this.emailBindTicket,
      this.emailBindEmail,
      this.emailBindCode,
      this.inviteCode || undefined,
    ).subscribe({
      next: (response) => {
        if (response.status === 200 && response.data) {
          // 检查是否需要用户确认合并账号
          if ((response.data as any).status === 'needs_merge_confirm') {
            this.emailBindIsSubmitting = false;
            this.cdr.detectChanges();
            const mergeInfo = (response.data as any).merge_info;
            this.modal.confirm({
              nzClassName: 'merge-confirm-modal',
              nzTitle: '发现已有账号',
              nzContent: `检测到微信账号「${mergeInfo?.wechat_nickname || '未知'}」与邮箱账号「${mergeInfo?.email || '未知'}」可以合并。合并后微信将绑定到邮箱账号，原微信账号将被停用。是否确认合并？`,
              nzOkText: '确认合并',
              nzCancelText: '取消',
              nzOnOk: () => {
                this.emailBindIsSubmitting = true;
                this.cdr.detectChanges();
                this.authService.completeWechatEmailBindLogin(
                  this.emailBindTicket!,
                  this.emailBindEmail,
                  this.emailBindCode,
                  this.inviteCode || undefined,
                  true,
                ).subscribe({
                  next: (mergeResponse) => {
                    if (mergeResponse.status === 200 && mergeResponse.data && 'access_token' in mergeResponse.data) {
                      this.authService.handleWeChatOAuthSuccess({
                        access_token: mergeResponse.data.access_token,
                        refresh_token: mergeResponse.data.refresh_token,
                        user: mergeResponse.data.user,
                      }).then(() => {
                        this.message.success(this.translate.instant('LOGIN.LOGIN_SUCCESS') || '登录成功');
                        this.cleanupEmailBind();
                        this.emailBindMode = false;
                        this.emailBindCountdown = 0;
                        this.cdr.detectChanges();
                      }).catch(() => {
                        this.message.error(this.translate.instant('LOGIN.LOGIN_FAILED') || '登录失败');
                        this.emailBindIsSubmitting = false;
                        this.cdr.detectChanges();
                      });
                    } else {
                      this.message.error('合并失败，请重试');
                      this.emailBindIsSubmitting = false;
                      this.cdr.detectChanges();
                    }
                  },
                  error: (err) => {
                    const msg = err?.error?.messages || err?.error?.message || '合并失败，请重试';
                    this.message.error(msg);
                    this.emailBindIsSubmitting = false;
                    this.cdr.detectChanges();
                  },
                });
              },
            });
            return;
          }

          this.authService.handleWeChatOAuthSuccess({
            access_token: response.data.access_token,
            refresh_token: response.data.refresh_token,
            user: response.data.user,
          }).then(() => {
            this.message.success(
              response.data.is_new_user
                ? (this.translate.instant('LOGIN.WECHAT_REGISTER_SUCCESS') || '注册成功')
                : (this.translate.instant('LOGIN.LOGIN_SUCCESS') || '登录成功')
            );
            this.cleanupEmailBind();
            this.emailBindMode = false;
            this.emailBindCountdown = 0;
            this.cdr.detectChanges();
          }).catch((err) => {
            console.error('处理邮箱绑定登录成功数据失败:', err);
            this.message.error(this.translate.instant('LOGIN.LOGIN_FAILED') || '登录失败');
            this.emailBindIsSubmitting = false;
            this.cdr.detectChanges();
          });
        } else {
          this.message.error(response.message || '绑定失败');
          this.emailBindIsSubmitting = false;
          this.cdr.detectChanges();
        }
      },
      error: (error) => {
        console.error('邮箱绑定登录失败:', error);
        const msg = error?.error?.messages || error?.error?.message || '绑定失败，请重试';
        this.message.error(msg);
        this.emailBindIsSubmitting = false;
        this.cdr.detectChanges();
      },
    });
  }

  private startEmailBindCountdown(): void {
    this.clearEmailBindCountdown();
    this.emailBindCountdown = 60;
    this.emailBindCountdownTimer = setInterval(() => {
      this.emailBindCountdown--;
      this.cdr.detectChanges();
      if (this.emailBindCountdown <= 0) {
        this.clearEmailBindCountdown();
        this.emailBindIsSendingCode = false;
        this.cdr.detectChanges();
      }
    }, 1000);
  }

  private clearEmailBindCountdown(): void {
    if (this.emailBindCountdownTimer) {
      clearInterval(this.emailBindCountdownTimer);
      this.emailBindCountdownTimer = null;
    }
  }

  private cleanupEmailBind(): void {
    this.clearEmailBindCountdown();
  }
}
