import { Component, ElementRef, inject, ViewChild } from '@angular/core';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { AuthService, LoginRequest, RegisterRequest } from '../../services/auth.service';
import sha256 from 'crypto-js/sha256';
import { Subject, takeUntil } from 'rxjs';
import { ElectronService } from '../../services/electron.service';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzMessageService } from 'ng-zorro-antd/message';
import { LoginComponent } from '../../components/login/login.component';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzProgressModule } from 'ng-zorro-antd/progress';
import { NzInputModule } from 'ng-zorro-antd/input';
import { UiService } from '../../services/ui.service';

@Component({
  selector: 'app-user-center',
  imports: [
    FormsModule,
    CommonModule,
    ToolContainerComponent,
    LoginComponent,
    NzButtonModule,
    NzProgressModule,
    NzInputModule
  ],
  templateUrl: './user-center.component.html',
  styleUrl: './user-center.component.scss'
})
export class UserCenterComponent {
  currentUrl = '/user-center';
  windowInfo = '用户中心';
  @ViewChild('menuBox') menuBox: ElementRef;
  @ViewChild('nicknameInput') nicknameInput?: ElementRef<HTMLInputElement>;

  private destroy$ = new Subject<void>();
  private message = inject(NzMessageService);
  private authService = inject(AuthService);

  userInfo = {
    username: '',
    password: '',
    email: ''
  }

  isWaiting = false;
  isRegistering = false;
  isLoggedIn = false;
  currentUser: any = null;
  isGitHubAuthWaiting = false;
  isEditingNickname = false;
  editedNickname = '';
  nicknameSaving = false;
  nicknameError = '';
  quotaUsagePercent = 0;

  constructor(
    private uiService: UiService
  ) {

  }

  async ngOnInit() {
    // 首先检查并同步登录状态
    await this.checkAndSyncAuthStatus();

    // 监听登录状态
    this.authService.isLoggedIn$
      .pipe(takeUntil(this.destroy$))
      .subscribe(isLoggedIn => {
        this.isLoggedIn = isLoggedIn;
        this.refreshMe();
      });

    // 监听用户信息
    this.authService.userInfo$
      .pipe(takeUntil(this.destroy$))
      .subscribe(userInfo => {
        console.log('UserCenterComponent - 接收到用户信息更新: ', userInfo);
        this.currentUser = userInfo;
        this.calculateQuotaUsagePercent();
      });

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
      console.error('同步认证状态失败:', error);
    }
  }

  refreshMe() {
    this.authService.refreshMe().then(() => {
      console.log('Auth token refreshed.');
      this.calculateQuotaUsagePercent();
    });
  }


  ngAfterViewInit(): void {
    this.refreshMe();
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  async onRegister() {
    if (!this.userInfo.username || !this.userInfo.password || !this.userInfo.email) {
      this.message.warning('请填写完整的注册信息');
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
          this.message.success('注册成功，请登录');
          this.isRegistering = false;
          // 清空密码，保留用户名用于登录
          this.userInfo.password = '';
          this.userInfo.email = '';
        },
        error: (error) => {
          console.error('注册错误:', error);
          this.message.error('注册失败，请检查网络连接');
        },
        complete: () => {
          this.isWaiting = false;
        }
      });
    } catch (error) {
      console.error('注册过程中出错:', error);
      this.message.error('注册失败');
      this.isWaiting = false;
    }
  }

  async onLogout() {
    this.isWaiting = true;
    try {
      await this.authService.logout();
      this.message.success('已退出登录');
    } catch (error) {
      console.error('退出登录失败:', error);
      this.message.error('退出登录失败');
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
    this.message.warning('服务暂不可用');
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
      this.nicknameError = '昵称不能为空';
      this.message.warning('昵称不能为空');
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
      this.message.success('昵称修改已保存');
      this.isEditingNickname = false;
      this.editedNickname = '';
    } catch (error) {
      console.error('昵称更新失败:', error);
      this.nicknameError = '昵称更新失败，请稍后重试';
      this.message.error('昵称更新失败，请稍后重试');
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
          throw new Error('昵称修改失败，服务器返回错误');
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

  get quotaRemainingPercent(): number {
    return Math.max(0, 100 - this.quotaUsagePercent);
  }

  private calculateQuotaUsagePercent(): void {
    console.log('=== 开始计算配额使用百分比 ===');
    console.log('currentUser 完整对象:', JSON.stringify(this.currentUser, null, 2));
    console.log('currentUser?.quota:', this.currentUser?.quota);
    
    const total = this.currentUser?.quota?.total_token ?? 0;
    const used = this.currentUser?.quota?.used_token ?? 0;
    
    console.log('提取的值 - total:', total, 'used:', used);
    console.log('total 类型:', typeof total, 'used 类型:', typeof used);
    
    if (!total || total <= 0) {
      this.quotaUsagePercent = 0;
      console.log('总配额为0或无效，设置使用百分比为0');
      return;
    }
    const percent = (used / total) * 100;
    // 保留2位小数，不四舍五入到整数
    this.quotaUsagePercent = Math.max(0, Math.min(100, Number(percent.toFixed(2))));
    console.log('计算得到的使用百分比:', this.quotaUsagePercent, '(used/total*100 =', used, '/', total, '*100)');
    console.log('=== 计算完成 ===');
  }
}
