import { Component, ElementRef, ViewChild, OnDestroy } from '@angular/core';
import { NzInputModule } from 'ng-zorro-antd/input';
import { FormsModule } from '@angular/forms';
import { DialogComponent } from './components/dialog/dialog.component';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { UiService } from '../../services/ui.service';
import { NzResizableModule, NzResizeEvent } from 'ng-zorro-antd/resizable';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { ChatService, ChatTextOptions } from './services/chat.service';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { MenuComponent } from '../../components/menu/menu.component';
import { IMenuItem } from '../../configs/menu.config';
import { McpService } from './services/mcp.service';
import { ProjectService } from '../../services/project.service';
import { CmdService } from '../../services/cmd.service';
import { newProjectTool } from './tools/createProjectTool';
import { executeCommandTool } from './tools/executeCommandTool';
import { askApprovalTool } from './tools/askApprovalTool';
import { getContextTool } from './tools/getContextTool';
import { listDirectoryTool } from './tools/listDirectoryTool';
import { readFileTool } from './tools/readFileTool';
import { createFileTool } from './tools/createFileTool';
import { createFolderTool } from './tools/createFolderTool';
import { editFileTool } from './tools/editFileTool';
import { editAbiFileTool } from './tools/editAbiFileTool';
import { deleteFileTool } from './tools/deleteFileTool';
import { deleteFolderTool } from './tools/deleteFolderTool';
import { checkExistsTool } from './tools/checkExistsTool';
import { getDirectoryTreeTool } from './tools/getDirectoryTreeTool';
import { fetchTool, FetchToolService } from './tools/fetchTool';
import {
  smartBlockTool,
  connectBlocksTool,
  createCodeStructureTool,
  configureBlockTool,
  variableManagerTool,
  findBlockTool,
  deleteBlockTool,
  getWorkspaceOverviewTool  // 新增工具导入
} from './tools/editBlockTool';
import { todoWriteTool } from './tools';
import { NzModalService } from 'ng-zorro-antd/modal';
import { ConfigService } from '../../services/config.service';

export interface Tool {
  name: string;
  description: string;
  input_schema: { [key: string]: any };
}

export interface ResourceItem {
  type: 'file' | 'folder' | 'url';
  path?: string;
  url?: string;
  name: string;
}

export interface ChatMessage {
  role: string;
  content: string;
  state: 'doing' | 'done';
}

import { NzMessageService } from 'ng-zorro-antd/message';
import { TOOLS } from './tools/tools';
import { AuthService } from '../../services/auth.service';
import { resolveObjectURL } from 'buffer';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
// import { reloadAbiJsonTool, reloadAbiJsonToolSimple } from './tools';

