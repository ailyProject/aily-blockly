import { CommonModule } from '@angular/common';
import { Component, Input, Output, EventEmitter, inject, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzDividerModule } from 'ng-zorro-antd/divider';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { AuthService, LoginRequest, RegisterRequest } from '../../../services/auth.service';
import { ElectronService } from '../../../services/electron.service';
import { GitHubLoginDialogComponent } from '../github-login-dialog/github-login-dialog.component';
import { Subject, takeUntil } from 'rxjs';
import sha256 from 'crypto-js/sha256';

// 声明 electronAPI 类型
declare const window: any;

@Component({
  selector: 'app-user',
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzInputModule,
    NzSpinModule,
    NzDividerModule,
    NzIconModule
  ],
  templateUrl: './user.component.html',
  styleUrl: './user.component.scss'
})
export class UserComponent implements OnInit, OnDestroy, AfterViewInit {

  @ViewChild('menuBox') menuBox: ElementRef;

  @Input() position = {
    x: 0,
    y: 40,
  };

  @Input() width = 300;

  @Output() closeEvent = new EventEmitter<void>();

  private destroy$ = new Subject<void>();
  private message = inject(NzMessageService);
  private modal = inject(NzModalService);
  private authService = inject(AuthService);
  private electronService = inject(ElectronService);

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

  async ngOnInit() {
    // 首先检查并同步登录状态
    await this.checkAndSyncAuthStatus();

    // 监听登录状态
    this.authService.isLoggedIn$
      .pipe(takeUntil(this.destroy$))
      .subscribe(isLoggedIn => {
        this.isLoggedIn = isLoggedIn;
        
        // 如果登录成功且当前在GitHub登录等待状态，关闭弹窗
        if (isLoggedIn && this.isGitHubAuthWaiting) {
          this.isGitHubAuthWaiting = false;
          this.closeEvent.emit();
        }
      });

    // 监听用户信息
    this.authService.userInfo$
      .pipe(takeUntil(this.destroy$))
      .subscribe(userInfo => {
        this.currentUser = userInfo;
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

  ngAfterViewInit(): void {
    document.addEventListener('click', this.handleDocumentClick);
    document.addEventListener('contextmenu', this.handleDocumentClick);
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    document.removeEventListener('click', this.handleDocumentClick);
    document.removeEventListener('contextmenu', this.handleDocumentClick);
  }

  handleDocumentClick = (event: MouseEvent) => {
    event.preventDefault();
    const target = event.target as Node;

    // 检查点击是否在用户组件内
    const isClickInUserBox = this.menuBox && this.menuBox.nativeElement.contains(target);

    if (!isClickInUserBox) {
      this.closeEvent.emit();
    }
  };

  async onLogin() {
    if (!this.userInfo.username || !this.userInfo.password) {
      this.message.warning('请输入用户名和密码');
      return;
    }

    this.isWaiting = true;

    try {
      const loginData: LoginRequest = {
        username: this.userInfo.username,
        password: sha256(this.userInfo.password).toString()
      };

      this.authService.login(loginData).subscribe({
        next: (response) => {
          if (response.status === 200 && response.data) {
            this.message.success('登录成功');
            this.closeEvent.emit();
          } else {
            this.message.error(response.message || '登录失败');
          }
        },
        error: (error) => {
          console.error('登录错误:', error);
          this.message.error('登录失败，请检查网络连接');
        },
        complete: () => {
          this.isWaiting = false;
        }
      });
    } catch (error) {
      console.error('登录过程中出错:', error);
      this.message.error('登录失败');
      this.isWaiting = false;
    }
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
      this.closeEvent.emit();
    } catch (error) {
      console.error('退出登录失败:', error);
      this.message.error('退出登录失败');
    } finally {
      this.isWaiting = false;
    }
  }

  onSettings() {
    console.log('用户设置');
    // 这里可以添加设置逻辑
    this.closeEvent.emit();
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

  /**
   * 开始 GitHub 浏览器 OAuth 登录
   */
  async onGitHubLogin() {
    if (this.isGitHubAuthWaiting) return;

    // 首先显示确认对话框
    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: {
        padding: '0',
      },
      nzWidth: '380px',
      nzContent: GitHubLoginDialogComponent,
      nzData: {
        title: 'GitHub 登录确认',
        text: ''
      }
    });

    // 等待用户选择
    modalRef.afterClose.subscribe(async (result: any) => {
      if (result && result.result === 'agree') {
        // 用户同意，继续GitHub登录流程
        await this.proceedWithGitHubLogin();
      }
      // 如果用户取消或关闭对话框，则不执行任何操作
    });
  }

  /**
   * 执行实际的GitHub登录流程
   */
  private async proceedWithGitHubLogin() {
    this.isGitHubAuthWaiting = true;

    try {
      // 直接通过 HTTP 请求启动 GitHub OAuth 流程
      this.authService.startGitHubOAuth().subscribe({
        next: (response) => {
          // 使用 ElectronService 在系统浏览器中打开授权页面
          if (this.electronService.isElectron) {
            this.electronService.openUrl(response.authorization_url);
            this.message.info('正在跳转到 GitHub 授权页面...');
          } else {
            // 如果不在 Electron 环境中，使用 window.open 作为降级方案
            window.open(response.authorization_url, '_blank');
            this.message.info('正在跳转到 GitHub 授权页面...');
          }
        },
        error: (error) => {
          console.error('启动 GitHub OAuth 失败:', error);
          this.message.error('启动 GitHub 登录失败，请检查网络连接');
          this.isGitHubAuthWaiting = false;
        }
      });
    } catch (error) {
      console.error('GitHub 登录出错:', error);
      this.message.error('GitHub 登录失败');
      this.isGitHubAuthWaiting = false;
    }
  }

}
