import * as Blockly from 'blockly';
import { projectDataRuntime } from './project-data-runtime';
import { AilyDataRef, isAilyDataRef, ProjectDataError } from './project-data.types';

export type ProjectDataFieldProjectionKind =
  | 'tft-animation'
  | 'tft-image'
  | 'adafruit-rgb565-image'
  | 'u8g2-animation'
  | 'u8g2-bitmap'
  | 'led-matrix-image'
  | 'image-preview';

interface ProjectDataFieldSlot {
  readonly kind: ProjectDataFieldProjectionKind;
  readonly fieldType: string;
  readonly libraryName: string;
}

type BlocklyJsonDefinition = Record<string, any>;
type TranslationResolver = (key: string) => unknown;
type GeneratorFunction = (block: Blockly.Block, generator: any) => unknown;

const PROJECT_DATA_FIELD_TYPES: Readonly<Record<string, ProjectDataFieldProjectionKind>> = {
  field_tftespi_animation: 'tft-animation',
  field_tftespi_image: 'tft-image',
  field_u8g2_animation: 'u8g2-animation',
  field_bitmap_u8g2: 'u8g2-bitmap',
  field_led_matrix_image: 'led-matrix-image',
  field_image_preview: 'image-preview',
};

const fieldSlots = new Map<string, Map<string, ProjectDataFieldSlot>>();
const wrappedGeneratorFunctions = new WeakSet<GeneratorFunction>();

/**
 * Decorates a cloned library block definition in memory. The library package on
 * disk remains unchanged and can continue to target the legacy generator ABI.
 */
export function decorateLibraryBlockDefinitionForProjectData(
  definition: BlocklyJsonDefinition,
  libraryName = '',
  translate?: TranslationResolver,
): BlocklyJsonDefinition {
  if (!definition || typeof definition !== 'object' || typeof definition['type'] !== 'string') {
    return definition;
  }

  const blockType = definition['type'];
  let hasTftImageField = false;
  for (const key of Object.keys(definition)) {
    if (!/^args\d+$/.test(key) || !Array.isArray(definition[key])) continue;
    for (const argument of definition[key]) {
      if (!argument || typeof argument !== 'object') continue;
      decorateKnownLegacyField(argument, libraryName, blockType);
      const fieldType = typeof argument['type'] === 'string' ? argument['type'] : '';
      const fieldName = typeof argument['name'] === 'string' ? argument['name'] : '';
      const kind = PROJECT_DATA_FIELD_TYPES[fieldType];
      if (!fieldName || !kind) continue;

      if (fieldType === 'field_tftespi_image') {
        argument['imageMode'] = true;
        argument['fps'] = 1;
        argument['maxFrames'] = 1;
        hasTftImageField = true;
      }
      registerProjectDataFieldSlot(blockType, fieldName, {
        kind: resolveProjectionKind(libraryName, blockType, fieldName, kind),
        fieldType,
        libraryName,
      });
    }
  }

  if (hasTftImageField) {
    const key = 'BLOCKLY.TFTESPI_IMAGE.BLOCK_TOOLTIP';
    const translated = translate?.(key);
    definition['tooltip'] = typeof translated === 'string' && translated && translated !== key
      ? translated
      : 'Upload an image and convert it to RGB565/RGB332 pixel data';
  }
  return definition;
}

/** Removes runtime slot metadata when the owning library is unloaded. */
export function unregisterProjectDataFieldSlots(blockTypes: readonly string[]): void {
  for (const blockType of blockTypes) fieldSlots.delete(blockType);
}

/**
 * Wraps generators registered by a read-only library. The wrapper only changes
 * getFieldValue for declared Project Data slots; every other block API remains
 * the original Blockly block.
 */
