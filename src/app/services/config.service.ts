import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { lastValueFrom, Subject, timeout } from 'rxjs';
import { ElectronService } from './electron.service';
import { API, setServerUrl, setRegistryUrl, setToolWebUrl } from '../configs/api.config';
import { calculateSimilarity, extractKeywords } from '../utils/fuzzy-search.utils';
import { mapCoderBoardIndexToBoardList, type CoderBoardIndexEntry } from '../utils/coder-board.mapper';
import { normalizeLanguageCode } from '../utils/language-code';

export const DEVELOPMENT_MODE_PREFERENCES = ['coder', 'blockly'] as const;
export type DevelopmentModePreference = typeof DEVELOPMENT_MODE_PREFERENCES[number];
export type DevelopmentModePreferenceSource = 'onboarding' | 'settings' | 'migration';

export interface ConfigServiceNotice {
  key: string;
  type: 'error';
  message: string;
}

@Injectable({
  providedIn: 'root',
})
export class ConfigService {
  private static readonly ERROR_MESSAGE_DEDUP_MS = 10000;
  private static readonly DEFAULT_BUILD_FLAVOR = 'cn';
  private static readonly DEFAULT_OFFICIAL_REGION = 'cn';
  private static readonly RESOURCE_REQUEST_TIMEOUT_MS = 8000;
  private static readonly HARDWARE_INDEX_BACKGROUND_REFRESH_MIN_INTERVAL_MS = 30000;
  private static readonly HARDWARE_INDEX_CHAT_SEND_REFRESH_DELAY_MS = 5000;

  data: AppConfig | any = {};

  /** 配置重新加载完成时发出，供 blockly 等组件实时应用新配置 */
  configReloaded$ = new Subject<void>();
  readonly configNotice$ = new Subject<ConfigServiceNotice>();
  
  // 数据加载状态标识
  private _isDataReady = false;
  private activeResourceSourceKey: string | null = null;
  
  // 测试用：模拟慢速加载（毫秒），设为0禁用
  private readonly SIMULATE_SLOW_LOADING = 0; // 改为2000可以看到loading效果
  
  /**
   * 检查boards和libraries数据是否已加载完成
   */
  get isDataReady(): boolean {
    const ready = this._isDataReady && 
           (this.boardDict && Object.keys(this.boardDict).length > 0) &&
           (this.libraryDict && Object.keys(this.libraryDict).length > 0);
    
    if (!ready) {
      //console.log('[ConfigService] isDataReady=false', {
      //   _isDataReady: this._isDataReady,
      //   boardDictSize: Object.keys(this.boardDict || {}).length,
      //   libraryDictSize: Object.keys(this.libraryDict || {}).length
      // });
    }
    
    return ready;
  }

  constructor(
    private http: HttpClient,
    private electronService: ElectronService
  ) { }

  private normalizeBuildFlavor(flavor?: string): string {
    return flavor === 'global' ? 'global' : ConfigService.DEFAULT_BUILD_FLAVOR;
  }

  private resolveOfficialRegionKey(): string {
    if (typeof this.data?.official_region === 'string' && this.data.official_region) {
      return this.data.official_region;
    }

    return this.normalizeBuildFlavor(this.data?.build_flavor) === 'global'
      ? 'eu'
      : ConfigService.DEFAULT_OFFICIAL_REGION;
  }

  private isOfficialRegionKey(regionKey: string): boolean {
    const regionConfig = this.data?.regions?.[regionKey];
    if (!regionConfig) {
      return false;
    }

    if (typeof regionConfig.official === 'boolean') {
      return regionConfig.official;
    }

    return regionKey === 'cn' || regionKey === 'eu';
  }

  private isRegionSelectable(regionKey: string): boolean {
    if (!this.data?.regions?.[regionKey]) {
      return false;
    }

    if (!this.isOfficialRegionKey(regionKey)) {
      return true;
    }

    return regionKey === this.resolveOfficialRegionKey();
  }

  private applyRegionRuntimeConfig(regionKey: string): void {
    if (!regionKey || !this.data?.regions?.[regionKey]) {
      return;
    }

    this.data.region = regionKey;
    setRegistryUrl(this.data.regions[regionKey].npm_registry);
    setServerUrl(this.data.regions[regionKey].api_server);
    setToolWebUrl(this.data.regions[regionKey].tool_web);
  }

