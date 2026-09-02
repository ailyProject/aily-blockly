/**
 * 宿主直接通过新版 Aily Chat Runtime 创建并提交需求会话。
 * React 输入框只展示已创建的会话，不参与任务注入。
 */

import { Injectable } from '@angular/core';
import { UiService } from '@core/app-shell/public-api';
import { ElectronService } from '@core/platform/public-api';
import { ProjectService } from '@domain/project/public-api';
import { ConnectionGraphService } from '@domain/schematic/public-api';
import { BehaviorSubject } from 'rxjs';
import {
  ChildToolProcessService,
  DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID,
} from '@integration/subapps/public-api';

export type AilyChatDemandSessionKind =
  | 'architecture'
  | 'schematic'
  | 'block-explain'
  | 'code-sync';

export type DiagramGenerationKind = Extract<
  AilyChatDemandSessionKind,
  'architecture' | 'schematic'
>;

export interface DiagramGenerationActivity {
  kind: DiagramGenerationKind;
  requestId: string;
  projectPath: string;
  startedAt: number;
  sessionId?: string;
}

export interface DiagramGenerationState {
  architecture: DiagramGenerationActivity | null;
  schematic: DiagramGenerationActivity | null;
}

export interface AilyChatDemandResource {
  type: 'file' | 'folder' | 'url' | 'block';
  name: string;
  path?: string;
  content?: string;
  blockId?: string;
  blockContext?: string;
}

export interface AilyChatDemandSessionRequest {
  kind: AilyChatDemandSessionKind;
  title: string;
  prompt: string;
  mode: 'agent' | 'ask';
  revealSession?: boolean;
  resources?: AilyChatDemandResource[];
}

export interface AilyChatDemandSessionResult {
  accepted: boolean;
  reason?: 'schematic-agent-running';
  sessionId?: string;
  state?: 'settled' | 'rejected' | 'failed';
  error?: string;
}

export type DemandSessionProgressType =
  | 'thinking'
  | 'complete'
  | 'error';

export interface SchematicGenerationOptions {
  revealSession?: boolean;
  title?: string;
}

const AILY_CHAT_TOOL_ID = DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID;
const AILY_CHAT_DEMAND_SESSION_CHANNEL = 'aily-chat-demand-session-v1';
const DEMAND_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const ARCHITECTURE_AGENT_PREFIX = '[AGENT: ArchitectureAgent]';
const SCHEMATIC_AGENT_PREFIX = '[AGENT: SchematicAgent]';
const DEFAULT_SCHEMATIC_PROMPT = '生成项目连线图';
const EMPTY_DIAGRAM_GENERATION_STATE: DiagramGenerationState = {
  architecture: null,
  schematic: null,
};

interface DemandSessionResponse {
  channel: typeof AILY_CHAT_DEMAND_SESSION_CHANNEL;
  type: 'response';
  requestId: string;
  result?: AilyChatDemandSessionResult;
}

interface DemandSessionEvent {
  channel: typeof AILY_CHAT_DEMAND_SESSION_CHANNEL;
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
export class AilyChatDemandSessionService {
  private readonly diagramGenerationStateSubject =
    new BehaviorSubject<DiagramGenerationState>(EMPTY_DIAGRAM_GENERATION_STATE);

  readonly diagramGenerationState$ = this.diagramGenerationStateSubject.asObservable();

  constructor(
    private projectService: ProjectService,
    private connectionGraphService: ConnectionGraphService,
    private electronService: ElectronService,
    private childToolProcess: ChildToolProcessService,
    private uiService: UiService,
  ) {
    this.setupConnectionGraphIpc();
    this.projectService.currentProjectPath$.subscribe(projectPath => {
      this.clearDiagramGenerationOutsideProject(projectPath);
    });
  }

  async createArchitectureSession(prompt: string, title = prompt): Promise<AilyChatDemandSessionResult> {
    return this.runDemandSession({
      kind: 'architecture',
      title,
      prompt: this.withAgentPrefix(prompt, ARCHITECTURE_AGENT_PREFIX),
      mode: 'agent',
      revealSession: true,
    });
  }

  async explainBlocks(
    prompt: string,
    resources: AilyChatDemandResource[],
    title = prompt,
  ): Promise<AilyChatDemandSessionResult> {
    return this.runDemandSession({
      kind: 'block-explain',
      title,
      prompt,
      mode: 'ask',
      revealSession: true,
      resources,
    });
  }

