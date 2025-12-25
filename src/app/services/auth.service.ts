import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { API } from '../configs/api.config';
import { ElectronService } from './electron.service';

export interface CommonResponse {
  status: number;
  message: string;
  data?: any;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  status: number;
  message: string;
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

export interface RegisterRequest {
  username: string;
  password: string;
  email: string;
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

  // 用户登录状态
  private isLoggedInSubject = new BehaviorSubject<boolean>(false);
  public isLoggedIn$ = this.isLoggedInSubject.asObservable();

  // 用户信息
  private userInfoSubject = new BehaviorSubject<any>(null);
  public userInfo$ = this.userInfoSubject.asObservable();

  // 登录弹窗显示状态
  showUser = new BehaviorSubject<any>(null);

  constructor() {
    // 不在构造函数中立即初始化，等待ElectronService初始化完成
  }

  /**
   * 初始化认证状态 - 需要在ElectronService初始化后调用
   */
  async initializeAuth(): Promise<void> {
    try {
      const token = await this.getToken2();
      // const userInfo = await this.getUserInfo();

      // console.log('初始化认证状态:', { token });

      if (token) {
        // 延迟执行避免循环依赖
        setTimeout(() => {
          this.getMe(token).then(userInfo => {
            // console.log('获取用户信息:', userInfo);
            if (userInfo) {
              this.userInfoSubject.next(userInfo);
              this.isLoggedInSubject.next(true);
            } else {
              this.isLoggedInSubject.next(false);
            }

            // console.log('认证状态:', this.isLoggedInSubject.value);
          }).catch(error => {
            this.isLoggedInSubject.next(false);
          });
        }, 0);
        // 验证 token 是否有效
        // const isValid = await this.verifyToken(token);
        // if (isValid) {
        //   this.isLoggedInSubject.next(true);
        //   this.userInfoSubject.next(userInfo);
        // } else {
        //   await this.clearAuthData();
        // }
      }
    } catch (error) {
      await this.clearAuthData();
    }
  }

  /**
   * 用户登录
   */
  login(loginData: LoginRequest): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(API.login, loginData).pipe(
      map((response) => {
        // console.log("登录响应: ", response);
        if (response.status === 200 && response.data) {
          // console.log("登录成功，token: ", response.data.access_token);
          // 保存 token 和用户信息
          this.saveToken2(response.data.access_token);
          this.getMe(response.data.access_token);
          // if (response.data.user) {
          //   this.saveUserInfo(response.data.user);
          //   this.userInfoSubject.next(response.data.user);
          // }
          this.isLoggedInSubject.next(true);
        } else {
          this.isLoggedInSubject.next(false);
        }
        return response;
      }),
      catchError(this.handleError)
    );
  }