export function wrapProjectDataGeneratorFunctions(
  generator: any,
  blockTypes: readonly string[],
): void {
  if (!generator?.forBlock) return;
  for (const blockType of blockTypes) {
    const original = generator.forBlock[blockType] as GeneratorFunction | undefined;
    if (typeof original !== 'function' || wrappedGeneratorFunctions.has(original)) continue;

    const wrapped: GeneratorFunction = function (this: unknown, block, targetGenerator) {
      return original.call(this, createGeneratorBlockView(block), targetGenerator);
    };
    wrappedGeneratorFunctions.add(wrapped);
    generator.forBlock[blockType] = wrapped;
  }
}

/**
 * Completes the asynchronous resource barrier used by every synchronous Blockly
 * generator. Fields may optionally expose prepareForCodeGeneration for derived
 * runtime caches (for example decoded image previews).
 */
export async function prepareBlocklyProjectDataForCodeGeneration(
  workspace: Blockly.Workspace,
  projectValue?: unknown,
): Promise<void> {
  await projectDataRuntime.flushPending();
  await projectDataRuntime.prepareValue(
    projectValue ?? Blockly.serialization.workspaces.save(workspace),
  );

  const preparations: Promise<unknown>[] = [];
  for (const block of workspace.getAllBlocks(false)) {
    for (const input of block.inputList) {
      for (const field of input.fieldRow) {
        const prepare = (field as any)?.prepareForCodeGeneration;
        if (typeof prepare === 'function') {
          preparations.push(Promise.resolve(prepare.call(field)));
        }
      }
    }
  }
  await Promise.all(preparations);
  await projectDataRuntime.flushPending();
}

/** Pure projection entry point exported for byte-level regression tests. */
export function projectPreparedFieldValueForLegacyGenerator(
  kind: ProjectDataFieldProjectionKind,
  compactValue: unknown,
  preparedPayload?: unknown,
): unknown {
  const state = parseCompactState(compactValue);
  switch (kind) {
    case 'tft-animation':
      return projectTftAnimation(state, preparedPayload);
    case 'tft-image':
      return projectTftImage(state, preparedPayload);
    case 'adafruit-rgb565-image':
      return projectAdafruitImage(state, preparedPayload);
    case 'u8g2-animation':
      return projectU8g2Animation(state, preparedPayload);
    case 'u8g2-bitmap':
      return projectU8g2Bitmap(state, preparedPayload);
    case 'led-matrix-image':
      return projectLedMatrixImage(state, preparedPayload);
    case 'image-preview':
      return projectImagePreview(state);
  }
}

function decorateKnownLegacyField(
  argument: BlocklyJsonDefinition,
  libraryName: string,
  blockType: string,
): void {
  if (
    libraryName.toLowerCase() === 'adafruit_gfx'
    && blockType === 'tft_bitmap_image'
    && argument['name'] === 'IMAGE_DATA'
    && argument['type'] === 'field_input'
  ) {
    delete argument['text'];
    Object.assign(argument, {
      type: 'field_tftespi_image',
      width: 16,
      height: 16,
      fps: 1,
      maxFrames: 1,
      format: 'rgb565',
      fieldHeight: 50,
      imageMode: true,
    });
  }
}

function resolveProjectionKind(
  libraryName: string,
  blockType: string,
  fieldName: string,
  fallback: ProjectDataFieldProjectionKind,
): ProjectDataFieldProjectionKind {
  return libraryName.toLowerCase() === 'adafruit_gfx'
    && blockType === 'tft_bitmap_image'
    && fieldName === 'IMAGE_DATA'
    ? 'adafruit-rgb565-image'
    : fallback;
}

function registerProjectDataFieldSlot(
  blockType: string,
  fieldName: string,
  slot: ProjectDataFieldSlot,
): void {
  let blockSlots = fieldSlots.get(blockType);
  if (!blockSlots) {
    blockSlots = new Map<string, ProjectDataFieldSlot>();
    fieldSlots.set(blockType, blockSlots);
  }
  blockSlots.set(fieldName, slot);
}

