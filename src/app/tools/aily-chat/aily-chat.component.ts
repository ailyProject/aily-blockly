import { Component, ElementRef, ViewChild, ViewChildren, QueryList, OnDestroy, ChangeDetectorRef, ChangeDetectionStrategy } from '@angular/core';
import { NzInputModule } from 'ng-zorro-antd/input';
import { FormsModule } from '@angular/forms';
import { XDialogComponent } from './components/x-dialog/x-dialog.component';
import { DialogComponent } from './components/dialog/dialog.component';
import { ChatRenameDialogComponent } from './components/chat-rename-dialog/chat-rename-dialog.component';
import { ChatDeleteDialogComponent } from './components/chat-delete-dialog/chat-delete-dialog.component';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { UiService } from '../../services/ui.service';
import { NzResizableModule, NzResizeEvent } from 'ng-zorro-antd/resizable';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ChatService, ModelConfig } from './services/chat.service';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { MenuComponent } from '../../components/menu/menu.component';
import { IMenuItem } from '../../configs/menu.config';
import { McpService } from './services/mcp.service';
import { ProjectService } from '../../services/project.service';
import { CmdService } from '../../services/cmd.service';
import { CrossPlatformCmdService } from '../../services/cross-platform-cmd.service';
import { PlatformService } from '../../services/platform.service';
import { ElectronService } from '../../services/electron.service';
import { BuilderService } from '../../services/builder.service';
import { FetchToolService } from './tools/fetchTool';
import { WebSearchToolService } from './tools/webSearchTool';
import {
  getActiveWorkspace,
  configureBlockTool,
  deleteBlockTool,
  getWorkspaceOverviewTool,
  queryBlockDefinitionTool,
} from './tools/editBlockTool';
import { ConnectionGraphService } from '../../services/connection-graph.service';
import { NzModalService } from 'ng-zorro-antd/modal';
import { ConfigService } from '../../services/config.service';
import { AilyChatConfigService } from './services/aily-chat-config.service';
import { MERMAID_DARK_THEME, MermaidCodeComponent, clearMermaidCache } from 'ngx-x-markdown';
import './tools/registered/register-all';
import { AilyHost } from './core/host';
import { createElectronHostAdapter } from './adapters/electron-host-adapter';
import {
  formatSearchPattern as _formatSearchPattern,
  getLastFolderName as _getLastFolderName,
  getFileName as _getFileName,
  getUrlDisplayName as _getUrlDisplayName,
  getLibraryNickname as _getLibraryNickname,
} from './services/tool-display.service';
import {
  splitContent as _splitContent,
  getRandomString as _getRandomString,
} from './services/ui-helpers.service';
import { ScrollManagerService } from './services/scroll-manager.service';
import { ResourceManagerService } from './services/resource-manager.service';
import { MenuManagerService } from './services/menu-manager.service';
import { ChatEngineService } from './services/chat-engine.service';
import { EditCheckpointService } from './services/edit-checkpoint.service';
import { UnsavedEditsDialogComponent } from './components/unsaved-edits-dialog/unsaved-edits-dialog.component';

import { NzMessageService } from 'ng-zorro-antd/message';
import { AuthService } from '../../services/auth.service';
import { FloatingTodoComponent } from './components/floating-todo/floating-todo.component';
import { AilyEditsViewerComponent } from './components/aily-edits-viewer/aily-edits-viewer.component';
import { TodoUpdateService } from './services/todoUpdate.service';
import { ArduinoLintService } from './services/arduino-lint.service';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LoginComponent } from '../../components/login/login.component';
import { NoticeService } from '../../services/notice.service';
import { AilyChatSettingsComponent } from './components/settings/settings.component';
import { OnboardingService } from '../../services/onboarding.service';
import { AbsAutoSyncService } from './services/abs-auto-sync.service';
import { RepetitionDetectionService } from './services/repetition-detection.service';
import { ContextBudgetService } from './services/context-budget.service';
import { SubagentSessionService } from './services/subagent-session.service';
import { ChatHistoryService } from './services/chat-history.service';
import { ThemeService } from '../../services/theme.service';

