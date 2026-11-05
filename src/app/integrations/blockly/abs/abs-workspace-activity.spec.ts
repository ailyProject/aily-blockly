import { fakeAsync, tick } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import { BlocklyWorkspaceEditGate, BlocklyWorkspaceRecoveryGrant } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';

describe('workspace execution and protected recovery activity', () => {
  let service: BlocklyService, internal: any, gate: BlocklyWorkspaceEditGate, root: HTMLDivElement;
  beforeEach(() => {
    service = Object.create(BlocklyService.prototype); internal = service;
    root = document.createElement('div'); document.body.append(root);
    const recovery = new BehaviorSubject(false);
    gate = new BlocklyWorkspaceEditGate(required => recovery.next(required));
    Object.assign(internal, { workspaceEditGate: gate, workspaceRecoveryRequiredSubject: recovery,
      _workspace: { getParentSvg: () => ({ parentElement: root }), cancelCurrentGesture() {}, hideChaff() {} },
      _aiWriting: new BehaviorSubject(false), aiWritingSources: new Set(),
      _aiWaitWriting: new BehaviorSubject(false), _aiExecutionActive: new BehaviorSubject(false),
      aiExecutionActiveSources: new Set(), aiWaitWritingGeneration: 0 });
  });
  afterEach(() => { service.clearAiWaitWriting(); internal.releaseWorkspaceInputFence?.(); root.remove(); });
  const click = () => root.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  it('ends a failed writer activity while retaining its fence and grant-bound recovery', () => {
    const changes: boolean[] = []; internal.workspaceRecoveryRequiredSubject.subscribe(value => changes.push(value));
    const lease = service.acquireWorkspaceEditLease();
    expect(service.aiWriting).toBeTrue(); expect(click()).toBeFalse();
    const grant = lease.quarantine('native readback failed') as BlocklyWorkspaceRecoveryGrant;
    lease.release();
    expect(service.aiWriting).toBeFalse(); expect(service.isWorkspaceEditInProgress()).toBeFalse();
    expect(service.isWorkspaceRecoveryRequired()).toBeTrue(); expect(service.isWorkspaceEditBlocked()).toBeTrue();
    service.clearAiWaitWriting(); expect(click()).toBeFalse();
    const recovery = service.acquireWorkspaceRecoveryLease(grant);
    expect(service.aiWriting).toBeTrue(); recovery.release();
    expect(service.aiWriting).toBeFalse(); expect(click()).toBeFalse();
    expect(service.isWorkspaceRecoveryRequired()).toBeTrue();
    const completed = service.acquireWorkspaceRecoveryLease(grant);
    completed.completeRecovery(); completed.release();
    expect(service.aiWriting).toBeFalse(); expect(service.isWorkspaceRecoveryRequired()).toBeFalse();
    expect(service.isWorkspaceEditBlocked()).toBeFalse(); expect(click()).toBeTrue();
    expect(changes).toEqual([false, true, false]);
  });

  it('does not clear another activity source or a replacement lease when an old writer releases', () => {
    service.setAiWritingActive('other-operation', true);
    const old = service.acquireWorkspaceEditLease(); gate.reset();
    const current = service.acquireWorkspaceEditLease();
    old.release(); service.setAiWritingActive('other-operation', false);
    expect(service.aiWriting).toBeTrue(); expect(click()).toBeFalse();
    current.release(); expect(service.aiWriting).toBeFalse(); expect(click()).toBeTrue();
  });

  it('expires the short hint while a real writer independently keeps its activity', fakeAsync(() => {
    service.aiWaiting = true; expect(service.checkAiWaiting()).toBeTrue();
    tick(1000); const lease = service.acquireWorkspaceEditLease();
    tick(1000); expect(service.aiWaitWriting).toBeFalse(); expect(service.aiWriting).toBeTrue();
    lease.release(); expect(service.aiWriting).toBeFalse();
  }));

  it('clears only the old hint deadline when stopped and started again', fakeAsync(() => {
    service.aiWaiting = true; service.checkAiWaiting(); tick(1500);
    service.clearAiWaitWriting(); expect(service.aiWaitWriting).toBeFalse();
    service.checkAiWaiting(); tick(500); expect(service.aiWaitWriting).toBeTrue();
    tick(1500); expect(service.aiWaitWriting).toBeFalse();
    service.checkAiWaiting(); service.clearAiWaitWriting(); tick(3000);
    expect(service.aiWaitWriting).toBeFalse();
  }));
});
