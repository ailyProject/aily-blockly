import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { version as packageVersion } from '../../../../../package.json';

export interface RendererLifecycleEvent {
  readonly kind: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';
  readonly generation: number;
}

export interface UserInteractionNotificationPayload {
  readonly key?: string;
  readonly title?: string;
  readonly body?: string;
}

export interface UserInteractionNotificationResult extends Record<string, unknown> {
  readonly ok: boolean;
  readonly notified: boolean;
  readonly reason?: 'foreground' | 'empty-body';
  readonly key?: string;
}

@Injectable({
  providedIn: 'root',
})
export class ElectronService {
  isElectron = false;
  electron: any = window['electronAPI'];
  private runtimeApplicationVersion = packageVersion;
  private readonly rendererGenerationSubject = new BehaviorSubject<number>(0);
  private readonly rendererLifecycleSubject = new Subject<RendererLifecycleEvent>();
  private rendererLifecycleListenersRegistered = false;
  private rendererSuspended = false;
  private rendererScreenLocked = false;

  readonly rendererGeneration$ = this.rendererGenerationSubject.asObservable();
  readonly rendererLifecycle$ = this.rendererLifecycleSubject.asObservable();

  constructor() { }

  async init() {
    if (this.electron && typeof this.electron.versions() == 'object') {
      console.log('Running in electron', this.electron.versions());
      this.isElectron = true;
      // 在这里把 相关nodejs内容 挂载到 window 上
      // 调用前先判断isElectron
      for (let key in this.electron) {
        // console.log('load ' + key);
        window[key] = this.electron[key];
      }
      try {
        const appVersion = await this.electron.ipcRenderer?.invoke?.('get-app-version');
        if (typeof appVersion === 'string' && appVersion.trim()) {
          this.runtimeApplicationVersion = appVersion.trim();
        }
      } catch (error) {
        console.warn('Unable to read packaged application version:', error);
      }
      this.registerRendererLifecycleListeners();
    } else {
      console.log('Running in browser');
    }
  }

  get applicationVersion(): string {
    return this.runtimeApplicationVersion;
  }

  /**
  * 读取文件内容
  */
  readFile(filePath: string) {
    return window['fs'].readFileSync(filePath, 'utf8');
  }

  readFileBytes(filePath: string): Uint8Array {
    const data = window['fs'].readFileBuffer(filePath);
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  }

  async readFileAsync(filePath: string, encoding = 'utf8'): Promise<string> {
    const fsApi = window['fs'];
    if (fsApi?.readFile) {
      return await fsApi.readFile(filePath, encoding);
    }

    return this.readFile(filePath);
  }

  /**
   * 读取目录内容
   */
  readDir(dirPath: string) {
    return window['fs'].readDirSync(dirPath);
  }

  /**
   * 写文件
   */
  writeFile(filePath: string, content: string) {
    window['fs'].writeFileSync(filePath, content);
  }

  writeFileBytes(filePath: string, content: Uint8Array) {
    window['fs'].writeFileBuffer(filePath, content);
  }

  /**
   * 删除文件
   */
  deleteFile(filePath: string) {
    return window['fs'].unlinkSync(filePath);
  }

  /**
   * 删除目录
   * @param dirPath 目录路径
   * @param recursive 是否递归删除（默认为 true）
   */
  deleteDir(dirPath: string) {
    return window['fs'].rmdirSync(dirPath);
  }

  /**
   * 删除文件或目录（自动判断类型）
   * @param path 文件或目录路径
   */
  delete(path: string) {
    if (this.isDirectory(path)) {
      return this.deleteDir(path);
    } else {
      return this.deleteFile(path);
    }
  }

  /**
 * 判断路径是否存在
 */
  exists(path: string): boolean {
    return window['fs'].existsSync(path)
  }

  /**
   * 判断是否为目录
   */
  isDirectory(path: string) {
    return window['fs'].isDirectory(path);
  }

  isFile(path: string) {
    return window['fs'].isFile(path);
  }

  // join路径
  pathJoin(...paths: string[]) {
    return window['path'].join(...paths);
  }

  // 写入系统剪贴板
  async clipboardWriteText(text: string): Promise<void> {
    if (window['clipboard']?.writeText) {
      window['clipboard'].writeText(text);
      return;
    }

    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    this.writeTextWithTextarea(text);
  }

  // 读取系统剪贴板
  async clipboardReadText(): Promise<string> {
    if (window['clipboard']?.readText) {
      return window['clipboard'].readText() || '';
    }

    if (navigator.clipboard?.readText && window.isSecureContext) {
      return await navigator.clipboard.readText();
    }

    return '';
  }

