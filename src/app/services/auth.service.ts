import { Injectable, inject, ApplicationRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject, throwError, from, firstValueFrom } from 'rxjs';
import { catchError, map, switchMap, timeout } from 'rxjs/operators';
import { API } from '../configs/api.config';
import { ElectronService } from './electron.service';
import { createApiError, extractApiErrorDetails } from '../utils/api-error.utils';
import type {
  AuthQuotaInfoSnapshot,
  AuthQuotaInfoSnapshotItem,
  AuthSnapshot,
  AuthUserInfo,
} from '../tools/aily-chat/core/auth-snapshot';

export interface CommonResponse {
  status: number;
  message?: string | null;
  messages?: string | string[] | null;
  errorCode?: string | null;
  errorArgs?: Record<string, unknown>;
  errorMessage?: string | null;
  data?: any;
}

export interface GitHubPermissionStatus {
  provider: 'github';
  bound: boolean;
  provider_username?: string | null;
  provider_email?: string | null;
  scopes: string[];
  repo: boolean;
  public_repo: boolean;
  pr_submission_enabled: boolean;
  github_authorization_purpose?: string | null;
  scope_checked_at?: string | null;
}

export interface LoginRequest {
  username: string;
  password: string;
  altcha?: string;
}

export interface LoginResponse {
  status: number;
  message?: string | null;
  messages?: string | string[] | null;
  errorCode?: string | null;
  errorArgs?: Record<string, unknown>;
  errorMessage?: string | null;
  data?: {
    access_token: string;
    refresh_token?: string;
    token_type: "bearer";
    user?: {
      id: string;
      email?: string;
      phone?: string;
      nickname?: string;
      groups?: string[];
    };
  };
}

interface RefreshTokenResponseData {
  access_token: string;
  refresh_token?: string;
  token_type?: 'bearer';
}

export type GitHubOAuthPurpose = 'login' | 'bind' | 'library_pr_submit';

interface AuthHandleErrorOptions {
  log?: boolean;
}

export interface RegisterRequest {
  username: string;
  password: string;
  email: string;
}

export interface SSOTokenResponse {
  sso_token: string;
  expires_in: number;
  target_url: string | null;
}

export type AuthInitializationState =
  | 'idle'
  | 'checking'
  | 'authenticated'
  | 'signed_out'
  | 'unavailable';

export interface LoginDialogRequestState {
  requestId: number;
  reason: string;
  allowSkip: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly TOKEN_KEY = 'aily_user_token';
  private readonly REFRESH_TOKEN_KEY = 'aily_refresh_token';
  private readonly USER_INFO_KEY = 'aily_user_info';

  private http = inject(HttpClient);
  private electronService = inject(ElectronService);
  private appRef = inject(ApplicationRef);

  // 用户登录状态
  private isLoggedInSubject = new BehaviorSubject<boolean>(false);
  public isLoggedIn$ = this.isLoggedInSubject.asObservable();
  get isLoggedIn(): boolean { return this.isLoggedInSubject.value; }

  // 登录时需要绑定微信的信号
  private needsWechatBindSubject = new Subject<string>();
  public needsWechatBind$ = this.needsWechatBindSubject.asObservable();

  /** 由 app.component 调用，通知登录组件进入微信绑定模式 */
  emitNeedsWechatBind(pendingTicket: string): void {
    this.needsWechatBindSubject.next(pendingTicket);
  }

  // 用户信息
  private userInfoSubject = new BehaviorSubject<AuthUserInfo | null>(null);
  public userInfo$ = this.userInfoSubject.asObservable();
  private githubBindCompletedSubject = new Subject<any>();
  public githubBindCompleted$ = this.githubBindCompletedSubject.asObservable();

  // 归一化 auth snapshot，避免 chat 等消费者依赖原始 userInfo 结构
  private authSnapshotSubject = new BehaviorSubject<AuthSnapshot | null>(null);
  public authSnapshot$ = this.authSnapshotSubject.asObservable();
  private authChangedSubject = new Subject<void>();
  public authChanged$ = this.authChangedSubject.asObservable();
  private authQuotaInfoSnapshotOverride: AuthQuotaInfoSnapshot | null = null;
  private authQuotaInfoRefreshRetryHandle: ReturnType<typeof setTimeout> | null = null;
  private authHydrationRetryHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly authQuotaInfoRefreshRetryDelaysMs = [0, 1000, 5000] as const;
  private readonly authHydrationRetryDelaysMs = [1000, 5000] as const;
  private readonly authRequestTimeoutMs = 12000;
  private readonly authQuotaRequestTimeoutMs = 8000;
  private authInitializationPromise: Promise<void> | null = null;
  private readonly authInitializationStateSubject = new BehaviorSubject<AuthInitializationState>('idle');
  readonly authInitializationState$ = this.authInitializationStateSubject.asObservable();

  private loginDialogRequestId = 0;
  private readonly loginDialogRequestSubject = new BehaviorSubject<LoginDialogRequestState | null>(null);
  readonly loginDialogRequest$ = this.loginDialogRequestSubject.asObservable();

  // 登录弹窗显示状态
  showUser = new BehaviorSubject<any>(null);

  constructor() {
    // 登录状态变化后强制触发全局变更检测
    this.isLoggedInSubject.subscribe((isLoggedIn) => {
      if (isLoggedIn) {
        this.dismissLoginDialog();
      }
      setTimeout(() => this.appRef.tick());
    });
  }

  requestLogin(reason = 'auth-required', options: { allowSkip?: boolean } = {}): void {
    if (this.isLoggedIn) {
      return;
    }

    const current = this.loginDialogRequestSubject.value;
    this.loginDialogRequestSubject.next({
      requestId: ++this.loginDialogRequestId,
      reason,
      allowSkip: options.allowSkip === true || current?.allowSkip === true,
    });
  }

  dismissLoginDialog(): void {
    if (this.loginDialogRequestSubject.value !== null) {
      this.loginDialogRequestSubject.next(null);
    }
  }

