import * as Blockly from 'blockly/core';
import { projectDataRuntime } from '../../../../../services/project-data/project-data-runtime';
import { projectResourceGc } from '../../../services/project-resource-gc.service';
import { MEDIA_FIELD_PARAMETER_DEBOUNCE_MS } from './field-media-editor-style';

type AudioFieldParams = Record<string, string | number>;
type AudioFieldTranslator = (key: string, params?: AudioFieldParams) => string;

const AUDIO_I18N_PREFIX = 'BLOCKLY.AUDIO';
const AUDIO_MESSAGE_NAMES = [
  'BUTTON_UPLOAD',
  'BUTTON_CLEAR',
  'BUTTON_PLAY',
  'BUTTON_STOP',
  'UPLOAD_TOOLTIP',
  'LABEL_SAMPLE_RATE',
  'LABEL_CHANNELS',
  'LABEL_BIT_RATE',
  'LABEL_MONO',
  'LABEL_STEREO',
  'LABEL_START',
  'LABEL_END',
  'EMPTY',
  'STATUS_READING',
  'STATUS_DECODING',
  'STATUS_ENCODING',
  'STATUS_INFO',
  'ERROR_FILE_SIZE',
  'ERROR_DECODE',
  'ERROR_ENCODE',
  'ERROR_LOAD',
  'ERROR_PROJECT_PATH_MISSING',
  'ERROR_FS_UNAVAILABLE',
  'ERROR_FILE_MISSING',
  'WORKER_ERROR_INVALID_PCM',
  'WORKER_ERROR_DURATION_EXCEEDED',
  'WORKER_ERROR_INVALID_SETTINGS',
  'WORKER_ERROR_EMPTY_SELECTION',
  'WORKER_ERROR_ENCODE_FAILED',
] as const;

const DEFAULT_AUDIO_MESSAGES: Record<string, string> = {
  BUTTON_UPLOAD: 'Upload',
  BUTTON_CLEAR: 'Clear',
  BUTTON_PLAY: 'Play selection',
  BUTTON_STOP: 'Stop playback',
  UPLOAD_TOOLTIP: 'Select an audio file supported by the browser',
  LABEL_SAMPLE_RATE: 'Sample rate',
  LABEL_CHANNELS: 'Channels',
  LABEL_BIT_RATE: 'Bit rate',
  LABEL_MONO: 'Mono',
  LABEL_STEREO: 'Stereo',
  LABEL_START: 'Start',
  LABEL_END: 'End',
  EMPTY: 'No audio uploaded',
  STATUS_READING: 'Reading {{name}}...',
  STATUS_DECODING: 'Decoding {{name}}...',
  STATUS_ENCODING: 'Encoding MP3... {{progress}}%',
  STATUS_INFO: '{{name}} | {{duration}} | {{sampleRate}} Hz | {{channels}} ch | {{bitRate}} kbps | {{size}}',
  ERROR_FILE_SIZE: 'File size cannot exceed {{maxSize}}. Current file: {{currentSize}}',
  ERROR_DECODE: 'The browser could not decode this audio file',
  ERROR_ENCODE: 'MP3 encoding failed',
  ERROR_LOAD: 'Audio file could not be loaded: {{message}}',
  ERROR_PROJECT_PATH_MISSING: 'Current project folder was not found',
  ERROR_FS_UNAVAILABLE: 'File system API is unavailable for audio files',
  ERROR_FILE_MISSING: 'Audio file does not exist: {{path}}',
  WORKER_ERROR_INVALID_PCM: 'The decoded PCM data is invalid',
  WORKER_ERROR_DURATION_EXCEEDED: 'Audio duration cannot exceed 30 minutes',
  WORKER_ERROR_INVALID_SETTINGS: 'The MP3 settings are invalid',
  WORKER_ERROR_EMPTY_SELECTION: 'Select a non-empty audio range',
  WORKER_ERROR_ENCODE_FAILED: 'The MP3 encoder returned no data',
};

let audioFieldTranslator: AudioFieldTranslator | null = null;

function interpolate(message: string, params?: AudioFieldParams) {
  if (!params) return message;
  return message.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  ));
}

function translateAudioMessage(name: string, params?: AudioFieldParams) {
  const key = `${AUDIO_I18N_PREFIX}.${name}`;
  const translated = audioFieldTranslator?.(key, params);
  if (translated && translated !== key) return translated;
  return interpolate(DEFAULT_AUDIO_MESSAGES[name] || key, params);
}

function applyAudioBlocklyMessages() {
  for (const name of AUDIO_MESSAGE_NAMES) {
    Blockly.Msg[`AUDIO_${name}`] = translateAudioMessage(name);
  }
}

export function setAudioFieldTranslator(translator: AudioFieldTranslator | null) {
  audioFieldTranslator = translator;
  applyAudioBlocklyMessages();
}

applyAudioBlocklyMessages();

export interface AudioFieldValue {
  schemaVersion: 1;
  encoding: 'mp3-cbr-v1';
  sampleRate: number;
  channels: 1 | 2;
  bitRate: number;
  duration: number;
  trimStart: number;
  trimEnd: number;
  outputDuration: number;
  sourcePath?: string;
  audioPath?: string;
}

export interface FieldAudioFromJsonConfig extends Blockly.FieldConfig {
  value?: AudioFieldValue;
  sampleRate?: number;
  channels?: number;
  bitRate?: number;
  fieldWidth?: number;
  fieldHeight?: number;
}

interface WorkerResult {
  mp3: Uint8Array;
  duration: number;
  sampleCount: number;
}

interface WorkerResponse {
  type: 'progress' | 'done' | 'error';
  requestId: number;
  progress?: number;
  result?: WorkerResult;
  message?: string;
  messageKey?: string;
}

interface EncodingSettings {
  sampleRate: number;
  channels: 1 | 2;
  bitRate: number;
  trimStart: number;
  trimEnd: number;
}

interface ActiveEncodingTask {
  worker: Worker;
  reject: (error: Error) => void;
}

class AudioEncodingCancelledError extends Error {}

const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_CHANNELS: 1 | 2 = 1;
const DEFAULT_BIT_RATE = 16;
const DEFAULT_FIELD_WIDTH = 100;
const DEFAULT_FIELD_HEIGHT = 21;
const MAX_SOURCE_FILE_SIZE = 50 * 1024 * 1024;
const MAX_SOURCE_DURATION_SECONDS = 30 * 60;
const WAVEFORM_BINS = 360;
const MIN_TRIM_SECONDS = 0.02;
const SAMPLE_RATES = [8_000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000] as const;
const LOW_RATE_BIT_RATES = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] as const;
const HIGH_RATE_BIT_RATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] as const;

function validBitRates(sampleRate: number): readonly number[] {
  return sampleRate <= 24_000 ? LOW_RATE_BIT_RATES : HIGH_RATE_BIT_RATES;
}

function nearestNumber(value: unknown, values: readonly number[], fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return values.reduce((nearest, candidate) => (
    Math.abs(candidate - number) < Math.abs(nearest - number) ? candidate : nearest
  ), values.includes(fallback) ? fallback : values[0]);
}