  private writeTextWithTextarea(text: string) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(textarea);
    }
  }

  // 调用浏览器打开url
  openUrl(url) {
    window['other'].openByBrowser(url);
  }

  // 改变窗口title
  setTitle(title: string) {
    document.title = title;
  }

  // 打开一个新的实例窗口
  openNewInStance(route, queryParams = null) {
    let target = {
      route
    }
    if (queryParams) {
      target['queryParams'] = queryParams
    }
    window['ipcRenderer'].invoke('open-new-instance', target);
    // 基本用法 - 只传递路由
    // await window.electronAPI.ipcRenderer.invoke('open-new-instance', {
    //   route: 'main/blockly-editor'
    // });

    // // 高级用法 - 传递路由和查询参数
    // await window.electronAPI.ipcRenderer.invoke('open-new-instance', {
    //   route: 'main/blockly-editor',
    //   queryParams: {
    //     path: '/path/to/project',
    //     mode: 'edit',
    //     theme: 'dark'
    //   }
    // });

    // // 处理返回结果
    // const result = await window.electronAPI.ipcRenderer.invoke('open-new-instance', {
    //   route: 'main/settings',
    //   queryParams: { tab: 'general' }
    // });

    // if (result.success) {
    //   console.log('新实例已启动，PID:', result.pid);
    // } else {
    //   console.error('启动失败:', result.error);
    // }
  }

  /**
   * 显示系统通知
   * @param title 通知标题
   * @param body 通知内容
   * @param options 可选配置
   * @returns Promise<{success: boolean, result?: any, error?: string}>
   */
  async notify(title: string, body: string, options?: {
    icon?: string;
    silent?: boolean;
    timeoutType?: 'default' | 'never';
    urgency?: 'normal' | 'critical' | 'low';
  }) {
    if (!this.isElectron) {
      console.warn('Not in Electron environment, notification not supported');
      return { success: false, error: 'Not in Electron environment' };
    }

    try {
      const notificationOptions = {
        title,
        body,
        ...options
      };

      const result = await window['notification'].show(notificationOptions);
      return result;
    } catch (error) {
      console.warn('Show notification error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 请求用户注意当前窗口：Windows 任务栏闪烁、macOS Dock 弹跳与角标等（需在后台时使用）。
   * 与系统通知互补，避免仅依赖短时气泡。
   */
  async requestWindowAttention(): Promise<{ success: boolean; error?: string }> {
    if (!this.isElectron) {
      return { success: false, error: 'Not in Electron environment' };
    }
    try {
      const w = window['iWindow'] as { requestAttention?: () => Promise<{ success: boolean; error?: string }> } | undefined;
      if (w?.requestAttention) {
        return await w.requestAttention();
      }
      return { success: false, error: 'requestAttention unavailable' };
    } catch (error: any) {
      console.warn('requestWindowAttention error:', error);
      return { success: false, error: error?.message };
    }
  }

  async notifyUserInteraction(
    payload: UserInteractionNotificationPayload,
  ): Promise<UserInteractionNotificationResult> {
    if (this.isWindowFocused() && !this.isWindowMinimized()) {
      return { ok: true, notified: false, reason: 'foreground' };
    }

    const title = String(payload?.title || 'Aily').trim().slice(0, 120) || 'Aily';
    const body = String(payload?.body || '').trim().slice(0, 500);
    if (!body) {
      return { ok: false, notified: false, reason: 'empty-body' };
    }

    await this.requestWindowAttention().catch(() => undefined);
    const platform = (window as any).electronAPI?.platform?.type;
    const result = await this.notify(title, body, {
      silent: false,
      timeoutType: 'never',
      ...(platform === 'linux' ? { urgency: 'critical' as const } : {}),
    });
    return {
      ok: result?.success !== false,
      notified: result?.success !== false,
      key: String(payload?.key || ''),
    };
  }

  /**
   * 检查是否支持通知
   * @returns Promise<boolean>
   */
  async isNotificationSupported(): Promise<boolean> {
    if (!this.isElectron) {
      return false;
    }

    try {
      return await window['notification'].isSupported();
    } catch (error) {
      console.error('Check notification support error:', error);
      return false;
    }
  }

  /**
   * 检查当前窗口是否为活动窗口（是否获得焦点）
   * @returns boolean
   */
  isWindowFocused(): boolean {
    if (!this.isElectron) {
      // 在浏览器环境中使用 document.hasFocus()
      return document.hasFocus();
    }

    try {
      return window['iWindow'].isFocused();
    } catch (error) {
      console.error('Check window focus error:', error);
      return false;
    }
  }

  /**
   * 检查当前窗口是否最小化
   * @returns boolean
   */
  isWindowMinimized(): boolean {
    if (!this.isElectron) {
      return false;
    }

    try {
      return window['iWindow'].isMinimized();
    } catch (error) {
      console.error('Check window minimized error:', error);
      return false;
    }
  }

  /**
   * 监听窗口获得焦点事件
   * @param callback 回调函数
   * @returns 取消监听的函数
   */
  onWindowFocus(callback: () => void): () => void {
    if (!this.isElectron) {
      // 在浏览器环境中使用原生事件
      const handler = () => callback();
      window.addEventListener('focus', handler);
      return () => window.removeEventListener('focus', handler);
    }

    try {
      return window['iWindow'].onFocus(callback);
    } catch (error) {
      console.error('Listen window focus error:', error);
      return () => {};
    }
  }

  /**
   * 监听窗口失去焦点事件
   * @param callback 回调函数
   * @returns 取消监听的函数
   */
  onWindowBlur(callback: () => void): () => void {
    if (!this.isElectron) {
      // 在浏览器环境中使用原生事件
      const handler = () => callback();
      window.addEventListener('blur', handler);
      return () => window.removeEventListener('blur', handler);
    }

    try {
      return window['iWindow'].onBlur(callback);
    } catch (error) {
      console.error('Listen window blur error:', error);
      return () => {};
    }
  }

  /**
   * 检查窗口是否最大化
   * @returns boolean
   */
  isWindowMaximized(): boolean {
    if (!this.isElectron) {
      return false;
    }

    try {
      return window['iWindow'].isMaximized();
    } catch (error) {
      console.error('Check window maximized error:', error);
      return false;
    }
  }

  /**
   * 检查窗口是否最大化（同步方法，用于模板绑定）
   * 注意：这里实际检测的是窗口最大化状态，而非全屏状态
   * @returns boolean
   */
  isWindowFullScreen(): boolean {
    if (!this.isElectron) {
      return false;
    }

    try {
      return window['iWindow'].isMaximized();
    } catch (error) {
      console.error('Check window maximized error:', error);
      return false;
    }
  }

  /**
   * 监听窗口全屏状态变化事件
   * @param callback 回调函数，参数为是否全屏
   * @returns 取消监听的函数
   */
  onWindowFullScreenChanged(callback: (isFullScreen: boolean) => void): () => void {
    if (!this.isElectron) {
      return () => {};
    }

    try {
      return window['iWindow'].onFullScreenChanged(callback);
    } catch (error) {
      console.error('Listen window full screen changed error:', error);
      return () => {};
    }
  }

  /**
   * 监听窗口最大化状态变化事件
   * @param callback 回调函数，参数为是否最大化
   * @returns 取消监听的函数
   */
  onWindowMaximizeChanged(callback: (isMaximized: boolean) => void): () => void {
    if (!this.isElectron) {
      return () => {};
    }

    try {
      return window['iWindow'].onMaximizeChanged(callback);
    } catch (error) {
      console.error('Listen window maximize changed error:', error);
      return () => {};
    }
  }

  openByExplorer(path){
    window['other'].openByExplorer(path);
  }

  /**
   * 发送渲染进程就绪信号
   */
  async sendRendererReady(): Promise<number> {
    if (!this.isElectron) {
      return 0;
    }

    const generation = Number(await window['ipcRenderer'].invoke('get-renderer-generation'));
    if (!Number.isInteger(generation) || generation <= 0) {
      console.warn('[RendererLifecycle] Main process did not provide a valid renderer generation.');
      return 0;
    }

    window['ipcRenderer'].send('renderer-ready', { generation });
    return generation;
  }

  get currentRendererGeneration(): number {
    return this.rendererGenerationSubject.value;
  }

  get isRendererSuspended(): boolean {
    return this.rendererSuspended;
  }

  get isRendererScreenLocked(): boolean {
    return this.rendererScreenLocked;
  }

  private registerRendererLifecycleListeners(): void {
    if (this.rendererLifecycleListenersRegistered || !window['ipcRenderer']?.on) {
      return;
    }
    this.rendererLifecycleListenersRegistered = true;
    window['ipcRenderer'].on('renderer-ready-ack', (_event: unknown, payload: { generation?: unknown }) => {
      const generation = Number(payload?.generation);
      if (Number.isInteger(generation) && generation > 0) {
        this.rendererGenerationSubject.next(generation);
      }
    });
    window['ipcRenderer'].on('renderer-lifecycle', (_event: unknown, payload: RendererLifecycleEvent) => {
      const generation = Number(payload?.generation);
      if ((payload?.kind === 'suspend'
        || payload?.kind === 'resume'
        || payload?.kind === 'lock-screen'
        || payload?.kind === 'unlock-screen')
        && Number.isInteger(generation)
        && generation === this.rendererGenerationSubject.value) {
        if (payload.kind === 'suspend') this.rendererSuspended = true;
        if (payload.kind === 'resume') this.rendererSuspended = false;
        if (payload.kind === 'lock-screen') this.rendererScreenLocked = true;
        if (payload.kind === 'unlock-screen') this.rendererScreenLocked = false;
        this.rendererLifecycleSubject.next({
          kind: payload.kind,
          generation,
        });
      }
    });
  }

  /**
   * 获取当前区域（异步方法）
   */
  async currentRegion(): Promise<string> {
    if (!this.isElectron) {
      return '';
    }
    try {
      return await window['env'].get('AILY_REGION') || '';
    } catch (error) {
      console.error('Get current region error:', error);
      return '';
    }
  }

  /**
   * 计算字符串内容的 SHA256 哈希值
   * @param content 要计算哈希的字符串内容
   * @returns SHA256 哈希值（十六进制字符串）
   */
  async calculateHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 计算文件的 SHA256 哈希值
   * @param filePath 文件路径
   * @returns SHA256 哈希值（十六进制字符串）
   */
  async calculateFileHash(filePath: string): Promise<string> {
    try {
      const content = this.readFile(filePath);
      return await this.calculateHash(content);
    } catch (error) {
      console.error('计算文件哈希值失败:', error);
      throw error;
    }
  }
}