  /**
   * 初始化认证状态 - 需要在ElectronService初始化后调用
   */
  initializeAuth(): Promise<void> {
    if (this.authInitializationPromise) {
      return this.authInitializationPromise;
    }

    const operation = this.performAuthInitialization();
    this.authInitializationPromise = operation;
    const clearOperation = () => {
      if (this.authInitializationPromise === operation) {
        this.authInitializationPromise = null;
      }
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  getAuthInitializationState(): AuthInitializationState {
    return this.authInitializationStateSubject.value;
  }

  private async performAuthInitialization(): Promise<void> {
    this.authInitializationStateSubject.next('checking');
    try {
      const token = await this.getToken2();
      if (!token) {
        this.isLoggedInSubject.next(false);
        this.authInitializationStateSubject.next('signed_out');
        return;
      }

      const userInfo = await this.getMe(token);
      const authenticated = !!userInfo;
      this.isLoggedInSubject.next(authenticated);
      this.authInitializationStateSubject.next(authenticated ? 'authenticated' : 'signed_out');
    } catch (error) {
      if (isAuthCredentialError(error)) {
        this.isLoggedInSubject.next(false);
        this.authInitializationStateSubject.next('signed_out');
        return;
      }

      // Network and timeout failures do not invalidate locally stored
      // credentials. Remote capability owns the unavailable/offline surface.
      this.authInitializationStateSubject.next('unavailable');
    }
  }

  /**
   * 用户登录
   */
  login(loginData: LoginRequest): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(API.login, { ...loginData, device_id: 'pc' }).pipe(
      switchMap((response) => {
        // console.log("登录响应: ", response);
        if (response.status === 200 && response.data) {
          return from((async () => {
            await this.saveToken2(response.data.access_token);
            if (response.data.refresh_token) {
              await this.saveRefreshToken(response.data.refresh_token);
            }
            await this.handleSuccessfulTokenAcquisition(
              response.data.access_token,
              response.data.user as AuthUserInfo | undefined,
            );
            return response;
          })());
        } else {
          this.isLoggedInSubject.next(false);
        }

        return from(Promise.resolve(response));
      }),
      catchError(error => this.handleError(error))
    );
  }

  /**
   * 用户注册
   */
  register(registerData: RegisterRequest): Observable<any> {
    return this.http.post(API.register, registerData).pipe(
      catchError(error => this.handleError(error))
    );
  }

  /**
   * 发送邮箱验证码
   */
  sendEmailCode(email: string, altcha: string): Observable<CommonResponse> {
    // Mock 模式下直接返回成功
    if (this.getWechatMockScenario()) {
      return new Observable(observer => {
        setTimeout(() => {
          observer.next({ status: 200, message: 'mock: 验证码已发送' } as CommonResponse);
          observer.complete();
        }, 200);
      });
    }
    return this.http.post<CommonResponse>(API.sendEmailCode, { email, altcha, device_id: 'pc' }).pipe(
      catchError(error => this.handleError(error))
    );
  }

  /**
   * 邮箱验证码登录
   */
  loginByEmail(email: string, code: string, inviteCode: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(API.loginByEmail, { email, code, device_id: 'pc', invite_code: inviteCode }).pipe(
      switchMap((response) => {
        if (response.status === 200 && response.data) {
          // 需要绑定微信时不保存 token
          if ((response.data as any).status === 'needs_wechat_bind') {
            return from(Promise.resolve(response));
          }
          return from((async () => {
            await this.saveToken2(response.data!.access_token);
            if (response.data!.refresh_token) {
              await this.saveRefreshToken(response.data!.refresh_token);
            }
            await this.handleSuccessfulTokenAcquisition(
              response.data!.access_token,
              response.data!.user as AuthUserInfo | undefined,
            );
            return response;
          })());
        } else {
          this.isLoggedInSubject.next(false);
        }

        return from(Promise.resolve(response));
      }),
      catchError(error => this.handleError(error))
    );
  }

  /**
   * 用户登出
   */
  async logout(): Promise<void> {
    try {
      const token = await this.getToken2();
      if (token) {
        // 调用服务器登出接口
        this.http.get<CommonResponse>(API.logout, {
          headers: { Authorization: `Bearer ${token}` }
        }).subscribe({
          error: (error) => console.warn('服务器登出')
        });
      }
    } catch (error) {
      console.error('登出过程中出错:', error);
    } finally {
      // 清理当前实例的认证数据
      await this.clearAuthData();
    }
  }

  /**
   * 验证 token 是否有效
   */
  private verifyToken(token: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.http.post<CommonResponse>(API.verifyToken, {}, {
        headers: { Authorization: `Bearer ${token}` }
      }).subscribe({
        next: (response) => resolve(response.data.valid || false),
        error: () => resolve(false)
      });
    });
  }

  /**
   * 获取当前登录用户信息
   */
  private getMe(token: string): Promise<AuthUserInfo | null> {
    return new Promise((resolve, reject) => {
      this.http.get<CommonResponse>(API.me, {
        headers: { Authorization: `Bearer ${token}` }
      }).pipe(
        timeout(this.authRequestTimeoutMs),
      ).subscribe({
        next: async (response) => {
          if (response.status === 200 && response.data) {
            const userData = this.mergeCurrentGithubInfo(response.data);
            try {
              const quotaInfoSnapshot = await this.getAuthQuotaInfoSnapshot(token);
              this.setCurrentUserInfo(userData, quotaInfoSnapshot);
            } catch (quotaError) {
              console.warn('获取独立配额快照失败，回退到 auth/me:', quotaError);
              const recoveredQuotaInfoSnapshot = await this.retryAuthQuotaInfoSnapshotImmediately(token);
              if (recoveredQuotaInfoSnapshot) {
                this.setCurrentUserInfo(userData, recoveredQuotaInfoSnapshot);
              } else {
                this.setCurrentUserInfo(userData, null);
                if (this.getAuthSnapshot()?.quotaInfoSnapshot?.source !== 'token') {
                  this.scheduleAuthQuotaInfoSnapshotRetry(token, userData, 1);
                }
              }
            }
            resolve(userData);
          } else {
            console.warn('获取用户信息失败:', response);
            reject(null);
          }
        },
        error: (error) => reject(error)
      });
    });
  }

  async refreshCurrentUser(): Promise<any | null> {
    // 先检查是否有 token，没有 token 就不发起请求
    const token = await this.getToken2();
    if (!token) {
      return null;
    }
    return this.getMe(token);
  }

  async refreshMe() {
    await this.refreshCurrentUser();
  }

  hasGithubBinding(user: any = this.currentUser): boolean {
    return user?.github?.bound === true;
  }

  hasGithubLibraryPrPermission(user: any = this.currentUser): boolean {
    const github = user?.github;
    if (!github || typeof github !== 'object' || Array.isArray(github)) {
      return false;
    }
    if (github.pr_submission_enabled === true) {
      return true;
    }

    const extraData = github.extra_data && typeof github.extra_data === 'object' && !Array.isArray(github.extra_data)
      ? github.extra_data
      : {};
    const scopes = [
      ...this.normalizeGithubScopes(github.scopes),
      ...this.normalizeGithubScopes(github.scope),
      ...this.normalizeGithubScopes(extraData['scopes']),
      ...this.normalizeGithubScopes(extraData['scope']),
    ];
    return scopes.includes('repo');
  }

  private normalizeGithubScopes(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((scope): scope is string => typeof scope === 'string');
    }
    if (typeof value === 'string') {
      return value.split(/[,\s]+/).map(scope => scope.trim()).filter(Boolean);
    }
    return [];
  }

  getGithubPermissions(): Observable<GitHubPermissionStatus> {
    return this.http.get<CommonResponse & { data: GitHubPermissionStatus }>(API.githubPermissions).pipe(
      map(response => {
        if (response.status === 200 && response.data) {
          this.mergeGithubPermissionStatus(response.data);
          return response.data;
        }
        throw response;
      }),
      catchError(error => this.handleError(error))
    );
  }

  hasGithubLibraryPrPermissionStatus(status: GitHubPermissionStatus | null | undefined): boolean {
    if (!status?.bound) {
      return false;
    }
    const scopes = this.normalizeGithubScopes(status.scopes);
    return status.pr_submission_enabled === true || status.repo === true || scopes.includes('repo');
  }

  private mergeGithubPermissionStatus(status: GitHubPermissionStatus): void {
    const currentUser: any = this.currentUser || {};
    const currentGithub = currentUser?.github && typeof currentUser.github === 'object' && !Array.isArray(currentUser.github)
      ? currentUser.github
      : {};
    this.setCurrentUserInfo({
      ...currentUser,
      github: {
        ...currentGithub,
        ...status,
        bound: status.bound,
        scopes: this.normalizeGithubScopes(status.scopes),
      },
    });
  }

  private mergeCurrentGithubInfo(user: any): any {
    if (!user || typeof user !== 'object' || Array.isArray(user)) {
      return user;
    }
    const currentUser: any = this.currentUser;
    const currentGithub = currentUser?.github && typeof currentUser.github === 'object' && !Array.isArray(currentUser.github)
      ? currentUser.github
      : {};
    const nextGithub = user.github && typeof user.github === 'object' && !Array.isArray(user.github)
      ? user.github
      : {};
    return {
      ...user,
      github: {
        ...currentGithub,
        ...nextGithub,
      },
    };
  }

  /**
   * 获取用户权益摘要（仪表盘用，无缓存）
   */
  getBenefits(): Observable<CommonResponse> {
    return this.http.get<CommonResponse>(API.benefits);
  }

  /**
   * 更改用户昵称
   */
  async changeNickname(newNickname: string) {
    return this.http.post<CommonResponse>(API.changeNickname, { nickname: newNickname });
  }



  /**
   * 检查是否支持安全存储
   */
  private isSafeStorageAvailable(): boolean {
    try {
      // 使用有错，当前直接返回false
      // return window['safeStorage'];
      return false;
    } catch (error) {
      console.warn('SafeStorage 检查失败:', error);
      return false;
    }
  }

  /**
   * 安全保存 token
   */
  private async saveToken(token: string): Promise<void> {
    try {
      if (this.electronService.isElectron && (window as any).electronAPI?.safeStorage) {
        const encrypted = (window as any).electronAPI.safeStorage.encryptString(token);
        localStorage.setItem(this.TOKEN_KEY, encrypted.toString('base64'));
      } else {
        // 降级到 localStorage（开发环境或不支持 safeStorage）
        localStorage.setItem(this.TOKEN_KEY, token);
      }
    } catch (error) {
      // console.error('保存 token 失败:', error);
      throw error;
    }
  }

  /**
   * 获取 token
   */
  async getToken(): Promise<string | null> {
    try {
      const storedData = localStorage.getItem(this.TOKEN_KEY);
      if (!storedData) return null;

      if (this.electronService.isElectron && (window as any).electronAPI?.safeStorage) {
        try {
          const buffer = Buffer.from(storedData, 'base64');
          return (window as any).electronAPI.safeStorage.decryptString(buffer);
        } catch (error) {
          console.error('Token 解密失败:', error);
          localStorage.removeItem(this.TOKEN_KEY);
          return null;
        }
      } else {
        // 降级到直接返回（开发环境）
        return storedData;
      }
    } catch (error) {
      console.error('获取 token 失败:', error);
      return null;
    }
  }

  /**
   * 检查认证文件是否存在（用于快速判断登录状态）
   */
  async checkAuthFileExists(): Promise<boolean> {
    try {
      if (this.electronService.isElectron && (window as any).electronAPI?.path && (window as any).electronAPI?.fs) {
        const appDataPath = (window as any).electronAPI.path.getAppDataPath();
        const authFilePath = (window as any).electronAPI.path.join(appDataPath, '.aily');
        return (window as any).electronAPI.fs.existsSync(authFilePath);
      } else {
        // 降级到localStorage检查
        const token = localStorage.getItem('aily_auth_token');
        return !!token;
      }
    } catch (error) {
      console.error('检查认证文件失败:', error);
      return false;
    }
  }

  /**
   * 同步登录状态（基于文件存在性检查）
   */
  async syncLoginStatus(): Promise<void> {
    try {
      const fileExists = await this.checkAuthFileExists();
      const currentLoginStatus = this.isLoggedInSubject.value;

      // 如果文件状态与当前登录状态不一致，则更新状态
      if (fileExists !== currentLoginStatus) {
        if (!fileExists && currentLoginStatus) {
          // 文件不存在但当前显示为登录状态，说明其他实例已登出
          // console.log('检测到其他实例已登出，同步登出当前实例');
          await this.clearAuthData();
        } else if (fileExists && !currentLoginStatus) {
          // 文件存在但当前显示为未登录状态，重新获取用户信息
          // console.log('检测到认证文件存在，重新获取登录状态');
          const token = await this.getToken2();
          if (token) {
            try {
              const userInfo = await this.getMe(token);
              if (userInfo) {
                this.isLoggedInSubject.next(true);
              }
            } catch (error) {
              console.error('获取用户信息失败:', error);
              // token可能已过期，清理文件
              await this.clearAuthDataFile();
            }
          }
        }
      }
    } catch (error) {
      console.error('同步登录状态失败:', error);
    }
  }

  async saveToken2(token: string): Promise<void> {
    try {
      if (this.electronService.isElectron && (window as any).electronAPI?.path && (window as any).electronAPI?.fs) {
        // 获取AppData路径
        const appDataPath = (window as any).electronAPI.path.getAppDataPath();
        const authFilePath = (window as any).electronAPI.path.join(appDataPath, '.aily');

        // 读取现有文件内容或创建新的
        let authData: any = {};
        if ((window as any).electronAPI.fs.existsSync(authFilePath)) {
          try {
            const content = (window as any).electronAPI.fs.readFileSync(authFilePath);
            authData = JSON.parse(content);
          } catch (error) {
            console.warn('读取现有认证文件失败，将创建新文件:', error);
            authData = {};
          }
        }

        // 加密token（如果支持safeStorage）
        let encryptedToken = token;
        if ((window as any).electronAPI?.safeStorage) {
          try {
            const encrypted = (window as any).electronAPI.safeStorage.encryptString(token);
            encryptedToken = encrypted.toString('base64');
          } catch (error) {
            // console.warn('token加密失败，使用明文存储:', error);
          }
        }

        // 更新token
        authData.access_token = encryptedToken;
        authData.updated_at = new Date().toISOString();

        // 写入文件
        (window as any).electronAPI.fs.writeFileSync(authFilePath, JSON.stringify(authData, null, 2));
        // console.log('Token已保存到:', authFilePath);
      } else {
        // 降级到localStorage（开发环境或不支持electron）
        localStorage.setItem('aily_auth_token', token);
        // console.log('Token已保存到localStorage（降级方案）');
      }
    } catch (error) {
      console.error('保存token到.aily文件失败:', error);
      throw error;
    }
  }

  private async saveRefreshToken(refreshToken: string): Promise<void> {
    try {
      if (this.electronService.isElectron && (window as any).electronAPI?.path && (window as any).electronAPI?.fs) {
        const appDataPath = (window as any).electronAPI.path.getAppDataPath();
        const authFilePath = (window as any).electronAPI.path.join(appDataPath, '.aily');

        let authData: any = {};
        if ((window as any).electronAPI.fs.existsSync(authFilePath)) {
          try {
            const content = (window as any).electronAPI.fs.readFileSync(authFilePath);
            authData = JSON.parse(content);
          } catch (error) {
            console.warn('读取现有认证文件失败，将创建新文件:', error);
            authData = {};
          }
        }

        authData.refresh_token = refreshToken;
        authData.updated_at = new Date().toISOString();
        (window as any).electronAPI.fs.writeFileSync(authFilePath, JSON.stringify(authData, null, 2));
      } else {
        localStorage.setItem(this.REFRESH_TOKEN_KEY, refreshToken);
      }
    } catch (error) {
      console.error('保存刷新 token 失败:', error);
    }
  }

  private async getRefreshToken(): Promise<string | null> {
    try {
      if (this.electronService.isElectron && (window as any).electronAPI?.path && (window as any).electronAPI?.fs) {
        const appDataPath = (window as any).electronAPI.path.getAppDataPath();
        const authFilePath = (window as any).electronAPI.path.join(appDataPath, '.aily');

        if (!(window as any).electronAPI.fs.existsSync(authFilePath)) {
          return null;
        }

        const content = (window as any).electronAPI.fs.readFileSync(authFilePath, 'utf8');
        const authData = JSON.parse(content);
        return authData.refresh_token || null;
      }

      return localStorage.getItem(this.REFRESH_TOKEN_KEY);
    } catch (error) {
      console.error('获取刷新 token 失败:', error);
      return null;
    }
  }

  async getToken2(): Promise<string | null> {
    try {
      if (this.electronService.isElectron && (window as any).electronAPI?.path && (window as any).electronAPI?.fs) {
        // 获取AppData路径
        const appDataPath = (window as any).electronAPI.path.getAppDataPath();
        const authFilePath = (window as any).electronAPI.path.join(appDataPath, '.aily');

        // 检查文件是否存在
        if ((window as any).electronAPI.fs.existsSync(authFilePath)) {
          // console.log('认证文件存在，正在读取...');
          const content = (window as any).electronAPI.fs.readFileSync(authFilePath, 'utf8');
          const authData = JSON.parse(content);

          // console.log('authData: ', authData);

          return authData.access_token;

          //   // 解密token（如果支持safeStorage）
          //   if ((window as any).electronAPI?.safeStorage) {
          //     try {
          //       console.log('使用safeStorage解密token');
          //       const buffer = Buffer.from(authData.access_token, 'base64');
          //       return (window as any).electronAPI.safeStorage.decryptString(buffer);
          //     } catch (error) {
          //       console.error('Token解密失败:', error);
          //       return null;
          //     }
          //   } else {
          //     // 降级到直接返回（开发环境或不支持safeStorage）
          //     console.log('直接返回未加密的token');
          //     return authData.access_token;
          //   }
        } else {
          // console.warn('认证文件不存在:', authFilePath);
          return null;
        }
      } else {
        // console.log('使用localStorage降级模式');
        // console.log('electronService.isElectron:', this.electronService.isElectron);
        // console.log('electronAPI.path:', (window as any).electronAPI?.path);
        // console.log('electronAPI.fs:', (window as any).electronAPI?.fs);
        // 降级到localStorage（开发环境或不支持electron）
        return localStorage.getItem('aily_auth_token');
      }
    } catch (error) {
      // console.warn('获取token失败:', error);
      return null;
    }
  }

  /**
   * 移除.aily文件和localStorage中的认证数据
   */

  async clearAuthDataFile(): Promise<void> {
    try {
      if (this.electronService.isElectron && (window as any).electronAPI?.path && (window as any).electronAPI?.fs) {
        const appDataPath = (window as any).electronAPI.path.getAppDataPath();
        const authFilePath = (window as any).electronAPI.path.join(appDataPath, '.aily');

        // 删除.aily文件
        if ((window as any).electronAPI.fs.existsSync(authFilePath)) {
          (window as any).electronAPI.fs.unlinkSync(authFilePath);
          // console.log('已删除认证文件:', authFilePath);
        }
      } else {
        // 降级到localStorage（开发环境或不支持electron）
        localStorage.removeItem('aily_auth_token');
        // console.log('已清除localStorage中的认证数据');
      }
    } catch (error) {
      console.error('清除认证数据失败:', error);
    }
  }


  /**
   * 保存用户信息
   */
  private async saveUserInfo(userInfo: any): Promise<void> {
    try {
      const userInfoStr = JSON.stringify(userInfo);
      if (this.electronService.isElectron && (window as any).electronAPI?.safeStorage) {
        const encrypted = (window as any).electronAPI.safeStorage.encryptString(userInfoStr);
        localStorage.setItem(this.USER_INFO_KEY, encrypted.toString('base64'));
      } else {
        localStorage.setItem(this.USER_INFO_KEY, userInfoStr);
      }
    } catch (error) {
      // console.log('保存用户信息失败:', error);
    }
  }

  /**
   * 获取用户信息
   */
  private async getUserInfo(): Promise<any> {
    try {
      const storedData = localStorage.getItem(this.USER_INFO_KEY);
      if (!storedData) return null;

      let userInfoStr: string;
      if (this.electronService.isElectron && (window as any).electronAPI?.safeStorage) {
        try {
          const buffer = Buffer.from(storedData, 'base64');
          userInfoStr = (window as any).electronAPI.safeStorage.decryptString(buffer);
        } catch (error) {
          console.error('用户信息解密失败:', error);
          localStorage.removeItem(this.USER_INFO_KEY);
          return null;
        }
      } else {
        userInfoStr = storedData;
      }

      return JSON.parse(userInfoStr);
    } catch (error) {
      console.error('获取用户信息失败:', error);
      return null;
    }
  }

  /**
   * 清除所有认证数据
   */
  private async clearAuthData(): Promise<void> {
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.REFRESH_TOKEN_KEY);
    localStorage.removeItem(this.USER_INFO_KEY);
    this.clearPendingAuthQuotaInfoSnapshotRetry();
    this.clearPendingAuthHydrationRetry();
    this.clearAuthDataFile();
    this.isLoggedInSubject.next(false);
    this.setCurrentUserInfo(null);
    this.authInitializationStateSubject.next('signed_out');
  }

  /**
   * 获取当前登录状态
   */
  get isAuthenticated(): boolean {
    return this.isLoggedInSubject.value;
  }

  /**
   * 获取当前用户信息
   */
  get currentUser(): AuthUserInfo | null {
    return this.userInfoSubject.value;
  }

  get userInfo(): AuthUserInfo | null {
    return this.userInfoSubject.value;
  }

  getAuthSnapshot(): AuthSnapshot | null {
    return this.authSnapshotSubject.value;
  }

  async refreshAuthToken(): Promise<boolean> {
    const refreshToken = await this.getRefreshToken();
    if (!refreshToken) {
      return false;
    }

    try {
      const response = await firstValueFrom(
        this.http.post<CommonResponse & { data?: RefreshTokenResponseData }>(
          API.refreshToken,
          { refresh_token: refreshToken }
        )
      );

      const accessToken = response.data?.access_token;
      if (response.status !== 200 || !accessToken) {
        return false;
      }

      await this.saveToken2(accessToken);
      if (response.data?.refresh_token) {
        await this.saveRefreshToken(response.data.refresh_token);
      }
      return true;
    } catch (error) {
      console.warn('刷新 token 失败:', error);
      return false;
    }
  }

  /**
   * 检查当前用户是否具备指定权益
   */
  hasEntitlement(entitlementKey: string): boolean {
    const entitlements = this.currentUser?.entitlements;
    if (!entitlements || typeof entitlements !== 'object') {
      return false;
    }
    return Boolean(entitlements[entitlementKey]);
  }

  private async getAuthQuotaInfoSnapshot(token: string): Promise<AuthQuotaInfoSnapshot | null> {
    return new Promise((resolve, reject) => {
      this.http.get<CommonResponse>(API.authQuotaInfo, {
        headers: { Authorization: `Bearer ${token}` }
      }).pipe(
        timeout(this.authQuotaRequestTimeoutMs),
      ).subscribe({
        next: (response) => {
          if (response.status !== 200 || !response.data) {
            resolve(null);
            return;
          }

          resolve(normalizeAuthQuotaInfoSnapshotPayload(response.data, { source: 'token' }) ?? null);
        },
        error: (error) => reject(error),
      });
    });
  }

  private async retryAuthQuotaInfoSnapshotImmediately(
    token: string,
  ): Promise<AuthQuotaInfoSnapshot | null> {
    try {
      return await this.getAuthQuotaInfoSnapshot(token);
    } catch (error) {
      console.warn('立即重试独立配额快照失败:', error);
      return null;
    }
  }

  private scheduleAuthQuotaInfoSnapshotRetry(
    token: string,
    expectedUserInfo: AuthUserInfo,
    attemptIndex = 0,
  ): void {
    if (attemptIndex >= this.authQuotaInfoRefreshRetryDelaysMs.length) {
      return;
    }

    this.clearPendingAuthQuotaInfoSnapshotRetry();
    const retryDelay = this.authQuotaInfoRefreshRetryDelaysMs[attemptIndex];
    this.authQuotaInfoRefreshRetryHandle = setTimeout(() => {
      this.authQuotaInfoRefreshRetryHandle = null;
      void this.refreshAuthQuotaInfoSnapshotForCurrentUser(token, expectedUserInfo, attemptIndex);
    }, retryDelay);
  }

  private clearPendingAuthQuotaInfoSnapshotRetry(): void {
    if (this.authQuotaInfoRefreshRetryHandle !== null) {
      clearTimeout(this.authQuotaInfoRefreshRetryHandle);
      this.authQuotaInfoRefreshRetryHandle = null;
    }
  }

  private scheduleAuthHydrationRetry(
    token: string,
    expectedUserInfo: AuthUserInfo,
    attemptIndex = 0,
  ): void {
    if (attemptIndex >= this.authHydrationRetryDelaysMs.length) {
      return;
    }

    this.clearPendingAuthHydrationRetry();
    const retryDelay = this.authHydrationRetryDelaysMs[attemptIndex];
    this.authHydrationRetryHandle = setTimeout(() => {
      this.authHydrationRetryHandle = null;
      void this.refreshHydratedAuthStateForCurrentUser(token, expectedUserInfo, attemptIndex);
    }, retryDelay);
  }

  private clearPendingAuthHydrationRetry(): void {
    if (this.authHydrationRetryHandle !== null) {
      clearTimeout(this.authHydrationRetryHandle);
      this.authHydrationRetryHandle = null;
    }
  }

  private async refreshAuthQuotaInfoSnapshotForCurrentUser(
    token: string,
    expectedUserInfo: AuthUserInfo,
    attemptIndex: number,
  ): Promise<void> {
    const currentUserInfo = this.userInfoSubject.getValue();
    if (!currentUserInfo || !isSameAuthUser(currentUserInfo, expectedUserInfo)) {
      return;
    }

    if (this.authQuotaInfoSnapshotOverride?.source === 'token') {
      return;
    }

    try {
      const quotaInfoSnapshot = await this.getAuthQuotaInfoSnapshot(token);
      if (!quotaInfoSnapshot) {
        this.retryAuthQuotaInfoSnapshotIfStillPending(token, expectedUserInfo, attemptIndex + 1);
        return;
      }

      const latestUserInfo = this.userInfoSubject.getValue();
      if (!latestUserInfo || !isSameAuthUser(latestUserInfo, expectedUserInfo)) {
        return;
      }

      this.setCurrentUserInfo(latestUserInfo, quotaInfoSnapshot);
    } catch (error) {
      console.warn('后台刷新独立配额快照失败:', error);
      this.retryAuthQuotaInfoSnapshotIfStillPending(token, expectedUserInfo, attemptIndex + 1);
    }
  }

  private retryAuthQuotaInfoSnapshotIfStillPending(
    token: string,
    expectedUserInfo: AuthUserInfo,
    nextAttemptIndex: number,
  ): void {
    const latestUserInfo = this.userInfoSubject.getValue();
    if (!latestUserInfo || !isSameAuthUser(latestUserInfo, expectedUserInfo)) {
      return;
    }

    if (this.authQuotaInfoSnapshotOverride?.source === 'token') {
      return;
    }

    this.scheduleAuthQuotaInfoSnapshotRetry(token, expectedUserInfo, nextAttemptIndex);
  }

  private async refreshHydratedAuthStateForCurrentUser(
    token: string,
    expectedUserInfo: AuthUserInfo,
    attemptIndex: number,
  ): Promise<void> {
    const currentUserInfo = this.userInfoSubject.getValue();
    if (!currentUserInfo || !isSameAuthUser(currentUserInfo, expectedUserInfo)) {
      return;
    }

    try {
      const userInfo = await this.getMe(token);
      if (!userInfo) {
        this.scheduleAuthHydrationRetry(token, expectedUserInfo, attemptIndex + 1);
        return;
      }

      const latestUserInfo = this.userInfoSubject.getValue();
      if (!latestUserInfo || !isSameAuthUser(latestUserInfo, expectedUserInfo)) {
        return;
      }

      await this.saveUserInfo(userInfo);
    } catch (error) {
      console.warn('后台刷新完整认证快照失败:', error);
      this.scheduleAuthHydrationRetry(token, expectedUserInfo, attemptIndex + 1);
    }
  }

  private async retryHydratedAuthStateImmediately(
    token: string,
  ): Promise<AuthUserInfo | null> {
    try {
      return await this.getMe(token);
    } catch (error) {
      console.warn('立即重试完整认证快照失败:', error);
      return null;
    }
  }

  private handleSuccessfulTokenAcquisition(
    token: string,
    fallbackUser?: AuthUserInfo | null,
  ): Promise<boolean> {
    return this.hydrateAuthStateFromToken(token, fallbackUser ?? null)
      .then((user) => {
        const isLoggedIn = !!user;
        this.isLoggedInSubject.next(isLoggedIn);
        this.authInitializationStateSubject.next(isLoggedIn ? 'authenticated' : 'unavailable');
        return isLoggedIn;
      });
  }

  private async hydrateAuthStateFromToken(
    token: string,
    fallbackUser?: AuthUserInfo | null,
  ): Promise<AuthUserInfo | null> {
    try {
      const userInfo = await this.getMe(token);
      if (userInfo) {
        await this.saveUserInfo(userInfo);
        return userInfo;
      }
    } catch (error) {
      console.warn('获取完整认证快照失败，立即重试一次:', error);
      const recoveredUser = await this.retryHydratedAuthStateImmediately(token);
      if (recoveredUser) {
        await this.saveUserInfo(recoveredUser);
        return recoveredUser;
      }
      console.warn('完整认证快照立即重试仍失败，尝试使用回退用户信息');
    }

    if (fallbackUser) {
      await this.saveUserInfo(fallbackUser);
      this.setCurrentUserInfo(fallbackUser);
      this.scheduleAuthHydrationRetry(token, fallbackUser);
      return fallbackUser;
    }

    return null;
  }

  private setCurrentUserInfo(
    userInfo: AuthUserInfo | null,
    quotaInfoSnapshotOverride?: AuthQuotaInfoSnapshot | null,
  ): void {
    const previousUserInfo = this.userInfoSubject.getValue();
    if (!userInfo || !isSameAuthUser(previousUserInfo, userInfo)) {
      this.clearPendingAuthQuotaInfoSnapshotRetry();
      this.clearPendingAuthHydrationRetry();
    }
    this.authQuotaInfoSnapshotOverride = resolveAuthQuotaInfoSnapshotOverride(
      this.authQuotaInfoSnapshotOverride,
      quotaInfoSnapshotOverride,
      userInfo,
      previousUserInfo,
    );

    this.userInfoSubject.next(userInfo);
    this.authSnapshotSubject.next(this.buildAuthSnapshot(userInfo, this.authQuotaInfoSnapshotOverride));
    this.authChangedSubject.next();
  }

  private buildAuthSnapshot(
    userInfo: AuthUserInfo | null,
    quotaInfoSnapshotOverride?: AuthQuotaInfoSnapshot | null,
  ): AuthSnapshot | null {
    if (!userInfo) {
      return null;
    }

    const subscriptionPlan = userInfo.subscription_plan;
    const quota = userInfo.quota;
    const entitlements = userInfo.entitlements;
    const groups = userInfo.groups;
    const quotaInfoSnapshot = quotaInfoSnapshotOverride ?? buildAuthQuotaInfoSnapshot(userInfo);

    const snapshot: AuthSnapshot = {
      ...(subscriptionPlan && typeof subscriptionPlan === 'object' && typeof subscriptionPlan.name === 'string'
        ? { plan: subscriptionPlan.name }
        : {}),
      ...(subscriptionPlan && typeof subscriptionPlan === 'object' && typeof subscriptionPlan.service_tier === 'string'
        ? { serviceTier: subscriptionPlan.service_tier }
        : {}),
      ...(subscriptionPlan && typeof subscriptionPlan === 'object' && typeof subscriptionPlan.status === 'string'
        ? { subscriptionStatus: subscriptionPlan.status }
        : {}),
      ...(subscriptionPlan && typeof subscriptionPlan === 'object' && typeof subscriptionPlan.end_date === 'string'
        ? { subscriptionEndDate: subscriptionPlan.end_date }
        : {}),
      ...(Array.isArray(groups)
        ? { groups: groups.filter((group): group is string => typeof group === 'string' && group.trim().length > 0) }
        : {}),
      ...(quota && typeof quota === 'object'
        && typeof quota.total_token === 'number'
        && typeof quota.used_token === 'number'
        && typeof quota.remaining_token === 'number'
        ? {
            quotaSummary: {
              totalToken: quota.total_token,
              usedToken: quota.used_token,
              remainingToken: quota.remaining_token,
              ...(typeof quota.reset_time === 'string' ? { resetTime: quota.reset_time } : {}),
            },
          }
        : {}),
      ...(quotaInfoSnapshot ? { quotaInfoSnapshot } : {}),
      ...(entitlements && typeof entitlements === 'object'
        ? { entitlements: entitlements as Readonly<Record<string, unknown>> }
        : {}),
    };

    return Object.keys(snapshot).length > 0 ? snapshot : null;
  }

  /**
   * 是否具备功能预览资格
   */
  hasFeaturePreviewAccess(): boolean {
    return this.hasEntitlement('feature-preview:access');
  }

  /**
   * 检查并同步登录状态（供组件调用）
   * 在用户点击用户组件时调用此方法来确保状态同步
   */
  async checkAndSyncAuthStatus(): Promise<boolean> {
    await this.syncLoginStatus();
    return this.isAuthenticated;
  }

  /**
   * 启动 GitHub OAuth 流程
   */
  startGitHubOAuth(inviteCode?: string): Observable<{ authorization_url: string; state: string }> {
    return this.startGitHubOAuthForPurpose('login', inviteCode);
  }

  startGitHubBindOAuth(): Observable<{ authorization_url: string; state: string }> {
    return this.startGitHubOAuthForPurpose('bind');
  }

  startGitHubLibraryPrSubmitOAuth(): Observable<{ authorization_url: string; state: string }> {
    return this.startGitHubOAuthForPurpose('library_pr_submit', undefined, { logErrors: false });
  }

  private startGitHubOAuthForPurpose(
    purpose: GitHubOAuthPurpose,
    inviteCode?: string,
    options: { logErrors?: boolean } = {},
  ): Observable<{ authorization_url: string; state: string }> {
    // 生成并存储 state 参数
    const state = this.generateOAuthState(purpose);

    const requestData: any = {
      redirect_uri: 'abis://auth/callback',
      state: state,
      device_id: 'pc',
      purpose,
    };
    if (inviteCode) {
      requestData.invite_code = inviteCode;
    }

    return this.http.post<CommonResponse>(API.githubBrowserAuthorize, requestData).pipe(
      map(response => {
        if (response.status === 200 && response.data?.authorization_url) {
          // 注册当前实例为OAuth发起者
          if (this.electronService.isElectron && (window as any).electronAPI?.oauth) {
            (window as any).electronAPI.oauth.registerState(state).then((result: any) => {
              // console.log('已注册OAuth状态到实例管理:', result);
            }).catch((error: any) => {
              console.error('注册OAuth状态失败:', error);
            });
          }

          return {
            authorization_url: response.data.authorization_url,
            state: state
          };
        }
        throw response;
      }),
      catchError(error => this.handleError(error, { log: options.logErrors !== false }))
    );
  }

  /**
   * GitHub OAuth 状态管理
   */
  private oauthState: { state: string; timestamp: number; purpose: GitHubOAuthPurpose } | null = null;
  private readonly OAUTH_TIMEOUT = 5 * 60 * 1000; // 5分钟超时

  /**
   * 生成并存储 OAuth state
   */
  generateOAuthState(purpose: GitHubOAuthPurpose = 'login'): string {
    const state = Math.random().toString(36).substring(2) + Date.now().toString(36);
    this.oauthState = { state, timestamp: Date.now(), purpose };

    // 同时保存到文件系统（用于跨实例共享）
    this.saveOAuthStateToFile(state, purpose);

    return state;
  }

  /**
   * 保存 OAuth state 到文件
   */
  private async saveOAuthStateToFile(state: string, purpose: GitHubOAuthPurpose): Promise<void> {
    try {
      if (this.electronService.isElectron && (window as any).electronAPI?.path && (window as any).electronAPI?.fs) {
        // 使用共享的AppData路径（不使用实例隔离的路径）
        const originalAppDataPath = await this.getOriginalAppDataPath();
        const stateFilePath = (window as any).electronAPI.path.join(originalAppDataPath, '.oauth-state');

        const stateData = {
          state,
          timestamp: Date.now(),
          purpose,
        };

        // 确保目录存在
        const stateDir = (window as any).electronAPI.path.dirname(stateFilePath);
        if (!(window as any).electronAPI.fs.existsSync(stateDir)) {
          (window as any).electronAPI.fs.mkdirSync(stateDir, { recursive: true });
        }

        (window as any).electronAPI.fs.writeFileSync(stateFilePath, JSON.stringify(stateData, null, 2));
        // console.log('OAuth state已保存到共享文件:', stateFilePath);
      }
    } catch (error) {
      console.error('保存OAuth状态到文件失败:', error);
    }
  }

  /**
   * 从文件读取 OAuth state
   */
  private async loadOAuthStateFromFile(): Promise<{ state: string; timestamp: number; purpose?: GitHubOAuthPurpose } | null> {
    try {
      if (this.electronService.isElectron && (window as any).electronAPI?.path && (window as any).electronAPI?.fs) {
        const originalAppDataPath = await this.getOriginalAppDataPath();
        const stateFilePath = (window as any).electronAPI.path.join(originalAppDataPath, '.oauth-state');

        if ((window as any).electronAPI.fs.existsSync(stateFilePath)) {
          const content = (window as any).electronAPI.fs.readFileSync(stateFilePath, 'utf8');
          const stateData = JSON.parse(content);
          // console.log('从共享文件加载OAuth状态:', stateData);
          return stateData;
        }
      }
      return null;
    } catch (error) {
      console.error('从文件加载OAuth状态失败:', error);
      return null;
    }
  }

  private async getOAuthPurpose(state: string): Promise<GitHubOAuthPurpose> {
    if (this.oauthState?.state === state) {
      return this.oauthState.purpose || 'login';
    }

    const fileState = await this.loadOAuthStateFromFile();
    if (fileState?.state === state && (fileState.purpose === 'bind' || fileState.purpose === 'login' || fileState.purpose === 'library_pr_submit')) {
      return fileState.purpose;
    }

    return 'login';
  }

  /**
   * 获取原始AppData路径（非实例隔离）
   */
  private async getOriginalAppDataPath(): Promise<string> {
    try {
      const currentAppDataPath = (window as any).electronAPI.path.getAppDataPath();

      // 检查是否是实例隔离的路径 (包含 /instances/ 的路径)
      const instancesMatch = currentAppDataPath.match(/(.*)[/\\]instances[/\\][^/\\]+$/);
      if (instancesMatch) {
        return instancesMatch[1]; // 返回原始路径
      }

      // 如果不是实例隔离路径，直接返回
      return currentAppDataPath;
    } catch (error) {
      console.error('获取原始AppData路径失败:', error);
      return (window as any).electronAPI.path.getAppDataPath();
    }
  }

  /**
   * 验证 OAuth state
   */
  async validateOAuthState(state: string): Promise<boolean> {
    // 首先检查内存中的状态（同实例验证）
    if (this.oauthState && this.oauthState.state === state) {
      // 检查超时
      if (Date.now() - this.oauthState.timestamp <= this.OAUTH_TIMEOUT) {
        // console.log('OAuth状态验证通过（内存）');
        return true;
      }
    }

    // 如果内存中没有，尝试从文件加载（跨实例验证）
    const fileState = await this.loadOAuthStateFromFile();
    if (fileState && fileState.state === state) {
      // 检查超时
      if (Date.now() - fileState.timestamp <= this.OAUTH_TIMEOUT) {
        // console.log('OAuth状态验证通过（文件）');
        return true;
      } else {
        // console.log('OAuth状态已超时');
        this.clearOAuthStateFile();
      }
    } else {
      // console.log('OAuth状态验证失败:', {
      //   inputState: state,
      //   memoryState: this.oauthState?.state,
      //   fileState: fileState?.state
      // });
    }

    return false;
  }

  /**
   * 清理 OAuth state
   */
  clearOAuthState(): void {
    this.oauthState = null;
    this.clearOAuthStateFile();
  }

  /**
   * 清理 OAuth state 文件
   */
  private async clearOAuthStateFile(): Promise<void> {
    try {
      if (this.electronService.isElectron && (window as any).electronAPI?.path && (window as any).electronAPI?.fs) {
        const originalAppDataPath = await this.getOriginalAppDataPath();
        const stateFilePath = (window as any).electronAPI.path.join(originalAppDataPath, '.oauth-state');

        if ((window as any).electronAPI.fs.existsSync(stateFilePath)) {
          (window as any).electronAPI.fs.unlinkSync(stateFilePath);
          // console.log('已清理OAuth状态共享文件:', stateFilePath);
        }
      }
    } catch (error) {
      console.error('清理OAuth状态文件失败:', error);
    }
  }

  /**
   * GitHub Token 交换
   */
  exchangeGitHubToken(code: string, state: string, inviteCode?: string): Observable<any> {
    const requestData: any = {
      code: code,
      state: state,
      device_id: 'pc'
    };
    if (inviteCode) {
      requestData.invite_code = inviteCode;
    }

    return this.http.post<CommonResponse>(API.githubTokenExchange, requestData).pipe(
      map(response => {
        if (response.status === 200 && response.data) {
          return response.data;
        }
        throw response;
      }),
      catchError(error => this.handleError(error))
    );
  }

  bindGitHubAccount(code: string, state: string, purpose?: GitHubOAuthPurpose): Observable<any> {
    return this.http.post<CommonResponse>(API.githubBind, {
      code,
      state,
      device_id: 'pc',
      client_type: 'electron',
      purpose,
    }).pipe(
      map(response => {
        if (response.status === 200) {
          return response.data || {};
        }
        throw response;
      }),
      catchError(error => this.handleError(error, { log: purpose !== 'library_pr_submit' }))
    );
  }

  /**
   * 处理协议回调
   */
  async handleOAuthCallback(callbackData: {
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  }): Promise<{ success: boolean; data?: any; error?: string; message?: string; errorCode?: string | null; errorArgs?: Record<string, unknown>; purpose?: GitHubOAuthPurpose }> {
    try {
      // 检查是否有错误
      if (callbackData.error) {
        this.clearOAuthState();
        return {
          success: false,
          error: callbackData.error,
          message: callbackData.error_description || '授权失败'
        };
      }

      // 检查必需参数
      if (!callbackData.code || !callbackData.state) {
        this.clearOAuthState();
        return {
          success: false,
          error: 'missing_parameters',
          message: '缺少必需的参数'
        };
      }

      // 验证 state
      const isValidState = await this.validateOAuthState(callbackData.state);
      if (!isValidState) {
        return {
          success: false,
          error: 'invalid_state',
          message: '无效的状态参数或请求已超时'
        };
      }

      const purpose = await this.getOAuthPurpose(callbackData.state);

      if (purpose === 'bind' || purpose === 'library_pr_submit') {
        const bindData = await this.bindGitHubAccount(callbackData.code, callbackData.state, purpose).toPromise();
        this.clearOAuthState();
        const user = this.markGithubBoundLocally(bindData, purpose);
        this.githubBindCompletedSubject.next(user);
        this.refreshCurrentUser().then(refreshedUser => {
          if (refreshedUser && !this.hasGithubBinding(refreshedUser)) {
            this.githubBindCompletedSubject.next(this.markGithubBoundLocally(refreshedUser));
          }
        }).catch(error => {
          console.error('刷新 GitHub 绑定用户信息失败:', error);
        });
        return {
          success: true,
          data: bindData,
          purpose,
        };
      }

      // 交换 token
      const tokenData = await this.exchangeGitHubToken(callbackData.code, callbackData.state).toPromise();

      // 清理状态
      this.clearOAuthState();

      // 检查是否需要绑定微信
      if (tokenData?.status === 'needs_wechat_bind') {
        const authError = extractApiErrorDetails(tokenData, '请先绑定微信后再继续登录');
        return {
          success: false,
          error: 'needs_wechat_bind',
          data: tokenData,
          message: authError.message,
          errorCode: authError.errorCode,
          errorArgs: authError.errorArgs,
        };
      }

      // 处理成功结果
      await this.handleGitHubOAuthSuccess(tokenData);

      return {
        success: true,
        data: tokenData,
        purpose: 'login',
      };

    } catch (error) {
      const authError = extractApiErrorDetails(error, '处理回调失败');
      this.clearOAuthState();
      return {
        success: false,
        error: 'callback_processing_failed',
        message: authError.message,
        errorCode: authError.errorCode,
        errorArgs: authError.errorArgs,
      };
    }
  }

  private markGithubBoundLocally(source?: any, purpose?: GitHubOAuthPurpose): any {
    const sourceUser = source?.user && typeof source.user === 'object' && !Array.isArray(source.user)
      ? source.user
      : source;
    const currentUser: any = this.currentUser || {};
    const sourceGithub = sourceUser?.github && typeof sourceUser.github === 'object' && !Array.isArray(sourceUser.github)
      ? sourceUser.github
      : {};
    const currentGithub = currentUser?.github && typeof currentUser.github === 'object' && !Array.isArray(currentUser.github)
      ? currentUser.github
      : {};
    const prSubmissionGithub = purpose === 'library_pr_submit'
      ? {
        pr_submission_enabled: true,
        scopes: Array.from(new Set([
          ...this.normalizeGithubScopes(currentGithub.scopes),
          ...this.normalizeGithubScopes(sourceGithub.scopes),
          'repo',
        ])),
      }
      : {};
    const nextUser = {
      ...currentUser,
      ...(sourceUser && typeof sourceUser === 'object' && !Array.isArray(sourceUser) ? sourceUser : {}),
      github: {
        ...currentGithub,
        ...sourceGithub,
        ...prSubmissionGithub,
        bound: true,
      },
    };
    this.setCurrentUserInfo(nextUser);
    return nextUser;
  }

  /**
   * GitHub OAuth 登录成功处理
   */
  async handleGitHubOAuthSuccess(data: { access_token: string; refresh_token?: string; user?: any }): Promise<void> {
    try {
      await this.saveToken2(data.access_token);
      if (data.refresh_token) {
        await this.saveRefreshToken(data.refresh_token);
      }
      await this.handleSuccessfulTokenAcquisition(data.access_token, data.user as AuthUserInfo | undefined);
    } catch (error) {
      console.error('处理 GitHub OAuth 成功数据失败:', error);
      throw error;
    }
  }

  // ==================== 微信登录 Mock ====================
  private wechatMockCallCount = new Map<string, number>();

  private getWechatMockScenario(): 'confirmed' | 'needs_email_bind' | 'email_merge_confirm' | 'login_bind_merge_confirm' | null {
    const scenario = sessionStorage.getItem('wechat_login_mock_scenario');
    if (scenario === 'confirmed' || scenario === 'needs_email_bind' || scenario === 'email_merge_confirm' || scenario === 'login_bind_merge_confirm') {
      return scenario as any;
    }
    return null;
  }

  /**
   * 获取微信扫码二维码
   */
  getWeChatQrcode(inviteCode?: string): Observable<CommonResponse & { data: { ticket: string; qrcode_url: string; expires_in: number } }> {
    const mock = this.getWechatMockScenario();
    if (mock) {
      const ticket = `mock_ticket_${Date.now()}`;
      this.wechatMockCallCount.set(ticket, 0);
      return new Observable(observer => {
        setTimeout(() => {
          observer.next({
            status: 200,
            message: 'mock',
            data: {
              ticket,
              qrcode_url: `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent('mock:' + ticket)}`,
              expires_in: 300,
            },
          } as any);
          observer.complete();
        }, 400);
      });
    }
    const params: any = {};
    if (inviteCode) {
      params.invite_code = inviteCode;
    }
    return this.http.get<CommonResponse & { data: { ticket: string; qrcode_url: string; expires_in: number } }>(API.wechatQrcode, { params }).pipe(
      catchError(error => this.handleError(error))
    );
  }

  /**
   * 检查微信扫码状态
   */
  checkWeChatStatus(ticket: string): Observable<CommonResponse & { data: { status: string; access_token?: string; refresh_token?: string; token_type?: string; is_new_user?: boolean; user?: any; message?: string } }> {
    const mock = this.getWechatMockScenario();
    if (mock && ticket.startsWith('mock_ticket_')) {
      const count = this.wechatMockCallCount.get(ticket) || 0;
      this.wechatMockCallCount.set(ticket, count + 1);

      let data: any;
      if (count < 2) {
        data = { status: 'pending', message: '等待扫码' };
      } else if (count < 4) {
        data = { status: 'scanned', message: '已扫码，请在手机上确认' };
      } else if (mock === 'needs_email_bind' || mock === 'email_merge_confirm') {
        data = { status: 'needs_email_bind', message: '当前微信需要补全邮箱后继续登录。' };
        this.wechatMockCallCount.delete(ticket);
      } else {
        data = {
          status: 'confirmed',
          access_token: `mock_access_${Date.now()}`,
          refresh_token: `mock_refresh_${Date.now()}`,
          token_type: 'bearer',
          is_new_user: false,
          user: { id: 'mock_user', email: 'mock@example.com', nickname: 'Mock用户', groups: ['basic'] },
        };
        this.wechatMockCallCount.delete(ticket);
      }

      return new Observable(observer => {
        setTimeout(() => {
          observer.next({ status: 200, message: 'mock', data } as any);
          observer.complete();
        }, 300);
      });
    }

    return this.http.get<CommonResponse & { data: { status: string; access_token?: string; refresh_token?: string; token_type?: string; is_new_user?: boolean; user?: any; message?: string } }>(
      API.wechatCheck,
      { params: { ticket } }
    ).pipe(
      catchError(error => this.handleError(error))
    );
  }

  /**
   * 微信扫码登录成功处理
   */
  async handleWeChatOAuthSuccess(data: { access_token: string; refresh_token?: string; user?: any }): Promise<void> {
    try {
      await this.saveToken2(data.access_token);
      if (data.refresh_token) {
        await this.saveRefreshToken(data.refresh_token);
      }
      await this.handleSuccessfulTokenAcquisition(data.access_token, data.user as AuthUserInfo | undefined);
    } catch (error) {
      console.error('处理微信 OAuth 成功数据失败:', error);
      throw error;
    }
  }

  /**
   * 获取登录绑定微信的二维码
   */
  getWeChatLoginBindQrcode(pendingTicket: string): Observable<CommonResponse & { data: { ticket: string; qrcode_url: string; expires_in: number } }> {
    if (this.getWechatMockScenario() === 'login_bind_merge_confirm') {
      const ticket = `mock_ticket_lb_${Date.now()}`;
      this.wechatMockCallCount.set(ticket, 0);
      return new Observable(observer => {
        setTimeout(() => {
          observer.next({
            status: 200,
            message: 'mock',
            data: {
              ticket,
              qrcode_url: `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent('mock-lb:' + ticket)}`,
              expires_in: 300,
            },
          } as any);
          observer.complete();
        }, 400);
      });
    }
    return this.http.get<CommonResponse & { data: { ticket: string; qrcode_url: string; expires_in: number } }>(
      API.wechatLoginBindQrcode,
      { params: { pending_ticket: pendingTicket }, headers: { 'X-Supports-Merge-Confirm': 'true' } }
    ).pipe(
      catchError(error => this.handleError(error))
    );
  }

  /**
   * 检查登录绑定微信的状态
   */
  checkWeChatLoginBindStatus(ticket: string): Observable<CommonResponse & { data: { status: string; access_token?: string; refresh_token?: string; token_type?: string; is_new_user?: boolean; user?: any; message?: string; merge_info?: any } }> {
    if (this.getWechatMockScenario() === 'login_bind_merge_confirm' && ticket.startsWith('mock_ticket_lb_')) {
      const count = this.wechatMockCallCount.get(ticket) || 0;
      this.wechatMockCallCount.set(ticket, count + 1);

      let data: any;
      if (count < 2) {
        data = { status: 'pending', message: '等待扫码' };
      } else if (count < 4) {
        data = { status: 'scanned', message: '已扫码，正在处理...' };
      } else {
        data = {
          status: 'needs_merge_confirm',
          message: '该微信已关联其他账号，是否将微信合并到当前邮箱账号？',
          merge_info: {
            wechat_user_id: 'mock_wechat_user_id',
            wechat_nickname: 'Mock微信用户',
            email_user_id: 'mock_email_user_id',
            email: 'existing@example.com',
            provider_id: 'mock_provider_id',
          },
        };
        this.wechatMockCallCount.delete(ticket);
      }
      return new Observable(observer => {
        setTimeout(() => {
          observer.next({ status: 200, message: 'mock', data } as any);
          observer.complete();
        }, 300);
      });
    }
    return this.http.get<CommonResponse & { data: { status: string; access_token?: string; refresh_token?: string; token_type?: string; is_new_user?: boolean; user?: any; message?: string } }>(
      API.wechatLoginBindCheck,
      { params: { ticket }, headers: { 'X-Supports-Merge-Confirm': 'true' } }
    ).pipe(
      catchError(error => this.handleError(error))
    );
  }

  /**
   * 微信登录后补全邮箱绑定
   */
  completeWechatEmailBindLogin(ticket: string, email: string, code: string, invite_code?: string, confirm_merge?: boolean): Observable<CommonResponse & { data: { access_token: string; refresh_token?: string; token_type?: string; is_new_user?: boolean; user?: any } }> {
    const mock = this.getWechatMockScenario();
    // Mock 模式
    if (mock && ticket.startsWith('mock_ticket_')) {
      // email_merge_confirm 场景：首次返回 needs_merge_confirm，confirm 后返回成功
      if (mock === 'email_merge_confirm' && !confirm_merge) {
        return new Observable(observer => {
          setTimeout(() => {
            observer.next({
              status: 200,
              message: 'mock',
              data: {
                status: 'needs_merge_confirm',
                merge_info: {
                  wechat_user_id: 'mock_wechat_user_id',
                  wechat_nickname: 'Mock微信用户',
                  email_user_id: 'mock_email_user_id',
                  email: email || 'existing@example.com',
                  provider_id: 'mock_provider_id',
                },
              },
            } as any);
            observer.complete();
          }, 300);
        });
      }
      return new Observable(observer => {
        setTimeout(() => {
          observer.next({
            status: 200,
            message: 'mock',
            data: {
              access_token: `mock_access_${Date.now()}`,
              refresh_token: `mock_refresh_${Date.now()}`,
              token_type: 'bearer',
              is_new_user: false,
              user: { id: 'mock_user', email, nickname: email.split('@')[0] || 'Mock用户', groups: ['basic'] },
            },
          } as any);
          observer.complete();
        }, 300);
      });
    }

    const body: any = { ticket, email, code };
    if (invite_code) {
      body.invite_code = invite_code;
    }
    if (confirm_merge) {
      body.confirm_merge = confirm_merge;
    }
    return this.http.post<CommonResponse & { data: { access_token: string; refresh_token?: string; token_type?: string; is_new_user?: boolean; user?: any } }>(
      API.wechatCompleteEmailBind,
      body,
      { headers: { 'X-Supports-Merge-Confirm': 'true' } }
    ).pipe(
      catchError(error => this.handleError(error))
    );
  }

  /**
   * 确认微信账号合并
   */
  confirmWechatMerge(ticket: string, flow: 'login_bind' | 'bind'): Observable<CommonResponse & { data: any }> {
    if (this.getWechatMockScenario() && ticket.startsWith('mock_ticket_')) {
      return new Observable(observer => {
        setTimeout(() => {
          observer.next({
            status: 200,
            message: 'mock',
            data: {
              access_token: `mock_access_merged_${Date.now()}`,
              refresh_token: `mock_refresh_merged_${Date.now()}`,
              token_type: 'bearer',
              is_new_user: false,
              user: { id: 'mock_merged_user', email: 'existing@example.com', nickname: 'Mock合并用户', groups: ['basic'] },
            },
          } as any);
          observer.complete();
        }, 500);
      });
    }
    return this.http.post<CommonResponse & { data: any }>(
      API.wechatConfirmMerge,
      { ticket, flow }
    ).pipe(
      catchError(error => this.handleError(error))
    );
  }

  /**
   * 生成 SSO Token（用于桌面端跳转 Web 端免登）
   * @param targetUrl 可选，目标跳转 URL
   * @returns Observable<SSOTokenResponse>
   */
  generateSSOToken(targetUrl?: string): Observable<SSOTokenResponse> {
    return from(this.getToken2()).pipe(
      switchMap(token => {
        if (!token) {
          return throwError(() => new Error('用户未登录'));
        }

        const requestBody: any = {
          target_type: 'console',
        };
        if (targetUrl) {
          requestBody.target_url = targetUrl;
        }

        return this.http.post<CommonResponse>(API.ssoGenerate, requestBody, {
          headers: { Authorization: `Bearer ${token}` }
        }).pipe(
          map((response) => {
            if (response.status === 200 && response.data) {
              return {
                sso_token: response.data.sso_token,
                expires_in: response.data.expires_in,
                target_url: response.data.target_url
              };
            }
            throw response;
          }),
          catchError((error) => {
            console.error('生成 SSO Token 失败:', error);
            return throwError(() => error);
          })
        );
      })
    );
  }

  /**
   * 服务销毁时的清理工作
   */
  destroy(): void {
    // 不再需要文件监听的清理工作
  }

  /**
   * 错误处理
   */
  private handleError(error: any, options: AuthHandleErrorOptions = {}): Observable<never> {
    const apiError = createApiError(error, '认证服务错误');
    if (options.log !== false) {
      const codeSuffix = apiError.errorCode ? ` (${apiError.errorCode})` : '';
      console.error(`认证服务错误: ${apiError.message}${codeSuffix}`, error);
    }
    return throwError(() => apiError);
  }
}

