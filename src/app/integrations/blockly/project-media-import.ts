import { MAX_U8G2_BITMAP_DIMENSION, packXbmBitmap, projectDataRuntime } from '@domain/project/project-data/public-api';
import { createElectronProjectDataFileSystem, ProjectDataFileSystem } from '@domain/project/public-api';
import type { AilyDataRef, U8g2BitmapValue } from '@domain/project/project-data/public-api';

type Format = 'rgb565' | 'rgb332';
export interface MediaImportRequest {
  kind: 'tft_image' | 'tft_animation' | 'u8g2_bitmap';
  source: string;
  width: number;
  height: number;
  fps?: number;
  maxFrames?: number;
  format?: Format;
}
export interface MediaDecodeRequest {
  type: 'decode'; requestId: number; fileName: string; mimeType: string; buffer: ArrayBuffer;
  width: number; height: number; fps: number; maxFrames: number; format: Format;
}
export interface MediaDecodeResult {
  width: number; height: number; fps: number; maxFrames: number; format: Format;
  frames: Uint8Array[];
}
interface Dependencies {
  fs: ProjectDataFileSystem;
  decode(request: MediaDecodeRequest): Promise<MediaDecodeResult>;
  put(request: { codec: string; storage: 'raw-v1'; value: Uint8Array }): Promise<AilyDataRef>;
  assertCurrent(): void;
}
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4' };
const U8G2_THRESHOLD = 127;
const GUIDANCE = 'Edit the current text ABS with value unchanged as one JSON media field argument. Preserve the surrounding project source and apply the edited file normally.';

/** Prepares resources for native media fields without changing blocks or the ABS generation. */
export async function importProjectMedia(project: string, params: MediaImportRequest, dependencies?: Dependencies) {
  const session = projectDataRuntime.getSessionToken();
  const deps = dependencies || {
    fs: createElectronProjectDataFileSystem(), decode: decodeProjectMedia,
    put: request => projectDataRuntime.put(request),
    assertCurrent: () => {
      if (!session || session !== projectDataRuntime.getSessionToken()) throw new Error('Project changed during media import.');
    },
  } satisfies Dependencies;
  const integer = (value: unknown, name: string, max: number) => {
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error(`Invalid ${name}; expected an integer from 1 to ${max}.`);
    return Number(value);
  };
  try {
    deps.assertCurrent();
    const kind = params?.kind;
    if (!['tft_image', 'tft_animation', 'u8g2_bitmap'].includes(kind)) throw new Error('Unsupported media kind.');
    if (typeof params.source !== 'string' || !params.source.trim()) throw new Error('A source file is required.');
    const maxDimension = kind === 'u8g2_bitmap' ? MAX_U8G2_BITMAP_DIMENSION : 16384;
    const width = integer(params.width, 'width', maxDimension), height = integer(params.height, 'height', maxDimension);
    const format = params.format ?? 'rgb565';
    if (!['rgb565', 'rgb332'].includes(format)) throw new Error('Unsupported pixel format.');
    const fps = integer(params.fps ?? 10, 'fps', 30);
    const maxFrames = kind === 'tft_animation' ? integer(params.maxFrames ?? 300, 'maxFrames', 300) : 1;
    const frameSize = width * height * (format === 'rgb565' ? 2 : 1);
    if (frameSize > MAX_OUTPUT_BYTES) throw new Error('One frame exceeds the 8 MiB output budget.');
    const source = deps.fs.isAbsolute(params.source) ? params.source : deps.fs.join(project, params.source);
    const fileName = source.split(/[\\/]/).pop()!;
    const ext = fileName.split('.').pop()!.toLowerCase();
    if (!Object.hasOwn(MIME, ext) || (kind !== 'tft_animation' && ext === 'mp4')) throw new Error('Unsupported source format. Use PNG, JPEG, WebP, GIF, or MP4 for TFT animation.');
    const stat = await deps.fs.stat(source);
    if (!stat.isFile || stat.size < 1 || stat.size > MAX_SOURCE_BYTES) throw new Error('Source must be a regular file no larger than 64 MiB.');
    const bytes = await deps.fs.readBinary(source);
    if (bytes.length !== stat.size || bytes.length > MAX_SOURCE_BYTES) throw new Error('Source changed while reading; import the stable file again.');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)), byte => byte.toString(16).padStart(2, '0')).join('');
    const sourcePath = `assets/media-import/${hash}.${ext}`;
    const receipt = { ok: true as const, operation: 'project_media_import', project,
      sourcePath, sourceSha256: hash, sourceBytes: bytes.length, guidance: GUIDANCE };
    if (kind === 'u8g2_bitmap') {
      const packed = await decodeProjectBitmap(bytes.slice().buffer as ArrayBuffer, MIME[ext], width, height);
      deps.assertCurrent();
      await preserveSource(project, sourcePath, bytes, deps);
      deps.assertCurrent();
      const bitmap = await deps.put({ codec: 'u8g2-xbm-v1', storage: 'raw-v1', value: packed });
      deps.assertCurrent();
      const value: U8g2BitmapValue = { schemaVersion: 1, encoding: 'xbm-lsb-row-v1', width, height, bitmap };
      return { ...receipt, kind, fieldType: 'field_bitmap_u8g2', value, decodedBytes: packed.length };
    }
    const result = await deps.decode({ type: 'decode', requestId: 1, fileName, mimeType: MIME[ext],
      buffer: bytes.slice().buffer as ArrayBuffer, width, height, fps, maxFrames, format });
    deps.assertCurrent();
    if (result.width !== width || result.height !== height || result.format !== format || result.fps !== fps
      || result.frames.length < 1 || result.frames.length > maxFrames
      || result.frames.length * frameSize > MAX_OUTPUT_BYTES
      || result.frames.some(frame => !(frame instanceof Uint8Array) || frame.byteLength !== frameSize)) {
      throw new Error('Decoder returned inconsistent media dimensions or frame data.');
    }
    await preserveSource(project, sourcePath, bytes, deps);
    deps.assertCurrent();
    const packed = new Uint8Array(frameSize * result.frames.length);
    result.frames.forEach((frame, i) => packed.set(frame, i * frameSize));
    const frames = await deps.put({ codec: format === 'rgb332' ? 'tft-rgb332-frames-v1' : 'tft-rgb565-be-frames-v1', storage: 'raw-v1', value: packed });
    deps.assertCurrent();
    const value = { schemaVersion: 1, format, encoding: format === 'rgb332' ? 'rgb332' : 'rgb565-be',
      width, height, fps, maxFrames: Math.min(maxFrames, Math.floor(MAX_OUTPUT_BYTES / frameSize)), frameCount: result.frames.length,
      frames, sourceName: fileName, sourceType: MIME[ext], sourcePath };
    return { ...receipt, kind, blockType: kind === 'tft_image' ? 'tftespi_image' : 'tftespi_animation',
      fieldName: kind === 'tft_image' ? 'CUSTOM_IMAGE' : 'CUSTOM_ANIMATION', value, decodedBytes: packed.length };
  } catch (error) {
    return { ok: false as const, operation: 'project_media_import', project, code: 'MEDIA_IMPORT_FAILED',
      message: error instanceof Error ? error.message : String(error) };
  }
}

