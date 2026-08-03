import { Injectable } from '@angular/core';
import { NzModalService } from 'ng-zorro-antd/modal';

import { ElectronService } from './electron.service';
import { ProjectService } from './project.service';
import { SceneCodeReconciliationProviderService } from './scene-code-reconciliation-provider.service';
import {
  createSimulatorSceneCodeReconciliationProductPort,
  type SimulatorSceneCodeApprovalDecision,
} from '../integrations/simulator/simulator-scene-code-reconciliation-product-port';
import type {
  SimulatorSceneCodeReconciliationPort,
  SimulatorSceneCodeReconciliationRequest,
  SimulatorSceneCodeReconciliationResult,
} from '../integrations/simulator/simulator-scene-code-reconciliation-coordinator';
import type {
  SceneCodeReconciliationCandidate,
} from '../tools/aily-chat/core/scene-code-reconciliation-invocation';
import { AbsAutoSyncService } from '../tools/aily-chat/services/abs-auto-sync.service';
import {
  runSyncAbsFileConcreteHandler,
} from '../tools/aily-chat/tools/syncAbsFileTool';

@Injectable({ providedIn: 'root' })
export class SimulatorSceneCodeReconciliationService
implements SimulatorSceneCodeReconciliationPort {
  private readonly port: SimulatorSceneCodeReconciliationPort;

  constructor(
    private readonly candidates: SceneCodeReconciliationProviderService,
    private readonly absSync: AbsAutoSyncService,
    private readonly project: ProjectService,
    private readonly electron: ElectronService,
    private readonly modal: NzModalService,
  ) {
    this.port = createSimulatorSceneCodeReconciliationProductPort({
      candidates: {
        request: (input, signal) =>
          this.candidates.request(input, signal),
      },
      approvals: {
        requestApproval: (request, candidate, signal) =>
          this.requestApproval(request, candidate, signal),
      },
      program: {
        readCurrentAbs: () => this.readCurrentAbs(),
        applyAbs: (content, request, approvalId, signal) =>
          this.applyAbs(content, request, approvalId, signal),
      },
    });
  }

  reconcile(
    request: SimulatorSceneCodeReconciliationRequest,
    signal: AbortSignal,
  ): Promise<SimulatorSceneCodeReconciliationResult> {
    return this.port.reconcile(request, signal);
  }

  private readCurrentAbs(): string {
    const content = this.absSync.getWorkspaceAbsContent();
    if (typeof content !== 'string' || content.trim().length < 1) {
      throw new Error('Current Blockly ABS program is unavailable.');
    }
    return content;
  }

  private async applyAbs(
    content: string,
    request: SimulatorSceneCodeReconciliationRequest,
    approvalId: string,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const result = await runSyncAbsFileConcreteHandler(
      {
        operation: 'import',
        pendingAbsContent: content,
      },
      this.project,
      this.electron,
      this.absSync,
      {
        sessionId: `simulator-reconciliation:${shortHash(request.requestId)}`,
        turnId: request.requestId,
        toolCallId: approvalId,
        signal,
      },
    );
    throwIfAborted(signal);
    if (result.is_error) {
      throw new Error(result.content || 'Approved ABS import failed.');
    }
  }

  private requestApproval(
    request: SimulatorSceneCodeReconciliationRequest,
    candidate: SceneCodeReconciliationCandidate,
    signal: AbortSignal,
  ): Promise<SimulatorSceneCodeApprovalDecision> {
    throwIfAborted(signal);
    const approvalId =
      `scene-approval:${shortHash(request.requestId)}:${Date.now().toString(36)}`;
    const change = describeCandidate(candidate);
    return new Promise<SimulatorSceneCodeApprovalDecision>(
      (resolve, reject) => {
        let settled = false;
        const finish = (decision: SimulatorSceneCodeApprovalDecision) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(decision);
        };
        const modalRef = this.modal.confirm({
          nzTitle: '确认同步连线语义到 Blockly',
          nzContent: [
            candidate.summary,
            '',
            `Scene: ${request.sceneId}`,
            `语义版本: ${request.graphSemanticRevision}`,
            change,
            '',
            '批准后 Host 才会原子导入完整 ABS；仿真器不会直接修改 Blockly。',
          ].join('\n'),
          nzOkText: candidate.outcome === 'applied'
            ? '批准并应用'
            : '批准并继续编译',
          nzCancelText: '拒绝',
          nzClosable: false,
          nzMaskClosable: false,
          nzOnOk: () => finish({ approved: true, approvalId }),
          nzOnCancel: () => finish({ approved: false, approvalId }),
        });
        const onAbort = () => {
          if (settled) return;
          settled = true;
          modalRef.destroy();
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      },
    );
  }
}

function describeCandidate(
  candidate: SceneCodeReconciliationCandidate,
): string {
  if (candidate.outcome === 'already-aligned') {
    return 'Agent 结论：当前 Blockly 程序已经与该 Scene 语义一致。';
  }
  const lineCount = candidate.candidateAbs?.replace(/\r\n?/gu, '\n')
    .split('\n').length ?? 0;
  return `Agent 候选：应用一份完整 ABS（${lineCount} 行）。`;
}

function shortHash(value: string): string {
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489917);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Scene code reconciliation was cancelled.');
}
