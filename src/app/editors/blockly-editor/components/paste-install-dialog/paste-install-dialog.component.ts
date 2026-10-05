import { Component, inject } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { BaseDialogComponent, DialogButton } from '../../../../components/base-dialog/base-dialog.component';

export interface MissingLibInfo {
  blockType: string;
  name: string;
  version: string;
  localPath?: string;
}

@Component({
  selector: 'app-paste-install-dialog',
  imports: [NzTagModule, CommonModule, TranslateModule, BaseDialogComponent],
  templateUrl: './paste-install-dialog.component.html',
  styleUrl: './paste-install-dialog.component.scss'
})
export class PasteInstallDialogComponent {

  readonly modal = inject(NzModalRef);
  readonly translate = inject(TranslateService);
  readonly data: {
    missingLibs: MissingLibInfo[];
    installFn: (libs: MissingLibInfo[]) => Promise<void>;
    title?: string;
    message?: string;
    confirmText?: string;
  } = inject(NZ_MODAL_DATA);

  installing = false;
  installLog = '';
  currentLib = '';

  get missingLibs(): MissingLibInfo[] {
    return this.data.missingLibs;
  }

  get title(): string {
    return this.data.title || this.translate.instant('PASTE_INSTALL.TITLE');
  }

  get message(): string {
    return this.data.message || this.translate.instant('PASTE_INSTALL.MESSAGE');
  }

  get confirmText(): string {
    return this.data.confirmText || this.translate.instant('PASTE_INSTALL.INSTALL_AND_PASTE');
  }

  get buttons(): DialogButton[] {
    return [
      {
        text: 'PASTE_INSTALL.CANCEL',
        type: 'default',
        disabled: this.installing,
        action: 'cancel',
      },
      {
        text: this.confirmText,
        type: 'primary',
        loading: this.installing,
        action: 'install',
      },
    ];
  }

  getVersionDisplay(lib: MissingLibInfo): string {
    if (lib.localPath) {
      return 'file:' + lib.localPath;
    }
    return lib.version;
  }

  async selectLocalLibrary(lib: MissingLibInfo): Promise<void> {
    const result = await window['ipcRenderer'].invoke('dialog-select-files', {
      title: `选择 ${lib.name} 积木库目录`,
      properties: ['openDirectory'],
    });
    if (!result?.canceled && result?.filePaths?.[0]) {
      lib.localPath = result.filePaths[0];
      this.installLog = '';
    }
  }

  cancel(): void {
    if (!this.installing) {
      this.modal.close({ result: 'cancel' });
    }
  }

  async installAndPaste(): Promise<void> {
    this.installing = true;
    try {
      await this.data.installFn(this.data.missingLibs);
      this.modal.close({ result: 'installed' });
    } catch (error) {
      this.installing = false;
      this.installLog = String(error);
    }
  }

  onButtonClick(action: string): void {
    if (action === 'install') {
      void this.installAndPaste();
    } else {
      this.cancel();
    }
  }
}
