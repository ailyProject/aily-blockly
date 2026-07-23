import {
  FieldTftEsPiRgb565Animation,
  TftEsPiRgb565AnimationValue,
} from './field-tftespi-rgb565-animation';

describe('FieldTftEsPiRgb565Animation legacy value isolation', () => {
  function fieldHarness() {
    return Object.create(FieldTftEsPiRgb565Animation.prototype) as any;
  }

  it('preserves a valid RGB565 frame-array value', () => {
    const value: TftEsPiRgb565AnimationValue = {
      version: 1,
      format: 'rgb565',
      encoding: 'rgb565-be-base64',
      width: 2,
      height: 1,
      fps: 24,
      maxFrames: 2,
      frames: ['+AAH4A=='],
      sourceName: 'fixture.mp4',
    };

    expect(fieldHarness().normalizeValue(value)).toEqual(jasmine.objectContaining(value));
  });

  it('preserves a valid RGB332 frame-array value', () => {
    const value: TftEsPiRgb565AnimationValue = {
      version: 1,
      format: 'rgb332',
      encoding: 'rgb332-base64',
      width: 2,
      height: 1,
      fps: 12,
      maxFrames: 1,
      frames: ['/wA='],
    };

    expect(fieldHarness().normalizeValue(value)).toEqual(jasmine.objectContaining(value));
  });

  it('does not accept an AANI envelope in the legacy field', () => {
    const normalized = fieldHarness().normalizeValue({
      version: 4,
      format: 'aani',
      encoding: 'base64',
      extension: '.aani',
      data: 'QUFOSQ==',
    });

    expect(normalized.version).toBe(1);
    expect(normalized.format).toBe('rgb565');
    expect(normalized.frames).toEqual([]);
  });

  it('filters frames whose Base64 length cannot match the configured dimensions', () => {
    const normalized = fieldHarness().normalizeValue({
      version: 1,
      format: 'rgb565',
      encoding: 'rgb565-be-base64',
      width: 2,
      height: 1,
      fps: 10,
      maxFrames: 2,
      frames: ['AA==', '+AAH4A=='],
    });

    expect(normalized.frames).toEqual(['+AAH4A==']);
  });
});