function createGeneratorBlockView(block: Blockly.Block): Blockly.Block {
  const slots = fieldSlots.get(block.type);
  if (!slots?.size) return block;

  return new Proxy(block, {
    get(target, property, receiver) {
      if (property !== 'getFieldValue') return Reflect.get(target, property, receiver);
      return (fieldName: string) => {
        const rawValue = target.getFieldValue(fieldName);
        const slot = slots.get(fieldName);
        if (!slot) return rawValue;
        return projectRuntimeFieldValue(slot.kind, rawValue, target, fieldName);
      };
    },
  });
}

function projectRuntimeFieldValue(
  kind: ProjectDataFieldProjectionKind,
  compactValue: unknown,
  block: Blockly.Block,
  fieldName: string,
): unknown {
  const state = parseCompactState(compactValue);
  const ref = getSlotReference(kind, state);
  let payload: unknown;
  if (ref) {
    try {
      payload = projectDataRuntime.getPrepared(ref);
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw new ProjectDataError(error.code, error.message, {
          ...error.details,
          operation: 'codegen',
          blockId: block.id,
          blockType: block.type,
          fieldName,
        });
      }
      throw error;
    }
  }
  return projectPreparedFieldValueForLegacyGenerator(kind, state, payload);
}

function getSlotReference(
  kind: ProjectDataFieldProjectionKind,
  state: Record<string, any>,
): AilyDataRef | null {
  const candidate = kind === 'u8g2-bitmap'
    ? state['bitmap']
    : kind === 'led-matrix-image'
      ? state['pixels']
      : kind === 'image-preview'
        ? state['image']
        : state['frames'];
  return isAilyDataRef(candidate) ? candidate : null;
}

function parseCompactState(value: unknown): Record<string, any> {
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function projectTftAnimation(state: Record<string, any>, payload: unknown): unknown {
  const format = state['format'] === 'rgb332' ? 'rgb332' : 'rgb565';
  const width = positiveInteger(state['width'], 1);
  const height = positiveInteger(state['height'], 1);
  const fps = positiveNumber(state['fps'], 10);
  const frameCount = nonNegativeInteger(state['frameCount'], 0);
  const frameLength = width * height * (format === 'rgb332' ? 1 : 2);
  const bytes = payload === undefined
    ? new Uint8Array(0)
    : requireBytes(payload, frameLength * frameCount, 'TFT animation');
  const frames = Array.from({ length: frameCount }, (_, index) => bytesToBase64(
    bytes.subarray(index * frameLength, (index + 1) * frameLength),
  ));
  return {
    version: 1,
    format,
    encoding: format === 'rgb332' ? 'rgb332-base64' : 'rgb565-be-base64',
    width,
    height,
    fps,
    frames,
  };
}

function projectTftImage(state: Record<string, any>, payload: unknown): unknown {
  const animation = projectTftAnimation(
    { ...state, frameCount: state['frameCount'] || (payload === undefined ? 0 : 1) },
    payload,
  ) as Record<string, any>;
  return {
    version: 1,
    format: animation['format'],
    encoding: animation['encoding'],
    width: animation['width'],
    height: animation['height'],
    data: animation['frames'][0] || '',
  };
}

function projectAdafruitImage(state: Record<string, any>, payload: unknown): string {
  if (payload === undefined) return '';
  const format = state['format'] === 'rgb332' ? 'rgb332' : 'rgb565';
  const width = positiveInteger(state['width'], 1);
  const height = positiveInteger(state['height'], 1);
  const bytesPerPixel = format === 'rgb332' ? 1 : 2;
  const bytes = requireBytes(payload, width * height * bytesPerPixel, 'Adafruit image');
  const pixels = Array.from({ length: width * height }, (_, index) => (
    format === 'rgb332'
      ? rgb332ToRgb888(bytes[index])
      : rgb565ToRgb888((bytes[index * 2] << 8) | bytes[index * 2 + 1])
  ));
  return JSON.stringify({ width, height, pixels });
}

function projectU8g2Bitmap(state: Record<string, any>, payload: unknown): number[][] {
  const width = positiveInteger(state['width'], 1);
  const height = positiveInteger(state['height'], 1);
  if (payload === undefined) return createEmptyMatrix(width, height, 0);
  const rowBytes = Math.ceil(width / 8);
  const bytes = requireBytes(payload, rowBytes * height, 'U8G2 bitmap');
  return unpackMonochromeFrame(bytes, width, height);
}

function projectU8g2Animation(state: Record<string, any>, payload: unknown): unknown {
  const width = positiveInteger(state['width'], 1);
  const height = positiveInteger(state['height'], 1);
  const fps = positiveNumber(state['fps'], 10);
  const frameCount = nonNegativeInteger(state['frameCount'], 0);
  const frameLength = Math.ceil(width / 8) * height;
  const bytes = payload === undefined
    ? new Uint8Array(0)
    : requireBytes(payload, frameLength * frameCount, 'U8G2 animation');
  return {
    width,
    height,
    fps,
    frames: Array.from({ length: frameCount }, (_, index) => unpackMonochromeFrame(
      bytes.subarray(index * frameLength, (index + 1) * frameLength),
      width,
      height,
    )),
  };
}

function projectLedMatrixImage(state: Record<string, any>, payload: unknown): unknown {
  const mode = state['mode'] === 'rgb' ? 'rgb' : 'mono';
  const width = positiveInteger(state['width'], 1);
  const height = positiveInteger(state['height'], 1);
  if (payload === undefined) {
    return { mode, width, height, pixels: createEmptyMatrix(width, height, mode === 'rgb' ? null : 0) };
  }

  if (mode === 'mono') {
    const bytes = requireBytes(payload, Math.ceil(width / 8) * height, 'LED matrix image');
    return { mode, width, height, pixels: unpackMonochromeFrame(bytes, width, height) };
  }
  const bytes = requireBytes(payload, width * height * 4, 'LED matrix image');
  const pixels = createEmptyMatrix<string | null>(width, height, null);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const offset = (row * width + col) * 4;
      if (bytes[offset + 3] === 0) continue;
      pixels[row][col] = `#${toHex(bytes[offset])}${toHex(bytes[offset + 1])}${toHex(bytes[offset + 2])}`;
    }
  }
  return { mode, width, height, pixels };
}