export function normalizeAuthQuotaInfoSnapshotPayload(
  value: unknown,
  options?: {
    source?: 'auth-me' | 'token';
    fallbackQuotaResetDate?: string;
    fallbackQuota?: NonNullable<AuthUserInfo['quota']>;
  },
): AuthQuotaInfoSnapshot | undefined {
  const detailRecord = isRecord(value) ? value : undefined;
  const normalizedQuotaSnapshots = normalizeAuthQuotaSnapshots(
    detailRecord?.['quota_snapshots'] ?? detailRecord?.['quotaSnapshots'],
  );
  const fallbackQuotaSnapshots = normalizedQuotaSnapshots
    ?? (options?.fallbackQuota ? buildFallbackQuotaSnapshots(options.fallbackQuota) : undefined);
  const limitedUserQuotas = normalizeNumericRecord(
    detailRecord?.['limited_user_quotas'] ?? detailRecord?.['limitedUserQuotas'],
  );
  const quotaResetDate = typeof detailRecord?.['quota_reset_date'] === 'string'
    ? detailRecord['quota_reset_date']
    : typeof detailRecord?.['quotaResetDate'] === 'string'
      ? detailRecord['quotaResetDate']
      : options?.fallbackQuotaResetDate;
  const source = detailRecord?.['source'] === 'auth-me' || detailRecord?.['source'] === 'token'
    ? detailRecord['source']
    : options?.source ?? 'auth-me';

  if (!fallbackQuotaSnapshots && !limitedUserQuotas && !quotaResetDate) {
    return undefined;
  }

  return {
    source,
    ...(quotaResetDate ? { quotaResetDate } : {}),
    ...(fallbackQuotaSnapshots ? { quotaSnapshots: fallbackQuotaSnapshots } : {}),
    ...(limitedUserQuotas ? { limitedUserQuotas } : {}),
  };
}

