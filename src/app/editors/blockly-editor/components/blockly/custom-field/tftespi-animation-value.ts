import {
  AILY_ANIM_EXTENSION,
  AILY_ANIM_TIMESCALE,
  ParsedAilyAnimFile,
  parseAilyAnimFile,
} from './aani-v2';

export const TFTESPI_ANIMATION_VALUE_VERSION = 4 as const;
export const TFTESPI_ANIMATION_FORMAT = 'aani' as const;
export const TFTESPI_ANIMATION_ENCODING = 'base64' as const;
export const TFTESPI_ANIMATION_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const TFTESPI_ANIMATION_MAX_DIMENSION = 480;
export const TFTESPI_ANIMATION_MAX_FRAMES = 300;

export interface TftEsPiAnimationValue {
  version: typeof TFTESPI_ANIMATION_VALUE_VERSION;
  format: typeof TFTESPI_ANIMATION_FORMAT;
  encoding: typeof TFTESPI_ANIMATION_ENCODING;
  extension: typeof AILY_ANIM_EXTENSION;
  data: string;
  width: number;
  height: number;
  frameCount: number;
  durationTicks: string;
  timescale: number;
  sourceName?: string;
  sourcePath?: string;
}

export interface ValidatedTftEsPiAnimationValue {
  value: TftEsPiAnimationValue;
  bytes: Uint8Array | null;
  parsed: ParsedAilyAnimFile | null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  if (!base64 || base64.includes(',') || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error('AANI data 必须是无前缀的标准 Base64');
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function createEmptyTftEsPiAnimationValue(width = 160, height = 120): TftEsPiAnimationValue {
  return {
    version: TFTESPI_ANIMATION_VALUE_VERSION,
    format: TFTESPI_ANIMATION_FORMAT,
    encoding: TFTESPI_ANIMATION_ENCODING,
    extension: AILY_ANIM_EXTENSION,
    data: '',
    width,
    height,
    frameCount: 0,
    durationTicks: '0',
    timescale: AILY_ANIM_TIMESCALE,
  };
}

export function createTftEsPiAnimationValue(
  bytes: Uint8Array,
  source?: Pick<TftEsPiAnimationValue, 'sourceName' | 'sourcePath'>,
): ValidatedTftEsPiAnimationValue {
  validateFieldProfileBytes(bytes);
  const parsed = parseAilyAnimFile(bytes);
  validateFieldProfileHeader(parsed);
  const value: TftEsPiAnimationValue = {
    version: TFTESPI_ANIMATION_VALUE_VERSION,
    format: TFTESPI_ANIMATION_FORMAT,
    encoding: TFTESPI_ANIMATION_ENCODING,
    extension: AILY_ANIM_EXTENSION,
    data: bytesToBase64(bytes),
    width: parsed.header.canvasWidth,
    height: parsed.header.canvasHeight,
    frameCount: parsed.header.frameCount,
    durationTicks: parsed.header.durationTicks.toString(),
    timescale: parsed.header.timescale,
  };
  if (source?.sourceName) value.sourceName = source.sourceName;
  if (source?.sourcePath) value.sourcePath = source.sourcePath;
  return { value, bytes, parsed };
}

export function validateTftEsPiAnimationValue(
  candidate: unknown,
  emptyWidth = 160,
  emptyHeight = 120,
): ValidatedTftEsPiAnimationValue {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('动画字段值必须是对象');
  }
  const input = candidate as Record<string, unknown>;
  if (['frames', 'fps', 'maxFrames', 'sourceType'].some(key => key in input)
    || input['format'] === 'rgb565' || input['format'] === 'rgb332') {
    throw new Error('不再支持旧版逐帧 RGB 动画字段格式');
  }
  if (input['version'] !== TFTESPI_ANIMATION_VALUE_VERSION
    || input['format'] !== TFTESPI_ANIMATION_FORMAT
    || input['encoding'] !== TFTESPI_ANIMATION_ENCODING
    || input['extension'] !== AILY_ANIM_EXTENSION) {
    throw new Error('动画字段必须使用 AANI v2 Base64 契约');
  }
  if (typeof input['data'] !== 'string') throw new Error('动画字段 data 必须是字符串');
  const sourceName = optionalString(input['sourceName'], 'sourceName');
  const sourcePath = optionalString(input['sourcePath'], 'sourcePath');

  if (input['data'] === '') {
    if (input['frameCount'] !== 0 || input['durationTicks'] !== '0') {
      throw new Error('空动画的帧数与时长必须为 0');
    }
    if (input['width'] === undefined || input['height'] === undefined) {
      throw new Error('空动画也必须显式提供 width 和 height');
    }
    const width = integer(input['width'], 1, TFTESPI_ANIMATION_MAX_DIMENSION, emptyWidth, 'width');
    const height = integer(input['height'], 1, TFTESPI_ANIMATION_MAX_DIMENSION, emptyHeight, 'height');
    requireEqual(input['timescale'], AILY_ANIM_TIMESCALE, 'timescale');
    const value = createEmptyTftEsPiAnimationValue(width, height);
    if (sourceName) value.sourceName = sourceName;
    if (sourcePath) value.sourcePath = sourcePath;
    return { value, bytes: null, parsed: null };
  }

  const maximumBase64Length = Math.ceil(TFTESPI_ANIMATION_MAX_FILE_BYTES / 3) * 4;
  if (input['data'].length > maximumBase64Length) throw new Error('AANI 文件超过 8 MiB 字段限制');
  const bytes = base64ToBytes(input['data']);
  validateFieldProfileBytes(bytes);
  const parsed = parseAilyAnimFile(bytes);
  validateFieldProfileHeader(parsed);
  requireEqual(input['width'], parsed.header.canvasWidth, 'width');
  requireEqual(input['height'], parsed.header.canvasHeight, 'height');
  requireEqual(input['frameCount'], parsed.header.frameCount, 'frameCount');
  requireEqual(input['durationTicks'], parsed.header.durationTicks.toString(), 'durationTicks');
  requireEqual(input['timescale'], parsed.header.timescale, 'timescale');
  const value: TftEsPiAnimationValue = {
    version: TFTESPI_ANIMATION_VALUE_VERSION,
    format: TFTESPI_ANIMATION_FORMAT,
    encoding: TFTESPI_ANIMATION_ENCODING,
    extension: AILY_ANIM_EXTENSION,
    data: input['data'],
    width: parsed.header.canvasWidth,
    height: parsed.header.canvasHeight,
    frameCount: parsed.header.frameCount,
    durationTicks: parsed.header.durationTicks.toString(),
    timescale: parsed.header.timescale,
  };
  if (sourceName) value.sourceName = sourceName;
  if (sourcePath) value.sourcePath = sourcePath;
  return { value, bytes, parsed };
}

function validateFieldProfileBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > TFTESPI_ANIMATION_MAX_FILE_BYTES) {
    throw new Error('AANI 文件超过 8 MiB 字段限制');
  }
  if (bytes.byteLength >= 14) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint16(5, true);
    const height = view.getUint16(7, true);
    const frameCount = view.getUint16(9, true);
    if (width > TFTESPI_ANIMATION_MAX_DIMENSION || height > TFTESPI_ANIMATION_MAX_DIMENSION) {
      throw new Error(`AANI 画布不得超过 ${TFTESPI_ANIMATION_MAX_DIMENSION}x${TFTESPI_ANIMATION_MAX_DIMENSION}`);
    }
    if (frameCount > TFTESPI_ANIMATION_MAX_FRAMES) {
      throw new Error(`AANI 帧数不得超过 ${TFTESPI_ANIMATION_MAX_FRAMES}`);
    }
  }
}

function validateFieldProfileHeader(parsed: ParsedAilyAnimFile): void {
  if (parsed.header.canvasWidth > TFTESPI_ANIMATION_MAX_DIMENSION
    || parsed.header.canvasHeight > TFTESPI_ANIMATION_MAX_DIMENSION) {
    throw new Error(`AANI 画布不得超过 ${TFTESPI_ANIMATION_MAX_DIMENSION}x${TFTESPI_ANIMATION_MAX_DIMENSION}`);
  }
  if (parsed.header.frameCount > TFTESPI_ANIMATION_MAX_FRAMES) {
    throw new Error(`AANI 帧数不得超过 ${TFTESPI_ANIMATION_MAX_FRAMES}`);
  }
}

function requireEqual(actual: unknown, expected: unknown, name: string): void {
  if (actual !== expected) throw new Error(`动画字段 ${name} 与 AANI Header 不一致`);
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function integer(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 的整数`);
  }
  return value as number;
}
