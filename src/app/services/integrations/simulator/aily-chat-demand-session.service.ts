/**
 * Creates visible demand sessions in the independently installed Aily Chat
 * runtime. Blockly supplies project context only; it does not execute agents.
 */

import { Injectable } from '@angular/core';
import { UiService } from '@core/app-shell/public-api';
import { ProjectService } from '@domain/project/public-api';
import { BehaviorSubject } from 'rxjs';
import {
  ChildToolProcessService,
  DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID,
} from '@integration/subapps/public-api';

export type AilyChatDemandSessionKind =
  | 'architecture'
  | 'project-scene'
  | 'block-explain'
  | 'code-sync';

export type DiagramGenerationKind = Extract<
  AilyChatDemandSessionKind,
  'architecture' | 'project-scene'
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
  projectScene: DiagramGenerationActivity | null;
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
  reason?: 'project-scene-agent-running';
  sessionId?: string;
  state?: 'settled' | 'rejected' | 'failed';
  error?: string;
}

export interface ProjectSceneGenerationOptions {
  revealSession?: boolean;
  title?: string;
}

const AILY_CHAT_TOOL_ID = DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID;
const AILY_CHAT_DEMAND_SESSION_CHANNEL = 'aily-chat-demand-session-v1';
const DEMAND_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const ARCHITECTURE_AGENT_PREFIX = '[AGENT: ArchitectureAgent]';
const PROJECT_SCENE_AGENT_PREFIX = '[AGENT: ProjectSceneAgent]';
const DEFAULT_PROJECT_SCENE_PROMPT = '根据当前项目生成仿真连线场景';
const EMPTY_DIAGRAM_GENERATION_STATE: DiagramGenerationState = {
  architecture: null,
  projectScene: null,
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

@Injectable({ providedIn: 'root' })
export class AilyChatDemandSessionService {
  private readonly diagramGenerationStateSubject =
    new BehaviorSubject<DiagramGenerationState>(EMPTY_DIAGRAM_GENERATION_STATE);

  readonly diagramGenerationState$ = this.diagramGenerationStateSubject.asObservable();

  constructor(
    private readonly projectService: ProjectService,
    private readonly childToolProcess: ChildToolProcessService,
    private readonly uiService: UiService,
  ) {
    this.projectService.currentProjectPath$.subscribe(projectPath => {
      this.clearDiagramGenerationOutsideProject(projectPath);
    });
  }

  createArchitectureSession(
    prompt: string,
    title = prompt,
  ): Promise<AilyChatDemandSessionResult> {
    return this.runDemandSession({
      kind: 'architecture',
      title,
      prompt: this.withAgentPrefix(prompt, ARCHITECTURE_AGENT_PREFIX),
      mode: 'agent',
      revealSession: true,
    });
  }

  explainBlocks(
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

  generateProjectScene(
    prompt = DEFAULT_PROJECT_SCENE_PROMPT,
    options: ProjectSceneGenerationOptions = {},
    signal?: AbortSignal,
  ): Promise<AilyChatDemandSessionResult> {
    return this.runDemandSession({
      kind: 'project-scene',
      title: options.title || prompt,
      prompt: this.withAgentPrefix(prompt, PROJECT_SCENE_AGENT_PREFIX),
      mode: 'agent',
      revealSession: options.revealSession !== false,
    }, signal);
  }

  requestCodeSync(
    prompt: string,
    title = '同步仿真连线场景到代码',
    resources: AilyChatDemandResource[] = [],
    signal?: AbortSignal,
  ): Promise<AilyChatDemandSessionResult> {
    return this.runDemandSession({
      kind: 'code-sync',
      title,
      prompt,
      mode: 'agent',
      revealSession: true,
      resources,
    }, signal);
  }

  async runDemandSession(
    request: AilyChatDemandSessionRequest,
    signal?: AbortSignal,
  ): Promise<AilyChatDemandSessionResult> {
    throwIfAborted(signal);
    const cwd = this.projectService.currentProjectPath;
    if (!cwd) throw new Error('请先打开项目');

    const requestId = crypto.randomUUID();
    const diagramKind = this.toDiagramGenerationKind(request.kind);
    if (diagramKind) {
      if (this.isDiagramGenerating(diagramKind)) {
        if (diagramKind === 'project-scene') {
          return { accepted: false, reason: 'project-scene-agent-running' };
        }
        throw new Error('框架图正在生成，请等待当前任务结束');
      }
      this.beginDiagramGeneration(diagramKind, requestId, cwd);
    }

    let runtimeAcquired = false;
    try {
      await this.childToolProcess.acquire(AILY_CHAT_TOOL_ID);
      runtimeAcquired = true;
      throwIfAborted(signal);
      const result = await this.requestDemandSession(
        cwd,
        request,
        requestId,
        diagramKind,
        signal,
      );
      if (
        result.accepted === false
        && result.reason === 'project-scene-agent-running'
      ) {
        return result;
      }
      if (result.accepted !== true || result.state !== 'settled') {
        throw new Error(result.error || 'Aily Chat 需求会话执行失败');
      }
      return result;
    } finally {
      if (diagramKind) this.endDiagramGeneration(diagramKind, requestId);
      if (runtimeAcquired) await this.childToolProcess.release(AILY_CHAT_TOOL_ID);
    }
  }

  isDiagramGenerating(kind: DiagramGenerationKind): boolean {
    const activity = this.readDiagramActivity(kind);
    return !!activity && this.isSameProjectPath(
      activity.projectPath,
      this.projectService.currentProjectPath,
    );
  }

  private requestDemandSession(
    cwd: string,
    request: AilyChatDemandSessionRequest,
    requestId: string,
    diagramKind: DiagramGenerationKind | null,
    signal?: AbortSignal,
  ): Promise<AilyChatDemandSessionResult> {
    const revealSession = request.revealSession === true;

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        removeListener();
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(abortReason(signal)));
      const removeListener = this.childToolProcess.onMessage(
        AILY_CHAT_TOOL_ID,
        message => {
          const response = message as unknown as DemandSessionResponse | DemandSessionEvent;
          if (
            response.channel !== AILY_CHAT_DEMAND_SESSION_CHANNEL
            || response.requestId !== requestId
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

          finish(() => {
            if (response.result) resolve(response.result);
            else reject(new Error('Aily Chat Runtime 未返回需求会话结果'));
          });
        },
      );
      timeout = setTimeout(() => {
        finish(() => reject(new Error('Aily Chat 需求会话执行超时')));
      }, DEMAND_SESSION_TIMEOUT_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      void this.childToolProcess.sendMessage(AILY_CHAT_TOOL_ID, {
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
      }).catch(error => finish(() => reject(error)));
    });
  }

  private clearDiagramGenerationOutsideProject(projectPath: string): void {
    const current = this.diagramGenerationStateSubject.value;
    const keep = (activity: DiagramGenerationActivity | null) => (
      activity && this.isSameProjectPath(activity.projectPath, projectPath)
        ? activity
        : null
    );
    const next: DiagramGenerationState = {
      architecture: keep(current.architecture),
      projectScene: keep(current.projectScene),
    };
    if (
      next.architecture !== current.architecture
      || next.projectScene !== current.projectScene
    ) {
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
    return kind === 'architecture' || kind === 'project-scene' ? kind : null;
  }

  private readDiagramActivity(
    kind: DiagramGenerationKind,
  ): DiagramGenerationActivity | null {
    return kind === 'architecture'
      ? this.diagramGenerationStateSubject.value.architecture
      : this.diagramGenerationStateSubject.value.projectScene;
  }

  private writeDiagramActivity(
    kind: DiagramGenerationKind,
    activity: DiagramGenerationActivity | null,
  ): void {
    const current = this.diagramGenerationStateSubject.value;
    this.diagramGenerationStateSubject.next(kind === 'architecture'
      ? { ...current, architecture: activity }
      : { ...current, projectScene: activity });
  }

  private beginDiagramGeneration(
    kind: DiagramGenerationKind,
    requestId: string,
    projectPath: string,
  ): void {
    this.writeDiagramActivity(kind, {
      kind,
      requestId,
      projectPath,
      startedAt: Date.now(),
    });
  }

  private attachDiagramSession(
    kind: DiagramGenerationKind,
    requestId: string,
    sessionId: string,
  ): void {
    const current = this.readDiagramActivity(kind);
    if (!current || current.requestId !== requestId) return;
    this.writeDiagramActivity(kind, { ...current, sessionId });
  }

  private endDiagramGeneration(kind: DiagramGenerationKind, requestId: string): void {
    const current = this.readDiagramActivity(kind);
    if (!current || current.requestId !== requestId) return;
    this.writeDiagramActivity(kind, null);
  }

  private withAgentPrefix(prompt: string, prefix: string): string {
    const normalized = String(prompt || '').trim();
    return normalized.startsWith(prefix) ? normalized : `${prefix} ${normalized}`;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('Aily Chat 需求会话已取消');
}
