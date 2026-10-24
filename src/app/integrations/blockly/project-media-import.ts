import { projectDataRuntime } from '@domain/project/project-data/public-api';
import { createElectronProjectDataFileSystem, ProjectDataFileSystem } from '../../services/domains/project/project-data/project-data-file-system';
import type { AilyDataRef } from '@domain/project/project-data/public-api';

type Format = 'rgb565' | 'rgb332';
export interface MediaImportRequest {
  kind: 'tft_image' | 'tft_animation';
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

/** Uses the same browser decoder as the field editor; never changes blocks or an ABS generation. */
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
    if (!params || !['tft_image', 'tft_animation'].includes(params.kind)) throw new Error('Unsupported media kind.');
    if (typeof params.source !== 'string' || !params.source.trim()) throw new Error('A source file is required.');
    const format = params.format ?? 'rgb565';
    if (!['rgb565', 'rgb332'].includes(format)) throw new Error('Unsupported pixel format.');
    const width = integer(params.width, 'width', 16384), height = integer(params.height, 'height', 16384);
    const fps = integer(params.fps ?? 10, 'fps', 30);
    const maxFrames = params.kind === 'tft_image' ? 1 : integer(params.maxFrames ?? 300, 'maxFrames', 300);
    const frameSize = width * height * (format === 'rgb565' ? 2 : 1);
    if (frameSize > MAX_OUTPUT_BYTES) throw new Error('One frame exceeds the 8 MiB output budget.');
    const source = deps.fs.isAbsolute(params.source) ? params.source : deps.fs.join(project, params.source);
    const fileName = source.split(/[\\/]/).pop()!;
    const ext = fileName.split('.').pop()!.toLowerCase();
    if (!MIME[ext] || (params.kind === 'tft_image' && ext === 'mp4')) throw new Error('Unsupported source format. Use PNG, JPEG, WebP, GIF, or MP4 for animation.');
    const stat = await deps.fs.stat(source);
    if (!stat.isFile || stat.size < 1 || stat.size > MAX_SOURCE_BYTES) throw new Error('Source must be a regular file no larger than 64 MiB.');
    const bytes = await deps.fs.readBinary(source);
    if (bytes.length !== stat.size || bytes.length > MAX_SOURCE_BYTES) throw new Error('Source changed while reading; import the stable file again.');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)), byte => byte.toString(16).padStart(2, '0')).join('');
    const result = await deps.decode({ type: 'decode', requestId: 1, fileName, mimeType: MIME[ext],
      buffer: bytes.slice().buffer as ArrayBuffer, width, height, fps, maxFrames, format });
    deps.assertCurrent();
    if (result.width !== width || result.height !== height || result.format !== format || result.fps !== fps
      || result.frames.length < 1 || result.frames.length > maxFrames
      || result.frames.length * frameSize > MAX_OUTPUT_BYTES
      || result.frames.some(frame => !(frame instanceof Uint8Array) || frame.byteLength !== frameSize)) {
      throw new Error('Decoder returned inconsistent media dimensions or frame data.');
    }
    // A content-addressed source remains available when dimensions are edited or history is restored.
    let directory = project;
    for (const part of ['assets', 'media-import']) {
      directory = deps.fs.join(directory, part);
      if (await deps.fs.exists(directory)) {
        const info = await deps.fs.stat(directory);
        if (!info.isDirectory || info.isSymbolicLink) throw new Error('Media destination must be a physical project directory.');
      } else await deps.fs.mkdir(directory);
    }
    const sourcePath = `assets/media-import/${hash}.${ext}`;
    const target = deps.fs.join(project, sourcePath);
    if (await deps.fs.exists(target)) {
      const info = await deps.fs.stat(target);
      if (!info.isFile || info.isSymbolicLink) throw new Error('Media destination must be a regular file.');
      const previous = await deps.fs.readBinary(target);
      if (previous.length !== bytes.length || previous.some((value, i) => value !== bytes[i])) throw new Error('Existing media source failed its content hash check.');
    } else await deps.fs.writeBinary(target, bytes);
    deps.assertCurrent();
    const packed = new Uint8Array(frameSize * result.frames.length);
    result.frames.forEach((frame, i) => packed.set(frame, i * frameSize));
    const frames = await deps.put({ codec: format === 'rgb332' ? 'tft-rgb332-frames-v1' : 'tft-rgb565-be-frames-v1', storage: 'raw-v1', value: packed });
    deps.assertCurrent();
    const value = { schemaVersion: 1, format, encoding: format === 'rgb332' ? 'rgb332' : 'rgb565-be',
      width, height, fps, maxFrames: Math.min(maxFrames, Math.floor(MAX_OUTPUT_BYTES / frameSize)), frameCount: result.frames.length,
      frames, sourceName: fileName, sourceType: MIME[ext], sourcePath };
    return { ok: true, operation: 'project_media_import', project, kind: params.kind,
      blockType: params.kind === 'tft_image' ? 'tftespi_image' : 'tftespi_animation',
      fieldName: params.kind === 'tft_image' ? 'CUSTOM_IMAGE' : 'CUSTOM_ANIMATION', value,
      sourceSha256: hash, sourceBytes: bytes.length, decodedBytes: packed.length,
      guidance: 'Use value unchanged as the media field argument in your complete ABS candidate, then abs_apply with its existing generation. Only assets were prepared; no blocks, ABS, ABI, or baseline were changed.' };
  } catch (error) {
    return { ok: false, operation: 'project_media_import', project, code: 'MEDIA_IMPORT_FAILED',
      message: error instanceof Error ? error.message : String(error) };
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
