import { AILY_ANIM_TIMESCALE, buildAilyAnimFile } from './aani-v2';
import {
  createEmptyTftEsPiAnimationValue,
  createTftEsPiAnimationValue,
  validateTftEsPiAnimationValue,
} from './tftespi-animation-value';

function expectErrorMessage(action: () => unknown, expected: RegExp): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  expect(thrown instanceof Error ? thrown.message : String(thrown)).toMatch(expected);
}

describe('TFT_eSPI AANI field value', () => {
  function buildFixture() {
    return buildAilyAnimFile([
      new Uint16Array([0xf800, 0x07e0]),
      new Uint16Array([0xf800, 0x001f]),
    ], {
      width: 2,
      height: 1,
      fpsNumerator: 10,
      fpsDenominator: 1,
    }).file;
  }

  it('stores one complete canonical file in the locked v4 Base64 envelope', () => {
    const created = createTftEsPiAnimationValue(buildFixture(), {
      sourceName: 'fixture.aani',
    });
    expect(created.value.version).toBe(4);
    expect(created.value.format).toBe('aani');
    expect(created.value.encoding).toBe('base64');
    expect(created.value.extension).toBe('.aani');
    expect(created.value.width).toBe(2);
    expect(created.value.height).toBe(1);
    expect(created.value.frameCount).toBe(2);
    expect(created.value.timescale).toBe(AILY_ANIM_TIMESCALE);
    expect(created.value.sourceName).toBe('fixture.aani');
    expect(created.value.data.length).toBeGreaterThan(0);
    expect(validateTftEsPiAnimationValue(created.value).parsed?.header.frameCount).toBe(2);
  });

  it('rejects legacy frame arrays and legacy RGB formats', () => {
    expectErrorMessage(() => validateTftEsPiAnimationValue({
      version: 1,
      format: 'rgb565',
      encoding: 'rgb565-be-base64',
      frames: ['AAAA'],
    }), /旧版/);
    expectErrorMessage(() => validateTftEsPiAnimationValue({
      ...createEmptyTftEsPiAnimationValue(),
      frames: [],
    }), /旧版/);
  });

  it('rejects duplicated envelope metadata that disagrees with the file Header', () => {
    const value = createTftEsPiAnimationValue(buildFixture()).value;
    expectErrorMessage(() => validateTftEsPiAnimationValue({ ...value, width: 3 }), /width/);
    expectErrorMessage(() => validateTftEsPiAnimationValue({ ...value, durationTicks: '1' }), /durationTicks/);
    expectErrorMessage(() => validateTftEsPiAnimationValue({ ...value, extension: '.ailyanim' }), /AANI v2/);
  });

  it('accepts only the canonical empty envelope', () => {
    const empty = createEmptyTftEsPiAnimationValue(240, 240);
    expect(validateTftEsPiAnimationValue(empty).parsed).toBeNull();
    expectErrorMessage(() => validateTftEsPiAnimationValue({ ...empty, timescale: 999 }), /timescale/);
    expectErrorMessage(() => validateTftEsPiAnimationValue({ ...empty, frameCount: 1 }), /帧数/);
  });

  it('applies the editor resource profile before allocating preview buffers', () => {
    const oversizedCanvas = buildFixture().slice();
    new DataView(oversizedCanvas.buffer).setUint16(5, 481, true);
    expectErrorMessage(() => createTftEsPiAnimationValue(oversizedCanvas), /480x480/);

    const excessiveFrames = buildFixture().slice();
    new DataView(excessiveFrames.buffer).setUint16(9, 301, true);
    expectErrorMessage(() => createTftEsPiAnimationValue(excessiveFrames), /300/);
  });
});
