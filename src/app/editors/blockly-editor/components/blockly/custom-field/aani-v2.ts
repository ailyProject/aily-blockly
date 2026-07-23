/**
 * Compact AANI v2 codec used by the browser converter and preview.
 *
 * The wire format is deliberately fixed and streaming-friendly: a 14-byte
 * header, one 7-byte index entry per frame, then tightly packed frame data.
 * Legacy AILYANIM v1.x containers are intentionally not accepted.
 */

export const AILY_ANIM_MAGIC = 'AANI';
export const AILY_ANIM_EXTENSION = '.aani';
export const AILY_ANIM_HEADER_SIZE = 14;
export const AILY_ANIM_VERSION = 2;
export const AILY_ANIM_TIMESCALE = 1_000;
export const AILY_ANIM_FRAME_INDEX_SIZE = 7;

export enum AilyAnimFeature {
  Raw565 = 1 << 0,
  Delta = 1 << 1,
  Rle565 = 1 << 2,
  Mask1 = 1 << 4,
}

export enum AilyAnimFrameType {
  Key = 0,
  Delta = 1,
  Hold = 2,
}

export enum AilyAnimEncoding {
  None = 0,
  Raw565 = 1,
  Rle565 = 2,
  Mask1Raw565 = 3,
  Mask1Rle565 = 4,
}

const OP_DRAW_RECT = 0;
const OP_FILL_RECT = 1;
const OP_HEADER_SIZE = 12;
const FRAME_META_TYPE_MASK = 0x03;
const FRAME_META_OP_SHIFT = 2;
const MAX_OPS_PER_FRAME = 64;
const UINT16_MAX = 0xffff;
const UINT24_MAX = 0xff_ffff;
// MCU playback-cost model. The runtime decodes opaque data in 7680-pixel
// stripes; a display transaction is priced as 64 payload bytes so the encoder
// does not trade a tiny storage win for thousands of address-window changes.
const PLAYBACK_BATCH_PIXELS = 7680;
const PLAYBACK_DRAW_CALL_COST = 64;
const PLAYBACK_MASK_SCAN_DIVISOR = 4;
const PLAYBACK_RLE_DECODE_DIVISOR = 16;
const RLE_MIN_SAVING_BYTES = 64;
const RLE_MIN_SAVING_RATIO = 0.05;
const MASK_MIN_SAVING_BYTES = 256;
const MASK_MIN_SAVING_RATIO = 0.20;
const MASK_MAX_DRAW_CALLS = 256;
const MASK_SHORT_RUN_GRACE_CALLS = 16;
const MASK_MIN_AVERAGE_RUN_PIXELS = 4;
const MASK_DENSIFY_GAP_PIXELS = Math.floor(PLAYBACK_DRAW_CALL_COST / 2);
const UINT32_MAX = 0xffff_ffff;

export interface AilyAnimBuildOptions {
  width: number;
  height: number;
  fpsNumerator: number;
  fpsDenominator: number;
  loop?: boolean;
  keyIntervalFrames?: number;
  deltaToKeyThreshold?: number;
}

export interface AilyAnimEncodingStats {
  fillOps: number;
  raw565Ops: number;
  rle565Ops: number;
  mask1RawOps: number;
  mask1RleOps: number;
  raw565Bytes: number;
  encodedPayloadBytes: number;
}

export interface AilyAnimBuildInfo {
  width: number;
  height: number;
  timescale: number;
  durationTicks: bigint;
  frameCount: number;
  loopCount: number;
  requiredFeatures: number;
  fileSize: number;
  frameIndexSize: number;
  frameDataSize: number;
  keyFrameCount: number;
  deltaFrameCount: number;
  holdFrameCount: number;
  rawRgb565Size: number;
  compressionRatio: number;
  frameDurationsTicks: number[];
  encodingStats: AilyAnimEncodingStats;
}

export interface AilyAnimBuildResult {
  file: Uint8Array;
  info: AilyAnimBuildInfo;
}

export interface AilyAnimHeaderInfo {
  magic: 'AANI';
  version: number;
  requiredFeatures: number;
  canvasWidth: number;
  canvasHeight: number;
  timescale: number;
  frameCount: number;
  loopCount: number;
  durationTicks: bigint;
  headerCrc16: number;
}

export interface AilyAnimFrameInfo {
  timestampTicks: bigint;
  durationTicks: number;
  dataOffset: bigint;
  dataSize: number;
  opCount: number;
  frameType: AilyAnimFrameType;
}

interface ParsedOperation {
  opcode: number;
  encoding: AilyAnimEncoding;
  alphaMode: number;
  x: number;
  y: number;
  width: number;
  height: number;
  payload: Uint8Array;
  aux: number;
}

interface ParsedFrame extends AilyAnimFrameInfo {
  operations: ParsedOperation[];
}

export interface ParsedAilyAnimFile {
  bytes: Uint8Array;
  header: AilyAnimHeaderInfo;
  frames: readonly AilyAnimFrameInfo[];
  frameIndexSize: number;
  frameDataSize: number;
  keyFrameCount: number;
  deltaFrameCount: number;
  holdFrameCount: number;
  encodingStats: AilyAnimEncodingStats;
  /** Internal validated records used by the software preview decoder. */
  readonly _decodedFrames: readonly ParsedFrame[];
}

interface EncodedOperation {
  opcode: number;
  encoding: AilyAnimEncoding;
  alphaMode: number;
  x: number;
  y: number;
  width: number;
  height: number;
  payload: Uint8Array;
  aux: number;
  estimatedDrawCalls: number;
  maskScanPixels: number;
  decodedPixels: number;
}

interface EncodedFrame {
  timestampTicks: bigint;
  durationTicks: number;
  frameType: AilyAnimFrameType;
  opCount: number;
  record: Uint8Array | null;
  dataOffset: number;
}

export function getOutputExtension(): string {
  return AILY_ANIM_EXTENSION;
}

export function getRgb565FrameSize(width: number, height: number): number {
  assertIntegerInRange(width, 1, 0xffff, 'width');
  assertIntegerInRange(height, 1, 0xffff, 'height');
  const size = width * height * 2;
  if (!Number.isSafeInteger(size) || size > UINT32_MAX) {
    throw new Error('RGB565 单帧大小超出 AANI v2 浏览器编码器限制');
  }
  return size;
}

