import {
  AILY_ANIM_EXTENSION,
  AILY_ANIM_FRAME_INDEX_SIZE,
  AILY_ANIM_HEADER_SIZE,
  AILY_ANIM_MAGIC,
  AILY_ANIM_TIMESCALE,
  AILY_ANIM_VERSION,
  AilyAnimFeature,
  AilyAnimFrameType,
  buildAilyAnimFile,
  crc16CcittFalse,
  decodeAilyAnimFrame,
  getOutputExtension,
  packRgbaToRgb565,
  parseAilyAnimFile,
  unpackRgb565ToRgba,
  validateAilyAnimFile,
} from './aani-v2';

function pixels(values: number[]): Uint16Array {
  return Uint16Array.from(values);
}

function readU24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function writeU24(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

function refreshHeaderCrc(file: Uint8Array): void {
  new DataView(file.buffer, file.byteOffset, file.byteLength)
    .setUint16(12, crc16CcittFalse(file.subarray(0, 12)), true);
}

function frameDataOffset(file: Uint8Array): number {
  const frameCount = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint16(9, true);
  return AILY_ANIM_HEADER_SIZE + frameCount * AILY_ANIM_FRAME_INDEX_SIZE;
}

function recordOffset(file: Uint8Array, frameIndex: number): number {
  return new DataView(file.buffer, file.byteOffset, file.byteLength)
    .getUint32(AILY_ANIM_HEADER_SIZE + frameIndex * AILY_ANIM_FRAME_INDEX_SIZE, true);
}

function recordStart(file: Uint8Array, frameIndex: number): number {
  return frameDataOffset(file) + recordOffset(file, frameIndex);
}

function decoded565(file: Uint8Array, frameIndex: number, width: number, height: number): Uint16Array {
  return packRgbaToRgb565(decodeAilyAnimFrame(file, frameIndex).rgba, width, height);
}

describe('compact AANI v2 codec', () => {
  it('writes the exact 14-byte header, 7-byte index and payload-free Fill operation', () => {
    const built = buildAilyAnimFile([pixels([0x07e0, 0x07e0])], {
      width: 2,
      height: 1,
      fpsNumerator: 25,
      fpsDenominator: 1,
      loop: false,
    });
    const { file } = built;
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);

    expect(String.fromCharCode(...file.subarray(0, 4))).toBe(AILY_ANIM_MAGIC);
    expect(view.getUint8(4)).toBe(AILY_ANIM_VERSION);
    expect(view.getUint16(5, true)).toBe(2);
    expect(view.getUint16(7, true)).toBe(1);
    expect(view.getUint16(9, true)).toBe(1);
    expect(view.getUint8(11)).toBe(1);
    expect(view.getUint16(12, true)).toBe(crc16CcittFalse(file.subarray(0, 12)));
    expect(crc16CcittFalse(new TextEncoder().encode('123456789'))).toBe(0x29b1);

    expect(file.byteLength).toBe(14 + 7 + 12);
    expect(view.getUint32(14, true)).toBe(0);
    expect(view.getUint16(18, true)).toBe(40);
    expect(file[20]).toBe(AilyAnimFrameType.Key);
    expect(file[21]).toBe(0); // Fill kind.
    expect(view.getUint16(22, true)).toBe(0);
    expect(view.getUint16(24, true)).toBe(0);
    expect(view.getUint16(26, true)).toBe(2);
    expect(view.getUint16(28, true)).toBe(1);
    expect(readU24(file, 30)).toBe(0x07e0);

    const parsed = parseAilyAnimFile(file);
    expect(parsed.header.version).toBe(2);
    expect(parsed.header.timescale).toBe(1_000);
    expect(parsed.header.durationTicks).toBe(40n);
    expect(parsed.encodingStats.fillOps).toBe(1);
    expect(built.info.frameIndexSize).toBe(7);
    expect(built.info.frameDataSize).toBe(12);
  });

  it('stores Raw565 immediately after its 12-byte Op header with no padding', () => {
    const file = buildAilyAnimFile([pixels([0xf800, 0x07e0])], {
      width: 2,
      height: 1,
      fpsNumerator: 1,
      fpsDenominator: 1,
    }).file;
    const start = recordStart(file, 0);

    expect(file.byteLength).toBe(14 + 7 + 12 + 4);
    expect(file[start]).toBe(1);
    expect(readU24(file, start + 9)).toBe(4);
    expect(Array.from(file.subarray(start + 12))).toEqual([0x00, 0xf8, 0xe0, 0x07]);
    expect(Array.from(decoded565(file, 0, 2, 1))).toEqual([0xf800, 0x07e0]);
  });

  it('derives timestamps and features while preserving Key, Hold and Delta semantics', () => {
    const first = Uint16Array.from({ length: 128 }, (_value, index) => (index * 977 + 3) & 0xffff);
    const hold = first.slice();
    const changed = first.slice();
    changed.fill(0xf81f, 20, 24);
    const built = buildAilyAnimFile([first, hold, changed], {
      width: 128,
      height: 1,
      fpsNumerator: 24,
      fpsDenominator: 1,
    });
    const parsed = parseAilyAnimFile(built.file);

    expect(parsed.frames.map(frame => frame.frameType)).toEqual([
      AilyAnimFrameType.Key,
      AilyAnimFrameType.Hold,
      AilyAnimFrameType.Delta,
    ]);
    expect(parsed.frames.map(frame => frame.timestampTicks)).toEqual([0n, 42n, 83n]);
    expect(parsed.frames.map(frame => frame.durationTicks)).toEqual([42, 41, 42]);
    const firstRecordSize = parsed.frames[0].dataSize;
    expect(parsed.frames.map(frame => frame.dataOffset)).toEqual([
      0n,
      BigInt(firstRecordSize),
      BigInt(firstRecordSize),
    ]);
    expect(parsed.frames[1].opCount).toBe(0);
    expect(parsed.header.requiredFeatures & AilyAnimFeature.Delta).toBeTruthy();
    expect(Array.from(decoded565(built.file, 2, 128, 1))).toEqual(Array.from(changed));

    const staleZeroHoldOffset = built.file.slice();
    new DataView(staleZeroHoldOffset.buffer)
      .setUint32(AILY_ANIM_HEADER_SIZE + AILY_ANIM_FRAME_INDEX_SIZE, 0, true);
    expect(() => parseAilyAnimFile(staleZeroHoldOffset)).toThrowError(/HOLD FrameIndex/);
  });

  it('packs odd-length RLE records back-to-back without alignment bytes', () => {
    const first = new Uint16Array(300);
    first.fill(0xf800, 0, 100);
    first.fill(0x07e0, 100, 200);
    first.fill(0x001f, 200);
    const second = new Uint16Array(300);
    second.fill(0xffff, 0, 100);
    second.fill(0x0000, 100, 200);
    second.fill(0xffe0, 200);
    const file = buildAilyAnimFile([first, second], {
      width: 300,
      height: 1,
      fpsNumerator: 10,
      fpsDenominator: 1,
      keyIntervalFrames: 1,
    }).file;

    expect(recordOffset(file, 0)).toBe(0);
    expect(recordOffset(file, 1)).toBe(21); // 12-byte header + 9-byte RLE payload.
    expect(file.byteLength - frameDataOffset(file)).toBe(42);
    expect(file[recordStart(file, 0)]).toBe(2);
    expect(readU24(file, recordStart(file, 0) + 9)).toBe(9);
    expect(() => validateAilyAnimFile(file)).not.toThrow();
  });

  it('decodes opCount from the high six meta bits and supports immediate multi-op records', () => {
    const base = buildAilyAnimFile([pixels([0x07e0, 0x07e0])], {
      width: 2,
      height: 1,
      fpsNumerator: 1,
      fpsDenominator: 1,
    }).file;
    const file = new Uint8Array(base.byteLength + 12);
    file.set(base);
    file[AILY_ANIM_HEADER_SIZE + 6] = (1 << 2) | AilyAnimFrameType.Key;
    // Two operations: opCount - 1 = 1.
    const view = new DataView(file.buffer);
    const second = base.byteLength;
    file[second] = 0;
    view.setUint16(second + 1, 1, true);
    view.setUint16(second + 3, 0, true);
    view.setUint16(second + 5, 1, true);
    view.setUint16(second + 7, 1, true);
    writeU24(file, second + 9, 0x001f);

    const parsed = parseAilyAnimFile(file);
    expect(parsed.frames[0].opCount).toBe(2);
    expect(Array.from(decoded565(file, 0, 2, 1))).toEqual([0x07e0, 0x001f]);
  });

  it('rejects a KEY whose rectangles only cover the canvas as a union', () => {
    const base = buildAilyAnimFile([pixels([0x07e0, 0x07e0])], {
      width: 2,
      height: 1,
      fpsNumerator: 1,
      fpsDenominator: 1,
    }).file;
    const file = new Uint8Array(base.byteLength + 12);
    file.set(base);
    const view = new DataView(file.buffer);
    const first = recordStart(file, 0);
    const second = base.byteLength;
    file[AILY_ANIM_HEADER_SIZE + 6] = (1 << 2) | AilyAnimFrameType.Key;
    view.setUint16(first + 5, 1, true);
    file[second] = 0;
    view.setUint16(second + 1, 1, true);
    view.setUint16(second + 3, 0, true);
    view.setUint16(second + 5, 1, true);
    view.setUint16(second + 7, 1, true);
    writeU24(file, second + 9, 0x001f);

    expect(() => parseAilyAnimFile(file)).toThrowError(/KEY/);
  });

  it('keeps a coherent sparse Delta as Mask1 and validates mask padding', () => {
    const first = Uint16Array.from({ length: 255 }, (_value, index) => (index * 977 + 1) & 0xffff);
    const changed = first.slice();
    changed[0] ^= 0xffff;
    changed[254] ^= 0xffff;
    const file = buildAilyAnimFile([first, changed], {
      width: 255,
      height: 1,
      fpsNumerator: 30,
      fpsDenominator: 1,
    }).file;
    const parsed = parseAilyAnimFile(file);

    expect(parsed.frames[1].frameType).toBe(AilyAnimFrameType.Delta);
    expect(parsed.encodingStats.mask1RawOps).toBe(1);
    const start = recordStart(file, 1);
    expect(file[start]).toBe(3);
    expect(readU24(file, start + 9)).toBe(36); // 32-byte mask + two RGB565 colors.
    expect(Array.from(decoded565(file, 1, 255, 1))).toEqual(Array.from(changed));

    const badMask = file.slice();
    badMask[start + 12 + 31] |= 0x80;
    expect(() => parseAilyAnimFile(badMask)).toThrowError(/填充位/);
  });

  it('rejects fragmented checkerboard Mask candidates instead of emitting thousands of runs', () => {
    const first = Uint16Array.from({ length: 64 * 32 }, (_value, index) => (index * 4051 + 7) & 0xffff);
    const changed = first.slice();
    for (let index = 0; index < changed.length; index += 2) changed[index] ^= 0xffff;
    const parsed = parseAilyAnimFile(buildAilyAnimFile([first, changed], {
      width: 64,
      height: 32,
      fpsNumerator: 24,
      fpsDenominator: 1,
    }).file);

    expect(parsed.frames.map(frame => frame.frameType)).toEqual([
      AilyAnimFrameType.Key,
      AilyAnimFrameType.Key,
    ]);
    expect(parsed.encodingStats.mask1RawOps + parsed.encodingStats.mask1RleOps).toBe(0);
  });

  it('does not choose RLE for a one-byte payload saving', () => {
    const values = new Uint16Array(256);
    values.set([1, 1, 2, 2, 3, 3]);
    for (let index = 6; index < values.length; index++) values[index] = 1000 + index;
    const parsed = parseAilyAnimFile(buildAilyAnimFile([values], {
      width: 256,
      height: 1,
      fpsNumerator: 1,
      fpsDenominator: 1,
    }).file);

    expect(parsed.encodingStats.raw565Ops).toBe(1);
    expect(parsed.encodingStats.rle565Ops).toBe(0);
  });

  it('rejects legacy files, header corruption, invalid meta, offsets and trailing bytes', () => {
    const source = buildAilyAnimFile([pixels([0xf800, 0x07e0])], {
      width: 2,
      height: 1,
      fpsNumerator: 1,
      fpsDenominator: 1,
    }).file;
    const legacy = new Uint8Array(112);
    legacy.set(new TextEncoder().encode('AILYANIM'));
    expect(() => parseAilyAnimFile(legacy)).toThrowError(/magic/);

    const badHeader = source.slice();
    badHeader[6] ^= 1;
    expect(() => parseAilyAnimFile(badHeader)).toThrowError(/CRC16/);

    const badVersion = source.slice();
    badVersion[4] = 3;
    refreshHeaderCrc(badVersion);
    expect(() => parseAilyAnimFile(badVersion)).toThrowError(/版本/);

    const badDuration = source.slice();
    new DataView(badDuration.buffer).setUint16(AILY_ANIM_HEADER_SIZE + 4, 0, true);
    expect(() => parseAilyAnimFile(badDuration)).toThrowError(/duration/);

    const badType = source.slice();
    badType[AILY_ANIM_HEADER_SIZE + 6] = 3;
    expect(() => parseAilyAnimFile(badType)).toThrowError(/类型/);

    const badOffset = source.slice();
    new DataView(badOffset.buffer).setUint32(AILY_ANIM_HEADER_SIZE, 1, true);
    expect(() => parseAilyAnimFile(badOffset)).toThrowError(/recordOffset/);

    const badKind = source.slice();
    badKind[recordStart(badKind, 0)] = 5;
    expect(() => parseAilyAnimFile(badKind)).toThrowError(/kind/);

    const trailing = new Uint8Array(source.byteLength + 1);
    trailing.set(source);
    expect(() => parseAilyAnimFile(trailing)).toThrowError(/尾随字节/);
  });

  it('rejects truncated and under/over-decoded RLE payloads without any CRC refresh step', () => {
    const runs = new Uint16Array(300);
    runs.fill(0xf800, 0, 100);
    runs.fill(0x07e0, 100, 200);
    runs.fill(0x001f, 200);
    const file = buildAilyAnimFile([runs], {
      width: 300,
      height: 1,
      fpsNumerator: 1,
      fpsDenominator: 1,
    }).file;
    const start = recordStart(file, 0);
    const payload = start + 12;

    const under = file.slice();
    under[payload]--;
    expect(() => parseAilyAnimFile(under)).toThrowError(/样本不足/);

    const over = file.slice();
    over[payload]++;
    expect(() => parseAilyAnimFile(over)).toThrowError(/样本过多/);

    const truncated = file.slice();
    writeU24(truncated, start + 9, 0xff_ffff);
    expect(() => parseAilyAnimFile(truncated)).toThrowError(/payload.*越界/);
  });

  it('retains the public RGB565 helpers and canonical suffix', () => {
    const rgba = Uint8Array.from([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
    ]);
    const packed = packRgbaToRgb565(rgba, 3, 1);
    expect(Array.from(packed)).toEqual([0xf800, 0x07e0, 0x001f]);
    expect(Array.from(packRgbaToRgb565(unpackRgb565ToRgba(packed), 3, 1))).toEqual(Array.from(packed));
    expect(AILY_ANIM_TIMESCALE).toBe(1_000);
    expect(AILY_ANIM_EXTENSION).toBe('.aani');
    expect(getOutputExtension()).toBe('.aani');
  });

  it('rejects a frame duration that cannot fit the u16 millisecond index field', () => {
    const maximum = buildAilyAnimFile([pixels([0])], {
      width: 1,
      height: 1,
      fpsNumerator: 200,
      fpsDenominator: 13_107,
    }).file;
    expect(new DataView(maximum.buffer).getUint16(AILY_ANIM_HEADER_SIZE + 4, true)).toBe(0xffff);
    expect(parseAilyAnimFile(maximum).header.durationTicks).toBe(65_535n);

    expect(() => buildAilyAnimFile([pixels([0])], {
      width: 1,
      height: 1,
      fpsNumerator: 1,
      fpsDenominator: 66,
    })).toThrowError(/u16/);
  });
});
