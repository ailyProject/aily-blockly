import type { StatePart } from '../core/chat-parts';
import type { PartEventProcessor } from '../core/part-event-processor';

export type LexStatePartProcessor = Pick<
  PartEventProcessor,
  'upsertState'
>;

type LexStateHostSyncAccess = {
  applyHandoffEvent(event: { targetAgent?: string; targetModeId?: string; reason?: string }): void;
};

export class LexStateEventBridge {
  constructor(
    private readonly partProcessor: LexStatePartProcessor,
    private readonly hostSyncBridge?: LexStateHostSyncAccess,
  ) {}

  processEvent(event: any): boolean {
    switch (event.type) {
      case 'background_task':
        this.upsertBackgroundTaskState(event);
        return true;

      case 'task_graph':
        this.upsertTaskGraphState(event);
        return true;

      case 'task_scheduler':
        this.upsertTaskSchedulerState(event);
        return true;

      case 'task_autonomy':
        this.upsertTaskAutonomyState(event);
        return true;

      case 'agent_team':
        this.upsertAgentTeamState(event);
        return true;

      case 'mcp_state':
        this.upsertMcpState(event);
        return true;

      case 'instruction_state':
        this.upsertInstructionState(event);
        return true;

      case 'handoff':
        this.upsertHandoffState(event);
        return true;

      default:
        return false;
    }
  }

  private upsertHandoffState(event: any): void {
    const targetAgent = typeof event.targetAgent === 'string' && event.targetAgent.trim().length > 0
      ? event.targetAgent.trim()
      : '';
    const targetModeId = typeof event.targetModeId === 'string' && event.targetModeId.trim().length > 0
      ? event.targetModeId.trim().toLowerCase()
      : '';
    const targetLabel = targetAgent || (targetModeId ? `${targetModeId} 模式` : '未知代理');
    let text = `代理请求切换到 ${targetLabel}`;
    if (typeof event.reason === 'string' && event.reason.trim().length > 0) {
      text += ` - ${this.summarizeText(event.reason, 80)}`;
    }

    this.partProcessor.upsertState(
      `handoff:${event.handoffId || targetAgent}`,
      text,
      'info',
      {
        kind: 'handoff',
        metadata: {
          handoffId: event.handoffId,
          ...(targetAgent ? { targetAgent } : {}),
          ...(targetModeId ? { targetModeId } : {}),
          reason: event.reason,
        },
      },
    );

    this.hostSyncBridge?.applyHandoffEvent({
      ...(targetAgent ? { targetAgent } : {}),
      ...(targetModeId ? { targetModeId } : {}),
      reason: typeof event.reason === 'string' ? event.reason : undefined,
    });
  }

  private upsertInstructionState(event: any): void {
    this.partProcessor.upsertState(
      event.stateId,
      event.summary,
      event.state,
      {
        kind: 'instructions',
        metadata: {
          ...event.snapshot,
          summary: event.summary,
        },
      },
    );
  }

  private upsertMcpState(event: any): void {
    this.partProcessor.upsertState(
      event.stateId,
      event.summary,
      event.state,
      {
        kind: 'mcp',
        progress: event.progress,
        metadata: event.snapshot,
      },
    );
  }

  private upsertBackgroundTaskState(event: any): void {
    const stateId = `background-task:${event.taskId}`;
    const summary = typeof event.summary === 'string' && event.summary.trim().length > 0
      ? event.summary.trim()
      : undefined;
    let text = `后台任务 ${event.description || event.taskId}`;

    switch (event.status) {
      case 'running':
        text += ' 运行中';
        if (typeof event.progress === 'number') {
          text += ` (${Math.round(event.progress)}%)`;
        }
        if (summary) {
          text += ` - ${this.summarizeText(summary, 60)}`;
        }
        break;
      case 'completed':
        text += ' 已完成';
        break;
      case 'cancelled':
        text += ' 已取消';
        break;
      case 'failed':
      default:
        text += ' 失败';
        break;
    }

    if (event.error) {
      text += ` - ${this.summarizeText(event.error, 60)}`;
    } else if (event.output && event.status === 'completed') {
      text += ` - ${this.summarizeText(event.output, 60)}`;
    }

    this.partProcessor.upsertState(
      stateId,
      text,
      this.mapBackgroundTaskState(event),
      {
        kind: 'background_task',
        progress: typeof event.progress === 'number' ? event.progress : undefined,
        metadata: {
          taskId: event.taskId,
          status: event.status,
          description: event.description,
          agentName: event.agentName,
          summary,
          progress: typeof event.progress === 'number' ? event.progress : undefined,
          startedAt: event.startedAt,
          completedAt: event.completedAt,
          output: event.output ? this.summarizeText(event.output, 120) : undefined,
          error: event.error,
        },
      },
    );
  }

