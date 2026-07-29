/* 这个服务用来控制窗口、工具的显示和隐藏，通过 Subject 来实现组件之间的通信。
 */
import { Injectable, Injector } from '@angular/core';
import { filter, Observable, Subject } from 'rxjs';
import { ChatService } from '../tools/aily-chat/services/chat.service';
import { ElectronService } from './electron.service';
import { TerminalService } from '../tools/terminal/terminal.service';
import { Router } from '@angular/router';
import { FeedbackDialogComponent } from '../components/feedback-dialog/feedback-dialog.component';
import { NzModalService } from 'ng-zorro-antd/modal';
import { ProjectSettingDialogComponent } from '../components/project-setting-dialog/project-setting-dialog.component';
import { AuthService } from './auth.service';
import { LogService } from './log.service';
import { getChildToolConfig } from '../configs/tool.config';
import { ConfigService } from './config.service';
import { BoardSelectorDialogComponent } from '../main-window/components/board-selector-dialog/board-selector-dialog.component';

const AILY_CHAT_TOOL_IDS = new Set(['aily-chat', 'aily-chat-react']);

@Injectable({
  providedIn: 'root',
})
export class UiService {
  // 用来控制窗口和工具的显示和隐藏
  actionSubject = new Subject();

  // 用来更新footer右下角的状态
  stateSubject = new Subject<ActionState>();

  // 用来记录当前已打开的工具
  openToolList: string[] = [];

  openWindowPathList: string[] = [];

  // 用来获取当前最上层的工具
  get topTool() {
    return this.openToolList[this.openToolList.length - 1] || null;
  }

  // 用来记录terminal是否打开
  terminalIsOpen = false;
  // 当前选中的底部面板tab
  currentBottomTab = '';
  theme = 'dark';
  isMainWindow = false;

  private modalService: NzModalService | null = null;


  constructor(
    private electronService: ElectronService,
    private terminalService: TerminalService,
    private router: Router,
    private authService: AuthService,
    private logService: LogService,
    private configService: ConfigService,
    private injector: Injector,
    private chatService: ChatService,
  ) { }

  private get modal(): NzModalService {
    if (!this.modalService) {
      this.modalService = this.injector.get(NzModalService);
    }
    return this.modalService;
  }


  // 初始化UI服务，这个init函数仅供main-window使用
  init(): void {
    // 注册 window 全局方法，供非 Angular 环境调用
    (window as any).openAndSendToAilyChat = (text: string, options?: Record<string, any>) => {
      this.openAndSendToChat(text, options);
    };
    if (this.electronService.isElectron) {
      this.isMainWindow = true;
      window['ipcRenderer'].on('window-go-main', (event, toolName) => {
        this.openToolInMainWindow(this.resolveToolNameFromWindowPath(toolName));
      });

      window['ipcRenderer'].on('sub-window-state-changed', (_event, state) => {
        this.updateSubWindowState(state?.path, !!state?.open);
      });

      window['ipcRenderer'].on('window-receive', async (event, message) => {
        // console.log('window-receive', message);
        let data;
        if (message.data?.action === 'logout') {
          // 处理登出请求
          try {
            await this.authService.logout();
            data = { success: true };
          } catch (error) {
            console.error('登出失败:', error);
            data = { success: false, error: error.message };
          }
        } else if (message.data?.action === 'log') {
          // 处理子窗口发来的日志
          this.logService.update(message.data.log);
          data = { success: true };
        } else if (message.data?.action === 'get-build-path') {
          // 返回当前项目的构建缓存路径
          try {
            const { ProjectService } = await import('./project.service');
            const projectService = this.injector.get(ProjectService);
            if (projectService.currentProjectPath) {
              const buildPath = await projectService.getBuildPath();
              data = { success: true, buildPath };
            } else {
              data = { success: true, buildPath: null };
            }
          } catch (error) {
            data = { success: true, buildPath: null };
          }
        }
        // if (message.data.action == 'open-terminal') {
        //   data = await this.openTerminal();
        //   // console.log('open-terminal', pid);
        // } else if (message.data.action == 'close-terminal') {
        //   this.closeTerminal();
        // } else {
        //   return;
        // }
        // 反馈完成结果
        if (message.messageId) {
          window['ipcRenderer'].send('main-window-response', {
            messageId: message.messageId,
            result: "success",
            data,
          });
        }
      });
    }

  }

