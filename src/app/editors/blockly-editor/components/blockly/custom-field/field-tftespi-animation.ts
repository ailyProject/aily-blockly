import * as Blockly from 'blockly/core';
import { projectDataRuntime, AilyDataRef, isAilyDataRef } from '@domain/project/public-api';
import { MEDIA_FIELD_PARAMETER_DEBOUNCE_MS } from './field-media-editor-style';

type AnimationMessageParams = Record<string, string | number>;
type AnimationTranslator = (key: string, params?: AnimationMessageParams) => string;

const I18N_PREFIX = 'BLOCKLY.TFTESPI_ANIMATION';
const BLOCKLY_MESSAGE_NAMES = [
  'BUTTON_UPLOAD',
  'UPLOAD_TOOLTIP',
  'BUTTON_CLEAR',
  'BUTTON_PLAY_TEST',
  'BUTTON_STOP_PLAY_TEST',
  'PLAY_TEST_TOOLTIP',
  'LABEL_WIDTH',
  'LABEL_HEIGHT',
  'LABEL_FPS',
  'LABEL_MAX_FRAMES',
  'LABEL_COLOR_MODE',
  'EMPTY',
] as const;

const DEFAULT_MESSAGES: Record<string, string> = {
  BUTTON_UPLOAD: 'Upload',
  UPLOAD_TOOLTIP: 'MP4 / GIF',
  BUTTON_CLEAR: 'Clear',
  BUTTON_PLAY_TEST: 'Play preview',
  BUTTON_STOP_PLAY_TEST: 'Stop preview',
  PLAY_TEST_TOOLTIP: 'Preview the converted animation',
  LABEL_WIDTH: 'W',
  LABEL_HEIGHT: 'H',
  LABEL_FPS: 'FPS',
  LABEL_MAX_FRAMES: 'Frames',
  LABEL_COLOR_MODE: 'Color',
  EMPTY: 'No animation uploaded',
  STATUS_READING_FILE: 'Reading {{name}}...',
  STATUS_SAVING_FILE: 'Saving {{name}}...',
  STATUS_DECODING: 'Converting animation...',
  STATUS_REDECODING: 'Re-converting {{name}}...',
  STATUS_INFO: '{{sourcePrefix}}{{frames}} frames | {{width}}x{{height}} | {{fps}} FPS | {{mode}} | {{dataSize}}',
  ERROR_FILE_SIZE_EXCEEDED: 'Source file must not exceed {{maxSize}} (current: {{currentSize}})',
  ERROR_DECODE_FAILED: 'Animation conversion failed',
  ERROR_REDECODE_FAILED: 'Animation re-conversion failed',
  ERROR_PROJECT_PATH_MISSING: 'The current project path is unavailable, so the source file cannot be saved',
  ERROR_FS_CREATE_ASSETS_UNAVAILABLE: 'The assets directory cannot be created',
  ERROR_FS_SAVE_UNAVAILABLE: 'The animation source file cannot be saved',
  ERROR_FS_READ_UNAVAILABLE: 'The animation source file cannot be read',
  ERROR_SOURCE_READ_INVALID: 'The animation source file returned invalid data',
  ERROR_SOURCE_MISSING_REDECODE: 'The animation source file is unavailable for re-conversion',
  ERROR_SOURCE_NOT_FOUND: 'Animation source not found: {{path}}',
  ERROR_PROJECT_DATA_LOAD_FAILED: 'Animation data could not be loaded: {{message}}',
  ERROR_MD5_UNAVAILABLE: 'The file hashing API is unavailable; restart the application and try again',
  ERROR_MD5_FAILED: 'Failed to hash the source file',
  WORKER_ERROR_CREATE_CANVAS: 'Unable to create the animation conversion canvas',
  WORKER_ERROR_MP4_PARSE_FAILED: 'Failed to parse the MP4 container',
  WORKER_ERROR_MP4_NO_VIDEO_TRACK: 'No video track was found in the MP4 file',
  WORKER_ERROR_MP4_METADATA_FAILED: 'Failed to read MP4 metadata',
  WORKER_ERROR_MP4_FRAME_EXTRACTION_FAILED: 'Failed to extract MP4 video samples',
  WORKER_ERROR_WEB_CODECS_UNSUPPORTED: 'This browser does not support WebCodecs VideoDecoder',
  WORKER_STATUS_PARSE_MP4: 'Parsing MP4...',
  WORKER_ERROR_CODEC_UNSUPPORTED: 'The current browser cannot decode {{codec}}',
  WORKER_STATUS_DECODE_MP4_FRAME: 'Converting MP4 frame {{current}}/{{total}}',
  WORKER_ERROR_MP4_NO_VALID_FRAMES: 'The MP4 file decoded successfully, but no usable frames were produced',
  WORKER_ERROR_IMAGE_DECODER_UNSUPPORTED: 'This browser does not support ImageDecoder',
  WORKER_STATUS_PARSE_IMAGE: 'Parsing {{format}}...',
  WORKER_STATUS_DECODE_IMAGE_FRAME: 'Converting {{format}} frame {{current}}/{{total}}',
  WORKER_ERROR_IMAGE_NO_VALID_FRAMES: '{{format}} decoded successfully, but no usable frames were produced',
  WORKER_ERROR_UNSUPPORTED_FILE_TYPE: 'Only MP4, GIF, PNG, JPEG, and WebP files are supported',
  WORKER_ERROR_FRAME_TOO_LARGE: 'A {{width}}x{{height}} {{mode}} frame exceeds the {{maxSize}} output budget ({{size}})',
};

const DEFAULT_IMAGE_MESSAGES: Record<string, string> = {
  UPLOAD_TOOLTIP: 'Supported formats: PNG, JPEG, WebP, GIF',
  EMPTY: 'No image uploaded',
  STATUS_DECODING: 'Converting image...',
  STATUS_REDECODING: 'Re-converting {{name}}...',
  STATUS_INFO: '{{width}}x{{height}} | {{mode}} | {{dataSize}}',
  ERROR_DECODE_FAILED: 'Image conversion failed',
  ERROR_REDECODE_FAILED: 'Image re-conversion failed',
  ERROR_PROJECT_PATH_MISSING: 'The current project path is unavailable, so the image source cannot be saved',
  ERROR_FS_CREATE_ASSETS_UNAVAILABLE: 'The assets directory cannot be created',
  ERROR_FS_SAVE_UNAVAILABLE: 'The image source file cannot be saved',
  ERROR_FS_READ_UNAVAILABLE: 'The image source file cannot be read',
  ERROR_SOURCE_READ_INVALID: 'The image source file returned invalid data',
  ERROR_SOURCE_MISSING_REDECODE: 'The image source file is unavailable for re-conversion',
  ERROR_SOURCE_NOT_FOUND: 'Image source not found: {{path}}',
  ERROR_PROJECT_DATA_LOAD_FAILED: 'Image data could not be loaded: {{message}}',
  WORKER_ERROR_UNSUPPORTED_FILE_TYPE: 'Only PNG, JPEG, WebP, and GIF files are supported',
};

let animationTranslator: AnimationTranslator | null = null;

function interpolate(message: string, params?: AnimationMessageParams) {
  if (!params) return message;
  return message.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  ));
}

function translateMessage(messageName: string, params?: AnimationMessageParams) {
  const translationKey = `${I18N_PREFIX}.${messageName}`;
  const translated = animationTranslator?.(translationKey, params);
  if (translated && translated !== translationKey) {
    return translated;
  }

  if (messageName !== 'UPLOAD_TOOLTIP' && messageName !== 'WORKER_ERROR_UNSUPPORTED_FILE_TYPE') {
    const sharedTranslationKey = `BLOCKLY.U8G2_ANIMATION.${messageName}`;
    const sharedTranslated = animationTranslator?.(sharedTranslationKey, params);
    if (sharedTranslated && sharedTranslated !== sharedTranslationKey) {
      return sharedTranslated;
    }
    const sharedMessage = Blockly.Msg[`U8G2_ANIMATION_${messageName}`];
    if (sharedMessage) {
      return interpolate(sharedMessage, params);
    }
  }

  return interpolate(DEFAULT_MESSAGES[messageName] || translationKey, params);
}

