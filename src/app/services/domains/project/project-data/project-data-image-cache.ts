import type * as Blockly from 'blockly';
import { areAilyDataRefsEquivalent, isAilyDataRef, type AilyDataRef } from './project-data.types';
import type { PreparedDataReader } from './project-data-field-preparation';

interface ImageCache {
  readonly resourceId: string;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly processedSizes: Readonly<Record<number, readonly string[]>>;
  readonly imageElement: HTMLImageElement;
}
const caches = new WeakMap<Blockly.Field, { ref: AilyDataRef; value: ImageCache }>();
// Capture browser primitives before replay installs its library-effect guards.
const ImageConstructor = Image;
const createElement = document.createElement.bind(document);
const schedule = globalThis.setTimeout.bind(globalThis), cancel = globalThis.clearTimeout.bind(globalThis);

/** Decode only supplied memory, never a path/URL. Publish a complete cache or fail. */
export async function cacheProjectDataImage(field: Blockly.Field, ref: AilyDataRef, dataUrl: string): Promise<void> {
  const owner = field.getSourceBlock();
  if (!owner || owner.isDisposed()) throw new Error('Image preparation requires a live field owner.');
  const cached = caches.get(field);
  if (cached && areAilyDataRefsEquivalent(cached.ref, ref)) return;
  if (!/^data:(?:image\/[\w.+-]+|application\/octet-stream);base64,/.test(dataUrl)) throw new Error('Image preparation requires inline resource bytes.');
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new ImageConstructor();
    const finish = (error?: Error) => {
      cancel(timer); image.onload = image.onerror = null;
      if (error) { image.removeAttribute('src'); reject(error); } else resolve(image);
    };
    const timer = schedule(() => finish(new Error('Image resource decoding timed out.')), 5000);
    image.onerror = () => finish(new Error('Image resource decoding failed.'));
    image.onload = () => finish(image.naturalWidth * image.naturalHeight > 16 * 1024 * 1024
      ? new Error('Image resource exceeds decoded pixel limit.') : undefined);
    image.src = dataUrl;
  });
  const processedSizes: Record<number, readonly string[]> = Object.create(null);
  for (const size of [8, 16, 24, 32, 48, 64, 96, 128]) {
    const canvas = createElement('canvas'); canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image preparation requires a 2D canvas.');
    const scale = Math.min(size / image.naturalWidth, size / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    context.fillStyle = '#000000'; context.fillRect(0, 0, size, size);
    context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
    const pixels = context.getImageData(0, 0, size, size).data, rgb565: string[] = [];
    for (let i = 0; i < pixels.length; i += 4) {
      const color = ((pixels[i] >> 3) << 11) | ((pixels[i + 1] >> 2) << 5) | (pixels[i + 2] >> 3);
      rgb565.push(`0x${color.toString(16).padStart(4, '0').toUpperCase()}`);
    }
    processedSizes[size] = Object.freeze(rgb565);
  }
  const current = field.getValue()?.image;
  if (field.getSourceBlock() !== owner || owner.isDisposed()
    || !isAilyDataRef(current) || !areAilyDataRefsEquivalent(current, ref)) throw new Error('Image resource or owner changed during preparation.');
  caches.set(field, { ref: structuredClone(ref), value: Object.freeze({ resourceId: ref.$ailyData.id,
    originalWidth: image.naturalWidth, originalHeight: image.naturalHeight,
    processedSizes: Object.freeze(processedSizes), imageElement: image }) });
}

export function releaseProjectDataImage(field: Blockly.Field): void { caches.delete(field); }

/** The same cache builder for a candidate's private, already-resolved snapshot. */
export async function prepareProjectDataImage(field: Blockly.Field, read: PreparedDataReader): Promise<void> {
  const state = field.getValue(), ref = state?.image;
  if (!isAilyDataRef(ref)) return;
  const bytes = read(ref);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== ref.$ailyData.rawLength) throw new Error('Image resource length mismatch.');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await cacheProjectDataImage(field, ref, `data:${state.mediaType || 'application/octet-stream'};base64,${btoa(binary)}`);
}

/** Legacy library ABI, scoped to fields in this workspace, never a window-wide filename cache. */
export function installProjectDataImageCache(realm: Record<string, any>, workspace: () => Blockly.Workspace | null,
  assertCurrent: () => void): void {
  Object.defineProperty(realm, 'tftImageCache', { configurable: false, get: () => {
    assertCurrent();
    const result: Record<string, ImageCache> = Object.create(null);
    for (const block of workspace()?.getAllBlocks(false) ?? []) for (const input of block.inputList) for (const field of input.fieldRow) {
      const cache = caches.get(field);
      if (!cache) continue;
      const current = field.getValue()?.image;
      if (!isAilyDataRef(current) || !areAilyDataRefsEquivalent(current, cache.ref)) continue;
      result[current.$ailyData.id] = cache.value;
    }
    return Object.freeze(result);
  } });
}