function projectImagePreview(state: Record<string, any>): unknown {
  const image = isAilyDataRef(state['image']) ? state['image'] : null;
  return {
    ...state,
    filePath: typeof state['filePath'] === 'string' && state['filePath'].trim()
      ? state['filePath']
      : image?.$ailyData.id || '',
  };
}

function unpackMonochromeFrame(bytes: Uint8Array, width: number, height: number): number[][] {
  const rowBytes = Math.ceil(width / 8);
  return Array.from({ length: height }, (_, row) => Array.from(
    { length: width },
    (_, col) => (bytes[row * rowBytes + (col >> 3)] >> (col & 7)) & 1,
  ));
}

function requireBytes(payload: unknown, expectedLength: number, label: string): Uint8Array {
  if (!(payload instanceof Uint8Array) || payload.byteLength !== expectedLength) {
    throw new ProjectDataError(
      'corrupt',
      `${label} payload length mismatch: expected ${expectedLength}, received ${
        payload instanceof Uint8Array ? payload.byteLength : 'non-binary data'
      }.`
    );
  }
  return payload;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function rgb565ToRgb888(value: number): number {
  const red = ((value >> 11) & 0x1f) << 3;
  const green = ((value >> 5) & 0x3f) << 2;
  const blue = (value & 0x1f) << 3;
  return (red << 16) | (green << 8) | blue;
}

function rgb332ToRgb888(value: number): number {
  const red = ((value >> 5) & 0x07) << 5;
  const green = ((value >> 2) & 0x07) << 5;
  const blue = (value & 0x03) << 6;
  return (red << 16) | (green << 8) | blue;
}

function positiveInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function createEmptyMatrix<T>(width: number, height: number, value: T): T[][] {
  return Array.from({ length: height }, () => Array<T>(width).fill(value));
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, '0');
}