/** Convert RGBA8888 to the normative rounded RGB565 representation. */
export function packRgbaToRgb565(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  background = 0x0000,
): Uint16Array {
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || rgba.byteLength < pixelCount * 4) {
    throw new Error('RGBA 帧数据长度与目标尺寸不匹配');
  }
  const bgRed5 = (background >>> 11) & 0x1f;
  const bgGreen6 = (background >>> 5) & 0x3f;
  const bgBlue5 = background & 0x1f;
  const bgRed = Math.floor((bgRed5 * 255 + 15) / 31);
  const bgGreen = Math.floor((bgGreen6 * 255 + 31) / 63);
  const bgBlue = Math.floor((bgBlue5 * 255 + 15) / 31);
  const pixels = new Uint16Array(pixelCount);

  for (let pixelIndex = 0, source = 0; pixelIndex < pixelCount; pixelIndex++, source += 4) {
    const alpha = rgba[source + 3];
    const red = blendChannel(rgba[source], bgRed, alpha);
    const green = blendChannel(rgba[source + 1], bgGreen, alpha);
    const blue = blendChannel(rgba[source + 2], bgBlue, alpha);
    const red5 = Math.floor((red * 31 + 127) / 255);
    const green6 = Math.floor((green * 63 + 127) / 255);
    const blue5 = Math.floor((blue * 31 + 127) / 255);
    pixels[pixelIndex] = (red5 << 11) | (green6 << 5) | blue5;
  }
  return pixels;
}

export function buildAilyAnimFile(
  frames: readonly Uint16Array[],
  options: AilyAnimBuildOptions,
): AilyAnimBuildResult {
  if (frames.length === 0) throw new Error('至少需要一帧数据');
  const width = assertIntegerInRange(options.width, 1, 0xffff, 'width');
  const height = assertIntegerInRange(options.height, 1, 0xffff, 'height');
  assertIntegerInRange(frames.length, 1, 0xffff, 'frameCount');
  const fpsNumerator = assertIntegerInRange(options.fpsNumerator, 1, UINT32_MAX, 'fpsNumerator');
  const fpsDenominator = assertIntegerInRange(options.fpsDenominator, 1, UINT32_MAX, 'fpsDenominator');
  const pixelCount = width * height;
  for (let index = 0; index < frames.length; index++) {
    if (frames[index].length !== pixelCount) {
      throw new Error(`第 ${index + 1} 帧像素数量错误：应为 ${pixelCount}`);
    }
  }

  const keyInterval = Math.max(1, Math.min(10_000, Math.round(options.keyIntervalFrames ?? 60)));
  const threshold = Math.min(1, Math.max(0, options.deltaToKeyThreshold ?? 0.85));
  const encodedFrames: EncodedFrame[] = [];
  const stats: AilyAnimEncodingStats = emptyEncodingStats();
  let requiredFeatures = 0;
  let keyFrameCount = 0;
  let deltaFrameCount = 0;
  let holdFrameCount = 0;

  for (let index = 0; index < frames.length; index++) {
    const timestampTicks = frameTimeAt(index, fpsNumerator, fpsDenominator);
    const nextTimestamp = frameTimeAt(index + 1, fpsNumerator, fpsDenominator);
    const durationBig = nextTimestamp - timestampTicks;
    if (durationBig <= 0n || durationBig > BigInt(UINT16_MAX)) {
      throw new Error('帧时长超出 AANI v2 的 u16 毫秒范围');
    }
    const durationTicks = Number(durationBig);
    const mustKey = index === 0 || index % keyInterval === 0;

    if (!mustKey && pixelsEqual(frames[index - 1], frames[index])) {
      encodedFrames.push({
        timestampTicks,
        durationTicks,
        frameType: AilyAnimFrameType.Hold,
        opCount: 0,
        record: null,
        dataOffset: 0,
      });
      requiredFeatures |= AilyAnimFeature.Delta;
      holdFrameCount++;
      continue;
    }

    const keyOperation = chooseOpaqueOperation(frames[index], 0, 0, width, height);
    const keyRecord = buildFrameRecord(keyOperation);
    let operation = keyOperation;
    let record = keyRecord;
    let frameType = AilyAnimFrameType.Key;

    if (!mustKey) {
      const deltaOperation = chooseDeltaOperation(frames[index - 1], frames[index], width, height);
      if (deltaOperation) {
        const deltaRecord = buildFrameRecord(deltaOperation);
        if (operationPlaybackScore(deltaOperation)
            < operationPlaybackScore(keyOperation) * threshold) {
          operation = deltaOperation;
          record = deltaRecord;
          frameType = AilyAnimFrameType.Delta;
        }
      }
    }

    if (frameType === AilyAnimFrameType.Key) keyFrameCount++;
    else {
      deltaFrameCount++;
      requiredFeatures |= AilyAnimFeature.Delta;
    }
    requiredFeatures |= featureForEncoding(operation.encoding);
    updateEncodingStats(stats, operation);
    encodedFrames.push({
      timestampTicks,
      durationTicks,
      frameType,
      opCount: 1,
      record,
      dataOffset: 0,
    });
  }

  let frameDataSize = 0;
  for (const frame of encodedFrames) {
    frame.dataOffset = frameDataSize;
    if (!frame.record) continue;
    frameDataSize += frame.record.byteLength;
    if (frameDataSize > UINT32_MAX) {
      throw new Error('AANI v2 FrameData 超出 u32 相对偏移范围');
    }
  }

  const frameIndexOffset = AILY_ANIM_HEADER_SIZE;
  const frameIndexSize = encodedFrames.length * AILY_ANIM_FRAME_INDEX_SIZE;
  const frameDataOffset = AILY_ANIM_HEADER_SIZE + frameIndexSize;
  const fileSize = frameDataOffset + frameDataSize;
  if (!Number.isSafeInteger(fileSize)) {
    throw new Error('AANI v2 文件大小超出浏览器安全整数范围');
  }

  const file = new Uint8Array(fileSize);
  const view = new DataView(file.buffer);
  writeHeader(view, {
    width,
    height,
    frameCount: encodedFrames.length,
    loopCount: options.loop === false ? 1 : 0,
  });

  encodedFrames.forEach((frame, index) => {
    const offset = frameIndexOffset + index * AILY_ANIM_FRAME_INDEX_SIZE;
    view.setUint32(offset, frame.dataOffset, true);
    view.setUint16(offset + 4, frame.durationTicks, true);
    const meta = frame.frameType === AilyAnimFrameType.Hold
      ? AilyAnimFrameType.Hold
      : ((frame.opCount - 1) << FRAME_META_OP_SHIFT) | frame.frameType;
    view.setUint8(offset + 6, meta);
    if (frame.record) file.set(frame.record, frameDataOffset + frame.dataOffset);
  });

  const durationTicks = frameTimeAt(encodedFrames.length, fpsNumerator, fpsDenominator);
  const rawRgb565Size = pixelCount * 2 * frames.length;
  const info: AilyAnimBuildInfo = {
    width,
    height,
    timescale: AILY_ANIM_TIMESCALE,
    durationTicks,
    frameCount: frames.length,
    loopCount: options.loop === false ? 1 : 0,
    requiredFeatures,
    fileSize,
    frameIndexSize,
    frameDataSize,
    keyFrameCount,
    deltaFrameCount,
    holdFrameCount,
    rawRgb565Size,
    compressionRatio: rawRgb565Size === 0 ? 1 : fileSize / rawRgb565Size,
    frameDurationsTicks: encodedFrames.map(frame => frame.durationTicks),
    encodingStats: stats,
  };
  return { file, info };
}

