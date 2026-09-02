import { InjectionToken } from '@angular/core';
import type { LinuxBoardConnector } from '@shared/public-api';

export interface DeviceActionFeedback {
  success: boolean;
  data?: any;
  error?: string;
}

/** UI/editor/subapp coordination required by firmware upload. */
export interface DeviceApplicationPort {
  hasActionListener(listenerId: string): boolean;
  dispatchAction(
    type: string,
    payload: any,
    callback?: (feedback: DeviceActionFeedback) => void,
    timeoutMs?: number,
  ): void;
  dispatchActionWithFeedback(type: string, payload: any, timeoutMs: number): Promise<DeviceActionFeedback>;
  sendToolSignal(signal: string, payload: Record<string, unknown>): void;
  handleSubappSignal(signal: string, payload: Record<string, unknown>): Promise<void> | null;
  uploadFromBlocklyEditor(): Promise<any>;
  cancelBlocklyEditorUpload(): void;
  getLinuxBoardSelectedTransport(): LinuxBoardConnector | null;
  syncAndRunLinuxBoardSource(
    source: string,
    projectPath: string,
    expectedTransport: LinuxBoardConnector,
    entry: string,
  ): Promise<Record<string, unknown>>;
  stopLinuxBoardProject(): Promise<Record<string, unknown>>;
}

export const DEVICE_APPLICATION_PORT = new InjectionToken<DeviceApplicationPort>(
  'DEVICE_APPLICATION_PORT',
);
