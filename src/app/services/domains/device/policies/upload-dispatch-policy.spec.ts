import { resolveUploadDispatchMode } from './upload-dispatch-policy';

describe('resolveUploadDispatchMode', () => {
  it('prioritizes direct upload for Aily Code projects', () => {
    const mode = resolveUploadDispatchMode({
      isAilyCodeProject: true,
      hasBlocklyUploader: true,
    });

    expect(mode).toBe('coder-direct');
  });
});