  normalizeDevelopmentModePreference(value: unknown): DevelopmentModePreference {
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'auto') {
        return 'blockly';
      }
      if ((DEVELOPMENT_MODE_PREFERENCES as readonly string[]).includes(normalized)) {
        return normalized as DevelopmentModePreference;
      }
    }

    return 'blockly';
  }

  isCoderEnabled(): boolean {
    return this.data?.coder?.enabled === true;
  }

  getDevelopmentModePreference(): DevelopmentModePreference {
    if (!this.isCoderEnabled()) {
      return 'blockly';
    }
    return this.normalizeDevelopmentModePreference(this.data?.developmentModePreference);
  }

  async setDevelopmentModePreference(
    preference: unknown,
    source: DevelopmentModePreferenceSource = 'settings',
    options: { save?: boolean } = {},
  ): Promise<DevelopmentModePreference> {
    const normalized = this.isCoderEnabled()
      ? this.normalizeDevelopmentModePreference(preference)
      : 'blockly';
    this.data.developmentModePreference = normalized;
    this.data.developmentModePreferenceSource = source;
    this.data.developmentModePreferenceUpdatedAt = Date.now();
    console.info('[ConfigService] development mode preference updated', {
      preference: normalized,
      source,
    });
    this.configReloaded$.next();

    if (options.save !== false) {
      await this.save();
    }

    return normalized;
  }

  async markDevelopmentModePreferencePrompted(options: { save?: boolean } = {}): Promise<void> {
    this.data.developmentModePreferencePromptedAt = Date.now();
    if (options.save !== false) {
      await this.save();
    }
  }

  shouldPromptDevelopmentModePreference(): boolean {
    if (!this.isCoderEnabled()) {
      return false;
    }
    return !this.data?.developmentModePreferenceSource && !this.data?.developmentModePreferencePromptedAt;
  }

  getPreferredChatAgentRuntimeMode(): 'coder' | 'blockly' {
    return this.getDevelopmentModePreference() === 'coder' ? 'coder' : 'blockly';
  }

  async init() {
    if (!this.electronService.isElectron) {
      //console.log('[ConfigService] 非Electron环境，跳过数据加载，直接标记就绪');
      // 非 Electron 环境下，跳过 loading 状态（没有数据源）
      this._isDataReady = true;
      return;
    }
    //console.log('[ConfigService] 开始初始化...');
    await this.load();
    //console.log('[ConfigService] 初始化完成, isDataReady=', this.isDataReady);
  }

  async load() {
    //console.log('[ConfigService] load() 开始执行...');
    let defaultConfigFilePath = window['path'].getElectronPath();
    let defaultConfigFile = window['fs'].readFileSync(`${defaultConfigFilePath}/config/config.json`);
    this.data = await JSON.parse(defaultConfigFile);

    this.data["selectedLanguage"] = normalizeLanguageCode(window['platform'].lang);

    let userConfData;
    let configFilePath = window['path'].getAppDataPath();
    // 检查配置文件是否存在，如果不存在则创建一个默认的配置文件
    if (this.electronService.exists(`${configFilePath}/config.json`)) {
      userConfData = JSON.parse(this.electronService.readFile(`${configFilePath}/config.json`));
    } else {
      userConfData = {};
    }

    // 合并用户配置和默认配置
    this.data = { ...this.data, ...userConfData };
    this.data.selectedLanguage = normalizeLanguageCode(this.data.selectedLanguage);
    this.data.developmentModePreference = this.isCoderEnabled()
      ? this.normalizeDevelopmentModePreference(this.data.developmentModePreference)
      : 'blockly';
    this.data.build_flavor = this.normalizeBuildFlavor(this.data.build_flavor);
    this.data.official_region = this.resolveOfficialRegionKey();

    // 使用主进程已确定的 region 与官方 region 覆盖配置
    if (this.electronService.isElectron) {
      try {
        const [region, officialRegion, buildFlavor] = await Promise.all([
          this.electronService.electron.ipcRenderer.invoke('env-get', 'AILY_REGION'),
          this.electronService.electron.ipcRenderer.invoke('env-get', 'AILY_OFFICIAL_REGION'),
          this.electronService.electron.ipcRenderer.invoke('env-get', 'AILY_BUILD_FLAVOR')
        ]);

        this.data.build_flavor = this.normalizeBuildFlavor(buildFlavor || this.data.build_flavor);
        this.data.official_region = officialRegion || this.resolveOfficialRegionKey();

        if (region && this.data.regions && this.data.regions[region]) {
          this.applyRegionRuntimeConfig(region);
        } else {
          this.applyRegionRuntimeConfig(this.data.region || this.resolveOfficialRegionKey());
        }
      } catch (e) {
        console.error('Failed to get env vars', e);
        this.applyRegionRuntimeConfig(this.data.region || this.resolveOfficialRegionKey());
      }
    } else {
      this.applyRegionRuntimeConfig(this.data.region || this.resolveOfficialRegionKey());
    }

    await this.applyResourceSourceRuntimeSelection();

    // 添加当前系统类型到data中
    this.data["platform"] = window['platform'].type;
    this.data["lang"] = normalizeLanguageCode(window['platform'].lang);
    this.configReloaded$.next();

    // 并行加载缓存的boards.json、libraries.json和tags.json（旧格式，用于基础功能）
    // await Promise.all([
    this.loadAndCacheBoardList(configFilePath);
    this.loadAndCacheLibraryList(configFilePath);
    this.loadAndCacheTagList(configFilePath);
    this.loadAndCacheCoderBoardIndex(configFilePath);
    // ]);

    // 注意：boardIndex 和 libraryIndex（新格式索引）延迟到 AI 组件加载时再加载
    // 以减轻软件启动耗时，参见 loadHardwareIndexForAI()

  }

  private async loadAndCacheBoardList(configFilePath: string): Promise<void> {
    const localPath = `${configFilePath}/boards.json`;

    try {
      if (this.electronService.exists(localPath)) {
        this.boardList = this.parseBoardList(this.electronService.readFile(localPath));
        const boardList = await this.loadBoardList();
        if (boardList.length > 0) {
          this.boardList = boardList;
          this.electronService.writeFile(localPath, JSON.stringify(boardList));
        }
      } else {
        // 首次启动软件，创建boards.json
        const boardList = await this.fetchBoardListOrThrow();
        this.boardList = boardList;
        this.electronService.writeFile(localPath, JSON.stringify(boardList));
      }
    } catch (error) {
      console.error('[ConfigService] boards.json 加载失败，尝试从线上恢复:', error);
      await this.reloadBoardListFromRemote(localPath, error);
    }

    this.boardDict = {};
    // 创建一个boardDict，方便通过name快速查找board信息
    this.boardList.forEach(board => {
      this.boardDict[board.name] = board;
    });
    // console.log(`[ConfigService] boardDict创建完成，共 ${Object.keys(this.boardDict).length} 个开发板`);
  }

  private async loadAndCacheLibraryList(configFilePath: string): Promise<void> {
    const localPath = `${configFilePath}/libraries.json`;

    try {
      if (this.electronService.exists(localPath)) {
        this.libraryList = this.parseLibraryList(this.electronService.readFile(localPath));
        const libraryList = await this.loadLibraryList();
        if (libraryList.length > 0) {
          this.libraryList = libraryList;
          this.electronService.writeFile(localPath, JSON.stringify(libraryList));
        }
      } else {
        // 首次启动软件，创建libraries.json
        const libraryList = await this.fetchLibraryListOrThrow();
        this.libraryList = libraryList;
        this.electronService.writeFile(localPath, JSON.stringify(libraryList));
      }
    } catch (error) {
      console.error('[ConfigService] libraries.json 加载失败，尝试从线上恢复:', error);
      await this.reloadLibraryListFromRemote(localPath, error);
    }

    this.libraryDict = {};
    // 创建一个libraryDict，方便通过name快速查找library信息
    this.libraryList.forEach(library => {
      this.libraryDict[library.name] = library;
    });
    // console.log(`[ConfigService] libraryDict创建完成，共 ${Object.keys(this.libraryDict).length} 个库`);
  }

  async save() {
    if (!this.electronService.isElectron) return;
    let configFilePath = window['path'].getAppDataPath();
    window['fs'].writeFileSync(`${configFilePath}/config.json`, JSON.stringify(this.data, null, 2));
  }

  /**
   * 获取当前区域配置
   */
  getCurrentRegionConfig() {
    const region = this.data.region || 'cn';
    return this.data.regions && this.data.regions[region] ? this.data.regions[region] : this.data.regions['cn'];
  }

  private normalizeResourceSourceUrl(url: string): string {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  private buildLegacyResourceSourceList(): ResourceSourceConfig[] {
    const fallbackSources = [
      { key: 'primary', url: this.data?.regions?.eu?.resource },
      { key: 'mirror', url: this.data?.regions?.cn?.resource },
      { key: 'localhost', url: this.data?.regions?.localhost?.resource }
    ];
    const seenUrls = new Set<string>();
    const normalizedSources: ResourceSourceConfig[] = [];

    for (const source of fallbackSources) {
      const url = this.normalizeResourceSourceUrl(source.url || '');
      if (!url || seenUrls.has(url)) {
        continue;
      }

      seenUrls.add(url);
      normalizedSources.push({
        key: source.key,
        url,
        enabled: true
      });
    }

    return normalizedSources;
  }

  getResourceSourceList(): ResourceSourceConfig[] {
    const configuredSources = Array.isArray(this.data?.resource_sources) ? this.data.resource_sources : [];
    const seenUrls = new Set<string>();
    const normalizedSources: ResourceSourceConfig[] = [];

    for (const source of configuredSources) {
      const url = this.normalizeResourceSourceUrl(source?.url || '');
      if (!url || source?.enabled === false || seenUrls.has(url)) {
        continue;
      }

      seenUrls.add(url);
      normalizedSources.push({
        key: typeof source.key === 'string' && source.key.trim() ? source.key.trim() : `resource_${normalizedSources.length + 1}`,
        name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : undefined,
        url,
        enabled: source.enabled !== false
      });
    }

    return normalizedSources.length > 0 ? normalizedSources : this.buildLegacyResourceSourceList();
  }

  getSelectedResourceSourceKey(): string {
    return typeof this.data?.resource_source === 'string' && this.data.resource_source.trim()
      ? this.data.resource_source.trim()
      : 'auto';
  }

  private isAutoResourceSourceSelection(): boolean {
    return this.getSelectedResourceSourceKey() === 'auto';
  }

  private getManualResourceSource(): ResourceSourceConfig | null {
    const selectedKey = this.getSelectedResourceSourceKey();
    if (selectedKey === 'auto') {
      return null;
    }

    return this.getResourceSourceList().find((source) => source.key === selectedKey) || null;
  }

  private getCurrentResourceSource(): ResourceSourceConfig | null {
    const sources = this.getResourceSourceList();
    if (sources.length === 0) {
      return null;
    }

    if (!this.isAutoResourceSourceSelection()) {
      return this.getManualResourceSource() || sources[0];
    }

    return sources.find((source) => source.key === this.activeResourceSourceKey) || sources[0];
  }

  private getResourceSourceCandidates(): ResourceSourceConfig[] {
    const sources = this.getResourceSourceList();
    if (sources.length === 0) {
      return [];
    }

    if (!this.isAutoResourceSourceSelection()) {
      return [this.getManualResourceSource() || sources[0]];
    }

    const currentSource = this.getCurrentResourceSource();
    if (!currentSource) {
      return sources;
    }

    return [currentSource, ...sources.filter((source) => source.key !== currentSource.key)];
  }

  private buildZipUrlCandidates(): string[] {
    const seenUrls = new Set<string>();
    const urls: string[] = [];

    for (const source of this.getResourceSourceCandidates()) {
      if (!source.url || seenUrls.has(source.url)) {
        continue;
      }

      seenUrls.add(source.url);
      urls.push(source.url);
    }

    return urls;
  }

  async applyResourceSourceRuntimeSelection(): Promise<void> {
    const currentSource = this.getCurrentResourceSource();
    this.activeResourceSourceKey = currentSource?.key || null;
    await this.syncResourceRuntimeEnv();
    this.configReloaded$.next();
  }

  private async syncResourceRuntimeEnv(): Promise<void> {
    const currentUrl = this.getCurrentResourceUrl();
    const zipUrls = JSON.stringify(this.buildZipUrlCandidates());

    if (window['process']?.env) {
      window['process'].env['AILY_ZIP_URL'] = currentUrl;
      window['process'].env['AILY_ZIP_URLS'] = zipUrls;
    }

    if (window['ipcRenderer']) {
      await Promise.all([
        window['ipcRenderer'].invoke('env-set', { key: 'AILY_ZIP_URL', value: currentUrl }),
        window['ipcRenderer'].invoke('env-set', { key: 'AILY_ZIP_URLS', value: zipUrls })
      ]);
    }
  }

  private async fetchResourceJsonOrThrow<T>(pathname: string): Promise<T> {
    const candidates = this.getResourceSourceCandidates();
    if (candidates.length === 0) {
      throw new Error('未配置可用的资源地址');
    }

    let lastError: unknown;
    for (let index = 0; index < candidates.length; index++) {
      const source = candidates[index];
      try {
        const response = await lastValueFrom(
          this.http.get<T>(`${source.url}${pathname}`, {
            responseType: 'json',
          }).pipe(timeout(ConfigService.RESOURCE_REQUEST_TIMEOUT_MS)),
        );

        if (this.activeResourceSourceKey !== source.key) {
          this.activeResourceSourceKey = source.key;
          void this.syncResourceRuntimeEnv();
          this.configReloaded$.next();
        }

        return response;
      } catch (error) {
        lastError = error;
        console.warn(`[ConfigService] 资源请求失败 (${source.key}) ${pathname}:`, error);
        if (!this.isAutoResourceSourceSelection() || index === candidates.length - 1) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error('资源请求失败');
  }

  /**
   * 当前服务区域是否为中国区
   */
  get isCnRegion(): boolean {
    return (this.data?.region || 'cn').toLowerCase() === 'cn';
  }

  /**
   * 获取当前区域的资源URL
   */
  getCurrentResourceUrl(): string {
    return this.getCurrentResourceSource()?.url || this.getCurrentRegionConfig()?.resource || '';
  }

  /**
   * 获取当前构建版型的官方区域资源 URL。
   * 法务协议等区分 CN/海外版本的内容必须使用此地址，
   * 不能跟随 resource_source 的自动镜像切换。
   */
  getOfficialRegionResourceUrl(): string {
    const officialRegion = this.resolveOfficialRegionKey();
    const currentRegion = this.data?.region || officialRegion;
    const resourceUrl = this.data?.regions?.[officialRegion]?.resource
      || this.data?.regions?.[currentRegion]?.resource
      || '';
    return this.normalizeResourceSourceUrl(resourceUrl);
  }

  /**
   * 子应用目录跟随当前服务区域的 regions.<region>.resource，
   * 不使用 resource_source 的资源镜像选择。
   */
  getSubappIndexUrl(): string {
    const resourceUrl = this.normalizeResourceSourceUrl(this.getCurrentRegionConfig()?.resource || '');
    return resourceUrl ? `${resourceUrl}/subapp-index.json` : '';
  }

  /**
   * 获取当前区域的NPM Registry URL
   */
  getCurrentNpmRegistry(): string {
    return this.getCurrentRegionConfig()?.npm_registry || '';
  }

  /**
   * 获取当前区域的API Server URL
   */
  getCurrentApiServer(): string {
    return this.getCurrentRegionConfig()?.api_server || '';
  }

  /**
   * 获取当前区域的Updater URL
   */
  getCurrentUpdaterUrl(): string {
    return this.getCurrentRegionConfig()?.updater || '';
  }

  /**
   * 获取 Web 站点 URL（用于协议文档等）
   */
  getWebUrl(): string {
    const url = this.getCurrentRegionConfig()?.web || this.data?.web || 'https://aily.pro';
    return url.endsWith('/') ? url.slice(0, -1) : url;
  }

  /**
   * 获取用户中心 URL（如果配置了）
   */
  getUcenterWebUrl(): string {
    const url = this.getCurrentRegionConfig()?.ucenter_web || this.data?.ucenter_web || 'https://c.aily.pro';
    return url.endsWith('/') ? url.slice(0, -1) : url;
  }


  /**
   * 获取所有可用区域列表
   */
  getRegionList(): Array<{key: string, name: string, enabled: boolean}> {
    if (!this.data.regions) return [];
    return Object.keys(this.data.regions).map(key => ({
      key,
      name: this.data.regions[key].name,
      enabled: this.data.regions[key].enabled !== false
    }));
  }

  /**
   * 获取启用的区域列表
   */
  getEnabledRegionList(): Array<{key: string, name: string, enabled: boolean}> {
    return this.getRegionList().filter(region => region.enabled && this.isRegionSelectable(region.key));
  }

  /**
   * 设置当前区域
   */
  async setRegion(regionKey: string) {
    if (this.data.regions && this.data.regions[regionKey] && this.isRegionSelectable(regionKey)) {
      const previousApiServer = this.getCurrentApiServer();
      this.data.region = regionKey;
      const regionConfig = this.data.regions[regionKey];
      
      // 更新 API 配置模块的缓存
      setRegistryUrl(regionConfig.npm_registry);
      setServerUrl(regionConfig.api_server);
      setToolWebUrl(regionConfig.tool_web);
      
      // 更新环境变量
      if (window['process']?.env) {
        window['process'].env['AILY_REGION'] = regionKey;
        window['process'].env['AILY_NPM_REGISTRY'] = regionConfig.npm_registry;
        window['process'].env['AILY_API_SERVER'] = regionConfig.api_server;
        window['process'].env['AILY_TOOL_WEB'] = regionConfig.tool_web;
        window['process'].env['AILY_SUBAPP_INDEX_URL'] = this.getSubappIndexUrl();
      }
      
      // 通过 ipcRenderer 通知主进程更新环境变量（等待所有更新完成）
      if (window['ipcRenderer']) {
        await Promise.all([
          window['ipcRenderer'].invoke('env-set', { key: 'AILY_REGION', value: regionKey }),
          window['ipcRenderer'].invoke('env-set', { key: 'AILY_NPM_REGISTRY', value: regionConfig.npm_registry }),
          window['ipcRenderer'].invoke('env-set', { key: 'AILY_API_SERVER', value: regionConfig.api_server }),
          window['ipcRenderer'].invoke('env-set', { key: 'AILY_TOOL_WEB', value: regionConfig.tool_web }),
          window['ipcRenderer'].invoke('env-set', { key: 'AILY_SUBAPP_INDEX_URL', value: this.getSubappIndexUrl() })
        ]);
      }

      await this.syncResourceRuntimeEnv();
      
      // 保存配置
      await this.save();

      if (previousApiServer !== this.getCurrentApiServer()) {
        this.configReloaded$.next();
      }
    }
  }

  boardList = [];
  boardDict = {};
  private errorNoticeState: Record<string, { message: string; at: number }> = {};

  private parseBoardList(raw: string): any[] {
    return this.parseArrayPayload(raw, 'boards.json 格式无效');
  }

  private async fetchBoardListOrThrow(): Promise<any[]> {
    return this.fetchRemoteArrayOrThrow('/boards.json', '线上 boards.json 格式无效');
  }

  private async reloadBoardListFromRemote(localPath: string, originalError: unknown): Promise<void> {
    try {
      const latestBoardList = await this.fetchBoardListOrThrow();
      this.boardList = latestBoardList;
      this.electronService.writeFile(localPath, JSON.stringify(latestBoardList));
      //console.log('[ConfigService] 已使用线上最新 boards.json 覆盖本地缓存');
    } catch (remoteError) {
      this.boardList = [];
      const message = this.getBoardReloadFailureMessage(remoteError, originalError);
      console.error('[ConfigService] 从线上恢复 boards.json 失败:', remoteError);
      this.emitBoardLoadError(message);
    }
  }

  private getBoardReloadFailureMessage(remoteError: unknown, originalError: unknown): string {
    return this.buildReloadFailureMessage('开发板列表', 'boards.json', remoteError, originalError);
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      if (typeof error.error === 'string' && error.error.trim()) {
        return error.error;
      }
      return error.message || `HTTP ${error.status}`;
    }

    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === 'string') {
      return error;
    }

    return '未知错误';
  }

  private emitBoardLoadError(message: string): void {
    this.emitDedupedError('board-list', message);
  }

  async loadBoardList(): Promise<any[]> {
    try {
      return await this.fetchBoardListOrThrow();
    } catch (error) {
      console.error('Failed to load board list:', error);
      return [];
    }
  }

  /**
   * 开发板选择弹窗：优先返回已缓存列表（启动时已加载 boards.json），避免每次打开都请求线上。
   */
  getBoardListForSelector(): any[] {
    if (!this.boardList?.length) {
      return [];
    }
    return this.sortBoardsByUsage([...this.boardList]);
  }

  /** Coder 新建项目使用的开发板索引（由 coder_board_index.json 映射而来） */
  coderBoardList: any[] = [];

  private async loadAndCacheCoderBoardIndex(configFilePath: string): Promise<void> {
    const localPath = `${configFilePath}/coder_board_index.json`;

    try {
      if (this.electronService.exists(localPath)) {
        const entries = this.parseCoderBoardIndexEntries(this.electronService.readFile(localPath));
        this.coderBoardList = mapCoderBoardIndexToBoardList(entries);
        const remoteEntries = await this.loadCoderBoardIndexEntries();
        if (remoteEntries.length > 0) {
          this.coderBoardList = mapCoderBoardIndexToBoardList(remoteEntries);
          this.writeCoderBoardIndexCache(localPath, remoteEntries);
        }
      } else {
        const remoteEntries = await this.fetchCoderBoardIndexEntriesOrThrow();
        this.coderBoardList = mapCoderBoardIndexToBoardList(remoteEntries);
        this.writeCoderBoardIndexCache(localPath, remoteEntries);
      }
    } catch (error) {
      console.error('[ConfigService] coder_board_index.json 加载失败，尝试从线上恢复:', error);
      await this.reloadCoderBoardIndexFromRemote(localPath, error);
    }

    console.log(`[ConfigService] coderBoardList 加载完成，共 ${this.coderBoardList.length} 个开发板`);
  }

  private parseCoderBoardIndexEntries(raw: string): CoderBoardIndexEntry[] {
    return this.parseArrayPayload(raw, 'coder_board_index.json 格式无效', 'boards') as CoderBoardIndexEntry[];
  }

  private writeCoderBoardIndexCache(localPath: string, entries: CoderBoardIndexEntry[]): void {
    this.electronService.writeFile(localPath, JSON.stringify({ boards: entries }));
  }

  /** Coder 开发板索引固定走 regions.cn.resource，不走 resource_sources 镜像链 */
  private getCoderBoardResourceUrl(): string {
    return this.normalizeResourceSourceUrl(this.data?.regions?.cn?.resource || '');
  }

  private async fetchCoderBoardIndexEntriesOrThrow(): Promise<CoderBoardIndexEntry[]> {
    const resourceUrl = this.getCoderBoardResourceUrl();
    if (!resourceUrl) {
      throw new Error('未配置 Coder 开发板资源地址 (regions.cn.resource)');
    }

    const response: any = await lastValueFrom(
      this.http.get(`${resourceUrl}/coder_board_index.json`, {
        responseType: 'json',
      }).pipe(timeout(ConfigService.RESOURCE_REQUEST_TIMEOUT_MS)),
    );

    if (Array.isArray(response)) {
      return response as CoderBoardIndexEntry[];
    }
    if (response && Array.isArray(response.boards)) {
      return response.boards as CoderBoardIndexEntry[];
    }

    throw new Error('线上 coder_board_index.json 格式无效');
  }

  private async reloadCoderBoardIndexFromRemote(localPath: string, originalError: unknown): Promise<void> {
    try {
      const latestEntries = await this.fetchCoderBoardIndexEntriesOrThrow();
      this.coderBoardList = mapCoderBoardIndexToBoardList(latestEntries);
      this.writeCoderBoardIndexCache(localPath, latestEntries);
      console.log('[ConfigService] 已使用线上最新 coder_board_index.json 覆盖本地缓存');
    } catch (remoteError) {
      this.coderBoardList = [];
      const message = this.buildReloadFailureMessage(
        'Coder 开发板列表',
        'coder_board_index.json',
        remoteError,
        originalError
      );
      console.error('[ConfigService] 从线上恢复 coder_board_index.json 失败:', remoteError);
      this.emitDedupedError('coder-board-list', message);
    }
  }

  async loadCoderBoardIndexEntries(): Promise<CoderBoardIndexEntry[]> {
    try {
      return await this.fetchCoderBoardIndexEntriesOrThrow();
    } catch (error) {
      console.error('Failed to load coder board index:', error);
      return [];
    }
  }

  /** Aily Code 新建向导：返回已映射、按使用次数排序的开发板列表 */
  getCoderBoardList(): any[] {
    if (!this.coderBoardList?.length) {
      return [];
    }
    return this.sortBoardsByUsage([...this.coderBoardList]);
  }

  /**
   * Aily Code 切换开发板弹窗：优先内存缓存（coder_board_index.json），并过滤尚未支持的板卡。
   */
  getCoderBoardListForSelector(): any[] {
    if (!this.coderBoardList?.length) {
      return [];
    }
    const list = this.coderBoardList.filter((board) => board.state !== 'todo');
    return this.sortBoardsByUsage([...list]);
  }

  /** 线上刷新 Coder 开发板索引并返回选择器列表 */
  async loadCoderBoardList(): Promise<any[]> {
    try {
      const entries = await this.loadCoderBoardIndexEntries();
      if (entries.length > 0) {
        this.coderBoardList = mapCoderBoardIndexToBoardList(entries);
      }
    } catch (error) {
      console.error('Failed to load coder board list:', error);
    }
    return this.getCoderBoardListForSelector();
  }

  libraryList = [];
  libraryDict = {};

  tagList: any = {};

  private parseLibraryList(raw: string): any[] {
    return this.parseArrayPayload(raw, 'libraries.json 格式无效');
  }

  private async fetchLibraryListOrThrow(): Promise<any[]> {
    return this.fetchRemoteArrayOrThrow('/libraries.json', '线上 libraries.json 格式无效');
  }

  private async reloadLibraryListFromRemote(localPath: string, originalError: unknown): Promise<void> {
    try {
      const latestLibraryList = await this.fetchLibraryListOrThrow();
      this.libraryList = latestLibraryList;
      this.electronService.writeFile(localPath, JSON.stringify(latestLibraryList));
      //console.log('[ConfigService] 已使用线上最新 libraries.json 覆盖本地缓存');
    } catch (remoteError) {
      this.libraryList = [];
      const message = this.getLibraryReloadFailureMessage(remoteError, originalError);
      console.error('[ConfigService] 从线上恢复 libraries.json 失败:', remoteError);
      this.emitLibraryLoadError(message);
    }
  }

  private getLibraryReloadFailureMessage(remoteError: unknown, originalError: unknown): string {
    return this.buildReloadFailureMessage('扩展库列表', 'libraries.json', remoteError, originalError);
  }

  private emitLibraryLoadError(message: string): void {
    this.emitDedupedError('library-list', message);
  }

  async loadLibraryList(): Promise<any[]> {
    try {
      return await this.fetchLibraryListOrThrow();
    } catch (error) {
      console.error('Failed to load library list:', error);
      return [];
    }
  }

  // ==================== tags.json ====================

  private async loadAndCacheTagList(configFilePath: string): Promise<void> {
    const localPath = `${configFilePath}/tags.json`;

    try {
      if (this.electronService.exists(localPath)) {
        this.tagList = JSON.parse(this.electronService.readFile(localPath));
        const tagList = await this.fetchTagList();
        if (tagList) {
          this.tagList = tagList;
          this.electronService.writeFile(localPath, JSON.stringify(tagList));
        }
      } else {
        // 首次启动软件，创建tags.json
        const tagList = await this.fetchTagList();
        if (tagList) {
          this.tagList = tagList;
          this.electronService.writeFile(localPath, JSON.stringify(tagList));
        }
      }
    } catch (error) {
      console.error('[ConfigService] tags.json 加载失败，尝试从线上恢复:', error);
      await this.reloadTagListFromRemote(localPath, error);
    }

    //console.log('[ConfigService] tagList加载完成:', this.tagList?.tags?.length || 0, '个标签');
  }

  private async fetchTagList(): Promise<any> {
    try {
      return await this.fetchResourceJsonOrThrow('/tags.json');
    } catch (error) {
      console.error('Failed to load tag list:', error);
      return null;
    }
  }

  private async reloadTagListFromRemote(localPath: string, originalError: unknown): Promise<void> {
    try {
      const latestTagList = await this.fetchTagList();
      if (latestTagList) {
        this.tagList = latestTagList;
        this.electronService.writeFile(localPath, JSON.stringify(latestTagList));
        //console.log('[ConfigService] 已使用线上最新 tags.json 覆盖本地缓存');
      }
    } catch (remoteError) {
      this.tagList = {};
      const message = this.buildReloadFailureMessage('标签列表', 'tags.json', remoteError, originalError);
      console.error('[ConfigService] 从线上恢复 tags.json 失败:', remoteError);
      this.emitDedupedError('tag-list', message);
    }
  }

  // ==================== 新格式索引（结构化数据）====================
  boardIndex: any[] = [];  // 新格式开发板索引
  libraryIndex: any[] = [];  // 新格式库索引
  private _hardwareIndexLoaded = false;  // 标记索引是否已加载
  private hardwareIndexLoadPromise: Promise<void> | null = null;
  private hardwareIndexBackgroundRefreshPromise: Promise<void> | null = null;
  private hardwareIndexBackgroundRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private hardwareIndexLastLoadedAt = 0;
  private hardwareIndexLastRefreshScheduledAt = 0;

  /**
   * 为 AI 工具加载硬件索引数据（boardIndex 和 libraryIndex）
   * 延迟加载以减轻软件启动耗时
   * @returns Promise<void>
   */
  async loadHardwareIndexForAI(): Promise<void> {
    // 避免重复加载
    if (this._hardwareIndexLoaded) {
      this.traceHardwareIndexRefresh('hardware index already loaded');
      return;
    }

    if (this.hardwareIndexLoadPromise) {
      return this.hardwareIndexLoadPromise;
    }

    this.hardwareIndexLoadPromise = this.loadHardwareIndexForAIInternal();
    try {
      await this.hardwareIndexLoadPromise;
    } finally {
      this.hardwareIndexLoadPromise = null;
    }
  }

  scheduleHardwareIndexRefreshForAI(reason: string, options: { readonly force?: boolean } = {}): void {
    const normalizedReason = typeof reason === 'string' && reason.trim().length > 0
      ? reason.trim()
      : 'unspecified';
    const now = Date.now();
    if (!options.force) {
      if (this.hardwareIndexBackgroundRefreshPromise) {
        this.traceHardwareIndexRefresh('skip background hardware refresh while in flight', { reason: normalizedReason });
        return;
      }

      if (this.hardwareIndexBackgroundRefreshTimer) {
        this.traceHardwareIndexRefresh('skip background hardware refresh while scheduled', { reason: normalizedReason });
        return;
      }

      if (this.hardwareIndexLastRefreshScheduledAt > 0
        && now - this.hardwareIndexLastRefreshScheduledAt < ConfigService.HARDWARE_INDEX_BACKGROUND_REFRESH_MIN_INTERVAL_MS) {
        this.traceHardwareIndexRefresh('skip background hardware refresh due to min interval', {
          reason: normalizedReason,
          elapsedMs: now - this.hardwareIndexLastRefreshScheduledAt,
        });
        return;
      }
    }

    if (options.force && this.hardwareIndexBackgroundRefreshTimer) {
      clearTimeout(this.hardwareIndexBackgroundRefreshTimer);
      this.hardwareIndexBackgroundRefreshTimer = null;
    }

    this.hardwareIndexLastRefreshScheduledAt = now;
    const delayMs = !options.force && normalizedReason === 'chat-send-latest'
      ? ConfigService.HARDWARE_INDEX_CHAT_SEND_REFRESH_DELAY_MS
      : 0;
    const startRefresh = () => {
      this.hardwareIndexBackgroundRefreshTimer = null;
      this.hardwareIndexBackgroundRefreshPromise = this.refreshHardwareIndexForAIInternal(normalizedReason)
        .catch(error => {
          console.warn('[ConfigService] 后台刷新 AI 硬件索引失败:', error);
        })
        .finally(() => {
          this.hardwareIndexBackgroundRefreshPromise = null;
        });
    };

    if (delayMs > 0) {
      this.hardwareIndexBackgroundRefreshTimer = setTimeout(startRefresh, delayMs);
      return;
    }

    startRefresh();
  }

  private async loadHardwareIndexForAIInternal(): Promise<void> {
    this.traceHardwareIndexRefresh('start loading hardware index');
    const configFilePath = window['path'].getAppDataPath();
    
    await Promise.all([
      this.loadAndCacheBoardIndex(configFilePath),
      this.loadAndCacheLibraryIndex(configFilePath)
    ]);
    
    this._hardwareIndexLoaded = true;
    this.hardwareIndexLastLoadedAt = Date.now();
    this.traceHardwareIndexRefresh('hardware index loaded', {
      boardCount: this.boardIndex?.length ?? 0,
      libraryCount: this.libraryIndex?.length ?? 0,
    });
  }

  private async refreshHardwareIndexForAIInternal(reason: string): Promise<void> {
    this.traceHardwareIndexRefresh('start background hardware refresh', {
      reason,
      alreadyLoaded: this._hardwareIndexLoaded,
      lastLoadedAt: this.hardwareIndexLastLoadedAt || null,
    });

    if (!this._hardwareIndexLoaded) {
      await this.loadHardwareIndexForAI();
      return;
    }

    const configFilePath = window['path'].getAppDataPath();
    await Promise.all([
      this.loadAndCacheBoardIndex(configFilePath),
      this.loadAndCacheLibraryIndex(configFilePath)
    ]);

    this.hardwareIndexLastLoadedAt = Date.now();
    this.traceHardwareIndexRefresh('background hardware refresh finished', {
      reason,
      boardCount: this.boardIndex?.length ?? 0,
      libraryCount: this.libraryIndex?.length ?? 0,
    });
  }

  private traceHardwareIndexRefresh(message: string, details?: Record<string, unknown>): void {
    try {
      const enabled = globalThis.localStorage?.getItem?.('aily.config.traceHardwareIndexRefresh') === '1'
        || (globalThis as Record<string, unknown>)['__AILY_CONFIG_TRACE_HARDWARE_INDEX_REFRESH__'] === true;
      if (!enabled) {
        return;
      }
      console.info(`[ConfigService][debug] ${message}`, details ?? {});
    } catch {
      // Debug tracing must never affect the chat submit hot path.
    }
  }

  /**
   * 检查硬件索引是否已加载
   */
  get isHardwareIndexLoaded(): boolean {
    return this._hardwareIndexLoaded;
  }

  private async loadAndCacheBoardIndex(configFilePath: string): Promise<void> {
    const localPath = `${configFilePath}/boards-index.json`;

    try {
      // 优先从本地缓存读取
      if (this.electronService.exists(localPath)) {
        this.boardIndex = this.parseBoardIndex(this.electronService.readFile(localPath));
        this.traceHardwareIndexRefresh('local board index loaded', { count: this.boardIndex?.length || 0 });
      }
      // 从远程加载最新数据
      const boardIndex = await this.loadBoardIndex();
      if (boardIndex.length > 0) {
        this.boardIndex = boardIndex;
        this.writeBoardIndexCache(localPath, boardIndex);
        this.traceHardwareIndexRefresh('remote board index loaded and cached', { count: boardIndex.length });
      }
    } catch (error) {
      console.error('[ConfigService] boards-index.json 加载失败，尝试从线上恢复:', error);
      await this.reloadBoardIndexFromRemote(localPath, error);
    }
  }

  private async loadAndCacheLibraryIndex(configFilePath: string): Promise<void> {
    const localPath = `${configFilePath}/libraries-index.json`;
    this.traceHardwareIndexRefresh('checking libraries index path', { localPath });

    try {
      // 优先从本地缓存读取
      if (this.electronService.exists(localPath)) {
        const fileContent = this.electronService.readFile(localPath);
        this.traceHardwareIndexRefresh('local libraries index file read', { byteLength: fileContent?.length || 0 });
        this.libraryIndex = this.parseLibraryIndex(fileContent);
        this.traceHardwareIndexRefresh('local library index loaded', { count: this.libraryIndex?.length || 0 });

        if (this.libraryIndex.length > 0) {
          const sample = this.libraryIndex[0];
          this.traceHardwareIndexRefresh('library index sample', {
            name: sample.name,
            displayName: sample.displayName,
            category: sample.category,
            hasNewFormat: !!(sample.displayName && sample.category && sample.supportedCores)
          });
        }
      } else {
        this.traceHardwareIndexRefresh('local libraries index file missing');
      }

      // 从远程加载最新数据
      const libraryIndex = await this.loadLibraryIndex();
      if (libraryIndex.length > 0) {
        this.libraryIndex = libraryIndex;
        this.writeLibraryIndexCache(localPath, libraryIndex);
        this.traceHardwareIndexRefresh('remote library index loaded and cached', { count: libraryIndex.length });
      }
    } catch (error) {
      console.error('[ConfigService] libraries-index.json 加载失败，尝试从线上恢复:', error);
      await this.reloadLibraryIndexFromRemote(localPath, error);
    }
  }

  private parseBoardIndex(raw: string): any[] {
    return this.parseArrayPayload(raw, 'boards-index.json 格式无效', 'boards');
  }

  private parseLibraryIndex(raw: string): any[] {
    return this.parseArrayPayload(raw, 'libraries-index.json 格式无效', 'libraries');
  }

  private writeBoardIndexCache(localPath: string, boardIndex: any[]): void {
    const cacheData = {
      version: '1.0.0',
      generated: new Date().toISOString(),
      count: boardIndex.length,
      boards: boardIndex
    };
    this.electronService.writeFile(localPath, JSON.stringify(cacheData));
  }

  private writeLibraryIndexCache(localPath: string, libraryIndex: any[]): void {
    const cacheData = {
      version: '1.0.0',
      generated: new Date().toISOString(),
      count: libraryIndex.length,
      libraries: libraryIndex
    };
    this.electronService.writeFile(localPath, JSON.stringify(cacheData));
  }

  private async fetchBoardIndexOrThrow(): Promise<any[]> {
    return this.fetchRemoteArrayOrThrow('/boards-index.json', '线上 boards-index.json 格式无效', 'boards');
  }

  private async fetchLibraryIndexOrThrow(): Promise<any[]> {
    return this.fetchRemoteArrayOrThrow('/libraries-index.json', '线上 libraries-index.json 格式无效', 'libraries');
  }

  private async reloadBoardIndexFromRemote(localPath: string, originalError: unknown): Promise<void> {
    try {
      const latestBoardIndex = await this.fetchBoardIndexOrThrow();
      this.boardIndex = latestBoardIndex;
      this.writeBoardIndexCache(localPath, latestBoardIndex);
      //console.log('[ConfigService] 已使用线上最新 boards-index.json 覆盖本地缓存');
    } catch (remoteError) {
      this.boardIndex = [];
      const message = this.getBoardIndexReloadFailureMessage(remoteError, originalError);
      console.error('[ConfigService] 从线上恢复 boards-index.json 失败:', remoteError);
      this.emitBoardIndexLoadError(message);
    }
  }

  private async reloadLibraryIndexFromRemote(localPath: string, originalError: unknown): Promise<void> {
    try {
      const latestLibraryIndex = await this.fetchLibraryIndexOrThrow();
      this.libraryIndex = latestLibraryIndex;
      this.writeLibraryIndexCache(localPath, latestLibraryIndex);
      //console.log('[ConfigService] 已使用线上最新 libraries-index.json 覆盖本地缓存');
    } catch (remoteError) {
      this.libraryIndex = [];
      const message = this.getLibraryIndexReloadFailureMessage(remoteError, originalError);
      console.error('[ConfigService] 从线上恢复 libraries-index.json 失败:', remoteError);
      this.emitLibraryIndexLoadError(message);
    }
  }

  private getBoardIndexReloadFailureMessage(remoteError: unknown, originalError: unknown): string {
    return this.buildReloadFailureMessage('开发板索引', 'boards-index.json', remoteError, originalError);
  }

  private getLibraryIndexReloadFailureMessage(remoteError: unknown, originalError: unknown): string {
    return this.buildReloadFailureMessage('扩展库索引', 'libraries-index.json', remoteError, originalError);
  }

  private emitBoardIndexLoadError(message: string): void {
    this.emitDedupedError('board-index', message);
  }

  private emitLibraryIndexLoadError(message: string): void {
    this.emitDedupedError('library-index', message);
  }

  private parseArrayPayload(raw: string, invalidMessage: string, wrapperKey?: string): any[] {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (wrapperKey && parsed && Array.isArray(parsed[wrapperKey])) {
      return parsed[wrapperKey];
    }
    throw new Error(invalidMessage);
  }

  private async fetchRemoteArrayOrThrow(pathname: string, invalidMessage: string, wrapperKey?: string): Promise<any[]> {
    const response: any = await this.fetchResourceJsonOrThrow(pathname);

    if (Array.isArray(response)) {
      return response;
    }
    if (wrapperKey && response && Array.isArray(response[wrapperKey])) {
      return response[wrapperKey];
    }

    throw new Error(invalidMessage);
  }

  private buildReloadFailureMessage(resourceLabel: string, fileName: string, remoteError: unknown, originalError: unknown): string {
    if (remoteError instanceof HttpErrorResponse) {
      if (remoteError.status === 0) {
        return `${resourceLabel}加载失败：网络连接异常，请检查网络或代理设置后重试。`;
      }

      return `${resourceLabel}加载失败：服务器返回 ${remoteError.status}，请稍后重试。`;
    }

    const remoteMessage = this.getErrorMessage(remoteError);
    if (/(network|timeout|failed to fetch|net::|offline)/i.test(remoteMessage)) {
      return `${resourceLabel}加载失败：网络连接异常，请检查网络或代理设置后重试。`;
    }

    const compactMessage = remoteMessage && remoteMessage.length <= 60 ? `：${remoteMessage}` : '，请稍后重试。';
    return `${resourceLabel}加载失败${compactMessage}`;
  }

  private emitDedupedError(key: string, message: string): void {
    const now = Date.now();
    const state = this.errorNoticeState[key];
    if (state?.message === message && now - state.at < ConfigService.ERROR_MESSAGE_DEDUP_MS) {
      return;
    }

    this.errorNoticeState[key] = { message, at: now };
    this.configNotice$.next({ key, type: 'error', message });
    console.warn('[ConfigService]', message);
  }

  async loadBoardIndex(): Promise<any[]> {
    try {
      return await this.fetchBoardIndexOrThrow();
    } catch (error) {
      console.warn('boards-index.json not available:', error);
      return [];
    }
  }

  async loadLibraryIndex(): Promise<any[]> {
    try {
      return await this.fetchLibraryIndexOrThrow();
    } catch (error) {
      console.warn('libraries-index.json not available:', error);
      return [];
    }
  }

  // examplesList;
  // async loadExamplesList() {
  //   this.examplesList = await lastValueFrom(
  //     this.http.get(this.getCurrentResourceUrl() + '/examples.json', {
  //       responseType: 'json',
  //     }),
  //   );
  //   return this.examplesList;
  // }

  /**
   * 记录开发板使用次数
   * @param boardName 开发板名称
   */
  recordBoardUsage(boardName: string) {
    if (!this.data.boardUsageCount) {
      this.data.boardUsageCount = {};
    }

    // 增加使用次数
    this.data.boardUsageCount[boardName] = (this.data.boardUsageCount[boardName] || 0) + 1;

    // 保存配置
    this.save();
  }

  /**
   * 获取开发板使用次数
   * @param boardName 开发板名称
   * @returns 使用次数
   */
  getBoardUsageCount(boardName: string): number {
    return this.data.boardUsageCount?.[boardName] || 0;
  }

  /**
   * 获取所有开发板的使用次数统计
   * @returns 使用次数统计对象
   */
  getAllBoardUsageCount(): Record<string, number> {
    return this.data.boardUsageCount || {};
  }

  /**
   * 根据使用次数对开发板列表进行排序
   * @param boardList 开发板列表
   * @returns 排序后的开发板列表
   */
  sortBoardsByUsage(boardList: any[]): any[] {
    const usageCount = this.getAllBoardUsageCount();

    return [...boardList].sort((a, b) => {
      const usageA = usageCount[a.name] || 0;
      const usageB = usageCount[b.name] || 0;

      // 首先按使用次数降序排列
      if (usageA !== usageB) {
        return usageB - usageA;
      }

      // 如果使用次数相同，按原来的顺序排列（保持稳定排序）
      return 0;
    });
  }

  // ==================== 库/开发板验证和模糊查询 ====================

  /**
   * 验证库是否存在，不存在则模糊查询
   * @param libraryName 库名称（可以是 name 或 nickname）
   * @returns 验证结果，包含是否存在、真实库数据、是否为模糊匹配
   */
  validateLibrary(libraryName: string): { exists: boolean; library: any | null; fuzzyMatch: boolean; originalQuery: string } {
    if (!libraryName) {
      return { exists: false, library: null, fuzzyMatch: false, originalQuery: libraryName };
    }

    const queryLower = libraryName.toLowerCase().trim();

    // 1. 精确匹配 name
    const exactMatch = this.libraryList.find(lib => 
      lib.name?.toLowerCase() === queryLower
    );
    if (exactMatch) {
      return { exists: true, library: exactMatch, fuzzyMatch: false, originalQuery: libraryName };
    }

    // 2. 精确匹配 nickname
    const nicknameMatch = this.libraryList.find(lib => 
      lib.nickname?.toLowerCase() === queryLower
    );
    if (nicknameMatch) {
      return { exists: true, library: nicknameMatch, fuzzyMatch: false, originalQuery: libraryName };
    }

    // 3. 模糊匹配 - 计算相似度并找最佳匹配
    const candidates = this.libraryList.map(lib => {
      const nameScore = calculateSimilarity(queryLower, lib.name?.toLowerCase() || '');
      const nicknameScore = calculateSimilarity(queryLower, lib.nickname?.toLowerCase() || '');
      
      // 关键词匹配 - 提高权重
      let keywordScore = 0;
      if (lib.keywords && Array.isArray(lib.keywords)) {
        // 提取查询中的关键词（去除特殊字符、分割、提取有意义的部分）
        const queryKeywords = extractKeywords(queryLower);
        
        for (const queryKw of queryKeywords) {
          for (const libKw of lib.keywords) {
            const libKwLower = libKw.toLowerCase();
            // 完全匹配
            if (libKwLower === queryKw) {
              keywordScore += 0.8;
            }
            // 包含关系
            else if (libKwLower.includes(queryKw) || queryKw.includes(libKwLower)) {
              keywordScore += 0.4;
            }
          }
        }
      }
      
      // 描述匹配
      let descriptionScore = 0;
      if (lib.description) {
        const descLower = lib.description.toLowerCase();
        const queryKeywords = extractKeywords(queryLower);
        for (const queryKw of queryKeywords) {
          if (descLower.includes(queryKw)) {
            descriptionScore += 0.3;
          }
        }
      }
      
      return {
        library: lib,
        score: Math.max(nameScore, nicknameScore) + keywordScore + descriptionScore
      };
    }).filter(c => c.score > 0.3)  // 相似度阈值
      .sort((a, b) => b.score - a.score);

    if (candidates.length > 0) {
      return { 
        exists: true, 
        library: candidates[0].library, 
        fuzzyMatch: true, 
        originalQuery: libraryName 
      };
    }

    return { exists: false, library: null, fuzzyMatch: false, originalQuery: libraryName };
  }

  /**
   * 验证开发板是否存在，不存在则模糊查询
   * @param boardName 开发板名称（可以是 name 或 nickname/displayName）
   * @returns 验证结果，包含是否存在、真实开发板数据、是否为模糊匹配
   */
  validateBoard(boardName: string): { exists: boolean; board: any | null; fuzzyMatch: boolean; originalQuery: string } {
    if (!boardName) {
      return { exists: false, board: null, fuzzyMatch: false, originalQuery: boardName };
    }

    const queryLower = boardName.toLowerCase().trim();

    // 1. 精确匹配 name
    const exactMatch = this.boardList.find(board => 
      board.name?.toLowerCase() === queryLower
    );
    if (exactMatch) {
      return { exists: true, board: exactMatch, fuzzyMatch: false, originalQuery: boardName };
    }

    // 2. 精确匹配 nickname/displayName
    const nicknameMatch = this.boardList.find(board => 
      board.nickname?.toLowerCase() === queryLower ||
      board.displayName?.toLowerCase() === queryLower
    );
    if (nicknameMatch) {
      return { exists: true, board: nicknameMatch, fuzzyMatch: false, originalQuery: boardName };
    }

    // 3. 模糊匹配 - 计算相似度并找最佳匹配
    const candidates = this.boardList.map(board => {
      const nameScore = calculateSimilarity(queryLower, board.name?.toLowerCase() || '');
      const nicknameScore = calculateSimilarity(queryLower, board.nickname?.toLowerCase() || '');
      const displayNameScore = calculateSimilarity(queryLower, board.displayName?.toLowerCase() || '');
      
      // 描述匹配
      let descriptionScore = 0;
      if (board.description) {
        const descLower = board.description.toLowerCase();
        const queryKeywords = extractKeywords(queryLower);
        for (const queryKw of queryKeywords) {
          if (descLower.includes(queryKw)) {
            descriptionScore += 0.3;
          }
        }
      }
      
      return {
        board: board,
        score: Math.max(nameScore, nicknameScore, displayNameScore) + descriptionScore
      };
    }).filter(c => c.score > 0.3)  // 相似度阈值
      .sort((a, b) => b.score - a.score);

    if (candidates.length > 0) {
      return { 
        exists: true, 
        board: candidates[0].board, 
        fuzzyMatch: true, 
        originalQuery: boardName 
      };
    }

    return { exists: false, board: null, fuzzyMatch: false, originalQuery: boardName };
  }

}

