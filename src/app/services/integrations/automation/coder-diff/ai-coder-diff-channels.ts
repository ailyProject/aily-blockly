/** 与独立 aily-coder 子应用包 src/aiEditDiffChannels.ts 契约一致 */

export const AILY_CODER_AI_EDIT_DIFF_CHANNEL = 'aily-coder-ai-edit-diff';
export const AILY_CODER_AI_EDIT_DIFF_RESULT_CHANNEL = 'aily-coder-ai-edit-diff-result';

export type AiEditDiffFileType = 'create' | 'modify' | 'delete';

export interface AiEditDiffFilePayload {
  filePath: string;
  baselineContent: string;
  currentContent?: string;
  type: AiEditDiffFileType;
}

export interface AiEditDiffOpenPayload {
  previewId: string;
  title: string;
  files: readonly AiEditDiffFilePayload[];
  focusFilePath?: string;
}

export type AiEditDiffResultAction = 'acceptFile' | 'rejectFile' | 'acceptAll' | 'rejectAll';

export interface AiEditDiffResultPayload {
  channel: typeof AILY_CODER_AI_EDIT_DIFF_RESULT_CHANNEL;
  previewId: string;
  action: AiEditDiffResultAction;
  filePath?: string;
}
