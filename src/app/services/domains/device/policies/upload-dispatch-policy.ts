export type UploadDispatchMode = 'coder-direct' | 'blockly-action' | 'unavailable';

export function resolveUploadDispatchMode(input: {
  isAilyCodeProject: boolean;
  hasBlocklyUploader: boolean;
}): UploadDispatchMode {
  if (input.isAilyCodeProject) {
    return 'coder-direct';
  }
  return input.hasBlocklyUploader ? 'blockly-action' : 'unavailable';
}
