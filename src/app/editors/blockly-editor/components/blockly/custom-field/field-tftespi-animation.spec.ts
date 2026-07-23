import { FieldTftEsPiAnimation } from './field-tftespi-animation';

describe('FieldTftEsPiAnimation AILYANIM extension routing', () => {
  it('routes .AANI as AILYANIM but rejects it with the canonical lowercase extension error', async () => {
    const field = Object.create(FieldTftEsPiAnimation.prototype) as any;
    const fileInput = {
      files: [new File([Uint8Array.of(0)], 'fixture.AANI', { type: 'application/octet-stream' })],
      value: 'fixture.AANI',
    };
    const setStatus = jasmine.createSpy('setStatus');

    field.fileInput = fileInput;
    field.uploadRequestId = 0;
    field.stopPreview = () => undefined;
    field.commitSettings = () => undefined;
    field.clearSourceRedecodeTimer = () => undefined;
    field.invalidateDecodeOperations = () => 1;
    field.isUploadOperationCurrent = () => true;
    field.setStatus = setStatus;

    expect(field.isAaniSource('fixture.AANI')).toBeTrue();
    await field.onFileSelected();

    expect(setStatus.calls.mostRecent().args).toEqual([
      jasmine.stringMatching(/\.aani/),
      true,
    ]);
    expect(fileInput.value).toBe('');
  });
});

describe('FieldTftEsPiAnimation status file name', () => {
  const field = Object.create(FieldTftEsPiAnimation.prototype) as any;

  it('shortens names longer than 10 characters and keeps the extension', () => {
    expect(field.formatStatusFileName('12345678901.mp4')).toBe('1234567890...mp4');
  });

  it('does not shorten names with at most 10 characters', () => {
    expect(field.formatStatusFileName('1234567890.gif')).toBe('1234567890.gif');
  });
});