  openWindow(opt: WindowOpts) {
    this.updateSubWindowState(opt.path, true);
    window['subWindow'].open(opt);
  }

  openToolWindow(name: string, options?: Omit<WindowOpts, 'path'>) {
    const toolWindowPath = this.getToolWindowPath(name);
    if (!toolWindowPath) {
      return false;
    }

    this.openWindow({
      path: toolWindowPath.replace(/^\/+/, ''),
      title: options?.title || name,
      width: options?.width ?? 1200,
      height: options?.height ?? 800,
      ...(options?.x !== undefined ? { x: options.x } : {}),
      ...(options?.y !== undefined ? { y: options.y } : {}),
      ...(options?.displayId !== undefined ? { displayId: options.displayId } : {}),
      relativeToDisplay: options?.relativeToDisplay !== false,
      clampToWorkArea: options?.clampToWorkArea !== false,
      applyInitialBounds: options?.applyInitialBounds === true,
    });
    return true;
  }

  // 这个方法是给header用的
  turnTool(opt: ToolOpts) {
    if (this.topTool == opt.data) {
      this.closeTool(opt.data);
    } else {
      this.openTool(opt.data);
    }
  }

  // 如果其它组件/程序要打开工具，调用这个方法
  openTool(name: string) {
    // if (name == 'terminal') {
    //   this.openTerminal();
    //   return;
    // }
    const toolWindowPath = this.getToolWindowPath(name);
    if (this.isMainWindow && toolWindowPath && window['subWindow']?.focus) {
      void window['subWindow'].focus(toolWindowPath)
        .then((focused: boolean) => {
          if (!focused) {
            this.openToolInMainWindow(name);
          }
        })
        .catch(() => this.openToolInMainWindow(name));
      return;
    }

    this.openToolInMainWindow(name);
  }

  /**
   * Open a tool in the main-window embedded stack without first attempting
   * to focus a detached child window. Host automation has already resolved
   * the requested presentation mode before calling this method.
   */
  openToolEmbedded(name: string): boolean {
    this.openToolInMainWindow(name);
    return this.topTool === name;
  }

  private openToolInMainWindow(name: string) {
    if (!name) {
      return;
    }
    this.openToolList = this.openToolList.filter((e) => e !== name);
    this.openToolList.push(name);
    this.actionSubject.next({ action: 'open', type: 'tool', data: name });
  }