export function resolveAuthQuotaInfoSnapshotOverride(
  currentOverride: AuthQuotaInfoSnapshot | null,
  nextOverride: AuthQuotaInfoSnapshot | null | undefined,
  userInfo: AuthUserInfo | null,
  previousUserInfo?: AuthUserInfo | null,
): AuthQuotaInfoSnapshot | null {
  if (!userInfo) {
    return null;
  }

  if (nextOverride === undefined) {
    return isSameAuthUser(previousUserInfo, userInfo)
      ? currentOverride
      : null;
  }

  if (nextOverride) {
    return nextOverride;
  }

  return currentOverride?.source === 'token' && isSameAuthUser(previousUserInfo, userInfo)
    ? currentOverride
    : null;
}

function isSameAuthUser(
  previousUserInfo: AuthUserInfo | null | undefined,
  nextUserInfo: AuthUserInfo | null | undefined,
): boolean {
  const previousIdentity = readAuthUserIdentity(previousUserInfo);
  const nextIdentity = readAuthUserIdentity(nextUserInfo);

  return !previousIdentity || !nextIdentity || previousIdentity === nextIdentity;
}

function readAuthUserIdentity(userInfo: AuthUserInfo | null | undefined): string | null {
  if (!userInfo || typeof userInfo !== 'object') {
    return null;
  }

  if (typeof userInfo.id === 'string' && userInfo.id.trim().length > 0) {
    return `id:${userInfo.id}`;
  }

  if (typeof userInfo.email === 'string' && userInfo.email.trim().length > 0) {
    return `email:${userInfo.email}`;
  }

  if (typeof userInfo.login === 'string' && userInfo.login.trim().length > 0) {
    return `login:${userInfo.login}`;
  }

  if (typeof userInfo.phone === 'string' && userInfo.phone.trim().length > 0) {
    return `phone:${userInfo.phone}`;
  }

  return null;
}

