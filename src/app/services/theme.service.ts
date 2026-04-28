import { Injectable, signal } from '@angular/core';
import { ConfigService } from './config.service';

export type ThemeMode = 'dark' | 'light';

@Injectable({
  providedIn: 'root',
})
export class ThemeService {
  /** 当前主题的响应式信号 */
  readonly theme = signal<ThemeMode>('dark');

  /** ng-zorro 主题 link 元素 */
  private nzThemeLinkEl: HTMLLinkElement | null = null;

  constructor(private configService: ConfigService) {}

  /**
   * 初始化主题（应在 app 启动时调用）。
   * 从 ConfigService 中的持久化配置读取主题，如果为 'light' 则切换，否则保持默认 dark。
   */
  init(): void {
    const saved = this.configService.data?.theme;
    const mode: ThemeMode = saved === 'light' ? 'light' : 'dark';
    this.applyTheme(mode);

    // 监听来自 settings 子窗口的主题切换通知
    if (window['ipcRenderer']) {
      window['ipcRenderer'].on('setting-changed', (event: any, data: any) => {
        if (data.action === 'theme-changed') {
          this.applyTheme(data.data as ThemeMode);
        }
      });
    }
  }

  /** 设置主题 */
  setTheme(mode: ThemeMode): void {
    this.applyTheme(mode);
    this.persist(mode);
  }

  /** 切换主题 */
  toggleTheme(): void {
    const next: ThemeMode = this.theme() === 'dark' ? 'light' : 'dark';
    this.setTheme(next);
  }

  /** 获取当前 Monaco Editor 主题名 */
  getMonacoTheme(): string {
    return this.theme() === 'dark' ? 'vs-dark' : 'vs';
  }

  /** 获取当前 Mermaid 主题名 */
  getMermaidTheme(): string {
    return this.theme() === 'dark' ? 'dark' : 'default';
  }

  /** 获取当前 Blockly 主题标识 */
  getBlocklyThemeId(): 'dark' | 'light' {
    return this.theme();
  }

  // ── 内部方法 ──────────────────────────────────────────

  private applyTheme(mode: ThemeMode): void {
    this.theme.set(mode);

    // 设置 html 元素上的 data-theme 属性
    document.documentElement.setAttribute('data-theme', mode);

    // 切换 ng-zorro 主题样式表
    this.switchNzTheme(mode);
  }

  /**
   * 动态切换 ng-zorro 的 dark / default CSS。
   * 利用 <link> 标签进行主题切换，避免同时打包两份 CSS。
   */
  private switchNzTheme(mode: ThemeMode): void {
    const darkHref = 'ng-zorro-antd.dark.css';
    const lightHref = 'ng-zorro-antd.min.css';

    // 查找已存在的 ng-zorro 主题 link（angular.json 打包的或我们动态创建的）
    if (!this.nzThemeLinkEl) {
      // 查找 angular.json 通过 styles 数组注入的 ng-zorro 样式
      const allLinks = document.querySelectorAll('link[rel="stylesheet"]');
      allLinks.forEach((link: HTMLLinkElement) => {
        if (link.href.includes('ng-zorro-antd')) {
          this.nzThemeLinkEl = link;
        }
      });

      // 也查找 <style> 标签中内联的 ng-zorro 样式（Angular 构建可能内联）
      if (!this.nzThemeLinkEl) {
        // angular build 会将 CSS 打包为 style 标签，无法通过 link 切换
        // 此时需要动态创建 link 标签来加载另一套主题
        this.nzThemeLinkEl = document.createElement('link');
        this.nzThemeLinkEl.rel = 'stylesheet';
        this.nzThemeLinkEl.id = 'nz-theme';
        document.head.appendChild(this.nzThemeLinkEl);
      }
    }

    if (this.nzThemeLinkEl.tagName === 'LINK') {
      // 如果切换到 light，移除 dark CSS link 并加载 light CSS
      // 如果切换到 dark，使用已有的 dark CSS
      if (mode === 'light') {
        this.nzThemeLinkEl.href = lightHref;
      } else {
        this.nzThemeLinkEl.href = darkHref;
      }
    }
  }

  private persist(mode: ThemeMode): void {
    if (this.configService.data) {
      this.configService.data.theme = mode === 'dark' ? 'default' : 'light';
      this.configService.save();
    }
  }
}
