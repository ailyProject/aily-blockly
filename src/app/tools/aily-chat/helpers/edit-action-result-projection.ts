import { mkError, mkState, type ChatPart } from '../core/chat-parts';

import type { ChatViewWriteBridge } from './chat-view-write-bridge';

export type EditActionName = 'undo' | 'redo' | 'restore';
export type EditActionResultState = 'done' | 'warn' | 'error' | 'info';

export type EditActionResultDescriptor = {
  summaryText: string;
  state: EditActionResultState;
  fileCount?: number;
  errorCount?: number;
  detailMessage?: string;
};

type EditActionProjectionViewWriteAccess = Pick<ChatViewWriteBridge, 'appendAilyPartsMessageHandle'>;

export function appendEditActionResult(
  viewWriteBridge: EditActionProjectionViewWriteAccess,
  action: EditActionName,
  result: EditActionResultDescriptor,
): void {
  const parts: ChatPart[] = [
    mkState(
      `edit-action-${action}-${Date.now()}`,
      result.summaryText,
      result.state,
      undefined,
      undefined,
      {
        action,
        fileCount: result.fileCount,
        errorCount: result.errorCount,
      },
    ),
  ];

  if (result.detailMessage) {
    parts.push(mkError(result.detailMessage));
  }

  viewWriteBridge.appendAilyPartsMessageHandle(parts, { scroll: true });
}

export function buildEditActionResult(
  summaryText: string,
  state: EditActionResultState,
  options: {
    fileCount?: number;
    errorCount?: number;
    detailMessage?: string;
  } = {},
): EditActionResultDescriptor {
  return {
    summaryText,
    state,
    fileCount: options.fileCount,
    errorCount: options.errorCount,
    detailMessage: options.detailMessage,
  };
}

export function formatEditErrorDetail(errors: readonly string[]): string | undefined {
  if (errors.length === 0) {
    return undefined;
  }

  const lines = errors.slice(0, 3).map((error, index) => `${index + 1}. ${error}`);
  return `以下操作失败（最多显示 3 条）：\n${lines.join('\n')}`;
}

export function buildUndoActionResult(fileCount: number, errors: readonly string[]): EditActionResultDescriptor {
  if (errors.length > 0) {
    return buildEditActionResult(
      `已撤销 ${fileCount} 个文件变更，另有 ${errors.length} 个错误`,
      'warn',
      {
        fileCount,
        errorCount: errors.length,
        detailMessage: formatEditErrorDetail(errors),
      },
    );
  }

  return buildEditActionResult(`已撤销 ${fileCount} 个文件变更`, 'done', {
    fileCount,
  });
}

export function buildRedoActionSummary(fileCount: number, chatTurnCount: number): string {
  if (chatTurnCount <= 0) {
    return fileCount > 0
      ? `已重做 ${fileCount} 个文件变更（仅恢复工作区）`
      : '已重做工作区状态（仅恢复工作区）';
  }

  const segments: string[] = [];

  if (fileCount > 0) {
    segments.push(`${fileCount} 个文件变更`);
  }

  if (chatTurnCount > 0) {
    segments.push(`${chatTurnCount} 轮聊天`);
  }

  if (segments.length === 0) {
    return '已重做工作区与聊天状态';
  }

  return `已重做 ${segments.join('和')}`;
}

export function buildRedoApplyActionResult(
  fileCount: number,
  chatTurnCount: number,
  errors: readonly string[],
): EditActionResultDescriptor {
  const summaryText = buildRedoActionSummary(fileCount, chatTurnCount);
  if (errors.length > 0) {
    return buildEditActionResult(
      `${summaryText}，另有 ${errors.length} 个错误`,
      'warn',
      {
        fileCount,
        errorCount: errors.length,
        detailMessage: formatEditErrorDetail(errors),
      },
    );
  }

  return buildEditActionResult(summaryText, 'done', { fileCount });
}