function buildAuthQuotaInfoSnapshot(userInfo: AuthUserInfo): AuthQuotaInfoSnapshot | undefined {
  const quota = userInfo.quota;
  if (!quota || typeof quota !== 'object') {
    return undefined;
  }

  const normalized = normalizeAuthQuotaInfoSnapshotPayload(quota.details, {
    source: 'auth-me',
    fallbackQuotaResetDate: typeof quota.reset_time === 'string' ? quota.reset_time : undefined,
  });

  return normalized?.quotaSnapshots || normalized?.limitedUserQuotas
    ? normalized
    : undefined;
}

function buildFallbackQuotaSnapshots(
  quota: NonNullable<AuthUserInfo['quota']>,
): Readonly<Record<string, AuthQuotaInfoSnapshotItem>> | undefined {
  if (
    typeof quota.total_token !== 'number'
    || typeof quota.remaining_token !== 'number'
  ) {
    return undefined;
  }

  const percentRemaining = typeof quota.total_token === 'number' && quota.total_token > 0
    ? Math.max(0, Math.min(100, (quota.remaining_token / quota.total_token) * 100))
    : 0;

  return {
    chat: {
      entitlement: quota.total_token,
      remaining: quota.remaining_token,
      percentRemaining,
      ...(quota.total_token < 0 ? { unlimited: true } : {}),
      ...(typeof quota.reset_time === 'string' ? { resetDate: quota.reset_time } : {}),
    },
  };
}