  async generateSchematic(
    prompt = DEFAULT_SCHEMATIC_PROMPT,
    options: SchematicGenerationOptions = {},
  ): Promise<void> {
    this.emitProgress('thinking', '正在分析项目...');
    try {
      const result = await this.runDemandSession({
        kind: 'schematic',
        title: options.title || prompt,
        prompt: this.withAgentPrefix(prompt, SCHEMATIC_AGENT_PREFIX),
        mode: 'agent',
        revealSession: options.revealSession === true,
      });
      if (result.accepted === false && result.reason === 'schematic-agent-running') {
        this.emitProgress('complete', '已有连线图 Agent 正在执行');
        return;
      }
      this.emitProgress('complete', '连线图生成完成');
    } catch (error) {
      const message = error instanceof Error ? error.message : '连线图生成失败';
      this.emitProgress('error', message);
      console.error('[AilyChatDemandSession] 连线图生成失败:', error);
    }
  }

  async syncSchematicToCode(prompt: string): Promise<AilyChatDemandSessionResult> {
    return this.runDemandSession({
      kind: 'code-sync',
      title: '同步连线图到代码',
      prompt,
      mode: 'agent',
      revealSession: true,
    });
  }

  async runDemandSession(
    request: AilyChatDemandSessionRequest,
  ): Promise<AilyChatDemandSessionResult> {
    const cwd = this.projectService.currentProjectPath;
    if (!cwd) {
      throw new Error('请先打开项目');
    }

    const requestId = crypto.randomUUID();
    const diagramKind = this.toDiagramGenerationKind(request.kind);
    if (diagramKind) {
      if (this.isDiagramGenerating(diagramKind)) {
        if (diagramKind === 'schematic') {
          return { accepted: false, reason: 'schematic-agent-running' };
        }
        const label = diagramKind === 'architecture' ? '框架图' : '连线图';
        throw new Error(`${label}正在生成，请等待当前任务结束`);
      }
      this.beginDiagramGeneration(diagramKind, requestId, cwd);
    }

    let runtimeAcquired = false;
    try {
      await this.childToolProcess.acquire(AILY_CHAT_TOOL_ID);
      runtimeAcquired = true;
      const result = await this.requestDemandSession(cwd, request, requestId, diagramKind);
      if (result.accepted === false && result.reason === 'schematic-agent-running') {
        return result;
      }
      if (result.accepted !== true || result.state !== 'settled') {
        throw new Error(result.error || 'Aily Chat 需求会话执行失败');
      }
      return result;
    } finally {
      if (diagramKind) {
        this.endDiagramGeneration(diagramKind, requestId);
      }
      if (runtimeAcquired) {
        await this.childToolProcess.release(AILY_CHAT_TOOL_ID);
      }
    }
  }

  private setupConnectionGraphIpc(): void {
    if (!this.electronService.isElectron || !window['ipcRenderer']) return;

    window['ipcRenderer'].on(
      'iframe-message-connection-graph',
      (_event: unknown, payload: { type?: string; data?: unknown }) => {
        if (payload?.type === 'generate-graph-data') {
          const request = (payload.data || {}) as {
            prompt?: unknown;
            revealSession?: unknown;
            title?: unknown;
          };
          const prompt = typeof request.prompt === 'string'
            ? request.prompt
            : DEFAULT_SCHEMATIC_PROMPT;
          void this.generateSchematic(prompt, {
            revealSession: request.revealSession === true,
            title: typeof request.title === 'string' ? request.title : undefined,
          });
          return;
        }
        if (payload?.type === 'generate-graph-code') {
          void this.handleSyncToCodeRequest();
        }
      },
    );
  }

  private async handleSyncToCodeRequest(): Promise<void> {
    const connectionData = this.connectionGraphService.getConnectionGraph();
    if (!connectionData) {
      console.warn('[AilyChatDemandSession] 同步到代码: 无连线图数据');
      return;
    }

    const componentSummary = (connectionData.components || [])
      .map((component: any) => `- ${component.title || component.refId || component.id}`)
      .join('\n');
    const prompt = `请根据当前连线图方案，将硬件连线配置同步到项目代码中。

## 当前连线组件
${componentSummary}

## 连线数量
${(connectionData.connections || []).length} 条连线

请分析连线图，在代码中添加或修改对应的传感器初始化和引脚配置代码。`;

    try {
      await this.syncSchematicToCode(prompt);
    } catch (error) {
      console.error('[AilyChatDemandSession] 同步到代码失败:', error);
    }
  }