export class FieldAudio extends Blockly.Field<AudioFieldValue> {
  private readonly fieldWidth: number;
  private readonly fieldHeight: number;
  private initialValue: AudioFieldValue | null = null;
  private blockDisplayImage: SVGImageElement | null = null;
  private blockPreviewUrl = '';
  private statusElement: HTMLElement | null = null;
  private waveformCanvas: HTMLCanvasElement | null = null;
  private trimTrack: HTMLElement | null = null;
  private trimSelection: HTMLElement | null = null;
  private trimStartHandle: HTMLButtonElement | null = null;
  private trimEndHandle: HTMLButtonElement | null = null;
  private trimStartLabel: HTMLElement | null = null;
  private trimEndLabel: HTMLElement | null = null;
  private playhead: HTMLElement | null = null;
  private playButton: HTMLButtonElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  private sampleRateSelect: HTMLSelectElement | null = null;
  private channelsSelect: HTMLSelectElement | null = null;
  private bitRateSelect: HTMLSelectElement | null = null;
  private pendingSampleRate = DEFAULT_SAMPLE_RATE;
  private pendingChannels: 1 | 2 = DEFAULT_CHANNELS;
  private pendingBitRate = DEFAULT_BIT_RATE;
  private pendingTrimStart = 0;
  private pendingTrimEnd = 0;
  private settingsTimer: ReturnType<typeof setTimeout> | null = null;
  private activeEncoding: ActiveEncodingTask | null = null;
  private operationVersion = 0;
  private requestId = 0;
  private applyingEncodedValue = false;
  private isDisposed = false;
  private decodedAudio: AudioBuffer | null = null;
  private decodedSourceId = '';
  private decodingAudio: Promise<AudioBuffer> | null = null;
  private sourceWaveform: number[] = [];
  private decodedOutputAudio: AudioBuffer | null = null;
  private decodedOutputId = '';
  private decodingOutputAudio: Promise<AudioBuffer> | null = null;
  private outputWaveform: number[] = [];
  private playbackContext: AudioContext | null = null;
  private playbackSource: AudioBufferSourceNode | null = null;
  private playbackAnimationFrame = 0;
  private playbackStartedAt = 0;
  private playbackOffset = 0;
  private playbackEnd = 0;
  private playbackDuration = 0;
  private draggedHandle: 'start' | 'end' | null = null;
  private removePointerListeners: (() => void) | null = null;

  constructor(
    value: AudioFieldValue | typeof Blockly.Field.SKIP_SETUP,
    validator?: Blockly.FieldValidator<AudioFieldValue>,
    config?: FieldAudioFromJsonConfig,
  ) {
    super(value, validator, config);
    this.SERIALIZABLE = true;
    this.fieldWidth = Math.max(40, Number(config?.fieldWidth) || DEFAULT_FIELD_WIDTH);
    this.fieldHeight = Math.max(16, Number(config?.fieldHeight) || DEFAULT_FIELD_HEIGHT);
    const normalized = this.normalizeValue(
      value === Blockly.Field.SKIP_SETUP ? config?.value : value,
      config,
    );
    this.syncPendingSettings(normalized);
    if (value === Blockly.Field.SKIP_SETUP && !config?.value) this.setValue(normalized);
  }

  static override fromJson(options: FieldAudioFromJsonConfig) {
    return new this(options.value ?? Blockly.Field.SKIP_SETUP, undefined, options);
  }

  protected override doClassValidation_(newValue?: AudioFieldValue) {
    if (!newValue || typeof newValue !== 'object') return null;
    return this.normalizeValue(newValue);
  }

  protected override doValueUpdate_(newValue: AudioFieldValue) {
    if (!this.applyingEncodedValue) this.invalidateOperations();
    const nextSourceId = newValue.sourcePath || '';
    if (nextSourceId !== this.decodedSourceId) {
      this.decodedAudio = null;
      this.decodedSourceId = '';
      this.decodingAudio = null;
      this.sourceWaveform = [];
    }
    const nextOutputId = newValue.audioPath || '';
    if (nextOutputId !== this.decodedOutputId) {
      if (this.playbackSource) this.stopPlayback(true);
      this.decodedOutputAudio = null;
      this.decodedOutputId = '';
      this.decodingOutputAudio = null;
      this.outputWaveform = [];
    }
    this.value_ = this.cloneValue(newValue);
    this.syncPendingSettings(newValue);
    this.blockPreviewUrl = '';
    this.updateSize_();
    this.updateBlockPreview();
    this.updateEditorFromValue();
  }

  override saveState(_doFullSerialization?: boolean) {
    return this.cloneValue(this.getValue());
  }

  override initView() {
    this.blockDisplayImage = Blockly.utils.dom.createSvgElement(
      'image',
      { x: 0, y: 0, style: 'cursor: pointer;' },
      this.getSvgRoot(),
    ) as SVGImageElement;
    this.updateSize_();
    this.updateBlockPreview();
  }

  protected override render_() {
    super.render_();
    this.updateBlockPreview();
  }

  override updateEditable() {
    const editable = super.updateEditable();
    const root = this.getSvgRoot();
    if (root) {
      Blockly.utils.dom.removeClass(root, 'blocklyNonEditableText');
      Blockly.utils.dom.removeClass(root, 'blocklyEditableText');
    }
    return editable;
  }

  protected override updateSize_() {
    if (this.borderRect_) {
      this.borderRect_.setAttribute('width', String(this.fieldWidth));
      this.borderRect_.setAttribute('height', String(this.fieldHeight));
    }
    if (this.blockDisplayImage) {
      this.blockDisplayImage.setAttribute('width', String(this.fieldWidth));
      this.blockDisplayImage.setAttribute('height', String(this.fieldHeight));
    }
    this.size_.width = this.fieldWidth;
    this.size_.height = this.fieldHeight;
  }

  protected override showEditor_() {
    this.initialValue = this.cloneValue(this.getValue());
    const editor = this.createDropdownEditor();
    const content = Blockly.DropDownDiv.getContentDiv();
    content.appendChild(editor);
    content.classList.add('contains-audio-editor', 'ailyMediaFieldDropdown');
    Blockly.DropDownDiv.showPositionedByField(this, this.disposeDropdown.bind(this));
    void this.preloadDecodedAudio();
  }

  override dispose() {
    this.isDisposed = true;
    this.clearSettingsTimer();
    this.invalidateOperations();
    this.stopPlayback(true);
    void this.closePlaybackContext();
    this.removePointerListeners?.();
    super.dispose();
  }

