import type { LiveHostSessionRecord } from '../services/chat-history.service';
import {
  HostSessionSaveBridge,
  type HostSessionSaveContext,
} from './host-session-save-bridge';

export type SessionLifecycleBuildHostSessionRecordOptions =
  Parameters<HostSessionSaveBridge['buildHostSessionRecord']>[0];

export type SessionLifecycleBuildLiveHostSessionRecordOptions =
  Parameters<HostSessionSaveBridge['buildLiveHostSessionRecord']>[0];

export type SessionLifecycleSaveCurrentSessionOptions =
  Parameters<HostSessionSaveBridge['saveCurrentSession']>[0];

export interface SessionLifecycleSaveBridgePort {
  buildHostSessionRecord(options: SessionLifecycleBuildHostSessionRecordOptions): LiveHostSessionRecord | null;
  buildLiveHostSessionRecord(options?: SessionLifecycleBuildLiveHostSessionRecordOptions): LiveHostSessionRecord | null;
  saveCurrentSession(options: SessionLifecycleSaveCurrentSessionOptions): boolean;
}

class HostSessionLifecycleSaveBridgePort implements SessionLifecycleSaveBridgePort {
  private readonly bridge: HostSessionSaveBridge;

  constructor(ctx: HostSessionSaveContext) {
    this.bridge = new HostSessionSaveBridge(ctx);
  }

  buildHostSessionRecord(options: SessionLifecycleBuildHostSessionRecordOptions): LiveHostSessionRecord | null {
    return this.bridge.buildHostSessionRecord(options);
  }

  buildLiveHostSessionRecord(options?: SessionLifecycleBuildLiveHostSessionRecordOptions): LiveHostSessionRecord | null {
    return this.bridge.buildLiveHostSessionRecord(options);
  }

  saveCurrentSession(options: SessionLifecycleSaveCurrentSessionOptions): boolean {
    return this.bridge.saveCurrentSession(options);
  }
}

export function createSessionLifecycleHostSessionSaveBridge(
  ctx: HostSessionSaveContext,
): SessionLifecycleSaveBridgePort {
  return new HostSessionLifecycleSaveBridgePort(ctx);
}