  private upsertTaskGraphState(event: any): void {
    const nodes = Array.isArray(event.snapshot?.nodes) ? event.snapshot.nodes : [];
    const totalNodes = nodes.length;
    const completedNodes = nodes.filter((node: any) => node.status === 'completed').length;
    const failedNodes = nodes.filter((node: any) => node.status === 'failed').length;
    const finishedNodes = nodes.filter((node: any) => node.status === 'completed' || node.status === 'failed').length;
    const statusCounts = this.collectTaskGraphStatusCounts(nodes);
    const progress = totalNodes > 0 ? Math.round((finishedNodes / totalNodes) * 100) : undefined;
    const stateId = event.nodeId
      ? `task-graph:${event.runId}:node:${event.nodeId}`
      : `task-graph:${event.runId}`;
    const graphLabel = event.description || event.graphId || event.runId;
    const currentNode = event.nodeId
      ? nodes.find((node: any) => node.nodeId === event.nodeId)
      : undefined;

    let text = `任务图 ${graphLabel}`;
    if (event.nodeId) {
      text += `: 节点 ${event.nodeId} ${this.formatTaskGraphNodeStatus(event.nodeStatus)}`;
    } else {
      text += ` ${this.formatTaskGraphStatus(event.status)}`;
    }
    if (totalNodes > 0) {
      text += ` (${completedNodes}/${totalNodes})`;
    }
    if (event.error) {
      text += ` - ${this.summarizeText(event.error, 60)}`;
    } else if (event.output && (event.status === 'completed' || event.nodeStatus === 'completed')) {
      text += ` - ${this.summarizeText(event.output, 60)}`;
    }

    this.partProcessor.upsertState(
      stateId,
      text,
      this.mapTaskGraphState(event.status, event.nodeStatus, Boolean(event.error)),
      {
        kind: 'task_graph',
        progress,
        metadata: {
          runId: event.runId,
          graphId: event.graphId,
          status: event.status,
          nodeId: event.nodeId,
          taskId: event.taskId,
          nodeStatus: event.nodeStatus,
          totalNodes,
          completedNodes,
          failedNodes,
          runningNodes: statusCounts['running'],
          blockedNodes: statusCounts['blocked'],
          pendingNodes: statusCounts['pending'],
          readyNodes: statusCounts['ready'],
          currentNode: currentNode ? this.toTaskGraphNodeSummary(currentNode) : undefined,
          nodeHighlights: this.buildTaskGraphNodeHighlights(nodes, currentNode?.nodeId || event.nodeId),
        },
      },
    );
  }

  private upsertTaskSchedulerState(event: any): void {
    const stateId = event.scheduleId ? `task-scheduler:${event.scheduleId}` : 'task-scheduler:service';
    const targetLabel = event.description || event.scheduleId || '任务调度器';
    let text = '';

    switch (event.phase) {
      case 'started':
        text = '任务调度器已启动';
        break;
      case 'stopped':
        text = '任务调度器已停止';
        break;
      case 'triggered':
        text = `调度 ${targetLabel} 已触发`;
        if (event.launchKind === 'graph' && event.graphRunId) {
          text += ` -> 图 ${event.graphRunId}`;
        } else if (event.launchKind === 'task' && event.taskId) {
          text += ` -> 任务 ${event.taskId}`;
        }
        break;
      case 'trigger_failed':
        text = `调度 ${targetLabel} 触发失败`;
        break;
      case 'skipped':
        text = `调度 ${targetLabel} 已跳过`;
        break;
      default:
        text = `调度 ${targetLabel} 状态更新`;
        break;
    }

    if (event.triggerReason && event.phase !== 'started' && event.phase !== 'stopped') {
      text += ` (${this.formatTriggerReason(event.triggerReason)})`;
    }
    if (event.error) {
      text += ` - ${this.summarizeText(event.error, 60)}`;
    } else if (event.resultText) {
      text += ` - ${this.summarizeText(event.resultText, 60)}`;
    }

    this.partProcessor.upsertState(
      stateId,
      text,
      this.mapTaskSchedulerState(event),
      {
        kind: 'task_scheduler',
        metadata: {
          phase: event.phase,
          schedulerStatus: event.schedulerStatus,
          scheduleId: event.scheduleId,
          triggerKind: event.triggerKind,
          triggerReason: event.triggerReason,
          launchKind: event.launchKind,
          launchMode: event.launchMode,
          taskId: event.taskId,
          graphRunId: event.graphRunId,
          scheduleCount: Array.isArray(event.snapshot?.schedules) ? event.snapshot.schedules.length : 0,
        },
      },
    );
  }

