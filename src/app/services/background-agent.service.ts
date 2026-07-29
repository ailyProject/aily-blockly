/**
 * BackgroundAgentService - 后台 Agent 服务
 *
 * 使用 aily-lex 运行独立的后台 Agent，用于连线图自动生成。
 * - 通过 lex createAgent() 创建本地 agent（不依赖服务端 subagent）
 * - Agent 自动调用 schematic/file/context 等工具
 * - 通过 IPC 推送进度到连线图子窗口
 */

import { Injectable, OnDestroy } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import { ElectronService } from './electron.service';
import { ProjectService } from './project.service';
import { ConnectionGraphService } from './connection-graph.service';
import { AilyChatConfigService } from '../tools/aily-chat/services/aily-chat-config.service';
import { ChatService } from '../tools/aily-chat/services/chat.service';
import { AilyHost } from '../tools/aily-chat/core/host';
import {
  createBlocklyStandardHostBinding,
  buildLexEndpoint,
  buildLexModelConfig,
} from '../tools/aily-chat/helpers/lex-agent-bootstrap';

type AilyLexModule = typeof import('aily-lex/browser');

// ===== 类型定义 =====

export type ProgressEventType =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'text'
  | 'complete'
  | 'error';

export interface ProgressEvent {
  type: ProgressEventType;
  content: string;
  toolName?: string;
  timestamp: number;
  data?: any;
}

export type BackgroundAgentStatus = 'idle' | 'running' | 'completed' | 'error';

/** 工具显示名称映射 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  'get_pinmap_summary': '获取引脚信息',
  'generate_schematic': '生成连线方案',
  'validate_schematic': '验证连线配置',
  'get_component_catalog': '获取组件目录',
  'get_project_context': '获取项目上下文',
  'generate_pinmap': '生成引脚图',
  'save_pinmap': '保存引脚图',
  'get_current_schematic': '获取当前电路图',
  'apply_schematic': '应用电路方案',
  'get_context': '获取上下文',
  'get_project_info': '获取项目信息',
  'read_file': '读取文件',
  'create_file': '创建文件',
  'edit_file': '编辑文件',
  'delete_file': '删除文件',
  'delete_folder': '删除文件夹',
  'create_folder': '创建文件夹',
  'list_directory': '列出目录',
  'get_directory_tree': '获取目录树',
  'grep_tool': '搜索内容',
  'grep_search': '搜索内容',
  'glob_tool': '搜索文件',
  'glob_search': '搜索文件',
  'get_board_parameters': '获取开发板参数',
  'fetch': '获取网页',
  'fetch_webpage': '获取网页',
};

/** BackgroundAgent 可用的 lex 核心工具子集（仅文件/搜索/上下文，不含终端/agent/web） */
const BACKGROUND_AGENT_CORE_TOOLS = new Set([
  'read_file', 'write_file', 'edit_file',
  'delete_file',
  'grep_search', 'glob_search',
  'get_context',
  'think',
]);

@Injectable({
  providedIn: 'root'
})
export class BackgroundAgentService implements OnDestroy {
  // ===== 状态 =====
  private progress$ = new Subject<ProgressEvent>();
  private status: BackgroundAgentStatus = 'idle';
  private abortController: AbortController | null = null;

  // ===== 懒加载 lex =====
  private _lex: AilyLexModule | null = null;
  private _loadPromise: Promise<boolean> | null = null;

  constructor(
    private projectService: ProjectService,
    private connectionGraphService: ConnectionGraphService,
    private electronService: ElectronService,
    private ailyChatConfigService: AilyChatConfigService,
    private chatService: ChatService,
  ) {
    this.setupIpcListeners();
    console.log('[BackgroundAgent] 服务初始化');
  }

  ngOnDestroy(): void {
    this.cancel();
  }

  // =========================================================================
  // 公共 API
  // =========================================================================

  /** 当前状态 */
  get currentStatus(): BackgroundAgentStatus {
    return this.status;
  }

  /** 是否正在运行 */
  get isRunning(): boolean {
    return this.status === 'running';
  }

  /**
   * Starts the user-visible reconciliation step for a Simulator-owned Scene.
   * Completion is deliberately not implied here: the project host will only
   * accept a later Builder result that carries the exact graph revision.
   */
  requestSimulatorSceneCodeReconciliation(request: {
    sceneId: string;
    expectedGraphSemanticRevision: string;
    sceneDocument: unknown;
  }): boolean {
    if (typeof window.openAndSendToAilyChat !== 'function') return false;
    const sceneSnapshot = JSON.stringify(request.sceneDocument, null, 2);
    const prompt = `请根据 Simulator Scene 的最新硬件语义，协调当前 Blockly 代码。

## 约束
1. Scene ID: ${request.sceneId}
2. graphSemanticRevision: ${request.expectedGraphSemanticRevision}
3. 只修改当前项目的 Blockly/生成代码所需内容，不启动或控制 QEMU/GDB。
4. 完成修改后告知用户返回 Simulator 再次点击 “Sync code & rebuild”；
   Artifact 编译和替换由独立 project host 继续协调。

## SceneEditorDocument
\`\`\`json
${sceneSnapshot}
\`\`\``;
    window.openAndSendToAilyChat(prompt, { autoSend: true });
    return true;
  }

