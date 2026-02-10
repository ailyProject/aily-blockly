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
import { Subscription, skip, distinctUntilChanged } from 'rxjs';
import { ChatService, ChatTextOptions, AVAILABLE_MODELS, ModelConfig } from './services/chat.service';
import { ModelConfigOption } from './services/aily-chat-config.service';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { MenuComponent } from '../../components/menu/menu.component';
import { IMenuItem } from '../../configs/menu.config';
import { McpService } from './services/mcp.service';
import { ProjectService } from '../../services/project.service';
import { CmdService } from '../../services/cmd.service';
import { PlatformService } from '../../services/platform.service';
import { ElectronService } from '../../services/electron.service';
import { newProjectTool } from './tools/createProjectTool';
import { executeCommandTool } from './tools/executeCommandTool';
import { askApprovalTool } from './tools/askApprovalTool';
import { getContextTool } from './tools/getContextTool';
import { getProjectInfoTool } from './tools/getProjectInfoTool';
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
import { grepTool } from './tools/grepTool';
import { searchBoardsLibrariesTool } from './tools/searchBoardsLibrariesTool';
import { getHardwareCategoriesTool } from './tools/getHardwareCategoriesTools';
import { getBoardParametersTool } from './tools/getBoardParametersTool';
import globTool from './tools/globTool';
import { fetchTool, FetchToolService } from './tools/fetchTool';
import {
  smartBlockTool,
  connectBlocksTool,
  createCodeStructureTool,
  configureBlockTool,
  // variableManagerTool,
  // findBlockTool,
  deleteBlockTool,
  getWorkspaceOverviewTool,  // 新增工具导入
  getActiveWorkspace,  // 导入工作区检测函数
  queryBlockDefinitionTool,
  // getBlockConnectionCompatibilityTool,
  // 新增：智能块分析工具
  analyzeLibraryBlocksTool,
  // intelligentBlockSequenceTool,
  verifyBlockExistenceTool,
  fixJsonString  // 导入 JSON 修复函数
} from './tools/editBlockTool';
// ABS 工具 (Aily Block Syntax)
// import { insertDslHandler, getDslHelpHandler } from './tools/dslTool';
import { syncAbsFileHandler } from './tools/syncAbsFileTool';
// // 原子化块操作工具
// import {
//   createSingleBlockTool,
//   connectBlocksSimpleTool,
//   setBlockFieldTool,
//   setBlockInputTool,
//   getWorkspaceBlocksTool,
//   batchCreateBlocksTool
// } from './tools/atomicBlockTools';
// // 扁平化块操作工具
// import { flatCreateBlocksTool } from './tools/flatBlockTools';
// // ABS 块操作工具 (Aily Block Syntax)
// import { dslCreateBlocksTool } from './tools/dslBlockTools';
import { todoWriteTool } from './tools';
// import { arduinoSyntaxTool } from './tools/arduinoSyntaxTool';
import { NzModalService } from 'ng-zorro-antd/modal';
import { ConfigService } from '../../services/config.service';
import { createSecurityContext } from './services/security.service';
import { AilyChatConfigService } from './services/aily-chat-config.service';

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

export enum ToolCallState {
  DOING = 'doing',
  DONE = 'done',
  WARN = 'warn',
  ERROR = 'error'
}

export interface ToolCallInfo {
  id: string;
  name: string;
  state: ToolCallState;
  text: string;
  args?: any;
}

