import type { IDialog, IFileSystem } from '../core/host-api';

export type ChatDebugImportDialogLike = Pick<IDialog, 'selectFiles'>;
export type ChatDebugImportFileSystemLike = Pick<IFileSystem, 'readFileSync'> & Partial<Pick<IFileSystem, 'readFile'>>;

export type ChatDebugImportResult<T> =
  | { kind: 'cancelled' }
  | { kind: 'failed'; filePath: string }
  | { kind: 'imported'; filePath: string; imported: T };

export async function importDebugSnapshotFromDialog<T>(deps: {
  dialog: ChatDebugImportDialogLike;
  fs: ChatDebugImportFileSystemLike;
  importDebugSnapshot(data: Uint8Array): Promise<T | null> | T | null;
}): Promise<ChatDebugImportResult<T>> {
  const result = await deps.dialog.selectFiles({
    title: '导入调试快照',
    properties: ['openFile'],
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });

  if (result?.canceled || !result?.filePaths?.length) {
    return { kind: 'cancelled' };
  }

  const filePath = result.filePaths[0];
  const content = await readUtf8File(deps.fs, filePath);
  const imported = await deps.importDebugSnapshot(new TextEncoder().encode(content));
  if (!imported) {
    return { kind: 'failed', filePath };
  }

  return {
    kind: 'imported',
    filePath,
    imported,
  };
}

async function readUtf8File(fs: ChatDebugImportFileSystemLike, filePath: string): Promise<string> {
  if (typeof fs.readFile === 'function') {
    return fs.readFile(filePath, 'utf-8');
  }

  return fs.readFileSync(filePath, 'utf-8');
}