export function parseAilyAnimFile(input: ArrayBuffer | Uint8Array): ParsedAilyAnimFile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < AILY_ANIM_HEADER_SIZE) throw new Error('AANI v2 文件头不完整');
  for (let index = 0; index < AILY_ANIM_MAGIC.length; index++) {
    if (bytes[index] !== AILY_ANIM_MAGIC.charCodeAt(index)) throw new Error('文件 magic 不是 AANI');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  const canvasWidth = view.getUint16(5, true);
  const canvasHeight = view.getUint16(7, true);
  const frameCount = view.getUint16(9, true);
  const loopCount = view.getUint8(11);
  const headerCrc16 = view.getUint16(12, true);

  if (version !== AILY_ANIM_VERSION) {
    throw new Error(`不支持的 AANI 版本：${version}`);
  }
  if (crc16CcittFalse(bytes.subarray(0, 12)) !== headerCrc16) {
    throw new Error('AANI Header CRC16 校验失败');
  }
  if (canvasWidth === 0 || canvasHeight === 0 || frameCount === 0) {
    throw new Error('AANI 画布尺寸或帧数无效');
  }

  const frameIndexSize = checkedMultiply(frameCount, AILY_ANIM_FRAME_INDEX_SIZE, 'FrameIndex');
  const frameDataOffset = AILY_ANIM_HEADER_SIZE + frameIndexSize;
  assertRange(AILY_ANIM_HEADER_SIZE, frameIndexSize, bytes.byteLength, 'FrameIndex');
  const frameDataSize = bytes.byteLength - frameDataOffset;
  const header: AilyAnimHeaderInfo = {
    magic: 'AANI',
    version,
    requiredFeatures: 0,
    canvasWidth,
    canvasHeight,
    timescale: AILY_ANIM_TIMESCALE,
    frameCount,
    loopCount,
    durationTicks: 0n,
    headerCrc16,
  };

  const parsedFrames: ParsedFrame[] = [];
  const stats = emptyEncodingStats();
  let actualFeatures = 0;
  let timestampTicks = 0n;
  let frameDataCursor = 0;
  let keyFrameCount = 0;
  let deltaFrameCount = 0;
  let holdFrameCount = 0;

  for (let index = 0; index < header.frameCount; index++) {
    const offset = AILY_ANIM_HEADER_SIZE + index * AILY_ANIM_FRAME_INDEX_SIZE;
    const recordOffset = view.getUint32(offset, true);
    const durationTicks = view.getUint16(offset + 4, true);
    const meta = view.getUint8(offset + 6);
    const frameType = meta & FRAME_META_TYPE_MASK;
    const encodedOpCount = meta >>> FRAME_META_OP_SHIFT;
    if (durationTicks === 0) throw new Error(`Frame ${index} duration 必须大于 0`);
    if (frameType === 3) throw new Error(`Frame ${index} 类型无效`);
    const isHold = frameType === AilyAnimFrameType.Hold;
    const opCount = isHold ? 0 : encodedOpCount + 1;
    const frame: ParsedFrame = {
      timestampTicks,
      durationTicks,
      dataOffset: BigInt(recordOffset),
      dataSize: 0,
      opCount,
      frameType: frameType as AilyAnimFrameType,
      operations: [],
    };

    if (isHold) {
      if (index === 0 || recordOffset !== frameDataCursor || encodedOpCount !== 0) {
        throw new Error('HOLD FrameIndex 无效');
      }
      actualFeatures |= AilyAnimFeature.Delta;
      holdFrameCount++;
      parsedFrames.push(frame);
      timestampTicks += BigInt(durationTicks);
      continue;
    }

    if (frame.frameType === AilyAnimFrameType.Key) {
      keyFrameCount++;
    } else {
      if (index === 0) throw new Error('Frame 0 必须是 KEY');
      actualFeatures |= AilyAnimFeature.Delta;
      deltaFrameCount++;
    }

    if (recordOffset !== frameDataCursor) {
      throw new Error(`Frame ${index} recordOffset 不连续`);
    }
    const parsedRecord = parseFrameRecord(
      bytes,
      frameDataOffset + recordOffset,
      frame.opCount,
      header,
      stats,
    );
    frame.operations = parsedRecord.operations;
    frame.dataSize = parsedRecord.dataSize;
    frameDataCursor += parsedRecord.dataSize;
    for (const operation of frame.operations) actualFeatures |= featureForEncoding(operation.encoding);
    if (frame.frameType === AilyAnimFrameType.Key) validateKeyCoverage(frame, header);
    parsedFrames.push(frame);
    timestampTicks += BigInt(durationTicks);
  }

  if (parsedFrames[0].frameType !== AilyAnimFrameType.Key) throw new Error('Frame 0 必须是 KEY');
  if (frameDataCursor !== frameDataSize) {
    throw new Error('FrameData 包含未索引的尾随字节');
  }
  header.durationTicks = timestampTicks;
  header.requiredFeatures = actualFeatures;

  return {
    bytes,
    header,
    frames: parsedFrames,
    frameIndexSize,
    frameDataSize,
    keyFrameCount,
    deltaFrameCount,
    holdFrameCount,
    encodingStats: stats,
    _decodedFrames: parsedFrames,
  };
}