function applyBlocklyMessages() {
  BLOCKLY_MESSAGE_NAMES.forEach((messageName) => {
    Blockly.Msg[`TFTESPI_ANIMATION_${messageName}`] = translateMessage(messageName);
  });
}

export function setTftEsPiAnimationFieldTranslator(translator: AnimationTranslator | null) {
  animationTranslator = translator;
  applyBlocklyMessages();
}

applyBlocklyMessages();

export type TftEsPiAnimationFormat = 'rgb565' | 'rgb332';
export type TftEsPiAnimationEncoding = 'rgb565-be' | 'rgb332';

export interface TftEsPiAnimationValue {
  schemaVersion: 1;
  format: TftEsPiAnimationFormat;
  encoding: TftEsPiAnimationEncoding;
  width: number;
  height: number;
  fps: number;
  maxFrames: number;
  frameCount: number;
  frames: AilyDataRef | null;
  sourceName?: string;
  sourceType?: string;
  sourcePath?: string;
}

function translateImageMessage(messageName: string, params?: AnimationMessageParams) {
  const translationKey = `BLOCKLY.TFTESPI_IMAGE.${messageName}`;
  const translated = animationTranslator?.(translationKey, params);
  if (translated && translated !== translationKey) {
    return translated;
  }
  if (DEFAULT_IMAGE_MESSAGES[messageName]) {
    return interpolate(DEFAULT_IMAGE_MESSAGES[messageName], params);
  }
  return translateMessage(messageName, params);
}

interface DecodedTftEsPiAnimationValue {
  schemaVersion: 1;
  format: TftEsPiAnimationFormat;
  encoding: TftEsPiAnimationEncoding;
  width: number;
  height: number;
  fps: number;
  maxFrames: number;
  frames: Uint8Array[];
  sourceName: string;
  sourceType: string;
}

interface DecodeWorkerMessage {
  type: 'progress' | 'done' | 'error';
  requestId: number;
  message?: string;
  messageKey?: string;
  messageParams?: AnimationMessageParams;
  result?: DecodedTftEsPiAnimationValue;
}

interface AnimationDecodeSource {
  fileName: string;
  mimeType: string;
  buffer: ArrayBuffer;
  sourcePath?: string;
}

interface ActiveDecodeTask {
  worker: Worker;
  requestId: number;
  reject: (reason: Error) => void;
}

class AnimationDecodeCancelledError extends Error {}

export interface FieldTftEsPiAnimationFromJsonConfig extends Blockly.FieldConfig {
  type?: string;
  value?: TftEsPiAnimationValue;
  width?: number;
  height?: number;
  fps?: number;
  maxFrames?: number;
  format?: TftEsPiAnimationFormat;
  fieldHeight?: number;
  imageMode?: boolean;
}

