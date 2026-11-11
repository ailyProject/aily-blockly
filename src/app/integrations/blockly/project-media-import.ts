import { MAX_U8G2_BITMAP_DIMENSION, packXbmBitmap, projectDataRuntime } from '@domain/project/project-data/public-api';
import { createElectronProjectDataFileSystem, ProjectDataFileSystem } from '@domain/project/public-api';
import type { AilyDataRef, U8g2BitmapValue } from '@domain/project/project-data/public-api';
import { fitMediaRect } from '@domain/project/project-data/media/public-api';
import type { MediaFit, MediaRect, MediaSize } from '@domain/project/project-data/media/public-api';
import type { BoundMediaImportTarget, MediaImportTarget, MediaKind } from './project-media-target';

type Format = 'rgb565' | 'rgb332';
export interface MediaImportRequest {
  kind?: MediaKind;
  source: string;
  target?: MediaImportTarget;
  width?: number;
  height?: number;
  fit?: MediaFit;
  fps?: number;
  maxFrames?: number;
  format?: Format;
}
export interface MediaDecodeRequest {
  type: 'decode'; requestId: number; fileName: string; mimeType: string; buffer: ArrayBuffer;
  width: number; height: number; fps: number; maxFrames: number; format: Format;
  fit?: MediaFit;
}
export interface MediaDecodeResult {
  width: number; height: number; fps: number; maxFrames: number; format: Format;
  frames: Uint8Array[];
  firstFrame?: { source: MediaSize; content: MediaRect };
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
const GUIDANCE = 'Insert absArgument unchanged as one field argument in the current text ABS.';

function mediaAbs(value: object, target?: BoundMediaImportTarget) {
  const absArgument = JSON.stringify(value);
  return { absArgument, ...(target?.singleFieldOutput ? { absExpression: `${target.blockType}(${absArgument})` } : {}) };
}

/** Prepares resources for native media fields without changing blocks or the ABS generation. */
export async function importProjectMedia(project: string, params: MediaImportRequest, dependencies?: Dependencies,
  resolveTarget?: (target: MediaImportTarget) => BoundMediaImportTarget) {
  const session = projectDataRuntime.getSessionToken();
  const base = dependencies || {
    fs: createElectronProjectDataFileSystem(), decode: decodeProjectMedia,
    put: request => projectDataRuntime.put(request),
    assertCurrent: () => {
      if (!session || session !== projectDataRuntime.getSessionToken()) throw new Error('Project changed during media import.');
    },
  } satisfies Dependencies;
  let target: BoundMediaImportTarget | undefined;
  const deps: Dependencies = { ...base, assertCurrent() { base.assertCurrent(); target?.assertCurrent(); } };
  const integer = (value: unknown, name: string, max: number) => {
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error(`Invalid ${name}; expected an integer from 1 to ${max}.`);
    return Number(value);
  };
  try {
    deps.assertCurrent();
    if (typeof params?.source !== 'string' || !params.source.trim()) throw new Error('A source file is required.');
    if (params.target !== undefined) {
      if (!resolveTarget) throw new Error('The host cannot resolve a registered media field in this project.');
      target = resolveTarget(params.target);
    }
    const kind = target?.kind ?? params.kind;
    if (kind !== 'tft_image' && kind !== 'tft_animation' && kind !== 'u8g2_bitmap') throw new Error('Unsupported media kind.');
    if (target && ((params.kind !== undefined && params.kind !== kind)
      || (params.width !== undefined && params.width !== target.width)
      || (params.height !== undefined && params.height !== target.height))) {
      throw new Error(`Target field requires ${kind} at ${target.width}×${target.height}. Omit kind, width and height when using target.`);
    }
    const fit = params.fit ?? (target || kind === 'u8g2_bitmap' ? 'contain' : 'stretch');
    if (fit !== 'contain' && fit !== 'stretch') throw new Error('Unsupported media fit.');
    const maxDimension = kind === 'u8g2_bitmap' ? MAX_U8G2_BITMAP_DIMENSION : 16384;
    const width = integer(target?.width ?? params.width, 'width', maxDimension);
    const height = integer(target?.height ?? params.height, 'height', maxDimension);
    const targetSize = { width, height };
    const format = params.format ?? 'rgb565';
    if (!['rgb565', 'rgb332'].includes(format)) throw new Error('Unsupported pixel format.');
    const fps = integer(params.fps ?? 10, 'fps', 30);
    const maxFrames = kind === 'tft_animation' ? integer(params.maxFrames ?? 300, 'maxFrames', 300) : 1;
    const frameSize = width * height * (format === 'rgb565' ? 2 : 1);
    if (frameSize > MAX_OUTPUT_BYTES) throw new Error('One frame exceeds the 8 MiB output budget.');
    const source = await resolveMediaSource(project, params.source, !!target, deps.fs);
    const fileName = source.split(/[\\/]/).pop()!;
    const ext = fileName.split('.').pop()!.toLowerCase();
    if (!Object.hasOwn(MIME, ext) || (kind !== 'tft_animation' && ext === 'mp4')) throw new Error('Unsupported source format. Use PNG, JPEG, WebP, GIF, or MP4 for TFT animation.');
    const stat = await deps.fs.stat(source);
    if (!stat.isFile || stat.isSymbolicLink || stat.size < 1 || stat.size > MAX_SOURCE_BYTES)
      throw new Error('Source must be a regular file no larger than 64 MiB.');
    const bytes = await deps.fs.readBinary(source);
    const after = await deps.fs.stat(source);
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || !after.isFile || after.isSymbolicLink)
      throw new Error('Source changed while reading; import the stable file again.');
    deps.assertCurrent();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)), byte => byte.toString(16).padStart(2, '0')).join('');
    const sourcePath = `assets/media-import/${hash}.${ext}`;
    const receipt = { ok: true as const, operation: 'project_media_import', project,
      sourcePath, sourceSha256: hash, sourceBytes: bytes.length, guidance: GUIDANCE };
    const field = target && { blockType: target.blockType, fieldName: target.fieldName, fieldType: target.fieldType };
    if (kind === 'u8g2_bitmap') {
      const { packed, source, content } = await decodeProjectBitmap(bytes.slice().buffer as ArrayBuffer, MIME[ext], targetSize, fit);
      deps.assertCurrent();
      await preserveSource(project, sourcePath, bytes, deps);
      deps.assertCurrent();
      const bitmap = await deps.put({ codec: 'u8g2-xbm-v1', storage: 'raw-v1', value: packed });
      deps.assertCurrent();
      const value: U8g2BitmapValue = { schemaVersion: 1, encoding: 'xbm-lsb-row-v1', width, height, bitmap };
      return { ...receipt, kind, fieldType: 'field_bitmap_u8g2', ...field, value, ...mediaAbs(value, target),
        geometry: { source, target: targetSize, content, fit }, decodedBytes: packed.length };
    }
    const result = await deps.decode({ type: 'decode', requestId: 1, fileName, mimeType: MIME[ext],
      buffer: bytes.slice().buffer as ArrayBuffer, width, height, fps, maxFrames, format, fit });
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
      fieldName: kind === 'tft_image' ? 'CUSTOM_IMAGE' : 'CUSTOM_ANIMATION', ...field, value, ...mediaAbs(value, target),
      geometry: { target: targetSize, fit, ...result.firstFrame }, decodedBytes: packed.length };
  } catch (error) {
    return { ok: false as const, operation: 'project_media_import', project, code: 'MEDIA_IMPORT_FAILED',
      message: error instanceof Error ? error.message : String(error) };
  }
}