export function validateAilyAnimFile(input: ArrayBuffer | Uint8Array): void {
  parseAilyAnimFile(input);
}

export function decodeAilyAnimFrame(
  input: ArrayBuffer | Uint8Array,
  frameIndex: number,
): { rgba: Uint8ClampedArray; timestampTicks: bigint; durationTicks: number } {
  const parsed = parseAilyAnimFile(input);
  return decodeParsedAilyAnimFrame(parsed, frameIndex);
}

/** Decode from an already validated parse tree, avoiding repeated CRC/index scans in preview loops. */
export function decodeParsedAilyAnimFrame(
  parsed: ParsedAilyAnimFile,
  frameIndex: number,
): { rgba: Uint8ClampedArray; timestampTicks: bigint; durationTicks: number } {
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= parsed.header.frameCount) {
    throw new Error('预览帧索引越界');
  }
  let keyIndex = frameIndex;
  while (keyIndex > 0 && parsed._decodedFrames[keyIndex].frameType !== AilyAnimFrameType.Key) keyIndex--;
  const canvas = new Uint16Array(parsed.header.canvasWidth * parsed.header.canvasHeight);
  for (let index = keyIndex; index <= frameIndex; index++) {
    const frame = parsed._decodedFrames[index];
    if (frame.frameType === AilyAnimFrameType.Hold) continue;
    for (const operation of frame.operations) applyOperation(canvas, parsed.header, operation);
  }
  const rgba = unpackRgb565ToRgba(canvas);
  const frame = parsed._decodedFrames[frameIndex];
  return { rgba, timestampTicks: frame.timestampTicks, durationTicks: frame.durationTicks };
}

/** Stateful decoder for smooth sequential preview; random seeks restart at the nearest Key. */
export class AilyAnimPreviewDecoder {
  private readonly canvas: Uint16Array;
  private currentFrame = -1;

  constructor(private readonly parsed: ParsedAilyAnimFile) {
    this.canvas = new Uint16Array(parsed.header.canvasWidth * parsed.header.canvasHeight);
  }

  decode(frameIndex: number): { rgba: Uint8ClampedArray; timestampTicks: bigint; durationTicks: number } {
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= this.parsed.header.frameCount) {
      throw new Error('预览帧索引越界');
    }
    let start = this.currentFrame + 1;
    if (this.currentFrame < 0 || frameIndex < this.currentFrame) {
      start = frameIndex;
      while (start > 0 && this.parsed._decodedFrames[start].frameType !== AilyAnimFrameType.Key) start--;
      this.canvas.fill(0);
      this.currentFrame = start - 1;
    }
    for (let index = start; index <= frameIndex; index++) {
      const frame = this.parsed._decodedFrames[index];
      if (frame.frameType !== AilyAnimFrameType.Hold) {
        for (const operation of frame.operations) applyOperation(this.canvas, this.parsed.header, operation);
      }
      this.currentFrame = index;
    }
    const frame = this.parsed._decodedFrames[frameIndex];
    return {
      rgba: unpackRgb565ToRgba(this.canvas),
      timestampTicks: frame.timestampTicks,
      durationTicks: frame.durationTicks,
    };
  }
}

export function unpackRgb565ToRgba(pixels: Uint16Array): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(pixels.length * 4);
  for (let index = 0; index < pixels.length; index++) {
    const value = pixels[index];
    const red5 = (value >>> 11) & 0x1f;
    const green6 = (value >>> 5) & 0x3f;
    const blue5 = value & 0x1f;
    const target = index * 4;
    rgba[target] = Math.floor((red5 * 255 + 15) / 31);
    rgba[target + 1] = Math.floor((green6 * 255 + 31) / 63);
    rgba[target + 2] = Math.floor((blue5 * 255 + 15) / 31);
    rgba[target + 3] = 255;
  }
  return rgba;
}

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xffff, refin/refout false, xorout 0. */
export function crc16CcittFalse(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = ((crc << 1) ^ ((crc & 0x8000) !== 0 ? 0x1021 : 0)) & 0xffff;
    }
  }
  return crc;
}

function chooseOpaqueOperation(
  pixels: Uint16Array,
  x: number,
  y: number,
  width: number,
  height: number,
): EncodedOperation {
  if (pixels.length > 0 && pixels.every(pixel => pixel === pixels[0])) {
    return {
      opcode: OP_FILL_RECT,
      encoding: AilyAnimEncoding.None,
      alphaMode: 0,
      x,
      y,
      width,
      height,
      payload: new Uint8Array(),
      aux: pixels[0],
      estimatedDrawCalls: 1,
      maskScanPixels: 0,
      decodedPixels: 0,
    };
  }
  const raw = rgb565Bytes(pixels);
  const rle = encodeRle565(pixels);
  const estimatedDrawCalls = estimateOpaqueDrawCalls(width, height);
  const rawOperation: EncodedOperation = {
    opcode: OP_DRAW_RECT,
    encoding: AilyAnimEncoding.Raw565,
    alphaMode: 0,
    x,
    y,
    width,
    height,
    payload: raw,
    aux: pixels.length,
    estimatedDrawCalls,
    maskScanPixels: 0,
    decodedPixels: pixels.length,
  };
  if (!rleWorthwhile(raw.byteLength, rle.byteLength)) return rawOperation;
  const rleOperation: EncodedOperation = {
    ...rawOperation,
    encoding: AilyAnimEncoding.Rle565,
    payload: rle,
  };
  return compareOperationCost(rawOperation, rleOperation) <= 0
    ? rawOperation : rleOperation;
}

interface MaskCandidateData {
  mask: Uint8Array;
  colors: Uint16Array;
  drawCalls: number;
}

