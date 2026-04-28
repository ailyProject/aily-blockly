import { Component, inject } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

export interface MissingLibInfo {
  blockType: string;
  name: string;
  version: string;
  localPath?: string;
}

@Component({
  selector: 'app-paste-install-dialog',
  imports: [NzButtonModule, NzTagModule, NzSpinModule, CommonModule, TranslateModule],
  templateUrl: './paste-install-dialog.component.html',
  styleUrl: './paste-install-dialog.component.scss'
})
export class PasteInstallDialogComponent {

  readonly modal = inject(NzModalRef);
  readonly data: {
    missingLibs: MissingLibInfo[];
    installFn: (libs: MissingLibInfo[]) => Promise<void>;
  } = inject(NZ_MODAL_DATA);

  installing = false;
  installLog = '';
  currentLib = '';

  get missingLibs(): MissingLibInfo[] {
    return this.data.missingLibs;
  }

  getVersionDisplay(lib: MissingLibInfo): string {
    if (lib.localPath) {
      const folderName = lib.localPath.split(/[/\\]/).pop() || '';
      return 'file:' + folderName;
    }
    return lib.version;
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
}