// 共享类型从 core/chat-types.ts 导入并重新导出（保持向后兼容）
import { Tool, ResourceItem, ChatMessage, ToolCallState, ToolCallInfo } from './core/chat-types';
export type { Tool, ResourceItem, ChatMessage, ToolCallInfo };
export { ToolCallState };

// import { reloadAbiJsonTool, reloadAbiJsonToolSimple } from './tools';

@Component({
  selector: 'app-aily-chat',
  imports: [
    SubWindowComponent,
    NzInputModule,
    FormsModule,
    CommonModule,
    XDialogComponent,
    NzButtonModule,
    ToolContainerComponent,
    NzResizableModule,
    NzToolTipModule,
    MenuComponent,
    FloatingTodoComponent,
    AilyEditsViewerComponent,
    TranslateModule,
    LoginComponent,
    AilyChatSettingsComponent
  ],
  templateUrl: './aily-chat.component.html',
  styleUrl: './aily-chat.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ScrollManagerService, ResourceManagerService, MenuManagerService, EditCheckpointService, ChatEngineService],
})
export class AilyChatComponent implements OnDestroy {
  options = {
    autoHide: true,
    clickOnTrack: true,
    scrollbarMinSize: 50,
  };

  @ViewChild('chatContainer') chatContainer: ElementRef;
  @ViewChild('chatList') chatList: ElementRef;
  @ViewChild('chatTextarea') chatTextarea: ElementRef;
  @ViewChildren(XDialogComponent) xDialogComponents: QueryList<XDialogComponent>;

  // ==================== Engine 状态代理（模板绑定） ====================

  get list() { return this.engine.list; }
  set list(val) { this.engine.list = val; }

  get isWaiting() { return this.engine.isWaiting; }

  get isCompleted() { return this.engine.isCompleted; }
  set isCompleted(val) { this.engine.isCompleted = val; }

  get isLoggedIn() { return this.engine.isLoggedIn; }

  get inputValue() { return this.engine.inputValue; }
  set inputValue(val) { this.engine.inputValue = val; }

  get sessionId() { return this.engine.sessionId; }

  get sessionTitle() { return this.engine.sessionTitle; }

  get currentMode() { return this.engine.currentMode; }

  get currentModel() { return this.engine.currentModel; }

  get currentModelName() { return this.engine.currentModelName; }

  get contextBudget$() { return this.engine.contextBudget$; }

  get contextBudgetSnapshot() { return this.engine.contextBudgetSnapshot; }

  get debug() { return this.engine.debug; }

  get prjPath() { return this.engine.prjPath; }

  get prjRootPath() { return this.engine.prjRootPath; }

  get currentUrl() { return this._currentUrl; }
  private _currentUrl: string;

  bottomHeight = 180;
  showSettings = false;

  constructor(
    private uiService: UiService,
    private chatService: ChatService,
    private mcpService: McpService,
    private projectService: ProjectService,
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private blocklyService: BlocklyService,
    private fetchToolService: FetchToolService,
    private webSearchToolService: WebSearchToolService,
    private router: Router,
    private message: NzMessageService,
    private authService: AuthService,
    private modal: NzModalService,
    private configService: ConfigService,
    private todoUpdateService: TodoUpdateService,
    private arduinoLintService: ArduinoLintService,
    private translate: TranslateService,
    private noticeService: NoticeService,
    private platformService: PlatformService,
    private electronService: ElectronService,
    private ailyChatConfigService: AilyChatConfigService,
    private onboardingService: OnboardingService,
    private absAutoSyncService: AbsAutoSyncService,
    private connectionGraphService: ConnectionGraphService,
    private repetitionDetectionService: RepetitionDetectionService,
    private contextBudgetService: ContextBudgetService,
    private subagentSessionService: SubagentSessionService,
    private chatHistoryService: ChatHistoryService,
    private cdr: ChangeDetectorRef,
    private builderService: BuilderService,
    public engine: ChatEngineService,
    public scrollManager: ScrollManagerService,
    public resourceManager: ResourceManagerService,
    public menuManager: MenuManagerService,
    private themeService: ThemeService,
  ) {
    // 注册 OnPush CD 回调 — viewAdapter 每次 flush/appendImmediate 后调用 markForCheck
    this.engine.setCdCallback(() => this.cdr.markForCheck());
  }