function estimateOpaqueDrawCalls(width: number, height: number): number {
  if (width <= PLAYBACK_BATCH_PIXELS) {
    const rowsPerBatch = Math.max(1, Math.floor(PLAYBACK_BATCH_PIXELS / width));
    return Math.ceil(height / rowsPerBatch);
  }
  return height * Math.ceil(width / PLAYBACK_BATCH_PIXELS);
}

function rleWorthwhile(rawBytes: number, rleBytes: number): boolean {
  const saving = rawBytes - rleBytes;
  return saving >= Math.max(
    RLE_MIN_SAVING_BYTES,
    Math.ceil(rawBytes * RLE_MIN_SAVING_RATIO),
  );
}

function operationPlaybackScore(operation: EncodedOperation): number {
  let score = OP_HEADER_SIZE + operation.payload.byteLength;
  score += operation.estimatedDrawCalls * PLAYBACK_DRAW_CALL_COST;
  if (operation.maskScanPixels > 0) {
    score += Math.ceil(operation.maskScanPixels / PLAYBACK_MASK_SCAN_DIVISOR);
  }
  if (operation.encoding === AilyAnimEncoding.Rle565
      || operation.encoding === AilyAnimEncoding.Mask1Rle565) {
    score += Math.ceil(operation.decodedPixels / PLAYBACK_RLE_DECODE_DIVISOR);
  }
  return score;
}

function compareOperationCost(left: EncodedOperation, right: EncodedOperation): number {
  return operationPlaybackScore(left) - operationPlaybackScore(right)
    || left.payload.byteLength - right.payload.byteLength
    || left.encoding - right.encoding;
}

function buildMaskCandidate(
  previous: Uint16Array,
  current: Uint16Array,
  canvasWidth: number,
  minX: number,
  minY: number,
  width: number,
  height: number,
  maxMergeGap: number,
): MaskCandidateData {
  const mask = new Uint8Array(Math.ceil(width * height / 8));
  const colors: number[] = [];
  let drawCalls = 0;

  const appendSpan = (row: number, start: number, end: number): void => {
    const spanLength = end - start + 1;
    drawCalls += Math.ceil(spanLength / PLAYBACK_BATCH_PIXELS);
    for (let x = start; x <= end; x++) {
      const target = row * width + x;
      const source = (minY + row) * canvasWidth + minX + x;
      mask[target >> 3] |= 1 << (target & 7);
      colors.push(current[source]);
    }
  };

  for (let row = 0; row < height; row++) {
    let runStart = -1;
    let runEnd = -1;
    for (let x = 0; x < width; x++) {
      const source = (minY + row) * canvasWidth + minX + x;
      if (current[source] === previous[source]) continue;
      if (runStart < 0) {
        runStart = x;
        runEnd = x;
      } else if (x - runEnd - 1 <= maxMergeGap) {
        runEnd = x;
      } else {
        appendSpan(row, runStart, runEnd);
        runStart = x;
        runEnd = x;
      }
    }
    if (runStart >= 0) appendSpan(row, runStart, runEnd);
  }

  return { mask, colors: Uint16Array.from(colors), drawCalls };
}

function buildMaskOperations(
  data: MaskCandidateData,
  x: number,
  y: number,
  width: number,
  height: number,
): EncodedOperation[] {
  if (data.drawCalls === 0 || data.colors.length === 0) return [];
  const rawColors = rgb565Bytes(data.colors);
  const rawOperation: EncodedOperation = {
    opcode: OP_DRAW_RECT,
    encoding: AilyAnimEncoding.Mask1Raw565,
    alphaMode: 1,
    x,
    y,
    width,
    height,
    payload: concatBytes(data.mask, rawColors),
    aux: data.colors.length,
    estimatedDrawCalls: data.drawCalls,
    maskScanPixels: width * height,
    decodedPixels: data.colors.length,
  };
  const operations = [rawOperation];
  const rleColors = encodeRle565(data.colors);
  if (rleWorthwhile(rawColors.byteLength, rleColors.byteLength)) {
    operations.push({
      ...rawOperation,
      encoding: AilyAnimEncoding.Mask1Rle565,
      payload: concatBytes(data.mask, rleColors),
    });
  }
  return operations;
}

function maskOperationIsWorthwhile(
  operation: EncodedOperation,
  bestOpaque: EncodedOperation,
): boolean {
  const saving = bestOpaque.payload.byteLength - operation.payload.byteLength;
  const minimumSaving = Math.max(
    MASK_MIN_SAVING_BYTES,
    Math.ceil(bestOpaque.payload.byteLength * MASK_MIN_SAVING_RATIO),
  );
  const averageRun = operation.estimatedDrawCalls === 0
    ? 0 : operation.decodedPixels / operation.estimatedDrawCalls;
  return saving >= minimumSaving
    && operation.estimatedDrawCalls <= MASK_MAX_DRAW_CALLS
    && (operation.estimatedDrawCalls <= MASK_SHORT_RUN_GRACE_CALLS
      || averageRun >= MASK_MIN_AVERAGE_RUN_PIXELS);
}

