import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ActionService, UiService } from '@core/app-shell/public-api';
import {
  DeviceActionFeedback,
  DeviceApplicationPort,
} from '@domain/device/public-api';
import { SubappResourceLifecycleService } from '@integration/subapps/public-api';
import { LinuxBoardConnectorService } from '@integration/device/public-api';
import type { LinuxBoardConnector } from '@shared/public-api';
import { _UploaderService as BlocklyUploaderService } from '../../editors/blockly-editor/services/uploader.service';

@Injectable({ providedIn: 'root' })
export class DeviceApplicationAdapter implements DeviceApplicationPort {
  constructor(
    private readonly actionService: ActionService,
    private readonly uiService: UiService,
    private readonly subappResourceLifecycle: SubappResourceLifecycleService,
    private readonly blocklyUploaderService: BlocklyUploaderService,
    private readonly linuxBoardConnector: LinuxBoardConnectorService,
  ) {}

  hasActionListener(listenerId: string): boolean {
    return this.actionService.hasListener(listenerId);
  }

  dispatchAction(
    type: string,
    payload: any,
    callback?: (feedback: DeviceActionFeedback) => void,
    timeoutMs?: number,
  ): void {
    this.actionService.dispatch(type, payload, callback, timeoutMs);
  }

  dispatchActionWithFeedback(
    type: string,
    payload: any,
    timeoutMs: number,
  ): Promise<DeviceActionFeedback> {
    return firstValueFrom(this.actionService.dispatchWithFeedback(type, payload, timeoutMs));
  }

  sendToolSignal(signal: string, payload: Record<string, unknown>): void {
    this.uiService.sendToolSignal(signal, payload);
  }

  handleSubappSignal(signal: string, payload: Record<string, unknown>): Promise<void> | null {
    return this.subappResourceLifecycle.handleSignal(signal, payload);
  }

  uploadFromBlocklyEditor(): Promise<any> {
    return this.blocklyUploaderService.upload();
  }

  cancelBlocklyEditorUpload(): void {
    this.blocklyUploaderService.cancel();
  }

  getLinuxBoardSelectedTransport(): LinuxBoardConnector | null {
    return this.linuxBoardConnector.snapshot.selectedTransport;
  }

  syncAndRunLinuxBoardSource(
    source: string,
    projectPath: string,
    expectedTransport: LinuxBoardConnector,
    entry: string,
  ): Promise<Record<string, unknown>> {
    return this.linuxBoardConnector.syncAndRunSource(
      source,
      projectPath,
      expectedTransport,
      entry,
    );
  }

  stopLinuxBoardProject(): Promise<Record<string, unknown>> {
    return this.linuxBoardConnector.stop();
  }
}
