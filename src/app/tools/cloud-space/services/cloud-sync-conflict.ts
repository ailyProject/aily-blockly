import type { NzModalRef, NzModalService } from 'ng-zorro-antd/modal';
import { firstValueFrom } from 'rxjs';

export type CloudSyncConflictAction = 'overwrite' | 'save-new' | 'cancel';

export function chooseCloudSyncConflictAction(
  modal: NzModalService,
  repeated: boolean,
): Promise<CloudSyncConflictAction> {
  let dialog: NzModalRef<unknown, CloudSyncConflictAction>;
  dialog = modal.create<unknown, unknown, CloudSyncConflictAction>({
    nzTitle: repeated ? '云端工程再次更新' : '云同步冲突',
    nzContent: repeated
      ? '确认期间，云端又收到新版本。本地修改已保留，请重新选择处理方式。'
      : '云端工程已有新版本，本地修改已保留。你可以替换云端版本，或保留两个云工程。',
    nzWidth: 520,
    nzCentered: true,
    nzMaskClosable: false,
    nzClosable: true,
    nzKeyboard: true,
    nzFooter: [
      { label: '取消', onClick: () => dialog.close('cancel') },
      { label: '另存为新云工程', type: 'primary', onClick: () => dialog.close('save-new') },
      { label: '覆盖云端', danger: true, onClick: () => dialog.close('overwrite') },
    ],
  });
  return firstValueFrom(dialog.afterClose, { defaultValue: undefined }).then(action => action ?? 'cancel');
}

export async function confirmCloudSyncOverwrite(modal: NzModalService): Promise<boolean> {
  const dialog = modal.confirm({
    nzTitle: '确认覆盖云端工程？',
    nzContent: '当前本地内容将替换这个云工程的当前版本。其他电脑之后下载时会取得本地这份内容。',
    nzCentered: true,
    nzMaskClosable: false,
    nzClosable: true,
    nzKeyboard: true,
    nzAutofocus: 'cancel',
    nzCancelText: '取消',
    nzOkText: '确认覆盖',
    nzOkDanger: true,
    nzOnOk: () => true,
  });
  return await firstValueFrom(dialog.afterClose, { defaultValue: undefined }) === true;
}