  /**
   * 用户注册
   */
  register(registerData: RegisterRequest): Observable<any> {
    return this.http.post(API.register, registerData).pipe(
      catchError(this.handleError)
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
  private getMe(token: string): Promise<any> {
    return new Promise((resolve, reject) => {
      this.http.get<CommonResponse>(API.me, {
        headers: { Authorization: `Bearer ${token}` }
      }).subscribe({
        next: (response) => {
          if (response.status === 200 && response.data) {
            this.userInfoSubject.next(response.data);
            resolve(response.data);
          } else {
            console.warn('获取用户信息失败:', response);
            reject(null);
          }
        },
        error: (error) => reject(error)
      });
    });
  }

  async refreshMe() {
    return this.http.get<CommonResponse>(API.me).subscribe( (res) => {
      if (res.status === 200 && res.data) {
        this.userInfoSubject.next(res.data);
      };
    });
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
                this.userInfoSubject.next(userInfo);
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
            console.warn('token加密失败，使用明文存储:', error);
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
          console.warn('认证文件不存在:', authFilePath);
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
      console.error('获取token失败:', error);
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
   * 保存刷新 token
   */
  private async saveRefreshToken(refreshToken: string): Promise<void> {
    try {
      if (this.electronService.isElectron && (window as any).electronAPI?.safeStorage) {
        const encrypted = (window as any).electronAPI.safeStorage.encryptString(refreshToken);
        localStorage.setItem(this.REFRESH_TOKEN_KEY, encrypted.toString('base64'));
      } else {
        localStorage.setItem(this.REFRESH_TOKEN_KEY, refreshToken);
      }
    } catch (error) {
      console.error('保存刷新 token 失败:', error);
    }
  }

  /**
   * 获取刷新 token
   */
  private async getRefreshToken(): Promise<string | null> {
    try {
      const storedData = localStorage.getItem(this.REFRESH_TOKEN_KEY);
      if (!storedData) return null;

      if (this.electronService.isElectron && (window as any).electronAPI?.safeStorage) {
        try {
          const buffer = Buffer.from(storedData, 'base64');
          return (window as any).electronAPI.safeStorage.decryptString(buffer);
        } catch (error) {
          console.error('刷新 token 解密失败:', error);
          localStorage.removeItem(this.REFRESH_TOKEN_KEY);
          return null;
        }
      } else {
        return storedData;
      }
    } catch (error) {
      console.error('获取刷新 token 失败:', error);
      return null;
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
      console.log('保存用户信息失败:', error);
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
   * 刷新 token
   */
  async refreshAuthToken(): Promise<boolean> {
    try {
      const refreshToken = await this.getRefreshToken();
      if (!refreshToken) return false;

      const response = await this.http.post<CommonResponse>(
        API.refreshToken,
        { refreshToken }
      ).toPromise();

      if (response?.data?.token) {
        await this.saveToken2(response.data.token);
        if (response.data.refreshToken) {
          await this.saveRefreshToken(response.data.refreshToken);
        }
        return true;
      }
      return false;
    } catch (error) {
      console.error('刷新 token 失败:', error);
      return false;
    }
  }

  /**
   * 清除所有认证数据
   */
  private async clearAuthData(): Promise<void> {
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.REFRESH_TOKEN_KEY);
    localStorage.removeItem(this.USER_INFO_KEY);
    this.clearAuthDataFile();
    this.isLoggedInSubject.next(false);
    this.userInfoSubject.next(null);
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
  get currentUser(): any {
    return this.userInfoSubject.value;
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
  startGitHubOAuth(): Observable<{ authorization_url: string; state: string }> {
    // 生成并存储 state 参数
    const state = this.generateOAuthState();
    
    const requestData = {
      redirect_uri: 'ailyblockly://auth/callback',
      state: state
    };

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
        throw new Error(response.message || '获取授权URL失败');
      }),
      catchError(this.handleError)
    );
  }

  /**
   * GitHub OAuth 状态管理
   */
  private oauthState: { state: string; timestamp: number } | null = null;
  private readonly OAUTH_TIMEOUT = 5 * 60 * 1000; // 5分钟超时

  /**
   * 生成并存储 OAuth state
   */
  generateOAuthState(): string {
    const state = Math.random().toString(36).substring(2) + Date.now().toString(36);
    this.oauthState = { state, timestamp: Date.now() };
    
    // 同时保存到文件系统（用于跨实例共享）
    this.saveOAuthStateToFile(state);
    
    return state;
  }

  /**
   * 保存 OAuth state 到文件
   */
  private async saveOAuthStateToFile(state: string): Promise<void> {
    try {
      if (this.electronService.isElectron && (window as any).electronAPI?.path && (window as any).electronAPI?.fs) {
        // 使用共享的AppData路径（不使用实例隔离的路径）
        const originalAppDataPath = await this.getOriginalAppDataPath();
        const stateFilePath = (window as any).electronAPI.path.join(originalAppDataPath, '.oauth-state');
        
        const stateData = {
          state,
          timestamp: Date.now()
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
  private async loadOAuthStateFromFile(): Promise<{ state: string; timestamp: number } | null> {
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
  exchangeGitHubToken(code: string, state: string): Observable<any> {
    const requestData = {
      code: code,
      state: state
    };

    return this.http.post<CommonResponse>(API.githubTokenExchange, requestData).pipe(
      map(response => {
        if (response.status === 200 && response.data) {
          return response.data;
        }
        throw new Error(response.message || '网络超时，请重试');
      }),
      catchError(this.handleError)
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
  }): Promise<{ success: boolean; data?: any; error?: string; message?: string }> {
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

      // 交换 token
      const tokenData = await this.exchangeGitHubToken(callbackData.code, callbackData.state).toPromise();
      
      // 清理状态
      this.clearOAuthState();

      // 处理成功结果
      await this.handleGitHubOAuthSuccess(tokenData);

      return {
        success: true,
        data: tokenData
      };

    } catch (error) {
      this.clearOAuthState();
      return {
        success: false,
        error: 'callback_processing_failed',
        message: error instanceof Error ? error.message : '处理回调失败'
      };
    }
  }

  /**
   * GitHub OAuth 登录成功处理
   */
  async handleGitHubOAuthSuccess(data: { access_token: string; user?: any }): Promise<void> {
    try {
      await this.saveToken2(data.access_token);
      if (data.user) {
        await this.saveUserInfo(data.user);
        this.userInfoSubject.next(data.user);
      }
      this.isLoggedInSubject.next(true);
    } catch (error) {
      console.error('处理 GitHub OAuth 成功数据失败:', error);
      throw error;
    }
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
  private handleError(error: any): Observable<never> {
    console.error('认证服务错误:', error);
    return throwError(() => error);
  }
}
