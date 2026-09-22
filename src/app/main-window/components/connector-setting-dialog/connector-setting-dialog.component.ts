import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzCheckboxModule } from 'ng-zorro-antd/checkbox';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

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

@Component({
  selector: 'app-connector-setting-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzCheckboxModule,
    NzInputModule,
    TranslateModule,
    BaseDialogComponent,
  ],
  templateUrl: './connector-setting-dialog.component.html',
  styleUrl: './connector-setting-dialog.component.scss',
})
export class ConnectorSettingDialogComponent {
  private readonly modal = inject(NzModalRef);
  private readonly connector = inject(LinuxBoardConnectorService);
  private readonly translate = inject(TranslateService);
  private readonly data = inject<ConnectorSettingDialogData | null>(NZ_MODAL_DATA, { optional: true });

  settings: LinuxBoardSshSettings = {
    ...this.connector.getSshSettings(),
    ...(this.data?.settings || {}),
  };
  connecting = false;

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
        text: 'SSH_CONNECTION_DIALOG.CANCEL',
        action: 'cancel',
        disabled: this.connecting,
      },
      {
        text: this.connecting
          ? 'SSH_CONNECTION_DIALOG.CONNECTING'
          : 'SSH_CONNECTION_DIALOG.CONNECT',
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
    this.modal.close();
  }

  async selectPrivateKey(): Promise<void> {
    const path = await window['ipcRenderer']?.invoke?.('select-file', {
      title: this.translate.instant('SSH_CONNECTION_DIALOG.SELECT_PRIVATE_KEY'),
      path: this.settings.privateKeyPath || undefined,
    });
    if (path) this.settings.privateKeyPath = String(path);
  }

  private async connect(): Promise<void> {
    if (!this.canConnect || this.connecting) return;
    this.connecting = true;
    try {
      await this.connector.connectSsh({ ...this.settings });
      this.settings.password = '';
      this.modal.close({ connected: true });
    } catch {
      // LinuxBoardConnectorService 将连接错误统一发布到 <app-notification>。
    } finally {
      this.connecting = false;
    }
  }
}