  private upsertTaskAutonomyState(event: any): void {
    let text = '';
    switch (event.phase) {
      case 'enabled':
        text = '任务自治已启用';
        break;
      case 'stopped':
        text = '任务自治已停止';
        if (event.reason) {
          text += `: ${this.formatAutonomyReason(event.reason)}`;
        }
        break;
      case 'failure_recorded':
        text = '任务自治记录失败';
        break;
      case 'success_recorded':
        text = '任务自治记录成功';
        break;
      default:
        text = '任务自治状态更新';
        break;
    }

    const failureCount = event.snapshot?.consecutiveFailures;
    const maxFailures = event.snapshot?.maxConsecutiveFailures;
    if (event.phase === 'failure_recorded' && typeof failureCount === 'number' && typeof maxFailures === 'number') {
      text += ` (${failureCount}/${maxFailures})`;
    }
    if (event.error) {
      text += ` - ${this.summarizeText(event.error, 60)}`;
    }

    this.partProcessor.upsertState(
      'task-autonomy:policy',
      text,
      this.mapTaskAutonomyState(event),
      {
        kind: 'task_autonomy',
        metadata: {
          phase: event.phase,
          status: event.status,
          reason: event.reason,
          scheduleId: event.scheduleId,
          taskId: event.taskId,
          graphRunId: event.graphRunId,
          consecutiveFailures: failureCount,
          maxConsecutiveFailures: maxFailures,
        },
      },
    );
  }

  private upsertAgentTeamState(event: any): void {
    const roleCount = Array.isArray(event.snapshot?.roles) ? event.snapshot.roles.length : 0;
    const messageCount = Array.isArray(event.snapshot?.messages) ? event.snapshot.messages.length : 0;
    let text = '';

    switch (event.phase) {
      case 'started':
        text = `协作团队 ${event.teamId} 已启动`;
        if (roleCount > 0) {
          text += ` (${roleCount} 角色)`;
        }
        break;
      case 'message': {
        const route = event.message
          ? `${event.message.fromRoleId} -> ${event.message.toRoleId}`
          : '协议消息';
        text = `协作团队 ${event.teamId}: ${route}`;
        if (event.message?.content) {
          text += ` - ${this.summarizeText(event.message.content, 48)}`;
        }
        break;
      }
      case 'completed':
        text = `协作团队 ${event.teamId} 已完成`;
        if (messageCount > 0) {
          text += ` (${messageCount} 条消息)`;
        }
        break;
      case 'failed':
        text = `协作团队 ${event.teamId} 失败`;
        break;
      default:
        text = `协作团队 ${event.teamId} 状态更新`;
        break;
    }

    if (event.error) {
      text += ` - ${this.summarizeText(event.error, 60)}`;
    }

    this.partProcessor.upsertState(
      `agent-team:${event.runId}`,
      text,
      this.mapAgentTeamState(event),
      {
        kind: 'agent_team',
        metadata: {
          phase: event.phase,
          teamId: event.teamId,
          runId: event.runId,
          graphId: event.graphId,
          graphRunId: event.graphRunId,
          status: event.status,
          roleCount,
          messageCount,
          fromRoleId: event.message?.fromRoleId,
          toRoleId: event.message?.toRoleId,
          nodeId: event.message?.nodeId,
          roles: this.buildAgentTeamRoleSummaries(event.snapshot?.roles),
          recentMessages: this.buildAgentTeamMessageSummaries(event),
        },
      },
    );
  }

  private collectTaskGraphStatusCounts(nodes: any[]): Record<string, number> {
    const counts: Record<string, number> = {
      pending: 0,
      ready: 0,
      running: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
    };

    for (const node of nodes) {
      const status = typeof node?.status === 'string' ? node.status : '';
      if (status in counts) {
        counts[status] += 1;
      }
    }

    return counts;
  }

  private buildTaskGraphNodeHighlights(nodes: any[], focusNodeId?: string): Array<Record<string, unknown>> {
    const picked = new Map<string, Record<string, unknown>>();
    const addNode = (node: any) => {
      if (!node || typeof node.nodeId !== 'string' || picked.has(node.nodeId)) {
        return;
      }
      picked.set(node.nodeId, this.toTaskGraphNodeSummary(node));
    };

    if (focusNodeId) {
      addNode(nodes.find((node: any) => node.nodeId === focusNodeId));
    }

    for (const status of ['failed', 'running', 'blocked', 'ready', 'pending']) {
      for (const node of nodes) {
        if (node?.status === status) {
          addNode(node);
          if (picked.size >= 6) {
            return Array.from(picked.values());
          }
        }
      }
    }

    if (picked.size === 0) {
      for (const node of nodes) {
        if (node?.status === 'completed') {
          addNode(node);
          if (picked.size >= 3) {
            break;
          }
        }
      }
    }

    return Array.from(picked.values());
  }

  private toTaskGraphNodeSummary(node: any): Record<string, unknown> {
    return {
      nodeId: node.nodeId,
      taskId: node.taskId,
      description: node.description,
      status: node.status,
      attempts: node.attempts,
      executionMode: node.executionMode,
      note: node.error
        ? this.summarizeText(node.error, 72)
        : this.summarizeText(node.output, 72),
    };
  }

