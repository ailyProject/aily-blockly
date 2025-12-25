import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { RouterOutlet, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { ElectronService } from './services/electron.service';
import { ConfigService } from './services/config.service';
import { TranslationService } from './services/translation.service';
import { AuthService } from './services/auth.service';
import { NzMessageService } from 'ng-zorro-antd/message';

// 声明 electronAPI 类型
declare const window: any;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, CommonModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'aily-blockly';

  private electronService = inject(ElectronService);
  private configService = inject(ConfigService);
  private translationService = inject(TranslationService);
  private authService = inject(AuthService);
  private message = inject(NzMessageService);
  private router = inject(Router);

  private oauthResultListener: (() => void) | null = null;
  private exampleListListener: (() => void) | null = null;

  async ngOnInit() {
    await this.electronService.init();
    await this.configService.init();
    await this.translationService.init();

    // 在ElectronService初始化完成后再初始化认证服务
    await this.authService.initializeAuth();

    if (!this.electronService.isElectron) return;
    // 设置全局OAuth监听器
    this.setupGlobalOAuthListener();
    // 设置示例列表监听器
    this.setupExampleListListener();

    // 通知主进程渲染进程已就绪
    this.electronService.sendRendererReady();
  }

  ngOnDestroy() {
    // 清理OAuth监听器
    if (this.oauthResultListener) {
      this.oauthResultListener();
    }
    // 清理示例列表监听器
    if (this.exampleListListener) {
      this.exampleListListener();
    }
  }

  /**
   * 设置全局GitHub OAuth协议回调监听
   */
  private setupGlobalOAuthListener() {
    if (window['oauth'] && window['oauth'].onCallback) {
      this.oauthResultListener = window['oauth'].onCallback(async (callbackData: any) => {
        try {
          // 使用AuthService处理协议回调
          const result = await this.authService.handleOAuthCallback(callbackData);

          if (result.success) {
            console.log('GitHub OAuth 成功:', result.data);
            this.message.success('GitHub 登录成功');
          } else {
            // OAuth失败
            let errorMessage = 'GitHub 登录超时，请重试';

            switch (result.error) {
              case 'timeout':
              case 'invalid_state':
                errorMessage = '登录状态无效或已超时，请重试';
                break;
              case 'missing_parameters':
                errorMessage = '授权参数缺失，请重试';
                break;
              case 'access_denied':
                errorMessage = '您取消了授权';
                break;
              case 'callback_processing_failed':
                errorMessage = result.message || '处理授权回调失败';
                break;
              default:
                errorMessage = result.message || 'GitHub 登录超时，请重试';
            }

            this.message.error(errorMessage);
          }
        } catch (error) {
          console.error('处理OAuth回调异常:', error);
          this.message.error('登录处理失败，请重试');
        }
      });
    }
  }

  /**
   * 设置示例列表协议监听
   */
  private setupExampleListListener() {
    if (window['exampleList'] && window['exampleList'].onOpen) {
      this.exampleListListener = window['exampleList'].onOpen((data: any) => {
        console.log('收到打开示例列表请求:', data);
        
        // 导航到示例列表页面
        this.router.navigate(['/main/playground'], {
          queryParams: { 
            keyword: data.keyword || '',
            id: data.id || '',
            sessionId: data.sessionId || '',
            params: data.params || '',
            version: data.version || ''
          }
        });
      });
    }
  }
}