function chooseDeltaOperation(
  previous: Uint16Array,
  current: Uint16Array,
  canvasWidth: number,
  canvasHeight: number,
): EncodedOperation | null {
  let minX = canvasWidth;
  let minY = canvasHeight;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0; index < current.length; index++) {
    if (previous[index] === current[index]) continue;
    const x = index % canvasWidth;
    const y = Math.floor(index / canvasWidth);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < minX || maxY < minY) return null;
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const count = width * height;
  const rectPixels = new Uint16Array(count);
  let target = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++, target++) {
      const source = y * canvasWidth + x;
      const value = current[source];
      rectPixels[target] = value;
    }
  }

  const raw = rgb565Bytes(rectPixels);
  const rle = encodeRle565(rectPixels);
  const estimatedDrawCalls = estimateOpaqueDrawCalls(width, height);
  const rawOperation: EncodedOperation = {
    opcode: OP_DRAW_RECT,
    encoding: AilyAnimEncoding.Raw565,
    alphaMode: 0,
    x: minX,
    y: minY,
    width,
    height,
    payload: raw,
    aux: count,
    estimatedDrawCalls,
    maskScanPixels: 0,
    decodedPixels: count,
  };
  const opaqueCandidates = [rawOperation];
  if (rleWorthwhile(raw.byteLength, rle.byteLength)) {
    opaqueCandidates.push({
      ...rawOperation,
      encoding: AilyAnimEncoding.Rle565,
      payload: rle,
    });
  }
  if (rectPixels.every(pixel => pixel === rectPixels[0])) {
    opaqueCandidates.push({
      opcode: OP_FILL_RECT,
      encoding: AilyAnimEncoding.None,
      alphaMode: 0,
      x: minX,
      y: minY,
      width,
      height,
      payload: new Uint8Array(0),
      aux: rectPixels[0],
      estimatedDrawCalls: 1,
      maskScanPixels: 0,
      decodedPixels: 0,
    });
  }
  opaqueCandidates.sort(compareOperationCost);
  const bestOpaque = opaqueCandidates[0];

  // Exact masks minimize bytes. Densified masks additionally redraw short
  // unchanged gaps with their current colors, which is visually identical
  // but collapses many tiny horizontal runs into a few useful transfers.
  const exactMask = buildMaskCandidate(
    previous, current, canvasWidth, minX, minY, width, height, 0);
  const denseMask = buildMaskCandidate(
    previous, current, canvasWidth, minX, minY, width, height,
    MASK_DENSIFY_GAP_PIXELS);
  const maskCandidates = [
    ...buildMaskOperations(exactMask, minX, minY, width, height),
    ...buildMaskOperations(denseMask, minX, minY, width, height),
  ].filter(candidate => maskOperationIsWorthwhile(candidate, bestOpaque));

  const candidates = [bestOpaque, ...maskCandidates];
  candidates.sort(compareOperationCost);
  return candidates[0];
}

function buildFrameRecord(operation: EncodedOperation): Uint8Array {
  assertIntegerInRange(operation.x, 0, 0xffff, 'operation.x');
  assertIntegerInRange(operation.y, 0, 0xffff, 'operation.y');
  assertIntegerInRange(operation.width, 1, 0xffff, 'operation.width');
  assertIntegerInRange(operation.height, 1, 0xffff, 'operation.height');
  let kind: number;
  let data: number;
  if (operation.opcode === OP_FILL_RECT) {
    if (operation.encoding !== AilyAnimEncoding.None || operation.alphaMode !== 0
      || operation.payload.byteLength !== 0 || operation.aux > 0xffff) {
      throw new Error('AANI FILL operation 无效');
    }
    kind = AilyAnimEncoding.None;
    data = operation.aux;
  } else {
    if (operation.opcode !== OP_DRAW_RECT
      || operation.encoding < AilyAnimEncoding.Raw565
      || operation.encoding > AilyAnimEncoding.Mask1Rle565
      || operation.payload.byteLength === 0
      || operation.payload.byteLength > UINT24_MAX) {
      throw new Error('AANI DRAW operation 或 u24 payload 长度无效');
    }
    kind = operation.encoding;
    data = operation.payload.byteLength;
  }

  const record = new Uint8Array(OP_HEADER_SIZE + operation.payload.byteLength);
  const view = new DataView(record.buffer);
  view.setUint8(0, kind);
  view.setUint16(1, operation.x, true);
  view.setUint16(3, operation.y, true);
  view.setUint16(5, operation.width, true);
  view.setUint16(7, operation.height, true);
  writeUint24(view, 9, data);
  record.set(operation.payload, OP_HEADER_SIZE);
  return record;
}

function writeHeader(
  view: DataView,
  values: {
    width: number;
    height: number;
    frameCount: number;
    loopCount: number;
  },
): void {
  assertIntegerInRange(values.width, 1, 0xffff, 'width');
  assertIntegerInRange(values.height, 1, 0xffff, 'height');
  assertIntegerInRange(values.frameCount, 1, 0xffff, 'frameCount');
  assertIntegerInRange(values.loopCount, 0, 0xff, 'loopCount');
  for (let index = 0; index < AILY_ANIM_MAGIC.length; index++) {
    view.setUint8(index, AILY_ANIM_MAGIC.charCodeAt(index));
  }
  view.setUint8(4, AILY_ANIM_VERSION);
  view.setUint16(5, values.width, true);
  view.setUint16(7, values.height, true);
  view.setUint16(9, values.frameCount, true);
  view.setUint8(11, values.loopCount);
  const headerPrefix = new Uint8Array(view.buffer, view.byteOffset, 12);
  view.setUint16(12, crc16CcittFalse(headerPrefix), true);
}

function parseFrameRecord(
  bytes: Uint8Array,
  recordOffset: number,
  opCount: number,
  header: AilyAnimHeaderInfo,
  stats: AilyAnimEncodingStats,
): { operations: ParsedOperation[]; dataSize: number } {
  assertIntegerInRange(opCount, 1, MAX_OPS_PER_FRAME, 'opCount');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const operations: ParsedOperation[] = [];
  let cursor = recordOffset;
  for (let index = 0; index < opCount; index++) {
    assertRange(cursor, OP_HEADER_SIZE, bytes.byteLength, `Operation ${index} Header`);
    const kind = view.getUint8(cursor);
    const x = view.getUint16(cursor + 1, true);
    const y = view.getUint16(cursor + 3, true);
    const width = view.getUint16(cursor + 5, true);
    const height = view.getUint16(cursor + 7, true);
    const data = readUint24(view, cursor + 9);
    cursor += OP_HEADER_SIZE;

    if (kind > AilyAnimEncoding.Mask1Rle565 || width === 0 || height === 0) {
      throw new Error(`Operation ${index} kind 或尺寸无效`);
    }
    if (x + width > header.canvasWidth || y + height > header.canvasHeight) {
      throw new Error(`Operation ${index} 超出画布`);
    }

    const opcode = kind === AilyAnimEncoding.None ? OP_FILL_RECT : OP_DRAW_RECT;
    const encoding = kind as AilyAnimEncoding;
    const alphaMode = kind === AilyAnimEncoding.Mask1Raw565
      || kind === AilyAnimEncoding.Mask1Rle565 ? 1 : 0;
    let payload: Uint8Array = new Uint8Array();
    let aux = data;
    if (opcode === OP_FILL_RECT) {
      if (data > 0xffff) throw new Error('FILL data 高 8 位必须为 0');
    } else {
      if (data === 0) throw new Error('DRAW payload 不得为空');
      assertRange(cursor, data, bytes.byteLength, `Operation ${index} payload`);
      payload = bytes.subarray(cursor, cursor + data);
      cursor += data;
      const sampleCount = width * height;
      if (encoding === AilyAnimEncoding.Mask1Raw565
        || encoding === AilyAnimEncoding.Mask1Rle565) {
        const maskSize = Math.ceil(sampleCount / 8);
        if (payload.byteLength < maskSize) throw new Error('MASK1 mask 被截断');
        aux = popcountMask(payload.subarray(0, maskSize), sampleCount);
      } else {
        aux = sampleCount;
      }
    }
    const operation: ParsedOperation = { opcode, encoding, alphaMode, x, y, width, height, payload, aux };
    validateOperationPayload(operation);
    updateEncodingStats(stats, operation);
    operations.push(operation);
  }
  return { operations, dataSize: cursor - recordOffset };
}

