import type { ResourceItem } from '../core/chat-types';
import { getSupportedImageMimeTypeFromPath } from '../core/chat-image-attachment';
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

  return result.filePaths.map(createFileResource);
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

function createFileResource(filePath: string): ResourceItem {
  const mimeType = getSupportedImageMimeTypeFromPath(filePath);
  if (!mimeType) {
    return { type: 'file', path: filePath, name: getBaseName(filePath) };
  }
  const id = globalThis.crypto?.randomUUID?.()
    ?? `image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return {
    type: 'image',
    path: filePath,
    name: getBaseName(filePath),
    mimeType,
    imageAttachment: {
      id,
      type: 'image',
      name: getBaseName(filePath),
      origin: 'file',
      source: { kind: 'local-file', uri: filePath },
      mimeType,
      detail: 'auto',
    },
  };
}