  private createDropdownEditor() {
    const editor = this.createElement('div', 'audioFieldEditor ailyMediaFieldEditor');
    editor.addEventListener('pointerdown', (event) => event.stopPropagation());

    const toolbar = this.createElement('div', 'audioFieldToolbar ailyMediaFieldToolbar');
    const settings = this.createElement('div', 'audioFieldSettings ailyMediaFieldSettings');
    this.sampleRateSelect = this.createSelect(SAMPLE_RATES.map((rate) => ({
      value: String(rate),
      label: `${rate / 1000} kHz`,
    })));
    this.channelsSelect = this.createSelect([
      { value: '1', label: translateAudioMessage('LABEL_MONO') },
      { value: '2', label: translateAudioMessage('LABEL_STEREO') },
    ]);
    this.bitRateSelect = this.createSelect([]);
    settings.append(
      this.createControl(translateAudioMessage('LABEL_SAMPLE_RATE'), this.sampleRateSelect),
      this.createControl(translateAudioMessage('LABEL_CHANNELS'), this.channelsSelect),
      this.createControl(translateAudioMessage('LABEL_BIT_RATE'), this.bitRateSelect),
    );
    this.sampleRateSelect.addEventListener('change', () => {
      this.pendingSampleRate = nearestNumber(
        this.sampleRateSelect?.value,
        SAMPLE_RATES,
        this.pendingSampleRate,
      );
      this.refreshBitRateOptions();
      this.scheduleReencode();
    });
    this.channelsSelect.addEventListener('change', () => {
      this.pendingChannels = this.channelsSelect?.value === '2' ? 2 : 1;
      this.scheduleReencode();
    });
    this.bitRateSelect.addEventListener('change', () => {
      this.pendingBitRate = nearestNumber(
        this.bitRateSelect?.value,
        validBitRates(this.pendingSampleRate),
        this.pendingBitRate,
      );
      this.scheduleReencode();
    });
    toolbar.appendChild(settings);

    const actions = this.createElement('div', 'audioFieldActions ailyMediaFieldActions');
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'audio/*,.wav,.mp3,.aac,.m4a,.ogg,.flac,.webm';
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => this.handleSelectedFile());
    actions.append(
      this.fileInput,
      this.createButton(
        translateAudioMessage('BUTTON_UPLOAD'),
        () => this.fileInput?.click(),
        translateAudioMessage('UPLOAD_TOOLTIP'),
      ),
      this.createButton(translateAudioMessage('BUTTON_CLEAR'), () => this.clearAudio()),
    );
    toolbar.appendChild(actions);
    editor.appendChild(toolbar);

    this.statusElement = this.createElement('div', 'audioFieldStatus ailyMediaFieldStatus');
    editor.appendChild(this.statusElement);

    const waveformSurface = this.createElement('div', 'audioFieldWaveformSurface ailyMediaFieldSurface');
    this.waveformCanvas = document.createElement('canvas');
    this.waveformCanvas.className = 'audioFieldWaveform';
    this.waveformCanvas.width = 720;
    this.waveformCanvas.height = 180;
    waveformSurface.appendChild(this.waveformCanvas);

    const trimArea = this.createElement('div', 'audioFieldTrimArea');
    this.playButton = this.createIconButton('fa-light fa-play', () => void this.togglePlayback());
    this.trimTrack = this.createElement('div', 'audioFieldTrimTrack');
    this.trimSelection = this.createElement('div', 'audioFieldTrimSelection');
    this.playhead = this.createElement('div', 'audioFieldPlayhead');
    this.trimStartHandle = this.createTrimHandle('start');
    this.trimEndHandle = this.createTrimHandle('end');
    this.trimTrack.append(
      this.trimSelection,
      this.playhead,
      this.trimStartHandle,
      this.trimEndHandle,
    );
    this.trimTrack.addEventListener('pointerdown', (event) => this.beginTrackDrag(event));
    trimArea.append(this.playButton, this.trimTrack);
    waveformSurface.appendChild(trimArea);

    const labels = this.createElement('div', 'audioFieldTrimLabels');
    this.trimStartLabel = this.createElement('span', 'audioFieldTrimLabel');
    this.trimEndLabel = this.createElement('span', 'audioFieldTrimLabel');
    labels.append(this.trimStartLabel, this.trimEndLabel);
    waveformSurface.appendChild(labels);
    editor.appendChild(waveformSurface);