import { NzMessageService } from 'ng-zorro-antd/message';
import { TOOLS } from './tools/tools';
import { AuthService } from '../../services/auth.service';
import { FloatingTodoComponent } from './components/floating-todo/floating-todo.component';
import { TodoUpdateService } from './services/todoUpdate.service';
import { ArduinoLintService } from './services/arduino-lint.service';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LoginComponent } from '../../components/login/login.component';
import { NoticeService } from '../../services/notice.service';
import { AilyChatSettingsComponent } from './components/settings/settings.component';
import { OnboardingService } from '../../services/onboarding.service';
import { AILY_CHAT_ONBOARDING_CONFIG } from '../../configs/onboarding.config';
import { AbsAutoSyncService } from './services/abs-auto-sync.service';
import { absVersionControlHandler } from './tools/absVersionControlTool';

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
    FloatingTodoComponent,
    TranslateModule,
    LoginComponent,
    AilyChatSettingsComponent
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

  // 用于区分“用户滚动” vs “内容高度变化导致的滚动回跳”
  private _scrollTrackLastTop: number | null = null;
  private _scrollTrackLastHeight: number | null = null;
  private _scrollTrackLastAtBottom: boolean | null = null;

  // defaultList: ChatMessage[] = [{
  //   "role": "system",
  //   "content": "欢迎使用AI助手服务，我可以帮助你 分析项目、转换blockly库、修复错误、生成程序，告诉我你需要什么帮助吧~🤓\n\n >当前为测试版本，可能会有不少问题，如遇故障，群里呼叫`奈何col`哦",
  //   "state": "done"
  // }];

  list: ChatMessage[] = [];
  // ...this.defaultList.map(item => ({ ...item }))
  // list = ChatListExamples  // 示例数据

  currentUrl;
  inputValue = '';
  prjRootPath = '';
  prjPath = '';
  currentUserGroup: string[] = [];

  // 会话期间允许访问的额外路径（用户添加的上下文文件/文件夹）
  sessionAllowedPaths: string[] = [];

  isCompleted = false;
  private isSessionStarting = false; // 防止重复启动会话的标志位
  private hasInitializedForThisLogin = false; // 标记是否已为当前登录状态初始化过
  private isCancelled = false; // 标记任务是否被用户取消，防止取消后工具结果触发重连

  private textMessageSubscription: Subscription;
  private loginStatusSubscription: Subscription;
  private aiWritingSubscription: Subscription;
  private aiWaitingSubscription: Subscription;
  private projectPathSubscription: Subscription; // 订阅项目路径变化
  private configChangedSubscription: Subscription; // 订阅配置变更
  private mcpInitialized = false; // 添加标志位防止重复初始化MCP
  
  // 任务操作相关
  private taskActionHandler: ((event: Event) => void) | null = null;
  private lastStopReason: string = ''; // 保存上次停止原因用于重试

  get sessionId() {
    return this.chatService.currentSessionId;
  }

  get sessionTitle() {
    return this.chatService.currentSessionTitle;
  }

  get currentMode() {
    return this.chatService.currentMode;
  }

  get currentModel() {
    return this.chatService.currentModel;
  }

  get currentModelName() {
    return this.chatService.currentModel?.name;
  }

  /**
   * 确保字符串在 JSON 中是安全的，转义特殊字符
   */
  private makeJsonSafe(str: string): string {
    if (!str) return str;
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  }

  /**
   * 显示工具调用状态信息
   * @param toolCallInfo 工具调用信息
   */
  private displayToolCallState(toolCallInfo: ToolCallInfo): void {
    const stateMessage = `
\`\`\`aily-state
{
  "state": "${toolCallInfo.state}",
  "text": "${this.makeJsonSafe(toolCallInfo.text)}",
  "id": "${toolCallInfo.id}"
}
\`\`\`\n\n
`;

    this.appendMessage('aily', stateMessage);

    // 如果是开始状态，存储到 toolCallStates 用于后续完成时使用
    if (toolCallInfo.state === ToolCallState.DOING) {
      this.toolCallStates[toolCallInfo.id] = toolCallInfo.text;
    }
  }

  /**
   * 开始工具调用 - 显示 doing 状态
   * @param toolId 工具调用ID
   * @param toolName 工具名称
   * @param text 显示文本
   * @param args 工具参数（可选，用于历史记录恢复）
   */
  private startToolCall(toolId: string, toolName: string, text: string, args?: any): void {
    // 添加JSON校验text字段
    text = this.makeJsonSafe(text);

    const toolCallInfo: ToolCallInfo = {
      id: toolId,
      name: toolName,
      state: ToolCallState.DOING,
      text: text,
      args: args
    };

    this.displayToolCallState(toolCallInfo);
  }

  /**
   * 完成工具调用 - 显示 done/warn/error 状态
   * @param toolId 工具调用ID
   * @param toolName 工具名称
   * @param state 完成状态
   * @param text 显示文本
   */
  private completeToolCall(toolId: string, toolName: string, state: ToolCallState, text: string): void {
    // 优先使用传入的文本，如果为空则使用历史状态文本
    const displayText = text || this.toolCallStates[toolId] || '';

    const toolCallInfo: ToolCallInfo = {
      id: toolId,
      name: toolName,
      state: state,
      text: displayText
    };

    this.displayToolCallState(toolCallInfo);

    // 清除状态缓存
    delete this.toolCallStates[toolId];
  }

  /**
   * 从历史记录恢复工具调用状态
   * 用于加载历史对话时重新显示工具调用状态
   * @param toolCallInfos 工具调用信息数组
   */
  private restoreToolCallStates(toolCallInfos: ToolCallInfo[]): void {
    toolCallInfos.forEach(info => {
      // 对于已完成的工具调用，直接显示最终状态
      if (info.state !== ToolCallState.DOING) {
        this.displayToolCallState(info);
      } else {
        // 对于进行中的工具调用，可能需要标记为超时或错误
        // 这里可以根据业务需求决定如何处理
        const timeoutInfo: ToolCallInfo = {
          ...info,
          state: ToolCallState.ERROR,
          text: `${info.text} (会话中断)`
        };
        this.displayToolCallState(timeoutInfo);
      }
    });
  }

  /**
   * 解析历史消息中
   * @param historyData 历史消息数组
   * @returns
   */
  private parseHistory(historyData: any[]): void {
    const toolCallMap = new Map<string, { name: string, args?: any }>();

    // 遍历历史数据，解析工具调用和执行结果
    historyData.forEach(item => {
      if (item.type === 'ToolCallRequestEvent' && Array.isArray(item.content)) {
        // 记录工具调用信息
        item.content.forEach(call => {
          if (call.id && call.name) {
            let args = null;
            try {
              args = call.arguments ? JSON.parse(call.arguments) : null;
            } catch (e) {
              console.warn('解析工具参数失败:', e);
            }

            toolCallMap.set(call.id, {
              name: call.name,
              args: args
            });

            // 显示工具开始状态
            const startText = this.generateToolStartText(call.name, args);
            const startInfo: ToolCallInfo = {
              id: call.id,
              name: call.name,
              state: ToolCallState.DOING,
              text: startText,
              args: args
            };
            this.displayToolCallState(startInfo);
          }
        });
      } else if (item.type === 'ToolCallExecutionEvent' && Array.isArray(item.content)) {
        // 处理工具执行结果
        item.content.forEach(result => {
          if (result.call_id && toolCallMap.has(result.call_id)) {
            const toolInfo = toolCallMap.get(result.call_id)!;
            const resultState = result?.is_error ? ToolCallState.ERROR : ToolCallState.DONE;
            const resultText = this.generateToolResultText(toolInfo.name, toolInfo.args, result);

            const completeInfo: ToolCallInfo = {
              id: result.call_id,
              name: toolInfo.name,
              state: resultState,
              text: resultText,
              args: toolInfo.args
            };
            this.displayToolCallState(completeInfo);

            // 清除已完成的工具调用记录
            toolCallMap.delete(result.call_id);
          }
        });
      } else {
        // 处理历史消息，标记其中的交互组件为历史模式
        const processedContent = this.markContentAsHistory(item.content);
        this.appendMessage(item.role, processedContent);
      }
    });

    // 处理未完成的工具调用（标记为中断）
    toolCallMap.forEach((toolInfo, callId) => {
      const timeoutInfo: ToolCallInfo = {
        id: callId,
        name: toolInfo.name,
        state: ToolCallState.ERROR,
        text: `${this.generateToolStartText(toolInfo.name, toolInfo.args)} (会话中断)`,
        args: toolInfo.args
      };
      this.displayToolCallState(timeoutInfo);
    });
  }

  /**
   * 标记消息内容为历史模式
   * 用于在历史记录渲染时隐藏交互按钮
   * @param content 消息内容
   * @returns 处理后的内容
   */
  private markContentAsHistory(content: string): string {
    if (!content || typeof content !== 'string') {
      return content;
    }

    // 匹配所有 aily-* 代码块，为其中的 JSON 添加 isHistory 标记
    // 使用更灵活的正则表达式匹配各种格式
    return content.replace(
      /```(aily-[a-z-]+)\s*([\s\S]*?)```/g,
      (match, blockType, jsonContent) => {
        try {
          const trimmedContent = jsonContent.trim();
          if (!trimmedContent) {
            return match;
          }
          const data = JSON.parse(trimmedContent);
          data.isHistory = true;
          return `\`\`\`${blockType}\n${JSON.stringify(data, null, 2)}\n\`\`\``;
        } catch (e) {
          // 如果解析 JSON 失败，返回原始内容
          return match;
        }
      }
    );
  }

  /**
   * 根据工具名称和参数生成开始状态的显示文本
   * @param toolName 工具名称
   * @param args 工具参数
   * @returns 显示文本
   */
  private generateToolStartText(toolName: string, args?: any): string {
    if (!args) return `正在执行工具: ${toolName}`;

    // 去除可能的 mcp_ 前缀
    const cleanToolName = toolName.startsWith('mcp_') ? toolName.substring(4) : toolName;

    switch (cleanToolName) {
      case 'create_project':
        return "创建项目...";
      case 'execute_command':
        return this.formatCommandDisplay(args.command || 'unknown');
      case 'get_context':
        return "获取上下文信息...";
      case 'get_project_info':
        return "获取项目信息...";
      case 'list_directory':
        const distFolderName = args.path ? this.getLastFolderName(args.path) : 'unknown';
        return `获取${distFolderName}目录内容`;
      case 'read_file':
        const readFileName = args.path ? this.getFileName(args.path) : 'unknown';
        return `读取: ${readFileName}`;
      case 'create_file':
        const createFileName = args.path ? this.getFileName(args.path) : 'unknown';
        return `创建: ${createFileName}`;
      case 'create_folder':
        const createFolderName = args.path ? this.getLastFolderName(args.path) : 'unknown';
        return `创建: ${createFolderName}`;
      case 'edit_file':
        const editFileName = args.path ? this.getFileName(args.path) : 'unknown';
        return `编辑: ${editFileName}`;
      case 'delete_file':
        const deleteFileName = args.path ? this.getFileName(args.path) : 'unknown';
        return `删除: ${deleteFileName}`;
      case 'delete_folder':
        const deleteFolderName = args.path ? this.getLastFolderName(args.path) : 'unknown';
        return `删除: ${deleteFolderName}`;
      case 'check_exists':
        const checkFileName = args.path ? this.getFileName(args.path) : '';
        const checkFolderName = args.path ? this.getLastFolderName(args.path) : '';
        return checkFileName ? `检查文件是否存在: ${checkFileName}` : `检查文件夹是否存在: ${checkFolderName}`;
      case 'get_directory_tree':
        const treeFolderName = args.path ? this.getLastFolderName(args.path) : 'unknown';
        return `获取目录树: ${treeFolderName}`;
      case 'fetch':
        const fetchUrl = args.url ? this.getUrlDisplayName(args.url) : 'unknown';
        return `进行网络请求: ${fetchUrl}`;
      case 'reload_project':
        return `重新加载项目...`;
      case 'edit_abi_file':
        if (args.replaceStartLine !== undefined) {
          if (args.replaceEndLine !== undefined && args.replaceEndLine !== args.replaceStartLine) {
            return `替换ABI文件第 ${args.replaceStartLine}-${args.replaceEndLine} 行内容...`;
          } else {
            return `替换ABI文件第 ${args.replaceStartLine} 行内容...`;
          }
        } else if (args.insertLine !== undefined) {
          return `ABI文件第 ${args.insertLine} 行插入内容...`;
        } else if (args.replaceMode === false) {
          return "向ABI文件末尾追加内容...";
        }
        return "编辑ABI文件...";
      case 'reload_abi_json':
        return "重新加载Blockly工作区数据...";
      // 原子化块工具
      case 'create_single_block':
        return `创建块: ${args.type || 'unknown'}`;
      case 'connect_blocks_simple':
        return `连接块: ${args.action || 'unknown'}`;
      case 'set_block_field':
        return `设置字段: ${args.fieldName || 'unknown'}`;
      case 'set_block_input':
        return `设置输入: ${args.inputName || 'unknown'}`;
      case 'get_workspace_blocks':
        return "获取工作区块列表...";
      // 扁平化块工具
      case 'flat_create_blocks':
        let flatBlockCount = 0;
        if (args?.blocks) {
          if (typeof args.blocks === 'string') {
            try {
              flatBlockCount = JSON.parse(args.blocks).length;
            } catch (e) {
              flatBlockCount = 0;
            }
          } else if (Array.isArray(args.blocks)) {
            flatBlockCount = args.blocks.length;
          }
        }
        return `扁平化创建块: ${flatBlockCount}个块...`;
      // ABS 块工具 (Aily Block Syntax)
      // case 'dsl_create_blocks':
      //   return `ABS 创建块...`;
      // 原有块工具
      case 'smart_block_tool':
        return `创建Blockly块: ${args.type || 'unknown'}`;
      case 'connect_blocks_tool':
        return "连接Blockly块...";
      case 'create_code_structure_tool':
        return `创建代码结构: ${args.structure || 'unknown'}`;
      case 'configure_block_tool':
        return "配置Blockly块...";
      case 'variable_manager_tool':
        const operation = args.operation;
        const operationText = operation === 'create' ? '创建' :
          operation === 'delete' ? '删除' :
            operation === 'rename' ? '重命名' : '列出';
        return `${operationText}变量...`;
      case 'delete_block_tool':
        return "删除Blockly块...";
      case 'get_workspace_overview_tool':
        return "分析工作区全览...";
      case 'queryBlockDefinitionTool':
        return "查询块定义信息...";
      case 'getBlockConnectionCompatibilityTool':
        return "分析块连接兼容性...";
      default:
        return `执行工具: ${cleanToolName}`;
    }
  }

  /**
   * 根据工具名称、参数和执行结果生成完成状态的显示文本
   * @param toolName 工具名称
   * @param args 工具参数
   * @param result 执行结果
   * @returns 显示文本
   */
  private generateToolResultText(toolName: string, args?: any, result?: any): string {
    if (result?.is_error) {
      return `${toolName} 执行失败`;
    }

    // 去除可能的 mcp_ 前缀
    const cleanToolName = toolName.startsWith('mcp_') ? toolName.substring(4) : toolName;

    switch (cleanToolName) {
      case 'create_project':
        return "项目创建成功";
      case 'execute_command':
        const cmdDisplay = this.formatCommandDisplay(args?.command || 'unknown');
        return `${cmdDisplay} ✓`;
      case 'get_context':
        return "上下文信息获取成功";
      case 'get_project_info':
        return "项目信息获取成功";
      case 'list_directory':
        const distFolderName = args?.path ? this.getLastFolderName(args.path) : 'unknown';
        return `获取${distFolderName}目录内容成功`;
      case 'read_file':
        const readFileName = args?.path ? this.getFileName(args.path) : 'unknown';
        return `读取${readFileName}文件成功`;
      case 'create_file':
        const createFileName = args?.path ? this.getFileName(args.path) : 'unknown';
        return `创建${createFileName}文件成功`;
      case 'create_folder':
        const createFolderName = args?.path ? this.getLastFolderName(args.path) : 'unknown';
        return `创建${createFolderName}文件夹成功`;
      case 'edit_file':
        const editFileName = args?.path ? this.getFileName(args.path) : 'unknown';
        return `编辑${editFileName}文件成功`;
      case 'delete_file':
        const deleteFileName = args?.path ? this.getFileName(args.path) : 'unknown';
        return `删除${deleteFileName}文件成功`;
      case 'delete_folder':
        const deleteFolderName = args?.path ? this.getLastFolderName(args.path) : 'unknown';
        return `删除${deleteFolderName}文件夹成功`;
      case 'check_exists':
        const checkFileName = args?.path ? this.getFileName(args.path) : '';
        const checkFolderName = args?.path ? this.getLastFolderName(args.path) : '';
        return checkFileName ? `文件 ${checkFileName} 存在` : `文件夹 ${checkFolderName} 存在`;
      case 'get_directory_tree':
        const treeFolderName = args?.path ? this.getLastFolderName(args.path) : 'unknown';
        return `获取目录树 ${treeFolderName} 成功`;
      case 'fetch':
        const fetchUrl = args?.url ? this.getUrlDisplayName(args.url) : 'unknown';
        return `网络请求 ${fetchUrl} 成功`;
      case 'reload_project':
        return "项目重新加载成功";
      case 'edit_abi_file':
        if (args?.insertLine !== undefined) {
          return `ABI文件第 ${args.insertLine} 行插入内容成功`;
        } else if (args?.replaceStartLine !== undefined) {
          if (args?.replaceEndLine !== undefined && args.replaceEndLine !== args.replaceStartLine) {
            return `ABI文件第 ${args.replaceStartLine}-${args.replaceEndLine} 行替换成功`;
          } else {
            return `ABI文件第 ${args.replaceStartLine} 行替换成功`;
          }
        } else if (args?.replaceMode === false) {
          return 'ABI文件内容追加成功';
        }
        return 'ABI文件编辑成功';
      case 'reload_abi_json':
        return 'ABI数据重新加载成功';
      // 原子化块工具结果
      case 'create_single_block':
        return `块创建成功: ${args?.type || 'unknown'}`;
      case 'connect_blocks_simple':
        return `块连接成功: ${args?.action || 'unknown'}`;
      case 'set_block_field':
        return `字段设置成功: ${args?.fieldName || 'unknown'}`;
      case 'set_block_input':
        return `输入设置成功: ${args?.inputName || 'unknown'}`;
      case 'get_workspace_blocks':
        return `获取块列表成功`;
      // 扁平化块工具结果
      case 'flat_create_blocks':
        let blocksCreated = result?.data?.stats?.blocksCreated || 0;
        if (blocksCreated === 0 && args?.blocks) {
          if (typeof args.blocks === 'string') {
            try {
              blocksCreated = JSON.parse(args.blocks).length;
            } catch (e) {
              blocksCreated = 0;
            }
          } else if (Array.isArray(args.blocks)) {
            blocksCreated = args.blocks.length;
          }
        }
        const connsCreated = result?.data?.stats?.connectionsEstablished || 0;
        return `扁平化创建成功: ${blocksCreated}个块, ${connsCreated}个连接`;
      // ABS 块工具结果 (Aily Block Syntax)
      // case 'dsl_create_blocks':
      //   return result?.is_error ? 'ABS 块创建失败' : 'ABS 块创建成功';
      // 原有块工具结果
      case 'smart_block_tool':
        return `智能块操作成功: ${args?.type || 'unknown'}`;
      case 'connect_blocks_tool':
        return `块连接成功: ${args?.connectionType || 'unknown'}连接`;
      case 'create_code_structure_tool':
        return `代码结构创建成功: ${args?.structure || 'unknown'}`;
      case 'configure_block_tool':
        return `块配置成功: ID ${args?.blockId || 'unknown'}`;
      case 'variable_manager_tool':
        const operation = args?.operation || 'unknown';
        const variableName = args?.variableName ? ` ${args.variableName}` : '';
        return `变量操作成功: ${operation}${variableName}`;
      case 'delete_block_tool':
        return `块删除成功`;
      case 'get_workspace_overview_tool':
        return `工作区分析完成`;
      case 'queryBlockDefinitionTool':
        return `块定义查询完成`;
      case 'getBlockConnectionCompatibilityTool':
        return `块连接兼容性分析完成`;
      default:
        return `${cleanToolName} 执行成功`;
    }
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
   * 格式化命令显示，特别处理路径相关命令
   * @param command 完整命令字符串
   * @param maxPathSegments 显示路径的最大段数（默认2）
   * @returns 格式化后的显示文本
   */
  private formatCommandDisplay(command: string, maxPathSegments: number = 2): string {
    if (!command) return 'unknown';

    const parts = command.trim().split(/\s+/);
    if (parts.length === 0) return 'unknown';

    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    // 命令名称映射表
    const specialCommands: Record<string, string> = {
      'cd': '切换到', 'mkdir': '创建目录', 'rmdir': '删除目录',
      'rm': '删除', 'del': '删除', 'remove': '删除',
      'cp': '复制', 'copy': '复制',
      'mv': '移动', 'move': '移动', 'rename': '重命名',
      'ls': '列出', 'dir': '列出', 'tree': '目录树',
      'cat': '查看', 'type': '查看', 'head': '查看', 'tail': '查看', 'less': '查看', 'more': '查看',
      'touch': '创建文件', 'echo': '输出', 'printf': '输出',
      'chmod': '修改权限', 'chown': '修改所有者',
      'grep': '搜索', 'find': '查找', 'locate': '定位',
      'tar': '压缩/解压', 'zip': '压缩', 'unzip': '解压', 'gzip': '压缩', 'gunzip': '解压',
      'curl': '请求', 'wget': '下载',
      'pip': 'pip', 'npm': 'npm', 'yarn': 'yarn', 'pnpm': 'pnpm', 'node': 'node', 'python': 'python',
      'git': 'git', 'svn': 'svn',
      'make': '构建', 'cmake': '配置构建', 'gcc': '编译', 'g++': '编译', 'clang': '编译',
      'sudo': '管理员执行', 'su': '切换用户',
      'ssh': '远程连接', 'scp': '远程复制', 'rsync': '同步',
      'ps': '进程列表', 'kill': '终止进程', 'top': '系统监控', 'htop': '系统监控',
      'df': '磁盘空间', 'du': '目录大小', 'free': '内存信息',
      'pwd': '当前目录', 'whoami': '当前用户', 'hostname': '主机名',
      'ping': '网络测试', 'ifconfig': '网络配置', 'ipconfig': '网络配置', 'netstat': '网络状态',
      'apt': 'apt', 'apt-get': 'apt-get', 'yum': 'yum', 'brew': 'brew', 'choco': 'choco',
      'systemctl': '服务管理', 'service': '服务管理',
      'docker': 'docker', 'kubectl': 'kubectl',
    };

    // 过滤掉选项参数（以 - 开头的）
    const filteredArgs = args.filter(a => !a.startsWith('-'));

    // 特殊处理 cd 命令（需要处理路径显示）
    if (cmd === 'cd' && filteredArgs.length > 0) {
      const targetPath = filteredArgs.join(' ').replace(/["']/g, '');
      const normalizedPath = targetPath.replace(/\\/g, '/');
      const pathParts = normalizedPath.split('/').filter(Boolean);

      if (pathParts.length > maxPathSegments) {
        return `切换到: .../${pathParts.slice(-maxPathSegments).join('/')}`;
      } else if (pathParts.length > 0) {
        return `切换到: ${pathParts.join('/')}`;
      }
      return 'cd';
    }

    // 如果命令在映射表中
    if (specialCommands[cmd]) {
      if (filteredArgs.length > 0) {
        const target = filteredArgs[filteredArgs.length - 1].replace(/["']/g, '');
        const name = target.split(/[\\/]/).pop() || target;
        return `${specialCommands[cmd]}: ${name}`;
      }
      return specialCommands[cmd];
    }

    // 其他命令：显示 "命令名 + 第一个参数"
    if (filteredArgs.length > 0) {
      return `${cmd} ${filteredArgs[0]}`;
    }
    return cmd;
  }

  /**
   * 解析正则表达式 pattern，提取关键词并格式化显示
   * 例如: '\\besp32\\b|\\barduino uno\\b' => 'esp32 | arduino uno'
   * @param pattern 正则表达式模式
   * @param maxLength 最大显示长度，超过则截断并添加省略号
   * @returns 格式化后的显示文本
   */
  formatSearchPattern(pattern: string, maxLength: number = 30): string {
    if (!pattern) return '未知模式';

    try {
      // 按 | 分割（处理正则表达式中的 OR 操作）
      const parts = pattern.split('|');

      // 提取每个部分的关键词（移除 \b 等正则边界符）
      const keywords = parts.map(part => {
        return part
          .replace(/\\b/g, '')           // 移除单词边界 \b
          .replace(/\^|\$/g, '')          // 移除行首/行尾锚点
          .replace(/\\[dDwWsS]/g, '')     // 移除字符类简写
          .replace(/[\[\]\(\)\{\}\*\+\?\.]/g, '') // 移除常见正则元字符
          .trim();
      }).filter(k => k.length > 0);  // 过滤空字符串

      if (keywords.length === 0) {
        // 如果提取不到关键词，直接使用原 pattern 截取
        return pattern.length > maxLength ? pattern.substring(0, maxLength) + '...' : pattern;
      }

      // 用 " | " 连接关键词
      const formatted = keywords.join(' | ');

      // 检查长度，超过则截断
      if (formatted.length > maxLength) {
        // 尝试只显示前几个关键词
        let result = '';
        for (let i = 0; i < keywords.length; i++) {
          const next = result ? result + ' | ' + keywords[i] : keywords[i];
          if (next.length > maxLength - 3) {  // 留出 "..." 的位置
            return result + '...';
          }
          result = next;
        }
        return result + '...';
      }

      return formatted;
    } catch (e) {
      // 解析失败，返回截取的原 pattern
      return pattern.length > maxLength ? pattern.substring(0, maxLength) + '...' : pattern;
    }
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
   * 从给定路径获取对应 Aily 库的 nickname
   * @param path 文件或目录的完整路径（可能在库目录内的任意位置）
   * @returns 库的 nickname，如果未找到则返回空字符串
   */
  async getLibraryNickname(path: string): Promise<string> {
    if (!path) return '';

    try {
      // 标准化路径分隔符（处理Windows和Unix路径）
      const normalizedPath = path.replace(/\\/g, '/');

      // 查找 @aily-project 的位置
      const ailyProjectIndex = normalizedPath.indexOf('/@aily-project/');
      if (ailyProjectIndex === -1) {
        return '';
      }

      // 获取 @aily-project 后的部分
      const afterAilyProject = normalizedPath.substring(ailyProjectIndex + '/@aily-project/'.length);
      const pathParts = afterAilyProject.split('/');

      // 第一个部分应该是库名（如 lib-esp32-time）
      if (pathParts.length === 0) {
        return '';
      }

      const libraryName = pathParts[0];
      // 构建 package.json 的完整路径
      const packageJsonPath = normalizedPath.substring(0, ailyProjectIndex) +
        '/@aily-project/' + libraryName + '/package.json';

      // 使用 Electron 的 fs 模块读取文件
      if (window['fs'] && window['fs'].existsSync(packageJsonPath)) {
        const fileContent = window['fs'].readFileSync(packageJsonPath, 'utf-8');
        const packageData = JSON.parse(fileContent);
        return packageData.nickname || '';
      }

      return '';
    } catch (error) {
      console.warn('获取库 nickname 失败:', error);
      return '';
    }
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

  getProjectRootPath(): string {
    return this.projectService.projectRootPath;
  }

  getCurrentProjectPath(): string {
    return this.projectService.currentProjectPath !== this.projectService.projectRootPath
      ? this.projectService.currentProjectPath
      : '';
  }

  getCurrentProjectLibrariesPath(): string {
    if (this.getCurrentProjectPath() != '') {
      return this.getCurrentProjectPath() + '/node_modules/@aily-project';
    }

    return '';
  }

  // 内置工具
  tools: Tool[] = TOOLS;

  // 关键信息获取
  getKeyInfo = async () => {
    const shell = await window['terminal'].getShell();
    return `
<keyinfo>
项目存放根路径(**rootFolder**): ${this.projectService.projectRootPath || '无'}
当前项目路径(**path**): ${this.getCurrentProjectPath() || '无'}
当前项目库存放路径(**librariesPath**): ${this.getCurrentProjectLibrariesPath() || '无'}
appDataPath(**appDataPath**): ${window['path'].getAppDataPath() || '无'}
 - 包含SDK文件、编译器工具等，boards.json-开发板列表 libraries.json-库列表 等缓存到此路径
转换库存放路径(**libraryConversionPath**): ${this.getCurrentProjectPath() ? this.getCurrentProjectPath() : (window['path'].join(window['path'].getAppDataPath(), 'libraries') || '无')}
当前使用的语言(**lang**)： ${this.configService.data.lang || 'zh-cn'}
操作系统(**os**): ${window['platform'].type || 'unknown'}
当前命令行终端(**terminal**): ${shell || 'unknown'}
</keyinfo>
<keyinfo>
uses get_hardware_categories tool to get hardware categories before searching boards and libraries.
uses search_boards_libraries tool to search for boards and libraries based on user needs.
Do not create non-existent boards and libraries.
</keyinfo>
`
  }

  // 动态获取安全上下文（每次调用时根据当前项目路径重新创建，只允许当前项目路径）
  private get securityContext(): ReturnType<typeof createSecurityContext> {
    // 获取安全工作区配置
    const securityWorkspaces = this.ailyChatConfigService.securityWorkspaces;
    const allowProjectPathAccess: boolean = securityWorkspaces.project;
    const allowNodeModulesAccess: boolean = securityWorkspaces.library;
    
    // 使用会话期间保存的允许路径
    return createSecurityContext(this.getCurrentProjectPath(), {
      allowProjectPathAccess: allowProjectPathAccess,  // 默认允许访问当前项目路径
      allowNodeModulesAccess: allowNodeModulesAccess,  // 默认允许访问 node_modules
      additionalAllowedPaths: this.sessionAllowedPaths
    });
  }

  // generate title
  generateTitle(content: string) {
    if (this.sessionTitle) return;
    this.chatService.generateTitle(this.sessionId, content);
  }

  isLoggedIn = false;

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
    private todoUpdateService: TodoUpdateService,
    private arduinoLintService: ArduinoLintService,
    private translate: TranslateService,
    private noticeService: NoticeService,
    private platformService: PlatformService,
    private electronService: ElectronService,
    private ailyChatConfigService: AilyChatConfigService,
    private onboardingService: OnboardingService,
    private absAutoSyncService: AbsAutoSyncService
  ) {
    // securityContext 改为 getter，每次使用时动态获取当前项目路径
  }

  ngOnInit() {
    // if (this.electronService.isElectron) {
    //   this.prjPath = window['path'].getUserDocuments() + `${pt}aily-project${pt}`;
    // }

    this.prjPath = this.projectService.currentProjectPath === this.projectService.projectRootPath ? "" : this.projectService.currentProjectPath;
    this.prjRootPath = this.projectService.projectRootPath;

    // 设置全局工具引用，供测试和调试使用
    (window as any)['editBlockTool'] = {
      getActiveWorkspace,
      // connectBlocksTool,
      // createCodeStructureTool,
      configureBlockTool,
      // variableManagerTool,
      // findBlockTool,
      deleteBlockTool,
      getWorkspaceOverviewTool,
      queryBlockDefinitionTool,
      // getBlockConnectionCompatibilityTool
    };

    // 订阅消息
    this.currentUrl = this.router.url;
    // 订阅外部文本消息
    this.textMessageSubscription = this.chatService.getTextMessages().subscribe(
      message => {
        this.receiveTextFromExternal(message.text, message.options);
      }
    );

    this.authService.initializeAuth().then((res) => {
      // 初始化完成后的处理
      // console.log("认证初始化完成");

      // 初始化后立即订阅
      this.authService.userInfo$.subscribe(userInfo => {
        // console.log('userInfo$ 更新:', userInfo);
        this.currentUserGroup = userInfo?.groups || [];
      });
    });

    this.aiWritingSubscription = this.blocklyService.aiWriting$.subscribe(this.showAiWritingNotice.bind(this));

    this.aiWaitingSubscription = this.blocklyService.aiWaiting$.subscribe(this.showAiWritingNotice.bind(this));

    // 绑定任务操作事件监听
    this.taskActionHandler = this.handleTaskAction.bind(this);
    document.addEventListener('aily-task-action', this.taskActionHandler);

    // 订阅项目路径变化，重新加载聊天历史列表
    // 使用 skip(1) 跳过初始值，distinctUntilChanged 确保只在路径真正变化时触发
    this.projectPathSubscription = this.projectService.currentProjectPath$.pipe(
      distinctUntilChanged(),
      skip(1)
    ).subscribe(
      (newPath: string) => {
        console.log('[AilyChat] 项目路径变化:', newPath);
        
        // 更新当前项目路径
        this.prjPath = newPath === this.projectService.projectRootPath ? '' : newPath;
        this.prjRootPath = this.projectService.projectRootPath;
        
        // 根据新的项目路径重新加载聊天历史
        const targetPath = newPath || this.projectService.projectRootPath;
        this.chatService.openHistoryFile(targetPath);
        this.HistoryList = [...this.chatService.historyList].reverse();
        
        // 初始化 ABS 自动同步服务
        if (newPath && newPath !== this.projectService.projectRootPath) {
          this.absAutoSyncService.initialize(newPath);
        }
        
        console.log('[AilyChat] 历史记录已重新加载, 数量:', this.HistoryList.length);
      }
    );

    // 订阅登录状态变化
    this.loginStatusSubscription = this.authService.isLoggedIn$.subscribe(
      async isLoggedIn => {
        // console.log('登录状态变化:', isLoggedIn, {
        //   hasInitializedForThisLogin: this.hasInitializedForThisLogin,
        //   isSessionStarting: this.isSessionStarting,
        //   currentSessionId: this.sessionId
        // });

        // 只在登录状态下调用startSession，避免登出时重复显示登录按钮
        if (!this.hasInitializedForThisLogin && !this.isSessionStarting && isLoggedIn) {
          this.isLoggedIn = isLoggedIn;
          this.hasInitializedForThisLogin = true;
          this.list = []; // 重置消息列表

          this.startSession().then((res) => {
            // console.log("startSession result: ", res);
            // 获取历史记录
            this.getHistory();
            // 检查是否需要显示新手引导
            this.checkFirstUsage();
          }).catch((err) => {
            // console.warn("startSession error: ", err);

          });
        }

        if (isLoggedIn) {
          // console.log('用户已登录，准备初始化AI助手会话');
        } else {
          // 用户登出时的处理
          // console.log('用户已登出，清理会话和状态');

          // 停止并关闭当前会话（如果存在）
          try {
            await this.stopAndCloseSession();
          } catch (error) {
            console.warn('清理会话时出错:', error);
          }

          // 重置所有相关状态
          this.hasInitializedForThisLogin = false;
          this.mcpInitialized = false;
          this.isWaiting = false;
          this.isCompleted = false;
          this.isSessionStarting = false;

          // 清空会话ID和路径
          this.chatService.currentSessionId = '';
          this.chatService.currentSessionPath = '';

          // 重置消息列表为默认状态
          this.list = [];

          //           let errData = {
          //             status: 422,
          //             message: "用户已登出，需要重新登录才能继续使用AI助手功能"
          //           }
          //           this.appendMessage('error', `
          // \`\`\`aily-error
          // ${JSON.stringify(errData)}
          // \`\`\`\n\n`)

          // 清理工具调用状态
          this.toolCallStates = {};

          // 断开流连接
          if (this.messageSubscription) {
            this.messageSubscription.unsubscribe();
            this.messageSubscription = null;
          }

          // console.log('用户登出状态清理完成');
        }
      }
    );

    // 订阅配置变更，实时应用新配置
    this.configChangedSubscription = this.ailyChatConfigService.configChanged$.subscribe(
      async (newConfig) => {
        // console.log('配置已变更:', newConfig);
        
        // 判断当前会话是否有对话历史（排除系统默认消息）
        const hasConversationHistory = this.list.length > 0;
        
        // 如果当前会话没有对话历史，则可以安全地重新启动会话以应用新配置
        if (!hasConversationHistory && this.sessionId && this.isLoggedIn) {
          // console.log('当前会话无对话历史，重新启动会话以应用新配置');
          try {
            // 先停止当前会话
            await this.stopAndCloseSession(true); // skipSave=true，因为只是重新初始化
            // 启动新会话
            await this.startSession();
            this.message.success('配置已更新并生效');
            // console.log('会话已重新启动，新配置已生效');
          } catch (error) {
            console.warn('重新启动会话失败:', error);
            this.message.warning('配置更新失败，请尝试新建对话');
          }
        } else if (hasConversationHistory) {
          // 如果有对话历史，提示用户配置将在下次会话生效
          this.message.info('配置已保存，将在下次新建对话时生效');
          // console.log('当前会话有对话历史，配置将在下次会话生效');
        }
      }
    );
  }

  showAiWritingNotice(isWaiting) {
    if (isWaiting) {
      this.noticeService.update({
        title: "AI正在操作",
        state: "doing",
        showProgress: false,
        setTimeout: 0,
        stop: () => {
          this.stop();
        },
      });
    } else {
      this.noticeService.clear();
    }
  }

  /**
   * 接收来自外部组件的文本并显示在输入框中
   * @param text 接收到的文本
   * @param options 发送选项，包含 sender、type、cover 等参数
   */
  receiveTextFromExternal(text: string, options?: ChatTextOptions): void {
    // console.log('接收到外部文本:', text, '选项:', options);

    if (options?.type === 'button') {
      // 拦截特殊按钮动作
      if (text === '重试') {
        this.retryLastAction();
        return;
      }
      if (text === '新建会话') {
        this.newChat();
        return;
      }
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
              // console.log('取消对话成功:', res);
              resolve();
            },
            error: (err) => {
              console.warn('取消对话失败:', err);
              resolve(); // 即使失败也继续
            }
          });
        });

        // 然后关闭连接
        await new Promise<void>((resolve) => {
          this.chatService.closeSession(this.sessionId).subscribe({
            next: (res: any) => {
              // console.log('关闭时会话连接已关闭:', res);
              resolve();
            },
            error: (err) => {
              console.warn('关闭时关闭会话失败:', err);
              resolve(); // 即使失败也继续
            }
          });
        });
      }
    } catch (error) {
      console.warn('关闭会话过程中出错:', error);
    }
  }

  async close() {
    // 最后关闭工具窗口
    this.uiService.closeTool('aily-chat');
  }

  ngAfterViewInit(): void {
    this.chatService.openHistoryFile(this.projectService.currentProjectPath || this.projectService.projectRootPath);
    this.HistoryList = [...this.chatService.historyList].reverse();
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

  /**
   * 清理最后一条 AI 消息中的流式残留内容
   * 
   * 由于流式传输的延迟，agent 输出的终止标记（如 TERMINATE、[to_user]）
   * 和未完成的特殊代码块可能残留在消息中。此方法在对话终止时统一清理。
   */
  private cleanupLastAiMessage(): void {
    if (this.list.length === 0) return;
    const lastMsg = this.list[this.list.length - 1];
    if (lastMsg.role !== 'aily' || !lastMsg.content) return;

    let content = lastMsg.content as string;
    const originalLength = content.length;

    // 1. 移除终止标记及其前后空白（完整或部分）
    //    匹配 TERMINATE 的完整或部分出现（流式可能只传了前几个字符）
    content = content.replace(/\s*\[?TERMINATE\]?\s*$/i, '');
    content = content.replace(/\s*\[to_user\]\s*$/i, '');
    // 部分终止标记（如 "TERMI", "TERMINA" 等出现在末尾）
    const terminatePartials = ['TERMINAT', 'TERMINA', 'TERMIN', 'TERMI', 'TERM'];
    for (const partial of terminatePartials) {
      if (content.trimEnd().endsWith(partial)) {
        content = content.substring(0, content.lastIndexOf(partial)).trimEnd();
        break;
      }
    }

    // 2. 移除未闭合的特殊 aily 代码块
    //    检测以 ```aily-xxx 开头但未以 ``` 闭合的代码块
    const ailyCodeBlockStart = /```(aily-(?:state|button|error|blockly|board|library|task-action|think|mermaid)|mermaid)[^\n]*\n/g;
    let match: RegExpExecArray | null;
    let lastUnclosedStart = -1;

    // 重置 lastIndex
    ailyCodeBlockStart.lastIndex = 0;
    while ((match = ailyCodeBlockStart.exec(content)) !== null) {
      const startPos = match.index;
      // 在 startPos 之后查找闭合的 ```
      const afterStart = content.substring(startPos + match[0].length);
      const closeMatch = afterStart.match(/\n\s*```/);
      if (!closeMatch) {
        // 没找到闭合标记，这是一个未完成的代码块
        lastUnclosedStart = startPos;
      }
    }

    if (lastUnclosedStart >= 0) {
      content = content.substring(0, lastUnclosedStart).trimEnd();
    }

    // 3. 清理末尾残留的不完整 markdown 代码块起始符 (```, `` 等)
    content = content.replace(/\s*`{1,3}\s*$/, '');

    // 只在内容实际发生变化时更新
    if (content.length !== originalLength) {
      lastMsg.content = content;
    }
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
    this.chatService.historyChatMap.set(this.sessionId, this.list);
  }

  /**
   * 保存当前会话数据到文件
   * 在创建新对话、关闭对话、组件销毁时调用
   */
  private saveCurrentSession(): void {
    if (!this.sessionId || this.list.length === 0) {
      return;
    }

    try {
      // 使用会话创建时记录的路径，确保历史记录保存到发起会话的位置
      // 如果没有记录的路径，才使用当前项目路径作为后备
      const prjPath = this.chatService.currentSessionPath || this.projectService.currentProjectPath || this.projectService.projectRootPath;
      
      if (!prjPath) {
        console.warn('无法获取项目路径，跳过保存会话');
        return;
      }

      // 确保会话在历史列表中
      let historyData = this.chatService.historyList.find(h => h.sessionId === this.sessionId);
      if (!historyData) {
        const title = this.sessionTitle || 'q' + Date.now();
        this.chatService.historyList.push({ sessionId: this.sessionId, name: title });
        this.HistoryList = [...this.chatService.historyList].reverse();
      }

      // 保存历史列表索引文件
      this.chatService.saveHistoryFile(prjPath);
      
      // 保存聊天记录到 .chat_history 文件夹
      this.chatService.saveSessionChatHistory(prjPath, this.sessionId, this.list);
      
      // console.log('会话已保存:', this.sessionId, '路径:', prjPath);
    } catch (error) {
      console.warn('保存会话失败:', error);
    }
  }

  async startSession(): Promise<void> {
    // 如果会话正在启动中，直接返回
    if (this.isSessionStarting) {
      // console.log('startSession 被跳过: 会话正在启动中');
      return Promise.resolve();
    }

    this.isSessionStarting = true;
    // 重置取消标志，确保新会话正常工作
    this.isCancelled = false;

    // 清空会话期间的额外允许路径
    this.sessionAllowedPaths = [];

    if (!this.mcpInitialized) {
      this.mcpInitialized = true;
      await this.mcpService.init();
      
      // 延迟加载硬件索引数据（用于 AI 工具的开发板/库搜索）
      this.configService.loadHardwareIndexForAI().catch(err => {
        console.warn('[AilyChat] 加载硬件索引失败:', err);
      });
    }
    
    // // 会话开始时自动导出 ABS 文件（无感同步）
    // const currentPath = this.getCurrentProjectPath();
    // if (currentPath) {
    //   this.absAutoSyncService.initialize(currentPath);
    //   this.absAutoSyncService.onSessionStart().catch(err => {
    //     console.warn('[AilyChat] ABS 自动导出失败:', err);
    //   });
    // }

    // tools + mcp tools
    this.isCompleted = false;
    
    // 根据配置过滤启用的工具
    const enabledToolNames = this.ailyChatConfigService.enabledTools;
    const disabledToolNames = this.ailyChatConfigService.disabledTools || [];
    const hasEnabledToolsConfig = enabledToolNames && enabledToolNames.length > 0;
    
    // 过滤工具逻辑：
    // 1. 如果没有配置，使用全部工具
    // 2. 如果有配置，启用的工具 + 新工具（不在禁用列表中的未知工具）
    let tools = hasEnabledToolsConfig 
      ? this.tools.filter(tool => 
          enabledToolNames.includes(tool.name) || 
          (!disabledToolNames.includes(tool.name) && !enabledToolNames.includes(tool.name))
        )
      : this.tools;
    
    let mcpTools = this.mcpService.tools.map(tool => {
      if (!tool.name.startsWith("mcp_")) {
        tool.name = "mcp_" + tool.name;
      }
      return tool;
    });
    if (mcpTools && mcpTools.length > 0) {
      tools = tools.concat(mcpTools);
    }
    
    // 获取 maxCount 配置
    const maxCount = this.ailyChatConfigService.maxCount;

    // 自定义apiKey与 baseUrl - 使用当前选择模型的配置
    let customllmConfig;
    if (this.currentModel && this.currentModel.baseUrl && this.currentModel.apiKey) {
      customllmConfig = {
        apiKey: this.currentModel.apiKey,
        baseUrl: this.currentModel.baseUrl,
      }
    } else if (this.ailyChatConfigService.useCustomApiKey) {
      // 兼容旧版本的全局配置
      customllmConfig = {
        apiKey: this.ailyChatConfigService.apiKey,
        baseUrl: this.ailyChatConfigService.baseUrl,
      }
    } else {
      customllmConfig = null;
    }

    // 使用当前选择的模型名称（服务端会根据 baseUrl 自动推断 family）
    const selectModel = this.currentModel?.model || null;


    return new Promise<void>((resolve, reject) => {
      this.chatService.startSession(this.currentMode, tools, maxCount, customllmConfig, selectModel).subscribe({
        next: (res: any) => {
          if (res.status === 'success') {
            if (res.data != this.sessionId) {
              this.chatService.currentSessionId = res.data;
              this.chatService.currentSessionTitle = "";
              // 记录会话创建时的项目路径，用于后续保存历史记录到正确位置
              this.chatService.currentSessionPath = this.projectService.currentProjectPath || this.projectService.projectRootPath;
            }
            // console.log('会话启动成功, sessionId:', res.data);
            this.streamConnect();
            this.isSessionStarting = false;

            if (this.list.length === 0) {
              this.list = [];
            }

            resolve();
          } else {
            if (res?.data === 401) {
              this.message.error(res.message);
            } else {
              let errData = { "message": res.message || '启动会话失败，请稍后重试。' }
              this.appendMessage('error', `
\`\`\`aily-error
${JSON.stringify(errData)}
\`\`\`\n\n`)
            }

            this.isSessionStarting = false;
            reject(res.message || '启动会话失败');

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

  autoScrollEnabled = true; // 控制是否自动滚动到底部


  private _isWaiting = false;

  get isWaiting() {
    return this._isWaiting;
  }

  set isWaiting(value: boolean) {
    this._isWaiting = value;
    this.blocklyService.aiWaiting = value;
    if (!value) {
      this.aiWriting = false;
      this.blocklyService.aiWaitWriting = false;
    }
  }

  set aiWriting(value: boolean) {
    this.blocklyService.aiWriting = value;
  }

  async sendButtonClick(): Promise<void> {
    this.autoScrollEnabled = true;
    this.scrollToBottom();
    if (this.isWaiting) {
      this.stop();
      return;
    }

    this.send('user', this.inputValue.trim(), true);
    // 将用户添加的上下文路径保存到会话允许路径中
    this.mergeSelectContentToSessionPaths();
    this.selectContent = [];
    this.inputValue = "";
  }

  resetChat(): Promise<void> {
    return this.startSession();
  }

  async send(sender: string, content: string, clear: boolean = true): Promise<void> {
    // 如果任务已取消且是工具消息，直接忽略，防止触发重连
    if (this.isCancelled && sender === 'tool') {
      console.log('任务已取消，忽略工具结果消息');
      return;
    }
    
    if (this.isCompleted) {
      // console.log('上次会话已完成，需要重新启动会话');
      // 重置取消标志，开始新会话
      this.isCancelled = false;
      await this.resetChat();
    }

    // 发送消息时重新启用自动滚动
    this.autoScrollEnabled = true;

    let text = content.trim();
    if (!this.sessionId || !text) return;

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

      this.generateTitle(text);

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
    // msgQueue
    this.chatService.sendMessage(sessionId, text, sender).subscribe({
      next: (res: any) => {
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
        console.warn('发送消息失败:', error);

        // 检查是否是502错误且还有重试次数
        if (error.status === 502 && retryCount > 0) {
          // console.log(`遇到502错误，还有${retryCount}次重试机会，正在重试...`);

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
\`\`\`

\`\`\`aily-button
[{"text":"重试","action":"retry","type":"primary"}]
\`\`\`

`);
        }
      }
    });
  }

  // 这里写停止发送信号
  stop() {
    // 标记任务已取消，防止后续工具结果触发重连
    this.isCancelled = true;
    
    // 设置最后一条AI消息状态为done（如果存在）
    if (this.list.length > 0 && this.list[this.list.length - 1].role === 'aily') {
      this.list[this.list.length - 1].state = 'done';
    }

    this.chatService.cancelTask(this.sessionId).subscribe((res: any) => {
      if (res.status === 'success') {
        // console.log('任务已取消:', res);
        this.isWaiting = false;
        this.isCompleted = true;
      } else {
        console.warn('取消任务失败:', res);
      }
    });
  }

  streamConnect(): void {
    // console.log("stream connect sessionId: ", this.sessionId);
    let newConnect = true;
    let newProject = false;
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
        // 记录流式数据到文件（Unicode 转中文）
        // try {
        //   const logPath = this.projectService.projectRootPath + '\\stream_log.txt';
        //   const timestamp = new Date().toISOString();
        //   const jsonStr = JSON.stringify(data, null, 2).replace(/\\u[\dA-Fa-f]{4}/gi, match =>
        //     String.fromCharCode(parseInt(match.replace(/\\u/g, ''), 16))
        //   );
        //   const logEntry = `[${timestamp}]\n${jsonStr}\n\n`;
        //   window['fs'].appendFileSync(logPath, logEntry, 'utf8');
        // } catch (logErr) {
        //   console.warn('写入日志文件失败:', logErr);
        // }
        
        // console.log("当前是否处于等待状态： ", this.isWaiting)
        if (!this.isWaiting) {
          return; // 如果不在等待状态，直接返回
        }

        // console.log("Recv: ", data);

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
                  const resultState = result?.is_error ? ToolCallState.ERROR : ToolCallState.DONE;
                  const resultText = this.toolCallStates[result.call_id];
                  if (resultText) {
                    // console.log("完成工具调用: ", result.call_id, result.name, resultState, resultText);
                    this.completeToolCall(result.call_id, result.name || 'unknown', resultState, resultText);
                  }
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
              newConnect = true;
            }
          } else if (data.type === 'error') {
            // 设置最后一条AI消息状态为done（如果存在）
            if (this.list.length > 0 && this.list[this.list.length - 1].role === 'aily') {
              this.list[this.list.length - 1].state = 'done';
            }
            this.appendMessage('error', `
\`\`\`aily-error
{
  "message": "${this.makeJsonSafe(data.message || '未知错误')}"
}
\`\`\`

\`\`\`aily-button
[{"text":"重试","action":"retry","type":"primary"}]
\`\`\`

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
                console.warn('JSON解析失败，尝试备用方法:', e);
                try {
                  // 备用方案：使用Function构造器
                  toolArgs = new Function('return ' + data.tool_args)();
                } catch (e2) {
                  console.warn('所有解析方法都失败:', e2);
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

            // console.log("工具调用请求: ", data.tool_name, toolArgs);

            // 定义 block 工具列表
            const blockTools = [
              'smart_block_tool',
              'connect_blocks_tool',
              'create_code_structure_tool',
              'configure_block_tool',
              'delete_block_tool',
              'create_single_block',
              'connect_blocks_simple',
              'set_block_field',
              'set_block_input',
              'batch_create_blocks',
              'sync_abs_file',
              // 'get_workspace_overview_tool',
              // 'queryBlockDefinitionTool',
              // 'analyze_library_blocks',
              // 'verify_block_existence'
            ];

            // 检查是否是 block 工具，如果是则设置 aiWriting 状态
            const isBlockTool = blockTools.includes(data.tool_name);
            if (isBlockTool) {
              this.aiWriting = true;
            }

            try {
              if (data.tool_name.startsWith('mcp_')) {
                data.tool_name = data.tool_name.substring(4);
                toolResult = await this.mcpService.use_tool(data.tool_name, toolArgs);
              } else {

                switch (data.tool_name) {
                  case 'create_project':
                    // console.log('[创建项目工具被调用]', toolArgs);
                    this.startToolCall(toolCallId, data.tool_name, "正在创建项目...", toolArgs);
                    toolResult = await newProjectTool(this.prjRootPath, toolArgs, this.projectService, this.configService);
                    if (toolResult?.is_error) {
                      this.uiService.updateFooterState({ state: 'warn', text: '项目创建失败' });
                      resultState = "warn"
                      resultText = '项目创建异常,即将重试';
                    } else {
                      resultText = `项目创建成功`;
                      newProject = true;
                    }
                    break;
                  case 'execute_command':
                    console.log('[执行命令工具被调用]', toolArgs);
                    // Extract the command main body for display
                    const commandParts = toolArgs.command.split(' ');
                    let displayCommand = toolArgs.command;
                    let displayArgs = '';

                    if (commandParts.length > 1) {
                      // 对于 npm 命令，显示前两个词（如 "npm install"）
                      if (commandParts[0].toLowerCase() === 'npm') {
                        displayCommand = `${commandParts[0]} ${commandParts[1]}`;
                      } else {
                        // 其他命令显示命令词+第一个参数
                        displayCommand = `${commandParts[0]}`;
                        displayArgs = commandParts[1] || '';
                        // 如果Args太长，只显示后20个字符
                        if (displayArgs.length > 20) {
                          displayArgs = '...' + displayArgs.slice(-20);
                        }
                      }
                    }

                    this.startToolCall(toolCallId, data.tool_name, `执行: ${displayCommand} ${displayArgs}`, toolArgs);
                    // Check if cwd is specified, otherwise use project paths
                    if (!toolArgs.cwd) {
                      toolArgs.cwd = this.projectService.currentProjectPath || this.projectService.projectRootPath;
                    }

                    // Get project path from command args or default
                    const projectPath = toolArgs.cwd || this.prjPath;

                    // Check if this is an npm uninstall command
                    const command = toolArgs.command;
                    const isNpmInstall = command.includes('npm i') || command.includes('npm install')
                    const isNpmUninstall = command.includes('npm uninstall');

                    // 如果是 npm uninstall，需要在执行命令之前先卸载库（因为命令执行后文件就被删除了）
                    if (isNpmUninstall) {
                      console.log('检测到 npm uninstall 命令，在执行前先卸载库');
                      // Extract all @aily-project/ packages from the uninstall command
                      const npmRegex = /@aily-project\/[a-zA-Z0-9-_]+/g;
                      const matches = command.match(npmRegex);

                      console.log('npm uninstall matches:', matches);

                      if (matches && matches.length > 0) {
                        // 使用 Set 去重，避免重复处理
                        const uniqueLibs = [...new Set(matches)];
                        console.log('去重后的卸载库列表:', uniqueLibs);

                        // 检查库是否正在使用中
                        const separator = this.platformService.getPlatformSeparator();
                        const libsInUse: string[] = [];

                        for (const libPackageName of uniqueLibs as string[]) {
                          try {
                            const libPackagePath = projectPath + `${separator}node_modules${separator}` + libPackageName;
                            const libBlockPath = libPackagePath + `${separator}block.json`;

                            // 检查 block.json 文件是否存在
                            if (this.electronService.exists(libBlockPath)) {
                              const blocksData = JSON.parse(this.electronService.readFile(libBlockPath));
                              const abiJson = JSON.stringify(this.blocklyService.getWorkspaceJson());

                              // 检查工作区中是否使用了该库的任何块
                              for (let index = 0; index < blocksData.length; index++) {
                                const element = blocksData[index];
                                if (abiJson.includes(element.type)) {
                                  libsInUse.push(libPackageName);
                                  break;
                                }
                              }
                            }
                          } catch (e) {
                            console.warn("检查库使用情况失败:", libPackageName, e);
                          }
                        }

                        // 如果有库正在使用中，阻止卸载并返回错误消息
                        if (libsInUse.length > 0) {
                          const errorMsg = `无法卸载以下库，因为项目代码正在使用它们：${libsInUse.join(', ')}。请先删除相关代码块后再尝试卸载。`;
                          console.warn(errorMsg);
                          toolResult = {
                            content: errorMsg,
                            is_error: true
                          };
                          // 直接跳过命令执行
                          break;
                        }

                        // 遍历所有匹配到的库包名进行卸载
                        for (const libPackageName of uniqueLibs) {
                          try {
                            await this.blocklyService.unloadLibrary(libPackageName, projectPath);
                            console.log("库卸载成功:", libPackageName);
                          } catch (e) {
                            console.warn("卸载库失败:", libPackageName, e);
                            // 卸载失败不影响其他库的处理，继续
                          }
                        }
                      }
                    }

                    // 执行命令，传递安全上下文用于路径验证
                    toolResult = await executeCommandTool(this.cmdService, toolArgs, this.securityContext);

                    if (!toolResult?.is_error) {
                      if (isNpmInstall) {
                        console.log('检测到 npm install 命令，尝试加载库');
                        // Extract all @aily-project/ packages from the command
                        const npmRegex = /@aily-project\/[a-zA-Z0-9-_]+/g;  // 使用全局匹配
                        const matches = command.match(npmRegex);

                        console.log('npmRegex matches:', matches);

                        if (matches && matches.length > 0) {
                          // 使用 Set 去重，避免重复加载
                          const uniqueLibs = [...new Set(matches)];
                          console.log('去重后的库列表:', uniqueLibs);

                          // 遍历所有匹配到的库包名
                          for (const libPackageName of uniqueLibs) {
                            // Load the library into blockly
                            try {
                              await this.blocklyService.loadLibrary(libPackageName, projectPath);
                              console.log("库加载成功:", libPackageName);
                            } catch (e) {
                              console.warn("加载库失败:", libPackageName, e);
                              // 加载失败不影响其他库的加载，继续处理
                            }
                          }
                        } else {
                          console.log("projectOpen: ", projectPath);
                          this.projectService.projectOpen(projectPath);
                        }
                      }
                      console.log(`命令 ${displayCommand} 执行成功`);
                      resultText = `命令 ${displayCommand} 执行成功`
                    } else {
                      // npm install 失败时不重试，避免重复加载库
                      if (isNpmInstall) {
                        console.log(`npm install命令执行失败，不触发重试以避免重复加载库`);
                        resultState = "done";  // 标记为完成，不触发重试
                        resultText = `npm install命令执行失败，请检查网络或依赖配置`;
                      } else {
                        console.log(`命令 ${displayCommand} 执行异常, 即将重试`);
                        resultState = "warn";
                        resultText = `命令 ${displayCommand} 执行异常, 即将重试`;
                      }
                    }
                    break;
                  case 'get_context':
                    // console.log('[获取上下文信息工具被调用]', toolArgs);
                    this.startToolCall(toolCallId, data.tool_name, "获取 上下文信息...", toolArgs);
                    toolResult = await getContextTool(this.projectService, toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = '获取 上下文信息 异常, 即将重试';
                    } else {
                      resultText = `获取 上下文信息 成功`;
                    }
                    break;
                  case 'get_project_info':
                    // console.log('[获取项目信息工具被调用]', toolArgs);
                    this.startToolCall(toolCallId, data.tool_name, "获取 项目信息...", toolArgs);
                    toolResult = await getProjectInfoTool(this.projectService, toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = '获取 项目信息 异常, 即将重试';
                    } else {
                      resultText = `获取 项目信息 成功`;
                    }
                    break;
                  case 'list_directory':
                    // console.log('[列出目录工具被调用]', toolArgs);
                    const distFolderName = this.getLastFolderName(toolArgs.path);
                    this.startToolCall(toolCallId, data.tool_name, `获取${distFolderName}目录内容`, toolArgs);
                    toolResult = await listDirectoryTool(toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = `获取 ${distFolderName} 目录内容异常, 即将重试`;
                    } else {
                      resultText = `获取 ${distFolderName} 目录内容成功`;
                    }
                    break;
                  case 'read_file':
                    // console.log('[读取文件工具被调用]', toolArgs);
                    let readFileName = this.getFileName(toolArgs.path);
                    // let libNickName = '';
                    // if (this.configService.data.devmode) {
                    //   libNickName += `[${toolArgs.path}] `;
                    // }
                    let libNickName = await this.getLibraryNickname(toolArgs.path);
                    // if (this.configService.data.devmode) {
                    // 将\\转为/以便显示
                    // const displayPath = toolArgs.path.replace(/\\\\/g, '/').replace(/\\/g, '/');
                    // readFileName = `${displayPath}`;

                    // 是否包含 lib- 前缀 及 readmd
                    const hasLibPrefix = toolArgs.path.includes('lib-') && (toolArgs.path.endsWith('README.md') || toolArgs.path.endsWith('readme.md'));

                    if (libNickName || hasLibPrefix) {
                      // readFileName = `${libNickName}`;
                      if (hasLibPrefix && !libNickName) {
                        // 提取库名作为昵称
                        const pathParts = toolArgs.path.split(/[/\\]/);
                        for (let part of pathParts) {
                          if (part.startsWith('lib-')) {
                            libNickName = part;
                            break;
                          }
                        }
                      }

                      this.startToolCall(toolCallId, data.tool_name, `了解 ${libNickName} 使用方法`, toolArgs);
                    } else {
                      this.startToolCall(toolCallId, data.tool_name, `读取: ${readFileName}`, toolArgs);
                    }

                    toolResult = await readFileTool(toolArgs, this.securityContext);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      if (readFileName === 'project.abs') {
                        resultText = `读取 项目文件 异常, 即将重试`;
                      } else if (libNickName) {
                        resultText = `了解 ${libNickName} 使用方法异常, 即将重试`;
                      } else {
                        resultText = `读取 文件 异常, 即将重试`;
                      }
                    } else {
                      if (readFileName === 'project.abs') {
                        resultText = `读取 项目文件 成功`;
                      } else if (libNickName) {
                        resultText = `了解 ${libNickName} 使用方法成功`;
                      } else {
                        resultText = `读取 ${readFileName} 文件成功`;
                      }
                    }
                    // } else {
                    //   if (libNickName) {
                    //     readFileName = `${libNickName} ${readFileName}`;
                    //   }
                    //   this.startToolCall(toolCallId, data.tool_name, `读取: ${readFileName}`, toolArgs);
                    //   toolResult = await readFileTool(toolArgs);
                    //   if (toolResult?.is_error) {
                    //     resultState = "warn";
                    //     resultText = `读取异常, 即将重试`;
                    //   } else {
                    //     resultText = `读取${readFileName}文件成功`;
                    //   }
                    // }
                    break;
                  case 'create_file':
                    // console.log('[创建文件工具被调用]', toolArgs);
                    let createFileName = this.getFileName(toolArgs.path);
                    if (createFileName === 'project.abs') {
                      createFileName = '项目文件';
                    }
                    this.startToolCall(toolCallId, data.tool_name, `创建: ${createFileName}`, toolArgs);
                    toolResult = await createFileTool(toolArgs, this.securityContext);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = `创建 ${createFileName} 文件异常, 即将重试`;
                    } else {
                      resultText = `创建 ${createFileName} 文件成功`;
                    }
                    break;
                  case 'create_folder':
                    // console.log('[创建文件夹工具被调用]', toolArgs);
                    let createFolderName = this.getLastFolderName(toolArgs.path);
                    this.startToolCall(toolCallId, data.tool_name, `创建: ${createFolderName}`, toolArgs);
                    toolResult = await createFolderTool(toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = `创建 ${createFolderName} 文件夹异常, 即将重试`;
                    } else {
                      resultText = `创建 ${createFolderName} 文件夹成功`;
                    }
                    break;
                  case 'edit_file':
                    // console.log('[编辑文件工具被调用]', toolArgs);
                    let editFileName = this.getFileName(toolArgs.path);
                    if (editFileName === 'project.abs') {
                      editFileName = '项目文件';
                    }
                    this.startToolCall(toolCallId, data.tool_name, `编辑: ${editFileName}`, toolArgs);
                    toolResult = await editFileTool(toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = `编辑 ${editFileName} 文件异常, 即将重试`;
                    } else {
                      resultText = `编辑 ${editFileName} 文件成功`;
                    }
                    break;
                  case 'delete_file':
                    // console.log('[删除文件工具被调用]', toolArgs);
                    let deleteFileName = this.getFileName(toolArgs.path);
                    if (editFileName === 'project.abs') {
                      editFileName = '项目文件';
                    }
                    this.startToolCall(toolCallId, data.tool_name, `删除: ${deleteFileName}`, toolArgs);
                    toolResult = await deleteFileTool(toolArgs, this.securityContext);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = `删除 ${deleteFileName} 文件异常, 即将重试`;
                    } else {
                      resultText = `删除 ${deleteFileName} 文件成功`;
                    }
                    break;
                  case 'delete_folder':
                    // console.log('[删除文件夹工具被调用]', toolArgs);
                    let deleteFolderName = this.getLastFolderName(toolArgs.path);
                    this.startToolCall(toolCallId, data.tool_name, `删除: ${deleteFolderName}`, toolArgs);
                    toolResult = await deleteFolderTool(toolArgs, this.securityContext);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = `删除 ${deleteFolderName} 文件夹异常, 即将重试`;
                    } else {
                      resultText = `删除 ${deleteFolderName} 文件夹成功`;
                    }
                    break;
                  case 'check_exists':
                    // console.log('[检查存在性工具被调用]', toolArgs);
                    // Determine if the path is likely a file or folder
                    let stateText = "检查路径是否存在";
                    let checkFileName = this.getFileName(toolArgs.path);
                    let checkFolderName = this.getLastFolderName(toolArgs.path);

                    const doingText = checkFileName ? `检查文件是否存在: ${checkFileName}` : `检查文件夹是否存在: ${checkFolderName}`;
                    const errText = checkFileName ? `检查文件 ${checkFileName} 是否存在失败: ` : `检查文件夹 ${checkFolderName} 是否存在失败: `;
                    const successText = checkFileName ? `文件 ${checkFileName} 存在` : `文件夹 ${checkFolderName} 存在`;

                    this.startToolCall(toolCallId, data.tool_name, doingText, toolArgs);
                    toolResult = await checkExistsTool(toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = errText;
                    } else {
                      resultText = successText;
                    }
                    break;
                  case 'get_directory_tree':
                    // console.log('[获取目录树工具被调用]', toolArgs);
                    let treeFolderName = this.getLastFolderName(toolArgs.path);
                    this.startToolCall(toolCallId, data.tool_name, `获取目录树: ${treeFolderName}`, toolArgs);
                    toolResult = await getDirectoryTreeTool(toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "error";
                      resultText = `获取目录树 ${treeFolderName} 失败: ` + (toolResult?.content || '未知错误');
                    } else {
                      resultText = `获取目录树 ${treeFolderName} 成功`;
                    }
                    break;
                  case 'search_boards_libraries':
                    // console.log('[开发板库搜索工具被调用]', toolArgs);
                    // 处理查询显示：filters 可能是字符串或对象
                    let searchDisplayText = '';

                    // 解析 filters（可能是 JSON 字符串）
                    let parsedFilters: any = null;
                    if (toolArgs.filters) {
                      if (typeof toolArgs.filters === 'string') {
                        try {
                          const trimmed = toolArgs.filters.trim();
                          if (trimmed && trimmed !== '{}') {
                            parsedFilters = JSON.parse(trimmed);
                          }
                        } catch (e) {
                          console.warn('Failed to parse filters:', toolArgs.filters);
                        }
                      } else if (typeof toolArgs.filters === 'object') {
                        parsedFilters = toolArgs.filters;
                      }
                    }

                    // 优先显示 filters.keywords
                    if (parsedFilters?.keywords) {
                      const keywords = Array.isArray(parsedFilters.keywords)
                        ? parsedFilters.keywords
                        : String(parsedFilters.keywords).split(/\s+/);
                      if (keywords.length > 0) {
                        searchDisplayText = keywords.slice(0, 3).join(', ');
                        if (keywords.length > 3) {
                          searchDisplayText += ` 等${keywords.length}个关键词`;
                        }
                      }
                    }

                    // 显示其他筛选条件（排除 keywords）
                    if (parsedFilters) {
                      const otherFilterKeys = Object.keys(parsedFilters).filter(k => k !== 'keywords');
                      if (otherFilterKeys.length > 0) {
                        const filterDisplay = otherFilterKeys.slice(0, 3).map(k => {
                          const val = parsedFilters[k];
                          if (Array.isArray(val)) return `${k}:[${val.slice(0, 2).join(',')}${val.length > 2 ? '...' : ''}]`;
                          return `${k}:${val}`;
                        }).join(', ');
                        searchDisplayText += searchDisplayText ? ` + ${filterDisplay}` : filterDisplay;
                      }
                    }

                    if (!searchDisplayText) {
                      searchDisplayText = '未知查询';
                    }
                    const searchType = toolArgs.type || 'boards';
                    const searchTypeDisplay = searchType === 'boards' ? '开发板' : searchType === 'libraries' ? '库' : '开发板和库';
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在搜索${searchTypeDisplay}: ${searchDisplayText}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await searchBoardsLibrariesTool.handler(toolArgs, this.configService);
                    if (toolResult?.is_error) {
                      resultState = "error";
                      resultText = `搜索 ${searchTypeDisplay} 失败: ` + (toolResult?.content || '未知错误');
                    } else {
                      const totalMatches = toolResult.metadata?.totalMatches || 0;
                      // 显示搜索内容，截取前20个字符
                      const searchSummary = searchDisplayText.length > 20 ? searchDisplayText.substring(0, 20) + '...' : searchDisplayText;
                      resultText = `搜索 ${searchTypeDisplay} 「${searchSummary}」完成，找到 ${totalMatches} 个匹配项`;
                    }
                    break;
                  case 'get_hardware_categories':
                    // console.log('[硬件分类获取工具被调用]', toolArgs);
                    const catType = toolArgs.type === 'boards' ? '开发板' : '库';
                    const dimensionLabels: Record<string, string> = {
                      brand: '品牌', architecture: '架构', connectivity: '连接方式',
                      category: '主分类', hardwareType: '硬件类型', communication: '通信协议'
                    };
                    const dimensionDisplay = dimensionLabels[toolArgs.dimension] || toolArgs.dimension;
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在获取${catType}的${dimensionDisplay}分类",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await getHardwareCategoriesTool.handler(toolArgs, this.configService);
                    if (toolResult.is_error) {
                      resultState = "error";
                      resultText = `获取 ${catType} 分类失败: ` + (toolResult.content || '未知错误');
                    } else {
                      const categoryCount = toolResult.metadata?.categories?.length || 0;
                      const totalCount = toolResult.metadata?.total || 0;
                      resultText = `获取 ${catType} ${dimensionDisplay} 分类完成，共 ${categoryCount} 个分类，涵盖 ${totalCount} 个${catType}`;
                    }
                    break;
                  case 'get_board_parameters':
                    // console.log('[开发板参数获取工具被调用]', toolArgs);
                    const paramsList = toolArgs.parameters && Array.isArray(toolArgs.parameters) ? toolArgs.parameters.join(', ') : '所有参数';
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在获取当前开发板参数 (${paramsList})",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await getBoardParametersTool.handler(this.projectService, toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "error";
                      resultText = `获取开发板参数失败: ` + (toolResult?.content || '未知错误');
                    } else {
                      const boardName = toolResult.metadata?.boardName || '未知';
                      const paramsCount = toolResult.metadata?.parameterCount || 0;
                      resultText = `获取开发板 "${boardName}" 参数成功，返回 ${paramsCount} 个参数`;
                    }
                    break;
                  case 'grep_tool':
                    // console.log('[Grep搜索工具被调用]', toolArgs);
                    // 格式化 pattern 用于显示（提取关键词）
                    let searchPattern = this.formatSearchPattern(toolArgs.pattern, 30);
                    // 转义 JSON 敏感字符
                    searchPattern = searchPattern
                      .replace(/\\/g, '\\\\')
                      .replace(/"/g, '\\"')
                      .replace(/\n/g, ' ')
                      .replace(/\r/g, '')
                      .replace(/\t/g, ' ');
                    const searchPathDisplay = toolArgs.path ? this.getLastFolderName(toolArgs.path) : '当前项目';
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在搜索内容: ${searchPattern} (${searchPathDisplay})",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await grepTool(toolArgs);
                    // 用于结果显示的搜索内容（格式化显示关键词）
                    const searchPatternDisplay = this.formatSearchPattern(toolArgs.pattern, 20);
                    if (toolResult?.is_error) {
                      resultState = "error";
                      resultText = `搜索「${searchPatternDisplay}」失败: ` + (toolResult?.content || '未知错误');
                    } else {
                      // 优先显示匹配记录数，如果没有则显示文件数
                      const numMatches = toolResult.metadata?.numMatches;
                      const numFiles = toolResult.metadata?.numFiles;

                      if (numMatches !== undefined) {
                        // 新的 JavaScript 展开模式：显示匹配记录数
                        if (numMatches === 0) {
                          resultText = `搜索「${searchPatternDisplay}」完成，未找到匹配内容`;
                        } else {
                          const duration = toolResult.metadata?.durationMs || 0;
                          resultText = `搜索「${searchPatternDisplay}」完成，找到 ${numMatches} 个匹配记录`;
                          // if (duration > 0) {
                          //   resultText += ` (耗时 ${duration}ms)`;
                          // }
                        }
                      } else if (numFiles !== undefined) {
                        // 传统文件名模式：显示匹配文件数
                        resultText = `搜索「${searchPatternDisplay}」完成，找到 ${numFiles} 个匹配文件`;
                      } else {
                        // 兜底显示
                        resultText = `搜索「${searchPatternDisplay}」完成`;
                      }
                    }
                    break;
                  case 'glob_tool':
                    // console.log('[Glob文件搜索工具被调用]', toolArgs);
                    const globPattern = toolArgs.pattern ? toolArgs.pattern.substring(0, 30) : '未知模式';
                    const globPathDisplay = toolArgs.path ? this.getLastFolderName(toolArgs.path) : '当前目录';
                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在查找文件: ${globPattern} (${globPathDisplay})",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await globTool(toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "error";
                      resultText = `文件搜索失败: ` + (toolResult?.content || '未知错误');
                    } else {
                      // 显示找到的文件数量
                      const numFiles = toolResult.metadata?.numFiles;
                      const duration = toolResult.metadata?.durationMs || 0;
                      const truncated = toolResult.metadata?.truncated;

                      if (numFiles === 0) {
                        resultText = `搜索完成，未找到匹配的文件`;
                      } else {
                        resultText = `搜索完成，找到 ${numFiles} 个文件`;
                        if (duration > 0) {
                          resultText += ` (耗时 ${duration}ms)`;
                        }
                        if (truncated) {
                          resultText += ` (结果已截断)`;
                        }
                      }
                    }
                    break;
                  case 'fetch':
                    // console.log('[网络请求工具被调用]', toolArgs);
                    const fetchUrl = this.getUrlDisplayName(toolArgs.url);
                    this.startToolCall(toolCallId, data.tool_name, `进行网络请求: ${fetchUrl}`, toolArgs);
                    toolResult = await fetchTool(this.fetchToolService, toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "error";
                      resultText = `网络请求异常，即将重试`;
                    } else {
                      resultText = `网络请求 ${fetchUrl} 成功`;
                    }
                    break;
                  case 'ask_approval':
                    // console.log('[请求确认工具被调用]', toolArgs);
                    toolResult = await askApprovalTool(toolArgs);
                    // 不显示状态信息，因为这是用户交互操作
                    break;
                  case 'reload_project':
                    // console.log('[重新加载项目工具被调用]', toolArgs);
                    this.startToolCall(toolCallId, data.tool_name, "重新加载项目...", toolArgs);
                    break;
                  case 'edit_abi_file':
                    // console.log('[编辑ABI文件工具被调用]', toolArgs);

                    // 根据操作模式生成不同的状态文本
                    let abiOperationText = "编辑ABI文件...";
                    if (toolArgs.replaceStartLine !== undefined) {
                      if (toolArgs.replaceEndLine !== undefined && toolArgs.replaceEndLine !== toolArgs.replaceStartLine) {
                        abiOperationText = `替换ABI文件第 ${toolArgs.replaceStartLine}-${toolArgs.replaceEndLine} 行内容...`;
                      } else {
                        abiOperationText = `替换ABI文件第 ${toolArgs.replaceStartLine} 行内容...`;
                      }
                    } else if (toolArgs.insertLine !== undefined) {
                      abiOperationText = `ABI文件第 ${toolArgs.insertLine} 行插入内容...`;
                    } else if (toolArgs.replaceMode === false) {
                      abiOperationText = "向ABI文件末尾追加内容...";
                    }

                    this.startToolCall(toolCallId, data.tool_name, abiOperationText, toolArgs);

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
                        "is_error": editAbiResult?.is_error
                      }
                      if (toolResult?.is_error) {
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
                          is_error: reloadResult?.is_error
                        }
                      }
                    }
                    break;
                  case 'reload_abi_json':
                    // console.log('[重新加载ABI JSON工具被调用]', toolArgs);
                    this.startToolCall(toolCallId, data.tool_name, "重新加载Blockly工作区数据...", toolArgs);
                    // 导入工具函数
                    const { ReloadAbiJsonToolService } = await import('./tools/reloadAbiJsonTool');
                    const reloadAbiJsonService = new ReloadAbiJsonToolService(this.blocklyService, this.projectService);
                    const reloadResult = await reloadAbiJsonService.executeReloadAbiJson(toolArgs);
                    toolResult = {
                      content: reloadResult.content,
                      is_error: reloadResult?.is_error
                    };
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = 'ABI数据重新加载异常';
                    } else {
                      resultText = 'ABI数据重新加载成功';
                    }
                    break;
                  // =============================================================================
                  // 原子化块操作工具
                  // =============================================================================
                  // case 'create_single_block':
                  //   this.startToolCall(toolCallId, data.tool_name, `创建块: ${toolArgs.type}`, toolArgs);
                  //   toolResult = await createSingleBlockTool(toolArgs);
                  //   if (toolResult.is_error) {
                  //     resultState = "warn";
                  //     resultText = `块创建失败: ${toolArgs.type}`;
                  //   } else {
                  //     resultText = `块创建成功: ${toolArgs.type} (ID: ${toolResult.metadata?.blockId})`;
                  //   }
                  //   break;
                  // case 'connect_blocks_simple':
                  //   this.startToolCall(toolCallId, data.tool_name, `连接块: ${toolArgs.action}`, toolArgs);
                  //   toolResult = await connectBlocksSimpleTool(toolArgs);
                  //   if (toolResult.is_error) {
                  //     resultState = "warn";
                  //     resultText = `块连接失败`;
                  //   } else {
                  //     resultText = `块连接成功: ${toolArgs.action}`;
                  //   }
                  //   break;
                  // case 'set_block_field':
                  //   this.startToolCall(toolCallId, data.tool_name, `设置字段: ${toolArgs.fieldName}`, toolArgs);
                  //   toolResult = await setBlockFieldTool(toolArgs);
                  //   if (toolResult.is_error) {
                  //     resultState = "warn";
                  //     resultText = `字段设置失败`;
                  //   } else {
                  //     resultText = `字段设置成功: ${toolArgs.fieldName}`;
                  //   }
                  //   break;
                  // case 'set_block_input':
                  //   this.startToolCall(toolCallId, data.tool_name, `设置输入: ${toolArgs.inputName}`, toolArgs);
                  //   toolResult = await setBlockInputTool(toolArgs);
                  //   if (toolResult.is_error) {
                  //     resultState = "warn";
                  //     resultText = `输入设置失败`;
                  //   } else {
                  //     resultText = `输入设置成功: ${toolArgs.inputName}`;
                  //   }
                  //   break;
                  // case 'get_workspace_blocks':
                  //   this.startToolCall(toolCallId, data.tool_name, "获取工作区块列表...", toolArgs);
                  //   toolResult = await getWorkspaceBlocksTool();
                  //   if (toolResult.is_error) {
                  //     resultState = "warn";
                  //     resultText = `获取块列表失败`;
                  //   } else {
                  //     resultText = `获取块列表成功`;
                  //   }
                  //   break;
                  // case 'batch_create_blocks':
                  //   // 解析可能是 JSON 字符串的参数以获取正确数量（使用 JSON 修复）
                  //   let parsedBlocks: any[] = [];
                  //   let parsedConns: any[] = [];
                  //   let displayText = '批量创建块...';  // 默认显示文本
                  //   try {
                  //     // 使用 fixJsonString 修复可能格式错误的 JSON
                  //     if (typeof toolArgs.blocks === 'string') {
                  //       const fixResult = fixJsonString(toolArgs.blocks);
                  //       const jsonToParse = fixResult.success ? fixResult.fixed : toolArgs.blocks;
                  //       parsedBlocks = JSON.parse(jsonToParse);
                  //     } else if (Array.isArray(toolArgs.blocks)) {
                  //       parsedBlocks = toolArgs.blocks;
                  //     }

                  //     if (typeof toolArgs.connections === 'string') {
                  //       const fixResult = fixJsonString(toolArgs.connections);
                  //       const jsonToParse = fixResult.success ? fixResult.fixed : toolArgs.connections;
                  //       parsedConns = JSON.parse(jsonToParse);
                  //     } else if (Array.isArray(toolArgs.connections)) {
                  //       parsedConns = toolArgs.connections;
                  //     }

                  //     // 成功解析后生成显示文本
                  //     const batchBlockCount = Array.isArray(parsedBlocks) ? parsedBlocks.length : 0;
                  //     const batchConnCount = Array.isArray(parsedConns) ? parsedConns.length : 0;
                  //     displayText = `批量创建: ${batchBlockCount}个块, ${batchConnCount}个连接`;
                  //   } catch (e) {
                  //     console.warn('解析 batch_create_blocks 参数失败（已尝试修复）:', e);
                  //     // 解析失败时，尝试从字符串粗略估算数量
                  //     try {
                  //       const blocksStr = typeof toolArgs.blocks === 'string' ? toolArgs.blocks : JSON.stringify(toolArgs.blocks || []);
                  //       const connsStr = typeof toolArgs.connections === 'string' ? toolArgs.connections : JSON.stringify(toolArgs.connections || []);
                  //       const estimatedBlocks = (blocksStr.match(/"type"\s*:/g) || []).length;
                  //       const estimatedConns = (connsStr.match(/"parent"\s*:/g) || []).length;
                  //       if (estimatedBlocks > 0 || estimatedConns > 0) {
                  //         displayText = `批量创建: 约${estimatedBlocks}个块, 约${estimatedConns}个连接`;
                  //       }
                  //     } catch (estimateError) {
                  //       // 估算也失败，保持默认显示
                  //     }
                  //   }
                  //   this.startToolCall(toolCallId, data.tool_name, displayText, toolArgs);
                  //   toolResult = await batchCreateBlocksTool(toolArgs);
                  //   if (toolResult.is_error) {
                  //     resultState = "warn";
                  //     // 从 metadata 中获取实际的成功和失败数量
                  //     const totalBlocks = toolResult.metadata?.totalBlocks || 0;
                  //     const successBlocks = toolResult.metadata?.successBlocks || 0;
                  //     const totalConns = toolResult.metadata?.totalConnections || 0;
                  //     const successConns = toolResult.metadata?.successConnections || 0;
                  //     const failedBlocks = totalBlocks - successBlocks;
                  //     const failedConns = totalConns - successConns;
                  //     resultText = `批量创建部分失败: ${failedBlocks}个块失败, ${failedConns}个连接失败`;
                  //   } else {
                  //     const successBlocks = toolResult.metadata?.successBlocks || 0;
                  //     const successConns = toolResult.metadata?.successConnections || 0;
                  //     resultText = `批量创建成功: ${successBlocks}个块, ${successConns}个连接`;
                  //   }
                  //   break;
                  // =============================================================================
                  // 扁平化块创建工具
                  // =============================================================================
                  // case 'flat_create_blocks':
                  //   // console.log('🔧 [扁平化块创建工具被调用]');
                  //   // 解析可能是 JSON 字符串的参数
                  //   let flatBlockCount = 0;
                  //   let flatConnCount = 0;

                  //   if (toolArgs.blocks) {
                  //     if (typeof toolArgs.blocks === 'string') {
                  //       const fixResult = fixJsonString(toolArgs.blocks);
                  //       toolArgs.blocks = fixResult.success ? fixResult.fixed : toolArgs.blocks;
                  //       try {
                  //         flatBlockCount = JSON.parse(toolArgs.blocks).length;
                  //       } catch (e) {
                  //         console.warn('解析 flat_create_blocks.blocks 失败:', e);
                  //       }
                  //     } else if (Array.isArray(toolArgs.blocks)) {
                  //       flatBlockCount = toolArgs.blocks.length;
                  //     }
                  //   }

                  //   if (toolArgs.connections) {
                  //     if (typeof toolArgs.connections === 'string') {
                  //       const fixResult = fixJsonString(toolArgs.connections);
                  //       toolArgs.connections = fixResult.success ? fixResult.fixed : toolArgs.connections;
                  //       try {
                  //         flatConnCount = JSON.parse(toolArgs.connections).length;
                  //       } catch (e) {
                  //         console.warn('解析 flat_create_blocks.connections 失败:', e);
                  //       }
                  //     } else if (Array.isArray(toolArgs.connections)) {
                  //       flatConnCount = toolArgs.connections.length;
                  //     }
                  //   }

                  //   this.startToolCall(toolCallId, data.tool_name, `扁平化创建: ${flatBlockCount}个块, ${flatConnCount}个连接`, toolArgs);
                  //   toolResult = await flatCreateBlocksTool(toolArgs);
                  //   if (toolResult.is_error) {
                  //     resultState = "warn";
                  //     const stats = (toolResult as any).data?.stats;
                  //     if (stats) {
                  //       resultText = `扁平化创建部分失败: ${stats.blocksFailed || 0}个块失败, ${stats.connectionsFailed || 0}个连接失败`;
                  //     } else {
                  //       resultText = '扁平化块创建异常';
                  //     }
                  //   } else {
                  //     const stats = (toolResult as any).data?.stats;
                  //     if (stats) {
                  //       resultText = `扁平化创建成功: ${stats.blocksCreated}个块, ${stats.connectionsEstablished}个连接`;
                  //     } else {
                  //       resultText = `扁平化块创建成功`;
                  //     }
                  //   }
                  //   break;
                  // =============================================================================
                  // DSL 块创建工具
                  // =============================================================================
                  // case 'dsl_create_blocks':
                  //   this.startToolCall(toolCallId, data.tool_name, `DSL 创建块...`, toolArgs);
                  //   toolResult = await dslCreateBlocksTool(toolArgs);
                  //   if (toolResult.is_error) {
                  //     resultState = "warn";
                  //     resultText = 'DSL 块创建失败';
                  //   } else {
                  //     resultText = 'DSL 块创建成功';
                  //   }
                  //   break;
                  // =============================================================================
                  // 原有块操作工具
                  // =============================================================================
                  case 'smart_block_tool':
                    // console.log('🔧 [智能块工具被调用]');
                    // console.log('📥 大模型传入的完整参数:', JSON.stringify(toolArgs, null, 2));
                    // console.log('📋 参数解析:');
                    // console.log('  - 块类型:', toolArgs.type);
                    // console.log('  - 位置:', toolArgs.position);
                    // console.log('  - 字段:', toolArgs.fields);
                    // console.log('  - 输入:', toolArgs.inputs);
                    // console.log('  - 父级连接:', toolArgs.parentConnection);
                    // console.log('  - 创建变量:', toolArgs.createVariables);

                    this.startToolCall(toolCallId, data.tool_name, `创建Blockly块: ${toolArgs.type}`, toolArgs);
                    toolResult = await smartBlockTool(toolArgs);
                    // console.log('✅ 智能块工具执行结果:', toolResult);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = '智能块操作异常';
                    } else {
                      resultText = `智能块操作成功: ${toolArgs.type}`;
                    }
                    break;
                  case 'connect_blocks_tool':
                    // console.log('[块连接工具被调用]', toolArgs);
                    this.startToolCall(toolCallId, data.tool_name, "连接Blockly块...", toolArgs);
                    toolResult = await connectBlocksTool(toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = '块连接异常';
                    } else {
                      resultText = `块连接成功: ${toolArgs.connectionType}连接`;
                    }
                    break;
                  case 'create_code_structure_tool':
                    // console.log('[代码结构创建工具被调用]', toolArgs);
                    this.startToolCall(toolCallId, data.tool_name, `创建代码结构: ${toolArgs.structure}`, toolArgs);
                    toolResult = await createCodeStructureTool(toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = '代码结构创建异常';
                    } else {
                      resultText = `代码结构创建成功: ${toolArgs.structure}`;
                    }
                    break;
                  case 'configure_block_tool':
                    // console.log('[块配置工具被调用]', toolArgs);
                    this.startToolCall(toolCallId, data.tool_name, "配置Blockly块...", toolArgs);
                    toolResult = await configureBlockTool(toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = '块配置异常, 即将重试';
                    } else {
                      resultText = `块配置成功: ID ${toolArgs.blockId}`;
                    }
                    break;
                  // =============================================================================
                  // DSL 块创建工具
                  // =============================================================================
                  // case 'insert_code_dsl':
                  //   this.startToolCall(toolCallId, data.tool_name, "DSL 代码创建块...", toolArgs);
                  //   toolResult = await insertDslHandler(toolArgs);
                  //   if (toolResult?.is_error) {
                  //     resultState = "warn";
                  //     resultText = 'ABS 代码执行失败';
                  //   } else {
                  //     const metadata = toolResult?.metadata;
                  //     resultText = `ABS 代码执行成功: 创建了 ${metadata?.createdBlocks || 0} 个块`;
                  //   }
                  //   break;
                  // case 'get_dsl_syntax_help':
                  //   this.startToolCall(toolCallId, data.tool_name, "获取 ABS 语法帮助...", toolArgs);
                  //   toolResult = getDslHelpHandler();
                  //   resultText = 'ABS 语法帮助';
                  //   break;
                  case 'sync_abs_file':
                    if (toolArgs.operation === 'import') {
                      this.startToolCall(toolCallId, data.tool_name, "加载 图形化代码...", toolArgs);
                    }
                    // this.startToolCall(toolCallId, data.tool_name, `同步 ABS 文件 (${toolArgs.operation})...`, toolArgs);
                    toolResult = await syncAbsFileHandler(toolArgs, this.projectService, this.electronService, this.absAutoSyncService);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = '项目文件 同步失败';
                    } else {
                      const op = toolArgs.operation;
                      // export 时不显示状态
                      resultText = op === 'import' ? '加载 图形化代码 完成' 
                        // : op === 'status' ? 'ABS 状态查询完成'
                        : '';  // status 与 export 不显示
                    }
                    break;
                  case 'abs_version_control':
                    this.startToolCall(toolCallId, data.tool_name, `版本控制 (${toolArgs.operation})...`, toolArgs);
                    toolResult = await absVersionControlHandler(toolArgs, this.absAutoSyncService);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = '版本控制操作失败';
                    } else {
                      const op = toolArgs.operation;
                      resultText = op === 'list' ? '版本列表获取成功'
                        : op === 'get' ? '版本内容获取成功'
                        : op === 'rollback' ? '版本回滚成功'
                        : '版本保存成功';
                    }
                    break;
                  //                   case 'variable_manager_tool':
                  //                     console.log('[变量管理工具被调用]', toolArgs);
                  //                     this.appendMessage('aily', `

                  // \`\`\`aily-state
                  // {
                  //   "state": "doing",
                  //   "text": "正在${toolArgs.operation === 'create' ? '创建' : toolArgs.operation === 'delete' ? '删除' : toolArgs.operation === 'rename' ? '重命名' : '列出'}变量...",
                  //   "id": "${toolCallId}"
                  // }
                  // \`\`\`\n\n
                  //                     `);
                  //                     toolResult = await variableManagerTool(toolArgs);
                  //                     if (toolResult?.is_error) {
                  //                       resultState = "warn";
                  //                       resultText = '变量操作异常,即将重试';
                  //                     } else {
                  //                       resultText = `变量操作成功: ${toolArgs.operation}${toolArgs.variableName ? ' ' + toolArgs.variableName : ''}`;
                  //                     }
                  //                     break;
                  //                   case 'find_block_tool':
                  //                     console.log('[块查找工具被调用]', toolArgs);
                  //                     this.appendMessage('aily', `

                  // \`\`\`aily-state
                  // {
                  //   "state": "doing",
                  //   "text": "查找Blockly块...",
                  //   "id": "${toolCallId}"
                  // }
                  // \`\`\`\n\n
                  //                     `);
                  //                     toolResult = await findBlockTool(toolArgs);
                  //                     if (toolResult?.is_error) {
                  //                       resultState = "error";
                  //                       resultText = '块查找失败: ' + (toolResult?.content || '未知错误');
                  //                     } else {
                  //                       resultText = '块查找完成';
                  //                     }
                  //                     break;
                  case 'delete_block_tool':
                    // console.log('[块删除工具被调用]', toolArgs);
                    this.startToolCall(toolCallId, data.tool_name, "删除Blockly块...", toolArgs);
                    toolResult = await deleteBlockTool(toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "warn";
                      resultText = '块删除异常, 即将重试';
                    } else {
                      resultText = `块删除成功: ID ${toolArgs.blockId || '未知ID'}`;
                    }
                    break;
                  case 'get_workspace_overview_tool':
                    // console.log('[工作区全览工具被调用]', toolArgs);
                    this.startToolCall(toolCallId, data.tool_name, "分析工作区全览...", toolArgs);
                    toolResult = await getWorkspaceOverviewTool(toolArgs);
                    if (toolResult?.is_error) {
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
                    // console.log('[TODO工具被调用]', toolArgs);
                    //                     this.appendMessage('aily', `

                    // \`\`\`aily-state
                    // {
                    //   "state": "doing",
                    //   "text": "管理TODO项目...",
                    //   "id": "${toolCallId}"
                    // }
                    // \`\`\`\n\n
                    //                     `);
                    // 将当前会话ID传递给todoWriteTool，确保每个会话的TODO数据独立存储
                    const todoArgs = { ...toolArgs, sessionId: this.sessionId };
                    toolResult = await todoWriteTool(todoArgs);
                    if (toolResult?.is_error) {
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
                  case 'queryBlockDefinitionTool': {
                    // console.log('[块定义查询工具被调用]', toolArgs);
                    this.startToolCall(toolCallId, data.tool_name, "查询块定义信息...", toolArgs);
                    toolResult = await queryBlockDefinitionTool(this.projectService, toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "error";
                      resultText = '块定义查询失败: ' + (toolResult?.content || '未知错误');
                    } else {
                      resultText = `块定义查询完成: ${toolResult?.content}`;
                    }
                  }
                    break;
                  //                   case 'getBlockConnectionCompatibilityTool':
                  //                     {
                  //                       console.log('[块连接兼容性工具被调用]', toolArgs);
                  //                       this.appendMessage('aily', `

                  // \`\`\`aily-state
                  // {
                  //   "state": "doing",
                  //   "text": "正在分析块连接兼容性...",
                  //   "id": "${toolCallId}"
                  // }
                  // \`\`\`\n\n
                  //                       `);
                  //                       toolResult = await getBlockConnectionCompatibilityTool(this.projectService, toolArgs);
                  //                       if (toolResult?.is_error) {
                  //                         resultState = "error";
                  //                         resultText = '块连接兼容性分析失败: ' + (toolResult?.content || '未知错误');
                  //                       } else {
                  //                         resultText = `块连接兼容性分析完成: ${toolResult?.content}`;
                  //                       }
                  //                     }
                  //                     break;
                  case 'analyze_library_blocks':
                    // console.log('🔍 [库分析工具被调用]', toolArgs);

                    // 安全地处理 libraryNames 参数
                    let libraryNamesDisplay = '未知库';
                    let parsedLibraryNames: string[] = [];
                    try {
                      if (typeof toolArgs.libraryNames === 'string') {
                        // 尝试解析 JSON 数组字符串
                        if (toolArgs.libraryNames.startsWith('[')) {
                          parsedLibraryNames = JSON.parse(toolArgs.libraryNames);
                        } else {
                          // 普通字符串，可能是逗号分隔或单个库名
                          parsedLibraryNames = toolArgs.libraryNames.split(',').map((s: string) => s.trim()).filter(Boolean);
                        }
                      } else if (Array.isArray(toolArgs.libraryNames)) {
                        parsedLibraryNames = toolArgs.libraryNames;
                      }
                      if (parsedLibraryNames.length > 0) {
                        libraryNamesDisplay = parsedLibraryNames.join(', ');
                        // 更新 toolArgs 以便传递给工具
                        toolArgs.libraryNames = parsedLibraryNames;
                      }
                    } catch (error) {
                      console.warn('解析 libraryNames 失败:', error);
                      // 降级处理：直接作为单个库名使用
                      if (typeof toolArgs.libraryNames === 'string' && toolArgs.libraryNames) {
                        parsedLibraryNames = [toolArgs.libraryNames];
                        libraryNamesDisplay = toolArgs.libraryNames;
                        toolArgs.libraryNames = parsedLibraryNames;
                      }
                    }

                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在分析库: ${libraryNamesDisplay}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await analyzeLibraryBlocksTool(this.projectService, toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "error";
                      resultText = `库分析失败: ${toolResult?.content || '未知错误'}`;
                    } else {
                      const metadata = toolResult.metadata;
                      if (metadata) {
                        resultText = `库分析完成: 分析了 ${metadata.librariesAnalyzed || 0} 个库，找到 ${metadata.totalBlocks || 0} 个块定义`;
                      } else {
                        resultText = '库分析完成';
                      }
                    }
                    break;
                  //                   case 'intelligent_block_sequence':
                  //                     console.log('🤖 [智能块序列工具被调用]', toolArgs);
                  //                     this.appendMessage('aily', `

                  // \`\`\`aily-state
                  // {
                  //   "state": "doing",
                  //   "text": "正在生成智能块序列: ${toolArgs.userIntent ? toolArgs.userIntent.substring(0, 50) + '...' : ''}",
                  //   "id": "${toolCallId}"
                  // }
                  // \`\`\`\n\n
                  //                     `);
                  //                     toolResult = await intelligentBlockSequenceTool(this.projectService, toolArgs);
                  //                     if (toolResult?.is_error) {
                  //                       resultState = "error";
                  //                       resultText = `智能序列生成失败: ${toolResult?.content || '未知错误'}`;
                  //                     } else {
                  //                       const metadata = toolResult.metadata;
                  //                       if (metadata && metadata.sequenceLength !== undefined) {
                  //                         resultText = `智能序列生成完成: 生成了${metadata.sequenceLength}步序列，复杂度${metadata.complexity || '未知'}`;
                  //                       } else {
                  //                         resultText = '智能序列生成完成';
                  //                       }
                  //                     }
                  //                     break;
                  case 'verify_block_existence':
                    // console.log('✅ [块存在性验证工具被调用]', toolArgs);

                    // 安全地处理 blockTypes 参数
                    let blockTypesDisplay = '未知块';
                    try {
                      const blockTypes = typeof toolArgs.blockTypes === 'string'
                        ? JSON.parse(toolArgs.blockTypes)
                        : toolArgs.blockTypes;
                      if (Array.isArray(blockTypes)) {
                        blockTypesDisplay = blockTypes.join(', ');
                      }
                    } catch (error) {
                      console.warn('解析 blockTypes 失败:', error);
                    }

                    this.appendMessage('aily', `

\`\`\`aily-state
{
  "state": "doing",
  "text": "正在验证块: ${blockTypesDisplay}",
  "id": "${toolCallId}"
}
\`\`\`\n\n
                    `);
                    toolResult = await verifyBlockExistenceTool(this.projectService, toolArgs);
                    if (toolResult?.is_error) {
                      resultState = "error";
                      resultText = `块验证失败: ${toolResult?.content || '未知错误'}`;
                    } else {
                      const metadata = toolResult.metadata;
                      if (metadata) {
                        const existingCount = metadata.existingBlocks?.length || 0;
                        const missingCount = metadata.missingBlocks?.length || 0;
                        resultText = `块验证完成: ${existingCount}个块存在，${missingCount}个块缺失`;
                      } else {
                        resultText = '块验证完成';
                      }
                    }
                    break;
                  //                   case 'arduino_syntax_check':
                  //                     console.log('🔍 [Arduino语法检查工具被调用]', toolArgs);

                  //                     this.appendMessage('aily', `

                  // \`\`\`aily-state
                  // {
                  //   "state": "doing",
                  //   "text": "正在检查Arduino代码语法...",
                  //   "id": "${toolCallId}"
                  // }
                  // \`\`\`\n\n
                  //                     `);

                  //                     toolResult = await arduinoSyntaxTool.use(toolArgs);
                  //                     if (toolResult?.is_error) {
                  //                       resultState = "warn";
                  //                       resultText = '代码语法检查发现问题';
                  //                     } else {
                  //                       resultState = "success";
                  //                       resultText = 'Arduino代码语法检查通过';
                  //                     }
                  //                     break;
                }
              }

              // 根据执行结果确定状态
              if (toolResult && toolResult?.is_error) {
                resultState = "error";
              } else if (toolResult && toolResult.warning) {
                resultState = "warn";
              }
            } catch (error) {
              console.warn('工具执行出错:', error);
              resultState = "error";
              resultText = `工具执行出错: ${error.message || '未知错误'}`;
              toolResult = {
                is_error: true,
                content: resultText
              };
            }

            // 获取keyinfo
            // const keyInfo = await this.getKeyInfo();

            let toolContent = '';

            // 拼接到工具结果中返回
            if (toolResult?.content && this.chatService.currentMode === 'agent') {
              // 判断是否是 Blockly 相关工具
              const isBlocklyTool = [
                'smart_block_tool',
                'create_code_structure_tool',
                'configure_block_tool',
                'connect_blocks_tool',
                'delete_block_tool',
                'get_workspace_overview_tool',
                'edit_abi_file',
                'reload_abi_json',
                'create_single_block',
                'connect_blocks_simple',
                'set_block_field',
                'set_block_input',
                'batch_create_blocks',
                'flat_create_blocks',
                'sync_abs_file',
              ].includes(data.tool_name);

              // 判断是否需要路径信息的工具
              const needsPathInfo = [
                'create_project',
                'execute_command',
                'create_file',
                'edit_file',
                'delete_file',
                'create_folder',
                'delete_folder',
                'check_exists',
                'list_directory',
                'get_directory_tree',
                'grep_tool',
                'glob_tool',
                'edit_abi_file',
                'reload_abi_json'
              ].includes(data.tool_name);

              // 只在 Blockly 工具失败或警告时添加规则提示
              const needsRules = isBlocklyTool && (toolResult?.is_error || resultState === 'warn');

              // console.log('needsRules:', needsRules, 'isBlocklyTool:', isBlocklyTool, 'needsPathInfo:', needsPathInfo, 'resultState:', resultState, 'toolResult.is_error:', toolResult?.is_error);

              // 智能决定是否包含 keyInfo：需要路径信息的工具 或 工具失败/警告时
              const shouldIncludeKeyInfo = needsPathInfo || toolResult?.is_error || resultState === 'warn';

              if (needsRules || newConnect || newProject) {
                console.log('======================================包含规则提示======================================');
                newConnect = false;
                newProject = false;
                // Blockly 工具失败时：同时包含 keyInfo 和 rules
                // toolContent += `\n${keyInfo}\n
// 【ABS编写规范】
// - 字段(field)直接写值：field_dropdown写枚举\`HIGH\`、field_input写字符串\`"dht"\`、field_number写数字\`9600\`、field_variable写\`$varName\`
// - 值输入(input_value)必须连接值块：数字用\`math_number(10)\`、文本用\`text("Hello")\`、布尔用\`logic_boolean(TRUE)\`、变量用\`$varName\`(自动创建variables_get)
// - 语句输入(input_statement)用4空格缩进子块表示
// - 多输入块用\`@输入名:\`标记：如controls_if的\`@IF0:\`/\`@DO0:\`/\`@ELSE:\`
// - 空括号不可省略：\`block_name()\`
                toolContent += `
<rules>Blockly块操作规范流程（ABS模式），**严格遵守**：

【核心原则】
所有块操作统一通过ABS文件进行：创建=添加ABS代码行，修改=编辑参数，删除=移除代码行

【准备阶段】
1. 使用todo_write_tool规划当前项目流程
2. 使用get_workspace_overview_tool分析当前工作区，获取ABS代码和变量列表
3. 列出所有需要使用的库（必须包含\`lib-core-*\`系列核心库：logic、variables、time、math等）
4. 逐一阅读各库readme_ai.md了解块定义和ABS语法
5. 如果需要的库未安装，则查询并安装所需库，安装完成后重新执行步骤1-4

【创建/修改阶段】
1. **完整规划代码逻辑**，先在脑中构思完整的ABS结构
2. 使用sync_abs_file工具的export操作获取当前代码
3. 编辑ABS代码：添加新块、修改参数、调整结构
4. 使用sync_abs_file工具的import操作导入修改后的ABS
5. 检查工具反馈，如果失败则分析错误信息，修正ABS代码后重新导入
6. 重复步骤2-5直至完成

【修复原则】
- 诊断优先：分析get_workspace_overview_tool返回的ABS代码，定位问题
- 最小改动：只修改需要变更的ABS行，保持其他结构不变
- 增量更新：sync_abs_file支持增量更新，只会修改变化的块
- 错误处理：导入失败时检查ABS语法，特别是变量前缀\`$\`和括号匹配

【执行要求】
- 深入分析嵌入式代码逻辑和硬件特性，确保逻辑正确
- ABS代码保持清晰的缩进和换行，便于阅读和调试
- 复杂结构分步创建，先创建外层再填充内层</rules>
<toolResult>${toolResult?.content}</toolResult>\n<info>如果想结束对话，转交给用户，可以使用[to_xxx]，这里的xxx为user</info>`;
              } else if (shouldIncludeKeyInfo) {
                // 需要路径信息的工具 或 工具失败时：只包含 keyInfo
                // toolContent += `\n${keyInfo}\n<toolResult>${toolResult?.content}</toolResult>\n<info>如果想结束对话，转交给用户，可以使用[to_xxx]，这里的xxx为user</info>`;
                toolContent += `\n<toolResult>${toolResult?.content}</toolResult>\n<info>如果想结束对话，转交给用户，可以使用[to_xxx]，这里的xxx为user</info>`;
              } else {
                // 其他成功的工具：不包含 keyInfo
                // toolContent += `\n<toolResult>${toolResult?.content}</toolResult>\n<info>如果想结束对话，转交给用户，可以使用[to_xxx]，这里的xxx为user</info>`;
                toolContent += `<toolResult>${toolResult?.content}</toolResult>\n<info>如果想结束对话，转交给用户，可以使用[to_xxx]，这里的xxx为user</info>`;
              }
            } else {
              toolContent = `
Your role is ASK (Advisory & Quick Support) - you provide analysis, recommendations, and guidance ONLY. You do NOT execute actual tasks or changes.
<toolResult>${toolResult?.content || '工具执行完成，无返回内容'}</toolResult>\n<info>如果想结束对话，转交给用户，可以使用[to_xxx]，这里的xxx为user</info>`;
            }

            // 显示工具完成状态（除了 todo_write_tool，以及 resultText 为空的情况）
            if (data.tool_name !== 'todo_write_tool' && resultText) {
              let finalState: ToolCallState;
              switch (resultState) {
                case "error":
                  finalState = ToolCallState.ERROR;
                  break;
                case "warn":
                  finalState = ToolCallState.WARN;
                  break;
                default:
                  finalState = ToolCallState.DONE;
                  break;
              }

              this.completeToolCall(data.tool_id, data.tool_name, finalState, resultText);
            }

            // console.log(`工具调用结果: `, toolResult, resultText);

            this.send("tool", JSON.stringify({
              "type": "tool",
              "tool_id": data.tool_id,
              "content": toolContent,
              "resultText": this.makeJsonSafe(resultText),
              "is_error": toolResult?.is_error ?? false
            }, null, 2), false);
          } else if (data.type === 'user_input_required') {
            // 处理用户输入请求 - 需要用户补充消息时停止等待状态
            // 设置最后一条消息状态为done
            if (this.list.length > 0 && this.list[this.list.length - 1].role === 'aily') {
              this.list[this.list.length - 1].state = 'done';
            }
            this.isWaiting = false;
          } else if (data.type === 'TaskCompleted') {
            const stopReason = data.stop_reason || 'unknown';
            // 判断停止原因
            // 1. Text 'TERMINATE' mentioned - 正常结束，由 complete 回调处理状态
            // 2. Maximum number of messages - 需要显示继续对话提示
            // 3. 其他异常 - 需要显示重试提示
            
            // 先清理流式残留内容（TERMINATE 文字、未闭合的代码块等）
            this.cleanupLastAiMessage();

            if (stopReason.includes('TERMINATE')) {
              // 正常结束，状态由 complete 回调统一处理
              // pass
            } else if (stopReason.includes('Maximum number of messages')) {
              // 解析最大消息数
              const maxMessagesMatch = stopReason.match(/(\d+)\s*reached/);
              const maxMessages = maxMessagesMatch ? parseInt(maxMessagesMatch[1], 10) : 10;
              
              // 保存当前停止原因用于继续对话
              this.lastStopReason = stopReason;
              
              // 显示提示信息，询问是否继续
              this.appendMessage('aily', `

\`\`\`aily-task-action
{
  "actionType": "max_messages",
  "message": "已达到本轮对话的最大消息数限制（${maxMessages}条），您可以选择继续对话或开始新会话。",
  "stopReason": "${this.makeJsonSafe(stopReason)}",
  "metadata": {
    "maxMessages": ${maxMessages}
  }
}
\`\`\`\n\n
              `);
            } else {
              // 保存当前停止原因用于重试
              this.lastStopReason = stopReason;
              
              // 显示报错，并提供重试按钮
              this.appendMessage('aily', `
\`\`\`aily-error
{
  "message": "任务执行过程中遇到问题，请重试或开始新会话。"
}
\`\`\`

\`\`\`aily-button
[{"text":"重试","action":"retry","type":"primary"}]
\`\`\`

`);
            }

          }
          this.scrollToBottom();
        } catch (e) {
          console.log('处理流数据时出错:', e);
          this.appendMessage('error', `
\`\`\`aily-error
{
  "message": "服务异常，请稍后重试。"
}
\`\`\`

\`\`\`aily-button
[{"text":"重试","action":"retry","type":"primary"}]
\`\`\`

`);
          // 调用取消函数
          this.stop();
        }
      },
      complete: () => {
        // 清理流式残留内容
        this.cleanupLastAiMessage();

        if (this.list.length > 0 && this.list[this.list.length - 1].role === 'aily') {
          this.list[this.list.length - 1].state = 'done';
        }
        this.isWaiting = false;
        this.isCompleted = true;

        // 更新历史列表元数据（用于显示），但不立即落盘
        // 落盘操作在 newChat、closeSession、ngOnDestroy 时触发
        try {
          let historyData = this.chatService.historyList.find(h => h.sessionId === this.sessionId);
          if (!historyData && this.sessionId) {
            // 如果已经有标题,直接使用
            if (this.sessionTitle && this.sessionTitle.trim() !== '') {
              this.chatService.historyList.push({ sessionId: this.sessionId, name: this.sessionTitle });
              this.HistoryList = [...this.chatService.historyList].reverse();
            } else {
              // 没有标题则等待标题生成后更新
              const checkTitle = () => {
                if (this.chatService.titleIsGenerating) {
                  setTimeout(checkTitle, 1000);
                  return;
                }
                const title = this.sessionTitle || 'q' + Date.now();
                // 再次检查是否已存在
                if (!this.chatService.historyList.find(h => h.sessionId === this.sessionId)) {
                  this.chatService.historyList.push({ sessionId: this.sessionId, name: title });
                  this.HistoryList = [...this.chatService.historyList].reverse();
                }
              };
              setTimeout(checkTitle, 3000);
            }
          }
        } catch (error) {
          console.warn("Error updating history list:", error);
        }
      },
      error: (err) => {
        console.warn('流连接出错:', err);
        // 设置最后一条AI消息状态为done（如果存在）
        if (this.list.length > 0 && this.list[this.list.length - 1].role === 'aily') {
          this.list[this.list.length - 1].state = 'done';
        }

        // 只有在活跃对话中才显示错误提示和重试按钮
        if (this.isWaiting) {
          this.appendMessage('error', `
\`\`\`aily-error
{
  "message": "网络连接已断开，请检查网络后重试。"
}
\`\`\`

\`\`\`aily-button
[{"text":"重试","action":"retry","type":"primary"}]
\`\`\`

`);
        }
        this.isWaiting = false;
      }
    });
  }

  getHistory(): void {
    if (!this.sessionId) return;

    this.list = [];
    // console.log('获取历史消息，sessionId:', this.sessionId);
    
    // 优先从内存缓存中获取
    if (this.chatService.historyChatMap.get(this.sessionId)) {
      const cachedHistory = this.chatService.historyChatMap.get(this.sessionId);
      // 处理历史消息，标记其中的交互组件为历史模式
      this.list = cachedHistory.map(item => {
        if (item.content && typeof item.content === 'string') {
          return {
            ...item,
            content: this.markContentAsHistory(item.content)
          };
        }
        return item;
      });
      this.scrollToBottom('auto');
      return;
    }

    // 其次从本地 .chat_history 文件夹加载
    const prjPath = this.projectService.currentProjectPath || this.projectService.projectRootPath;
    const localChatHistory = this.chatService.loadSessionChatHistory(prjPath, this.sessionId);
    if (localChatHistory && localChatHistory.length > 0) {
      // 处理历史消息，标记其中的交互组件为历史模式
      this.list = localChatHistory.map(item => {
        if (item.content && typeof item.content === 'string') {
          return {
            ...item,
            content: this.markContentAsHistory(item.content)
          };
        }
        return item;
      });
      // 同时更新内存缓存
      this.chatService.historyChatMap.set(this.sessionId, this.list);
      this.scrollToBottom('auto');
      return;
    }

    // // 最后从服务端获取
    // this.chatService.getHistory(this.sessionId).subscribe((res: any) => {
    //   // console.log('get history', res);
    //   if (res.status === 'success') {
    //     // 先解析工具调用状态信息
    //     this.parseHistory(res.data);
    //     this.scrollToBottom('auto');
    //   } else {
    //     this.appendMessage('error', res.message);
    //   }
    // });
  }

  bottomHeight = 180;

  onContentResize({ height }: NzResizeEvent): void {
    this.bottomHeight = height!;
  }

  // 回车发送消息，ctrl+回车换行
  async onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      if (event.ctrlKey) {
        // Ctrl+Enter 换行
        const textarea = event.target as HTMLTextAreaElement;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        this.inputValue = this.inputValue.substring(0, start) + '\n' + this.inputValue.substring(end);
        // 需要在下一个事件循环中设置光标位置
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 1;
        }, 0);
        event.preventDefault();
      } else {
        this.autoScrollEnabled = true;
        this.scrollToBottom();
        // Enter 发送消息
        if (this.isWaiting) {
          return;
        }

        this.send("user", this.inputValue.trim(), true);
        // 将用户添加的上下文路径保存到会话允许路径中
        this.mergeSelectContentToSessionPaths();
        this.selectContent = [];
        this.inputValue = "";
        event.preventDefault();
      }
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

  scrollToBottom(behavior: string = 'smooth') {
    // 只在自动滚动启用时才滚动到底部
    if (!this.autoScrollEnabled) {
      return;
    }

    if (!this.chatContainer?.nativeElement) {
      return;
    }

    const element = this.chatContainer.nativeElement;
    let lastScrollHeight = 0;
    let stableCount = 0;
    const maxAttempts = 20; // 尝试20次（约2秒）
    const stableThreshold = 2; // 连续2次scrollHeight不变则认为稳定

    const attemptScroll = () => {
      try {
        const currentScrollTop = element.scrollTop;
        const scrollHeight = element.scrollHeight;
        const clientHeight = element.clientHeight;
        const maxScrollTop = scrollHeight - clientHeight;

        if (scrollHeight === lastScrollHeight) {
          stableCount++;
        } else {
          stableCount = 0;
          lastScrollHeight = scrollHeight;
        }

        if (stableCount >= stableThreshold || stableCount >= maxAttempts) {
          if (currentScrollTop < maxScrollTop - 2) {
            element.scrollTo({
              top: scrollHeight,
              behavior,
            });
          }
          return;
        }

        if (stableCount < maxAttempts) {
          setTimeout(attemptScroll, 100);
        }
      } catch (error) {
        console.warn('滚动到底部失败:', error);
      }
    };

    setTimeout(attemptScroll, 100);
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

    const prevTop = this._scrollTrackLastTop;
    const prevHeight = this._scrollTrackLastHeight;
    const deltaTop = (prevTop == null) ? 0 : (element.scrollTop - prevTop);
    const deltaHeight = (prevHeight == null) ? 0 : (element.scrollHeight - prevHeight);

    // 内容增长可能造成 scrollTop 轻微回跳（不是用户手动上滑）
    const contentGrew = prevHeight != null && deltaHeight > 0;
    const likelyReflowNudge = contentGrew && Math.abs(deltaTop) <= 10;

    const userScrolledUp = deltaTop < -30 && !likelyReflowNudge;

    if (!isAtBottom && this.autoScrollEnabled) {
      const shouldDisable = userScrolledUp || (!contentGrew && (this._scrollTrackLastAtBottom === true));
      if (shouldDisable) {
        this.autoScrollEnabled = false;
      }
    }
    else if (isAtBottom && !this.autoScrollEnabled) {
      this.autoScrollEnabled = true;
      // console.log('用户滚动到底部，已启用自动滚动');
    }

    this._scrollTrackLastTop = element.scrollTop;
    this._scrollTrackLastHeight = element.scrollHeight;
    this._scrollTrackLastAtBottom = isAtBottom;
  }

  HistoryList: any[] = [
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

  // AI模型列表
  get ModelList(): IMenuItem[] {
    // 从配置服务获取已启用的模型列表
    const enabledModels = this.ailyChatConfigService.getEnabledModels();
    return enabledModels.map(model => ({
      name: model.name,
      action: 'select-model',
      data: { model }
    }));
  }

  // 当前AI模式
  // currentMode = 'agent'; // 默认为代理模式

  async stopAndCloseSession(skipSave: boolean = false) {
    // 关闭会话前，保存当前会话数据（除非明确跳过）
    if (!skipSave) {
      this.saveCurrentSession();
    }

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
            // console.log('会话已停止:', res);
            this.isWaiting = false;
            resolve();
          },
          error: (err) => {
            clearTimeout(timeout);
            console.warn('停止会话失败:', err);
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
          // console.warn('关闭会话超时，继续执行');
          resolve();
        }, 5000);

        this.chatService.closeSession(this.sessionId).subscribe({
          next: (res: any) => {
            clearTimeout(timeout);
            // console.log('会话已关闭:', res);
            resolve();
          },
          error: (err) => {
            clearTimeout(timeout);
            console.warn('关闭会话失败:', err);
            resolve(); // 即使失败也继续
          }
        });
      });
    } catch (error) {
      console.warn('停止和关闭会话失败:', error);
      throw error; // 抛出错误，让调用者处理
    }
  }

  async newChat() {
    // console.log('启动新会话');

    // 检查当前会话是否还在进行中
    if (this.isWaiting) {
      this.message.warning(this.translate.instant('AILY_CHAT.STOP_CURRENT_SESSION_FIRST') || '请先停止当前会话，再新建');
      return;
    }

    // 防止重复创建新会话
    if (this.isSessionStarting) {
      // console.log('新会话正在创建中，跳过重复调用');
      return;
    }

    // 创建新对话前，保存当前会话数据
    this.saveCurrentSession();

    this.list = [];

    // console.log("CurrentList: ", this.list);
    // 新会话时重新启用自动滚动
    this.autoScrollEnabled = true;
    this.isCompleted = false;
    this.isCancelled = false; // 重置取消标志

    try {
      // 先停止并关闭当前会话（跳过保存，因为上面已保存）
      await this.stopAndCloseSession(true);

      // 确保会话完全关闭后再清空ID和路径
      this.chatService.currentSessionId = '';
      this.chatService.currentSessionTitle = '';
      this.chatService.currentSessionPath = '';

      // 重置会话启动标志和初始化标志
      this.isSessionStarting = false;
      this.hasInitializedForThisLogin = false;

      // 等待一小段时间确保所有异步操作完成
      await new Promise(resolve => setTimeout(resolve, 100));

      // 启动新会话
      await this.startSession();

    } catch (error) {
      console.warn('新会话启动失败:', error);

      // 即使失败也要确保标志位重置
      this.isSessionStarting = false;
    }
  }

  /**
   * 处理任务操作事件（来自 aily-task-action-viewer 组件）
   * @param event 自定义事件
   */
  private handleTaskAction(event: Event): void {
    const customEvent = event as CustomEvent;
    const { action, data } = customEvent.detail || {};
    
    // console.log('收到任务操作事件:', action, data);
    
    switch (action) {
      case 'continue':
        this.continueConversation();
        break;
      case 'retry':
        this.retryLastAction();
        break;
      case 'newChat':
        this.newChat();
        break;
      case 'dismiss':
        // 用户选择关闭，无需额外操作
        break;
      default:
        console.warn('未知的任务操作:', action);
    }
  }

  /**
   * 继续当前对话
   * 向服务器发送继续请求，让AI继续之前的任务
   */
  async continueConversation(): Promise<void> {
    if (this.isWaiting) {
      this.message.warning('正在处理中，请稍候...');
      return;
    }
    
    if (!this.sessionId) {
      this.message.warning('会话不存在，请开始新对话');
      return;
    }
    
    // 发送继续消息
    const continueMessage = '请继续完成之前的任务。';
    await this.send('user', continueMessage, false);
  }

  /**
   * 重试上次失败的操作
   */
  async retryLastAction(): Promise<void> {
    if (this.isWaiting) {
      this.message.warning('正在处理中，请稍候...');
      return;
    }
    
    if (!this.sessionId) {
      this.message.warning('会话不存在，请开始新对话');
      return;
    }
    
    // 发送重试消息
    const retryMessage = '请重试上次的操作。';
    await this.send('user', retryMessage, false);
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
    // console.log('文件选择结果:', result);
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

      // console.log('已添加的文件:', selectedPaths);
      // console.log('当前资源列表:', this.selectContent);
    } else {
      // console.log('用户取消了文件选择或没有选择文件');
    }
  }

  async addFolder() {
    const options = {
      title: '选择文件夹',
      properties: ['openDirectory']
    };
    const result = await window['dialog'].selectFiles(options);
    // console.log('文件夹选择结果:', result);
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

      // console.log('已添加的文件夹:', selectedPath);
      // console.log('当前资源列表:', this.selectContent);
    } else {
      // console.log('用户取消了文件夹选择或没有选择文件夹');
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
          // console.log('已添加的URL:', url.trim());
          // console.log('当前资源列表:', this.selectContent);
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
   * 将 selectContent 中的文件/文件夹路径合并到 sessionAllowedPaths
   * 用于在发送消息后保留用户添加的上下文路径权限
   */
  private mergeSelectContentToSessionPaths(): void {
    const newPaths = this.selectContent
      .filter(item => (item.type === 'file' || item.type === 'folder') && item.path)
      .map(item => item.path as string);

    // 去重合并到 sessionAllowedPaths
    for (const path of newPaths) {
      if (!this.sessionAllowedPaths.includes(path)) {
        this.sessionAllowedPaths.push(path);
      }
    }
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
      text = `<context>\n${text}\n</context>`;
    }

    return text.trim();
  }

  showHistoryList = false;
  showMode = false;
  showModelMenu = false;
  historyListPosition = { x: 0, y: 0 };
  modeListPosition = { x: 0, y: 0 };
  modelListPosition = { x: 0, y: 0 };

  openHistoryChat(e) {
    // 设置菜单的位置
    this.historyListPosition = { x: window.innerWidth - 302, y: 72 };
    // console.log(this.historyListPosition);

    this.showHistoryList = !this.showHistoryList;
  }

  closeMenu() {
    this.showHistoryList = false;
    this.showMode = false;
    this.showModelMenu = false;
  }

  menuClick(e) {
    // console.log('选择了历史会话:', e);
    // console.log("CurrentSessionId: ", this.chatService.currentSessionId)
    if (this.chatService.currentSessionId !== e.sessionId) {
      this.chatService.currentSessionId = e.sessionId;
      // 历史会话来自当前路径的历史列表，所以记录当前路径
      this.chatService.currentSessionPath = this.projectService.currentProjectPath || this.projectService.projectRootPath;
      this.getHistory();
      this.isCompleted = true;
      this.closeMenu();
    }
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

    this.showModelMenu = false;
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

  // 模型选择相关方法
  switchModel(event: MouseEvent) {
    // 获取点击的按钮元素
    const target = event.currentTarget as HTMLElement;
    if (target) {
      // 获取按钮的位置信息
      const rect = target.getBoundingClientRect();

      // 计算菜单位置：在按钮上方显示
      const menuWidth = 180; // 菜单宽度
      const menuHeight = this.ModelList.length * 30 + 6 + 6; // 预估菜单高度：每项30px + 上下padding各3px + 上下间距各3px

      // 计算水平位置
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
      this.modelListPosition = { x: Math.max(0, x), y: Math.max(0, y) };
    } else {
      // 如果无法获取按钮位置，使用默认位置
      this.modelListPosition = { x: window.innerWidth - 302, y: window.innerHeight - 280 };
    }

    // 阻止事件冒泡，避免触发其他点击事件
    event.preventDefault();
    event.stopPropagation();

    this.showMode = false;
    this.showModelMenu = !this.showModelMenu;
  }

  modelMenuClick(item: IMenuItem) {
    if (item.data?.model && item.data.model.model !== this.currentModel?.model) {
      this.switchToModel(item.data.model);
    }
    this.showModelMenu = false;
  }

  /**
   * 切换AI模型并创建新会话
   * @param model 要切换到的模型配置
   */
  private async switchToModel(model: ModelConfig) {
    if (model.model === this.currentModel?.model) {
      return;
    }

    // 保存模型到配置
    this.chatService.saveChatModel(model);
    // 切换模型需要创建新会话
    await this.stopAndCloseSession();
    this.startSession().then((res) => {
      // console.log('新会话已启动，当前模型:', this.currentModel);
    }).catch((err) => {
      console.error('切换模型失败:', err);
    });
  }

  /**
   * 切换AI模式并创建新会话
   * @param mode 要切换到的模式
   */
  private async switchToMode(mode: string) {
    if (mode === this.currentMode) {
      return;
    }

    // 保存模式到配置
    this.chatService.saveChatMode(mode as 'agent' | 'ask');
    // console.log('切换AI模式为:', this.currentMode);
    await this.stopAndCloseSession();
    this.startSession().then((res) => {
      // console.log('新会话已启动，当前模式:', this.currentMode);
    }).catch((err) => {
      this.switchToMode('chat');
    });
  }

  // ==================== 新手引导相关方法 ====================

  // 检查是否是第一次使用AI助手
  private checkFirstUsage() {
    const hasSeenOnboarding = this.configService.data.ailyChatOnboardingCompleted;
    if (!hasSeenOnboarding && this.isLoggedIn) {
      // 延迟显示引导，确保页面已渲染
      setTimeout(() => {
        this.onboardingService.start(AILY_CHAT_ONBOARDING_CONFIG, {
          onClosed: () => this.onOnboardingClosed(),
          onCompleted: () => this.onOnboardingClosed()
        });
      }, 800);
    }
  }

  // 引导关闭或完成时的处理
  private onOnboardingClosed() {
    this.configService.data.ailyChatOnboardingCompleted = true;
    this.configService.save();
  }

  /**
   * 清理订阅
   */
  ngOnDestroy() {
    // console.log('AilyChatComponent 正在销毁...');

    // 组件销毁前，保存当前会话数据
    this.saveCurrentSession();

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

    // 清理 aiWriting 订阅
    if (this.aiWritingSubscription) {
      this.aiWritingSubscription.unsubscribe();
      this.aiWritingSubscription = null;
    }

    // 清理 aiWaiting 订阅
    if (this.aiWaitingSubscription) {
      this.aiWaitingSubscription.unsubscribe();
      this.aiWaitingSubscription = null;
    }

    // 清理项目路径订阅
    if (this.projectPathSubscription) {
      this.projectPathSubscription.unsubscribe();
      this.projectPathSubscription = null;
    }

    // 清理配置变更订阅
    if (this.configChangedSubscription) {
      this.configChangedSubscription.unsubscribe();
      this.configChangedSubscription = null;
    }

    // 清理任务操作事件监听
    if (this.taskActionHandler) {
      document.removeEventListener('aily-task-action', this.taskActionHandler);
      this.taskActionHandler = null;
    }

    // 重置会话启动标志和MCP初始化标志
    this.isSessionStarting = false;
    this.mcpInitialized = false;
    this.hasInitializedForThisLogin = false;

    this.disconnect();

    if (this.list.length > 0 && this.list[this.list.length - 1].role === 'aily') {
      this.list[this.list.length - 1].state = 'done';
    }
  }

  // 添加订阅管理
  private messageSubscription: any;

  // 工具调用状态管理
  toolCallStates: { [key: string]: string } = {};


  demandEdit() {

  }

  showSettings = false;
  openSettings(event) {
    this.showSettings = !this.showSettings
  }

  onSettingsSaved() {
    // 关闭设置面板
    this.showSettings = false;
    
    // 注意：配置生效逻辑已由 configChanged$ 订阅处理
    // 这里不需要额外操作，消息提示会在订阅中统一处理
  }
}