function validateOperationPayload(operation: ParsedOperation): void {
  if (operation.opcode === OP_FILL_RECT) {
    if (operation.encoding !== AilyAnimEncoding.None || operation.alphaMode !== 0
      || operation.payload.byteLength !== 0 || (operation.aux & 0xffff_0000) !== 0) {
      throw new Error('FILL_RECT payload 无效');
    }
    return;
  }
  const sampleCount = operation.width * operation.height;
  if (operation.encoding === AilyAnimEncoding.Raw565) {
    if (operation.alphaMode !== 0 || operation.aux !== sampleCount
      || operation.payload.byteLength !== sampleCount * 2) throw new Error('RAW565 payload 无效');
    return;
  }
  if (operation.encoding === AilyAnimEncoding.Rle565) {
    if (operation.alphaMode !== 0 || operation.aux !== sampleCount) throw new Error('RLE565 Header 无效');
    decodeRle565(operation.payload, sampleCount);
    return;
  }
  if (operation.encoding !== AilyAnimEncoding.Mask1Raw565
    && operation.encoding !== AilyAnimEncoding.Mask1Rle565) {
    throw new Error(`不支持的 encoding ${operation.encoding}`);
  }
  if (operation.alphaMode !== 1) throw new Error('MASK1 alpha_mode 无效');
  const maskSize = Math.ceil(sampleCount / 8);
  if (operation.payload.byteLength < maskSize) throw new Error('MASK1 mask 被截断');
  const mask = operation.payload.subarray(0, maskSize);
  const covered = popcountMask(mask, sampleCount);
  if (operation.aux !== covered) throw new Error('MASK1 aux 与 popcount 不一致');
  const colors = operation.payload.subarray(maskSize);
  if (operation.encoding === AilyAnimEncoding.Mask1Raw565) {
    if (colors.byteLength !== covered * 2) throw new Error('MASK1 RAW 颜色流长度错误');
  } else {
    decodeRle565(colors, covered);
  }
}

function validateKeyCoverage(frame: ParsedFrame, header: AilyAnimHeaderInfo): void {
  if (frame.operations.length === 0) throw new Error('KEY 必须包含至少一个操作');
  const operation = frame.operations[0];
  const isOpaqueDraw = operation.opcode === OP_DRAW_RECT
    && operation.alphaMode === 0
    && (operation.encoding === AilyAnimEncoding.Raw565
      || operation.encoding === AilyAnimEncoding.Rle565);
  const isFill = operation.opcode === OP_FILL_RECT
    && operation.alphaMode === 0
    && operation.encoding === AilyAnimEncoding.None;
  if (operation.x !== 0 || operation.y !== 0
    || operation.width !== header.canvasWidth || operation.height !== header.canvasHeight
    || (!isOpaqueDraw && !isFill)) {
    throw new Error('KEY 不是自包含完整画布');
  }
}

function applyOperation(canvas: Uint16Array, header: AilyAnimHeaderInfo, operation: ParsedOperation): void {
  if (operation.opcode === OP_FILL_RECT) {
    const color = operation.aux & 0xffff;
    const startX = Math.max(0, operation.x);
    const endX = Math.min(header.canvasWidth, operation.x + operation.width);
    const startY = Math.max(0, operation.y);
    const endY = Math.min(header.canvasHeight, operation.y + operation.height);
    for (let targetY = startY; targetY < endY; targetY++) {
      canvas.fill(color, targetY * header.canvasWidth + startX, targetY * header.canvasWidth + endX);
    }
    return;
  }
  const sampleCount = operation.width * operation.height;
  let mask: Uint8Array | null = null;
  let colors: Uint16Array;
  if (operation.encoding === AilyAnimEncoding.Raw565) {
    colors = readRaw565(operation.payload, sampleCount);
  } else if (operation.encoding === AilyAnimEncoding.Rle565) {
    colors = decodeRle565(operation.payload, sampleCount);
  } else {
    const maskSize = Math.ceil(sampleCount / 8);
    mask = operation.payload.subarray(0, maskSize);
    const colorPayload = operation.payload.subarray(maskSize);
    colors = operation.encoding === AilyAnimEncoding.Mask1Raw565
      ? readRaw565(colorPayload, operation.aux)
      : decodeRle565(colorPayload, operation.aux);
  }

  let colorIndex = 0;
  for (let localY = 0, sample = 0; localY < operation.height; localY++) {
    const targetY = operation.y + localY;
    for (let localX = 0; localX < operation.width; localX++, sample++) {
      const covered = !mask || ((mask[sample >> 3] >> (sample & 7)) & 1) !== 0;
      if (!covered) continue;
      const color = colors[colorIndex++];
      const targetX = operation.x + localX;
      if (targetX >= 0 && targetX < header.canvasWidth && targetY >= 0 && targetY < header.canvasHeight) {
        canvas[targetY * header.canvasWidth + targetX] = color;
      }
    }
  }
}