/** Keep the original available for reimport at a different size or after history restore. */
async function preserveSource(project: string, sourcePath: string, bytes: Uint8Array, deps: Dependencies) {
  let directory = project;
  for (const part of ['assets', 'media-import']) {
    directory = deps.fs.join(directory, part);
    if (await deps.fs.exists(directory)) {
      const info = await deps.fs.stat(directory);
      if (!info.isDirectory || info.isSymbolicLink) throw new Error('Media destination must be a physical project directory.');
    } else {
      deps.assertCurrent();
      await deps.fs.mkdir(directory);
    }
  }
  const target = deps.fs.join(project, sourcePath);
  if (await deps.fs.exists(target)) {
    const info = await deps.fs.stat(target);
    if (!info.isFile || info.isSymbolicLink) throw new Error('Media destination must be a regular file.');
    const previous = await deps.fs.readBinary(target);
    if (previous.length !== bytes.length || previous.some((value, i) => value !== bytes[i])) throw new Error('Existing media source failed its content hash check.');
  } else {
    deps.assertCurrent();
    await deps.fs.writeBinary(target, bytes);
  }
}

/** Fit the first frame inside the panel with its aspect ratio and white padding. */
async function decodeProjectBitmap(buffer: ArrayBuffer, mimeType: string, width: number, height: number): Promise<Uint8Array> {
  const image = await createImageBitmap(new Blob([buffer], { type: mimeType }));
  try {
    const context = new OffscreenCanvas(width, height).getContext('2d');
    if (!context) throw new Error('Bitmap canvas is unavailable.');
    const scale = Math.min(width / image.width, height / image.height);
    const scaledWidth = Math.max(1, Math.round(image.width * scale));
    const scaledHeight = Math.max(1, Math.round(image.height * scale));
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, Math.floor((width - scaledWidth) / 2), Math.floor((height - scaledHeight) / 2), scaledWidth, scaledHeight);
    const { data } = context.getImageData(0, 0, width, height);
    return packXbmBitmap(width, height, (x, y) => {
      const i = (y * width + x) * 4;
      return ((data[i] * 4 + data[i + 1] * 10 + data[i + 2] * 2) >> 4) < U8G2_THRESHOLD;
    });
  } finally {
    image.close();
  }
}

export function decodeProjectMedia(request: MediaDecodeRequest): Promise<MediaDecodeResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../editors/blockly-editor/components/blockly/custom-field/tftespi-animation-decoder.worker.ts', import.meta.url), { type: 'module' });
    const finish = (error?: Error, result?: MediaDecodeResult) => {
      clearTimeout(timer); worker.terminate(); error ? reject(error) : resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('Media decoding exceeded 60 seconds.')), 60000);
    worker.onmessage = ({ data }) => {
      if (data?.requestId !== request.requestId) return;
      if (data.type === 'done') finish(undefined, data.result);
      if (data.type === 'error') finish(new Error(data.message || data.messageKey || 'Media decoding failed.'));
    };
    worker.onerror = event => finish(new Error(event.message || 'Media decoder worker failed.'));
    worker.postMessage(request, [request.buffer]);
  });
}