interface ResourceSourceConfig {
  key: string;
  name?: string;
  url: string;
  enabled?: boolean;
}

interface AppConfig {
  /** App version for which the managed aily tools were last refreshed. */
  installed?: string;

  /** 语言设置，例如 "zh_CN" */
  lang: string;

  /** UI主题 */
  theme: string;

  /** 字体设置 */
  font: string;

  /** 系统类型 */
  platform: string;

  /** 项目数据默认路径 */
  appdata_path: {
    win32: string;
    darwin: string;
    linux: string;
  }

  /** 项目默认路径 */
  project_path: string;

  /** 用户默认开发模式偏好：blockly 或 coder */
  developmentModePreference?: DevelopmentModePreference;

  /** 开发模式偏好来源 */
  developmentModePreferenceSource?: DevelopmentModePreferenceSource;

  /** 开发模式偏好更新时间 */
  developmentModePreferenceUpdatedAt?: number;

  /** 开发模式偏好首次提示时间 */
  developmentModePreferencePromptedAt?: number;

  /** 打包版型 */
  build_flavor?: string;

  /** 当前版型允许的官方区域 */
  official_region?: string;

  /** 当前选中的区域 */
  region: string;

  /** 当前选中的资源源，auto 表示自动模式 */
  resource_source?: string;