function encodeRle565(pixels: Uint16Array): Uint8Array {
  const output: number[] = [];
  let index = 0;
  while (index < pixels.length) {
    let runLength = 1;
    while (index + runLength < pixels.length
      && runLength < 128
      && pixels[index + runLength] === pixels[index]) runLength++;
    if (runLength >= 2) {
      output.push(0x80 | (runLength - 1), pixels[index] & 0xff, pixels[index] >>> 8);
      index += runLength;
      continue;
    }
    const literalStart = index++;
    while (index < pixels.length && index - literalStart < 128) {
      let nextRun = 1;
      while (index + nextRun < pixels.length
        && nextRun < 128
        && pixels[index + nextRun] === pixels[index]) nextRun++;
      if (nextRun >= 2) break;
      index++;
    }
    const literalLength = index - literalStart;
    output.push(literalLength - 1);
    for (let sample = literalStart; sample < index; sample++) {
      output.push(pixels[sample] & 0xff, pixels[sample] >>> 8);
    }
  }
  return Uint8Array.from(output);
}

function decodeRle565(payload: Uint8Array, expectedSamples: number): Uint16Array {
  const output = new Uint16Array(expectedSamples);
  let source = 0;
  let target = 0;
  while (source < payload.byteLength) {
    const control = payload[source++];
    const count = (control & 0x7f) + 1;
    if (target + count > expectedSamples) throw new Error('RLE565 输出样本过多');
    if ((control & 0x80) !== 0) {
      if (source + 2 > payload.byteLength) throw new Error('RLE565 repeat 包被截断');
      const color = payload[source] | (payload[source + 1] << 8);
      source += 2;
      output.fill(color, target, target + count);
      target += count;
    } else {
      const byteCount = count * 2;
      if (source + byteCount > payload.byteLength) throw new Error('RLE565 literal 包被截断');
      for (let index = 0; index < count; index++) {
        output[target++] = payload[source] | (payload[source + 1] << 8);
        source += 2;
      }
    }
  }
  if (target !== expectedSamples) throw new Error('RLE565 输出样本不足');
  return output;
}

function readRaw565(payload: Uint8Array, expectedSamples: number): Uint16Array {
  if (payload.byteLength !== expectedSamples * 2) throw new Error('RAW565 长度错误');
  const pixels = new Uint16Array(expectedSamples);
  for (let index = 0; index < expectedSamples; index++) {
    pixels[index] = payload[index * 2] | (payload[index * 2 + 1] << 8);
  }
  return pixels;
}

function rgb565Bytes(pixels: Uint16Array): Uint8Array {
  const bytes = new Uint8Array(pixels.length * 2);
  for (let index = 0; index < pixels.length; index++) {
    bytes[index * 2] = pixels[index] & 0xff;
    bytes[index * 2 + 1] = pixels[index] >>> 8;
  }
  return bytes;
}

function frameTimeAt(index: number, numerator: number, denominator: number): bigint {
  const scaled = BigInt(index) * BigInt(AILY_ANIM_TIMESCALE) * BigInt(denominator);
  return (scaled + BigInt(Math.floor(numerator / 2))) / BigInt(numerator);
}

function featureForEncoding(encoding: AilyAnimEncoding): number {
  if (encoding === AilyAnimEncoding.None) return 0;
  if (encoding === AilyAnimEncoding.Raw565) return AilyAnimFeature.Raw565;
  if (encoding === AilyAnimEncoding.Rle565) return AilyAnimFeature.Rle565;
  if (encoding === AilyAnimEncoding.Mask1Raw565) return AilyAnimFeature.Mask1;
  if (encoding === AilyAnimEncoding.Mask1Rle565) return AilyAnimFeature.Mask1 | AilyAnimFeature.Rle565;
  throw new Error(`未知 encoding ${encoding}`);
}

function updateEncodingStats(
  stats: AilyAnimEncodingStats,
  operation: Pick<EncodedOperation, 'opcode' | 'encoding' | 'payload' | 'width' | 'height'>,
): void {
  stats.raw565Bytes += operation.width * operation.height * 2;
  stats.encodedPayloadBytes += operation.payload.byteLength;
  if (operation.opcode === OP_FILL_RECT) stats.fillOps++;
  else if (operation.encoding === AilyAnimEncoding.Raw565) stats.raw565Ops++;
  else if (operation.encoding === AilyAnimEncoding.Rle565) stats.rle565Ops++;
  else if (operation.encoding === AilyAnimEncoding.Mask1Raw565) stats.mask1RawOps++;
  else if (operation.encoding === AilyAnimEncoding.Mask1Rle565) stats.mask1RleOps++;
}

function emptyEncodingStats(): AilyAnimEncodingStats {
  return {
    fillOps: 0,
    raw565Ops: 0,
    rle565Ops: 0,
    mask1RawOps: 0,
    mask1RleOps: 0,
    raw565Bytes: 0,
    encodedPayloadBytes: 0,
  };
}

function pixelsEqual(a: Uint16Array, b: Uint16Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function popcountMask(mask: Uint8Array, sampleCount: number): number {
  let count = 0;
  for (let sample = 0; sample < sampleCount; sample++) count += (mask[sample >> 3] >> (sample & 7)) & 1;
  if (sampleCount % 8 !== 0) {
    const validBits = sampleCount % 8;
    const invalidMask = 0xff << validBits;
    if ((mask[mask.length - 1] & invalidMask) !== 0) throw new Error('MASK1 行尾填充位必须为 0');
  }
  return count;
}

function blendChannel(source: number, background: number, alpha: number): number {
  return alpha === 255 ? source : Math.floor((source * alpha + background * (255 - alpha) + 127) / 255);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a);
  result.set(b, a.byteLength);
  return result;
}

function readUint24(view: DataView, offset: number): number {
  return view.getUint8(offset)
    | (view.getUint8(offset + 1) << 8)
    | (view.getUint8(offset + 2) << 16);
}

function writeUint24(view: DataView, offset: number, value: number): void {
  assertIntegerInRange(value, 0, UINT24_MAX, 'u24');
  view.setUint8(offset, value & 0xff);
  view.setUint8(offset + 1, (value >>> 8) & 0xff);
  view.setUint8(offset + 2, (value >>> 16) & 0xff);
}

function checkedMultiply(a: number, b: number, name: string): number {
  const result = a * b;
  if (!Number.isSafeInteger(result)) throw new Error(`${name} 大小溢出`);
  return result;
}

function assertRange(offset: number, size: number, parentSize: number, name: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0
    || offset > parentSize || size > parentSize - offset) {
    throw new Error(`${name} 越界`);
  }
}

function assertIntegerInRange(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 的整数`);
  }
  return value;
}
