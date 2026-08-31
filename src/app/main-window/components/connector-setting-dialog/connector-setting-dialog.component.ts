import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';

import {
  BaseDialogComponent,
  DialogButton,
} from '../../../components/base-dialog/base-dialog.component';
import {
  LinuxBoardConnectorService,
  LinuxBoardSshSettings,
} from '@integration/device/public-api';

export interface ConnectorSettingDialogData {
  settings?: Partial<LinuxBoardSshSettings>;
}

interface ConnectorError extends Error {
  code?: string;
  details?: { fingerprint?: string };
}

@Component({
  selector: 'app-connector-setting-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, NzInputModule, BaseDialogComponent],
  templateUrl: './connector-setting-dialog.component.html',
  styleUrl: './connector-setting-dialog.component.scss',
})
export class ConnectorSettingDialogComponent {
  private readonly modal = inject(NzModalRef);
  private readonly message = inject(NzMessageService);
  private readonly connector = inject(LinuxBoardConnectorService);
  private readonly data = inject<ConnectorSettingDialogData | null>(NZ_MODAL_DATA, { optional: true });

  settings: LinuxBoardSshSettings = {
    ...this.connector.getSshSettings(),
    ...(this.data?.settings || {}),
  };
  connecting = false;
  pendingHostKey = '';
  pendingHostKeyTarget = '';

  get canConnect(): boolean {
    const port = Number(this.settings.port);
    return Boolean(
      this.settings.host.trim()
      && this.settings.username.trim()
      && Number.isInteger(port)
      && port >= 1
      && port <= 65_535,
    );
  }

  get buttons(): DialogButton[] {
    return [
      {
        text: '取消',
        action: 'cancel',
        disabled: this.connecting,
      },
      {
        text: this.pendingHostKey ? '确认主机密钥并连接' : '连接',
        type: 'primary',
        action: 'connect',
        disabled: !this.canConnect || this.connecting,
        loading: this.connecting,
      },
    ];
  }

  onButtonClick(action: string): void {
    if (action === 'connect') {
      void this.connect();
    } else {
      this.close();
    }
  }

  close(): void {
    if (this.connecting) return;
    this.settings.password = '';
    this.pendingHostKey = '';
    this.modal.close();
  }

  async selectPrivateKey(): Promise<void> {
    const path = await window['ipcRenderer']?.invoke?.('select-file', {
      title: '选择 SSH 私钥',
      path: this.settings.privateKeyPath || undefined,
    });
    if (path) this.settings.privateKeyPath = String(path);
  }

  private async connect(): Promise<void> {
    if (!this.canConnect || this.connecting) return;
    const target = this.currentTarget();
    const confirmedHostKey = this.pendingHostKeyTarget === target
      ? this.pendingHostKey
      : undefined;
    this.connecting = true;
    try {
      await this.connector.connectSsh({ ...this.settings }, confirmedHostKey);
      this.settings.password = '';
      this.pendingHostKey = '';
      this.modal.close({ connected: true });
    } catch (error) {
      const connectorError = error as ConnectorError;
      const fingerprint = connectorError?.details?.fingerprint;
      if (connectorError?.code === 'HOST_KEY_UNKNOWN' && fingerprint) {
        this.pendingHostKey = fingerprint;
        this.pendingHostKeyTarget = target;
        this.message.warning('请核对主机密钥指纹，然后再次点击连接');
      } else {
        this.pendingHostKey = '';
        this.pendingHostKeyTarget = '';
        this.message.error(error instanceof Error ? error.message : String(error || 'SSH 连接失败'));
      }
    } finally {
      this.connecting = false;
    }
  }

  private currentTarget(): string {
    return `${this.settings.username.trim()}@${this.settings.host.trim().toLowerCase()}:${Number(this.settings.port)}`;
  }
}