  private requestDemandSession(
    cwd: string,
    request: AilyChatDemandSessionRequest,
    requestId: string,
    diagramKind: DiagramGenerationKind | null,
  ): Promise<AilyChatDemandSessionResult> {
    const revealSession = request.revealSession === true;

    return new Promise((resolve, reject) => {
      const removeListener = this.childToolProcess.onMessage(
        AILY_CHAT_TOOL_ID,
        (message) => {
          const response = message as unknown as DemandSessionResponse | DemandSessionEvent;
          if (
            response.channel !== AILY_CHAT_DEMAND_SESSION_CHANNEL ||
            response.requestId !== requestId
          ) {
            return;
          }

          if (response.type === 'event') {
            const sessionId = response.event?.type === 'session-created'
              ? String(response.event.sessionId || '').trim()
              : '';
            if (sessionId && diagramKind) {
              this.attachDiagramSession(diagramKind, requestId, sessionId);
            }
            if (sessionId && revealSession) {
              void this.uiService.openAilyChatSession(sessionId).then(
                opened => {
                  if (!opened) {
                    console.warn('[AilyChatDemandSession] 会话导航超时:', sessionId);
                  }
                },
                error => console.warn('[AilyChatDemandSession] 会话导航失败:', error),
              );
            }
            return;
          }

          clearTimeout(timeout);
          removeListener();
          if (response.result) resolve(response.result);
          else reject(new Error('Aily Chat Runtime 未返回需求会话结果'));
        },
      );
      const timeout = setTimeout(() => {
        removeListener();
        reject(new Error('Aily Chat 需求会话执行超时'));
      }, DEMAND_SESSION_TIMEOUT_MS);

      void this.childToolProcess
        .sendMessage(AILY_CHAT_TOOL_ID, {
          channel: AILY_CHAT_DEMAND_SESSION_CHANNEL,
          type: 'request',
          requestId,
          action: 'demand-session.run',
          kind: request.kind,
          cwd,
          title: request.title.trim(),
          prompt: request.prompt.trim(),
          mode: request.mode,
          revealSession,
          resources: request.resources || [],
        })
        .catch((error) => {
          clearTimeout(timeout);
          removeListener();
          reject(error);
        });
    });
  }

  isDiagramGenerating(kind: DiagramGenerationKind): boolean {
    const activity = this.diagramGenerationStateSubject.value[kind];
    return !!activity && this.isSameProjectPath(
      activity.projectPath,
      this.projectService.currentProjectPath,
    );
  }

  private clearDiagramGenerationOutsideProject(projectPath: string): void {
    const current = this.diagramGenerationStateSubject.value;
    const next: DiagramGenerationState = {
      architecture: current.architecture
        && this.isSameProjectPath(current.architecture.projectPath, projectPath)
        ? current.architecture
        : null,
      schematic: current.schematic
        && this.isSameProjectPath(current.schematic.projectPath, projectPath)
        ? current.schematic
        : null,
    };
    if (next.architecture !== current.architecture || next.schematic !== current.schematic) {
      this.diagramGenerationStateSubject.next(next);
    }
  }

  private isSameProjectPath(left: string, right: string): boolean {
    const normalize = (value: string) => String(value || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/u, '')
      .toLowerCase();
    return normalize(left) === normalize(right);
  }

  private toDiagramGenerationKind(
    kind: AilyChatDemandSessionKind,
  ): DiagramGenerationKind | null {
    return kind === 'architecture' || kind === 'schematic' ? kind : null;
  }

  private beginDiagramGeneration(
    kind: DiagramGenerationKind,
    requestId: string,
    projectPath: string,
  ): void {
    this.diagramGenerationStateSubject.next({
      ...this.diagramGenerationStateSubject.value,
      [kind]: {
        kind,
        requestId,
        projectPath,
        startedAt: Date.now(),
      },
    });
  }

  private attachDiagramSession(
    kind: DiagramGenerationKind,
    requestId: string,
    sessionId: string,
  ): void {
    const current = this.diagramGenerationStateSubject.value[kind];
    if (!current || current.requestId !== requestId) return;

    this.diagramGenerationStateSubject.next({
      ...this.diagramGenerationStateSubject.value,
      [kind]: { ...current, sessionId },
    });
  }

  private endDiagramGeneration(kind: DiagramGenerationKind, requestId: string): void {
    const current = this.diagramGenerationStateSubject.value[kind];
    if (!current || current.requestId !== requestId) return;

    this.diagramGenerationStateSubject.next({
      ...this.diagramGenerationStateSubject.value,
      [kind]: null,
    });
  }

  private withAgentPrefix(prompt: string, prefix: string): string {
    const normalized = String(prompt || '').trim();
    return normalized.startsWith(prefix) ? normalized : `${prefix} ${normalized}`;
  }

  private emitProgress(type: DemandSessionProgressType, content: string): void {
    this.connectionGraphService.emitNotice({
      title: 'AI生成中',
      text: content,
      state: type === 'thinking' ? 'doing' : type === 'complete' ? 'done' : 'error',
      ...(type === 'thinking'
        ? { showProgress: false }
        : { setTimeout: 3000 }),
    });
  }
}