  ngOnInit() {
    // 初始化宿主环境适配器
    if (!AilyHost.isInitialized()) {
      AilyHost.init(createElectronHostAdapter({
        projectService: this.projectService,
        configService: this.configService,
        authService: this.authService,
        builderService: this.builderService,
        platformService: this.platformService,
        noticeService: this.noticeService,
        blocklyService: this.blocklyService,
        connectionGraphService: this.connectionGraphService,
        cmdService: this.cmdService,
        crossPlatformCmdService: this.crossPlatformCmdService,
        absAutoSyncService: this.absAutoSyncService,
        fetchToolService: this.fetchToolService,
        webSearchToolService: this.webSearchToolService,
        electronService: this.electronService,
        uiService: this.uiService,
        onboardingService: this.onboardingService,
      }));
    }

    // 初始化 路由 URL
    this._currentUrl = this.router.url;

    // 初始化 MermaidCodeComponent
    import('mermaid').then(m => {
      const mermaidConfig = this.themeService.theme() === 'dark'
        ? { startOnLoad: false, ...MERMAID_DARK_THEME }
        : { startOnLoad: false, theme: 'default' };
      MermaidCodeComponent.setMermaidInstance(m.default, mermaidConfig);
    });

    // 设置全局工具引用，供测试和调试使用
    (window as any)['editBlockTool'] = {
      getActiveWorkspace,
      configureBlockTool,
      deleteBlockTool,
      getWorkspaceOverviewTool,
      queryBlockDefinitionTool,
    };

    // 初始化引擎（订阅、路径等）
    this.engine.init(this.chatTextarea);
  }

  // ===== 编辑消息事件处理 =====

  async onEditAndResend(event: { msgIndex: number; newText: string; resources: any[] }): Promise<void> {
    await this.engine.editAndResendFromTurn(event.msgIndex, event.newText, event.resources);
  }

  onEditModeToggle(event: { event: MouseEvent; type: string }): void {
    this.menuManager.toggleModeMenu(event.event);
  }

  onEditModelToggle(event: { event: MouseEvent; type: string }): void {
    this.menuManager.toggleModelMenu(event.event, this.ModelList.length);
  }

  async onEditAddFile(msgIndex: number): Promise<void> {
    const options = {
      title: '选择文件',
      properties: ['multiSelections'],
      filters: [{ name: '所有文件', extensions: ['*'] }]
    };
    const result = await AilyHost.get().dialog.selectFiles(options);
    if (!result.canceled && result.filePaths?.length > 0) {
      const dialog = this.xDialogComponents?.find(d => d.msgIndex === msgIndex);
      if (dialog) {
        result.filePaths.forEach(path => {
          const fileName = path.split(/[/\\]/).pop() || path;
          dialog.addEditResource({ type: 'file', path, name: fileName });
        });
      }
    }
  }

  async onEditAddFolder(msgIndex: number): Promise<void> {
    const options = {
      title: '选择文件夹',
      properties: ['openDirectory']
    };
    const result = await AilyHost.get().dialog.selectFiles(options);
    if (!result.canceled && result.filePaths?.length > 0) {
      const dialog = this.xDialogComponents?.find(d => d.msgIndex === msgIndex);
      if (dialog) {
        const selectedPath = result.filePaths[0];
        const folderName = selectedPath.split(/[/\\]/).pop() || selectedPath;
        dialog.addEditResource({ type: 'folder', path: selectedPath, name: folderName });
      }
    }
  }

  ngAfterViewInit(): void {
    this.scrollManager.setContainer(this.chatContainer);
    this.engine.refreshHistoryList();
    this.scrollManager.scrollToBottom();
  }

  ngOnDestroy() {
    this.engine.destroy();
  }

  // ==================== UI 事件处理器 ====================

  // --- @agent 自动补全 ---
  showAgentSuggestions = false;
  agentSuggestions: string[] = [];
  private allAgents: string[] = [];