const DEFAULT_WIDTH = 160;
const DEFAULT_HEIGHT = 120;
const DEFAULT_FPS = 10;
const DEFAULT_MAX_FRAMES = 10;
const DEFAULT_FORMAT: TftEsPiAnimationFormat = 'rgb565';
const MAX_WIDTH = 480;
const MAX_HEIGHT = 480;
const MAX_FPS = 30;
const MAX_FRAMES = 300;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const BLOCK_FIELD_HEIGHT = 50;

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string) {
  const rawBase64 = base64.includes(',') ? base64.split(',').pop() || '' : base64;
  const binary = atob(rawBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeAnimationFormat(value: unknown, fallback = DEFAULT_FORMAT): TftEsPiAnimationFormat {
  return value === 'rgb332' || value === 'rgb565' ? value : fallback;
}

function getAnimationEncoding(format: TftEsPiAnimationFormat): TftEsPiAnimationEncoding {
  return format === 'rgb332' ? 'rgb332' : 'rgb565-be';
}

function getAnimationCodec(format: TftEsPiAnimationFormat) {
  return format === 'rgb332' ? 'tft-rgb332-frames-v1' : 'tft-rgb565-be-frames-v1';
}

function getBytesPerPixel(format: TftEsPiAnimationFormat) {
  return format === 'rgb332' ? 1 : 2;
}

function getFrameByteLength(width: number, height: number, format: TftEsPiAnimationFormat) {
  return Math.max(1, width * height * getBytesPerPixel(format));
}

function getMaxFramesForDimensions(width: number, height: number, format: TftEsPiAnimationFormat) {
  const frameBytes = getFrameByteLength(width, height, format);
  return Math.max(1, Math.min(MAX_FRAMES, Math.floor(MAX_OUTPUT_BYTES / frameBytes)));
}

export class FieldTftEsPiAnimation extends Blockly.Field<TftEsPiAnimationValue> {
  private initialValue: TftEsPiAnimationValue | null = null;
  private imgWidth = DEFAULT_WIDTH;
  private imgHeight = DEFAULT_HEIGHT;
  private fps = DEFAULT_FPS;
  private maxFrames = DEFAULT_MAX_FRAMES;
  private pixelFormat = DEFAULT_FORMAT;
  private readonly fieldHeight: number;
  private readonly imageMode: boolean;
  private blockDisplayImage: SVGImageElement | null = null;
  private blockPreviewDataUrl = '';
  private statusElement: HTMLElement | null = null;
  private previewCanvas: HTMLCanvasElement | null = null;
  private frameRangeInput: HTMLInputElement | null = null;
  private frameIndexElement: HTMLElement | null = null;
  private playButton: HTMLButtonElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  private widthInput: HTMLInputElement | null = null;
  private heightInput: HTMLInputElement | null = null;
  private fpsInput: HTMLInputElement | null = null;
  private maxFramesInput: HTMLInputElement | null = null;
  private formatSelect: HTMLSelectElement | null = null;
  private settingsTimer: ReturnType<typeof setTimeout> | null = null;
  private sourceRedecodeTimer: ReturnType<typeof setTimeout> | null = null;
  private activeDecodeTask: ActiveDecodeTask | null = null;
  private playTimer: ReturnType<typeof setTimeout> | null = null;
  private playActive = false;
  private currentFrame = 0;
  private requestId = 0;
  private valueVersion = 0;
  private uploadRequestId = 0;
  private applyingDecodedValue = false;
  private isDisposed = false;
  private resolvedFrames: Uint8Array[] = [];
  private resolvedFrameRefId = '';
  private loadingFrames: Promise<Uint8Array[]> | null = null;
  private sourceBlockRenderScheduled = false;

  constructor(
    value: TftEsPiAnimationValue | typeof Blockly.Field.SKIP_SETUP,
    validator?: Blockly.FieldValidator<TftEsPiAnimationValue>,
    config?: FieldTftEsPiAnimationFromJsonConfig,
  ) {
    super(value, validator, config);
    this.SERIALIZABLE = true;
    this.fieldHeight = config?.fieldHeight ?? BLOCK_FIELD_HEIGHT;
    this.imageMode = config?.imageMode === true;

    const normalized = this.normalizeValue(
      value === Blockly.Field.SKIP_SETUP ? config?.value : value,
      config,
    );
    this.syncSettings(normalized);

    if (value === Blockly.Field.SKIP_SETUP && !config?.value) {
      this.setValue(normalized);
    }
  }

  static override fromJson(options: FieldTftEsPiAnimationFromJsonConfig) {
    const imageMode = options.imageMode === true || options.type === 'field_tftespi_image';
    return new this(options.value ?? Blockly.Field.SKIP_SETUP, undefined, {
      ...options,
      imageMode,
      fps: imageMode ? 1 : options.fps,
      maxFrames: imageMode ? 1 : options.maxFrames,
    });
  }

  protected override doClassValidation_(
    newValue?: TftEsPiAnimationValue,
  ): TftEsPiAnimationValue | null | undefined {
    if (!newValue || typeof newValue !== 'object') return null;
    return this.normalizeValue(newValue);
  }

  protected override doValueUpdate_(newValue: TftEsPiAnimationValue) {
    const dimensionsChanged = this.imgWidth !== newValue.width || this.imgHeight !== newValue.height;
    if (!this.applyingDecodedValue) {
      this.clearSettingsTimer();
      this.clearSourceRedecodeTimer();
      this.invalidateDecodeOperations();
    }
    const nextRefId = newValue.frames?.$ailyData.id || '';
    if (nextRefId !== this.resolvedFrameRefId) {
      this.resolvedFrames = [];
      this.resolvedFrameRefId = '';
      this.loadingFrames = null;
    }
    this.value_ = this.cloneValue(newValue);
    this.syncSettings(newValue);
    this.currentFrame = Math.min(this.currentFrame, Math.max(0, newValue.frameCount - 1));
    this.blockPreviewDataUrl = '';
    this.updateSize_();
    this.updateBlockDisplayImage();
    this.updateControlsFromValue();
    this.renderPreviewFrame(this.currentFrame);
    this.updateStatusFromValue();
    if (nextRefId && this.blockDisplayImage) {
      void this.ensureFramesLoaded().catch((error) => this.reportProjectDataLoadError(error));
    }
    if (dimensionsChanged) this.rerenderSourceBlockAfterResize();
  }

  override saveState(_doFullSerialization?: boolean): TftEsPiAnimationValue {
    return this.cloneValue(this.getValue());
  }

  protected override showEditor_() {
    const editor = this.createDropdownEditor();
    const dropdownContent = Blockly.DropDownDiv.getContentDiv();
    dropdownContent.appendChild(editor);
    dropdownContent.classList.add('contains-tftespi-animation-editor', 'ailyMediaFieldDropdown');
    Blockly.DropDownDiv.showPositionedByField(this, this.disposeDropdown.bind(this));
    void this.ensureFramesLoaded().catch((error) => this.reportProjectDataLoadError(error));
  }

  override initView() {
    this.blockDisplayImage = Blockly.utils.dom.createSvgElement(
      'image',
      {
        x: 0,
        y: 0,
        style: 'image-rendering: pixelated; cursor: pointer;',
      },
      this.getSvgRoot(),
    ) as SVGImageElement;
    this.updateSize_();
    this.updateBlockDisplayImage();
    void this.ensureFramesLoaded().catch((error) => this.reportProjectDataLoadError(error));
  }

  protected override render_() {
    super.render_();
    this.updateBlockDisplayImage();
  }

  override updateEditable() {
    const editable = super.updateEditable();
    const svgRoot = this.getSvgRoot();
    if (svgRoot) {
      Blockly.utils.dom.removeClass(svgRoot, 'blocklyNonEditableText');
      Blockly.utils.dom.removeClass(svgRoot, 'blocklyEditableText');
    }
    return editable;
  }

  protected override updateSize_() {
    const scale = this.fieldHeight / Math.max(1, this.imgHeight);
    const width = Math.max(1, this.imgWidth * scale);
    const height = this.fieldHeight;
    if (this.borderRect_) {
      this.borderRect_.setAttribute('width', String(width));
      this.borderRect_.setAttribute('height', String(height));
    }
    if (this.blockDisplayImage) {
      this.blockDisplayImage.setAttribute('width', String(width));
      this.blockDisplayImage.setAttribute('height', String(height));
    }
    this.size_.width = width;
    this.size_.height = height;
  }

  override dispose() {
    this.isDisposed = true;
    this.uploadRequestId += 1;
    this.clearSettingsTimer();
    this.clearSourceRedecodeTimer();
    this.stopPreview(false);
    this.invalidateDecodeOperations();
    super.dispose();
  }

  private createDropdownEditor() {
    this.initialValue = this.cloneValue(this.getValue());
    const editor = this.createElement('div', 'tftEsPiAnimationEditor ailyMediaFieldEditor');
    editor.addEventListener('pointerdown', (event) => event.stopPropagation());

    const toolbar = this.createElement('div', 'tftEsPiAnimationToolbar ailyMediaFieldToolbar');
    const settings = this.createElement('div', 'tftEsPiAnimationSettings ailyMediaFieldSettings');
    this.widthInput = this.createNumberInput(this.imgWidth, 1, MAX_WIDTH);
    this.heightInput = this.createNumberInput(this.imgHeight, 1, MAX_HEIGHT);
    this.fpsInput = this.createNumberInput(this.fps, 1, MAX_FPS);
    this.formatSelect = this.createFormatSelect(this.pixelFormat);
    this.maxFramesInput = this.createNumberInput(
      this.maxFrames,
      1,
      this.getMaxFramesLimit(this.imgWidth, this.imgHeight, this.pixelFormat),
    );
    settings.append(
      this.createNumberControl(Blockly.Msg['TFTESPI_ANIMATION_LABEL_WIDTH'], this.widthInput),
      this.createNumberControl(Blockly.Msg['TFTESPI_ANIMATION_LABEL_HEIGHT'], this.heightInput),
    );
    if (!this.imageMode) {
      settings.append(
        this.createNumberControl(Blockly.Msg['TFTESPI_ANIMATION_LABEL_FPS'], this.fpsInput),
        this.createNumberControl(Blockly.Msg['TFTESPI_ANIMATION_LABEL_MAX_FRAMES'], this.maxFramesInput),
      );
    }
    settings.append(
      this.createNumberControl(Blockly.Msg['TFTESPI_ANIMATION_LABEL_COLOR_MODE'], this.formatSelect),
    );
    for (const input of [this.widthInput, this.heightInput, this.fpsInput, this.maxFramesInput]) {
      input.addEventListener('input', () => this.scheduleSettingsCommit());
      input.addEventListener('change', () => this.scheduleSettingsCommit());
      input.addEventListener('blur', () => this.scheduleSettingsCommit());
    }
    this.formatSelect.addEventListener('change', () => this.scheduleSettingsCommit());
    toolbar.appendChild(settings);

    const actions = this.createElement('div', 'tftEsPiAnimationActions ailyMediaFieldActions');
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = this.imageMode
      ? 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif'
      : 'video/mp4,image/gif,.mp4,.gif';
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => void this.onFileSelected());
    actions.appendChild(this.fileInput);
    actions.append(
      this.createButton(
        Blockly.Msg['TFTESPI_ANIMATION_BUTTON_UPLOAD'],
        () => this.fileInput?.click(),
        this.imageMode
          ? this.getMessage('UPLOAD_TOOLTIP')
          : Blockly.Msg['TFTESPI_ANIMATION_UPLOAD_TOOLTIP'],
      ),
      this.createButton(
        Blockly.Msg['TFTESPI_ANIMATION_BUTTON_CLEAR'],
        () => this.clearAnimation(),
      ),
    );
    toolbar.appendChild(actions);
    editor.appendChild(toolbar);

    this.statusElement = this.createElement('div', 'tftEsPiAnimationStatus ailyMediaFieldStatus');
    editor.appendChild(this.statusElement);

    const preview = this.createElement('div', 'tftEsPiAnimationPreview ailyMediaFieldSurface');
    this.previewCanvas = document.createElement('canvas');
    this.previewCanvas.className = 'tftEsPiAnimationCanvas';
    preview.appendChild(this.previewCanvas);

    const playback = this.createElement('div', 'tftEsPiAnimationPlayback');
    this.playButton = this.createIconButton(
      'fa-light fa-play',
      () => this.togglePreview(),
      Blockly.Msg['TFTESPI_ANIMATION_PLAY_TEST_TOOLTIP'],
    );
    this.frameRangeInput = document.createElement('input');
    this.frameRangeInput.type = 'range';
    this.frameRangeInput.min = '0';
    this.frameRangeInput.step = '1';
    this.frameRangeInput.addEventListener('input', () => {
      this.stopPreview(false);
      this.renderPreviewFrame(Number(this.frameRangeInput?.value || 0));
    });
    this.frameIndexElement = this.createElement('span', 'tftEsPiAnimationFrameIndex');
    playback.append(this.playButton, this.frameRangeInput, this.frameIndexElement);
    preview.appendChild(playback);
    editor.appendChild(preview);

    this.updateControlsFromValue();
    this.renderPreviewFrame(0);
    this.updateStatusFromValue();
    this.syncDropdownWidthToToolbar(editor, toolbar);
    return editor;
  }

  private syncDropdownWidthToToolbar(editor: HTMLElement, toolbar: HTMLElement) {
    requestAnimationFrame(() => {
      if (!editor.isConnected) return;

      const toolbarWidth = Math.ceil(toolbar.getBoundingClientRect().width || toolbar.scrollWidth);
      if (toolbarWidth <= 0) return;

      const style = getComputedStyle(editor);
      const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      editor.style.width = `${Math.ceil(toolbarWidth + horizontalPadding)}px`;
      if (this.isDropdownOpen()) Blockly.DropDownDiv.repositionForWindowResize();
    });
  }

  private createNumberInput(value: number, min: number, max: number) {
    const input = document.createElement('input');
    input.type = 'number';
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.className = 'ailyMediaFieldInput';
    return input;
  }

  private createFormatSelect(value: TftEsPiAnimationFormat) {
    const select = document.createElement('select');
    for (const format of ['rgb565', 'rgb332'] as const) {
      const option = document.createElement('option');
      option.value = format;
      option.textContent = format.toUpperCase();
      select.appendChild(option);
    }
    select.value = value;
    select.className = 'ailyMediaFieldInput';
    return select;
  }

  private createNumberControl(label: string, input: HTMLElement) {
    const wrapper = this.createElement('label', 'tftEsPiAnimationNumberControl ailyMediaFieldControl');
    const labelElement = document.createElement('span');
    labelElement.textContent = label;
    wrapper.append(labelElement, input);
    return wrapper;
  }

  private createButton(text: string, callback: () => void, title?: string) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tftEsPiAnimationButton ailyMediaFieldButton';
    button.textContent = text;
    if (title) button.title = title;
    button.addEventListener('click', callback);
    return button;
  }

  private createIconButton(iconClassName: string, callback: () => void, label: string) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tftEsPiAnimationButton tftEsPiAnimationIconButton ailyMediaFieldButton ailyMediaFieldIconButton';
    button.title = label;
    button.setAttribute('aria-label', label);

    const icon = document.createElement('i');
    icon.className = iconClassName;
    button.appendChild(icon);
    button.addEventListener('click', callback);
    return button;
  }

  private scheduleSettingsCommit() {
    this.clearSettingsTimer();
    this.settingsTimer = setTimeout(
      () => this.commitSettings(),
      MEDIA_FIELD_PARAMETER_DEBOUNCE_MS,
    );
  }

  private clearSettingsTimer() {
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = null;
  }

  private commitSettings() {
    this.clearSettingsTimer();
    const current = this.getValue();
    const width = this.clampInput(this.widthInput, current.width, 1, MAX_WIDTH);
    const height = this.clampInput(this.heightInput, current.height, 1, MAX_HEIGHT);
    const fps = this.clampInput(this.fpsInput, current.fps, 1, MAX_FPS);
    const format = normalizeAnimationFormat(this.formatSelect?.value, current.format);
    const maxAllowedFrames = this.getMaxFramesLimit(width, height, format);
    if (this.maxFramesInput) this.maxFramesInput.max = String(maxAllowedFrames);
    const maxFrames = this.clampInput(this.maxFramesInput, current.maxFrames, 1, maxAllowedFrames);
    const dimensionsChanged = width !== current.width || height !== current.height;
    const formatChanged = format !== current.format;
    const requiresRedecode = dimensionsChanged || formatChanged || maxFrames < current.frameCount;
    const settingsChanged = requiresRedecode || fps !== current.fps || maxFrames !== current.maxFrames;
    if (!settingsChanged) return;

    const nextValue: TftEsPiAnimationValue = {
      ...current,
      width,
      height,
      fps,
      maxFrames,
      format,
      encoding: getAnimationEncoding(format),
      frameCount: requiresRedecode ? 0 : current.frameCount,
      frames: requiresRedecode ? null : current.frames,
    };
    this.setValue(nextValue, !this.isDropdownOpen());
    if (nextValue.sourcePath) this.scheduleRedecodeFromSource();
  }

  private clampInput(
    input: HTMLInputElement | null,
    fallback: number,
    min: number,
    max: number,
  ) {
    const parsed = Number(input?.value);
    const normalized = Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, Math.floor(parsed)))
      : fallback;
    if (input) input.value = String(normalized);
    return normalized;
  }

  private async onFileSelected() {
    const file = this.fileInput?.files?.[0];
    if (!file) return;
    this.stopPreview(false);
    this.commitSettings();
    this.clearSourceRedecodeTimer();
    const uploadRequestId = ++this.uploadRequestId;
    const decodeVersion = this.invalidateDecodeOperations();

    try {
      if (!this.isSupportedSource(file.name, file.type)) {
        throw new Error(this.getMessage('WORKER_ERROR_UNSUPPORTED_FILE_TYPE'));
      }
      if (file.size > MAX_SOURCE_FILE_SIZE_BYTES) {
        throw new Error(this.getMessage('ERROR_FILE_SIZE_EXCEEDED', {
          maxSize: this.formatFileSize(MAX_SOURCE_FILE_SIZE_BYTES),
          currentSize: this.formatFileSize(file.size),
        }));
      }

      this.setStatus(this.getMessage('STATUS_READING_FILE', { name: file.name }));
      const buffer = await file.arrayBuffer();
      if (!this.isUploadOperationCurrent(uploadRequestId, decodeVersion)) return;
      this.setStatus(this.getMessage('STATUS_SAVING_FILE', { name: file.name }));
      const sourcePath = this.persistSourceFile(file, buffer);
      const value = this.getValue();
      await this.decodeAnimation({
        fileName: file.name,
        mimeType: file.type || this.inferMimeType(file.name),
        buffer,
        sourcePath,
      }, value.width, value.height, value.fps, value.maxFrames, value.format, decodeVersion);
    } catch (error: any) {
      if (error instanceof AnimationDecodeCancelledError) return;
      if (!this.isUploadOperationCurrent(uploadRequestId, decodeVersion)) return;
      this.setStatus(error?.message || this.getMessage('ERROR_DECODE_FAILED'), true);
    } finally {
      if (this.fileInput && uploadRequestId === this.uploadRequestId) this.fileInput.value = '';
    }
  }

  private async decodeAnimation(
    source: AnimationDecodeSource,
    width: number,
    height: number,
    fps: number,
    maxFrames: number,
    format: TftEsPiAnimationFormat,
    expectedVersion: number,
  ) {
    if (!this.isDecodeVersionCurrent(expectedVersion)) return;
    this.cancelActiveDecode();
    if (!this.isDecodeVersionCurrent(expectedVersion)) return;
    const worker = new Worker(
      new URL('./tftespi-animation-decoder.worker.ts', import.meta.url),
      { type: 'module' },
    );
    const requestId = ++this.requestId;
    let task: ActiveDecodeTask | null = null;

    try {
      await new Promise<void>((resolve, reject) => {
        task = { worker, requestId, reject };
        this.activeDecodeTask = task;
        worker.onmessage = async (event: MessageEvent<DecodeWorkerMessage>) => {
          const message = event.data;
          if (!message || message.requestId !== requestId || this.activeDecodeTask !== task) return;
          if (message.type === 'progress') {
            if (expectedVersion === this.valueVersion) {
              this.setStatus(this.resolveWorkerMessage(message, 'STATUS_DECODING'));
            }
            return;
          }
          if (message.type === 'done') {
            if (!message.result) {
              this.activeDecodeTask = null;
              reject(new Error(this.getMessage('ERROR_DECODE_FAILED')));
              return;
            }
            try {
              const result = await this.persistDecodedFrames(message.result, {
                sourceName: source.fileName,
                sourceType: source.mimeType || message.result.sourceType,
                sourcePath: source.sourcePath,
              });
              if (this.isDecodeVersionCurrent(expectedVersion)) {
                this.currentFrame = 0;
                this.applyingDecodedValue = true;
                try {
                  this.setValue(result.value, !this.isDropdownOpen());
                  this.setResolvedFrames(result.value.frames, result.frames);
                  this.refreshResolvedFrames();
                } finally {
                  this.applyingDecodedValue = false;
                }
              }
              this.activeDecodeTask = null;
              resolve();
            } catch (error) {
              this.activeDecodeTask = null;
              reject(error instanceof Error ? error : new Error(String(error)));
            }
            return;
          }
          if (message.type === 'error') {
            this.activeDecodeTask = null;
            if (!this.isDecodeVersionCurrent(expectedVersion)) {
              resolve();
              return;
            }
            reject(new Error(this.resolveWorkerMessage(message, 'ERROR_DECODE_FAILED')));
          }
        };
        worker.onerror = (error) => {
          if (this.activeDecodeTask === task) this.activeDecodeTask = null;
          if (!this.isDecodeVersionCurrent(expectedVersion)) {
            resolve();
            return;
          }
          reject(new Error(error.message || this.getMessage('ERROR_DECODE_FAILED')));
        };
        worker.postMessage({
          type: 'decode',
          requestId,
          fileName: source.fileName,
          mimeType: source.mimeType,
          buffer: source.buffer,
          width,
          height,
          fps,
          maxFrames,
          format,
        }, [source.buffer]);
      });
    } catch (error) {
      if (error instanceof AnimationDecodeCancelledError) return;
      throw error;
    } finally {
      if (this.activeDecodeTask === task) this.activeDecodeTask = null;
      worker.terminate();
    }
  }

  private async persistDecodedFrames(
    decoded: DecodedTftEsPiAnimationValue,
    source: Pick<TftEsPiAnimationValue, 'sourceName' | 'sourceType' | 'sourcePath'>,
  ): Promise<{ value: TftEsPiAnimationValue; frames: Uint8Array[] }> {
    const frameByteLength = getFrameByteLength(decoded.width, decoded.height, decoded.format);
    const frames = decoded.frames.slice(0, decoded.maxFrames);
    if (frames.length === 0 || frames.some((frame) => (
      !(frame instanceof Uint8Array) || frame.byteLength !== frameByteLength
    ))) {
      throw new Error(this.getMessage('ERROR_DECODE_FAILED'));
    }

    const packedFrames = new Uint8Array(frameByteLength * frames.length);
    frames.forEach((frame, index) => packedFrames.set(frame, index * frameByteLength));
    const ref = await projectDataRuntime.put({
      codec: getAnimationCodec(decoded.format),
      storage: 'raw-v1',
      value: packedFrames,
    });

    return {
      value: {
        schemaVersion: 1,
        format: decoded.format,
        encoding: getAnimationEncoding(decoded.format),
        width: decoded.width,
        height: decoded.height,
        fps: decoded.fps,
        maxFrames: decoded.maxFrames,
        frameCount: frames.length,
        frames: ref,
        ...source,
      },
      frames,
    };
  }

  private scheduleRedecodeFromSource() {
    this.clearSourceRedecodeTimer();
    this.sourceRedecodeTimer = setTimeout(() => {
      this.sourceRedecodeTimer = null;
      void this.redecodeFromSource();
    }, 0);
  }

  private clearSourceRedecodeTimer() {
    if (this.sourceRedecodeTimer) clearTimeout(this.sourceRedecodeTimer);
    this.sourceRedecodeTimer = null;
  }

  private async redecodeFromSource() {
    const value = this.getValue();
    if (!value.sourcePath) return;
    const sourceFilePath = this.resolveSourceFilePath(value.sourcePath);
    const fsApi = (window as any)['fs'];
    if (!sourceFilePath || (!fsApi?.readFileBuffer && !fsApi?.readFileAsBase64)) {
      this.setStatus(this.getMessage('ERROR_SOURCE_MISSING_REDECODE'), true);
      return;
    }
    if (typeof fsApi.existsSync === 'function' && !fsApi.existsSync(sourceFilePath)) {
      this.setStatus(this.getMessage('ERROR_SOURCE_NOT_FOUND', { path: value.sourcePath }), true);
      return;
    }

    try {
      const sourceName = value.sourceName || this.getPathBaseName(value.sourcePath);
      const decodeVersion = this.valueVersion;
      this.setStatus(this.getMessage('STATUS_REDECODING', { name: sourceName }));
      await this.decodeAnimation({
        fileName: sourceName,
        mimeType: value.sourceType || this.inferMimeType(value.sourcePath),
        buffer: this.readSourceFileBuffer(sourceFilePath, fsApi),
        sourcePath: value.sourcePath,
      }, value.width, value.height, value.fps, value.maxFrames, value.format, decodeVersion);
    } catch (error: any) {
      if (error instanceof AnimationDecodeCancelledError) return;
      this.setStatus(error?.message || this.getMessage('ERROR_REDECODE_FAILED'), true);
    }
  }

  private persistSourceFile(file: File, buffer: ArrayBuffer) {
    const projectPath = this.getCurrentProjectPath();
    const fsApi = (window as any)['fs'];
    const pathApi = (window as any)['path'];
    if (!projectPath || !fsApi || !pathApi?.join || !pathApi?.relative) {
      throw new Error(this.getMessage('ERROR_PROJECT_PATH_MISSING'));
    }
    if (typeof fsApi.mkdirSync !== 'function') {
      throw new Error(this.getMessage('ERROR_FS_CREATE_ASSETS_UNAVAILABLE'));
    }

    const assetsDir = pathApi.join(projectPath, 'assets', 'tftespi-animation');
    fsApi.mkdirSync(assetsDir);
    const fileName = `${this.calculateSourceMd5(buffer, fsApi)}${this.getSourceExtension(file.name, file.type)}`;
    const assetFilePath = pathApi.join(assetsDir, fileName);
    if (typeof fsApi.existsSync === 'function' && fsApi.existsSync(assetFilePath)) {
      return this.normalizeAssetPath(pathApi.relative(projectPath, assetFilePath));
    }
    if (typeof fsApi.writeFileBuffer === 'function') {
      fsApi.writeFileBuffer(assetFilePath, buffer);
    } else if (typeof fsApi.writeFileSync === 'function') {
      fsApi.writeFileSync(assetFilePath, new Uint8Array(buffer));
    } else if (typeof fsApi.writeBase64File === 'function') {
      fsApi.writeBase64File(assetFilePath, bytesToBase64(new Uint8Array(buffer)));
    } else {
      throw new Error(this.getMessage('ERROR_FS_SAVE_UNAVAILABLE'));
    }
    return this.normalizeAssetPath(pathApi.relative(projectPath, assetFilePath));
  }

  private calculateSourceMd5(buffer: ArrayBuffer, fsApi: any) {
    if (typeof fsApi.md5Buffer !== 'function') {
      throw new Error(this.getMessage('ERROR_MD5_UNAVAILABLE'));
    }
    const md5 = String(fsApi.md5Buffer(buffer) || '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(md5)) {
      throw new Error(this.getMessage('ERROR_MD5_FAILED'));
    }
    return md5;
  }

  private readSourceFileBuffer(sourceFilePath: string, fsApi: any): ArrayBuffer {
    if (typeof fsApi.readFileBuffer === 'function') {
      return this.toArrayBuffer(fsApi.readFileBuffer(sourceFilePath));
    }
    if (typeof fsApi.readFileAsBase64 === 'function') {
      return base64ToBytes(fsApi.readFileAsBase64(sourceFilePath)).buffer;
    }
    throw new Error(this.getMessage('ERROR_FS_READ_UNAVAILABLE'));
  }

  private toArrayBuffer(data: unknown): ArrayBuffer {
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    }
    if (Array.isArray(data)) return new Uint8Array(data).buffer;
    const maybeBuffer = data as { type?: string; data?: unknown };
    if (maybeBuffer?.type === 'Buffer' && Array.isArray(maybeBuffer.data)) {
      return new Uint8Array(maybeBuffer.data).buffer;
    }
    throw new Error(this.getMessage('ERROR_SOURCE_READ_INVALID'));
  }

  private resolveSourceFilePath(sourcePath: string): string | null {
    const projectPath = this.getCurrentProjectPath();
    const pathApi = (window as any)['path'];
    if (!projectPath || !sourcePath || !pathApi?.join || !pathApi?.resolve || !pathApi?.relative) return null;
    const trimmed = sourcePath.trim();
    const fullPath = typeof pathApi.isAbsolute === 'function' && pathApi.isAbsolute(trimmed)
      ? trimmed
      : pathApi.join(projectPath, ...trimmed.split(/[\\/]+/).filter(Boolean));
    const projectRoot = pathApi.resolve(projectPath);
    const resolved = pathApi.resolve(fullPath);
    const relative = pathApi.relative(projectRoot, resolved);
    if (relative.startsWith('..') || (typeof pathApi.isAbsolute === 'function' && pathApi.isAbsolute(relative))) {
      return null;
    }
    return resolved;
  }

  private getCurrentProjectPath(): string | null {
    const projectServicePath = (window as any)['projectService']?.currentProjectPath;
    if (typeof projectServicePath === 'string' && projectServicePath.trim()) return projectServicePath;
    const searchPath = new URLSearchParams(window.location.search).get('path');
    if (searchPath) return searchPath;
    const hashQueryIndex = window.location.hash.indexOf('?');
    if (hashQueryIndex >= 0) {
      return new URLSearchParams(window.location.hash.slice(hashQueryIndex + 1)).get('path');
    }
    return null;
  }

  async ensureFramesLoaded(): Promise<Uint8Array[]> {
    const value = this.getValue();
    const ref = value.frames;
    if (!ref || value.frameCount === 0) {
      this.setResolvedFrames(null, []);
      return [];
    }
    const refId = ref.$ailyData.id;
    if (this.resolvedFrameRefId === refId && this.resolvedFrames.length === value.frameCount) {
      return this.resolvedFrames;
    }
    if (this.loadingFrames) return this.loadingFrames;

    const loading = projectDataRuntime.resolve<Uint8Array>(ref).then((packedFrames) => {
      const current = this.getValue();
      if (current.frames?.$ailyData.id !== refId) return [];
      const frameByteLength = getFrameByteLength(current.width, current.height, current.format);
      const expectedLength = frameByteLength * current.frameCount;
      if (!(packedFrames instanceof Uint8Array) || packedFrames.byteLength !== expectedLength) {
        throw new Error(`expected ${expectedLength} bytes, received ${packedFrames.byteLength}`);
      }
      const frames = Array.from({ length: current.frameCount }, (_, index) => (
        packedFrames.subarray(index * frameByteLength, (index + 1) * frameByteLength)
      ));
      this.setResolvedFrames(ref, frames);
      this.refreshResolvedFrames();
      return frames;
    }).finally(() => {
      if (this.loadingFrames === loading) this.loadingFrames = null;
    });
    this.loadingFrames = loading;
    return loading;
  }

  private setResolvedFrames(ref: AilyDataRef | null, frames: Uint8Array[]) {
    this.resolvedFrameRefId = ref?.$ailyData.id || '';
    this.resolvedFrames = frames;
  }

  private refreshResolvedFrames() {
    this.blockPreviewDataUrl = '';
    this.renderPreviewFrame(this.currentFrame);
    this.updateBlockDisplayImage();
    this.updateStatusFromValue();
  }

  private reportProjectDataLoadError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.setStatus(this.getMessage('ERROR_PROJECT_DATA_LOAD_FAILED', { message }), true);
  }

  private renderPreviewFrame(frameIndex: number) {
    const value = this.getValue();
    const frames = this.resolvedFrames;
    if (frames.length === 0) {
      this.currentFrame = 0;
      if (this.previewCanvas) this.drawEmptyCanvas(this.previewCanvas, value.width, value.height);
      if (this.frameRangeInput) {
        this.frameRangeInput.max = '0';
        this.frameRangeInput.value = '0';
        this.frameRangeInput.disabled = true;
      }
      if (this.frameIndexElement) this.frameIndexElement.textContent = '0/0';
      this.updatePlayButton();
      return;
    }
    this.currentFrame = Math.min(frames.length - 1, Math.max(0, Math.floor(frameIndex)));
    if (this.previewCanvas) {
      this.drawFrameToCanvas(this.previewCanvas, frames[this.currentFrame], value.width, value.height, value.format);
    }
    if (this.frameRangeInput) {
      this.frameRangeInput.max = String(Math.max(0, frames.length - 1));
      this.frameRangeInput.value = String(this.currentFrame);
      this.frameRangeInput.disabled = frames.length <= 1;
    }
    if (this.frameIndexElement) this.frameIndexElement.textContent = `${this.currentFrame + 1}/${frames.length}`;
    this.updatePlayButton();
  }

  private drawFrameToCanvas(
    canvas: HTMLCanvasElement,
    bytes: Uint8Array,
    width: number,
    height: number,
    format: TftEsPiAnimationFormat,
  ) {
    if (bytes.length !== getFrameByteLength(width, height, format)) return;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    const imageData = context.createImageData(width, height);
    for (let pixel = 0; pixel < width * height; pixel++) {
      const target = pixel * 4;
      if (format === 'rgb332') {
        const colour = bytes[pixel];
        imageData.data[target] = Math.round(((colour >> 5) & 0x07) * 255 / 7);
        imageData.data[target + 1] = Math.round(((colour >> 2) & 0x07) * 255 / 7);
        imageData.data[target + 2] = Math.round((colour & 0x03) * 255 / 3);
      } else {
        const colour = (bytes[pixel * 2] << 8) | bytes[pixel * 2 + 1];
        imageData.data[target] = Math.round(((colour >> 11) & 0x1f) * 255 / 31);
        imageData.data[target + 1] = Math.round(((colour >> 5) & 0x3f) * 255 / 63);
        imageData.data[target + 2] = Math.round((colour & 0x1f) * 255 / 31);
      }
      imageData.data[target + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);
  }

  private drawEmptyCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);
  }

  private updateBlockDisplayImage() {
    if (!this.blockDisplayImage) return;
    if (!this.blockPreviewDataUrl) {
      const value = this.getValue();
      const canvas = document.createElement('canvas');
      if (this.resolvedFrames.length > 0) {
        this.drawFrameToCanvas(canvas, this.resolvedFrames[0], value.width, value.height, value.format);
      } else {
        this.drawEmptyCanvas(canvas, value.width, value.height);
      }
      this.blockPreviewDataUrl = canvas.toDataURL('image/png');
    }
    this.blockDisplayImage.setAttributeNS('http://www.w3.org/1999/xlink', 'href', this.blockPreviewDataUrl);
  }

  private togglePreview() {
    if (this.playActive) this.stopPreview(true);
    else this.startPreview();
  }

  private startPreview() {
    const value = this.getValue();
    if (this.resolvedFrames.length <= 1) return;
    this.stopPreview(false);
    this.playActive = true;
    const tick = () => {
      if (!this.playActive) return;
      const current = this.getValue();
      this.renderPreviewFrame((this.currentFrame + 1) % this.resolvedFrames.length);
      this.playTimer = setTimeout(tick, Math.max(1, Math.round(1000 / Math.max(1, current.fps))));
    };
    this.playTimer = setTimeout(tick, Math.max(1, Math.round(1000 / value.fps)));
    this.updatePlayButton();
  }

  private stopPreview(resetToFirst: boolean) {
    this.playActive = false;
    if (this.playTimer) clearTimeout(this.playTimer);
    this.playTimer = null;
    if (resetToFirst && this.previewCanvas) this.renderPreviewFrame(0);
    this.updatePlayButton();
  }

  private updatePlayButton() {
    if (!this.playButton) return;
    const value = this.getValue();
    const label = this.playActive
      ? Blockly.Msg['TFTESPI_ANIMATION_BUTTON_STOP_PLAY_TEST']
      : Blockly.Msg['TFTESPI_ANIMATION_BUTTON_PLAY_TEST'];
    this.playButton.disabled = this.resolvedFrames.length <= 1;
    this.playButton.title = this.playActive
      ? Blockly.Msg['TFTESPI_ANIMATION_BUTTON_STOP_PLAY_TEST']
      : Blockly.Msg['TFTESPI_ANIMATION_PLAY_TEST_TOOLTIP'];
    this.playButton.setAttribute('aria-label', label);
    this.playButton.setAttribute('aria-pressed', String(this.playActive));

    const icon = this.playButton.querySelector('i');
    if (icon) icon.className = this.playActive ? 'fa-light fa-stop' : 'fa-light fa-play';
  }

  private updateControlsFromValue() {
    const value = this.getValue();
    if (this.widthInput) this.widthInput.value = String(value.width);
    if (this.heightInput) this.heightInput.value = String(value.height);
    if (this.fpsInput) this.fpsInput.value = String(value.fps);
    if (this.formatSelect) this.formatSelect.value = value.format;
    if (this.maxFramesInput) {
      this.maxFramesInput.max = String(this.getMaxFramesLimit(value.width, value.height, value.format));
      this.maxFramesInput.value = String(value.maxFrames);
    }
    this.renderPreviewFrame(this.currentFrame);
  }

  private updateStatusFromValue() {
    if (!this.statusElement) return;
    const value = this.getValue();
    const message = value.sourceName || value.frameCount > 1
      ? this.getMessage('STATUS_INFO', {
        sourcePrefix: value.sourceName ? `${this.truncateStatusSourceName(value.sourceName)} | ` : '',
        frames: value.frameCount,
        width: value.width,
        height: value.height,
        fps: value.fps,
        mode: value.format.toUpperCase(),
        dataSize: this.formatDataSize(getFrameByteLength(value.width, value.height, value.format) * value.frameCount),
      })
      : this.getMessage('EMPTY');
    this.setStatus(message);
  }

  private truncateStatusSourceName(sourceName: string) {
    const maxUnits = 10;
    let usedUnits = 0;
    let result = '';

    for (const char of Array.from(sourceName)) {
      const charUnits = this.getStatusSourceNameCharUnits(char);
      if (usedUnits + charUnits > maxUnits) {
        return `${result}...`;
      }

      result += char;
      usedUnits += charUnits;
    }

    return result;
  }

  private getStatusSourceNameCharUnits(char: string) {
    return char.codePointAt(0)! > 0xff ? 2 : 1;
  }

  private setStatus(message: string, isError = false) {
    if (!this.statusElement) return;
    this.statusElement.textContent = message;
    this.statusElement.title = message;
    this.statusElement.classList.toggle('is-error', isError);
  }

  private resolveWorkerMessage(message: DecodeWorkerMessage, fallback: string) {
    return message.messageKey
      ? this.getMessage(message.messageKey, message.messageParams)
      : message.message || this.getMessage(fallback);
  }

  private clearAnimation() {
    this.clearSettingsTimer();
    this.clearSourceRedecodeTimer();
    this.uploadRequestId += 1;
    this.invalidateDecodeOperations();
    this.stopPreview(false);
    this.currentFrame = 0;
    this.setValue(this.createEmptyValue({
      width: this.imgWidth,
      height: this.imgHeight,
      fps: this.fps,
      maxFrames: this.maxFrames,
      format: this.pixelFormat,
    }), !this.isDropdownOpen());
  }

  private createEmptyValue(config?: FieldTftEsPiAnimationFromJsonConfig): TftEsPiAnimationValue {
    const width = this.normalizeNumber(config?.width, DEFAULT_WIDTH, 1, MAX_WIDTH);
    const height = this.normalizeNumber(config?.height, DEFAULT_HEIGHT, 1, MAX_HEIGHT);
    const fps = this.normalizeNumber(config?.fps, DEFAULT_FPS, 1, MAX_FPS);
    const format = normalizeAnimationFormat(config?.format);
    const maxFrames = this.normalizeNumber(
      config?.maxFrames,
      this.imageMode ? 1 : DEFAULT_MAX_FRAMES,
      1,
      this.getMaxFramesLimit(width, height, format),
    );
    return {
      schemaVersion: 1,
      format,
      encoding: getAnimationEncoding(format),
      width,
      height,
      fps,
      maxFrames,
      frameCount: 0,
      frames: null,
    };
  }

  private normalizeValue(
    value?: TftEsPiAnimationValue | null,
    config?: FieldTftEsPiAnimationFromJsonConfig,
  ): TftEsPiAnimationValue {
    const fallback = this.createEmptyValue(config);
    if (!value || typeof value !== 'object') return fallback;
    if (value.schemaVersion !== 1 || (value.format !== 'rgb565' && value.format !== 'rgb332')) {
      return fallback;
    }
    const format = value.format;
    if (value.encoding !== getAnimationEncoding(format)) {
      return fallback;
    }
    const width = this.normalizeNumber(value.width, fallback.width, 1, MAX_WIDTH);
    const height = this.normalizeNumber(value.height, fallback.height, 1, MAX_HEIGHT);
    const fps = this.normalizeNumber(value.fps, fallback.fps, 1, MAX_FPS);
    const maxFrames = this.normalizeNumber(
      value.maxFrames,
      fallback.maxFrames,
      1,
      this.getMaxFramesLimit(width, height, format),
    );
    let frameCount = this.normalizeNumber(value.frameCount, 0, 0, maxFrames);
    const expectedRawLength = getFrameByteLength(width, height, format) * frameCount;
    const frames = frameCount > 0
      && isAilyDataRef(value.frames)
      && value.frames.$ailyData.logicalType === 'binary'
      && value.frames.$ailyData.codec === getAnimationCodec(format)
      && value.frames.$ailyData.rawLength === expectedRawLength
      ? value.frames
      : null;
    if (!frames) frameCount = 0;
    return {
      schemaVersion: 1,
      format,
      encoding: getAnimationEncoding(format),
      width,
      height,
      fps,
      maxFrames,
      frameCount,
      frames,
      sourceName: value.sourceName,
      sourceType: value.sourceType,
      sourcePath: value.sourcePath,
    };
  }

  private normalizeNumber(value: unknown, fallback: number, min: number, max: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
  }

  private getMaxFramesLimit(width: number, height: number, format: TftEsPiAnimationFormat) {
    return this.imageMode ? 1 : getMaxFramesForDimensions(width, height, format);
  }

  private getMessage(messageName: string, params?: AnimationMessageParams) {
    return this.imageMode
      ? translateImageMessage(messageName, params)
      : translateMessage(messageName, params);
  }

  private cloneValue(value: TftEsPiAnimationValue | null) {
    const normalized = this.normalizeValue(value);
    return {
      ...normalized,
      frames: normalized.frames
        ? { $ailyData: { ...normalized.frames.$ailyData } }
        : null,
    };
  }

  private syncSettings(value: TftEsPiAnimationValue) {
    this.imgWidth = value.width;
    this.imgHeight = value.height;
    this.fps = value.fps;
    this.maxFrames = value.maxFrames;
    this.pixelFormat = value.format;
  }

  private valuesEqual(left: TftEsPiAnimationValue | null, right: TftEsPiAnimationValue | null) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private rerenderSourceBlockAfterResize() {
    const sourceBlock = this.getSourceBlock();
    if (!(sourceBlock instanceof Blockly.BlockSvg) || this.sourceBlockRenderScheduled) return;

    const rootBlock = typeof sourceBlock.getRootBlock === 'function'
      ? sourceBlock.getRootBlock()
      : sourceBlock;
    const blockToRender = rootBlock instanceof Blockly.BlockSvg ? rootBlock : sourceBlock;
    if (!blockToRender.rendered) return;

    this.sourceBlockRenderScheduled = true;
    const renderBlock = () => {
      this.sourceBlockRenderScheduled = false;
      if (!blockToRender.rendered) return;
      blockToRender.render();
      if (this.isDropdownOpen()) Blockly.DropDownDiv.repositionForWindowResize();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(renderBlock);
    else Promise.resolve().then(renderBlock);
  }

  private disposeDropdown() {
    this.clearSettingsTimer();
    this.commitSettings();
    this.stopPreview(false);
    if (
      this.getSourceBlock()
      && this.initialValue
      && !this.valuesEqual(this.initialValue, this.getValue())
    ) {
      Blockly.Events.fire(new (Blockly.Events.get(Blockly.Events.BLOCK_CHANGE))(
        this.sourceBlock_,
        'field',
        this.name || null,
        this.initialValue,
        this.getValue(),
      ));
    }
    this.initialValue = null;
    this.statusElement = null;
    this.previewCanvas = null;
    this.frameRangeInput = null;
    this.frameIndexElement = null;
    this.playButton = null;
    this.fileInput = null;
    this.widthInput = null;
    this.heightInput = null;
    this.fpsInput = null;
    this.maxFramesInput = null;
    this.formatSelect = null;
    Blockly.DropDownDiv.getContentDiv().classList.remove(
      'contains-tftespi-animation-editor',
      'ailyMediaFieldDropdown',
    );
  }

  private cancelActiveDecode() {
    const task = this.activeDecodeTask;
    if (!task) return;
    this.activeDecodeTask = null;
    task.worker.terminate();
    task.reject(new AnimationDecodeCancelledError('Animation conversion cancelled'));
  }

  private invalidateDecodeOperations() {
    this.valueVersion = (Number.isFinite(this.valueVersion) ? this.valueVersion : 0) + 1;
    this.cancelActiveDecode();
    return this.valueVersion;
  }

  private isDecodeVersionCurrent(version: number) {
    return !this.isDisposed && version === this.valueVersion;
  }

  private isUploadOperationCurrent(uploadRequestId: number, decodeVersion: number) {
    return uploadRequestId === this.uploadRequestId
      && this.isDecodeVersionCurrent(decodeVersion);
  }

  private isDropdownOpen() {
    return Blockly.DropDownDiv.getOwner() === this;
  }

  private isSupportedSource(fileName: string, mimeType: string) {
    const lowerName = fileName.toLowerCase();
    const lowerType = (mimeType || '').toLowerCase();
    if (this.imageMode) {
      return ['.gif', '.png', '.jpg', '.jpeg', '.webp'].some(extension => lowerName.endsWith(extension))
        || ['gif', 'png', 'jpeg', 'jpg', 'webp'].some(type => lowerType.includes(type));
    }
    return lowerName.endsWith('.gif') || lowerName.endsWith('.mp4')
      || lowerType.includes('gif') || lowerType.includes('mp4');
  }

  private inferMimeType(fileName: string) {
    const extension = this.getPathExtension(fileName).toLowerCase();
    if (extension === '.gif') return 'image/gif';
    if (extension === '.png') return 'image/png';
    if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
    if (extension === '.webp') return 'image/webp';
    return 'video/mp4';
  }

  private getSourceExtension(fileName: string, mimeType: string) {
    const extension = this.getPathExtension(fileName).toLowerCase();
    if (this.imageMode) {
      if (['.gif', '.png', '.jpg', '.jpeg', '.webp'].includes(extension)) return extension;
      const lowerType = mimeType.toLowerCase();
      if (lowerType.includes('gif')) return '.gif';
      if (lowerType.includes('png')) return '.png';
      if (lowerType.includes('jpeg') || lowerType.includes('jpg')) return '.jpg';
      if (lowerType.includes('webp')) return '.webp';
      throw new Error(this.getMessage('WORKER_ERROR_UNSUPPORTED_FILE_TYPE'));
    }
    if (extension === '.gif' || extension === '.mp4') return extension;
    return mimeType.toLowerCase().includes('gif') ? '.gif' : '.mp4';
  }

  private getPathExtension(fileName: string) {
    const pathApi = (window as any)['path'];
    if (pathApi?.extname) return pathApi.extname(fileName) || '';
    return /\.[^./\\]+$/.exec(fileName)?.[0] || '';
  }

  private getPathBaseName(fileName: string) {
    const pathApi = (window as any)['path'];
    if (pathApi?.basename) return pathApi.basename(fileName);
    return fileName.split(/[\\/]/).pop() || fileName;
  }

  private normalizeAssetPath(assetPath: string) {
    return assetPath.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  private formatFileSize(bytes: number) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  private formatDataSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  private createElement(elementType: string, className: string) {
    const element = document.createElement(elementType);
    element.className = className;
    return element;
  }
}

Blockly.fieldRegistry.register('field_tftespi_animation', FieldTftEsPiAnimation);
Blockly.fieldRegistry.register('field_tftespi_image', FieldTftEsPiAnimation);

Blockly.Css.register(`
.tftEsPiAnimationEditor {
  align-items: stretch;
  background: #2a2a2a;
  box-sizing: border-box;
  color: #f4f4f4;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: min(94vw, 880px);
  padding: 5px 10px;
  width: max-content;
}
.tftEsPiAnimationToolbar {
  align-items: center;
  display: flex;
  flex-wrap: nowrap;
  gap: 8px;
  justify-content: space-between;
  max-width: 100%;
  width: max-content;
}
.tftEsPiAnimationSettings,
.tftEsPiAnimationActions {
  align-items: center;
  display: inline-flex;
  flex-wrap: nowrap;
  gap: 6px;
}
.tftEsPiAnimationActions { margin-left: auto; }
.tftEsPiAnimationNumberControl {
  align-items: center;
  display: inline-flex;
  gap: 4px;
}
.tftEsPiAnimationNumberControl span {
  color: #e8e8e8;
  font-size: 12px;
  line-height: 1;
}
.tftEsPiAnimationNumberControl input,
.tftEsPiAnimationNumberControl select {
  background: #fff;
  border: 1px solid #777;
  border-radius: 4px;
  box-sizing: border-box;
  color: #222;
  font-size: 12px;
  height: 26px;
  padding: 0 4px;
  text-align: center;
  width: 48px;
}
.tftEsPiAnimationNumberControl select { width: 78px; }
.tftEsPiAnimationButton {
  background: #333;
  border: 1px solid #666;
  border-radius: 4px;
  color: #fff;
  cursor: pointer;
  font-size: 12px;
  height: 26px;
  margin: 0;
  padding: 0 10px;
}
.tftEsPiAnimationButton:hover {
  background: #444;
  border-color: #888;
}
.tftEsPiAnimationButton:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.tftEsPiAnimationIconButton {
  align-items: center;
  display: inline-flex;
  justify-content: center;
  padding: 0;
  width: 26px;
}
.tftEsPiAnimationIconButton i {
  font-size: 12px;
  line-height: 1;
}
.tftEsPiAnimationStatus {
  color: #cfcfcf;
  font-size: 12px;
  line-height: 1.4;
  max-width: 100%;
  min-height: 18px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tftEsPiAnimationStatus.is-error { color: #ffb3b3; }
.tftEsPiAnimationPreview {
  align-items: center;
  background: #1b1b1b;
  border: 1px solid #666;
  border-radius: 4px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 150px;
  padding: 8px;
  width: 100%;
}
.tftEsPiAnimationCanvas {
  background: #151515;
  border: 1px solid #444;
  display: block;
  image-rendering: pixelated;
  max-height: 190px;
  max-width: min(86vw, 640px);
  object-fit: contain;
}
.tftEsPiAnimationPlayback {
  align-items: center;
  display: flex;
  gap: 6px;
  width: min(100%, 620px);
}
.tftEsPiAnimationPlayback input[type='range'] {
  accent-color: var(--aily-color-accent, #4db6ac);
  flex: 1;
  min-width: 120px;
}
.tftEsPiAnimationFrameIndex {
  color: var(--aily-text-tertiary, #cfcfcf);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  min-width: 54px;
  text-align: right;
}
.blocklyDropDownContent.contains-tftespi-animation-editor {
  background: #2a2a2a;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  max-height: none;
  overflow: visible;
}
`);
