import type { ResourceItem } from '../core/chat-types';
import type { IDialog, IDialogResult } from '../core/host-api';

type FileDialogLike = Pick<IDialog, 'selectFiles'>;

export async function pickFileResources(dialog: FileDialogLike): Promise<ResourceItem[]> {
  const result = await dialog.selectFiles({
    title: '选择文件',
    // Explicitly open the native file picker. Avoid wildcard filters here
    // because some platforms handle "*" inconsistently for all-file views.
    properties: ['openFile', 'multiSelections'],
  });

  if (isEmptySelection(result)) {
    return [];
  }

  return result.filePaths.map((path) => ({
    type: 'file',
    path,
    name: getBaseName(path),
  }));
}

export async function pickFolderResource(dialog: FileDialogLike): Promise<ResourceItem | null> {
  const result = await dialog.selectFiles({
    title: '选择文件夹',
    properties: ['openDirectory'],
  });

  if (isEmptySelection(result)) {
    return null;
  }

  const selectedPath = result.filePaths[0];
  return {
    type: 'folder',
    path: selectedPath,
    name: getBaseName(selectedPath),
  };
}

function isEmptySelection(result: IDialogResult | null | undefined): boolean {
  return Boolean(result?.canceled) || !result?.filePaths?.length;
}

function getBaseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}