  /** 进度事件流 */
  onProgress(): Observable<ProgressEvent> {
    return this.progress$.asObservable();
  }

  /**
   * 启动连线图生成任务
   * 完整流程：加载 lex → 创建 agent → 发送提示词 → 迭代事件 → 完成
   */
  async generateSchematic(): Promise<void> {
    if (this.isRunning) {
      console.warn('[BackgroundAgent] 任务已在运行中');
      return;
    }

    this.status = 'running';
    const ac = new AbortController();
    this.abortController = ac;

    try {
      // 1. 加载 lex 模块
      if (!await this._loadLex()) {
        throw new Error('aily-lex 模块不可用');
      }
      const lex = this._lex!;

      // 2. 构建 host API + adapter
      const cwd = this.projectService.currentProjectPath || '';
      const { adapter, toolProvider } = createBlocklyStandardHostBinding(cwd);

      // 3. 创建 lex agent
      const agent = lex.createAgent({
        host: adapter,
        endpoint: buildLexEndpoint(lex, this.chatService.currentModel, this.ailyChatConfigService),
        model: buildLexModelConfig(this.chatService.currentModel, 8192, this.ailyChatConfigService),
        cwd: cwd || undefined,
        maxToolCallIterations: this.ailyChatConfigService.maxRequests,
        extensions: {
          sessionCompletionCoordinator: {
            scheduleRequestCompleted: (input: {
              sessionId: string;
              turnId: string;
              reason: string;
              runWorkspaceFinalize: () => Promise<void>;
              runSessionEndHooks: () => Promise<void>;
            }) => {
              void (async () => {
                await input.runWorkspaceFinalize();
                await input.runSessionEndHooks();
              })().catch(error => {
                console.warn('[BackgroundAgent] request-completed coordination failed:', error);
              });
            },
          },
        },
        toolProvider,
        coreToolFilter: BACKGROUND_AGENT_CORE_TOOLS,
      });

      // 4. 构建提示词
      const prompt = this._buildGenerationPrompt();
      this.emitProgress('thinking', '正在分析项目...');
      console.log('[BackgroundAgent] 提示词已准备，启动 lex agent');

      // 5. 迭代 agent 事件
      for await (const event of agent.chat(prompt, ac.signal)) {
        if (ac.signal.aborted) break;
        this._handleAgentEvent(event);
      }

      // 6. 完成
      if (!ac.signal.aborted) {
        this.status = 'completed';
        this.emitProgress('complete', '连线图生成完成');
      }
    } catch (error: any) {
      if (!ac.signal.aborted) {
        this.status = 'error';
        this.emitProgress('error', error.message || '连线图生成失败');
        console.error('[BackgroundAgent] 生成失败:', error);
      }
    }
  }