  private resolveToolNameFromWindowPath(pathOrName: string | null | undefined): string {
    const normalizedPath = this.normalizeToolWindowPath(pathOrName);
    if (!normalizedPath) {
      return '';
    }

    const childToolMatch = normalizedPath.match(/^\/child-tool\/([^/?#]+)/);
    if (childToolMatch?.[1]) {
      return decodeURIComponent(childToolMatch[1]);
    }

    return normalizedPath.replace(/^\/+/, '');
  }

  private getToolWindowPath(name: string): string | null {
    const childToolConfig = getChildToolConfig(name);
    if (childToolConfig) {
      return childToolConfig.routePath || `/child-tool/${childToolConfig.id}`;
    }

    switch (name) {
      case 'code-viewer':
      case 'serial-monitor':
      case 'ffs-manager':
      case 'model-store':
        return `/${name}`;
      default:
        return null;
    }
  }

  private normalizeToolWindowPath(path: string | null | undefined): string | null {
    if (typeof path !== 'string') {
      return null;
    }
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      return null;
    }
    const hashRouteIndex = trimmedPath.indexOf('#/');
    const routePath = hashRouteIndex >= 0 ? trimmedPath.slice(hashRouteIndex + 2) : trimmedPath;
    return `/${routePath.replace(/^\/+/, '')}`;
  }

  private updateSubWindowState(path: string | null | undefined, open: boolean) {
    const normalizedPath = this.normalizeToolWindowPath(path);
    if (!normalizedPath) {
      return;
    }

    const isOpen = this.openWindowPathList.includes(normalizedPath);
    if (open && !isOpen) {
      this.openWindowPathList.push(normalizedPath);
      this.actionSubject.next({ action: 'open', type: 'sub-window', data: normalizedPath });
    } else if (!open && isOpen) {
      this.openWindowPathList = this.openWindowPathList.filter((path) => path !== normalizedPath);
      this.actionSubject.next({ action: 'close', type: 'sub-window', data: normalizedPath });
    }
  }

  private isToolWindowOpen(name: string): boolean {
    const toolWindowPath = this.getToolWindowPath(name);
    if (!toolWindowPath) {
      return false;
    }

    const normalizedPath = this.normalizeToolWindowPath(toolWindowPath);
    return !!normalizedPath && this.openWindowPathList.includes(normalizedPath);
  }

  closeTool(name: string) {
    if (name == 'terminal') {
      this.closeTerminal();
      return;
    }
    this.openToolList = this.openToolList.filter((e) => e !== name);
    this.actionSubject.next({ action: 'close', type: 'tool', data: name });
  }

  closeToolAll() {
    this.openToolList.forEach((name) => {
      this.closeTool(name);
    });
    this.openToolList = [];
  }

  // 发送工具信号，格式为 "toolname:action"，如 "serial-monitor:disconnect"
  sendToolSignal(signal: string, payload?: unknown) {
    this.actionSubject.next({ action: 'signal', type: 'tool', data: signal, payload });
  }

  /**
   * 打开 aily-chat 面板并发送消息。
   * 标准接口：任何需要「代为向大模型发送消息」的场景，统一调用此方法。
   * 输入通过 ChatService 的单一路径缓冲，聊天面板挂载后由
   * ChatExternalInputCoordinator 进入统一提交管线。
   *
   * @param text 要发送的文本内容
   * @param options 发送选项，如 { autoSend: true, cover: true }
   */
  openAndSendToChat(text: string, options?: Record<string, any>): void {
    const targetToolId = this.resolveMostRecentlyUsedAilyChatTool() || 'aily-chat';
    this.openTool(targetToolId);
    console.info('[AilyChat][ExternalInputDelivery]', {
      phase: 'deliver',
      target: targetToolId,
      textLength: typeof text === 'string' ? text.length : 0,
      autoSend: options?.['autoSend'] === true,
    });
    if (targetToolId === 'aily-chat') {
      this.chatService.sendTextToChat(text, options);
      return;
    }

    this.sendToolSignal(`${targetToolId}:external-input`, {
      targetToolId,
      text,
      options: options || {},
    });
  }

  private resolveMostRecentlyUsedAilyChatTool(): string | null {
    if (this.topTool && AILY_CHAT_TOOL_IDS.has(this.topTool)) {
      return this.topTool;
    }
    for (let index = this.openToolList.length - 1; index >= 0; index -= 1) {
      const toolId = this.openToolList[index];
      if (AILY_CHAT_TOOL_IDS.has(toolId)) {
        return toolId;
      }
    }
    return null;
  }

  openCodeEditorFile(
    projectPath: string,
    filePath: string,
    position?: {
      lineNumber?: number;
      column?: number;
      line?: number;
      character?: number;
    },
  ): Promise<boolean> {
    const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
    const normalizedFilePath = typeof filePath === 'string' ? filePath.trim() : '';
    if (!normalizedProjectPath || !normalizedFilePath) {
      return Promise.resolve(false);
    }

    const lineNumber = typeof position?.lineNumber === 'number'
      ? position.lineNumber
      : typeof position?.line === 'number'
        ? position.line + 1
        : undefined;
    const column = typeof position?.column === 'number'
      ? position.column
      : typeof position?.character === 'number'
        ? position.character + 1
        : undefined;

    const queryParams: Record<string, string | number> = {
      path: normalizedProjectPath,
      openFile: normalizedFilePath,
    };
    if (typeof lineNumber === 'number' && Number.isFinite(lineNumber) && lineNumber > 0) {
      queryParams['lineNumber'] = lineNumber;
    }
    if (typeof column === 'number' && Number.isFinite(column) && column > 0) {
      queryParams['column'] = column;
    }

    return this.router.navigate(['/main/code-editor'], {
      queryParams,
      replaceUrl: true,
    });
  }

  // 判断某个工具是否打开
  isToolOpen(name: string): boolean {
    return this.openToolList.includes(name) || this.isToolWindowOpen(name);
  }

  turnBottomSider(data = 'default') {
    if (this.terminalIsOpen && this.currentBottomTab === data) {
      // 如果底部面板已经打开且当前选中的就是要打开的tab，则关闭面板
      this.closeTerminal();
    } else if (this.terminalIsOpen) {
      // 如果底部面板已经打开但选中的不是要打开的tab，则切换到指定的tab
      this.switchBottomSiderTab(data);
    } else {
      // 如果底部面板未打开，则打开面板并显示指定的组件
      this.openBottomSider(data);
    }
  }

  // 切换底部面板的tab
  switchBottomSiderTab(data: string) {
    this.currentBottomTab = data;
    if (this.isMainWindow) {
      this.actionSubject.next({ action: 'switch-tab', type: 'bottom-sider', data });
    } else {
      window['iWindow'].send({ to: 'main', data: { action: 'switch-terminal-tab', tab: data } });
    }
  }

  async openBottomSider(data = 'default'): Promise<{ pid: number }> {
    return new Promise(async (resolve, reject) => {
      this.currentBottomTab = data;
      if (this.isMainWindow) {
        this.actionSubject.next({ action: 'open', type: 'bottom-sider', data });
        this.terminalIsOpen = true;
        const intervalId = setInterval(() => {
          if (this.terminalService.currentPid) {
            clearInterval(intervalId);
            resolve({ pid: this.terminalService.currentPid });
          }
        }, 100);
      } else {
        // 其它窗口调用
        let { pid } = await window['iWindow'].send({ to: 'main', data: { action: 'open-terminal' } });
        // console.log('open-terminal', pid);
        resolve({ pid });
      }
    });
  }

  closeTerminal() {
    if (this.isMainWindow) {
      this.actionSubject.next({ action: 'close', type: 'bottom-sider' });
      this.terminalIsOpen = false;
      this.currentBottomTab = '';
    } else {
      window['iWindow'].send({ to: 'main', data: { action: 'close-terminal' } });
    }
  }

  // 更新footer右下角的状态
  updateFooterState(state: ActionState) {
    // 判断当前url是否是main-window
    if (this.isMainWindow || !window['ipcRenderer']?.send) {
      this.stateSubject.next(state);
    } else {
      window['ipcRenderer'].send('state-update', state);
    }
  }

  // 关闭当前窗口
  closeWindow() {
    window['iWindow'].close();
  }


  openFeedback(data?: any) {
    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzCentered: true,
      nzWrapClassName: 'feedback-modal-wrap',
      nzBodyStyle: {
        padding: '0',
      },
      nzContent: FeedbackDialogComponent,
      nzWidth: '520px',
      nzData: data,
    });

    // 处理反馈结果
    modalRef.afterClose.subscribe(result => {
      if (result?.result === 'success') {
        console.log('反馈已提交:', result.data);
      }
    });
  }