async function resolveMediaSource(project: string, input: string, fieldTarget: boolean, fs: ProjectDataFileSystem) {
  const absolute = fs.isAbsolute(input);
  const source = fs.resolve(absolute ? input : fs.join(project, input));
  const relative = fs.relative(project, source);
  const parts = relative.split(/[\\/]/);
  const outside = parts[0] === '..' || fs.isAbsolute(relative);
  if (outside) {
    if (!absolute || fieldTarget) throw new Error('Select the original media from the current project or attach it first.');
    return source; // Keep the explicit absolute-source form for existing callers.
  }
  if (['.aily', '.workspace-history'].includes(parts[0].toLowerCase())) throw new Error('Private project state cannot be imported as media.');
  let directory = project;
  for (const part of parts.slice(0, -1)) {
    directory = fs.join(directory, part);
    const info = await fs.stat(directory);
    if (!info.isDirectory || info.isSymbolicLink) throw new Error('Media source path must stay in physical project directories.');
  }
  return source;
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

/** Decode the first frame with white padding for the one-bit field. */
async function decodeProjectBitmap(buffer: ArrayBuffer, mimeType: string, target: MediaSize, fit: MediaFit) {
  const image = await createImageBitmap(new Blob([buffer], { type: mimeType }));
  try {
    const { width, height } = target;
    const context = new OffscreenCanvas(width, height).getContext('2d');
    if (!context) throw new Error('Bitmap canvas is unavailable.');
    const source = { width: image.width, height: image.height };
    const content = fitMediaRect(source, target, fit);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, content.x, content.y, content.width, content.height);
    const { data } = context.getImageData(0, 0, width, height);
    const packed = packXbmBitmap(width, height, (x, y) => {
      const i = (y * width + x) * 4;
      return ((data[i] * 4 + data[i + 1] * 10 + data[i + 2] * 2) >> 4) < U8G2_THRESHOLD;
    });
    return { packed, source, content };
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