  /** 处理输入变化，检测 @mention */
  onInputChange(): void {
    const val = this.engine.inputValue;
    if (val.startsWith('@')) {
      if (this.allAgents.length === 0) {
        this.allAgents = SubagentSessionService.getAvailableAgents();
      }
      const query = val.slice(1).split(/\s/)[0].toLowerCase();
      this.agentSuggestions = this.allAgents.filter(a => a.toLowerCase().startsWith(query));
      this.showAgentSuggestions = this.agentSuggestions.length > 0 && !val.includes(' ');
    } else {
      this.showAgentSuggestions = false;
    }
  }

  /** 选中 agent 自动补全 */
  selectAgent(agentName: string): void {
    this.engine.inputValue = `@${agentName} `;
    this.showAgentSuggestions = false;
    setTimeout(() => {
      if (this.chatTextarea?.nativeElement) {
        this.chatTextarea.nativeElement.focus();
      }
    });
  }

  async sendButtonClick(): Promise<void> {
    this.scrollManager.autoScrollEnabled = true;
    this.scrollManager.scrollToBottom();
    if (this.engine.isWaiting) {
      this.engine.stop();
      return;
    }
    await this.engine.send('user', this.engine.inputValue.trim(), true);
    this.resourceManager.mergePathsTo(this.engine.sessionAllowedPaths);
    this.resourceManager.items = [];
    this.engine.inputValue = '';
  }

  async onKeyDown(event: KeyboardEvent) {
    // @agent 补全交互：Enter 选中、Escape 关闭
    if (this.showAgentSuggestions) {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.selectAgent(this.agentSuggestions[0]);
        return;
      }
      if (event.key === 'Escape') {
        this.showAgentSuggestions = false;
        event.preventDefault();
        return;
      }
    }