    this.updateEditorFromValue();
    requestAnimationFrame(() => {
      this.drawWaveform();
      if (this.isDropdownOpen()) Blockly.DropDownDiv.repositionForWindowResize();
    });
    return editor;
  }

  private createSelect(options: Array<{ value: string; label: string }>) {
    const select = document.createElement('select');
    select.className = 'audioFieldSelect ailyMediaFieldInput';
    for (const item of options) {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      select.appendChild(option);
    }
    return select;
  }

  private createControl(label: string, control: HTMLElement) {
    const wrapper = this.createElement('label', 'audioFieldControl ailyMediaFieldControl');
    const text = document.createElement('span');
    text.textContent = label;
    wrapper.append(text, control);
    return wrapper;
  }

  private createButton(text: string, callback: () => void, title?: string) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'audioFieldButton ailyMediaFieldButton';
    button.textContent = text;
    if (title) button.title = title;
    button.addEventListener('click', callback);
    return button;
  }

  private createIconButton(iconClass: string, callback: () => void) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'audioFieldButton audioFieldIconButton ailyMediaFieldButton ailyMediaFieldIconButton';
    button.title = translateAudioMessage('BUTTON_PLAY');
    button.setAttribute('aria-label', translateAudioMessage('BUTTON_PLAY'));
    const icon = document.createElement('i');
    icon.className = iconClass;
    button.appendChild(icon);
    button.addEventListener('click', callback);
    return button;
  }

  private createTrimHandle(kind: 'start' | 'end') {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = `audioFieldTrimHandle audioFieldTrimHandle-${kind}`;
    handle.setAttribute('aria-label', translateAudioMessage(kind === 'start' ? 'LABEL_START' : 'LABEL_END'));
    handle.addEventListener('pointerdown', (event) => this.beginHandleDrag(kind, event));
    return handle;
  }

  private refreshBitRateOptions() {
    if (!this.bitRateSelect) return;
    const rates = validBitRates(this.pendingSampleRate);
    this.pendingBitRate = nearestNumber(this.pendingBitRate, rates, rates[0]);
    this.bitRateSelect.replaceChildren(...rates.map((rate) => {
      const option = document.createElement('option');
      option.value = String(rate);
      option.textContent = `${rate} kbps`;
      return option;
    }));
    this.bitRateSelect.value = String(this.pendingBitRate);
  }

  private updateEditorFromValue() {
    const value = this.getValue();
    if (!value) return;
    if (this.sampleRateSelect) this.sampleRateSelect.value = String(this.pendingSampleRate);
    if (this.channelsSelect) this.channelsSelect.value = String(this.pendingChannels);
    this.refreshBitRateOptions();
    this.updateTrimUi();
    this.drawWaveform();
    this.updateStatusFromValue();
    this.updatePlayButton();
  }

  private beginTrackDrag(event: PointerEvent) {
    if (event.target !== this.trimTrack && event.target !== this.trimSelection) return;
    const value = this.getValue();
    if (!value.duration) return;
    const time = this.pointerTime(event);
    const kind = Math.abs(time - this.pendingTrimStart) <= Math.abs(time - this.pendingTrimEnd)
      ? 'start'
      : 'end';
    this.beginHandleDrag(kind, event);
  }

  private beginHandleDrag(kind: 'start' | 'end', event: PointerEvent) {
    if (!this.getValue().duration) return;
    event.preventDefault();
    event.stopPropagation();
    this.stopPlayback(false);
    this.draggedHandle = kind;
    this.removePointerListeners?.();
    const move = (moveEvent: PointerEvent) => this.updateDraggedHandle(moveEvent);
    const up = (upEvent: PointerEvent) => {
      this.updateDraggedHandle(upEvent);
      this.draggedHandle = null;
      this.removePointerListeners?.();
      this.scheduleReencode(0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
    this.removePointerListeners = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.removePointerListeners = null;
    };
    this.updateDraggedHandle(event);
  }

  private updateDraggedHandle(event: PointerEvent) {
    if (!this.draggedHandle) return;
    const duration = this.getValue().duration;
    const time = this.pointerTime(event);
    if (this.draggedHandle === 'start') {
      this.pendingTrimStart = Math.min(
        Math.max(0, this.pendingTrimEnd - MIN_TRIM_SECONDS),
        Math.max(0, time),
      );
    } else {
      this.pendingTrimEnd = Math.max(
        Math.min(duration, this.pendingTrimStart + MIN_TRIM_SECONDS),
        Math.min(duration, time),
      );
    }
    this.updateTrimUi();
    this.drawWaveform();
    this.updatePlayButton();
  }

  private pointerTime(event: PointerEvent) {
    const rect = this.trimTrack?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return ratio * this.getValue().duration;
  }

  private updateTrimUi(playbackTime?: number) {
    const duration = this.getValue().duration;
    const startRatio = duration > 0 ? this.pendingTrimStart / duration : 0;
    const endRatio = duration > 0 ? this.pendingTrimEnd / duration : 0;
    if (this.trimSelection) {
      this.trimSelection.style.left = `${startRatio * 100}%`;
      this.trimSelection.style.width = `${Math.max(0, endRatio - startRatio) * 100}%`;
    }
    if (this.trimStartHandle) this.trimStartHandle.style.left = `${startRatio * 100}%`;
    if (this.trimEndHandle) this.trimEndHandle.style.left = `${endRatio * 100}%`;
    if (this.trimStartLabel) {
      this.trimStartLabel.textContent = `${translateAudioMessage('LABEL_START')} ${this.formatTime(this.pendingTrimStart)}`;
    }
    if (this.trimEndLabel) {
      this.trimEndLabel.textContent = `${translateAudioMessage('LABEL_END')} ${this.formatTime(this.pendingTrimEnd)}`;
    }
    if (this.playhead) {
      const visible = playbackTime !== undefined && duration > 0;
      this.playhead.style.display = visible ? 'block' : 'none';
      if (visible) this.playhead.style.left = `${Math.min(1, Math.max(0, playbackTime! / duration)) * 100}%`;
    }
  }

  private drawWaveform() {
    if (!this.waveformCanvas) return;
    const canvas = this.waveformCanvas;
    const context = canvas.getContext('2d');
    if (!context) return;
    const width = canvas.width;
    const height = canvas.height;
    const center = height / 2;
    const value = this.getValue();
    const waveform = this.sourceWaveform;
    context.clearRect(0, 0, width, height);
    context.fillStyle = this.cssVariable('--aily-bg-elevated', '#1b1b1b');
    context.fillRect(0, 0, width, height);
    context.strokeStyle = this.cssVariable('--aily-border-tertiary', '#555');
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, center + 0.5);
    context.lineTo(width, center + 0.5);
    context.stroke();

    if (waveform.length === 0) {
      context.fillStyle = this.cssVariable('--aily-text-tertiary', '#999');
      context.font = '13px sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(translateAudioMessage('EMPTY'), width / 2, center);
      return;
    }

    const startRatio = value.duration > 0 ? this.pendingTrimStart / value.duration : 0;
    const endRatio = value.duration > 0 ? this.pendingTrimEnd / value.duration : 1;
    const barWidth = width / waveform.length;
    for (let index = 0; index < waveform.length; index++) {
      const ratio = (index + 0.5) / waveform.length;
      const amplitude = Math.max(1, waveform[index] / 255 * (center - 12));
      context.fillStyle = ratio >= startRatio && ratio <= endRatio
        ? this.cssVariable('--aily-color-accent', '#4db6ac')
        : this.cssVariable('--aily-text-disabled', '#626262');
      context.fillRect(
        index * barWidth,
        center - amplitude,
        Math.max(1, barWidth * 0.7),
        amplitude * 2,
      );
    }
  }

  private handleSelectedFile() {
    const file = this.fileInput?.files?.[0];
    if (!file) return;
    const operation = this.importAndEncode(file).finally(() => {
      if (this.fileInput) this.fileInput.value = '';
    });
    void projectDataRuntime.trackMutation(operation).catch((error) => this.reportError(error, 'ERROR_ENCODE'));
  }

  private async importAndEncode(file: File) {
    if (file.size > MAX_SOURCE_FILE_SIZE) {
      throw new Error(translateAudioMessage('ERROR_FILE_SIZE', {
        maxSize: this.formatSize(MAX_SOURCE_FILE_SIZE),
        currentSize: this.formatSize(file.size),
      }));
    }
    const version = this.beginOperation();
    this.stopPlayback(false);
    this.setStatus(translateAudioMessage('STATUS_READING', { name: file.name }));
    const buffer = await file.arrayBuffer();
    if (!this.isOperationCurrent(version)) return;
    const sourcePath = this.persistSourceFile(file, buffer);
    if (!this.isOperationCurrent(version)) return;
    this.setStatus(translateAudioMessage('STATUS_DECODING', { name: file.name }));
    const decoded = await this.decodeAudio(buffer.slice(0));
    if (!this.isOperationCurrent(version)) return;
    if (decoded.duration > MAX_SOURCE_DURATION_SECONDS) {
      throw new Error(translateAudioMessage('WORKER_ERROR_DURATION_EXCEEDED'));
    }
    this.decodedAudio = decoded;
    this.decodedSourceId = sourcePath;
    this.decodingAudio = null;
    this.sourceWaveform = this.createWaveform(decoded, WAVEFORM_BINS);
    this.pendingTrimStart = 0;
    this.pendingTrimEnd = decoded.duration;
    this.drawWaveform();
    const settings = this.readPendingSettings(decoded.duration);
    const result = await this.encodeAudio(decoded, settings, version);
    if (!this.isOperationCurrent(version)) return;
    await this.persistEncodedResult(result, settings, sourcePath, decoded.duration, version);
  }

  private scheduleReencode(delay = MEDIA_FIELD_PARAMETER_DEBOUNCE_MS) {
    this.clearSettingsTimer();
    if (!this.getValue().sourcePath) return;
    this.stopPlayback(false);
    this.updatePlayButton();
    this.settingsTimer = setTimeout(() => {
      this.settingsTimer = null;
      const operation = this.reencodeCurrentSource();
      void projectDataRuntime.trackMutation(operation).catch((error) => this.reportError(error, 'ERROR_ENCODE'));
    }, delay);
  }

  private async reencodeCurrentSource() {
    const current = this.getValue();
    if (!current.sourcePath) return;
    const version = this.beginOperation();
    this.stopPlayback(false);
    const decoded = await this.ensureDecodedAudio(current.sourcePath);
    if (!this.isOperationCurrent(version)) return;
    const settings = this.readPendingSettings(decoded.duration);
    const result = await this.encodeAudio(decoded, settings, version);
    if (!this.isOperationCurrent(version)) return;
    await this.persistEncodedResult(
      result,
      settings,
      current.sourcePath,
      decoded.duration,
      version,
    );
  }

  private async encodeAudio(
    decoded: AudioBuffer,
    settings: EncodingSettings,
    version: number,
  ): Promise<WorkerResult> {
    if (!this.isOperationCurrent(version)) throw new AudioEncodingCancelledError();
    const worker = new Worker(new URL('./audio-encoder.worker.ts', import.meta.url), { type: 'module' });
    const requestId = ++this.requestId;
    let task: ActiveEncodingTask | null = null;
    const channelData = Array.from({ length: decoded.numberOfChannels }, (_, index) => (
      decoded.getChannelData(index)
    ));
    try {
      return await new Promise<WorkerResult>((resolve, reject) => {
        task = { worker, reject };
        this.activeEncoding = task;
        this.updatePlayButton();
        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
          const message = event.data;
          if (!message || message.requestId !== requestId || this.activeEncoding !== task) return;
          if (message.type === 'progress') {
            if (this.isOperationCurrent(version)) {
              this.setStatus(translateAudioMessage('STATUS_ENCODING', {
                progress: Math.round((message.progress || 0) * 100),
              }));
            }
            return;
          }
          this.activeEncoding = null;
          if (message.type === 'done' && message.result) {
            resolve(message.result);
          } else {
            reject(new Error(message.messageKey
              ? translateAudioMessage(message.messageKey)
              : message.message || translateAudioMessage('ERROR_ENCODE')));
          }
        };
        worker.onerror = (event) => {
          if (this.activeEncoding === task) this.activeEncoding = null;
          reject(new Error(event.message || translateAudioMessage('ERROR_ENCODE')));
        };
        worker.postMessage({
          type: 'encode',
          requestId,
          sourceSampleRate: decoded.sampleRate,
          channelData,
          startTime: settings.trimStart,
          endTime: settings.trimEnd,
          sampleRate: settings.sampleRate,
          channels: settings.channels,
          bitRate: settings.bitRate,
        });
      });
    } finally {
      if (this.activeEncoding === task) this.activeEncoding = null;
      worker.terminate();
    }
  }

  private async persistEncodedResult(
    result: WorkerResult,
    settings: EncodingSettings,
    sourcePath: string,
    sourceDuration: number,
    version: number,
  ) {
    if (!(result.mp3 instanceof Uint8Array) || result.mp3.byteLength === 0) {
      throw new Error(translateAudioMessage('ERROR_ENCODE'));
    }
    const audioPath = this.persistCompressedFile(result.mp3);
    if (!this.isOperationCurrent(version)) return;
    this.clearOutputAudioCache();
    const next: AudioFieldValue = {
      schemaVersion: 1,
      encoding: 'mp3-cbr-v1',
      sampleRate: settings.sampleRate,
      channels: settings.channels,
      bitRate: settings.bitRate,
      duration: sourceDuration,
      trimStart: settings.trimStart,
      trimEnd: settings.trimEnd,
      outputDuration: result.duration,
      sourcePath,
      audioPath,
    };
    this.applyingEncodedValue = true;
    try {
      this.setValue(next, !this.isDropdownOpen());
    } finally {
      this.applyingEncodedValue = false;
    }
    this.setStatus(this.getInfoStatus(next));
  }

  private async preloadDecodedAudio() {
    const sourcePath = this.getValue().sourcePath;
    if (!sourcePath) return;
    try {
      await this.ensureDecodedAudio(sourcePath);
      this.drawWaveform();
    } catch (error) {
      this.reportError(error, 'ERROR_LOAD');
    }
  }

  private async ensureDecodedAudio(sourcePath: string) {
    if (this.decodedAudio && this.decodedSourceId === sourcePath) return this.decodedAudio;
    if (this.decodingAudio) return this.decodingAudio;
    const loading = Promise.resolve().then(async () => {
      const buffer = this.readProjectFileBuffer(sourcePath);
      const decoded = await this.decodeAudio(buffer);
      if (this.getValue().sourcePath === sourcePath) {
        this.decodedAudio = decoded;
        this.decodedSourceId = sourcePath;
        this.sourceWaveform = this.createWaveform(decoded, WAVEFORM_BINS);
      }
      return decoded;
    }).finally(() => {
      if (this.decodingAudio === loading) this.decodingAudio = null;
    });
    this.decodingAudio = loading;
    return loading;
  }

  private async decodeAudio(buffer: ArrayBuffer) {
    const AudioContextClass = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) throw new Error(translateAudioMessage('ERROR_DECODE'));
    const context = new AudioContextClass();
    try {
      return await context.decodeAudioData(buffer);
    } catch {
      throw new Error(translateAudioMessage('ERROR_DECODE'));
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  private createWaveform(decoded: AudioBuffer, binCount: number) {
    const bins = Math.min(640, Math.max(64, Math.floor(binCount) || WAVEFORM_BINS));
    const waveform = new Array<number>(bins);
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => (
      decoded.getChannelData(index)
    ));
    for (let bin = 0; bin < bins; bin++) {
      const from = Math.floor(bin * decoded.length / bins);
      const to = Math.max(from + 1, Math.floor((bin + 1) * decoded.length / bins));
      let peak = 0;
      for (let sample = from; sample < to; sample++) {
        let mixed = 0;
        for (const channel of channels) mixed += channel[sample] || 0;
        peak = Math.max(peak, Math.abs(mixed / channels.length));
      }
      waveform[bin] = Math.min(255, Math.round(peak * 255));
    }
    return waveform;
  }

  private async loadOutputWaveformForPreview() {
    const audioPath = this.getValue().audioPath;
    if (!audioPath) return;
    try {
      await this.ensureDecodedOutputAudio(audioPath);
      if (this.getValue().audioPath !== audioPath) return;
      this.blockPreviewUrl = '';
      this.updateBlockPreview();
    } catch (error) {
      this.reportError(error, 'ERROR_LOAD');
    }
  }

  private async ensureDecodedOutputAudio(audioPath: string) {
    if (this.decodedOutputAudio && this.decodedOutputId === audioPath) {
      return this.decodedOutputAudio;
    }
    if (this.decodingOutputAudio) return this.decodingOutputAudio;
    const loading = Promise.resolve().then(async () => {
      const buffer = this.readProjectFileBuffer(audioPath);
      const decoded = await this.decodeAudio(buffer);
      if (this.getValue().audioPath === audioPath) {
        this.decodedOutputAudio = decoded;
        this.decodedOutputId = audioPath;
        this.outputWaveform = this.createWaveform(decoded, WAVEFORM_BINS);
      }
      return decoded;
    }).finally(() => {
      if (this.decodingOutputAudio === loading) this.decodingOutputAudio = null;
    });
    this.decodingOutputAudio = loading;
    return loading;
  }

  private persistSourceFile(file: File, buffer: ArrayBuffer) {
    return this.persistProjectFile(
      ['assets', 'audio'],
      `${this.calculateMd5(buffer)}${this.getSourceExtension(file.name, file.type)}`,
      buffer,
    );
  }

  private persistCompressedFile(bytes: Uint8Array) {
    const audioPath = this.persistProjectFile(['audio'], `${this.calculateMd5(bytes)}.mp3`, bytes);
    const projectPath = this.getCurrentProjectPath();
    if (projectPath) projectResourceGc.registerManagedFile(projectPath, audioPath, 'field-audio-output');
    return audioPath;
  }

  private persistProjectFile(
    directoryParts: string[],
    fileName: string,
    data: ArrayBuffer | ArrayBufferView,
  ) {
    const projectPath = this.getCurrentProjectPath();
    const fsApi = (window as any)['fs'];
    const pathApi = (window as any)['path'];
    if (!projectPath || !fsApi || !pathApi?.join || !pathApi?.relative) {
      throw new Error(translateAudioMessage('ERROR_PROJECT_PATH_MISSING'));
    }
    if (typeof fsApi.mkdirSync !== 'function') {
      throw new Error(translateAudioMessage('ERROR_FS_UNAVAILABLE'));
    }
    const directory = pathApi.join(projectPath, ...directoryParts);
    fsApi.mkdirSync(directory);
    const filePath = pathApi.join(directory, fileName);
    if (typeof fsApi.existsSync === 'function' && fsApi.existsSync(filePath)) {
      return this.normalizeProjectPath(pathApi.relative(projectPath, filePath));
    }
    if (typeof fsApi.writeFileBuffer === 'function') {
      fsApi.writeFileBuffer(filePath, data);
    } else if (typeof fsApi.writeFileSync === 'function') {
      fsApi.writeFileSync(filePath, data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    } else if (typeof fsApi.writeBase64File === 'function') {
      fsApi.writeBase64File(filePath, this.bytesToBase64(data));
    } else {
      throw new Error(translateAudioMessage('ERROR_FS_UNAVAILABLE'));
    }
    return this.normalizeProjectPath(pathApi.relative(projectPath, filePath));
  }

  private readProjectFileBuffer(storedPath: string) {
    const filePath = this.resolveProjectFilePath(storedPath);
    const fsApi = (window as any)['fs'];
    if (!filePath || !fsApi) {
      throw new Error(translateAudioMessage('ERROR_PROJECT_PATH_MISSING'));
    }
    if (typeof fsApi.existsSync === 'function' && !fsApi.existsSync(filePath)) {
      throw new Error(translateAudioMessage('ERROR_FILE_MISSING', { path: storedPath }));
    }
    if (typeof fsApi.readFileBuffer === 'function') {
      return this.toArrayBuffer(fsApi.readFileBuffer(filePath));
    }
    if (typeof fsApi.readFileAsBase64 === 'function') {
      return this.base64ToArrayBuffer(fsApi.readFileAsBase64(filePath));
    }
    throw new Error(translateAudioMessage('ERROR_FS_UNAVAILABLE'));
  }

  private resolveProjectFilePath(storedPath: string) {
    const projectPath = this.getCurrentProjectPath();
    const pathApi = (window as any)['path'];
    if (!projectPath || !storedPath || !pathApi?.join || !pathApi?.resolve || !pathApi?.relative) {
      return null;
    }
    const fullPath = pathApi.join(projectPath, ...storedPath.split('/').filter(Boolean));
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

  private calculateMd5(data: ArrayBuffer | ArrayBufferView) {
    const fsApi = (window as any)['fs'];
    if (typeof fsApi?.md5Buffer !== 'function') {
      throw new Error(translateAudioMessage('ERROR_FS_UNAVAILABLE'));
    }
    const md5 = String(fsApi.md5Buffer(data) || '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(md5)) throw new Error(translateAudioMessage('ERROR_FS_UNAVAILABLE'));
    return md5;
  }

  private getSourceExtension(fileName: string, mimeType: string) {
    const extension = this.getPathExtension(fileName).toLowerCase();
    if (['.wav', '.mp3', '.aac', '.m4a', '.ogg', '.flac', '.webm', '.opus', '.aiff', '.aif'].includes(extension)) {
      return extension;
    }
    const mimeExtensions: Record<string, string> = {
      'audio/wav': '.wav',
      'audio/x-wav': '.wav',
      'audio/mpeg': '.mp3',
      'audio/aac': '.aac',
      'audio/mp4': '.m4a',
      'audio/ogg': '.ogg',
      'audio/flac': '.flac',
      'audio/webm': '.webm',
    };
    return mimeExtensions[(mimeType || '').toLowerCase()] || '.bin';
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

  private normalizeProjectPath(filePath: string) {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  private toArrayBuffer(data: unknown): ArrayBuffer {
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    }
    if (Array.isArray(data)) return new Uint8Array(data).buffer;
    const buffer = data as { type?: string; data?: unknown };
    if (buffer?.type === 'Buffer' && Array.isArray(buffer.data)) {
      return new Uint8Array(buffer.data).buffer;
    }
    throw new Error(translateAudioMessage('ERROR_FS_UNAVAILABLE'));
  }

  private bytesToBase64(data: ArrayBuffer | ArrayBufferView) {
    const buffer = data instanceof ArrayBuffer
      ? data
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(value: string) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }

  private getProjectFileSize(storedPath?: string) {
    if (!storedPath) return 0;
    const filePath = this.resolveProjectFilePath(storedPath);
    const fsApi = (window as any)['fs'];
    if (!filePath || typeof fsApi?.statSync !== 'function') return 0;
    try {
      return Number(fsApi.statSync(filePath)?.size) || 0;
    } catch {
      return 0;
    }
  }

  private async togglePlayback() {
    if (this.playbackSource) {
      this.stopPlayback(false);
      return;
    }
    const value = this.getValue();
    const audioPath = value.audioPath;
    if (!audioPath || this.hasPendingSettings() || this.activeEncoding) return;
    try {
      const decoded = await this.ensureDecodedOutputAudio(audioPath);
      if (!this.isDropdownOpen() || this.getValue().audioPath !== audioPath) return;
      const AudioContextClass = window.AudioContext
        || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      this.playbackContext ||= new AudioContextClass();
      await this.playbackContext.resume();
      const node = this.playbackContext.createBufferSource();
      node.buffer = decoded;
      node.connect(this.playbackContext.destination);
      this.playbackSource = node;
      this.playbackOffset = value.trimStart;
      this.playbackEnd = value.trimEnd;
      this.playbackDuration = Math.max(MIN_TRIM_SECONDS, decoded.duration);
      this.playbackStartedAt = this.playbackContext.currentTime;
      node.onended = () => {
        if (this.playbackSource === node) this.stopPlayback(true);
      };
      node.start(0);
      this.updatePlayButton();
      this.updatePlaybackPosition();
    } catch (error) {
      this.reportError(error, 'ERROR_LOAD');
    }
  }

  private updatePlaybackPosition() {
    if (!this.playbackSource || !this.playbackContext) return;
    const elapsed = this.playbackContext.currentTime - this.playbackStartedAt;
    const progress = Math.min(1, Math.max(0, elapsed / this.playbackDuration));
    const time = this.playbackOffset + (this.playbackEnd - this.playbackOffset) * progress;
    this.updateTrimUi(time);
    this.playbackAnimationFrame = requestAnimationFrame(() => this.updatePlaybackPosition());
  }

  private stopPlayback(resetPlayhead: boolean) {
    cancelAnimationFrame(this.playbackAnimationFrame);
    this.playbackAnimationFrame = 0;
    const source = this.playbackSource;
    this.playbackSource = null;
    if (source) {
      source.onended = null;
      try { source.stop(); } catch { /* already stopped */ }
      source.disconnect();
    }
    this.updatePlayButton();
    this.updateTrimUi(resetPlayhead ? undefined : undefined);
  }

  private async closePlaybackContext() {
    const context = this.playbackContext;
    this.playbackContext = null;
    if (context) await context.close().catch(() => undefined);
  }

  private updatePlayButton() {
    if (!this.playButton) return;
    const playing = Boolean(this.playbackSource);
    const label = translateAudioMessage(playing ? 'BUTTON_STOP' : 'BUTTON_PLAY');
    this.playButton.title = label;
    this.playButton.setAttribute('aria-label', label);
    this.playButton.disabled = !this.getValue().audioPath
      || this.hasPendingSettings()
      || Boolean(this.activeEncoding);
    const icon = this.playButton.querySelector('i');
    if (icon) icon.className = playing ? 'fa-light fa-stop' : 'fa-light fa-play';
  }

  private readPendingSettings(duration: number): EncodingSettings {
    const sampleRate = nearestNumber(this.pendingSampleRate, SAMPLE_RATES, DEFAULT_SAMPLE_RATE);
    const channels = this.pendingChannels === 2 ? 2 : 1;
    const bitRate = nearestNumber(this.pendingBitRate, validBitRates(sampleRate), DEFAULT_BIT_RATE);
    const trimStart = Math.min(Math.max(0, duration - MIN_TRIM_SECONDS), Math.max(0, this.pendingTrimStart));
    const trimEnd = Math.min(duration, Math.max(trimStart + MIN_TRIM_SECONDS, this.pendingTrimEnd || duration));
    this.pendingSampleRate = sampleRate;
    this.pendingChannels = channels;
    this.pendingBitRate = bitRate;
    this.pendingTrimStart = trimStart;
    this.pendingTrimEnd = trimEnd;
    return { sampleRate, channels, bitRate, trimStart, trimEnd };
  }

  private clearAudio() {
    this.clearSettingsTimer();
    this.invalidateOperations();
    this.stopPlayback(true);
    this.decodedAudio = null;
    this.decodedSourceId = '';
    this.decodingAudio = null;
    this.sourceWaveform = [];
    this.clearOutputAudioCache();
    this.pendingTrimStart = 0;
    this.pendingTrimEnd = 0;
    this.setValue(this.createEmptyValue({
      sampleRate: this.pendingSampleRate,
      channels: this.pendingChannels,
      bitRate: this.pendingBitRate,
      fieldWidth: this.fieldWidth,
      fieldHeight: this.fieldHeight,
    }), !this.isDropdownOpen());
  }

  private clearOutputAudioCache() {
    this.decodedOutputAudio = null;
    this.decodedOutputId = '';
    this.decodingOutputAudio = null;
    this.outputWaveform = [];
    this.blockPreviewUrl = '';
  }

  private createEmptyValue(config?: FieldAudioFromJsonConfig): AudioFieldValue {
    const sampleRate = nearestNumber(config?.sampleRate, SAMPLE_RATES, DEFAULT_SAMPLE_RATE);
    const channels: 1 | 2 = Number(config?.channels) === 2 ? 2 : 1;
    const bitRate = nearestNumber(config?.bitRate, validBitRates(sampleRate), DEFAULT_BIT_RATE);
    return {
      schemaVersion: 1,
      encoding: 'mp3-cbr-v1',
      sampleRate,
      channels,
      bitRate,
      duration: 0,
      trimStart: 0,
      trimEnd: 0,
      outputDuration: 0,
    };
  }

  private normalizeValue(value?: AudioFieldValue | null, config?: FieldAudioFromJsonConfig): AudioFieldValue {
    const fallback = this.createEmptyValue(config);
    if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || value.encoding !== 'mp3-cbr-v1') {
      return fallback;
    }
    const sampleRate = nearestNumber(value.sampleRate, SAMPLE_RATES, fallback.sampleRate);
    const channels: 1 | 2 = value.channels === 2 ? 2 : 1;
    const bitRate = nearestNumber(value.bitRate, validBitRates(sampleRate), fallback.bitRate);
    const duration = this.finiteNumber(value.duration, 0, 0, 30 * 60);
    const trimStart = this.finiteNumber(value.trimStart, 0, 0, duration);
    const trimEnd = duration > 0
      ? this.finiteNumber(value.trimEnd, duration, Math.min(duration, trimStart + MIN_TRIM_SECONDS), duration)
      : 0;
    const sourcePath = this.normalizeStoredPath(value.sourcePath, 'assets/audio');
    const audioPath = sourcePath ? this.normalizeStoredPath(value.audioPath, 'audio', '.mp3') : undefined;
    return {
      schemaVersion: 1,
      encoding: 'mp3-cbr-v1',
      sampleRate,
      channels,
      bitRate,
      duration: sourcePath ? duration : 0,
      trimStart: sourcePath ? trimStart : 0,
      trimEnd: sourcePath ? trimEnd : 0,
      outputDuration: audioPath
        ? this.finiteNumber(value.outputDuration, Math.max(0, trimEnd - trimStart), 0, duration)
        : 0,
      sourcePath,
      audioPath,
    };
  }

  private normalizeStoredPath(value: unknown, root: string, extension?: string) {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return undefined;
    const segments = normalized.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return undefined;
    if (!normalized.startsWith(`${root}/`)) return undefined;
    if (extension && !normalized.toLowerCase().endsWith(extension)) return undefined;
    return normalized;
  }

  private finiteNumber(value: unknown, fallback: number, min: number, max: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  }

  private cloneValue(value: AudioFieldValue) {
    const normalized = this.normalizeValue(value);
    return { ...normalized };
  }

  private syncPendingSettings(value: AudioFieldValue) {
    this.pendingSampleRate = value.sampleRate;
    this.pendingChannels = value.channels;
    this.pendingBitRate = value.bitRate;
    this.pendingTrimStart = value.trimStart;
    this.pendingTrimEnd = value.trimEnd;
  }

  private updateBlockPreview() {
    if (!this.blockDisplayImage) return;
    if (!this.blockPreviewUrl) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(this.fieldWidth * 2);
      canvas.height = Math.round(this.fieldHeight * 2);
      const context = canvas.getContext('2d');
      if (context) {
        context.fillStyle = '#171717';
        context.fillRect(0, 0, canvas.width, canvas.height);
        const waveform = this.outputWaveform;
        const center = canvas.height / 2;
        context.fillStyle = waveform.length ? '#4db6ac' : '#666';
        if (waveform.length) {
          const step = canvas.width / waveform.length;
          waveform.forEach((peak, index) => {
            const height = Math.max(2, peak / 255 * (center - 8));
            context.fillRect(index * step, center - height, Math.max(1, step * 0.7), height * 2);
          });
        } else {
          context.font = `${Math.round(canvas.height * 0.42)}px sans-serif`;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.fillText('♫', canvas.width / 2, center);
        }
      }
      this.blockPreviewUrl = canvas.toDataURL('image/png');
    }
    this.blockDisplayImage.setAttributeNS('http://www.w3.org/1999/xlink', 'href', this.blockPreviewUrl);
    if (this.outputWaveform.length === 0 && this.getValue().audioPath) {
      void this.loadOutputWaveformForPreview();
    }
  }

  private updateStatusFromValue() {
    const value = this.getValue();
    this.setStatus(value.audioPath ? this.getInfoStatus(value) : translateAudioMessage('EMPTY'));
  }

  private getInfoStatus(value: AudioFieldValue) {
    return translateAudioMessage('STATUS_INFO', {
      name: value.sourcePath ? this.getPathBaseName(value.sourcePath) : 'audio',
      duration: this.formatTime(value.outputDuration),
      sampleRate: value.sampleRate,
      channels: value.channels,
      bitRate: value.bitRate,
      size: this.formatSize(this.getProjectFileSize(value.audioPath)),
    });
  }

  private setStatus(message: string, error = false) {
    if (!this.statusElement) return;
    this.statusElement.textContent = message;
    this.statusElement.title = message;
    this.statusElement.classList.toggle('is-error', error);
  }

  private reportError(error: unknown, fallbackKey: string) {
    if (error instanceof AudioEncodingCancelledError) return;
    const message = error instanceof Error ? error.message : String(error || translateAudioMessage(fallbackKey));
    this.setStatus(
      fallbackKey === 'ERROR_LOAD'
        ? translateAudioMessage('ERROR_LOAD', { message })
        : message || translateAudioMessage(fallbackKey),
      true,
    );
  }

  private formatTime(seconds: number) {
    const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
    const minutes = Math.floor(totalMilliseconds / 60_000);
    const wholeSeconds = Math.floor(totalMilliseconds % 60_000 / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return `${minutes}:${String(wholeSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
  }

  private formatSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  private cssVariable(name: string, fallback: string) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  private clearSettingsTimer() {
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = null;
  }

  private beginOperation() {
    this.clearSettingsTimer();
    this.operationVersion += 1;
    this.cancelActiveEncoding();
    return this.operationVersion;
  }

  private invalidateOperations() {
    this.operationVersion += 1;
    this.cancelActiveEncoding();
  }

  private cancelActiveEncoding() {
    const task = this.activeEncoding;
    if (!task) return;
    this.activeEncoding = null;
    task.worker.terminate();
    task.reject(new AudioEncodingCancelledError('Audio encoding cancelled'));
  }

  private isOperationCurrent(version: number) {
    return !this.isDisposed && version === this.operationVersion;
  }

  private disposeDropdown() {
    this.removePointerListeners?.();
    const shouldCommitPendingSettings = this.hasPendingSettings();
    this.clearSettingsTimer();
    this.stopPlayback(true);
    if (
      this.getSourceBlock()
      && this.initialValue
      && JSON.stringify(this.initialValue) !== JSON.stringify(this.getValue())
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
    this.waveformCanvas = null;
    this.trimTrack = null;
    this.trimSelection = null;
    this.trimStartHandle = null;
    this.trimEndHandle = null;
    this.trimStartLabel = null;
    this.trimEndLabel = null;
    this.playhead = null;
    this.playButton = null;
    this.fileInput = null;
    this.sampleRateSelect = null;
    this.channelsSelect = null;
    this.bitRateSelect = null;
    Blockly.DropDownDiv.getContentDiv().classList.remove('contains-audio-editor', 'ailyMediaFieldDropdown');
    if (shouldCommitPendingSettings) {
      const operation = this.reencodeCurrentSource();
      void projectDataRuntime.trackMutation(operation).catch((error) => this.reportError(error, 'ERROR_ENCODE'));
    }
  }

  private hasPendingSettings() {
    const value = this.getValue();
    return Boolean(value.sourcePath) && (
      value.sampleRate !== this.pendingSampleRate
      || value.channels !== this.pendingChannels
      || value.bitRate !== this.pendingBitRate
      || Math.abs(value.trimStart - this.pendingTrimStart) > 0.0005
      || Math.abs(value.trimEnd - this.pendingTrimEnd) > 0.0005
    );
  }

  private isDropdownOpen() {
    return Blockly.DropDownDiv.getOwner() === this;
  }

  private createElement(tagName: string, className: string) {
    const element = document.createElement(tagName);
    element.className = className;
    return element;
  }
}

Blockly.fieldRegistry.register('field_audio', FieldAudio);

Blockly.Css.register(`
.audioFieldEditor {
  min-width: min(94vw, 740px);
  width: min(94vw, 740px);
}
.audioFieldToolbar {
  width: 100% !important;
}
.audioFieldSelect.ailyMediaFieldInput {
  width: auto;
  min-width: 76px;
}
.audioFieldWaveformSurface {
  overflow: hidden;
  padding: 10px 12px 8px;
  width: 100%;
}
.audioFieldWaveform {
  display: block;
  height: 180px;
  max-width: 100%;
  width: 720px;
}
.audioFieldTrimArea {
  align-items: center;
  display: flex;
  gap: 10px;
  padding: 10px 2px 2px;
}
.audioFieldTrimTrack {
  background: var(--aily-bg-input, #363636);
  border: 1px solid var(--aily-border-input, #666);
  border-radius: 4px;
  box-sizing: border-box;
  cursor: pointer;
  flex: 1;
  height: 10px;
  position: relative;
  touch-action: none;
}
.audioFieldTrimSelection {
  background: color-mix(in srgb, var(--aily-color-accent, #4db6ac) 65%, transparent);
  border-radius: 3px;
  bottom: 0;
  position: absolute;
  top: 0;
}
.audioFieldTrimHandle {
  background: var(--aily-color-accent, #4db6ac);
  border: 2px solid var(--aily-text-primary, #fff);
  border-radius: 50%;
  box-shadow: 0 1px 4px rgba(0, 0, 0, .45);
  cursor: ew-resize;
  height: 18px;
  margin: 0;
  padding: 0;
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 18px;
  z-index: 3;
}
.audioFieldTrimHandle:hover,
.audioFieldTrimHandle:focus-visible {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--aily-color-accent, #4db6ac) 32%, transparent);
  outline: none;
}
.audioFieldPlayhead {
  background: var(--aily-color-warning, #f4c542);
  bottom: -5px;
  display: none;
  pointer-events: none;
  position: absolute;
  top: -5px;
  transform: translateX(-50%);
  width: 2px;
  z-index: 2;
}
.audioFieldTrimLabels {
  color: var(--aily-text-tertiary, #cfcfcf);
  display: flex;
  font-variant-numeric: tabular-nums;
  justify-content: space-between;
  padding-left: 40px;
}
.audioFieldTrimLabel {
  font-size: 12px;
}
.blocklyDropDownContent.contains-audio-editor {
  max-height: none;
}
`);
