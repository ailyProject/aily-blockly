import { Injectable } from '@angular/core';
import { NzModalService } from 'ng-zorro-antd/modal';
import type {
  ProjectSceneGenerationRequestV1,
  SimulatorSubappHostAgentSceneProposalDecisionV1,
} from '@aily-project/simulator-host-sdk';

import type {
  SimulatorAgentSceneApprovalPort,
} from '../integrations/simulator/simulator-blockly-agent-callback-authority';

type AgentSceneProposal = NonNullable<
  SimulatorSubappHostAgentSceneProposalDecisionV1['proposal']
>;

/** Product-owned user decision for one native Scene proposal. */
@Injectable({ providedIn: 'root' })
export class SimulatorAgentSceneApprovalService
implements SimulatorAgentSceneApprovalPort {
  constructor(private readonly modal: NzModalService) {}

  requestApproval(
    request: ProjectSceneGenerationRequestV1,
    proposal: AgentSceneProposal,
    signal: AbortSignal,
  ): Promise<Readonly<{ approved: boolean; approvalId: string }>> {
    throwIfAborted(signal);
    const approvalId = [
      'scene-agent-approval',
      shortHash(request.requestId),
      Date.now().toString(36),
    ].join(':');
    const componentCount = proposal.componentMutations.length;
    const connectionCount = proposal.batch?.commands.length ?? 0;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(Object.freeze({ approved, approvalId }));
      };
      const modalRef = this.modal.confirm({
        nzTitle: '确认应用仿真连线方案',
        nzContent: [
          proposal.summary,
          '',
          `Scene：${request.sceneId}`,
          `元件变更：${componentCount}`,
          `连线命令：${connectionCount}`,
          '',
          '批准后，仿真器会通过 Project Scene 的版本控制接口应用此候选方案。Agent 不会直接修改文件或控制仿真进程。',
        ].join('\n'),
        nzOkText: '批准并应用',
        nzCancelText: '拒绝',
        nzClosable: false,
        nzMaskClosable: false,
        nzOnOk: () => finish(true),
        nzOnCancel: () => finish(false),
      });
      const onAbort = () => {
        if (settled) return;
        settled = true;
        modalRef.destroy();
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
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
    : new Error('Agent Scene approval was cancelled.');
}
