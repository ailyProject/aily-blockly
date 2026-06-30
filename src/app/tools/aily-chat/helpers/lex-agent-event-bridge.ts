import type { IAgentLifecycle, IChatServiceAccess } from '../core/chat-context';
import {
  type LexRuntimeEventContext,
  LexRuntimeEventBridge,
  type LexRuntimeHostSyncAccess,
  type LexRuntimePartProcessor,
} from './lex-runtime-event-bridge';
import type { LexHostSyncBridge } from './lex-host-sync-bridge';
import { LexSessionDiagnosticsEventBridge } from './lex-session-diagnostics-event-bridge';
import { LexStateEventBridge, type LexStatePartProcessor } from './lex-state-event-bridge';

export type LexAgentPartProcessor = LexStatePartProcessor & LexRuntimePartProcessor;
export type LexAgentHostSyncAccess = LexRuntimeHostSyncAccess & Pick<LexHostSyncBridge, 'applyHandoffEvent' | 'getCompactionMetricsSnapshot'>;
type LexAgentLifecycleAccess = {
  ensureResponseItem(): void;
  closeNativeThinking(): void;
  startNativeThinking(): void;
};

type LexAgentStateEventBridge = Pick<
  LexStateEventBridge,
  'processEvent'
>;

type LexAgentRuntimeEventBridge = Pick<
  LexRuntimeEventBridge,
  'processEvent'
>;

type LexAgentSessionDiagnosticsBridge = Pick<
  LexSessionDiagnosticsEventBridge,
  'processEvent'
>;

/**
 * Handles AgentEvent -> blockly UI/runtime bridge updates for the lex stream path.
 */
export class LexAgentEventBridge {
  private readonly stateEventBridge: LexAgentStateEventBridge;
  private readonly runtimeEventBridge: LexAgentRuntimeEventBridge;
  private readonly sessionDiagnosticsEventBridge: LexAgentSessionDiagnosticsBridge;
  private readonly messageLifecycleBridge: Pick<LexAgentLifecycleAccess, 'ensureResponseItem'>;

  constructor(
    ctx: LexRuntimeEventContext,
    partProcessor: LexAgentPartProcessor,
    hostSyncBridge: LexAgentHostSyncAccess,
    messageLifecycleBridge: LexAgentLifecycleAccess,
  ) {
    this.messageLifecycleBridge = messageLifecycleBridge;
    this.stateEventBridge = new LexStateEventBridge(partProcessor, hostSyncBridge);
    this.runtimeEventBridge = new LexRuntimeEventBridge(ctx, partProcessor, hostSyncBridge, messageLifecycleBridge);
    this.sessionDiagnosticsEventBridge = new LexSessionDiagnosticsEventBridge();
  }

  processEvent(event: any): void {
    this.messageLifecycleBridge.ensureResponseItem();

    if (this.stateEventBridge.processEvent(event)) {
      return;
    }

    if (this.runtimeEventBridge.processEvent(event)) {
      return;
    }

    this.sessionDiagnosticsEventBridge.processEvent(event);
  }
}