  /**
   * 取消当前任务
   */
  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.status = 'idle';
  }

  // =========================================================================
  // lex 模块加载
  // =========================================================================

  private async _loadLex(): Promise<boolean> {
    if (this._lex) return true;
    if (!this._loadPromise) {
      this._loadPromise = (async () => {
        try {
          this._lex = await import('aily-lex/browser');
          console.log('[BackgroundAgent] aily-lex 模块加载成功');
          return true;
        } catch (err) {
          console.warn('[BackgroundAgent] aily-lex 模块不可用:', err);
          this._loadPromise = null;
          return false;
        }
      })();
    }
    return this._loadPromise;
  }

  // =========================================================================
  // AgentEvent → ProgressEvent 映射
  // =========================================================================

  private _handleAgentEvent(event: import('aily-lex/browser').AgentEvent): void {
    switch (event.type) {
      case 'thinking':
        this.emitProgress('thinking', '正在分析项目...');
        break;
      case 'text_delta':
        this.emitProgress('text', event.text);
        break;
      case 'tool_call_start': {
        const displayName = TOOL_DISPLAY_NAMES[event.toolName] || event.toolName;
        this.emitProgress('tool_call', `正在${displayName}...`, event.toolName);
        break;
      }
      case 'tool_call_end': {
        const displayName = TOOL_DISPLAY_NAMES[event.toolName] || event.toolName;
        const suffix = event.result?.isError ? '失败' : '完成';
        this.emitProgress('tool_result', `${displayName}${suffix}`, event.toolName);
        break;
      }
      case 'error':
        this.emitProgress('error', event.error);
        break;
    }
  }

  // =========================================================================
  // 提示词构建
  // =========================================================================

  /**
   * 构建生成连线图的提示词，附带项目代码上下文。
   * 直接使用 AilyHost.get().fs 读取文件，不依赖 tool handler 函数。
   */
  private _buildGenerationPrompt(): string {
    let contextInfo = '';
    const host = AilyHost.get();
    const projectPath = this.projectService.currentProjectPath;

    try {
      // 项目基础信息
      if (projectPath) {
        contextInfo += `\n## 项目上下文\n项目路径: ${projectPath}\n`;

        // 尝试读取 package.json 获取开发板信息
        try {
          const pkgContent = host.fs.readFileSync(projectPath + '/package.json', 'utf-8');
          const pkg = JSON.parse(pkgContent);
          if (pkg.board) contextInfo += `开发板: ${pkg.board.name || pkg.board}\n`;
          if (pkg.name) contextInfo += `项目名称: ${pkg.name}\n`;
        } catch { /* ignore */ }

        // 简单目录概览
        try {
          const entries = host.fs.readdirSync?.(projectPath) ?? (host.fs as any).readDirSync?.(projectPath) ?? [];
          if (entries.length > 0) {
            contextInfo += `\n## 项目目录结构\n${entries.join('\n')}\n`;
          }
        } catch { /* ignore */ }

        // 读取主要代码文件
        const sep = host.platform?.pathSeparator || (host.platform?.isWindows ? '\\' : '/');
        const mainFiles = ['project.abs', 'src/main.ino', 'src/main.cpp', 'main.ino'];
        for (const file of mainFiles) {
          const filePath = projectPath + sep + file.replace(/\//g, sep);
          try {
            if (host.fs.existsSync(filePath)) {
              const content = host.fs.readFileSync(filePath, 'utf-8');
              contextInfo += `\n## 项目代码 (${file})\n\`\`\`\n${content}\n\`\`\`\n`;
              break;
            }
          } catch { /* ignore */ }
        }
      }
    } catch (e) {
      console.warn('[BackgroundAgent] 收集项目上下文失败:', e);
    }

    return `请分析当前项目的代码，自动生成对应的硬件连线图（电路连线方案）。

${contextInfo}

## 要求
1. 根据代码中使用的传感器/模块，确定需要的硬件组件
2. 使用 generate_schematic 获取引脚摘要并生成连线（该工具会自动尝试同步云端 pinmap；仅在需要单独查看引脚表时再调用 get_pinmap_summary）
3. 生成合理的连线方案
4. 验证连线配置的正确性
5. 应用连线方案到项目中

请开始分析并生成连线图。`;
  }

  // =========================================================================
  // IPC 监听（来自连线图子窗口的请求）
  // =========================================================================

  private setupIpcListeners(): void {
    if (!this.electronService.isElectron || !window['ipcRenderer']) return;

    window['ipcRenderer'].on('iframe-message-connection-graph', (_event: any, payload: { type: string; data?: unknown }) => {
      if (payload?.type === 'send-to-chat') {
        const { text, autoSend } = (payload.data || {}) as { text?: string; autoSend?: boolean };
        if (text && window.openAndSendToAilyChat) {
          window.openAndSendToAilyChat(text, { autoSend: autoSend !== false });
        }
        return;
      }
      if (payload?.type === 'generate-graph-code') {
        console.log('[BackgroundAgent] 收到同步到代码请求');
        this.handleSyncToCodeRequest();
      }
    });
  }

  // =========================================================================
  // "同步到代码" 处理
  // =========================================================================

  private handleSyncToCodeRequest(): void {
    const connectionData = this.connectionGraphService.getConnectionGraph();
    if (!connectionData) {
      console.warn('[BackgroundAgent] 同步到代码: 无连线图数据');
      return;
    }

    const componentSummary = (connectionData.components || [])
      .map((c: any) => `- ${c.title || c.refId || c.id}`)
      .join('\n');

    const prompt = `请根据当前连线图方案，将硬件连线配置同步到项目代码中。

## 当前连线组件
${componentSummary}

## 连线数量
${(connectionData.connections || []).length} 条连线

请分析连线图，在代码中添加或修改对应的传感器初始化和引脚配置代码。`;

    if (window.openAndSendToAilyChat) {
      window.openAndSendToAilyChat(prompt, { autoSend: true });
    }
  }

  // =========================================================================
  // 进度推送
  // =========================================================================

  private emitProgress(type: ProgressEventType, content: string, toolName?: string, data?: any): void {
    const event: ProgressEvent = {
      type,
      content,
      toolName,
      timestamp: Date.now(),
      data,
    };

    this.progress$.next(event);

    if (this.electronService.isElectron && window['ipcRenderer']) {
      window['ipcRenderer'].send('iframe-message-connection-graph', { type: 'generate-graph-progress', data: event });
    }
  }
}