  /** 资源源列表 */
  resource_sources?: ResourceSourceConfig[];

  /** 区域配置 */
  regions: {
    [key: string]: {
      name: string;
      enabled?: boolean;
      official?: boolean;
      api_server: string;
      web?: string;
      ucenter_web?: string;
      tool_web: string;
      npm_registry: string;
      resource: string;
      updater: string;
    }
  };

  /** 更新包下载镜像策略 */
  update_download_strategy?: {
    enabled?: boolean;
    mirror_region_order?: string[];
    fallback_on_error?: boolean;
    first_byte_timeout_ms?: number;
    stall_timeout_ms?: number;
    low_speed_window_ms?: number;
    min_average_speed_bytes_per_second?: number;
  };

  /** 编译选项 */
  compile: {
    /** 是否显示详细日志 */
    verbose: boolean;
    /** 警告处理方式，如 "error" 表示将警告视为错误 */
    warnings: string;
  };

  /** 上传选项 */
  upload: {
    /** 是否显示详细日志 */
    verbose: boolean;
    /** 警告处理方式 */
    warnings: string;
  };

  devmode: {
    enabled: boolean;
    autoSave: boolean;
  };

  blockly: {
    renderer: string; // Blockly渲染器
  }

  /** Coder 模式开关（由 electron/config/config.json 控制） */
  coder?: {
    enabled?: boolean;
  };

  /** 串口监视器快速发送列表 */
  quickSendList?: Array<{ name: string, type: "signal" | "text" | "hex", data: string }>;

  /** 最近打开的项目列表 */
  recentlyProjects?: Array<{ name: string, path: string }>;

  /** 当前选择的语言 */
  selectedLanguage?: string;

  /** Header toolbar app ids saved by AppStoreService. */
  toolbarAppIds?: string[];

  /** 跳过更新的版本列表 */
  skippedVersions?: string[];

  /** 开发板使用次数统计 */
  boardUsageCount?: Record<string, number>;

  /** AI聊天模式 */
  aiChatMode?: 'agent' | 'ask' | 'edit';

  /** AI聊天当前自定义智能体目标 */
  aiChatCustomAgentTarget?: string;

  /** 串口监视器配置 */
  serialMonitor?: {
    /** 上次选择的串口 */
    port?: string;
    /** 上次选择的波特率 */
    baudRate?: string;
    /** 数据位 */
    dataBits?: string;
    /** 停止位 */
    stopBits?: string;
    /** 校验位 */
    parity?: string;
    /** 流控制 */
    flowControl?: string;
  };
}
