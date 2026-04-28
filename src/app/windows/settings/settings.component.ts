import { Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { UiService } from '../../services/ui.service';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { SettingsService } from '../../services/settings.service';
import { TranslationService } from '../../services/translation.service';
import { ConfigService } from '../../services/config.service';
import { SimplebarAngularModule } from 'simplebar-angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { AuthService } from '../../services/auth.service';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ThemeService, ThemeMode } from '../../services/theme.service';
import { CmdService } from '../../services/cmd.service';

@Component({
  selector: 'app-settings',
  imports: [
    CommonModule,
    FormsModule,
    SubWindowComponent,
    NzButtonModule,
    NzInputModule,
    NzRadioModule,
    SimplebarAngularModule,
    TranslateModule,
    NzSwitchModule,
    NzSelectModule
  ],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnDestroy {
  @ViewChild('scrollContainer', { static: false }) scrollContainer: ElementRef;

  activeSection = 'SETTINGS.SECTIONS.BASIC'; // 当前活动的部分

  // simplebar 配置选项
  options = {
    autoHide: true,
    scrollbarMinSize: 50
  };

  items = [
    {
      name: 'SETTINGS.SECTIONS.BASIC',
      icon: 'fa-light fa-gear'
    },
    {
      name: 'SETTINGS.SECTIONS.THEME',
      icon: 'fa-light fa-gift'
    },
    // {
    //   name: 'SETTINGS.SECTIONS.COMPILATION',
    //   icon: 'fa-light fa-screwdriver-wrench'
    // },
    {
      name: 'SETTINGS.SECTIONS.BLOCKLY',
      icon: 'fa-light fa-puzzle-piece'
    },
    {
      name: 'SETTINGS.SECTIONS.REPOSITORY',
      icon: 'fa-light fa-globe'
    },
    {
      name: 'SETTINGS.SECTIONS.DEPENDENCIES',
      icon: 'fa-light fa-layer-group'
    },
    // {
    //   name: 'SETTINGS.SECTIONS.MCP',
    //   icon: 'fa-light fa-webhook'
    // },
    {
      name: 'SETTINGS.SECTIONS.CACHE',
      icon: 'fa-light fa-broom'
    },
    {
      name: 'SETTINGS.SECTIONS.DEVMODE',
      icon: 'fa-light fa-gear-code'
    },
  ];

  // 缓存管理
  cacheStats = { totalFiles: 0, totalSizeFormatted: '0 B' };
  cacheSizeLoading = false;
  cacheClearing: 'all' | '30' | '90' | null = null;
  private _clearCacheSubscription: Subscription | null = null;
  private _clearCacheLoadingRef: string | null = null;

  // 用于跟踪安装/卸载状态
  boardOperations = {};

  // 搜索关键字
  boardSearchKeyword: string = '';

  get boardList() {
    return this.settingsService.boardList.concat(
      this.settingsService.toolList,
      this.settingsService.sdkList,
      this.settingsService.compilerList
    );;
  }

  // 过滤后的开发板列表
  get filteredBoardList() {
    if (!this.boardSearchKeyword || this.boardSearchKeyword.trim() === '') {
      return this.boardList;
    }
    const keyword = this.boardSearchKeyword.toLowerCase().trim();
    return this.boardList.filter(board =>
      board.name.toLowerCase().includes(keyword) ||
      (board.version && board.version.toLowerCase().includes(keyword))
    );
  }

  get npmRegistryList() {
    return this.configService.getRegionList();
  }

  get apiServerList() {
    return this.configService.getRegionList();
  }

  // 区域对应的国旗映射
  regionFlags: { [key: string]: string } = {
    'cn': '🇨🇳',
    'eu': '🇪🇺',
    'us': '🇺🇸',
    'jp': '🇯🇵',
    'kr': '🇰🇷',
    'localhost': ''
  };

  // 获取区域列表（仅启用的区域）
  get regionList() {
    return this.configService.getEnabledRegionList();
  }

  // 获取区域对应的国旗
  getRegionFlag(key: string): string {
    return this.regionFlags[key] || '🌐';
  }

  // 当前选择的区域
  get selectedRegion() {
    return this.configData.region || 'cn';
  }

  set selectedRegion(value: string) {
    this.configData.region = value;
  }

  // 切换区域
  async onRegionChange(regionKey: string) {
    // 如果选择的区域和当前区域一样，直接返回
    if (regionKey === this.selectedRegion) {
      return;
    }

    // 检查是否已登录
    if (this.authService.isAuthenticated) {
      // 显示确认弹窗
      this.modal.confirm({
        nzTitle: this.translateService.instant('SETTINGS.FIELDS.REGION_TITLE'),
        nzContent: this.translateService.instant('SETTINGS.FIELDS.REGION_DESC'),
        nzOkText: this.translateService.instant('SETTINGS.FIELDS.REGION_CONFIRM'),
        nzCancelText: this.translateService.instant('SETTINGS.FIELDS.REGION_CANCEL'),
        nzBodyStyle: { background: 'var(--aily-bg-primary)' },
        nzOnOk: async () => {
          // 用户确认后，更新区域值
          this.selectedRegion = regionKey;

          // 发送消息到主窗口执行登出
          try {
            setTimeout(async () => {
              if (window['iWindow'] && window['iWindow'].send) {
                // 子窗口：发送消息到主窗口
                window['iWindow'].send({
                  to: 'main',
                  data: { action: 'logout' }
                });
                this.authService.logout();
              } else {
                this.authService.logout();
              }
            }, 0);
          } catch (error) {
            console.error('登出失败:', error);
          }
          // 继续执行切换区域
          await this.configService.setRegion(regionKey);
          await this.updateBoardList();
        }
      });
    } else {
      // 未登录，直接切换区域
      this.selectedRegion = regionKey;
      await this.configService.setRegion(regionKey);
      await this.updateBoardList();
    }
  }

  get langList() {
    return this.translationService.languageList;
  }

  get currentLang() {
    return this.translationService.getSelectedLanguage();
  }

  get configData() {
    return this.configService.data;
  }

  appdata_path: string

  mcpServiceList = []

  constructor(
    private uiService: UiService,
    private settingsService: SettingsService,
    private translationService: TranslationService,
    private configService: ConfigService,
    private authService: AuthService,
    private modal: NzModalService,
    private translateService: TranslateService,
    private themeService: ThemeService,
    private message: NzMessageService,
    private cmdService: CmdService
  ) {
  }

  ngOnDestroy() {
    this._clearCacheSubscription?.unsubscribe();
    if (this._clearCacheLoadingRef) {
      this.message.remove(this._clearCacheLoadingRef);
      this._clearCacheLoadingRef = null;
    }
  }

  async ngOnInit() {
    await this.configService.init();
  }

  async ngAfterViewInit() {
    await this.updateBoardList();
    this.loadCacheStats();
  }

  async updateBoardList() {
    const platform = this.configService.data.platform;
    // this.appdata_path = this.configService.data.appdata_path[platform].replace('%HOMEPATH%', window['path'].getUserHome());
    this.appdata_path = window['path'].getAppDataPath();
    // 使用当前区域的仓库地址
    const npmRegistry = this.configService.getCurrentNpmRegistry();
    // this.settingsService.getBoardList(this.appdata_path, npmRegistry);
    this.settingsService.getToolList(this.appdata_path, npmRegistry);
    this.settingsService.getSdkList(this.appdata_path, npmRegistry);
    this.settingsService.getCompilerList(this.appdata_path, npmRegistry);
  }

  selectLang(lang) {
    this.translationService.setLanguage(lang.code);
    window['ipcRenderer'].send('setting-changed', { action: 'language-changed', data: lang.code });
  }

  // 使用锚点滚动到指定部分
  scrollToSection(item) {
    this.activeSection = item.name;
    const element = document.getElementById(item.name);
    if (element && this.scrollContainer) {
      // 针对simplebar调整滚动方法
      const simplebarInstance = this.scrollContainer['SimpleBar'];
      if (simplebarInstance) {
        simplebarInstance.getScrollElement().scrollTo({
          top: element.offsetTop - 12,
          behavior: 'smooth'
        });
      }
    }
  }

  // 监听滚动事件以更新活动菜单项
  onScroll() {
    const sections = document.querySelectorAll('.section');
    let scrollElement;

    // 获取simplebar的滚动元素
    const simplebarInstance = this.scrollContainer['SimpleBar'];
    if (simplebarInstance) {
      scrollElement = simplebarInstance.getScrollElement();
    } else {
      return;
    }

    const scrollPosition = scrollElement.scrollTop;

    sections.forEach((section: HTMLElement) => {
      const sectionTop = section.offsetTop;
      const sectionHeight = section.offsetHeight;

      if (scrollPosition >= sectionTop - 50 &&
        scrollPosition < sectionTop + sectionHeight - 50) {
        this.activeSection = section.id.replace('section-', '');
      }
    });
  }

  cancel() {
    this.uiService.closeWindow();
  }

  apply() {
    // 保存到config.json，如有需要立即加载的，再加载
    this.configService.save();
    window['ipcRenderer'].send('setting-changed', { action: 'devmode-changed', data: this.configData.devmode });
    // 保存完毕后关闭窗口
    this.uiService.closeWindow();
  }

  onThemeChange(value: string) {
    const mode: ThemeMode = value === 'light' ? 'light' : 'dark';
    this.themeService.setTheme(mode);
    window['ipcRenderer'].send('setting-changed', { action: 'theme-changed', data: mode });
  }

  async uninstall(board) {
    this.boardOperations[board.name] = { status: 'loading' };
    const result = await this.settingsService.uninstall(board)
    if (result === 'success') {
      board.installed = false;
    }
    else if (result === 'failed') {
      this.boardOperations[board.name] = { status: 'failed' };
    }
  }

  async install(board) {
    this.boardOperations[board.name] = { status: 'loading' };
    const result = await this.settingsService.install(board)
    if (result === 'success') {
      board.installed = true;
    }
    else if (result === 'failed') {
      this.boardOperations[board.name] = { status: 'failed' };
    }
  }

  onDevModeChange() {
    // this.configData.devmode = this.configData.devmode;
  }

  async loadCacheStats() {
    const buildPath = window['path'].getAilyBuilderBuildPath();
    if (!buildPath || !window['fs'].existsSync(buildPath)) {
      this.cacheStats = { totalFiles: 0, totalSizeFormatted: '0 B' };
      this.cacheSizeLoading = false;
      return;
    }
    this.cacheSizeLoading = true;
    try {
      let totalSize = 0;
      let totalFiles = 0;
      const entries = window['fs'].readDirSync(buildPath);
      for (const entry of entries) {
        if (entry._isDirectory) {
          const dirPath = window['path'].join(buildPath, entry.name);
          const { size, count } = this.calcDirSize(dirPath);
          totalSize += size;
          totalFiles += count;
        }
      }
      this.cacheStats = { totalFiles, totalSizeFormatted: this.formatFileSize(totalSize) };
    } catch (e) {
      console.error('Failed to load cache stats', e);
    } finally {
      this.cacheSizeLoading = false;
    }
  }

  private calcDirSize(dirPath: string): { size: number; count: number } {
    let size = 0;
    let count = 0;
    try {
      const entries = window['fs'].readDirSync(dirPath);
      for (const entry of entries) {
        const fullPath = window['path'].join(dirPath, entry.name);
        if (entry._isDirectory) {
          const sub = this.calcDirSize(fullPath);
          size += sub.size;
          count += sub.count;
        } else {
          try {
            const stat = window['fs'].statSync(fullPath);
            size += stat.size;
            count++;
          } catch { }
        }
      }
    } catch { }
    return { size, count };
  }

  private formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
  }

  clearCache(option: 'all' | '30' | '90') {
    if (option === 'all') {
      this.modal.confirm({
        nzTitle: this.translateService.instant('SETTINGS.FIELDS.CACHE_CONFIRM_TITLE'),
        nzContent: this.translateService.instant('SETTINGS.FIELDS.CACHE_CONFIRM_DESC'),
        nzOkText: this.translateService.instant('SETTINGS.FIELDS.CACHE_CONFIRM_OK'),
        nzCancelText: this.translateService.instant('SETTINGS.BUTTONS.CANCEL'),
        nzBodyStyle: { background: 'var(--aily-bg-primary)' },
        nzOnOk: () => this.doClearCache(option)
      });
    } else {
      this.doClearCache(option);
    }
  }

  private doClearCache(option: 'all' | '30' | '90') {
    const buildPath = window['path'].getAilyBuilderBuildPath();
    const appDataPath = window['path'].getAppDataPath();
    const configFilePath = window['path'].join(appDataPath, 'clear-cache-config.json');
    const scriptPath = window['path'].join(window['path'].getAilyChildPath(), 'scripts', 'clear-cache.js');

    // 先获取当前项目缓存目录，再写配置并执行
    const run = (excludeDirs: string[]) => {
      try {
        window['fs'].writeFileSync(configFilePath, JSON.stringify({ buildPath, option, excludeDirs }, null, 2));
      } catch (e) {
        console.error('Failed to write clear-cache config', e);
        this.message.error(this.translateService.instant('SETTINGS.FIELDS.CACHE_CLEAR_FAILED'));
        return;
      }

      this.cacheClearing = option;
      const loadingRef = this.message.loading(this.translateService.instant('SETTINGS.FIELDS.CACHE_CLEARING'), { nzDuration: 0 });
      this._clearCacheLoadingRef = loadingRef.messageId;

      const command = `node "${scriptPath}" "${configFilePath}"`;
      this.sendLog({ detail: `${command}`, state: 'doing' });
      const startTime = Date.now();

      this._clearCacheSubscription?.unsubscribe();
      this._clearCacheSubscription = this.cmdService.spawn('node', [scriptPath, configFilePath], {}, true).subscribe({
        next: (output) => {
          if (output.type === 'stdout' && output.data) {
            const lines = output.data.split(/\r?\n/).filter(l => l.trim());
            for (const line of lines) {
              this.sendLog({ detail: line, state: 'doing' });
            }
          } else if (output.type === 'stderr' && output.data) {
            const lines = output.data.split(/\r?\n/).filter(l => l.trim());
            for (const line of lines) {
              this.sendLog({ detail: line, state: 'error' });
            }
          } else if (output.type === 'close') {
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            this.message.remove(loadingRef.messageId);
            this._clearCacheLoadingRef = null;
            if (output.code === 0) {
              this.sendLog({ detail: `Cache cleared (${duration}s)`, state: 'done' });
              this.message.success(this.translateService.instant('SETTINGS.FIELDS.CACHE_CLEARED'));
            } else {
              this.sendLog({ detail: `Cache clear failed (${duration}s) ${output.stderr}`, state: 'error' });
              this.message.error(this.translateService.instant('SETTINGS.FIELDS.CACHE_CLEAR_FAILED'));
            }
            this.cacheClearing = null;
            this.loadCacheStats();
          }
        },
        error: (e) => {
          console.error('Failed to clear cache', e);
          this.message.remove(loadingRef.messageId);
          this._clearCacheLoadingRef = null;
          this.sendLog({ title: this.translateService.instant('SETTINGS.FIELDS.CACHE_CLEAR_FAILED'), detail: String(e), state: 'error' });
          this.message.error(this.translateService.instant('SETTINGS.FIELDS.CACHE_CLEAR_FAILED'));
          this.cacheClearing = null;
          this.loadCacheStats();
        }
      });
    };

    // 向主窗口查询当前项目的缓存目录名，获取后执行清理
    if (window['iWindow'] && window['iWindow'].send) {
      window['iWindow'].send({ to: 'main', data: { action: 'get-build-path' } })
        .then((resp: any) => {
          const excludeDirs: string[] = [];
          if (resp?.buildPath) {
            excludeDirs.push(window['path'].basename(resp.buildPath));
          }
          run(excludeDirs);
        })
        .catch(() => run([]));
    } else {
      run([]);
    }
  }

  private sendLog(log: { title?: string; detail?: string; state?: string }) {
    if (window['iWindow'] && window['iWindow'].send) {
      window['iWindow'].send({ to: 'main', data: { action: 'log', log } });
    }
  }

  // 搜索框变化处理
  onBoardSearchChange() {
    // 搜索逻辑已通过 filteredBoardList getter 实现
    // 这里可以添加额外的处理逻辑，如防抖等
  }
}
