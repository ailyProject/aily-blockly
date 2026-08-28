/**
 * BackgroundAgentService - 后台 Agent 服务
 *
 * 负责连线图子窗口与新版 Aily Chat 之间的宿主转发。
 * - 不再启动旧版 aily-chat 后台执行链
 * - 将连线图提示词交给新版 Aily Chat 会话
 * - 通过 IPC 推送提示词转交状态到连线图子窗口
 */

import { Injectable, OnDestroy } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import { UiService } from '@core/app-shell/public-api';
import { ElectronService } from '@core/platform/public-api';
import { ProjectService } from '@domain/project/public-api';
import { ConnectionGraphService } from '@domain/schematic/public-api';
import {
  ChildToolProcessService,
  DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID,
} from '@integration/subapps/public-api';

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

interface SchematicGenerationOptions {
  revealSession?: boolean;
}

const AILY_CHAT_TOOL_ID = DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID;
const AILY_CHAT_HOST_SERVICE_CHANNEL = 'aily-chat-demand-session-v1';
const SCHEMATIC_GENERATION_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SCHEMATIC_PROMPT = '[AGENT: SchematicAgent] 生成项目连线图';
const SCHEMATIC_SESSION_TITLE = '生成电路连接图';

interface SchematicGenerationResponse {
  channel: typeof AILY_CHAT_HOST_SERVICE_CHANNEL;
  type: 'response';
  requestId: string;
  result?: {
    accepted?: boolean;
    reason?: 'schematic-agent-running';
    sessionId?: string;
    state?: 'settled' | 'rejected' | 'failed';
    error?: string;
  };
}

interface SchematicGenerationEvent {
  channel: typeof AILY_CHAT_HOST_SERVICE_CHANNEL;
  type: 'event';
  requestId: string;
  event?: {
    type?: 'session-created';
    sessionId?: string;
  };
}

@Injectable({
  providedIn: 'root'
})
export class BackgroundAgentService implements OnDestroy {
  // ===== 状态 =====
  private progress$ = new Subject<ProgressEvent>();
  private status: BackgroundAgentStatus = 'idle';

  constructor(
    private projectService: ProjectService,
    private connectionGraphService: ConnectionGraphService,
    private electronService: ElectronService,
    private childToolProcess: ChildToolProcessService,
    private uiService: UiService,
  ) {
    this.setupIpcListeners();
    console.log('[BackgroundAgent] 服务初始化');
  }

  ngOnDestroy(): void {
    this.status = 'idle';
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

  /** 进度事件流 */
  onProgress(): Observable<ProgressEvent> {
    return this.progress$.asObservable();
  }

  /**
   * 启动连线图生成任务
   * 完整流程：启动/复用新版 Aily Chat 后台 → 创建独立 session → 执行提示词 → 完成。
   */
  async generateSchematic(
    prompt = DEFAULT_SCHEMATIC_PROMPT,
    options: SchematicGenerationOptions = {},
  ): Promise<void> {
    if (this.isRunning) {
      console.warn('[BackgroundAgent] 任务已在运行中');
      return;
    }

    const cwd = this.projectService.currentProjectPath;
    if (!cwd) {
      this.status = 'error';
      this.emitProgress('error', '请先打开项目');
      return;
    }

    this.status = 'running';
    this.emitProgress('thinking', '正在分析项目...');
    let runtimeAcquired = false;
    const revealSession = options.revealSession === true;

    try {
      await this.childToolProcess.acquire(AILY_CHAT_TOOL_ID);
      runtimeAcquired = true;

      const result = await this.requestSchematicGeneration(cwd, prompt, revealSession);
      if (result.accepted === false && result.reason === 'schematic-agent-running') {
        this.status = 'completed';
        this.emitProgress('complete', '已有连线图 Agent 正在执行');
        return;
      }

      if (result.accepted !== true || result.state !== 'settled') {
        throw new Error(result.error || '连线图生成失败');
      }

      this.status = 'completed';
      this.emitProgress('complete', '连线图生成完成');
    } catch (error: any) {
      this.status = 'error';
      this.emitProgress('error', error.message || '连线图生成失败');
      console.error('[BackgroundAgent] 生成失败:', error);
    } finally {
      if (runtimeAcquired) {
        await this.childToolProcess.release(AILY_CHAT_TOOL_ID);
      }
    }
  }

  // =========================================================================
  // IPC 监听（来自连线图子窗口的请求）
  // =========================================================================

  private setupIpcListeners(): void {
    if (!this.electronService.isElectron || !window['ipcRenderer']) return;

    window['ipcRenderer'].on('iframe-message-connection-graph', (_event: any, payload: { type: string; data?: unknown }) => {
      if (payload?.type === 'generate-graph-data') {
        const request = (payload.data || {}) as { prompt?: unknown; revealSession?: unknown };
        const prompt = typeof request.prompt === 'string'
          ? request.prompt
          : DEFAULT_SCHEMATIC_PROMPT;
        void this.generateSchematic(prompt, { revealSession: request.revealSession === true });
        return;
      }
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

  private requestSchematicGeneration(
    cwd: string,
    prompt: string,
    revealSession: boolean,
  ): Promise<NonNullable<SchematicGenerationResponse['result']>> {
    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const removeListener = this.childToolProcess.onMessage(
        AILY_CHAT_TOOL_ID,
        (message) => {
          const response = message as unknown as SchematicGenerationResponse | SchematicGenerationEvent;
          if (
            response.channel !== AILY_CHAT_HOST_SERVICE_CHANNEL ||
            response.requestId !== requestId
          ) {
            return;
          }

          if (response.type === 'event') {
            const sessionId = response.event?.type === 'session-created'
              ? String(response.event.sessionId || '').trim()
              : '';
            if (sessionId && revealSession) {
              void this.uiService.openAilyChatSession(sessionId).then(
                opened => {
                  if (!opened) {
                    console.warn('[BackgroundAgent] Aily Chat session 导航超时:', sessionId);
                  }
                },
                error => console.warn('[BackgroundAgent] Aily Chat session 导航失败:', error),
              );
            }
            return;
          }

          clearTimeout(timeout);
          removeListener();
          if (response.result) resolve(response.result);
          else reject(new Error('Aily Chat 后台未返回连线图任务结果'));
        },
      );
      const timeout = setTimeout(() => {
        removeListener();
        reject(new Error('连线图后台任务执行超时'));
      }, SCHEMATIC_GENERATION_TIMEOUT_MS);

      void this.childToolProcess
        .sendMessage(AILY_CHAT_TOOL_ID, {
          channel: AILY_CHAT_HOST_SERVICE_CHANNEL,
          type: 'request',
          requestId,
          action: 'demand-session.run',
          kind: 'schematic',
          cwd,
          title: SCHEMATIC_SESSION_TITLE,
          prompt,
          mode: 'agent',
          revealSession,
          resources: [],
        })
        .catch((error) => {
          clearTimeout(timeout);
          removeListener();
          reject(error);
        });
    });
  }

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