  private buildAgentTeamRoleSummaries(roles: any): Array<Record<string, unknown>> {
    if (!Array.isArray(roles)) {
      return [];
    }

    return roles.map((role: any) => ({
      roleId: role.roleId,
      description: role.description,
      agentType: role.agentType,
      status: role.status,
      assignedCount: Array.isArray(role.assignedNodeIds) ? role.assignedNodeIds.length : 0,
      runningCount: Array.isArray(role.runningNodeIds) ? role.runningNodeIds.length : 0,
      completedCount: Array.isArray(role.completedNodeIds) ? role.completedNodeIds.length : 0,
      failedCount: Array.isArray(role.failedNodeIds) ? role.failedNodeIds.length : 0,
    }));
  }

  private buildAgentTeamMessageSummaries(event: any): Array<Record<string, unknown>> {
    const messages = Array.isArray(event.snapshot?.messages)
      ? event.snapshot.messages.slice(-3)
      : [];

    if (messages.length > 0) {
      return messages.map((message: any) => ({
        messageId: message.messageId,
        fromRoleId: message.fromRoleId,
        toRoleId: message.toRoleId,
        trigger: message.trigger,
        nodeId: message.nodeId,
        content: this.summarizeText(message.content, 88),
        timestamp: message.timestamp,
      }));
    }

    if (event.message) {
      return [{
        messageId: event.message.messageId,
        fromRoleId: event.message.fromRoleId,
        toRoleId: event.message.toRoleId,
        trigger: event.message.trigger,
        nodeId: event.message.nodeId,
        content: this.summarizeText(event.message.content, 88),
        timestamp: event.message.timestamp,
      }];
    }

    return [];
  }

  private mapTaskGraphState(status: string, nodeStatus: string | undefined, hasError: boolean): StatePart['state'] {
    if (hasError || status === 'failed' || nodeStatus === 'failed') return 'error';
    if (nodeStatus === 'blocked') return 'warn';
    if (status === 'completed' || nodeStatus === 'completed') return 'done';
    if (status === 'running' || nodeStatus === 'running' || nodeStatus === 'ready' || nodeStatus === 'pending') return 'doing';
    return 'info';
  }

  private mapTaskSchedulerState(event: any): StatePart['state'] {
    if (event.error || event.phase === 'trigger_failed') return 'error';
    if (event.phase === 'skipped') return 'warn';
    if (event.phase === 'triggered') {
      return event.launchMode === 'async' ? 'doing' : 'done';
    }
    return 'info';
  }

  private mapTaskAutonomyState(event: any): StatePart['state'] {
    if (event.error) return 'error';
    if (event.phase === 'failure_recorded') return 'warn';
    if (event.phase === 'success_recorded') return 'done';
    if (event.phase === 'stopped') return event.reason === 'manual_stop' ? 'info' : 'warn';
    return 'info';
  }

  private mapAgentTeamState(event: any): StatePart['state'] {
    if (event.error || event.phase === 'failed' || event.status === 'failed') return 'error';
    if (event.phase === 'completed' || event.status === 'completed') return 'done';
    return 'doing';
  }

  private mapBackgroundTaskState(event: any): StatePart['state'] {
    if (event.status === 'failed') return 'error';
    if (event.status === 'cancelled') return 'warn';
    if (event.status === 'completed') return 'done';
    return 'doing';
  }

  private formatTaskGraphStatus(status: string): string {
    const labels: Record<string, string> = {
      running: '运行中',
      completed: '已完成',
      failed: '失败',
    };
    return labels[status] || status;
  }

  private formatTaskGraphNodeStatus(status?: string): string {
    const labels: Record<string, string> = {
      pending: '等待中',
      ready: '就绪',
      running: '运行中',
      completed: '已完成',
      failed: '失败',
      blocked: '已阻塞',
    };
    return labels[status || ''] || (status || '状态更新');
  }

  private formatTriggerReason(reason: string): string {
    const labels: Record<string, string> = {
      interval: '定时触发',
      manual: '手动触发',
    };
    return labels[reason] || reason;
  }

  private formatAutonomyReason(reason: string): string {
    const labels: Record<string, string> = {
      manual_stop: '手动停止',
      schedule_failure: '调度失败',
      background_task_failure: '后台任务失败',
      graph_failure: '任务图失败',
      max_consecutive_failures: '连续失败超限',
    };
    return labels[reason] || reason;
  }

  private summarizeText(value: string | undefined, maxLength = 48): string {
    if (!value) return '';
    const condensed = value.replace(/\s+/g, ' ').trim();
    if (condensed.length <= maxLength) return condensed;
    return `${condensed.slice(0, maxLength - 1)}…`;
  }
}