function normalizeAuthQuotaSnapshots(
  value: unknown,
): Readonly<Record<string, AuthQuotaInfoSnapshotItem>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .map(([key, rawSnapshot]) => {
      if (!isRecord(rawSnapshot)) {
        return undefined;
      }

      const entitlement = readNumber(rawSnapshot['entitlement']);
      const remaining = readNumber(rawSnapshot['remaining']);
      const percentRemaining = readNumber(rawSnapshot['percent_remaining']) ?? readNumber(rawSnapshot['percentRemaining']);
      if (entitlement === undefined || remaining === undefined || percentRemaining === undefined) {
        return undefined;
      }

      return [key, {
        entitlement,
        remaining,
        percentRemaining,
        ...(typeof rawSnapshot['unlimited'] === 'boolean' ? { unlimited: rawSnapshot['unlimited'] } : {}),
        ...(readNumber(rawSnapshot['overage_count']) !== undefined
          ? { overageCount: readNumber(rawSnapshot['overage_count']) }
          : readNumber(rawSnapshot['overageCount']) !== undefined
            ? { overageCount: readNumber(rawSnapshot['overageCount']) }
            : {}),
        ...(typeof rawSnapshot['overage_permitted'] === 'boolean'
          ? { overagePermitted: rawSnapshot['overage_permitted'] }
          : typeof rawSnapshot['overagePermitted'] === 'boolean'
            ? { overagePermitted: rawSnapshot['overagePermitted'] }
            : {}),
        ...(typeof rawSnapshot['reset_date'] === 'string'
          ? { resetDate: rawSnapshot['reset_date'] }
          : typeof rawSnapshot['resetDate'] === 'string'
            ? { resetDate: rawSnapshot['resetDate'] }
            : typeof rawSnapshot['resetAt'] === 'string'
              ? { resetDate: rawSnapshot['resetAt'] }
              : {}),
      } satisfies AuthQuotaInfoSnapshotItem] as const;
    })
    .filter((entry): entry is readonly [string, AuthQuotaInfoSnapshotItem] => !!entry);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeNumericRecord(
  value: unknown,
): Readonly<Record<string, number>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .map(([key, rawValue]) => {
      const numberValue = readNumber(rawValue);
      return typeof numberValue === 'number' ? [key, numberValue] as const : undefined;
    })
    .filter((entry): entry is readonly [string, number] => !!entry);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isAuthCredentialError(error: unknown): boolean {
  const status = isRecord(error) ? readNumber(error['status']) : undefined;
  return status === 401 || status === 403;
}