    if (event.key === 'Enter') {
      if (event.ctrlKey) {
        const textarea = event.target as HTMLTextAreaElement;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        this.inputValue = this.inputValue.substring(0, start) + '\n' + this.inputValue.substring(end);
        setTimeout(() => { textarea.selectionStart = textarea.selectionEnd = start + 1; }, 0);
        event.preventDefault();
      } else {
        this.scrollManager.autoScrollEnabled = true;
        this.scrollManager.scrollToBottom();
        if (this.engine.isWaiting) return;
        await this.engine.send('user', this.engine.inputValue.trim(), true);
        this.resourceManager.mergePathsTo(this.engine.sessionAllowedPaths);
        this.resourceManager.items = [];
        this.engine.inputValue = '';
        event.preventDefault();
      }
    }
  }

  async close() {
    AilyHost.get().ui?.closeTool('aily-chat');
  }

  onContentResize({ height }: NzResizeEvent): void {
    this.bottomHeight = height!;
  }

  menuClick(e) {
    if (this.engine.editCheckpointService.hasUnsavedEdits()) {
      this.confirmUnsavedEditsBeforeSwitch(() => {
        this.doSwitchSession(e.sessionId);
      });
      return;
    }
    this.doSwitchSession(e.sessionId);
  }

  private doSwitchSession(sessionId: string) {
    this.menuManager.switchToSession(sessionId, this.chatService.currentSessionId, {
      onSaveCurrentSession: () => this.engine.saveCurrentSession(),
      onGetHistory: () => this.engine.getHistory(),
      onSetCompleted: () => { this.engine.isCompleted = true; },
      onSetServerSessionInactive: () => this.engine.setServerSessionInactive(),
    });
  }

  openHistoryChat() {
    this.engine.refreshHistoryList();
    this.menuManager.openHistoryChat();
  }

  historyActionClick(e: { action: string; data: any }) {
    this.menuManager.historyActionClick(e, this.engine.sessionId, {
      onGetHistory: () => this.engine.getHistory(),
      onNewChat: () => this.engine.newChat(),
      onDetectChanges: () => this.cdr.markForCheck(),
      onUpdateTitle: (title: string) => { this.chatService.currentSessionTitle = title; },
      onRefreshHistory: () => this.engine.refreshHistoryList(),
    });
  }

  modeMenuClick(item: IMenuItem) {
    if (item.data?.mode && item.data.mode !== this.currentMode) {
      this.engine.switchToMode(item.data.mode);
    }
    this.menuManager.showMode = false;
  }

  modelMenuClick(item: IMenuItem) {
    if (item.data?.model && item.data.model.model !== this.currentModel?.model) {
      this.engine.switchToModel(item.data.model);
    }
    this.menuManager.showModelMenu = false;
  }

  openSettings(event) {
    this.showSettings = !this.showSettings;
  }

  onSettingsSaved() {
    this.showSettings = false;
  }

  newChat() {
    if (this.engine.editCheckpointService.hasUnsavedEdits()) {
      this.confirmUnsavedEditsBeforeSwitch(() => {
        this.engine.newChat();
      });
      return;
    }
    this.engine.newChat();
  }

  /**
   * 切换会话/新建会话前，提示用户处理未保留的文件变更。
   * - 保留：acceptAllAsBaseline + 保存会话 + 继续
   * - 放弃：撤销所有变更到初始状态 + 继续
   * - 取消（关闭弹窗）：中止操作
   */
  private confirmUnsavedEditsBeforeSwitch(onConfirm: () => void): void {
    const summary = this.engine.editCheckpointService.getEditsSummary();
    if (!summary || summary.fileCount === 0) {
      // 无实际文件变更差异 — 自动标记为已保留并继续
      this.engine.editCheckpointService.acceptAllAsBaseline();
      this.engine.editCheckpointService.dismissSummary();
      onConfirm();
      return;
    }

    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: { padding: '0' },
      nzWidth: 340,
      nzContent: UnsavedEditsDialogComponent,
      nzData: { fileCount: summary.fileCount },
    });

    modalRef.afterClose.subscribe((action: string | null) => {
      if (action === 'keep') {
        // 保留变更：accept as baseline + save
        this.engine.editCheckpointService.acceptAllAsBaseline();
        this.engine.editCheckpointService.dismissSummary();
        this.engine.saveCurrentSession();
        onConfirm();
      } else if (action === 'discard') {
        // 放弃变更：undo all back to initial state
        while (this.engine.editCheckpointService.canUndo) {
          this.engine.editCheckpointService.undo();
        }
        this.engine.editCheckpointService.dismissSummary();
        this.engine.saveCurrentSession();
        onConfirm();
      }
      // null = 取消（关闭弹窗），不做任何操作
    });
  }

  // ==================== 模板辅助 ====================

  get ModeList(): IMenuItem[] {
    return [
      {
        name: this.translate.instant('AILY_CHAT.MODE_AGENT_FULL'),
        action: 'agent-mode',
        icon: 'fa-light fa-user-astronaut',
        data: { mode: 'agent' }
      },
      {
        name: this.translate.instant('AILY_CHAT.MODE_QA_FULL'),
        action: 'qa-mode',
        icon: 'fa-light fa-comment-smile',
        data: { mode: 'qa' }
      }
    ];
  }

  get ModelList(): IMenuItem[] {
    const enabledModels = this.ailyChatConfigService.getEnabledModels();
    return enabledModels.map(model => ({
      name: model.name,
      action: 'select-model',
      data: { model }
    }));
  }

  splitContent(content: any) { return _splitContent(content); }
  getRandomString() { return _getRandomString(); }
  getLastFolderName(path: string): string { return _getLastFolderName(path); }
  getFileName(path: string): string { return _getFileName(path); }
  getUrlDisplayName(url: string): string { return _getUrlDisplayName(url); }
  async getLibraryNickname(path: string): Promise<string> { return _getLibraryNickname(path); }
  formatSearchPattern(pattern: string, maxLength: number = 30): string { return _formatSearchPattern(pattern, maxLength); }
  getProjectRootPath(): string { return AilyHost.get().project.projectRootPath; }
  getCurrentProjectPath(): string { return this.engine.getCurrentProjectPath(); }
  getCurrentProjectLibrariesPath(): string {
    const cpp = this.getCurrentProjectPath();
    return cpp !== '' ? cpp + '/node_modules/@aily-project' : '';
  }

  demandEdit() { }


  openUrl(url: string = 'https://aily.pro/doc/ai-usage-guide') {
    this.electronService.openUrl(url);
  }
}
