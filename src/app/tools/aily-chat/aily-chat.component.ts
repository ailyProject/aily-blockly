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
import { Observable, tap, Subscription } from 'rxjs';
import { ChatService } from './services/chat.service';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { SimplebarAngularComponent, SimplebarAngularModule } from 'simplebar-angular';
import { MenuComponent } from '../../components/menu/menu.component';
import { IMenuItem } from '../../configs/menu.config';
import { McpService } from './services/mcp.service';
import { ProjectService } from '../../services/project.service';
import { CmdOutput, CmdService } from '../../services/cmd.service';
import { ElectronService } from '../../services/electron.service';
// import { ChatListExamples } from './chat.example';
import { BlocklyService } from '../../blockly/blockly.service';

import { newProjectTool } from './tools/createProjectTool';
import { executeCommandTool } from './tools/executeCommandTool';
import { askApprovalTool } from './tools/askApprovalTool';
import { getContextTool } from './tools/getContextTool';
import { fileOperationsTool } from './tools/fileOperationsTool';
import { fetchTool, FetchToolService } from './tools/fetchTool';

const { pt } = (window as any)['electronAPI'].platform;

export interface Tool {
  name: string;
  description: string;
  input_schema: { [key: string]: any };
}

import { ChatCommunicationService, ChatTextOptions } from '../../services/chat-communication.service';

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
    SimplebarAngularModule,
    MenuComponent
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
  @ViewChild('simplebarRef') simplebarRef: SimplebarAngularComponent;
  @ViewChild('chatList') chatList: ElementRef;
  @ViewChild('chatTextarea') chatTextarea: ElementRef;

  isUserInputRequired = false;

  list: any = [];
  // list = ChatListExamples  // 示例数据

  currentUrl;
  inputValue = '';
  prjRootPath = '';
  prjPath = '';

  windowInfo = 'AI助手';

  private textMessageSubscription: Subscription;

  get sessionId() {
    return this.chatService.currentSessionId;
  }

  // 内置工具
  tools: Tool[] = [
    {
      name: 'create_project',
      description: `创建一个新项目，返回项目路径。需要提供开发板信息，包含名称、昵称和版本号。`,
      input_schema: {
        type: 'object',
        properties: {
          board: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '板子名称' },
              nickname: { type: 'string', description: '板子昵称' },
              version: { type: 'string', description: '版本号' }
            },
            description: '开发板信息'
          },
        },
        required: ['board']
      }
    },
    {
      name: 'execute_command',
      description: `执行系统CLI命令。用于执行系统操作或运行特定命令来完成用户任务中的任何步骤。支持命令链，优先使用相对命令和路径以保持终端一致性。`,
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '执行的命令' },
          cwd: { type: 'string', description: '工作目录，可选' }
        },
        required: ['command']
      }
    },