@Component({
  selector: 'app-aily-chat',
  imports: [
    SubWindowComponent,
    NzInputModule,
    FormsModule,
    CommonModule,
    DialogComponent,
    NzButtonModule,
    ToolContainerComponent,
    NzResizableModule,
    NzToolTipModule,
    MenuComponent,
    TranslateModule
  ],
  templateUrl: './aily-chat.component.html',
  styleUrl: './aily-chat.component.scss',
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

  defaultList: ChatMessage[] = [{
    "role": "system",
    "content": "欢迎使用AI助手服务，我可以帮助你 分析项目、转换blockly库、修复错误、生成程序，告诉我你需要什么帮助吧~🤓\n\n >当前为测试版本，可能会有不少问题，如遇故障，群里呼叫`奈何col`哦",
    "state": "done"
  }];

  list: ChatMessage[] = [...this.defaultList.map(item => ({ ...item }))];
  // list = ChatListExamples  // 示例数据

  currentUrl;
  inputValue = '';
  prjRootPath = '';
  prjPath = '';

  isCompleted = false;
  private isSessionStarting = false; // 防止重复启动会话的标志位
  private hasInitializedForThisLogin = false; // 标记是否已为当前登录状态初始化过

  private textMessageSubscription: Subscription;
  private loginStatusSubscription: Subscription;
  private mcpInitialized = false; // 添加标志位防止重复初始化MCP

  get sessionId() {
    return this.chatService.currentSessionId;
  }

  get currentMode() {
    return this.chatService.currentMode;
  }


  /**
   * 确保字符串在 JSON 中是安全的，转义特殊字符
   */
  private makeJsonSafe(str: string): string {
    if (!str) return str;
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  }

  /**
   * 获取路径中最后一个文件夹的名称
   * @param path 路径字符串
   * @returns 最后一个文件夹名称，如果路径无效则返回空字符串
   */
  getLastFolderName(path: string): string {
    if (!path) return '';

    // 标准化路径分隔符（处理Windows和Unix路径）
    const normalizedPath = path.replace(/\\/g, '/');

    // 移除末尾的斜杠
    const trimmedPath = normalizedPath.endsWith('/')
      ? normalizedPath.slice(0, -1)
      : normalizedPath;

    // 分割路径并获取最后一个非空元素
    const parts = trimmedPath.split('/').filter(Boolean);

    return parts.length > 0 ? parts[parts.length - 1] : '';
  }

  /**
   * 获取路径中的文件名（不包含路径）
   * @param path 文件的完整路径
   * @returns 文件名，如果路径无效则返回空字符串
   */
  getFileName(path: string): string {
    if (!path) return '';

    // 标准化路径分隔符（处理Windows和Unix路径）
    const normalizedPath = path.replace(/\\/g, '/');

    // 获取路径的最后一部分（文件名）
    const parts = normalizedPath.split('/');
    return parts.length > 0 ? parts[parts.length - 1] : '';
  }

  /**
 * 获取URL中的文件名或有意义的部分
 * @param url 完整的URL地址
 * @returns 简化的URL名称，如果无法解析则返回原URL
 */
  getUrlDisplayName(url: string): string {
    if (!url) return '';

    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;

      // 如果路径为空或只是根路径，返回域名
      if (!pathname || pathname === '/') {
        return urlObj.hostname;
      }

      // 获取路径的最后一部分（可能是文件名）
      const pathParts = pathname.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        let lastPart = pathParts[pathParts.length - 1];

        // 对URL编码的字符串进行解码（如 %E5%BA%93%E8%A7%84%E8%8C%83.md -> 库规范.md）
        try {
          lastPart = decodeURIComponent(lastPart);
        } catch (decodeError) {
          // 如果解码失败，保持原样
          console.warn('URL解码失败:', decodeError);
        }

        // 如果最后一部分看起来像文件名（包含扩展名），直接返回
        if (lastPart.includes('.')) {
          return lastPart;
        }

        // 否则返回最后两个路径段（如果存在）
        if (pathParts.length >= 2) {
          let secondLastPart = pathParts[pathParts.length - 2];
          // 同样对倒数第二部分进行解码
          try {
            secondLastPart = decodeURIComponent(secondLastPart);
          } catch (decodeError) {
            console.warn('URL解码失败:', decodeError);
          }
          return `${secondLastPart}/${lastPart}`;
        }

        return lastPart;
      }

      // 回退到域名
      return urlObj.hostname;
    } catch (error) {
      // 如果URL解析失败，尝试简单的字符串处理
      const parts = url.split('/').filter(Boolean);
      if (parts.length > 0) {
        let lastPart = parts[parts.length - 1];
        // 对最后一部分进行URL解码
        try {
          lastPart = decodeURIComponent(lastPart);
        } catch (decodeError) {
          console.warn('URL解码失败:', decodeError);
        }
        return lastPart;
      }
      return url;
    }
  }

  getCurrentProjectPath(): string {
    return this.projectService.currentProjectPath !== this.projectService.projectRootPath
      ? this.projectService.currentProjectPath
      : '';
  }

  // 内置工具
  tools: Tool[] = TOOLS;

  constructor(
    private uiService: UiService,
    private chatService: ChatService,
    private mcpService: McpService,
    private projectService: ProjectService,
    private cmdService: CmdService,
    private blocklyService: BlocklyService,
    private fetchToolService: FetchToolService,
    private router: Router,
    private message: NzMessageService,
    private authService: AuthService,
    private modal: NzModalService,
    private configService: ConfigService,
    private translate: TranslateService
  ) { }

  ngOnInit() {
    // if (this.electronService.isElectron) {
    //   this.prjPath = window['path'].getUserDocuments() + `${pt}aily-project${pt}`;
    // }

    this.prjPath = this.projectService.currentProjectPath === this.projectService.projectRootPath ? "" : this.projectService.currentProjectPath;
    this.prjRootPath = this.projectService.projectRootPath;



    // 订阅消息
    this.currentUrl = this.router.url;
    // 订阅外部文本消息
    this.textMessageSubscription = this.chatService.getTextMessages().subscribe(
      message => {
        this.receiveTextFromExternal(message.text, message.options);
      }
    );

    this.authService.initializeAuth().then((res) => {
      console.log('AuthService initialized:', res);
    });

    // 订阅登录状态变化
    this.loginStatusSubscription = this.authService.isLoggedIn$.subscribe(
      async isLoggedIn => {
        console.log('登录状态变化:', isLoggedIn, {
          hasInitializedForThisLogin: this.hasInitializedForThisLogin,
          isSessionStarting: this.isSessionStarting,
          currentSessionId: this.sessionId
        });

        // 只在登录状态下调用startSession，避免登出时重复显示登录按钮
        if (!this.hasInitializedForThisLogin && !this.isSessionStarting && isLoggedIn) {
          this.hasInitializedForThisLogin = true;
          this.list = [...this.defaultList.map(item => ({ ...item }))]; // 重置消息列表

          this.startSession().then((res) => {
            console.log("startSession result: ", res);
            // 获取历史记录
            this.getHistory();
          }).catch((err) => {
            console.error("startSession error: ", err);
          });
        }

        if (isLoggedIn) {
          //
        } else {
          // 用户登出时的处理
          console.log('用户已登出，清理会话和状态');

          // 停止并关闭当前会话（如果存在）
          try {
            await this.stopAndCloseSession();
          } catch (error) {
            console.error('清理会话时出错:', error);
          }

          // 重置所有相关状态
          this.hasInitializedForThisLogin = false;
          this.mcpInitialized = false;
          this.isWaiting = false;
          this.isCompleted = false;
          this.isSessionStarting = false;

          // 清空会话ID
          this.chatService.currentSessionId = '';

          // 重置消息列表为默认状态
          this.list = [...this.defaultList.map(item => ({ ...item }))];

          let errData = {
            status: 422,
            message: "用户已登出，需要重新登录才能继续使用AI助手功能"
          }
          this.appendMessage('error', `
\`\`\`aily-error
${JSON.stringify(errData)}
\`\`\`\n\n`)

          // 清理工具调用状态
          this.toolCallStates = {};

          // 断开流连接
          if (this.messageSubscription) {
            this.messageSubscription.unsubscribe();
            this.messageSubscription = null;
          }

          console.log('用户登出状态清理完成');
        }
      }
    );
  }

  /**
   * 接收来自外部组件的文本并显示在输入框中
   * @param text 接收到的文本
   * @param options 发送选项，包含 sender、type、cover 等参数
   */
  receiveTextFromExternal(text: string, options?: ChatTextOptions): void {
    console.log('接收到外部文本:', text, '选项:', options);

    if (options?.type === 'button') {
      this.send("user", text, false);
      return;
    }

    // cover 默认为 true，只有明确设置为 false 时才追加
    if (options?.cover === false) {
      // 如果明确设置为不覆盖，则追加到末尾
      if (this.inputValue) {
        this.inputValue += '\n' + text;
      } else {
        this.inputValue = text;
      }
    } else {
      // 默认行为：覆盖输入框内容
      this.inputValue = text;
    }

    // 自动聚焦到输入框并将光标移到末尾
    setTimeout(() => {
      if (this.chatTextarea?.nativeElement) {
        const textarea = this.chatTextarea.nativeElement;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    }, 100);
  }

  async disconnect() {
    try {
      // 先取消对话
      if (this.sessionId) {
        await new Promise<void>((resolve) => {
          this.chatService.cancelTask(this.sessionId).subscribe({
            next: (res: any) => {
              console.log('取消对话成功:', res);
              resolve();
            },
            error: (err) => {
              console.error('取消对话失败:', err);
              resolve(); // 即使失败也继续
            }
          });
        });

        // 然后关闭连接
        await new Promise<void>((resolve) => {
          this.chatService.closeSession(this.sessionId).subscribe({
            next: (res: any) => {
              console.log('关闭时会话连接已关闭:', res);
              resolve();
            },
            error: (err) => {
              console.error('关闭时关闭会话失败:', err);
              resolve(); // 即使失败也继续
            }
          });
        });
      }
    } catch (error) {
      console.error('关闭会话过程中出错:', error);
    }
  }

  async close() {
    // 最后关闭工具窗口
    this.uiService.closeTool('aily-chat');
  }

  ngAfterViewInit(): void {
    this.scrollToBottom();
    // this.mcpService.init().then(() => {
    //   this.startSession();
    // })

    // 测试数据
    //     setTimeout(() => {
    //       this.list.push({
    //         role: 'bot',
    //         content: `\`\`\`aily-mermaid
    // flowchart TD
    //     subgraph "桌面时钟摆件"
    //         direction LR
    //         subgraph "核心控制"
    //             MCU[主控芯片 ESP32<br>内置Wi-Fi]
    //         end

    //         subgraph "外围设备"
    //             MATRIX[LED点阵屏<br>MAX7219驱动]
    //             RTC[实时时钟模块<br>DS3231]
    //             SENSOR[温湿度传感器<br>DHT22]
    //             BUTTON[物理按键]
    //         end

    //         subgraph "网络服务"
    //             NTP[NTP网络时间服务]
    //             WEATHER_API[天气信息API]
    //         end

    //         subgraph "电源"
    //             POWER[USB 5V供电]
    //         end
    //     end

    //     MCU -- SPI --> MATRIX
    //     MCU -- I2C --> RTC
    //     MCU -- GPIO --> SENSOR
    //     MCU -- GPIO --> BUTTON
    //     MCU -- Wi-Fi --> NTP
    //     MCU -- Wi-Fi --> WEATHER_API
    //     POWER --> MCU
    //     POWER --> MATRIX
    // \`\`\`\n\n`
    //       });
    //     }, 2000);
  }

  appendMessage(role, text) {
    // console.log("添加消息: ", role, text);

    try {
      const parsedText = JSON.parse(text);
      if (typeof parsedText === 'object') {
        text = parsedText.content || JSON.stringify(parsedText, null, 2);
      }
    } catch (e) {
      // 如果解析失败，说明不是JSON格式的字符串
      // 保持原样
    }

    // 检查是否存在消息列表，且最后一条消息的role与当前role相同
    if (this.list.length > 0 && this.list[this.list.length - 1].role === role) {
      // 如果是同一个role，追加内容到最后一条消息
      this.list[this.list.length - 1].content += text;
      // 如果是AI角色且正在输出，保持doing状态
      if (role === 'aily' && this.isWaiting) {
        this.list[this.list.length - 1].state = 'doing';
      }
    } else {
      // console.log("添加新消息: ", role);
      // 如果是不同的role或列表为空，创建新的消息
      const state = (role === 'aily' && this.isWaiting) ? 'doing' : 'done';
      this.list.push({
        "role": role,
        "content": text,
        "state": state
      });
    }
  }

  async startSession(): Promise<void> {
    // 如果会话正在启动中，直接返回
    if (this.isSessionStarting) {
      console.log('startSession 被跳过: 会话正在启动中');
      return Promise.resolve();
    }

    console.log('开始启动会话...', {
      currentSessionId: this.sessionId,
      isSessionStarting: this.isSessionStarting
    });
    this.isSessionStarting = true;

    if (!this.mcpInitialized) {
      this.mcpInitialized = true;
      await this.mcpService.init();
    }

    // tools + mcp tools
    this.isCompleted = false;
    let tools = this.tools;
    let mcpTools = this.mcpService.tools.map(tool => {
      if (!tool.name.startsWith("mcp_")) {
        tool.name = "mcp_" + tool.name;
      }
      return tool;
    });
    if (mcpTools && mcpTools.length > 0) {
      tools = tools.concat(mcpTools);
    }

    return new Promise<void>((resolve, reject) => {
      this.chatService.startSession(this.currentMode, tools).subscribe({
        next: (res: any) => {
          if (res.status === 'success') {
            this.chatService.currentSessionId = res.data;
            console.log('会话启动成功, sessionId:', res.data);
            this.streamConnect();
            this.isSessionStarting = false;
            resolve();
          } else {
            console.log("startSession failed: ", res);
            this.appendMessage('error', `
\`\`\`aily-error
{
  "message": ${res.message || '启动会话失败，请稍后重试。'}
}
\`\`\`\n\n`)
            this.isSessionStarting = false;
            reject(new Error(res.message || '启动会话失败'));
          }
        },
        error: (err) => {
          console.warn('启动会话失败:', err);
          let errData = {
            status: err.status,
            message: err.message
          }
          this.appendMessage('error', `
\`\`\`aily-error
${JSON.stringify(errData)}
\`\`\`\n\n`)
          this.isSessionStarting = false;
          reject(err);
        }
      });
    });
  }

  closeSession(): void {
    if (!this.sessionId) return;

    this.chatService.closeSession(this.sessionId).subscribe((res: any) => {
      // console.log('close session', res);
    });
  }

  isWaiting = false;
  autoScrollEnabled = true; // 控制是否自动滚动到底部

  async sendButtonClick(): Promise<void> {
    if (this.isWaiting) {
      this.stop();
      return;
    }



    // 发送消息时重新启用自动滚动
    this.autoScrollEnabled = true;

    // if (this.isCompleted) {
    //   console.log('上次会话已完成，需要重新启动会话');
    //   await this.resetChat();
    // }

    this.send('user', this.inputValue.trim(), true);
    this.inputValue = ''; // 发送后清空输入框
    this.selectContent = [];
  }

  resetChat(): Promise<void> {
    return this.startSession();
  }

  send(sender: string, content: string, clear: boolean = true): void {
    let text = content.trim();
    if (!this.sessionId || !text) return;

    if (this.isCompleted) {
      this.resetChat();
    }

    if (sender === 'user') {
      if (this.isWaiting) {
        return;
      }

      // 将用户输入的文本包裹在<user-query>标签中
      text = `<user-query>${text}</user-query>`;

      const resourcesText = this.getResourcesText();
      if (resourcesText) {
        text = resourcesText + '\n\n' + text;
      }

      this.appendMessage('user', text);
      this.appendMessage('aily', '[thinking...]');
    } else if (sender === 'tool') {
      if (!this.isWaiting) {
        return;
      }
    } else {
      console.warn('未知发送者类型:', sender);
      return;
    }

    this.isWaiting = true;

    this.sendMessageWithRetry(this.sessionId, text, sender, clear, 3);
  }

  /**
   * 发送消息并支持自动重试
   * @param sessionId 会话ID
   * @param text 发送的文本内容
   * @param sender 发送者类型
   * @param clear 是否清空输入框
   * @param retryCount 剩余重试次数
   */
  private sendMessageWithRetry(sessionId: string, text: string, sender: string, clear: boolean, retryCount: number): void {
    this.chatService.sendMessage(sessionId, text, sender).subscribe({
      next: (res: any) => {
        console.log("sendRes: ", res);
        if (res.status === 'success') {
          if (res.data) {
            this.appendMessage('aily', res.data);
          }

          if (clear) {
            this.inputValue = ''; // 发送后清空输入框
          }
        }
      },
      error: (error) => {
        console.error('发送消息失败:', error);

        // 检查是否是502错误且还有重试次数
        if (error.status === 502 && retryCount > 0) {
          console.log(`遇到502错误，还有${retryCount}次重试机会，正在重试...`);

          // 延迟1秒后重试
          setTimeout(() => {
            this.sendMessageWithRetry(sessionId, text, sender, clear, retryCount - 1);
          }, 1000);
        } else {
          // 重试次数用完或非502错误，显示错误信息
          this.isWaiting = false;

          let errorMessage = '发送消息失败';
          if (error.status === 502) {
            errorMessage = '服务器暂时无法响应，请稍后重试';
          } else if (error.message) {
            errorMessage = error.message;
          }

          this.appendMessage('error', `
\`\`\`aily-error
{
  "message": "${errorMessage}",
  "status": ${error.status || 'unknown'}
}
\`\`\`\n\n`);
        }
      }
    });
  }

  // 这里写停止发送信号
  stop() {
    // 设置最后一条AI消息状态为done（如果存在）
    if (this.list.length > 0 && this.list[this.list.length - 1].role === 'aily') {
      this.list[this.list.length - 1].state = 'done';
    }

    this.chatService.cancelTask(this.sessionId).subscribe((res: any) => {
      if (res.status === 'success') {
        console.log('任务已取消:', res);
      } else {
        console.error('取消任务失败:', res);
      }
    });
  }

  streamConnect(): void {
    console.log("stream connect sessionId: ", this.sessionId);
    if (!this.sessionId) {
      console.warn('无法建立流连接：sessionId 为空');
      return;
    }

    // 如果已经在连接中，先断开
    if (this.messageSubscription) {
      this.messageSubscription.unsubscribe();
      this.messageSubscription = null;
    }

    this.messageSubscription = this.chatService.streamConnect(this.sessionId).subscribe({
      next: async (data: any) => {
        if (!this.isWaiting) {
          return; // 如果不在等待状态，直接返回
        }

        console.log("Recv: ", data);

        try {
          if (data.type === 'ModelClientStreamingChunkEvent') {
            // 处理流式数据
            if (data.content) {
              this.appendMessage('aily', data.content);
            }
          } else if (data.type === 'TextMessage') {
            // 每条完整的对话信息
          } else if (data.type === 'ToolCallExecutionEvent') {
            // 处理工具执行完成事件
            if (data.content && Array.isArray(data.content)) {
              for (const result of data.content) {
                if (result.call_id && result?.name !== "ask_approval") {
                  // 根据工具名称和结果状态确定显示文本
                  const resultState = result.is_error ? "error" : "done";
                  const resultText = this.toolCallStates[result.call_id];
                  if (resultText) {
                    this.appendMessage('aily', `
  \`\`\`aily-state
  {
    "state": "done",
    "text": "${this.makeJsonSafe(resultText)}",
    "id": "${result.call_id}"
  }
  \`\`\`\n\n
`);
                  }

                  // 清除状态
                  delete this.toolCallStates[result.call_id];
                } else {
                  this.appendMessage('aily', "\n\n");
                }
              }
            }
          } else if (data.type.startsWith('context_compression_')) {
            // 上下文压缩触发消息
            if (data.type.startsWith('context_compression_start')) {
              this.appendMessage('aily', `\n\n
\`\`\`aily-state
{ 
  "state": "doing", 
  "text": "${data.content}",
  "id": "${data.id}"
}
\`\`\`\n\n
`);
            } else {
              this.appendMessage('aily', `\n\n
\`\`\`aily-state
{ 
  "state": "done",
  "text": "${data.content}",
  "id": "${data.id}"
}
\`\`\`\n\n
`);
            }
          } else if (data.type === 'error') {
            // 设置最后一条AI消息状态为done（如果存在）
            if (this.list.length > 0 && this.list[this.list.length - 1].role === 'aily') {
              this.list[this.list.length - 1].state = 'done';
            }
            this.appendMessage('error', `

\`\`\`aily-error
{
  "message": "${data.message || '未知错误'}"
}
\`\`\`\n\n

          `);
            this.isWaiting = false;
          } else if (data.type === 'tool_call_request') {
            let toolArgs;

            if (typeof data.tool_args === 'string') {
              try {
                // 在JSON解析前，先处理Windows路径中的反斜杠问题
                // 将Windows路径中的单个反斜杠替换为双反斜杠，避免被当作转义字符
                let processedString = data.tool_args;

                // 查找所有可能的路径字段，并在它们的值中修复反斜杠
                processedString = processedString.replace(
                  /"(path|cwd|directory|folder|filepath|dirpath)"\s*:\s*"([^"]*[\\][^"]*)"/g,
                  (match, fieldName, pathValue) => {
                    // 将路径中的单个反斜杠替换为双反斜杠（除非已经是双反斜杠）
                    const fixedPath = pathValue.replace(/(?<!\\)\\(?!\\)/g, '\\\\');
                    return `"${fieldName}":"${fixedPath}"`;
                  }
                );

                toolArgs = JSON.parse(processedString);
              } catch (e) {
                console.error('JSON解析失败，尝试备用方法:', e);
                try {
                  // 备用方案：使用Function构造器
                  toolArgs = new Function('return ' + data.tool_args)();
                } catch (e2) {
                  console.error('所有解析方法都失败:', e2);
                  this.send("tool", JSON.stringify({
                    "type": "tool_result",
                    "tool_id": data.tool_id,
                    "content": `参数解析失败: ${e.message}`,
                    "is_error": true
                  }, null, 2), false);
                  return;
                }
              }
            } else if (typeof data.tool_args === 'object' && data.tool_args !== null) {
              toolArgs = data.tool_args;
            } else {
              console.warn('意外的工具参数类型:', typeof data.tool_args, data.tool_args);
              toolArgs = data.tool_args;
            }

            // console.log("toolArgsJson: ", toolArgs);

            // 生成随机ID用于状态跟踪
            const toolCallId = `${data.tool_id}`;

            let toolResult = null;
            let resultState = "done";
            let resultText = '';

            console.log("工具调用请求: ", data.tool_name, toolArgs);

            try {
              if (data.tool_name.startsWith('mcp_')) {
                data.tool_name = data.tool_name.substring(4);
                toolResult = await this.mcpService.use_tool(data.tool_name, toolArgs);
              } else {

                switch (data.tool_name) {
                  case 'create_project':
                    console.log('[创建项目工具被调用]', toolArgs);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在创建项目...",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await newProjectTool(this.prjRootPath, toolArgs, this.projectService, this.configService);
                    if (toolResult.is_error) {
                      this.uiService.updateFooterState({ state: 'warn', text: '项目创建失败' });
                      resultState = "warn"
                      resultText = '项目创建异常,即将重试';
                    } else {
                      resultText = `项目创建成功`;
                    }
                    break;
                  case 'execute_command':
                    console.log('[执行命令工具被调用]', toolArgs);
                    // Extract the command main body for display
                    const commandParts = toolArgs.command.split(' ');
                    let displayCommand = toolArgs.command;

                    if (commandParts.length > 1) {
                      // 对于 npm 命令，显示前两个词（如 "npm install"）
                      if (commandParts[0].toLowerCase() === 'npm') {
                        displayCommand = `${commandParts[0]} ${commandParts[1]}`;
                      } else {
                        // 其他命令只显示第一个词
                        displayCommand = `${commandParts[0]}`;
                      }
                    }

                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在执行: ${displayCommand}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    // Check if cwd is specified, otherwise use project paths
                    if (!toolArgs.cwd) {
                      toolArgs.cwd = this.projectService.currentProjectPath || this.projectService.projectRootPath;
                    }
                    toolResult = await executeCommandTool(this.cmdService, toolArgs);
                    // Get project path from command args or default
                    const projectPath = toolArgs.cwd || this.prjPath;
                    if (!toolResult.is_error) {
                      // Check if this is an npm install command
                      const command = toolArgs.command;
                      if (command.includes('npm i') || command.includes('npm install')) {
                        console.log('检测到 npm install 命令，尝试加载库');
                        // Extract the package name for @aily-project/ packages only
                        const npmRegex = /npm (i|install)\s+(@aily-project\/[a-zA-Z0-9-_]+)/;
                        const match = command.match(npmRegex);

                        console.log('npmRegex match:', match);

                        if (match && match[2]) {
                          const libPackageName = match[2];
                          console.log('Installing library:', libPackageName);

                          // Load the library into blockly
                          try {
                            await this.blocklyService.loadLibrary(libPackageName, projectPath);
                          } catch (e) {
                            //
                            console.log("加载库失败:", e);
                          }
                        } else {
                          console.log("projectOpen: ", projectPath);
                          this.projectService.projectOpen(projectPath);
                        }
                      }
                      resultText = `命令${displayCommand}执行成功`
                    } else {
                      resultState = "warn";
                      resultText = `命令${displayCommand}执行异常, 即将重试`;
                    }
                    break;
                  case 'get_context':
                    // console.log('[获取上下文信息工具被调用]', toolArgs);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在获取上下文信息...",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await getContextTool(this.projectService, toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = '获取上下文信息异常, 即将重试';
                    } else {
                      resultText = `上下文信息获取成功`;
                    }
                    break;
                  case 'list_directory':
                    // console.log('[列出目录工具被调用]', toolArgs);
                    const distFolderName = this.getLastFolderName(toolArgs.path);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在获取${distFolderName}目录内容",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await listDirectoryTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = `获取${distFolderName}目录内容异常, 即将重试`;
                    } else {
                      resultText = `获取${distFolderName}目录内容成功`;
                    }
                    break;
                  case 'read_file':
                    // console.log('[读取文件工具被调用]', toolArgs);
                    let readFileName = this.getFileName(toolArgs.path);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在读取: ${readFileName}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await readFileTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = `读取异常, 即将重试`;
                    } else {
                      resultText = `读取${readFileName}文件成功`;
                    }
                    break;
                  case 'create_file':
                    // console.log('[创建文件工具被调用]', toolArgs);
                    let createFileName = this.getFileName(toolArgs.path);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在创建: ${createFileName}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await createFileTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = `创建${createFileName}文件异常, 即将重试`;
                    } else {
                      resultText = `创建${createFileName}文件成功`;
                    }
                    break;
                  case 'create_folder':
                    // console.log('[创建文件夹工具被调用]', toolArgs);
                    let createFolderName = this.getLastFolderName(toolArgs.path);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在创建: ${createFolderName}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await createFolderTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = `创建${createFolderName}文件夹异常, 即将重试`;
                    } else {
                      resultText = `创建${createFolderName}文件夹成功`;
                    }
                    break;
                  case 'edit_file':
                    // console.log('[编辑文件工具被调用]', toolArgs);
                    let editFileName = this.getFileName(toolArgs.path);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在编辑: ${editFileName}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await editFileTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = `编辑${editFileName}文件异常, 即将重试`;
                    } else {
                      resultText = `编辑${editFileName}文件成功`;
                    }
                    break;
                  case 'delete_file':
                    // console.log('[删除文件工具被调用]', toolArgs);
                    let deleteFileName = this.getFileName(toolArgs.path);
                    this.appendMessage('aily', `
\`\`\`aily-state
{
  "state": "doing",
  "text": "正在删除: ${deleteFileName}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await deleteFileTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = `删除${deleteFileName}文件异常, 即将重试`;
                    } else {
                      resultText = `删除${deleteFileName}文件成功`;
                    }
                    break;
                  case 'delete_folder':
                    // console.log('[删除文件夹工具被调用]', toolArgs);
                    let deleteFolderName = this.getLastFolderName(toolArgs.path);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在删除: ${deleteFolderName}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await deleteFolderTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = `删除${deleteFolderName}文件夹异常, 即将重试`;
                    } else {
                      resultText = `删除${deleteFolderName}文件夹成功`;
                    }
                    break;
                  case 'check_exists':
                    // console.log('[检查存在性工具被调用]', toolArgs);
                    // Determine if the path is likely a file or folder
                    let stateText = "正在检查路径是否存在";
                    let checkFileName = this.getFileName(toolArgs.path);
                    let checkFolderName = this.getLastFolderName(toolArgs.path);

                    const doingText = checkFileName ? `正在检查文件是否存在: ${checkFileName}` : `正在检查文件夹是否存在: ${checkFolderName}`;
                    const errText = checkFileName ? `检查文件 ${checkFileName} 是否存在失败: ` : `检查文件夹 ${checkFolderName} 是否存在失败: `;
                    const successText = checkFileName ? `文件 ${checkFileName} 存在` : `文件夹 ${checkFolderName} 存在`;

                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "${doingText}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await checkExistsTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = errText;
                    } else {
                      resultText = successText;
                    }
                    break;
                  case 'get_directory_tree':
                    // console.log('[获取目录树工具被调用]', toolArgs);
                    let treeFolderName = this.getLastFolderName(toolArgs.path);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在获取目录树: ${treeFolderName}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await getDirectoryTreeTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "error";
                      resultText = `获取目录树 ${treeFolderName} 失败: ` + (toolResult.content || '未知错误');
                    } else {
                      resultText = `获取目录树 ${treeFolderName} 成功`;
                    }
                    break;
                  case 'fetch':
                    // console.log('[网络请求工具被调用]', toolArgs);
                    const fetchUrl = this.getUrlDisplayName(toolArgs.url);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在进行网络请求: ${fetchUrl}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await fetchTool(this.fetchToolService, toolArgs);
                    if (toolResult.is_error) {
                      resultState = "error";
                      resultText = `网络请求异常，即将重试`;
                    } else {
                      resultText = `网络请求 ${fetchUrl} 成功`;
                    }
                    break;
                  case 'ask_approval':
                    console.log('[请求确认工具被调用]', toolArgs);
                    toolResult = await askApprovalTool(toolArgs);
                    // 不显示状态信息，因为这是用户交互操作
                    break;
                  case 'reload_project':
                    // console.log('[重新加载项目工具被调用]', toolArgs);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在重新加载项目...",
  "id": "${toolCallId}"
}
\`\`\`\n\n

                      `)
                    break;
                  case 'edit_abi_file':
                    console.log('[编辑ABI文件工具被调用]', toolArgs);

                    // 根据操作模式生成不同的状态文本
                    let abiOperationText = "正在编辑ABI文件...";
                    if (toolArgs.replaceStartLine !== undefined) {
                      if (toolArgs.replaceEndLine !== undefined && toolArgs.replaceEndLine !== toolArgs.replaceStartLine) {
                        abiOperationText = `正在替换ABI文件第 ${toolArgs.replaceStartLine}-${toolArgs.replaceEndLine} 行内容...`;
                      } else {
                        abiOperationText = `正在替换ABI文件第 ${toolArgs.replaceStartLine} 行内容...`;
                      }
                    } else if (toolArgs.insertLine !== undefined) {
                      abiOperationText = `正在ABI文件第 ${toolArgs.insertLine} 行插入内容...`;
                    } else if (toolArgs.replaceMode === false) {
                      abiOperationText = "正在向ABI文件末尾追加内容...";
                    }

                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "${abiOperationText}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);

                    const currentProjectPath = this.getCurrentProjectPath();
                    if (!currentProjectPath) {
                      console.warn('当前未打开项目');
                      resultState = "warn";
                      resultText = "当前未打开项目";
                    } else {
                      // 构建editAbiFileTool的参数，传递所有可能的参数
                      const editAbiParams: any = {
                        path: currentProjectPath,
                        content: toolArgs.content
                      };

                      // 传递可选参数
                      if (toolArgs.insertLine !== undefined) {
                        editAbiParams.insertLine = toolArgs.insertLine;
                      }
                      if (toolArgs.replaceStartLine !== undefined) {
                        editAbiParams.replaceStartLine = toolArgs.replaceStartLine;
                      }
                      if (toolArgs.replaceEndLine !== undefined) {
                        editAbiParams.replaceEndLine = toolArgs.replaceEndLine;
                      }
                      if (toolArgs.replaceMode !== undefined) {
                        editAbiParams.replaceMode = toolArgs.replaceMode;
                      }
                      if (toolArgs.encoding !== undefined) {
                        editAbiParams.encoding = toolArgs.encoding;
                      }
                      if (toolArgs.createIfNotExists !== undefined) {
                        editAbiParams.createIfNotExists = toolArgs.createIfNotExists;
                      }

                      const editAbiResult = await editAbiFileTool(editAbiParams);
                      toolResult = {
                        "content": editAbiResult.content,
                        "is_error": editAbiResult.is_error
                      }
                      if (toolResult.is_error) {
                        resultState = "warn";
                        resultText = `ABI文件编辑异常, 即将重试`;
                      } else {
                        // 根据操作模式生成不同的成功文本
                        if (toolArgs.insertLine !== undefined) {
                          resultText = `ABI文件第 ${toolArgs.insertLine} 行插入内容成功`;
                        } else if (toolArgs.replaceStartLine !== undefined) {
                          if (toolArgs.replaceEndLine !== undefined && toolArgs.replaceEndLine !== toolArgs.replaceStartLine) {
                            resultText = `ABI文件第 ${toolArgs.replaceStartLine}-${toolArgs.replaceEndLine} 行替换成功`;
                          } else {
                            resultText = `ABI文件第 ${toolArgs.replaceStartLine} 行替换成功`;
                          }
                        } else if (toolArgs.replaceMode === false) {
                          resultText = 'ABI文件内容追加成功';
                        } else {
                          resultText = 'ABI文件编辑成功';
                        }

                        // 导入工具函数
                        const { ReloadAbiJsonToolService } = await import('./tools/reloadAbiJsonTool');
                        const reloadAbiJsonService = new ReloadAbiJsonToolService(this.blocklyService, this.projectService);
                        const reloadResult = await reloadAbiJsonService.executeReloadAbiJson(toolArgs);
                        toolResult = {
                          content: reloadResult.content,
                          is_error: reloadResult.is_error
                        }
                      }
                    }
                    break;
                  case 'reload_abi_json':
                    console.log('[重新加载ABI JSON工具被调用]', toolArgs);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在重新加载Blockly工作区数据...",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    // 导入工具函数
                    const { ReloadAbiJsonToolService } = await import('./tools/reloadAbiJsonTool');
                    const reloadAbiJsonService = new ReloadAbiJsonToolService(this.blocklyService, this.projectService);
                    const reloadResult = await reloadAbiJsonService.executeReloadAbiJson(toolArgs);
                    toolResult = {
                      content: reloadResult.content,
                      is_error: reloadResult.is_error
                    };
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = 'ABI数据重新加载异常';
                    } else {
                      resultText = 'ABI数据重新加载成功';
                    }
                    break;
                  case 'smart_block_tool':
                    console.log('🔧 [智能块工具被调用]');
                    console.log('📥 大模型传入的完整参数:', JSON.stringify(toolArgs, null, 2));
                    console.log('📋 参数解析:');
                    console.log('  - 块类型:', toolArgs.type);
                    console.log('  - 位置:', toolArgs.position);
                    console.log('  - 字段:', toolArgs.fields);
                    console.log('  - 输入:', toolArgs.inputs);
                    console.log('  - 父级连接:', toolArgs.parentConnection);
                    console.log('  - 创建变量:', toolArgs.createVariables);

                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在操作Blockly块: ${toolArgs.type}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await smartBlockTool(toolArgs);
                    console.log('✅ 智能块工具执行结果:', toolResult);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = '智能块操作异常';
                    } else {
                      resultText = `智能块操作成功: ${toolArgs.type}`;
                    }
                    break;
                  case 'connect_blocks_tool':
                    console.log('[块连接工具被调用]', toolArgs);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在连接Blockly块...",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await connectBlocksTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = '块连接异常';
                    } else {
                      resultText = `块连接成功: ${toolArgs.connectionType}连接`;
                    }
                    break;
                  case 'create_code_structure_tool':
                    console.log('[代码结构创建工具被调用]', toolArgs);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在创建代码结构: ${toolArgs.structure}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await createCodeStructureTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = '代码结构创建异常';
                    } else {
                      resultText = `代码结构创建成功: ${toolArgs.structure}`;
                    }
                    break;
                  case 'configure_block_tool':
                    console.log('[块配置工具被调用]', toolArgs);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在配置Blockly块...",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await configureBlockTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = '块配置异常, 即将重试';
                    } else {
                      resultText = `块配置成功: ID ${toolArgs.blockId}`;
                    }
                    break;
                  case 'variable_manager_tool':
                    console.log('[变量管理工具被调用]', toolArgs);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在${toolArgs.operation === 'create' ? '创建' : toolArgs.operation === 'delete' ? '删除' : toolArgs.operation === 'rename' ? '重命名' : '列出'}变量...",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await variableManagerTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = '变量操作异常,即将重试';
                    } else {
                      resultText = `变量操作成功: ${toolArgs.operation}${toolArgs.variableName ? ' ' + toolArgs.variableName : ''}`;
                    }
                    break;
                  case 'find_block_tool':
                    console.log('[块查找工具被调用]', toolArgs);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在查找Blockly块...",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await findBlockTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = '块查找异常,即将重试';
                    } else {
                      resultText = '块查找完成';
                    }
                    break;
                  case 'delete_block_tool':
                    console.log('[块删除工具被调用]', toolArgs);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在删除Blockly块...",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await deleteBlockTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = '块删除异常, 即将重试';
                    } else {
                      resultText = `块删除成功: ${toolResult.content}`;
                    }
                    break;
                  case 'get_workspace_overview_tool':
                    console.log('[工作区全览工具被调用]', toolArgs);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在分析工作区全览...",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await getWorkspaceOverviewTool(toolArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = '工作区分析异常, 即将重试';
                    } else {
                      // 从 metadata 中提取关键统计信息用于显示
                      const stats = toolResult.metadata?.statistics;
                      if (stats) {
                        resultText = `工作区分析完成: 共${stats.totalBlocks}个块，${stats.independentStructures}个独立结构，最大深度${stats.maxDepth}层`;
                      } else {
                        resultText = `工作区分析完成`;
                      }
                    }
                    break;
                  case 'todo_write_tool':
                    console.log('[TODO工具被调用]', toolArgs);
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing", 
  "text": "正在管理TODO项目...",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    // 将当前会话ID传递给todoWriteTool，确保每个会话的TODO数据独立存储
                    const todoArgs = { ...toolArgs, sessionId: this.sessionId };
                    toolResult = await todoWriteTool(todoArgs);
                    if (toolResult.is_error) {
                      resultState = "warn";
                      resultText = 'TODO操作异常,即将重试';
                    } else {
                      // 根据操作类型显示不同的成功消息
                      const operation = toolArgs.operation || 'unknown';
                      const itemTitle = toolArgs.content || toolArgs.title || '项目';

                      // 基础成功消息
                      let baseMessage = '';
                      switch (operation) {
                        case 'add':
                          baseMessage = `TODO项目添加成功: ${itemTitle}`;
                          break;
                        case 'batch_add':
                          baseMessage = `TODO项目批量添加成功`;
                          break;
                        case 'list':
                          baseMessage = `TODO列表获取成功`;
                          break;
                        case 'update':
                          baseMessage = `TODO项目更新成功`;
                          break;
                        case 'toggle':
                          baseMessage = `TODO项目状态切换成功`;
                          break;
                        case 'delete':
                          baseMessage = `TODO项目删除成功`;
                          break;
                        case 'clear':
                          baseMessage = `TODO列表清空成功`;
                          break;
                        case 'query':
                          baseMessage = `TODO查询完成`;
                          break;
                        case 'stats':
                          baseMessage = `TODO统计完成`;
                          break;
                        default:
                          baseMessage = `TODO操作完成`;
                      }

                      // // 如果有todos数据，添加任务列表显示
                      // if (toolResult.todos && Array.isArray(toolResult.todos) && toolResult.todos.length > 0) {
                      //   const todoList = toolResult.todos.map(todo => {
                      //     const statusIcon = todo.status === 'completed' ? '✅' : 
                      //                       todo.status === 'in_progress' ? '🔄' : '⏸️';
                      //     const priorityIcon = todo.priority === 'high' ? '🔴' : 
                      //                         todo.priority === 'medium' ? '🟡' : '🟢';
                      //     return `${priorityIcon} ${todo.content} ${statusIcon}`;
                      //   }).join('\n');

                      //   resultText = `${baseMessage}\n\n当前任务列表:\n${todoList}`;
                      // } else {
                      resultText = baseMessage;
                      // }
                    }
                    break;
                }
              }

              // 根据执行结果确定状态
              if (toolResult && toolResult.is_error) {
                resultState = "error";
              } else if (toolResult && toolResult.warning) {
                resultState = "warn";
              }
            } catch (error) {
              console.error('工具执行出错:', error);
              resultState = "warn";
              toolResult = {
                is_error: true,
                content: `工具执行出错: ${error.message || '未知错误'}`
              };
            }

            this.toolCallStates[data.tool_id] = resultText;
            this.send("tool", JSON.stringify({
              "type": "tool",
              "tool_id": data.tool_id,
              "content": toolResult?.content || '',
              "resultText": this.makeJsonSafe(resultText),
              "is_error": toolResult.is_error
            }, null, 2), false);
          } else if (data.type === 'user_input_required') {
            // 处理用户输入请求 - 需要用户补充消息时停止等待状态
            // 设置最后一条消息状态为done
            if (this.list.length > 0 && this.list[this.list.length - 1].role === 'aily') {
              this.list[this.list.length - 1].state = 'done';
            }
            this.isWaiting = false;
          }
          this.scrollToBottom();
        } catch (e) {
          console.log('处理流数据时出错:', e);
          this.appendMessage('error', `

\`\`\`aily-error
{
  "message": "服务异常，请稍后重试。"
}
\`\`\`\n\n

          `);
          // 调用取消函数
          this.stop();
        }
      },
      complete: () => {
        console.log('streamConnect complete: ', this.list[this.list.length - 1]);
        // 设置最后一条消息状态为done（输出完成）
        if (this.list.length > 0 && this.list[this.list.length - 1].role === 'aily') {
          this.list[this.list.length - 1].state = 'done';
        }
        this.isWaiting = false;
        this.isCompleted = true;

        // TODO: 处理停止原因
      },
      error: (err) => {
        console.error('流连接出错:', err);
        // 设置最后一条AI消息状态为done（如果存在）
        if (this.list.length > 0 && this.list[this.list.length - 1].role === 'aily') {
          this.list[this.list.length - 1].state = 'done';
        }
        this.appendMessage('error', `

\`\`\`aily-error
{
  "message": "连接中断。"
}
\`\`\`\n\n

`);
        this.isWaiting = false;
      }
    });
  }

  getHistory(): void {
    if (!this.sessionId) return;

    console.log('获取历史消息，sessionId:', this.sessionId);
    this.chatService.getHistory(this.sessionId).subscribe((res: any) => {
      console.log('get history', res);
      if (res.status === 'success') {
        // 为历史消息添加状态，如果没有state属性则默认为done
        const historyData = res.data.map(item => {
          if (!item.hasOwnProperty('state')) {
            item.state = 'done';
          }
          return item;
        });
        // 合并历史消息和当前消息列表
        // this.list = [...this.list, ...historyData];
        // 将历史记录逐条添加到消息列表中
        if (historyData && historyData.length > 0) {
          historyData.forEach(message => {
            this.appendMessage(message.role, message.content);
          });
        }

        // console.log('历史消息:', this.list);

        this.scrollToBottom();
      } else {
        this.appendMessage('error', res.message);
      }
    });
  }

  bottomHeight = 180;
  onContentResize({ height }: NzResizeEvent): void {
    this.bottomHeight = height!;
  }

  // 当使用ctrl+enter时发送消息
  async onKeyDown(event: KeyboardEvent) {
    if (event.ctrlKey && event.key === 'Enter') {
      if (this.isWaiting) {
        return;
      }

      if (this.isCompleted) {
        console.log('上次会话已完成，需要重新启动会话');
        await this.resetChat();
      }

      this.send("user", this.inputValue.trim(), true);
      this.selectContent = [];
      this.inputValue = "";
      event.preventDefault();
    }
  }

  getRandomString() {
    return (
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15)
    );
  }

  splitContent(content: any) {
    // 正则表达式，匹配```blockly到下一个```之间的内容
    const regex = /```blockly([\s\S]*?)```/g;

    // 使用正则表达式进行匹配
    const matches = content.match(regex);

    // 处理匹配结果，将每次```blockly前面的内容也作为一个分段
    let segments: any = [];
    let lastIndex = 0;

    if (matches) {
      matches.forEach((match) => {
        const startIndex = content.indexOf(match, lastIndex);

        // 添加```blockly前面的内容
        if (startIndex > 0) {
          segments.push(content.slice(lastIndex, startIndex));
        }

        // 添加```blockly到```之间的内容
        segments.push(match);

        // 更新lastIndex
        lastIndex = startIndex + match.length;
      });

      // 添加最后一段内容（如果有）
      if (lastIndex < content.length) {
        segments.push(content.slice(lastIndex));
      }
    } else {
      // 如果没有匹配到```blockly，则整个content作为一段
      segments.push(content);
    }

    return segments;
  }

  scrollToBottom() {
    // 只在自动滚动启用时才滚动到底部
    if (!this.autoScrollEnabled) {
      return;
    }

    setTimeout(() => {
      try {
        if (this.chatContainer?.nativeElement) {
          const element = this.chatContainer.nativeElement;
          const currentScrollTop = element.scrollTop;
          const maxScrollTop = element.scrollHeight - element.clientHeight;

          // 只有当不在底部时才滚动，避免不必要的滚动
          if (currentScrollTop < maxScrollTop - 2) {
            // 使用 scrollTo 方法实现平滑滚动
            element.scrollTo({
              top: element.scrollHeight,
              behavior: 'smooth'
            });
          }
        }
      } catch (error) {
        console.warn('滚动到底部失败:', error);
      }
    }, 100);
  }

  /**
   * 检查用户是否手动向上滚动，如果是则禁用自动滚动
   */
  checkUserScroll() {
    if (!this.chatContainer?.nativeElement) {
      return;
    }

    const element = this.chatContainer.nativeElement;
    const threshold = 30; // 减小容差值，提高检测精度
    const isAtBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - threshold;

    // 如果用户不在底部，说明手动向上滚动了，禁用自动滚动
    if (!isAtBottom && this.autoScrollEnabled) {
      this.autoScrollEnabled = false;
      console.log('用户手动滚动，已禁用自动滚动');
    }
    // 如果用户滚动到底部附近，重新启用自动滚动
    else if (isAtBottom && !this.autoScrollEnabled) {
      this.autoScrollEnabled = true;
      console.log('用户滚动到底部，已启用自动滚动');
    }
  }

  HistoryList: IMenuItem[] = [
    // {
    //   name: '如何学习arduino如何学习arduino如何学习arduino'
    // },
    // {
    //   name: '制作一个ros小车'
    // },
    // {
    //   name: '历史记录3',
    // }
  ]

  // AI模式列表
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

  // 当前AI模式
  // currentMode = 'agent'; // 默认为代理模式

  async stopAndCloseSession() {
    try {
      // 等待停止操作完成
      await new Promise<void>((resolve, reject) => {
        if (!this.sessionId) {
          resolve();
          return;
        }

        // 设置超时，避免无限等待
        const timeout = setTimeout(() => {
          console.warn('停止会话超时，继续执行');
          resolve();
        }, 5000);

        this.chatService.stopSession(this.sessionId).subscribe({
          next: (res: any) => {
            clearTimeout(timeout);
            console.log('会话已停止:', res);
            this.isWaiting = false;
            resolve();
          },
          error: (err) => {
            clearTimeout(timeout);
            console.error('停止会话失败:', err);
            resolve(); // 即使失败也继续
          }
        });
      });

      // 等待关闭会话完成
      await new Promise<void>((resolve, reject) => {
        if (!this.sessionId) {
          resolve();
          return;
        }

        // 设置超时，避免无限等待
        const timeout = setTimeout(() => {
          console.warn('关闭会话超时，继续执行');
          resolve();
        }, 5000);

        this.chatService.closeSession(this.sessionId).subscribe({
          next: (res: any) => {
            clearTimeout(timeout);
            console.log('会话已关闭:', res);
            resolve();
          },
          error: (err) => {
            clearTimeout(timeout);
            console.error('关闭会话失败:', err);
            resolve(); // 即使失败也继续
          }
        });
      });
    } catch (error) {
      console.error('停止和关闭会话失败:', error);
      throw error; // 抛出错误，让调用者处理
    }
  }

  async newChat() {
    console.log('启动新会话');

    // 防止重复创建新会话
    if (this.isSessionStarting) {
      console.log('新会话正在创建中，跳过重复调用');
      return;
    }

    this.list = [...this.defaultList.map(item => ({...item}))];

    console.log("CurrentList: ", this.list);
    // 新会话时重新启用自动滚动
    this.autoScrollEnabled = true;
    this.isCompleted = false;

    try {
      // 先停止并关闭当前会话
      await this.stopAndCloseSession();

      // 确保会话完全关闭后再清空ID
      this.chatService.currentSessionId = '';

      // 重置会话启动标志和初始化标志
      this.isSessionStarting = false;
      this.hasInitializedForThisLogin = false;

      // 等待一小段时间确保所有异步操作完成
      await new Promise(resolve => setTimeout(resolve, 100));

      // 启动新会话
      await this.startSession();

    } catch (error) {
      console.error('新会话启动失败:', error);

      // 即使失败也要确保标志位重置
      this.isSessionStarting = false;
    }
  }

  selectContent: ResourceItem[] = []
  showAddList = false;
  openAddList() {
    this.showAddList = !this.showAddList;
  }

  async addFile() {
    const options = {
      title: '选择文件或文件夹',
      properties: ['multiSelections'],
      filters: [
        { name: '所有文件', extensions: ['*'] }
      ]
    };
    const result = await window['dialog'].selectFiles(options);
    console.log('文件选择结果:', result);
    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
      // 处理选中的文件/文件夹
      const selectedPaths = result.filePaths;

      // 将选中的文件添加到资源数组中
      selectedPaths.forEach(path => {
        // 检查是否已经存在
        const exists = this.selectContent.some(item =>
          item.type === 'file' && item.path === path
        );

        if (!exists) {
          const fileName = path.split(/[/\\]/).pop() || path;
          this.selectContent.push({
            type: 'file',
            path: path,
            name: fileName
          });
        }
      });

      console.log('已添加的文件:', selectedPaths);
      console.log('当前资源列表:', this.selectContent);
    } else {
      console.log('用户取消了文件选择或没有选择文件');
    }
  }

  async addFolder() {
    const options = {
      title: '选择文件夹',
      properties: ['openDirectory']
    };
    const result = await window['dialog'].selectFiles(options);
    console.log('文件夹选择结果:', result);
    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
      // 处理选中的文件夹
      const selectedPath = result.filePaths[0];

      // 检查是否已经存在
      const exists = this.selectContent.some(item =>
        item.type === 'folder' && item.path === selectedPath
      );

      if (!exists) {
        const folderName = selectedPath.split(/[/\\]/).pop() || selectedPath;
        this.selectContent.push({
          type: 'folder',
          path: selectedPath,
          name: folderName
        });
      }

      console.log('已添加的文件夹:', selectedPath);
      console.log('当前资源列表:', this.selectContent);
    } else {
      console.log('用户取消了文件夹选择或没有选择文件夹');
    }
  }


  addUrl() {
    // 可以添加一个对话框让用户输入URL
    const url = prompt('请输入URL地址:');
    if (url && url.trim()) {
      // 检查是否已经存在
      const exists = this.selectContent.some(item =>
        item.type === 'url' && item.url === url.trim()
      );

      if (!exists) {
        try {
          const urlObj = new URL(url.trim());
          const urlName = urlObj.hostname + urlObj.pathname;
          this.selectContent.push({
            type: 'url',
            url: url.trim(),
            name: urlName
          });
          console.log('已添加的URL:', url.trim());
          console.log('当前资源列表:', this.selectContent);
        } catch (error) {
          this.message.error('无效的URL格式');
        }
      } else {
        this.message.warning('该URL已经存在');
      }
    }
  }

  /**
   * 移除资源项
   * @param index 要移除的资源项索引
   */
  removeResource(index: number) {
    if (index >= 0 && index < this.selectContent.length) {
      this.selectContent.splice(index, 1);
    }
  }

  /**
   * 清空所有资源
   */
  clearAllResources() {
    this.selectContent = [];
  }

  /**
   * 获取资源列表的文本描述，用于发送给AI
   */
  getResourcesText(): string {
    if (this.selectContent.length === 0) {
      return '';
    }

    const fileItems = this.selectContent.filter(item => item.type === 'file');
    const folderItems = this.selectContent.filter(item => item.type === 'folder');
    const urlItems = this.selectContent.filter(item => item.type === 'url');

    let text = '';

    if (fileItems.length > 0) {
      text += '参考文件:\n';
      text += fileItems.map(item => `- ${item.path}`).join('\n');
      text += '\n\n';
    }

    if (folderItems.length > 0) {
      text += '参考文件夹:\n';
      text += folderItems.map(item => `- ${item.path}`).join('\n');
      text += '\n\n';
    }

    if (urlItems.length > 0) {
      text += '参考URL:\n';
      text += urlItems.map(item => `- ${item.url}`).join('\n');
      text += '\n\n';
    }

    // 将整个资源描述文本包裹在context标签中
    if (text) {
      text = `<context>\n${text}</context>`;
    }

    return text.trim();
  }

  showHistoryList = false;
  showMode = false;
  historyListPosition = { x: 0, y: 0 };
  modeListPosition = { x: 0, y: 0 };

  openHistoryChat(e) {
    // 设置菜单的位置
    this.historyListPosition = { x: window.innerWidth - 302, y: 72 };
    console.log(this.historyListPosition);

    this.showHistoryList = !this.showHistoryList;
  }

  closeMenu() {
    this.showHistoryList = false;
    this.showMode = false;
  }

  menuClick(e) {

  }

  // 模式选择相关方法
  switchMode(event: MouseEvent) {
    // 获取点击的按钮元素
    const target = event.currentTarget as HTMLElement;
    if (target) {
      // 获取按钮的位置信息
      const rect = target.getBoundingClientRect();

      // 计算菜单位置：在按钮上方显示，并且考虑右对齐
      const menuWidth = 130; // 菜单宽度
      const menuHeight = 68; // 预估菜单高度

      // 计算水平位置：右对齐到按钮右边缘
      let x = rect.left;

      // 计算垂直位置：在按钮上方显示
      let y = rect.top - menuHeight - 1;

      // 边界检查：如果菜单会超出屏幕左边界，则左对齐到按钮左边缘
      if (x < 0) {
        x = rect.left;
      }

      // 边界检查：如果菜单会超出屏幕上边界，则显示在按钮下方
      if (y < 0) {
        y = rect.bottom - 1;
      }

      // 设置菜单位置
      this.modeListPosition = { x: Math.max(0, x), y: Math.max(0, y) };
    } else {
      // 如果无法获取按钮位置，使用默认位置
      this.modeListPosition = { x: window.innerWidth - 302, y: window.innerHeight - 280 };
    }

    // 阻止事件冒泡，避免触发其他点击事件
    event.preventDefault();
    event.stopPropagation();

    this.showMode = !this.showMode;
  }

  modeMenuClick(item: IMenuItem) {
    if (item.data?.mode && item.data.mode !== this.currentMode) {
      this.switchToMode(item.data.mode);
      // if (this.currentMode != item.data.mode) {
      //   // 判断是否已经有对话内容产生，有则提醒切换模式会创建新的session
      //   if (this.list.length > 1) {
      //     // 显示确认弹窗
      //     this.modal.confirm({
      //       nzTitle: '确认切换模式',
      //       nzContent: '切换AI模式会创建新的对话会话, 是否继续？',
      //       nzOkText: '确认',
      //       nzCancelText: '取消',
      //       nzOnOk: () => {
      //         this.switchToMode(item.data.mode);
      //       },
      //       nzOnCancel: () => {
      //         console.log('用户取消了模式切换');
      //       }
      //     });
      //     return;
      //   }

      //   this.switchToMode(item.data.mode);
      // }
    }
    this.showMode = false;
  }

  /**
   * 切换AI模式并创建新会话
   * @param mode 要切换到的模式
   */
  private async switchToMode(mode: string) {
    // 暂禁止切换为agent模式
    if (mode === 'agent') {
      this.message.warning('当前账号暂时无法使用该模式！');
      return;
    }
    this.chatService.currentMode = mode;
    console.log('切换AI模式为:', this.currentMode);
    await this.stopAndCloseSession();
    await this.startSession();
  }

  /**
   * 清理订阅
   */
  ngOnDestroy() {
    console.log('AilyChatComponent 正在销毁...');

    // 清理消息订阅
    if (this.messageSubscription) {
      this.messageSubscription.unsubscribe();
      this.messageSubscription = null;
    }
    if (this.textMessageSubscription) {
      this.textMessageSubscription.unsubscribe();
      this.textMessageSubscription = null;
    }

    // 清理登录状态订阅
    if (this.loginStatusSubscription) {
      this.loginStatusSubscription.unsubscribe();
      this.loginStatusSubscription = null;
    }

    // 重置会话启动标志和MCP初始化标志
    this.isSessionStarting = false;
    this.mcpInitialized = false;
    this.hasInitializedForThisLogin = false;

    this.disconnect();
  }

  // 添加订阅管理
  private messageSubscription: any;

  // 工具调用状态管理
  toolCallStates: { [key: string]: string } = {};


  demandEdit() {

  }
}