  openProjectSettings() {
    // 这里参考 USAGE_EXAMPLE.ts 中的代码实现
    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: {
        padding: '0',
      },
      nzContent: ProjectSettingDialogComponent,
      nzWidth: '520px',
    });

    // 处理反馈结果
    modalRef.afterClose.subscribe(result => {
      if (result?.result === 'success') {
        console.log('反馈已提交:', result.data);
      }
    });
  }

  /** 打开切换开发板弹窗（Header 菜单与 Aily View MCU 节点共用） */
  async openBoardSelector(): Promise<void> {
    const { ProjectService } = await import('./project.service');
    const projectService = this.injector.get(ProjectService);
    const useCoderBoardList = projectService.isAilyCodeProject();

    // Aily Code 使用 coder_board_index；Blockly 使用 boards.json
    let boardList = useCoderBoardList
      ? this.configService.getCoderBoardListForSelector()
      : this.configService.getBoardListForSelector();
    if (!boardList.length) {
      boardList = useCoderBoardList
        ? await this.configService.loadCoderBoardList()
        : await this.configService.loadBoardList();
    }

    this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: {
        padding: '0',
      },
      nzWidth: '400px',
      nzContent: BoardSelectorDialogComponent,
      nzData: {
        boardList,
        isAilyCode: useCoderBoardList,
      },
    });
  }
}

export interface WindowOpts {
  /** 子窗口业务标识，如 settings-open / project-new，与 preload 路由一致 */
  type?: string;
  path: string;
  data?: any;
  title?: string;
  alwaysOnTop?: boolean;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  displayId?: string | number;
  relativeToDisplay?: boolean;
  clampToWorkArea?: boolean;
  /** 复用现有窗口时，是否应用本次携带的位置与尺寸。 */
  applyInitialBounds?: boolean;
}

export interface ToolOpts {
  type: string;
  data: string;
  title?: string;
}

export interface ActionState {
  text: string;
  desc?: string;
  state?: 'done' | 'doing' | 'error' | 'warn' | 'loading' | string,
  color?: string;
  icon?: string;
  timeout?: number;
}