//     {
//       name: "ask_approval",
//       description: `
//         ## ask_approval
// ### Description
// 向用户请求确认或批准某个操作。此工具用于在执行可能影响用户的操作之前，确保用户明确同意。
// ### Parameters
// - message: (required) 需要用户确认的消息内容。
// ### Usage
// <ask_approval>
// <message>需要用户确认的消息</message>
// </ask_approval>`,
//       input_schema: {
//         type: 'object',
//         properties: {
//           message: { type: 'string', description: '需要用户确认的消息' }
//         },
//         required: ['message']
//       }
//     },
    {
      name: "get_context",
      description: `获取当前的环境上下文信息，包括项目路径、当前平台、系统环境等。可以指定获取特定类型的上下文信息。`,
      input_schema: {
        type: 'object',
        properties: {
          info_type: { 
            type: 'string', 
            description: '要获取的上下文信息类型',
            enum: ['all', 'project', 'platform', 'system'],
            default: 'all'
          }
        }
      }
    },
    {
      name: "file_operations",
      description: `执行文件和文件夹操作，包括创建、读取、编辑、删除、重命名文件或文件夹，获取目录树，以及检查文件是否存在。支持相对路径和绝对路径。`,
      input_schema: {
        type: 'object',
        properties: {
          operation: { 
            type: 'string', 
            description: '要执行的操作类型',
            enum: ['list', 'read', 'create', 'edit', 'delete', 'exists', 'rename', 'tree']
          },
          path: { 
            type: 'string', 
            description: '文件或文件夹的基础路径'
          },
          name: { 
            type: 'string', 
            description: '文件或文件夹的名称，会与path结合构成完整路径'
          },
          content: { 
            type: 'string', 
            description: '文件内容（用于创建或编辑操作）'
          },
          is_folder: { 
            type: 'boolean', 
            description: '指定目标是否为文件夹',
            default: false
          },
          maxDepth: { 
            type: 'number', 
            description: '目录树的最大深度（仅用于tree操作）',
            default: 3
          }
        },
        required: ['operation', 'path']
      }
    },
    {
      name: "fetch",
      description: `获取网络上的信息和资源，支持HTTP/HTTPS请求，能够处理大文件下载。支持多种请求方法和响应类型。`,
      input_schema: {
        type: 'object',
        properties: {
          url: { 
            type: 'string', 
            description: '要请求的URL地址'
          },
          method: { 
            type: 'string', 
            description: 'HTTP请求方法',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
            default: 'GET'
          },
          headers: { 
            type: 'object', 
            description: '请求头（键值对）'
          },
          body: { 
            description: '请求体'
          },
          timeout: { 
            type: 'number', 
            description: '请求超时时间（毫秒）',
            default: 30000
          },
          maxSize: { 
            type: 'number', 
            description: '最大文件大小（字节）',
            default: 52428800
          },
          responseType: { 
            type: 'string', 
            description: '响应类型',
            enum: ['text', 'json', 'blob', 'arraybuffer'],
            default: 'text'
          }
        },
        required: ['url']
      }
    }
  ]


  constructor(
    private uiService: UiService,
    private chatService: ChatService,
    private mcpService: McpService,
    private projectService: ProjectService,
    private cmdService: CmdService,
    private electronService: ElectronService,
    private blocklyService: BlocklyService,
    private fetchToolService: FetchToolService,
    private chatCommunicationService: ChatCommunicationService,
    private router: Router
  ) { }

  ngOnInit() {
    // if (this.electronService.isElectron) {
    //   this.prjPath = window['path'].getUserDocuments() + `${pt}aily-project${pt}`;
    // }

    this.prjPath = this.projectService.currentProjectPath === this.projectService.projectRootPath? "" : this.projectService.currentProjectPath;
    this.prjRootPath = this.projectService.projectRootPath;

    // 订阅消息
    this.currentUrl = this.router.url;
    // 订阅外部文本消息
    this.textMessageSubscription = this.chatCommunicationService.getTextMessages().subscribe(
      message => {
        this.receiveTextFromExternal(message.text, message.options);
      }
    );

    // runCommandTool
    executeCommandTool(this.cmdService, { command: 'npm i C:\\Users\\stao\\Downloads\\Adafruit_SGP30-master\\Adafruit_SGP30-master\\dist', cwd: this.prjPath }).then(result => {
      console.log('Command Tool Result:', result);
    });
  }

  /**
   * 接收来自外部组件的文本并显示在输入框中
   * @param text 接收到的文本
   * @param options 发送选项，包含 sender、type、cover 等参数
   */
  receiveTextFromExternal(text: string, options?: ChatTextOptions): void {
    console.log('接收到外部文本:', text, '选项:', options);
    
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

      // 如果设置了自动发送，则立即发送
      if (options?.autoSend) {
        this.send();
      }
    }, 100);
  }

  close() {
    // 关闭stream连接
    this.closeSession();
    this.uiService.closeTool('aily-chat');
  }

  ngAfterViewInit(): void {
    this.scrollToBottom();
    this.mcpService.init().then(() => {
      this.startSession();
    })
  }

  appendMessage(role, text) {
    // 判断是否是JSON格式的字符串
    // if (role != 'user') {
    //   console.log('收到数据:');
    //   console.log(text);
    // }

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
    // console.log("listRole: ", this.list[this.list.length - 1]?.role, role);
    if (this.list.length > 0 && this.list[this.list.length - 1].role === role) {
      // 如果是同一个role，追加内容到最后一条消息
      this.list[this.list.length - 1].content += text;
    } else {
      // console.log("添加新消息: ", role);
      // 如果是不同的role或列表为空，创建新的消息
      this.list.push({
        "role": role,
        "content": text
      });
    }
  }

  startSession(): void {
    // tools + mcp tools
    let tools = this.tools;
    let mcpTools = this.mcpService.tools.map(tool => {
      tool.name = "mcp_" + tool.name;
      return tool;
    });
    if (mcpTools && mcpTools.length > 0) {
      tools = tools.concat(mcpTools);
    }

    this.chatService.startSession(tools).subscribe({
      next: (res: any) => {
        if (res.status === 'success') {
          this.chatService.currentSessionId = res.data;
          this.streamConnect();
          this.getHistory();
        } else {
          this.appendMessage('错误', '启动会话失败: ' + (res.message || '未知错误'));
        }
      },
      error: (err) => {
        console.error('启动会话失败:', err);
        if (err.status === 0) {
          this.appendMessage('错误', '网络连接失败，请检查您的网络连接后重试。');
        } else if (err.status === 408 || err.statusText === 'timeout') {
          this.appendMessage('错误', '连接超时，服务器可能暂时不可用，请稍后重试。');
        } else {
          this.appendMessage('错误', '启动会话失败: ' + (err.message || '网络错误，请检查连接后重试。'));
        }
      }
    });
  }

  closeSession(): void {
    if (!this.sessionId) return;

    this.chatService.closeSession(this.sessionId).subscribe((res: any) => {
      // console.log('close session', res);
    });
  }

  send(show: boolean = true): void {
    if (!this.sessionId || !this.inputValue.trim()) return;

    let text = this.inputValue.trim();
    if (show) this.appendMessage('user', text);
    this.inputValue = '';

    if (this.isUserInputRequired) {
      this.isUserInputRequired = false;
      text = JSON.stringify({
        "type": "user_input",
        "content": text
      }, null, 2);
    }

    this.chatService.sendMessage(this.sessionId, text).subscribe((res: any) => {
      if (res.status === 'success') {
        if (res.data) {
          this.appendMessage('aily', res.data);
        }
      }
    });
    this.scrollToBottom();
  }

  streamConnect(): void {
    console.log("streeam connect sessionId: ", this.sessionId);
    if (!this.sessionId) return;

    this.chatService.streamConnect(this.sessionId).subscribe({
      next: async (data: any) => {
        console.log("收到消息: ", data);
        // Replace "/toUser" with empty string in data.data if it exists
        if (data.data && typeof data.data === 'string') {
          data.data = data.data.replace(/\/toUser/g, '');
        }
        try {
          if (data.type === 'agent_response') {
            if (data.data) {
              this.appendMessage('assistant', data.data);
            }
          } else if (data.type === 'processing_started') {
            console.log('助手正在思考...');
          } else if (data.type === 'error') {
            console.error('助手出错:', data.data);
          } else if (data.type === 'user_input_required') {
            this.isUserInputRequired = true;
          } else if (data.type === 'tool_call_request') {
            // 处理工具调用请求
            // {type: 'tool_call_request', tool_id: 'call_MUkyOCjghtJHq9hvmH37ysrf', tool_name: 'frontend_fetch_library_json', tool_args: {…}}

            let toolArgs;
            
            if (typeof data.tool_args === 'string') {
              try {
                // 对于字符串类型的参数，尝试解析 JSON
                toolArgs = JSON.parse(data.tool_args);
                // console.log('JSON 解析成功:', toolArgs);
              } catch (e) {
                // console.error('JSON 解析失败:', e);
                // console.error('原始字符串:', data.tool_args);
                
                // 如果 JSON 解析失败，尝试其他方法
                try {
                  // 尝试使用 Function 构造器安全地解析（比 eval 更安全）
                  toolArgs = new Function('return ' + data.tool_args)();
                  // console.log('Function 构造器解析成功:', toolArgs);
                } catch (e2) {
                  console.error('Function 构造器解析也失败:', e2);
                  
                  // 最后的备用方案：返回错误信息
                  this.inputValue = JSON.stringify({
                    "type": "tool_result",
                    "tool_id": data.tool_id,
                    "content": `工具调用参数解析失败:\nJSON解析错误: ${e.message}\n备用解析错误: ${e2.message}\n原始参数: ${data.tool_args}`,
                    "is_error": true
                  }, null, 2);
                  this.send();
                  return;
                }
              }
            } else if (typeof data.tool_args === 'object' && data.tool_args !== null) {
              // 如果已经是对象，直接使用，但进行一些修复
              toolArgs = data.tool_args;
              
              // 只对路径字段进行修复，避免影响内容中的转义字符
              if (toolArgs.path && typeof toolArgs.path === 'string') {
                const originalPath = toolArgs.path;
                
                // 修复路径中常见的转义问题（只修复明显的路径转义错误）
                let fixedPath = originalPath;
                
                // 修复特定的已知路径问题
                if (originalPath.includes('distlock.json')) {
                  fixedPath = originalPath.replace('distlock.json', 'dist\\block.json');
                  // console.log('修复了路径中的转义问题:', originalPath, '->', fixedPath);
                }
                
                // 修复路径分隔符的转义问题（只在路径上下文中）
                // 仅当字符串看起来像是一个路径时才进行修复
                if (/^[a-zA-Z]:\\|^\\\\|^\//.test(fixedPath) || fixedPath.includes('\\\\')) {
                  // 这是一个Windows路径或网络路径，修复双反斜杠问题
                  fixedPath = fixedPath.replace(/\\\\/g, '\\');
                }
                
                toolArgs.path = fixedPath;
                
                // 如果路径包含文件名但没有 name 字段，自动分离
                if (!toolArgs.name && /\.(json|txt|js|ts|html|css|py|cpp|ino|h)$/i.test(toolArgs.path)) {
                  const lastSeparatorIndex = Math.max(toolArgs.path.lastIndexOf('\\'), toolArgs.path.lastIndexOf('/'));
                  if (lastSeparatorIndex > 0) {
                    toolArgs.name = toolArgs.path.substring(lastSeparatorIndex + 1);
                    toolArgs.path = toolArgs.path.substring(0, lastSeparatorIndex);
                    // console.log('自动分离路径和文件名 - path:', toolArgs.path, ', name:', toolArgs.name);
                  }
                }
              }
              
              // console.log('使用修复后的对象:', toolArgs);
            } else {
              // 处理其他类型（null, undefined, number, boolean 等）
              console.warn('意外的工具参数类型:', typeof data.tool_args, data.tool_args);
              toolArgs = data.tool_args;
            }

            // console.log("toolArgsJson: ", toolArgs);

            // 生成随机ID用于状态跟踪
//             const toolCallId = `call_${this.getRandomString()}`;
            
//             // 添加正在处理状态消息
//             const toolDescription = this.getToolDescription(data.tool_name, toolArgs);
//             this.appendMessage('assistant', `
// \`\`\`aily-state
// {
//   "state": "doing",
//   "text": "正在执行: ${toolDescription}",
//   "id": "${toolCallId}"
// }
// \`\`\`
// `);

            let toolResult = null;
            let resultState = "done";
            try {
              if (data.tool_name.startsWith('mcp_')) {
                data.tool_name = data.tool_name.substring(4);
                toolResult = await this.mcpService.use_tool(data.tool_name, toolArgs);
              } else {
                switch (data.tool_name) {
                  case 'create_project':
                    console.log('创建项目工具被调用', toolArgs);
                    toolResult = await newProjectTool(this.projectService, this.prjRootPath, toolArgs);
                    break;
                  case 'execute_command':
                    console.log('执行command命令工具被调用', toolArgs);
                    // Check if cwd is specified, otherwise use project paths
                    if (!toolArgs.cwd) {
                      toolArgs.cwd = this.projectService.currentProjectPath || this.projectService.projectRootPath;
                    }
                    toolResult = await executeCommandTool(this.cmdService, toolArgs);
                    console.log("toolResult: ", toolResult);
                    if (!toolResult.is_error) {
                      // Check if this is an npm install command
                      const command = toolArgs.command;
                      if (command.includes('npm i') || command.includes('npm install')) {
                        console.log('检测到 npm install 命令，尝试加载库');
                        // Extract the package name
                        const npmRegex = /npm (i|install)\s+(@?[a-zA-Z0-9-_/.]+)/;
                        const match = command.match(npmRegex);

                        console.log('npmRegex match:', match);
                        
                        if (match && match[2]) {
                          const libPackageName = match[2];
                          console.log('Installing library:', libPackageName);
                          
                          // Get project path from command args or default
                          const projectPath = toolArgs.cwd || this.prjPath;
                          
                          // Load the library into blockly
                          try {
                            await this.blocklyService.loadLibrary(libPackageName, projectPath);
                          } catch (e) {
                            console.error('加载库失败:', e);
                            toolResult = {
                              is_error: true,
                              content: `加载库失败: ${e.message}`
                            };
                          }
                        } else {
                          this.projectService.projectOpen(this.prjPath);
                        }
                      }
                    }
                    break;
                  case 'ask_approval':
                    console.log('请求用户确认工具被调用', toolArgs);
                    toolResult = await askApprovalTool(toolArgs);
                    break;
                  case 'get_context':
                    console.log('获取上下文信息工具被调用', toolArgs);
                    toolResult = await getContextTool(this.projectService, toolArgs);
                    break;
                  case 'file_operations':
                    console.log("toolArgs: ", toolArgs);
                    toolResult = await fileOperationsTool(toolArgs);
                    break;
                  case 'fetch':
                    console.log('网络请求工具被调用', toolArgs);
                    toolResult = await fetchTool(this.fetchToolService, toolArgs);
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
              resultState = "error";
              toolResult = {
                is_error: true,
                content: `工具执行出错: ${error.message || '未知错误'}`
              };
            }
            
//             // 添加完成状态消息
//             this.appendMessage('assistant', `
// \`\`\`aily-state
// {
//   "state": "${resultState}",
//   "text": "执行${resultState === "done" ? "完成" : resultState === "warn" ? "警告" : "失败"}: ${toolDescription}",
//   "id": "${toolCallId}"
// }
// \`\`\`
// `);

            this.inputValue = JSON.stringify({
              "type": "tool_result",
              "tool_id": data.tool_id,
              "content": toolResult.content,
              "is_error": toolResult.is_error
            }, null, 2);
            this.send(false);
          }
          this.scrollToBottom();
        } catch (e) {
          console.error('解析消息出错:', e);
        }
      },
      error: (err) => {
        console.error('流连接出错:', err);
        this.appendMessage('错误', '连接中断，请刷新页面重试');
      }
    });
  }

  getHistory(): void {
    if (!this.sessionId) return;

    this.chatService.getHistory(this.sessionId).subscribe((res: any) => {
      console.log('get history', res);
      if (res.status === 'success') {
        this.list = res.data;
        this.scrollToBottom();
      } else {
        this.appendMessage('错误', res.message);
      }
    });
  }

  bottomHeight = 180;
  onContentResize({ height }: NzResizeEvent): void {
    this.bottomHeight = height!;
  }

  // 当使用ctrl+enter时发送消息
  onKeyDown(event: KeyboardEvent) {
    if (event.ctrlKey && event.key === 'Enter') {
      this.send();
      event.preventDefault();
    }
  }

  /**
   * 根据工具名称和参数生成简短描述
   * @param toolName 工具名称
   * @param toolArgs 工具参数
   * @returns 工具调用的简短描述
   */
  // getToolDescription(toolName: string, toolArgs: any): string {
  //   let description = toolName;
    
  //   try {
  //     if (toolName === 'create_project' && toolArgs.board) {
  //       description = `创建项目(${toolArgs.board.name || toolArgs.board.nickname || '未知开发板'})`;
  //     } else if (toolName === 'execute_command' && toolArgs.command) {
  //       // 截取命令前30个字符，避免过长
  //       const shortCommand = toolArgs.command.length > 30 
  //         ? toolArgs.command.substring(0, 30) + '...' 
  //         : toolArgs.command;
  //       description = `执行命令: ${shortCommand}`;
  //     } else if (toolName === 'ask_approval' && toolArgs.message) {
  //       description = `请求确认`;
  //     } else if (toolName === 'get_context') {
  //       description = `获取上下文信息(${toolArgs.info_type || 'all'})`;
  //     } else if (toolName === 'file_operations' && toolArgs.operation) {
  //       const path = toolArgs.path + (toolArgs.name ? `/${toolArgs.name}` : '');
  //       const shortPath = path.length > 25 ? '...' + path.substring(path.length - 25) : path;
  //       description = `文件操作: ${toolArgs.operation} ${shortPath}`;
  //     } else if (toolName === 'fetch' && toolArgs.url) {
  //       const url = new URL(toolArgs.url);
  //       description = `网络请求: ${url.hostname}`;
  //     } else if (toolName.startsWith('mcp_')) {
  //       description = `MCP工具: ${toolName.substring(4)}`;
  //     }
  //   } catch (e) {
  //     console.error('生成工具描述失败:', e);
  //   }
    
  //   return description;
  // }

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
    setTimeout(() => {
      if (this.simplebarRef) {
        const scrollElement = this.simplebarRef.SimpleBar?.getScrollElement();
        if (scrollElement) {
          scrollElement.scrollTop = scrollElement.scrollHeight;
        }
      }
    }, 50); // 增加延迟时间
  }

  HistoryList: IMenuItem[] = [
    {
      name: '如何学习arduino如何学习arduino如何学习arduino'
    },
    {
      name: '制作一个ros小车'
    },
    {
      name: '历史记录3',
    },
    {
      name: '历史记录4',
    },
    {
      name: '历史记录5',
    },
    {
      name: '历史记录6',
    },
    {
      name: '历史记录7',
    },
    {
      name: '历史记录8',
    }
  ]

  newChat() {
    this.list = [];
    this.chatService.currentSessionId = '';
    this.closeSession();
    this.startSession();
  }

  addFile() {
    // 添加参考文件
  }

  showHistoryList = false;
  historyListPosition = { x: 0, y: 0 };
  openHistoryChat(e) {
    // 设置菜单的位置
    this.historyListPosition = { x: window.innerWidth - 302, y: 72 };
    console.log(this.historyListPosition);

    this.showHistoryList = !this.showHistoryList;
  }

  closeMenu() {
    this.showHistoryList = false;
  }

  menuClick(e) {

  }

  /**
   * 清理订阅
   */
  ngOnDestroy() {
    // 清理消息订阅
    if (this.messageSubscription) {
      this.messageSubscription.unsubscribe();
    }
    if (this.textMessageSubscription) {
      this.textMessageSubscription.unsubscribe();
    }
  }

  // 添加订阅管理
  private messageSubscription: any;
}
