import * as Blockly from 'blockly/core';
import { projectDataRuntime } from '../../../../../services/project-data/project-data-runtime';
import { AilyDataRef, isAilyDataRef } from '../../../../../services/project-data/project-data.types';
import { MEDIA_FIELD_PARAMETER_DEBOUNCE_MS } from './field-media-editor-style';

type U8g2AnimationI18nParams = Record<string, string | number>;
type U8g2AnimationTranslator = (key: string, params?: U8g2AnimationI18nParams) => string;

const U8G2_ANIMATION_I18N_PREFIX = 'BLOCKLY.U8G2_ANIMATION';
const U8G2_ANIMATION_BLOCKLY_MESSAGE_NAMES = [
    'BUTTON_UPLOAD',
    'UPLOAD_TOOLTIP',
    'BUTTON_CLEAR',
    'BUTTON_INVERT',
    'BUTTON_PLAY_TEST',
    'BUTTON_STOP_PLAY_TEST',
    'PLAY_TEST_TOOLTIP',
    'LABEL_WIDTH',
    'LABEL_HEIGHT',
    'LABEL_FPS',
    'LABEL_MAX_FRAMES',
    'LABEL_THRESHOLD',
    'LABEL_THRESHOLD_VALUE',
    'LABEL_DITHER',
    'EMPTY',
    'READY',
    'FRAME_EDIT',
    'FRAME_DELETE',
    'FRAME_DONE',
    'FRAME_CANCEL',
    'RENDERING_FRAMES',
    'FRAME_HINT',
] as const;
const DEFAULT_U8G2_ANIMATION_MESSAGES: Record<string, string> = {
    BUTTON_UPLOAD: "上传",
    UPLOAD_TOOLTIP: "支持格式：MP4、GIF、PNG",
    BUTTON_CLEAR: "清空",
    BUTTON_INVERT: "反色",
    BUTTON_PLAY_TEST: "播放测试",
    BUTTON_STOP_PLAY_TEST: "停止播放",
    PLAY_TEST_TOOLTIP: "测试播放",
    LABEL_WIDTH: "W",
    LABEL_HEIGHT: "H",
    LABEL_FPS: "FPS",
    LABEL_MAX_FRAMES: "总帧数",
    LABEL_THRESHOLD: "阈值",
    LABEL_THRESHOLD_VALUE: "阈值",
    LABEL_DITHER: "抖动",
    EMPTY: "未上传动画",
    READY: "已取模",
    FRAME_EDIT: "编辑该帧",
    FRAME_DELETE: "删除该帧",
    FRAME_DONE: "保存",
    FRAME_CANCEL: "取消，不保存",
    RENDERING_FRAMES: "正在加载帧",
    FRAME_HINT: "鼠标左键绘制，右键擦除",
    ERROR_FRAME_EDITOR_CONTEXT: "无法获取动画帧编辑器 canvas 2d context",
    ERROR_FILE_SIZE_EXCEEDED: "文件大小不能超过 {{maxSize}}，当前文件 {{currentSize}}",
    STATUS_READING_FILE: "正在读取 {{name}}...",
    STATUS_SAVING_FILE: "正在保存 {{name}}...",
    ERROR_DECODE_FAILED: "动画取模失败",
    ERROR_PROJECT_DATA_LOAD_FAILED: "动画数据加载失败: {{message}}",
    STATUS_DECODING: "正在取模...",
    STATUS_READY_WITH_COUNT: "已取模 {{frames}} 帧",
    ERROR_PROJECT_PATH_MISSING: "未找到当前项目目录，无法保存动画资源",
    ERROR_FS_CREATE_ASSETS_UNAVAILABLE: "文件系统接口不可用，无法创建 assets 目录",
    ERROR_FS_SAVE_UNAVAILABLE: "文件系统接口不可用，无法保存动画资源",
    ERROR_SOURCE_MISSING_REDECODE: "未找到动画源文件，无法重新取模",
    ERROR_SOURCE_NOT_FOUND: "源文件不存在: {{path}}",
    STATUS_REDECODING: "正在重新取模 {{name}}...",
    ERROR_REDECODE_FAILED: "重新取模失败",
    ERROR_FS_READ_UNAVAILABLE: "文件系统接口不可用，无法读取动画源文件",
    ERROR_SOURCE_READ_INVALID: "动画源文件读取结果无效",
    ERROR_MD5_UNAVAILABLE: "文件 MD5 接口不可用，请完全重启软件后再上传",
    ERROR_MD5_FAILED: "文件 MD5 计算失败",
    STATUS_RENDERING_FRAMES_WITH_COUNT: "正在加载 {{frames}} 帧...",
    FRAME_EDITOR_TITLE: "编辑第 {{index}} 帧",
    STATUS_INFO: "{{sourcePrefix}}{{frames}} 帧 | {{width}}x{{height}} | {{fps}} FPS | {{mode}} | 数据 {{dataSize}}",
    WORKER_ERROR_CREATE_CANVAS: "无法创建取模画布",
    WORKER_ERROR_MP4_PARSE_FAILED: "MP4 解析失败",
    WORKER_ERROR_MP4_NO_VIDEO_TRACK: "MP4 中没有找到视频轨道",
    WORKER_ERROR_MP4_METADATA_FAILED: "MP4 元数据解析失败",
    WORKER_ERROR_MP4_FRAME_EXTRACTION_FAILED: "MP4 视频帧提取失败",
    WORKER_ERROR_WEB_CODECS_UNSUPPORTED: "当前浏览器不支持 WebCodecs VideoDecoder",
    WORKER_STATUS_PARSE_MP4: "正在解析 MP4...",
    WORKER_ERROR_CODEC_UNSUPPORTED: "当前浏览器不支持解码 {{codec}}",
    WORKER_STATUS_DECODE_MP4_FRAME: "正在取模 MP4 帧 {{current}}/{{total}}",
    WORKER_ERROR_MP4_NO_VALID_FRAMES: "MP4 解码成功，但没有取到有效帧",
    WORKER_ERROR_IMAGE_DECODER_UNSUPPORTED: "当前浏览器不支持 ImageDecoder",
    WORKER_STATUS_PARSE_IMAGE: "正在解析 {{format}}...",
    WORKER_STATUS_DECODE_IMAGE_FRAME: "正在取模 {{format}} 帧 {{current}}/{{total}}",
    WORKER_ERROR_IMAGE_NO_VALID_FRAMES: "{{format}} 解码成功，但没有取到有效帧",
    WORKER_ERROR_UNSUPPORTED_FILE_TYPE: "只支持 MP4、GIF 或 PNG 文件",
};
let u8g2AnimationTranslator: U8g2AnimationTranslator | null = null;

function interpolateU8g2AnimationMessage(message: string, params?: U8g2AnimationI18nParams) {
    if (!params) return message;
    return message.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
    ));
}

function translateU8g2AnimationMessage(messageName: string, params?: U8g2AnimationI18nParams) {
    const translationKey = `${U8G2_ANIMATION_I18N_PREFIX}.${messageName}`;
    const translated = u8g2AnimationTranslator?.(translationKey, params);
    if (translated && translated !== translationKey) {
        return translated;
    }
    return interpolateU8g2AnimationMessage(
        DEFAULT_U8G2_ANIMATION_MESSAGES[messageName] || translationKey,
        params,
    );
}

function applyU8g2AnimationBlocklyMessages() {
    U8G2_ANIMATION_BLOCKLY_MESSAGE_NAMES.forEach((messageName) => {
        Blockly.Msg[`U8G2_ANIMATION_${messageName}`] = translateU8g2AnimationMessage(messageName);
    });
}

export function setU8g2AnimationFieldTranslator(translator: U8g2AnimationTranslator | null) {
    u8g2AnimationTranslator = translator;
    applyU8g2AnimationBlocklyMessages();
}

applyU8g2AnimationBlocklyMessages();

export interface U8g2AnimationValue {
    schemaVersion: 1;
    encoding: 'xbm-lsb-row-v1';
    width: number;
    height: number;
    fps: number;
    maxFrames: number;
    dither: boolean;
    threshold: number;
    frameCount: number;
    frames: AilyDataRef | null;
    sourceName?: string;
    sourceType?: string;
    sourcePath?: string;
}

interface DecodedU8g2AnimationValue {
    schemaVersion: 1;
    encoding: 'xbm-lsb-row-v1';
    width: number;
    height: number;
    fps: number;
    maxFrames: number;
    dither: boolean;
    threshold: number;
    frames: Uint8Array[];
    sourceName: string;
    sourceType: string;
}

interface DecodeWorkerMessage {
    type: 'progress' | 'done' | 'error';
    requestId: number;
    message?: string;
    messageKey?: string;
    messageParams?: U8g2AnimationI18nParams;
    progress?: number;
    result?: DecodedU8g2AnimationValue;
}

interface PixelColours {
    readonly empty: string;
    readonly filled: string;
}

interface AnimationDecodeSource {
    fileName: string;
    mimeType: string;
    buffer: ArrayBuffer;
    sourcePath?: string;
}

export interface FieldU8g2AnimationFromJsonConfig extends Blockly.FieldConfig {
    value?: U8g2AnimationValue;
    width?: number;
    height?: number;
    fps?: number;
    maxFrames?: number;
    dither?: boolean;
    threshold?: number;
    fieldHeight?: number;
    colours?: PixelColours;
}

const DEFAULT_WIDTH = 128;
const DEFAULT_HEIGHT = 64;
const DEFAULT_FPS = 10;
const DEFAULT_ANIMATION_SECONDS = 60;
const MAX_FPS = 30;
const MAX_FRAMES = 1800;
const DEFAULT_THRESHOLD = 127;
const BLOCK_FIELD_HEIGHT = 50;
const MAX_SOURCE_FILE_SIZE_BYTES = 12 * 1024 * 1024;
const FRAME_EDITOR_MAX_WIDTH = 560;
const FRAME_EDITOR_MAX_HEIGHT = 320;
const FRAME_STRIP_RENDER_BATCH_SIZE = 16;
const FRAME_STRIP_RENDER_BUDGET_MS = 8;
const DEFAULT_PIXEL_COLOURS: PixelColours = {
    empty: '#151515',
    filled: '#f4f4f4',
};
const FRAME_PAINT_CURSOR = createSvgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M18 2.5 21.5 6 10.8 16.7l-4.5 1 1-4.5L18 2.5Z" fill="#f5f5f5" stroke="#1a1a1a" stroke-width="1.5" stroke-linejoin="round"/><path d="m5.6 18.1 5.2-1.4L7.5 22H3l2.6-3.9Z" fill="#4db6ac" stroke="#1a1a1a" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
    5,
    21,
    'crosshair',
);
const FRAME_ERASER_CURSOR = createSvgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g transform="rotate(-45 12 12)"><rect x="4" y="8" width="16" height="9" rx="2" fill="#f5f5f5" stroke="#1a1a1a" stroke-width="1.5"/><path d="M12 8v9" stroke="#1a1a1a" stroke-width="1.2"/><rect x="5.5" y="9.5" width="5" height="6" rx="1" fill="#ff8da1"/></g></svg>`,
    12,
    12,
    'cell',
);
let u8g2AnimationModeCounter = 0;

function createSvgCursor(svg: string, hotX: number, hotY: number, fallback: string) {
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotX} ${hotY}, ${fallback}`;
}

function getMaxFramesLimit() {
    return MAX_FRAMES;
}

function getDefaultMaxFrames(fps: number) {
    return Math.min(getMaxFramesLimit(), Math.max(1, Math.floor(fps) * DEFAULT_ANIMATION_SECONDS));
}

function getFrameByteLength(width: number, height: number) {
    return Math.ceil(width / 8) * height;
}

export class FieldU8g2Animation extends Blockly.Field<U8g2AnimationValue> {
    private readonly bitmapModeInputName = `u8g2AnimationMode-${++u8g2AnimationModeCounter}`;
    private initialValue: U8g2AnimationValue | null = null;
    private imgWidth: number;
    private imgHeight: number;
    private fps: number;
    private maxFrames: number;
    private dither: boolean;
    private threshold: number;
    private fieldHeight: number;
    private pixelSize: number;
    private pixelColours: PixelColours;
    private blockDisplayImage: SVGImageElement | null = null;
    private frameStrip: HTMLElement | null = null;
    private statusElement: HTMLElement | null = null;
    private fileInput: HTMLInputElement | null = null;
    private playTestButton: HTMLButtonElement | null = null;
    private widthInput: HTMLInputElement | null = null;
    private heightInput: HTMLInputElement | null = null;
    private fpsInput: HTMLInputElement | null = null;
    private maxFramesInput: HTMLInputElement | null = null;
    private thresholdInput: HTMLInputElement | null = null;
    private ditherInput: HTMLInputElement | null = null;
    private thresholdValueControl: HTMLElement | null = null;
    private thresholdValueInput: HTMLInputElement | null = null;
    private frameEditor: HTMLElement | null = null;
    private frameEditorTitle: HTMLElement | null = null;
    private frameEditorCanvas: HTMLCanvasElement | null = null;
    private frameEditorContext: CanvasRenderingContext2D | null = null;
    private editingFrameIndex: number | null = null;
    private editingFrameDraft: number[][] | null = null;
    private frameEditorPixelSize = 1;
    private frameEditorPointerIsDown = false;
    private frameEditorPaintValue?: number;
    private frameEditorLastRow = -1;
    private frameEditorLastCol = -1;
    private boundEvents: Blockly.browserEvents.Data[] = [];
    private decodeWorker: Worker | null = null;
    private sourceRedecodeTimer: ReturnType<typeof setTimeout> | null = null;
    private sourceRedecodeInProgress = false;
    private sourceRedecodePending = false;
    private sourceRedecodeVersion = 0;
    private parameterInputTimerId: ReturnType<typeof setTimeout> | null = null;
    private frameStripRenderFrameId: number | null = null;
    private frameStripRenderVersion = 0;
    private playTestTimerId: ReturnType<typeof setTimeout> | null = null;
    private playTestActive = false;
    private playTestFrameIndex = 0;
    private requestId = 0;
    private sourceBlockRenderScheduled = false;
    private resolvedFrames: number[][][] = [];
    private resolvedFrameRefId = '';
    private loadingFrames: Promise<number[][][]> | null = null;
    private frameMutationVersion = 0;

    constructor(
        value: U8g2AnimationValue | typeof Blockly.Field.SKIP_SETUP,
        validator?: Blockly.FieldValidator<U8g2AnimationValue>,
        config?: FieldU8g2AnimationFromJsonConfig,
    ) {
        super(value, validator, config);
        this.SERIALIZABLE = true;

        const normalized = this.normalizeValue(
            value === Blockly.Field.SKIP_SETUP ? config?.value : value,
            config,
        );

        this.imgWidth = normalized.width;
        this.imgHeight = normalized.height;
        this.fps = normalized.fps;
        this.maxFrames = normalized.maxFrames;
        this.dither = normalized.dither;
        this.threshold = normalized.threshold;
        this.fieldHeight = BLOCK_FIELD_HEIGHT;
        this.pixelColours = { ...DEFAULT_PIXEL_COLOURS, ...config?.colours };
        this.pixelSize = this.getPixelSize();

        if (value === Blockly.Field.SKIP_SETUP && !config?.value) {
            this.setValue(normalized);
        }
    }

    static override fromJson(options: FieldU8g2AnimationFromJsonConfig) {
        return new this(
            options.value ?? Blockly.Field.SKIP_SETUP,
            undefined,
            options,
        );
    }

    protected override doClassValidation_(
        newValue?: U8g2AnimationValue,
    ): U8g2AnimationValue | null | undefined {
        if (!newValue || typeof newValue !== 'object') {
            return null;
        }

        const normalized = this.normalizeValue(newValue);
        return normalized;
    }

    protected override doValueUpdate_(newValue: U8g2AnimationValue) {
        const dimensionsChanged = this.imgWidth !== newValue.width || this.imgHeight !== newValue.height;
        const nextRefId = newValue.frames?.$ailyData.id || '';
        if (nextRefId !== this.resolvedFrameRefId) {
            this.resolvedFrames = [];
            this.resolvedFrameRefId = '';
            this.loadingFrames = null;
        }
        this.value_ = this.cloneValue(newValue);
        this.imgWidth = newValue.width;
        this.imgHeight = newValue.height;
        this.fps = newValue.fps;
        this.maxFrames = newValue.maxFrames;
        this.dither = newValue.dither;
        this.threshold = newValue.threshold;
        this.pixelSize = this.getPixelSize();
        this.updateSize_();
        this.updateBlockDisplayImage();
        this.updateControlsFromValue();
        this.renderFrameStrip();
        this.updatePlayTestButtonState();
        if (nextRefId && this.blockDisplayImage) {
            queueMicrotask(() => {
                void this.ensureFramesLoaded().catch((error) => this.reportProjectDataLoadError(error));
            });
        }
        if (dimensionsChanged) this.rerenderSourceBlockAfterResize();
    }

    override saveState(_doFullSerialization?: boolean): U8g2AnimationValue {
        return this.cloneValue(this.getValue());
    }

    protected override showEditor_(e?: Event) {
        const editor = this.dropdownCreate();
        const dropdownContent = Blockly.DropDownDiv.getContentDiv();
        dropdownContent.appendChild(editor);
        dropdownContent.classList.add('ailyMediaFieldDropdown');
        Blockly.DropDownDiv.showPositionedByField(
            this,
            this.dropdownDispose.bind(this),
        );
        void this.ensureFramesLoaded().catch((error) => this.reportProjectDataLoadError(error));
    }

    protected override render_() {
        super.render_();
        this.updateBlockDisplayImage();
    }

    override initView() {
        this.blockDisplayImage = Blockly.utils.dom.createSvgElement(
            'image',
            {
                x: 0,
                y: 0,
                width: this.pixelSize * this.imgWidth,
                height: this.pixelSize * this.imgHeight,
                style: 'image-rendering: pixelated; cursor: pointer;',
            },
            this.getSvgRoot(),
        ) as SVGImageElement;

        this.updateBlockDisplayImage();
        void this.ensureFramesLoaded().catch((error) => this.reportProjectDataLoadError(error));
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

    override getScaledBBox() {
        const boundingBox = this.getSvgRoot()?.getBoundingClientRect();
        if (!boundingBox) {
            throw new Error('Tried to retrieve a bounding box without a rect');
        }
        return new Blockly.utils.Rect(
            boundingBox.top,
            boundingBox.bottom,
            boundingBox.left,
            boundingBox.right,
        );
    }

    protected override updateSize_() {
        const newWidth = this.pixelSize * this.imgWidth;
        const newHeight = this.pixelSize * this.imgHeight;

        if (this.borderRect_) {
            this.borderRect_.setAttribute('width', String(newWidth));
            this.borderRect_.setAttribute('height', String(newHeight));
        }
        if (this.blockDisplayImage) {
            this.blockDisplayImage.setAttribute('width', String(newWidth));
            this.blockDisplayImage.setAttribute('height', String(newHeight));
        }

        this.size_.width = newWidth;
        this.size_.height = newHeight;
    }

    override dispose() {
        this.commitParameterInputChange();
        this.stopPlayTest(false);
        this.clearSourceRedecodeTimer();
        this.terminateWorker();
        for (const event of this.boundEvents) {
            Blockly.browserEvents.unbind(event);
        }
        this.boundEvents.length = 0;
        super.dispose();
    }

    private dropdownCreate() {
        const dropdownEditor = this.createElementWithClassname(
            'div',
            'u8g2AnimationEditor ailyMediaFieldEditor',
        );
        this.bindEditorContainerEvents(dropdownEditor);

        const toolbar = this.createToolbar();
        dropdownEditor.appendChild(toolbar);
        dropdownEditor.appendChild(this.createStatus());
        dropdownEditor.appendChild(this.createFrameEditor());

        this.frameStrip = this.createElementWithClassname('div', 'u8g2AnimationFrameStrip ailyMediaFieldSurface');
        dropdownEditor.appendChild(this.frameStrip);
        this.renderFrameStrip();
        this.syncDropdownWidthToToolbar(dropdownEditor, toolbar);

        Blockly.DropDownDiv.getContentDiv().classList.add('contains-u8g2-animation-editor');
        this.initialValue = this.cloneValue(this.getValue());

        return dropdownEditor;
    }

    private syncDropdownWidthToToolbar(dropdownEditor: HTMLElement, toolbar: HTMLElement) {
        requestAnimationFrame(() => {
            if (!dropdownEditor.isConnected) return;

            const toolbarWidth = Math.ceil(toolbar.getBoundingClientRect().width || toolbar.scrollWidth);
            if (toolbarWidth <= 0) return;

            const style = getComputedStyle(dropdownEditor);
            const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
            dropdownEditor.style.width = `${Math.ceil(toolbarWidth + horizontalPadding)}px`;
            this.repositionDropdownIfOpen();
        });
    }

    private createToolbar() {
        const toolbar = this.createElementWithClassname('div', 'u8g2AnimationToolbar ailyMediaFieldToolbar');
        const dimensionGroup = this.createElementWithClassname('div', 'u8g2AnimationControlGroup ailyMediaFieldSettings');

        this.widthInput = this.createNumberInput('W', this.imgWidth, 1, 256);
        this.heightInput = this.createNumberInput('H', this.imgHeight, 1, 128);
        this.fpsInput = this.createNumberInput('FPS', this.fps, 1, MAX_FPS);
        this.maxFramesInput = this.createNumberInput(Blockly.Msg['U8G2_ANIMATION_LABEL_MAX_FRAMES'], this.maxFrames, 1, getMaxFramesLimit());
        this.thresholdInput = this.createBitmapModeInput('Threshold', 'threshold', !this.dither);
        this.ditherInput = this.createBitmapModeInput('Dither', 'dither', this.dither);
        this.thresholdValueInput = this.createThresholdValueInput(this.threshold);

        this.bindDimensionInputEvents(this.widthInput);
        this.bindDimensionInputEvents(this.heightInput);
        this.bindPlaybackInputEvents(this.fpsInput);
        this.bindPlaybackInputEvents(this.maxFramesInput);
        this.bindBitmapModeInputEvents(this.thresholdInput);
        this.bindBitmapModeInputEvents(this.ditherInput);
        this.bindThresholdValueInputEvents(this.thresholdValueInput);

        dimensionGroup.appendChild(this.createNumberControl(Blockly.Msg['U8G2_ANIMATION_LABEL_WIDTH'], this.widthInput));
        dimensionGroup.appendChild(this.createNumberControl(Blockly.Msg['U8G2_ANIMATION_LABEL_HEIGHT'], this.heightInput));
        dimensionGroup.appendChild(this.createNumberControl(Blockly.Msg['U8G2_ANIMATION_LABEL_FPS'], this.fpsInput));
        dimensionGroup.appendChild(this.createNumberControl(Blockly.Msg['U8G2_ANIMATION_LABEL_MAX_FRAMES'], this.maxFramesInput));
        dimensionGroup.appendChild(this.createBitmapModeControl(Blockly.Msg['U8G2_ANIMATION_LABEL_DITHER'], this.ditherInput));
        dimensionGroup.appendChild(this.createBitmapModeControl(Blockly.Msg['U8G2_ANIMATION_LABEL_THRESHOLD'], this.thresholdInput));
        this.thresholdValueControl = this.createThresholdValueControl(this.thresholdValueInput);
        dimensionGroup.appendChild(this.thresholdValueControl);
        this.updateThresholdValueVisibility();
        toolbar.appendChild(dimensionGroup);

        const actionGroup = this.createElementWithClassname('div', 'u8g2AnimationButtonGroup ailyMediaFieldActions');
        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = 'video/mp4,image/gif,image/png,.mp4,.gif,.png';
        this.fileInput.style.display = 'none';
        actionGroup.appendChild(this.fileInput);
        this.bindEvent(this.fileInput, 'change', this.onFileSelected.bind(this));

        this.addControlButton(
            actionGroup,
            Blockly.Msg['U8G2_ANIMATION_BUTTON_UPLOAD'],
            () => this.fileInput?.click(),
            Blockly.Msg['U8G2_ANIMATION_UPLOAD_TOOLTIP'],
        );
        this.addControlButton(
            actionGroup,
            Blockly.Msg['U8G2_ANIMATION_BUTTON_CLEAR'],
            () => this.clearAnimation(),
        );
        this.addControlButton(
            actionGroup,
            Blockly.Msg['U8G2_ANIMATION_BUTTON_INVERT'],
            () => this.invertAnimation(),
        );
        toolbar.appendChild(actionGroup);

        return toolbar;
    }

    private createStatus() {
        this.statusElement = this.createElementWithClassname('div', 'u8g2AnimationStatus ailyMediaFieldStatus');
        this.updateStatusFromValue();
        return this.statusElement;
    }

    private createFrameEditor() {
        this.frameEditor = this.createElementWithClassname('div', 'u8g2AnimationFrameEditorModal');
        this.frameEditor.classList.add('is-hidden');
        this.frameEditor.setAttribute('role', 'dialog');
        this.frameEditor.setAttribute('aria-modal', 'true');

        const editorPanel = this.createElementWithClassname('div', 'u8g2AnimationFrameEditor ailyMediaFieldSurface');

        const header = this.createElementWithClassname('div', 'u8g2AnimationFrameEditorHeader');
        this.frameEditorTitle = this.createElementWithClassname('span', 'u8g2AnimationFrameEditorTitle');
        header.appendChild(this.frameEditorTitle);

        const editorActions = this.createElementWithClassname('div', 'u8g2AnimationFrameEditorActions');
        const cancelButton = this.createIconButton(
            'u8g2AnimationFrameEditorButton u8g2AnimationFrameEditorCancel',
            'fa-light fa-xmark',
            Blockly.Msg['U8G2_ANIMATION_FRAME_CANCEL'],
            () => this.closeFrameEditor(false),
        );
        const saveButton = this.createIconButton(
            'u8g2AnimationFrameEditorButton u8g2AnimationFrameEditorSave',
            'fa-light fa-check',
            Blockly.Msg['U8G2_ANIMATION_FRAME_DONE'],
            () => this.closeFrameEditor(),
        );
        editorActions.appendChild(cancelButton);
        editorActions.appendChild(saveButton);
        header.appendChild(editorActions);
        editorPanel.appendChild(header);

        const canvasWrap = this.createElementWithClassname('div', 'u8g2AnimationFrameEditorCanvasWrap ailyMediaFieldSurface');
        this.frameEditorCanvas = document.createElement('canvas');
        this.frameEditorCanvas.className = 'u8g2AnimationFrameEditorCanvas';
        this.frameEditorCanvas.tabIndex = 0;
        this.setFrameEditorCursor(false);
        canvasWrap.appendChild(this.frameEditorCanvas);
        editorPanel.appendChild(canvasWrap);

        const mouseHint = this.createElementWithClassname('div', 'u8g2AnimationFrameEditorHint ailyMediaFieldHint');
        mouseHint.textContent = Blockly.Msg['U8G2_ANIMATION_FRAME_HINT'];
        editorPanel.appendChild(mouseHint);

        this.frameEditorContext = this.frameEditorCanvas.getContext('2d');
        if (!this.frameEditorContext) {
            throw new Error(this.t('ERROR_FRAME_EDITOR_CONTEXT'));
        }

        this.frameEditor.appendChild(editorPanel);
        this.bindFrameEditorModalEvents();
        this.bindFrameEditorCanvasEvents();
        return this.frameEditor;
    }

    private createNumberInput(ariaLabel: string, value: number, min: number, max: number) {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'u8g2AnimationNumberInput ailyMediaFieldInput';
        input.min = String(min);
        input.max = String(max);
        input.value = String(value);
        input.setAttribute('aria-label', ariaLabel);
        return input;
    }

    private createBitmapModeInput(ariaLabel: string, value: 'threshold' | 'dither', checked: boolean) {
        const input = document.createElement('input');
        input.type = 'radio';
        input.className = 'u8g2AnimationModeInput';
        input.name = this.bitmapModeInputName;
        input.value = value;
        input.checked = checked;
        input.setAttribute('aria-label', ariaLabel);
        return input;
    }

    private createThresholdValueInput(value: number) {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'u8g2AnimationThresholdValueInput ailyMediaFieldInput';
        input.min = '0';
        input.max = '255';
        input.step = '1';
        input.value = String(value);
        input.setAttribute('aria-label', Blockly.Msg['U8G2_ANIMATION_LABEL_THRESHOLD_VALUE']);
        return input;
    }

    private createNumberControl(labelText: string, input: HTMLInputElement) {
        const control = this.createElementWithClassname('label', 'u8g2AnimationNumberControl ailyMediaFieldControl');
        const label = document.createElement('span');
        label.textContent = labelText;
        control.appendChild(label);
        control.appendChild(input);
        return control;
    }

    private createBitmapModeControl(labelText: string, input: HTMLInputElement) {
        const control = this.createElementWithClassname('label', 'u8g2AnimationModeControl ailyMediaFieldControl');
        control.appendChild(input);
        const label = document.createElement('span');
        label.textContent = labelText;
        control.appendChild(label);
        return control;
    }

    private createThresholdValueControl(input: HTMLInputElement) {
        const control = this.createElementWithClassname('span', 'u8g2AnimationThresholdValueControl');
        control.appendChild(input);
        return control;
    }

    private addControlButton(
        parent: HTMLElement,
        buttonText: string,
        onClick: (e?: Event) => void,
        tooltip?: string,
    ) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'u8g2AnimationButton ailyMediaFieldButton';
        button.textContent = buttonText;
        if (tooltip) {
            button.title = tooltip;
        }
        parent.appendChild(button);
        this.bindEvent(button, 'click', onClick);
        return button;
    }

    private createIconButton(
        className: string,
        iconClassName: string,
        label: string,
        onClick: (event: Event) => void,
        trackEvent = true,
    ) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.title = label;
        button.setAttribute('aria-label', label);

        const icon = document.createElement('i');
        icon.className = iconClassName;
        button.appendChild(icon);

        if (trackEvent) {
            this.bindEvent(button, 'click', onClick);
        } else {
            button.addEventListener('click', onClick);
        }
        return button;
    }

    private bindDimensionInputEvents(input: HTMLInputElement) {
        this.bindEvent(input, 'input', this.scheduleParameterInputChange.bind(this));
        this.bindEvent(input, 'change', this.scheduleParameterInputChange.bind(this));
        this.bindEvent(input, 'blur', this.scheduleParameterInputChange.bind(this));
    }

    private bindPlaybackInputEvents(input: HTMLInputElement) {
        this.bindEvent(input, 'input', this.scheduleParameterInputChange.bind(this));
        this.bindEvent(input, 'change', this.scheduleParameterInputChange.bind(this));
        this.bindEvent(input, 'blur', this.scheduleParameterInputChange.bind(this));
    }

    private bindBitmapModeInputEvents(input: HTMLInputElement) {
        this.bindEvent(input, 'change', this.onBitmapModeInputChange.bind(this));
    }

    private bindThresholdValueInputEvents(input: HTMLInputElement) {
        this.bindEvent(input, 'input', this.scheduleParameterInputChange.bind(this));
        this.bindEvent(input, 'change', this.scheduleParameterInputChange.bind(this));
        this.bindEvent(input, 'blur', this.scheduleParameterInputChange.bind(this));
    }

    private bindEditorContainerEvents(dropdownEditor: HTMLElement) {
        const stopEventPropagation = (event: Event) => event.stopPropagation();
        const stopContextMenu = (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
        };

        for (const eventName of [
            'pointerdown',
            'pointermove',
            'pointerup',
            'mousedown',
            'mousemove',
            'mouseup',
            'click',
            'dblclick',
            'touchstart',
            'touchmove',
            'touchend',
        ]) {
            this.bindEvent(dropdownEditor, eventName, stopEventPropagation);
        }
        this.bindEvent(dropdownEditor, 'contextmenu', stopContextMenu);
    }

    private scheduleParameterInputChange() {
        this.clearParameterInputTimer();
        this.parameterInputTimerId = setTimeout(() => {
            this.parameterInputTimerId = null;
            this.applyParameterInputChange();
        }, MEDIA_FIELD_PARAMETER_DEBOUNCE_MS);
    }

    private commitParameterInputChange() {
        this.clearParameterInputTimer();
        this.applyParameterInputChange();
    }

    private clearParameterInputTimer() {
        if (this.parameterInputTimerId !== null) {
            clearTimeout(this.parameterInputTimerId);
            this.parameterInputTimerId = null;
        }
    }

    private applyParameterInputChange() {
        const operation = this.applyParameterInputChangeAsync();
        projectDataRuntime.trackMutation(operation);
        void operation.catch((error) => this.reportProjectDataLoadError(error));
    }

    private async applyParameterInputChangeAsync() {
        if (
            !this.widthInput
            || !this.heightInput
            || !this.fpsInput
            || !this.maxFramesInput
            || !this.thresholdInput
            || !this.ditherInput
            || !this.thresholdValueInput
        ) return;
        if (
            this.widthInput.value === ''
            || this.heightInput.value === ''
            || this.fpsInput.value === ''
            || this.maxFramesInput.value === ''
            || this.thresholdValueInput.value === ''
        ) return;

        const currentValue = this.getValue();
        const nextWidth = this.clampInput(this.widthInput, currentValue.width);
        const nextHeight = this.clampInput(this.heightInput, currentValue.height);
        const nextFps = this.clampInput(this.fpsInput, currentValue.fps);
        const nextMaxFramesLimit = getMaxFramesLimit();
        this.maxFramesInput.max = String(nextMaxFramesLimit);
        let nextMaxFrames = this.clampInput(this.maxFramesInput, currentValue.maxFrames);
        if (
            nextFps !== currentValue.fps
            && (
                currentValue.maxFrames === getDefaultMaxFrames(currentValue.fps)
                || currentValue.maxFrames === nextMaxFramesLimit
            )
            && Number(this.maxFramesInput.value) === currentValue.maxFrames
        ) {
            nextMaxFrames = currentValue.maxFrames === nextMaxFramesLimit
                ? nextMaxFramesLimit
                : getDefaultMaxFrames(nextFps);
        }
        if (!this.thresholdInput.checked && !this.ditherInput.checked) {
            this.thresholdInput.checked = true;
        }
        const nextDither = this.ditherInput.checked;
        this.thresholdInput.checked = !nextDither;
        this.ditherInput.checked = nextDither;
        const nextThreshold = this.clampInput(this.thresholdValueInput, currentValue.threshold);

        this.widthInput.value = String(nextWidth);
        this.heightInput.value = String(nextHeight);
        this.fpsInput.value = String(nextFps);
        this.maxFramesInput.value = String(nextMaxFrames);
        this.thresholdValueInput.value = String(nextThreshold);
        this.updateThresholdValueVisibility();

        const dimensionsChanged = nextWidth !== currentValue.width || nextHeight !== currentValue.height;
        const parametersChanged = dimensionsChanged
            || nextFps !== currentValue.fps
            || nextMaxFrames !== currentValue.maxFrames
            || nextDither !== currentValue.dither
            || nextThreshold !== currentValue.threshold;
        if (!parametersChanged) return;

        await this.ensureFramesLoaded();
        this.closeFrameEditor();
        const resizedFrames = dimensionsChanged
            ? this.resizeFrames(this.resolvedFrames, nextWidth, nextHeight)
            : this.resolvedFrames;
        const nextFrames = resizedFrames.length > nextMaxFrames
            ? resizedFrames.slice(0, nextMaxFrames)
            : resizedFrames;
        const nextValue: U8g2AnimationValue = {
            ...currentValue,
            width: nextWidth,
            height: nextHeight,
            fps: nextFps,
            maxFrames: nextMaxFrames,
            dither: nextDither,
            threshold: nextThreshold,
        };
        if (dimensionsChanged || nextFrames.length !== this.resolvedFrames.length) {
            this.commitManualFrames(nextValue, nextFrames, true);
        } else {
            this.setValue(nextValue, false);
        }
        this.scheduleRedecodeFromSource(0);
    }

    private onBitmapModeInputChange() {
        if (!this.thresholdInput || !this.ditherInput) return;

        if (!this.thresholdInput.checked && !this.ditherInput.checked) {
            this.thresholdInput.checked = true;
        }

        const nextDither = this.ditherInput.checked;
        this.thresholdInput.checked = !nextDither;
        this.ditherInput.checked = nextDither;
        this.updateThresholdValueVisibility();

        this.scheduleParameterInputChange();
    }

    private async onFileSelected(event: Event) {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;

        input.value = '';
        this.commitParameterInputChange();
        this.invalidateSourceRedecode();
        this.clearSourceRedecodeTimer();
        this.closeFrameEditor(false);
        const width = this.widthInput ? this.clampInput(this.widthInput, this.imgWidth) : this.imgWidth;
        const height = this.heightInput ? this.clampInput(this.heightInput, this.imgHeight) : this.imgHeight;
        const fps = this.fpsInput ? this.clampInput(this.fpsInput, this.fps) : this.fps;
        if (this.maxFramesInput) {
            this.maxFramesInput.max = String(getMaxFramesLimit());
        }
        const maxFrames = this.maxFramesInput ? this.clampInput(this.maxFramesInput, this.maxFrames) : this.maxFrames;
        const dither = this.ditherInput ? this.ditherInput.checked : this.dither;
        const threshold = this.thresholdValueInput ? this.clampInput(this.thresholdValueInput, this.threshold) : this.threshold;

        try {
            if (file.size > MAX_SOURCE_FILE_SIZE_BYTES) {
                throw new Error(this.t('ERROR_FILE_SIZE_EXCEEDED', {
                    maxSize: this.formatFileSize(MAX_SOURCE_FILE_SIZE_BYTES),
                    currentSize: this.formatFileSize(file.size),
                }));
            }

            this.setStatus(this.t('STATUS_READING_FILE', { name: file.name }));
            const buffer = await file.arrayBuffer();
            this.invalidateSourceRedecode();
            this.clearSourceRedecodeTimer();
            this.setStatus(this.t('STATUS_SAVING_FILE', { name: file.name }));
            const sourcePath = this.persistSourceFile(file, buffer);
            await this.decodeAnimation({
                fileName: file.name,
                mimeType: file.type || this.inferMimeType(file.name),
                buffer,
                sourcePath,
            }, width, height, fps, maxFrames, dither, threshold);
        } catch (error: any) {
            this.setStatus(error?.message || this.t('ERROR_DECODE_FAILED'), true);
        }
    }

    private async decodeAnimation(
        source: AnimationDecodeSource,
        width: number,
        height: number,
        fps: number,
        maxFrames: number,
        dither: boolean,
        threshold: number,
        shouldApplyResult: () => boolean = () => true,
    ) {
        this.terminateWorker();
        const frameMutationVersion = ++this.frameMutationVersion;
        const worker = new Worker(
            new URL('./u8g2-animation-decoder.worker.ts', import.meta.url),
            { type: 'module' },
        );
        this.decodeWorker = worker;
        const requestId = ++this.requestId;

        try {
            await new Promise<void>((resolve, reject) => {
                worker.onmessage = (event: MessageEvent<DecodeWorkerMessage>) => {
                    const message = event.data;
                    if (!message || message.requestId !== requestId) return;

                    if (message.type === 'progress') {
                        this.setStatus(this.resolveWorkerMessage(message, 'STATUS_DECODING'));
                        return;
                    }

                    if (message.type === 'done' && message.result) {
                        void this.persistDecodedFrames(message.result, {
                            sourceName: source.fileName,
                            sourceType: source.mimeType || message.result.sourceType,
                            sourcePath: source.sourcePath,
                        }).then((result) => {
                            if (shouldApplyResult() && frameMutationVersion === this.frameMutationVersion) {
                                this.closeFrameEditor(false);
                                this.setValue(result.value, !this.isDropdownOpen());
                                this.setResolvedFrames(result.value.frames, result.frames);
                                this.refreshResolvedFrames();
                            }
                            resolve();
                        }).catch(reject);
                        return;
                    }

                    if (message.type === 'error') {
                        if (shouldApplyResult()) {
                            reject(new Error(this.resolveWorkerMessage(message, 'ERROR_DECODE_FAILED')));
                        } else {
                            resolve();
                        }
                    }
                };

                worker.onerror = (error) => {
                    if (shouldApplyResult()) {
                        reject(new Error(error.message || this.t('ERROR_DECODE_FAILED')));
                    } else {
                        resolve();
                    }
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
                    dither,
                    threshold,
                }, [source.buffer]);
            });
        } finally {
            if (this.decodeWorker === worker) {
                this.terminateWorker();
            }
        }
    }

    private persistSourceFile(file: File, buffer: ArrayBuffer): string {
        const projectPath = this.getCurrentProjectPath();
        const fsApi = (window as any)['fs'];
        const pathApi = (window as any)['path'];

        if (!projectPath || !fsApi || !pathApi?.join || !pathApi?.relative) {
            throw new Error(this.t('ERROR_PROJECT_PATH_MISSING'));
        }

        if (typeof fsApi.mkdirSync !== 'function') {
            throw new Error(this.t('ERROR_FS_CREATE_ASSETS_UNAVAILABLE'));
        }

        const assetsDir = pathApi.join(projectPath, 'assets', 'u8g2-animation');
        fsApi.mkdirSync(assetsDir);

        const sourceExt = this.getSourceExtension(file.name, file.type);
        const fileMd5 = this.calculateSourceMd5(buffer, fsApi);
        const fileName = `${fileMd5}${sourceExt}`;
        const assetFilePath = pathApi.join(assetsDir, fileName);

        if (typeof fsApi.existsSync === 'function' && fsApi.existsSync(assetFilePath)) {
            return this.normalizeAssetPath(pathApi.relative(projectPath, assetFilePath));
        }

        if (typeof fsApi.writeFileBuffer === 'function') {
            fsApi.writeFileBuffer(assetFilePath, buffer);
        } else if (typeof fsApi.writeFileSync === 'function') {
            fsApi.writeFileSync(assetFilePath, new Uint8Array(buffer));
        } else if (typeof fsApi.writeBase64File === 'function') {
            fsApi.writeBase64File(assetFilePath, this.arrayBufferToBase64(buffer));
        } else {
            throw new Error(this.t('ERROR_FS_SAVE_UNAVAILABLE'));
        }

        return this.normalizeAssetPath(pathApi.relative(projectPath, assetFilePath));
    }

    private scheduleRedecodeFromSource(delayMs = 0) {
        const value = this.getValue();
        if (!value?.sourcePath) return;

        this.sourceRedecodeVersion += 1;
        this.clearSourceRedecodeTimer();
        this.sourceRedecodeTimer = setTimeout(() => {
            this.sourceRedecodeTimer = null;
            void this.redecodeFromSource();
        }, delayMs);
    }

    private clearSourceRedecodeTimer() {
        if (this.sourceRedecodeTimer) {
            clearTimeout(this.sourceRedecodeTimer);
            this.sourceRedecodeTimer = null;
        }
    }

    private invalidateSourceRedecode() {
        this.sourceRedecodeVersion += 1;
        this.sourceRedecodePending = false;
    }

    private async redecodeFromSource() {
        if (this.sourceRedecodeInProgress) {
            this.sourceRedecodePending = true;
            return;
        }

        const value = this.getValue();
        if (!value?.sourcePath) return;

        const sourceFilePath = this.resolveSourceFilePath(value.sourcePath);
        const fsApi = (window as any)['fs'];
        if (!sourceFilePath || (!fsApi?.readFileBuffer && !fsApi?.readFileAsBase64)) {
            this.setStatus(this.t('ERROR_SOURCE_MISSING_REDECODE'), true);
            return;
        }

        if (typeof fsApi.existsSync === 'function' && !fsApi.existsSync(sourceFilePath)) {
            this.setStatus(this.t('ERROR_SOURCE_NOT_FOUND', { path: value.sourcePath }), true);
            return;
        }

        const decodeVersion = this.sourceRedecodeVersion;
        this.sourceRedecodeInProgress = true;
        try {
            const sourceName = value.sourceName || this.getPathBaseName(value.sourcePath);
            this.setStatus(this.t('STATUS_REDECODING', { name: sourceName }));
            const buffer = this.readSourceFileBuffer(sourceFilePath, fsApi);
            await this.decodeAnimation({
                fileName: sourceName,
                mimeType: value.sourceType || this.inferMimeType(value.sourcePath),
                buffer,
                sourcePath: value.sourcePath,
            }, value.width, value.height, value.fps, value.maxFrames, value.dither, value.threshold, () => decodeVersion === this.sourceRedecodeVersion);
        } catch (error: any) {
            if (decodeVersion === this.sourceRedecodeVersion) {
                this.setStatus(error?.message || this.t('ERROR_REDECODE_FAILED'), true);
            }
        } finally {
            this.sourceRedecodeInProgress = false;
            if (this.sourceRedecodePending) {
                this.sourceRedecodePending = false;
                this.scheduleRedecodeFromSource(0);
            }
        }
    }

    private readSourceFileBuffer(sourceFilePath: string, fsApi: any): ArrayBuffer {
        if (typeof fsApi.readFileBuffer === 'function') {
            return this.toArrayBuffer(fsApi.readFileBuffer(sourceFilePath));
        }

        if (typeof fsApi.readFileAsBase64 === 'function') {
            return this.base64ToArrayBuffer(fsApi.readFileAsBase64(sourceFilePath));
        }

        throw new Error(this.t('ERROR_FS_READ_UNAVAILABLE'));
    }

    private toArrayBuffer(data: unknown): ArrayBuffer {
        if (data instanceof ArrayBuffer) {
            return data;
        }

        if (ArrayBuffer.isView(data)) {
            const view = data as ArrayBufferView;
            return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
        }

        if (Array.isArray(data)) {
            return new Uint8Array(data).buffer;
        }

        const maybeBuffer = data as { type?: string; data?: unknown };
        if (maybeBuffer?.type === 'Buffer' && Array.isArray(maybeBuffer.data)) {
            return new Uint8Array(maybeBuffer.data).buffer;
        }

        throw new Error(this.t('ERROR_SOURCE_READ_INVALID'));
    }

    private resolveSourceFilePath(sourcePath: string): string | null {
        const projectPath = this.getCurrentProjectPath();
        const pathApi = (window as any)['path'];
        if (!projectPath || !sourcePath || !pathApi?.join || !pathApi?.resolve || !pathApi?.relative) {
            return null;
        }

        const trimmedSourcePath = sourcePath.trim();
        const isAbsolute = typeof pathApi.isAbsolute === 'function' && pathApi.isAbsolute(trimmedSourcePath);
        const fullPath = isAbsolute
            ? trimmedSourcePath
            : pathApi.join(projectPath, ...trimmedSourcePath.split(/[\\/]+/).filter(Boolean));
        const projectRoot = pathApi.resolve(projectPath);
        const resolvedFullPath = pathApi.resolve(fullPath);
        const relativePath = pathApi.relative(projectRoot, resolvedFullPath);

        if (relativePath.startsWith('..') || (typeof pathApi.isAbsolute === 'function' && pathApi.isAbsolute(relativePath))) {
            return null;
        }

        return resolvedFullPath;
    }

    private getCurrentProjectPath(): string | null {
        const projectServicePath = (window as any)['projectService']?.currentProjectPath;
        if (typeof projectServicePath === 'string' && projectServicePath.trim()) {
            return projectServicePath;
        }

        const searchPath = new URLSearchParams(window.location.search).get('path');
        if (searchPath) {
            return searchPath;
        }

        const hashQueryIndex = window.location.hash.indexOf('?');
        if (hashQueryIndex >= 0) {
            const hashPath = new URLSearchParams(window.location.hash.slice(hashQueryIndex + 1)).get('path');
            if (hashPath) {
                return hashPath;
            }
        }

        return null;
    }

    private getSourceExtension(fileName: string, mimeType?: string) {
        const ext = this.getPathExtension(fileName).toLowerCase();
        if (ext === '.mp4' || ext === '.gif' || ext === '.png') {
            return ext;
        }

        switch ((mimeType || '').toLowerCase()) {
            case 'video/mp4':
                return '.mp4';
            case 'image/gif':
                return '.gif';
            case 'image/png':
                return '.png';
            default:
                return '.bin';
        }
    }

    private calculateSourceMd5(buffer: ArrayBuffer, fsApi: any) {
        if (typeof fsApi.md5Buffer !== 'function') {
            throw new Error(this.t('ERROR_MD5_UNAVAILABLE'));
        }

        const md5 = String(fsApi.md5Buffer(buffer) || '').toLowerCase();
        if (!/^[a-f0-9]{32}$/.test(md5)) {
            throw new Error(this.t('ERROR_MD5_FAILED'));
        }
        return md5;
    }

    private inferMimeType(fileName: string) {
        switch (this.getPathExtension(fileName).toLowerCase()) {
            case '.mp4':
                return 'video/mp4';
            case '.gif':
                return 'image/gif';
            case '.png':
                return 'image/png';
            default:
                return '';
        }
    }

    private getPathExtension(fileName: string) {
        const pathApi = (window as any)['path'];
        if (pathApi?.extname) {
            return pathApi.extname(fileName) || '';
        }
        const match = /\.[^./\\]+$/.exec(fileName);
        return match?.[0] || '';
    }

    private getPathBaseName(fileName: string) {
        const pathApi = (window as any)['path'];
        if (pathApi?.basename) {
            return pathApi.basename(fileName);
        }
        return fileName.split(/[\\/]/).pop() || fileName;
    }

    private normalizeAssetPath(assetPath: string) {
        return assetPath.replace(/\\/g, '/').replace(/^\.\//, '');
    }

    private formatFileSize(bytes: number) {
        if (!Number.isFinite(bytes) || bytes <= 0) {
            return '0 MB';
        }
        return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }

    private arrayBufferToBase64(buffer: ArrayBuffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            const chunk = bytes.subarray(offset, offset + chunkSize);
            binary += String.fromCharCode(...chunk);
        }
        return btoa(binary);
    }

    private base64ToArrayBuffer(base64: string) {
        const rawBase64 = base64.includes(',') ? base64.split(',').pop() || '' : base64;
        const binary = atob(rawBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes.buffer;
    }

    private clearAnimation() {
        this.stopPlayTest(false);
        this.closeFrameEditor(false);
        this.invalidateSourceRedecode();
        this.clearSourceRedecodeTimer();
        this.frameMutationVersion += 1;
        this.setResolvedFrames(null, []);
        this.setValue(this.createEmptyValue(), false);
        this.setStatus(Blockly.Msg['U8G2_ANIMATION_EMPTY']);
    }

    private invertAnimation() {
        const operation = this.applyInvertAnimation();
        projectDataRuntime.trackMutation(operation);
        void operation.catch((error) => this.reportProjectDataLoadError(error));
    }

    private async applyInvertAnimation() {
        await this.ensureFramesLoaded();
        this.closeFrameEditor();
        this.invalidateSourceRedecode();
        this.clearSourceRedecodeTimer();

        const value = this.getValue();
        const nextFrames = this.resolvedFrames.map(frame => (
            frame.map(row => row.map(cell => cell === 1 ? 0 : 1))
        ));

        this.commitManualFrames(value, nextFrames);
        this.renderFrameStrip();
    }

    private renderFrameStrip() {
        if (!this.frameStrip) return;

        this.stopPlayTest(false);
        this.cancelFrameStripRender();
        this.playTestButton = null;
        this.frameStrip.replaceChildren();
        const value = this.getValue();
        const frames = this.resolvedFrames;
        const previewScale = this.getPreviewScale(value.width, value.height);
        this.frameStrip.style.minHeight = '';

        if (!frames.length) {
            const empty = this.createElementWithClassname('div', 'u8g2AnimationEmpty');
            empty.textContent = Blockly.Msg['U8G2_ANIMATION_EMPTY'];
            this.frameStrip.appendChild(empty);
            return;
        }

        this.frameStrip.style.minHeight = `${Math.ceil(value.height * previewScale) + 32}px`;
        const loading = this.createElementWithClassname('div', 'u8g2AnimationFrameLoading');
        loading.textContent = this.t('STATUS_RENDERING_FRAMES_WITH_COUNT', { frames: frames.length });
        this.frameStrip.appendChild(loading);

        const renderVersion = this.frameStripRenderVersion;
        let frameIndex = 0;

        const renderBatch = () => {
            const frameStrip = this.frameStrip;
            if (!frameStrip || renderVersion !== this.frameStripRenderVersion) return;

            const startTime = performance.now();
            const fragment = document.createDocumentFragment();
            let renderedCount = 0;
            while (frameIndex < frames.length && renderedCount < FRAME_STRIP_RENDER_BATCH_SIZE) {
                fragment.appendChild(this.createFrameStripItem(
                    frames[frameIndex],
                    frameIndex,
                    value.width,
                    value.height,
                    previewScale,
                ));
                frameIndex += 1;
                renderedCount += 1;
                if (performance.now() - startTime >= FRAME_STRIP_RENDER_BUDGET_MS) break;
            }

            if (loading.parentElement === frameStrip) {
                frameStrip.replaceChildren(fragment);
                this.repositionDropdownIfOpen();
            } else {
                frameStrip.appendChild(fragment);
            }

            if (frameIndex < frames.length) {
                this.frameStripRenderFrameId = requestAnimationFrame(renderBatch);
            } else {
                this.frameStripRenderFrameId = null;
            }
        };

        this.frameStripRenderFrameId = requestAnimationFrame(renderBatch);
    }

    private createFrameStripItem(
        frame: number[][],
        index: number,
        width: number,
        height: number,
        previewScale: number,
    ) {
        const item = this.createElementWithClassname('div', 'u8g2AnimationFrameItem');
        item.dataset['frameIndex'] = String(index);
        if (index === this.editingFrameIndex) {
            item.classList.add('is-editing');
        }
        const preview = this.createElementWithClassname('div', 'u8g2AnimationFramePreview');
        const canvas = this.renderBitmapToCanvas(frame, width, height, previewScale);
        const actions = this.createElementWithClassname('div', 'u8g2AnimationFrameActions');
        if (index === 0) {
            this.playTestButton = this.createFrameActionButton(
                'fa-light fa-play',
                Blockly.Msg['U8G2_ANIMATION_BUTTON_PLAY_TEST'],
                () => this.togglePlayTest(),
            );
            this.playTestButton.classList.add('u8g2AnimationFramePlayAction');
            this.updatePlayTestButtonState();
            actions.appendChild(this.playTestButton);
        }
        actions.appendChild(this.createFrameActionButton(
            'fa-light fa-paintbrush',
            Blockly.Msg['U8G2_ANIMATION_FRAME_EDIT'],
            (event) => this.openFrameEditor(this.getFrameStripItemIndex(item), event),
        ));
        actions.appendChild(this.createFrameActionButton(
            'fa-light fa-trash',
            Blockly.Msg['U8G2_ANIMATION_FRAME_DELETE'],
            (event) => this.deleteFrame(this.getFrameStripItemIndex(item), event),
        ));
        const label = document.createElement('span');
        label.textContent = String(index + 1);
        preview.appendChild(canvas);
        preview.appendChild(actions);
        item.appendChild(preview);
        item.appendChild(label);
        return item;
    }

    private getFrameStripItemIndex(item: HTMLElement) {
        const index = Number(item.dataset['frameIndex']);
        return Number.isInteger(index) ? index : -1;
    }

    private updateFrameStripEditingState() {
        if (!this.frameStrip) return;
        const editingFrameIndex = this.editingFrameIndex;
        this.frameStrip.querySelectorAll<HTMLElement>('.u8g2AnimationFrameItem').forEach((item) => {
            item.classList.toggle(
                'is-editing',
                Number(item.dataset['frameIndex']) === editingFrameIndex,
            );
        });
    }

    private updateFrameStripItem(index: number, frame: number[][], width: number, height: number) {
        const item = this.getFrameStripItem(index);
        if (!item) return;

        const nextItem = this.createFrameStripItem(
            frame,
            index,
            width,
            height,
            this.getPreviewScale(width, height),
        );
        item.replaceWith(nextItem);
    }

    private updateFrameStripAfterDelete(index: number, frameCount: number) {
        const item = this.getFrameStripItem(index);
        item?.remove();

        if (!this.frameStrip) return;
        this.frameStrip.querySelectorAll<HTMLElement>('.u8g2AnimationFrameItem').forEach((frameItem) => {
            const currentIndex = this.getFrameStripItemIndex(frameItem);
            if (currentIndex <= index) return;

            const nextIndex = currentIndex - 1;
            frameItem.dataset['frameIndex'] = String(nextIndex);
            const label = frameItem.querySelector('span');
            if (label) {
                label.textContent = String(nextIndex + 1);
            }
        });

        if (frameCount <= 1 && !this.frameStrip.querySelector('.u8g2AnimationFrameItem')) {
            this.renderFrameStrip();
        } else {
            this.updateFrameStripEditingState();
        }
    }

    private getFrameStripItem(index: number) {
        if (!this.frameStrip || index < 0) return null;
        return this.frameStrip.querySelector<HTMLElement>(`.u8g2AnimationFrameItem[data-frame-index="${index}"]`);
    }

    private cancelFrameStripRender() {
        this.frameStripRenderVersion += 1;
        if (this.frameStripRenderFrameId !== null) {
            cancelAnimationFrame(this.frameStripRenderFrameId);
            this.frameStripRenderFrameId = null;
        }
    }

    private repositionDropdownIfOpen() {
        if (Blockly.DropDownDiv.getOwner() === this) {
            Blockly.DropDownDiv.repositionForWindowResize();
        }
    }

    private createFrameActionButton(
        iconClassName: string,
        label: string,
        onClick: (event: Event) => void,
    ) {
        return this.createIconButton(
            'u8g2AnimationFrameAction',
            iconClassName,
            label,
            (event) => {
                this.stopFrameEditorEvent(event);
                onClick(event);
            },
            false,
        );
    }

    private openFrameEditor(index: number, event?: Event) {
        this.stopPlayTest();
        if (event) {
            this.stopFrameEditorEvent(event);
        }

        if (index < 0) return;
        const value = this.getValue();
        if (!this.resolvedFrames[index]) return;

        if (this.editingFrameIndex !== null && this.editingFrameIndex !== index) {
            this.applyFrameEditorDraft();
        }

        this.editingFrameIndex = index;
        this.editingFrameDraft = this.cloneFrame(this.resolvedFrames[index], value.width, value.height);
        this.frameEditorPixelSize = this.getFrameEditorScale(value.width, value.height);
        this.resizeFrameEditorCanvas(value.width, value.height);
        this.updateFrameEditorTitle();
        this.renderFrameEditorCanvas();
        this.frameEditor?.classList.remove('is-hidden');
        this.frameEditorCanvas?.focus();
        this.updateFrameStripEditingState();
    }

    private closeFrameEditor(applyDraft = true) {
        if (applyDraft) {
            this.applyFrameEditorDraft();
        }

        this.frameEditorPointerIsDown = false;
        this.frameEditorPaintValue = undefined;
        this.frameEditorLastRow = -1;
        this.frameEditorLastCol = -1;
        this.editingFrameIndex = null;
        this.editingFrameDraft = null;
        this.frameEditor?.classList.add('is-hidden');
        if (this.frameEditorTitle) {
            this.frameEditorTitle.textContent = '';
        }
        this.setFrameEditorCursor(false);
        this.updateFrameStripEditingState();
    }

    private applyFrameEditorDraft() {
        if (this.editingFrameIndex === null || !this.editingFrameDraft) return;

        const value = this.getValue();
        const frameIndex = this.editingFrameIndex;
        const frame = this.resolvedFrames[frameIndex];
        if (!frame) return;

        const nextFrame = this.cloneFrame(this.editingFrameDraft, value.width, value.height);
        if (this.framesEqual(frame, nextFrame)) return;

        this.invalidateSourceRedecode();
        this.clearSourceRedecodeTimer();
        const frames = this.resolvedFrames.slice();
        frames[frameIndex] = nextFrame;
        this.commitManualFrames(value, frames);
        this.updateFrameStripItem(frameIndex, nextFrame, value.width, value.height);
    }

    private deleteFrame(index: number, event?: Event) {
        this.stopPlayTest();
        if (event) {
            this.stopFrameEditorEvent(event);
        }

        if (index < 0) return;
        if (this.editingFrameIndex !== null && this.editingFrameIndex !== index) {
            this.applyFrameEditorDraft();
        }

        const value = this.getValue();
        if (!this.resolvedFrames[index]) return;

        this.invalidateSourceRedecode();
        this.clearSourceRedecodeTimer();

        const wasFrameStripRendering = this.frameStripRenderFrameId !== null;
        if (wasFrameStripRendering) {
            this.cancelFrameStripRender();
        }

        const frames = [
            ...this.resolvedFrames.slice(0, index),
            ...this.resolvedFrames.slice(index + 1),
        ];
        const nextFrames = frames.length
            ? frames
            : [this.createEmptyFrame(value.width, value.height)];

        if (this.editingFrameIndex === index) {
            this.closeFrameEditor(false);
        } else if (this.editingFrameIndex !== null && this.editingFrameIndex > index) {
            this.editingFrameIndex -= 1;
            this.updateFrameEditorTitle();
        }

        this.commitManualFrames(value, nextFrames);
        if (wasFrameStripRendering || this.resolvedFrames.length <= 1) {
            this.renderFrameStrip();
        } else {
            this.updateFrameStripAfterDelete(index, nextFrames.length);
        }
    }

    private updateFrameEditorTitle() {
        if (!this.frameEditorTitle || this.editingFrameIndex === null) return;
        this.frameEditorTitle.textContent = this.t('FRAME_EDITOR_TITLE', { index: this.editingFrameIndex + 1 });
    }

    private resizeFrameEditorCanvas(width: number, height: number) {
        if (!this.frameEditorCanvas) return;
        this.frameEditorCanvas.width = Math.max(1, width * this.frameEditorPixelSize);
        this.frameEditorCanvas.height = Math.max(1, height * this.frameEditorPixelSize);
    }

    private renderFrameEditorCanvas() {
        if (!this.frameEditorContext || !this.frameEditorCanvas || !this.editingFrameDraft) return;

        const value = this.getValue();
        this.frameEditorContext.clearRect(0, 0, this.frameEditorCanvas.width, this.frameEditorCanvas.height);
        for (let row = 0; row < value.height; row++) {
            for (let col = 0; col < value.width; col++) {
                this.paintFrameEditorPixel(row, col, this.editingFrameDraft[row]?.[col] === 1 ? 1 : 0);
            }
        }
    }

    private bindFrameEditorModalEvents() {
        if (!this.frameEditor) return;

        this.bindEvent(this.frameEditor, 'click', this.onFrameEditorModalClick.bind(this));
        this.bindEvent(document, 'keydown', this.onFrameEditorKeyDown.bind(this));
    }

    private bindFrameEditorCanvasEvents() {
        if (!this.frameEditorCanvas) return;

        this.bindEvent(this.frameEditorCanvas, 'pointerdown', this.onFrameEditorPointerStart.bind(this));
        this.bindEvent(this.frameEditorCanvas, 'pointermove', this.onFrameEditorPointerMove.bind(this));
        this.bindEvent(this.frameEditorCanvas, 'pointerup', this.onFrameEditorPointerEnd.bind(this));
        this.bindEvent(this.frameEditorCanvas, 'pointerleave', this.onFrameEditorPointerEnd.bind(this));
        this.bindEvent(this.frameEditorCanvas, 'pointercancel', this.onFrameEditorPointerEnd.bind(this));
        this.bindEvent(this.frameEditorCanvas, 'contextmenu', this.stopFrameEditorEvent.bind(this));
        this.bindEvent(this.frameEditorCanvas, 'touchmove', this.stopFrameEditorEvent.bind(this));
    }

    private onFrameEditorModalClick(event: Event) {
        event.stopPropagation();
        if (event.target === this.frameEditor) {
            event.preventDefault();
            this.closeFrameEditor(false);
        }
    }

    private onFrameEditorKeyDown(event: Event) {
        if (this.editingFrameIndex === null) return;

        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== 'Escape') return;

        this.stopFrameEditorEvent(event);
        this.closeFrameEditor(false);
    }

    private onFrameEditorPointerStart(event: Event) {
        if (!this.frameEditorCanvas || !this.editingFrameDraft) return;

        const pointerEvent = event as PointerEvent;
        if (pointerEvent.button !== 0 && pointerEvent.button !== 2) return;
        this.stopFrameEditorEvent(event);

        const point = this.getFrameEditorPoint(pointerEvent);
        if (!point) return;

        this.frameEditorPointerIsDown = true;
        this.frameEditorPaintValue = pointerEvent.button === 2 ? 0 : 1;
        this.setFrameEditorCursor(this.frameEditorPaintValue === 0);
        this.frameEditorLastRow = point.row;
        this.frameEditorLastCol = point.col;
        this.drawFrameEditorLine(point.row, point.col, point.row, point.col);
    }

    private onFrameEditorPointerMove(event: Event) {
        this.stopFrameEditorEvent(event);
        if (!this.frameEditorPointerIsDown || this.frameEditorPaintValue === undefined) return;

        const point = this.getFrameEditorPoint(event as PointerEvent);
        if (!point) return;

        if (point.row !== this.frameEditorLastRow || point.col !== this.frameEditorLastCol) {
            this.drawFrameEditorLine(this.frameEditorLastRow, this.frameEditorLastCol, point.row, point.col);
            this.frameEditorLastRow = point.row;
            this.frameEditorLastCol = point.col;
        }
    }

    private onFrameEditorPointerEnd(event?: Event) {
        if (event) {
            this.stopFrameEditorEvent(event);
        }

        this.frameEditorPointerIsDown = false;
        this.frameEditorPaintValue = undefined;
        this.frameEditorLastRow = -1;
        this.frameEditorLastCol = -1;
        this.setFrameEditorCursor(false);
    }

    private getFrameEditorPoint(event: PointerEvent) {
        if (!this.frameEditorCanvas) return null;

        const value = this.getValue();
        const rect = this.frameEditorCanvas.getBoundingClientRect();
        const col = Math.floor((event.clientX - rect.left) / this.frameEditorPixelSize);
        const row = Math.floor((event.clientY - rect.top) / this.frameEditorPixelSize);

        if (row < 0 || row >= value.height || col < 0 || col >= value.width) {
            return null;
        }

        return { row, col };
    }

    private drawFrameEditorLine(rowStart: number, colStart: number, rowEnd: number, colEnd: number) {
        if (this.frameEditorPaintValue === undefined) return;

        const dx = Math.abs(colEnd - colStart);
        const dy = Math.abs(rowEnd - rowStart);
        const sx = colStart < colEnd ? 1 : -1;
        const sy = rowStart < rowEnd ? 1 : -1;
        let err = dx - dy;
        let row = rowStart;
        let col = colStart;

        while (true) {
            this.paintFrameEditorAt(row, col);
            if (row === rowEnd && col === colEnd) break;

            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                col += sx;
            }
            if (e2 < dx) {
                err += dx;
                row += sy;
            }
        }
    }

    private paintFrameEditorAt(row: number, col: number) {
        if (!this.editingFrameDraft || this.frameEditorPaintValue === undefined) return;
        if (!this.editingFrameDraft[row]) return;

        const nextValue = this.frameEditorPaintValue === 1 ? 1 : 0;
        if (this.editingFrameDraft[row][col] === nextValue) return;

        this.editingFrameDraft[row][col] = nextValue;
        this.paintFrameEditorPixel(row, col, nextValue);
    }

    private paintFrameEditorPixel(row: number, col: number, value: number) {
        if (!this.frameEditorContext) return;

        const x = col * this.frameEditorPixelSize;
        const y = row * this.frameEditorPixelSize;
        this.frameEditorContext.fillStyle = value ? this.pixelColours.filled : this.pixelColours.empty;
        this.frameEditorContext.fillRect(x, y, this.frameEditorPixelSize, this.frameEditorPixelSize);

        if (this.frameEditorPixelSize >= 5) {
            this.frameEditorContext.strokeStyle = '#4f4f4f';
            this.frameEditorContext.lineWidth = 1;
            this.frameEditorContext.strokeRect(x + 0.5, y + 0.5, this.frameEditorPixelSize, this.frameEditorPixelSize);
        }
    }

    private setFrameEditorCursor(isErasing: boolean) {
        if (!this.frameEditorCanvas) return;
        this.frameEditorCanvas.style.cursor = isErasing ? FRAME_ERASER_CURSOR : FRAME_PAINT_CURSOR;
    }

    private stopFrameEditorEvent(event: Event) {
        event.preventDefault();
        event.stopPropagation();
    }

    private updateBlockDisplayImage() {
        if (!this.blockDisplayImage) return;
        const value = this.getValue();
        const firstFrame = this.resolvedFrames[0] || this.createEmptyFrame(value?.width || this.imgWidth, value?.height || this.imgHeight);
        const canvas = this.renderBitmapToCanvas(firstFrame, value.width, value.height, 1);
        const dataUrl = canvas.toDataURL();
        this.blockDisplayImage.setAttribute('href', dataUrl);
        this.blockDisplayImage.setAttributeNS('http://www.w3.org/1999/xlink', 'href', dataUrl);
    }

    private togglePlayTest() {
        if (this.playTestActive) {
            this.stopPlayTest();
            return;
        }
        this.startPlayTest();
    }

    private startPlayTest() {
        const value = this.getValue();
        if (!this.canPlayTest(value)) {
            this.updatePlayTestButtonState();
            return;
        }

        this.closeFrameEditor(false);
        this.playTestActive = true;
        this.playTestFrameIndex = 0;
        this.updatePlayTestButtonState();
        this.renderPlayTestFrame();
    }

    private stopPlayTest(restorePreview = true) {
        if (this.playTestTimerId !== null) {
            clearTimeout(this.playTestTimerId);
            this.playTestTimerId = null;
        }

        const wasActive = this.playTestActive;
        this.playTestActive = false;
        this.playTestFrameIndex = 0;
        this.updatePlayTestButtonState();

        if (restorePreview && wasActive) {
            this.restorePlayTestPreview();
        }
    }

    private renderPlayTestFrame() {
        if (!this.playTestActive) return;

        const value = this.getValue();
        if (!this.canPlayTest(value)) {
            this.stopPlayTest();
            return;
        }

        const frameIndex = this.playTestFrameIndex % this.resolvedFrames.length;
        const frame = this.resolvedFrames[frameIndex] || this.resolvedFrames[0];
        this.updatePreviewFrame(frame, value.width, value.height, frameIndex, this.resolvedFrames.length);
        this.playTestFrameIndex = (frameIndex + 1) % this.resolvedFrames.length;

        const frameDelayMs = Math.max(1, Math.round(1000 / Math.max(1, value.fps)));
        this.playTestTimerId = setTimeout(() => this.renderPlayTestFrame(), frameDelayMs);
    }

    private canPlayTest(value: U8g2AnimationValue) {
        return this.resolvedFrames.length > 1;
    }

    private updatePreviewFrame(
        frame: number[][],
        width: number,
        height: number,
        frameIndex: number,
        frameCount: number,
    ) {
        if (this.blockDisplayImage) {
            const canvas = this.renderBitmapToCanvas(frame, width, height, 1);
            const dataUrl = canvas.toDataURL();
            this.blockDisplayImage.setAttribute('href', dataUrl);
            this.blockDisplayImage.setAttributeNS('http://www.w3.org/1999/xlink', 'href', dataUrl);
        }

        this.updateFirstFrameStripPreview(frame, width, height, frameIndex, frameCount);
    }

    private updateFirstFrameStripPreview(
        frame: number[][],
        width: number,
        height: number,
        frameIndex: number,
        frameCount: number,
    ) {
        const firstItem = this.getFrameStripItem(0);
        if (!firstItem) return;

        firstItem.classList.add('is-playing');
        const preview = firstItem.querySelector<HTMLElement>('.u8g2AnimationFramePreview');
        const currentCanvas = preview?.querySelector<HTMLCanvasElement>('.u8g2AnimationCanvas');
        const nextCanvas = this.renderBitmapToCanvas(
            frame,
            width,
            height,
            this.getPreviewScale(width, height),
        );
        if (currentCanvas) {
            currentCanvas.replaceWith(nextCanvas);
        } else {
            preview?.prepend(nextCanvas);
        }

        const label = firstItem.querySelector('span');
        if (label) {
            label.textContent = `${frameIndex + 1}/${frameCount}`;
        }
    }

    private restorePlayTestPreview() {
        this.updateBlockDisplayImage();

        const value = this.getValue();
        const firstFrame = this.resolvedFrames[0];
        if (firstFrame) {
            this.updateFrameStripItem(0, firstFrame, value.width, value.height);
        }
    }

    private updatePlayTestButtonState() {
        if (!this.playTestButton) return;

        const label = this.playTestActive
            ? Blockly.Msg['U8G2_ANIMATION_BUTTON_STOP_PLAY_TEST']
            : Blockly.Msg['U8G2_ANIMATION_BUTTON_PLAY_TEST'];
        this.playTestButton.title = this.playTestActive
            ? Blockly.Msg['U8G2_ANIMATION_BUTTON_STOP_PLAY_TEST']
            : Blockly.Msg['U8G2_ANIMATION_PLAY_TEST_TOOLTIP'];
        this.playTestButton.setAttribute('aria-label', label);
        this.playTestButton.setAttribute('aria-pressed', String(this.playTestActive));
        this.playTestButton.disabled = !this.playTestActive && !this.canPlayTest(this.getValue());
        this.playTestButton.classList.toggle('is-active', this.playTestActive);

        const icon = this.playTestButton.querySelector('i');
        if (icon) {
            icon.className = this.playTestActive ? 'fa-light fa-stop' : 'fa-light fa-play';
        }
    }

    private renderBitmapToCanvas(frame: number[][], width: number, height: number, scale: number) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, width * scale);
        canvas.height = Math.max(1, height * scale);
        canvas.className = 'u8g2AnimationCanvas';

        const context = canvas.getContext('2d');
        if (!context) return canvas;

        context.imageSmoothingEnabled = false;
        const imageData = context.createImageData(width, height);
        const filled = this.hexToRgb(this.pixelColours.filled);
        const empty = this.hexToRgb(this.pixelColours.empty);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const targetIndex = (y * width + x) * 4;
                const isFilled = frame[y]?.[x] === 1;
                const color = isFilled ? filled : empty;
                imageData.data[targetIndex] = color.r;
                imageData.data[targetIndex + 1] = color.g;
                imageData.data[targetIndex + 2] = color.b;
                imageData.data[targetIndex + 3] = 255;
            }
        }

        const rawCanvas = document.createElement('canvas');
        rawCanvas.width = width;
        rawCanvas.height = height;
        const rawContext = rawCanvas.getContext('2d');
        rawContext?.putImageData(imageData, 0, 0);
        context.drawImage(rawCanvas, 0, 0, canvas.width, canvas.height);

        return canvas;
    }

    private updateControlsFromValue() {
        if (this.widthInput) this.widthInput.value = String(this.imgWidth);
        if (this.heightInput) this.heightInput.value = String(this.imgHeight);
        if (this.fpsInput) this.fpsInput.value = String(this.fps);
        if (this.maxFramesInput) {
            this.maxFramesInput.max = String(getMaxFramesLimit());
            this.maxFramesInput.value = String(this.maxFrames);
        }
        if (this.thresholdInput) this.thresholdInput.checked = !this.dither;
        if (this.ditherInput) this.ditherInput.checked = this.dither;
        if (this.thresholdValueInput) this.thresholdValueInput.value = String(this.threshold);
        this.updateThresholdValueVisibility();
        this.updateStatusFromValue();
    }

    private updateThresholdValueVisibility() {
        const isThresholdMode = !this.ditherInput?.checked;
        if (this.thresholdValueControl) {
            this.thresholdValueControl.style.display = isThresholdMode ? 'inline-flex' : 'none';
        }
        if (this.thresholdValueInput) {
            this.thresholdValueInput.disabled = !isThresholdMode;
        }
    }

    private updateStatusFromValue() {
        const value = this.getValue();
        if (!this.statusElement) return;
        if (value.frameCount <= 1 && !value.sourceName && !this.hasFramePixels(this.resolvedFrames)) {
            this.setStatus(Blockly.Msg['U8G2_ANIMATION_EMPTY']);
            this.statusElement.classList.remove('is-error');
            return;
        }

        const source = value.sourceName ? `${this.truncateStatusSourceName(value.sourceName)} · ` : '';
        const modeText = value.dither
            ? Blockly.Msg['U8G2_ANIMATION_LABEL_DITHER']
            : `${Blockly.Msg['U8G2_ANIMATION_LABEL_THRESHOLD']} ${value.threshold}`;
        this.setStatus(this.t('STATUS_INFO', {
            sourcePrefix: source,
            frames: value.frameCount,
            width: value.width,
            height: value.height,
            fps: value.fps,
            mode: modeText,
            dataSize: this.formatDataSize(this.getConvertedDataSizeBytes(value)),
        }));
        this.statusElement.classList.remove('is-error');
    }

    private getConvertedDataSizeBytes(value: U8g2AnimationValue) {
        return getFrameByteLength(value.width, value.height) * value.frameCount;
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

    private formatDataSize(bytes: number) {
        if (bytes < 1024) {
            return `${bytes} B`;
        }
        if (bytes < 1024 * 1024) {
            const value = bytes / 1024;
            return `${value < 10 ? value.toFixed(1) : Math.round(value)} KB`;
        }
        const value = bytes / (1024 * 1024);
        return `${value < 10 ? value.toFixed(1) : Math.round(value)} MB`;
    }

    private t(messageName: string, params?: U8g2AnimationI18nParams) {
        return translateU8g2AnimationMessage(messageName, params);
    }

    private resolveWorkerMessage(message: DecodeWorkerMessage, fallbackMessageName: string) {
        if (message.messageKey) {
            return this.t(message.messageKey, message.messageParams);
        }
        return message.message || this.t(fallbackMessageName);
    }

    private setStatus(message: string, isError = false) {
        if (!this.statusElement) return;
        this.statusElement.textContent = message;
        this.statusElement.title = message;
        this.statusElement.classList.toggle('is-error', isError);
    }

    private getPixelSize() {
        return this.fieldHeight / Math.max(1, this.imgHeight);
    }

    private getPreviewScale(width: number, height: number) {
        const maxSide = Math.max(width, height);
        if (maxSide <= 32) return 3.5;
        if (maxSide <= 64) return 2.5;
        return 1.5;
    }

    private getFrameEditorScale(width: number, height: number) {
        const widthScale = Math.floor(FRAME_EDITOR_MAX_WIDTH / Math.max(1, width));
        const heightScale = Math.floor(FRAME_EDITOR_MAX_HEIGHT / Math.max(1, height));
        return Math.max(1, Math.min(8, widthScale, heightScale));
    }

    private clampInput(input: HTMLInputElement, fallback: number) {
        const min = Number(input.min);
        const max = Number(input.max);
        const rawValue = Number(input.value);
        const value = Number.isFinite(rawValue) ? Math.floor(rawValue) : fallback;
        return Math.min(max, Math.max(min, value));
    }

    private resizeFrames(frames: number[][][], width: number, height: number) {
        const sourceFrames = frames.length ? frames : [this.createEmptyFrame(this.imgWidth, this.imgHeight)];
        return sourceFrames.map(frame => {
            const nextFrame: number[][] = [];
            for (let y = 0; y < height; y++) {
                const row: number[] = [];
                for (let x = 0; x < width; x++) {
                    row.push(frame[y]?.[x] === 1 ? 1 : 0);
                }
                nextFrame.push(row);
            }
            return nextFrame;
        });
    }

    private cloneFrame(frame: number[][], width: number, height: number) {
        const cloned: number[][] = [];
        for (let row = 0; row < height; row++) {
            const sourceRow = frame[row] || [];
            cloned.push(Array.from({ length: width }, (_, col) => sourceRow[col] === 1 ? 1 : 0));
        }
        return cloned;
    }

    private framesEqual(left: number[][], right: number[][]) {
        if (left.length !== right.length) return false;
        for (let row = 0; row < left.length; row++) {
            if (left[row].length !== right[row].length) return false;
            for (let col = 0; col < left[row].length; col++) {
                if (left[row][col] !== right[row][col]) return false;
            }
        }
        return true;
    }

    private commitManualFrames(value: U8g2AnimationValue, frames: number[][][], preserveSource = false) {
        this.stopPlayTest(false);
        const nextFrames = frames
            .slice(0, value.maxFrames)
            .map(frame => this.cloneFrame(frame, value.width, value.height));
        this.resolvedFrameRefId = '';
        this.resolvedFrames = nextFrames;
        this.updateBlockDisplayImage();
        this.updateControlsFromValue();
        this.updateStatusFromValue();

        const mutationVersion = ++this.frameMutationVersion;
        const mutation = this.persistManualFrames(value, nextFrames, preserveSource).then((nextValue) => {
            if (mutationVersion !== this.frameMutationVersion) return;
            this.setValue(nextValue, !this.isDropdownOpen());
            this.setResolvedFrames(nextValue.frames, nextFrames);
            this.refreshResolvedFrames();
        });
        projectDataRuntime.trackMutation(mutation);
        void mutation.catch((error) => this.reportProjectDataLoadError(error));
    }

    private async persistManualFrames(
        value: U8g2AnimationValue,
        frames: number[][][],
        preserveSource: boolean,
    ): Promise<U8g2AnimationValue> {
        if (frames.length === 0) {
            return {
                schemaVersion: 1,
                encoding: 'xbm-lsb-row-v1',
                width: value.width,
                height: value.height,
                fps: value.fps,
                maxFrames: value.maxFrames,
                dither: value.dither,
                threshold: value.threshold,
                frameCount: 0,
                frames: null,
                ...(preserveSource ? this.pickSourceMetadata(value) : {}),
            };
        }

        const packedFrames = this.packBitmapFrames(frames, value.width, value.height);
        const ref = await projectDataRuntime.put({
            codec: 'u8g2-xbm-frames-v1',
            storage: 'raw-v1',
            value: packedFrames,
        });
        return {
            schemaVersion: 1,
            encoding: 'xbm-lsb-row-v1',
            width: value.width,
            height: value.height,
            fps: value.fps,
            maxFrames: value.maxFrames,
            dither: value.dither,
            threshold: value.threshold,
            frameCount: frames.length,
            frames: ref,
            ...(preserveSource ? this.pickSourceMetadata(value) : {}),
        };
    }

    private async persistDecodedFrames(
        decoded: DecodedU8g2AnimationValue,
        source: Pick<U8g2AnimationValue, 'sourceName' | 'sourceType' | 'sourcePath'>,
    ): Promise<{ value: U8g2AnimationValue; frames: number[][][] }> {
        if (decoded.schemaVersion !== 1 || decoded.encoding !== 'xbm-lsb-row-v1') {
            throw new Error(this.t('ERROR_DECODE_FAILED'));
        }
        const frameByteLength = getFrameByteLength(decoded.width, decoded.height);
        const encodedFrames = decoded.frames.slice(0, decoded.maxFrames);
        if (encodedFrames.length === 0 || encodedFrames.some((frame) => (
            !(frame instanceof Uint8Array) || frame.byteLength !== frameByteLength
        ))) {
            throw new Error(this.t('ERROR_DECODE_FAILED'));
        }
        const packedFrames = new Uint8Array(frameByteLength * encodedFrames.length);
        encodedFrames.forEach((frame, index) => packedFrames.set(frame, index * frameByteLength));
        const ref = await projectDataRuntime.put({
            codec: 'u8g2-xbm-frames-v1',
            storage: 'raw-v1',
            value: packedFrames,
        });
        return {
            value: {
                schemaVersion: 1,
                encoding: 'xbm-lsb-row-v1',
                width: decoded.width,
                height: decoded.height,
                fps: decoded.fps,
                maxFrames: decoded.maxFrames,
                dither: decoded.dither,
                threshold: decoded.threshold,
                frameCount: encodedFrames.length,
                frames: ref,
                ...source,
            },
            frames: encodedFrames.map(frame => this.xbmToBitmap(frame, decoded.width, decoded.height)),
        };
    }

    async ensureFramesLoaded(): Promise<number[][][]> {
        const value = this.getValue();
        const ref = value.frames;
        if (!ref || value.frameCount === 0) {
            const frames = [this.createEmptyFrame(value.width, value.height)];
            this.setResolvedFrames(null, frames);
            this.refreshResolvedFrames();
            return frames;
        }
        const refId = ref.$ailyData.id;
        if (this.resolvedFrameRefId === refId && this.resolvedFrames.length === value.frameCount) {
            return this.resolvedFrames;
        }
        if (this.loadingFrames) return this.loadingFrames;

        const loading = projectDataRuntime.resolve<Uint8Array>(ref).then((packedFrames) => {
            const current = this.getValue();
            if (current.frames?.$ailyData.id !== refId) return [];
            const frameByteLength = getFrameByteLength(current.width, current.height);
            const expectedLength = frameByteLength * current.frameCount;
            if (!(packedFrames instanceof Uint8Array) || packedFrames.byteLength !== expectedLength) {
                throw new Error(`expected ${expectedLength} bytes, received ${packedFrames.byteLength}`);
            }
            const frames = Array.from({ length: current.frameCount }, (_, index) => this.xbmToBitmap(
                packedFrames.subarray(index * frameByteLength, (index + 1) * frameByteLength),
                current.width,
                current.height,
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

    private setResolvedFrames(ref: AilyDataRef | null, frames: number[][][]) {
        this.resolvedFrameRefId = ref?.$ailyData.id || '';
        this.resolvedFrames = frames;
    }

    private refreshResolvedFrames() {
        this.updateBlockDisplayImage();
        this.renderFrameStrip();
        this.updateControlsFromValue();
        this.updatePlayTestButtonState();
    }

    private reportProjectDataLoadError(error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus(this.t('ERROR_PROJECT_DATA_LOAD_FAILED', { message }), true);
    }

    private packBitmapFrames(frames: number[][][], width: number, height: number) {
        const frameByteLength = getFrameByteLength(width, height);
        const bytesPerRow = Math.ceil(width / 8);
        const packed = new Uint8Array(frameByteLength * frames.length);
        frames.forEach((frame, frameIndex) => {
            const frameOffset = frameIndex * frameByteLength;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    if (frame[y]?.[x] === 1) {
                        packed[frameOffset + y * bytesPerRow + Math.floor(x / 8)] |= 1 << (x % 8);
                    }
                }
            }
        });
        return packed;
    }

    private xbmToBitmap(bytes: Uint8Array, width: number, height: number) {
        const bytesPerRow = Math.ceil(width / 8);
        return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => (
            (bytes[y * bytesPerRow + Math.floor(x / 8)] & (1 << (x % 8))) !== 0 ? 1 : 0
        )));
    }

    private pickSourceMetadata(value: U8g2AnimationValue) {
        return {
            sourceName: value.sourceName,
            sourceType: value.sourceType,
            sourcePath: value.sourcePath,
        };
    }

    private createEmptyValue(config?: FieldU8g2AnimationFromJsonConfig): U8g2AnimationValue {
        const width = this.normalizeNumber(config?.width, DEFAULT_WIDTH, 1, 256);
        const height = this.normalizeNumber(config?.height, DEFAULT_HEIGHT, 1, 128);
        const fps = this.normalizeNumber(config?.fps, DEFAULT_FPS, 1, MAX_FPS);
        const maxFrames = this.normalizeNumber(config?.maxFrames, getDefaultMaxFrames(fps), 1, getMaxFramesLimit());
        const threshold = this.normalizeNumber(config?.threshold, DEFAULT_THRESHOLD, 0, 255);
        return {
            schemaVersion: 1,
            encoding: 'xbm-lsb-row-v1',
            width,
            height,
            fps,
            maxFrames,
            dither: !!config?.dither,
            threshold,
            frameCount: 0,
            frames: null,
        };
    }

    private createEmptyFrame(width: number, height: number) {
        const frame: number[][] = [];
        for (let y = 0; y < height; y++) {
            frame.push(Array.from({ length: width }, () => 0));
        }
        return frame;
    }

    private normalizeValue(
        value?: U8g2AnimationValue | null,
        config?: FieldU8g2AnimationFromJsonConfig,
    ): U8g2AnimationValue {
        const fallback = this.createEmptyValue(config);
        if (!value || typeof value !== 'object') return fallback;
        if (value.schemaVersion !== 1 || value.encoding !== 'xbm-lsb-row-v1') return fallback;

        const width = this.normalizeNumber(value.width, fallback.width, 1, 256);
        const height = this.normalizeNumber(value.height, fallback.height, 1, 128);
        const fps = this.normalizeNumber(value.fps, fallback.fps, 1, MAX_FPS);
        const maxFrames = this.normalizeNumber(value.maxFrames, fallback.maxFrames, 1, getMaxFramesLimit());
        const dither = typeof value.dither === 'boolean' ? value.dither : fallback.dither;
        const threshold = this.normalizeNumber(value.threshold, fallback.threshold, 0, 255);
        let frameCount = this.normalizeNumber(value.frameCount, 0, 0, maxFrames);
        const expectedRawLength = getFrameByteLength(width, height) * frameCount;
        const frames = frameCount > 0
            && isAilyDataRef(value.frames)
            && value.frames.$ailyData.logicalType === 'binary'
            && value.frames.$ailyData.codec === 'u8g2-xbm-frames-v1'
            && value.frames.$ailyData.rawLength === expectedRawLength
            ? value.frames
            : null;
        if (!frames) frameCount = 0;

        return {
            schemaVersion: 1,
            encoding: 'xbm-lsb-row-v1',
            width,
            height,
            fps,
            maxFrames,
            dither,
            threshold,
            frameCount,
            frames,
            sourceName: value.sourceName,
            sourceType: value.sourceType,
            sourcePath: value.sourcePath,
        };
    }

    private normalizeNumber(value: unknown, fallback: number, min: number, max: number) {
        const numberValue = Number(value);
        if (!Number.isFinite(numberValue)) return fallback;
        return Math.min(max, Math.max(min, Math.floor(numberValue)));
    }

    private hasFramePixels(frames: number[][][]) {
        return frames.some(frame => frame.some(row => row.some(cell => cell === 1)));
    }

    private cloneValue(value: U8g2AnimationValue | null): U8g2AnimationValue {
        const normalized = this.normalizeValue(value);
        return {
            ...normalized,
            frames: normalized.frames
                ? { $ailyData: { ...normalized.frames.$ailyData } }
                : null,
        };
    }

    private valuesEqual(left: U8g2AnimationValue | null, right: U8g2AnimationValue | null) {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    private rerenderSourceBlock() {
        const sourceBlock = this.getSourceBlock();
        if (!(sourceBlock instanceof Blockly.BlockSvg) || this.sourceBlockRenderScheduled) {
            return;
        }

        const rootBlock = typeof sourceBlock.getRootBlock === 'function'
            ? sourceBlock.getRootBlock()
            : sourceBlock;
        const blockToRender = rootBlock instanceof Blockly.BlockSvg ? rootBlock : sourceBlock;
        if (!blockToRender.rendered) {
            return;
        }

        this.sourceBlockRenderScheduled = true;
        const renderBlock = () => {
            this.sourceBlockRenderScheduled = false;
            if (blockToRender.rendered) {
                blockToRender.render();
            }
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(renderBlock);
        } else {
            Promise.resolve().then(renderBlock);
        }
    }

    private rerenderSourceBlockAfterResize() {
        this.rerenderSourceBlock();
        if (this.isDropdownOpen()) {
            Blockly.DropDownDiv.showPositionedByField(
                this,
                this.dropdownDispose.bind(this),
            );
        }
    }

    private isDropdownOpen() {
        return Blockly.DropDownDiv.getOwner() === this;
    }

    private dropdownDispose() {
        this.commitParameterInputChange();
        this.closeFrameEditor();
        this.stopPlayTest(false);
        this.cancelFrameStripRender();

        if (
            this.getSourceBlock() &&
            this.initialValue !== null &&
            !this.valuesEqual(this.initialValue, this.getValue())
        ) {
            Blockly.Events.fire(
                new (Blockly.Events.get(Blockly.Events.BLOCK_CHANGE))(
                    this.sourceBlock_,
                    'field',
                    this.name || null,
                    this.initialValue,
                    this.getValue(),
                ),
            );
            this.rerenderSourceBlock();
        }

        for (const event of this.boundEvents) {
            Blockly.browserEvents.unbind(event);
        }
        this.boundEvents.length = 0;
        this.frameStrip = null;
        this.statusElement = null;
        this.fileInput = null;
        this.playTestButton = null;
        this.widthInput = null;
        this.heightInput = null;
        this.fpsInput = null;
        this.maxFramesInput = null;
        this.thresholdInput = null;
        this.ditherInput = null;
        this.thresholdValueControl = null;
        this.thresholdValueInput = null;
        this.frameEditor = null;
        this.frameEditorTitle = null;
        this.frameEditorCanvas = null;
        this.frameEditorContext = null;
        this.editingFrameIndex = null;
        this.editingFrameDraft = null;
        this.frameEditorPointerIsDown = false;
        this.frameEditorPaintValue = undefined;
        this.frameEditorLastRow = -1;
        this.frameEditorLastCol = -1;
        this.initialValue = null;

        Blockly.DropDownDiv.getContentDiv().classList.remove(
            'contains-u8g2-animation-editor',
            'ailyMediaFieldDropdown',
        );
    }

    private terminateWorker() {
        if (this.decodeWorker) {
            this.decodeWorker.terminate();
            this.decodeWorker = null;
        }
    }

    private createElementWithClassname(elementType: string, className: string) {
        const newElement = document.createElement(elementType);
        newElement.className = className;
        return newElement;
    }

    private bindEvent(
        element: EventTarget,
        eventName: string,
        callback: (event: Event) => void,
    ) {
        this.boundEvents.push(
            Blockly.browserEvents.bind(element, eventName, this, callback),
        );
    }

    private hexToRgb(hex: string): { r: number; g: number; b: number } {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16),
        } : { r: 0, g: 0, b: 0 };
    }
}

Blockly.fieldRegistry.register('field_u8g2_animation', FieldU8g2Animation);

Blockly.Css.register(`
.u8g2AnimationEditor {
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
.u8g2AnimationToolbar {
  align-items: center;
  display: flex;
  flex-wrap: nowrap;
  gap: 8px;
  justify-content: space-between;
  max-width: 100%;
  width: max-content;
}
.u8g2AnimationControlGroup,
.u8g2AnimationButtonGroup {
  align-items: center;
  display: inline-flex;
  flex-wrap: nowrap;
  gap: 6px;
}
.u8g2AnimationButtonGroup {
  margin-left: auto;
}
.u8g2AnimationNumberControl {
  align-items: center;
  display: inline-flex;
  gap: 4px;
}
.u8g2AnimationModeControl {
  align-items: center;
  display: inline-flex;
  gap: 4px;
}
.u8g2AnimationThresholdValueControl {
  align-items: center;
  display: inline-flex;
}
.u8g2AnimationNumberControl span,
.u8g2AnimationModeControl span {
  color: #e8e8e8;
  font-size: 12px;
  line-height: 1;
}
.u8g2AnimationNumberInput {
  background: #fff;
  border: 1px solid #777;
  border-radius: 4px;
  color: #222;
  font-size: 12px;
  height: 26px;
  padding: 0 4px;
  text-align: center;
  width: 48px;
}
.u8g2AnimationButton {
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
.u8g2AnimationModeInput {
  accent-color: var(--aily-color-accent, #4db6ac);
  height: 16px;
  margin: 0;
  width: 16px;
}
.u8g2AnimationThresholdValueInput {
  background: #fff;
  border: 1px solid #777;
  border-radius: 4px;
  color: #222;
  font-size: 12px;
  height: 26px;
  padding: 0 4px;
  text-align: center;
  width: 48px;
}
.u8g2AnimationButton:hover {
  background: #444;
  border-color: #888;
}
.u8g2AnimationButton:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.u8g2AnimationStatus {
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
.u8g2AnimationStatus.is-error {
  color: #ffb3b3;
}
.u8g2AnimationFrameEditorModal {
  align-items: center;
  background: var(--aily-bg-overlay, rgba(0, 0, 0, 0.46));
  box-sizing: border-box;
  display: flex;
  inset: 0;
  justify-content: center;
  padding: 24px;
  position: fixed;
  z-index: 100001;
}
.u8g2AnimationFrameEditorModal.is-hidden {
  display: none;
}
.u8g2AnimationFrameEditor {
  background: var(--aily-bg-elevated, #1b1b1b);
  border: 1px solid var(--aily-border-input, #666);
  border-radius: 6px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.42);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: min(88vh, 560px);
  max-width: min(92vw, 620px);
  padding: 10px;
  width: max-content;
}
.u8g2AnimationFrameEditorHeader {
  align-items: center;
  display: flex;
  justify-content: space-between;
  min-height: 24px;
}
.u8g2AnimationFrameEditorTitle {
  color: var(--aily-text-primary, #e8e8e8);
  font-size: 12px;
  line-height: 1;
}
.u8g2AnimationFrameEditorActions {
  display: inline-flex;
  gap: 6px;
}
.u8g2AnimationFrameEditorButton {
  align-items: center;
  background: var(--aily-bg-secondary, #333);
  border: 1px solid var(--aily-border-input, #666);
  border-radius: 4px;
  color: var(--aily-text-primary, #fff);
  cursor: pointer;
  display: inline-flex;
  height: 24px;
  justify-content: center;
  margin: 0;
  padding: 0;
  width: 24px;
}
.u8g2AnimationFrameEditorButton:hover {
  background: var(--aily-bg-hover, #444);
  border-color: var(--aily-color-accent, #888);
}
.u8g2AnimationFrameEditorSave:hover {
  background: var(--aily-color-accent, #4db6ac);
  border-color: var(--aily-color-accent, #73d8d0);
  color: var(--aily-bg-primary, #111);
}
.u8g2AnimationFrameEditorCancel:hover {
  background: var(--aily-bg-hover, #4a4a4a);
  border-color: var(--aily-text-tertiary, #aaa);
}
.u8g2AnimationFrameEditorCanvasWrap {
  align-self: center;
  background: var(--aily-bg-input, #111);
  border: 1px solid var(--aily-border-input, #444);
  max-height: min(66vh, 420px);
  max-width: min(86vw, 560px);
  overflow: auto;
  scrollbar-color: var(--aily-border-tertiary, #666) transparent;
  scrollbar-width: thin;
}
.u8g2AnimationFrameEditorCanvasWrap::-webkit-scrollbar {
  height: 4px;
  width: 4px;
}
.u8g2AnimationFrameEditorCanvasWrap::-webkit-scrollbar-track {
  background: transparent;
}
.u8g2AnimationFrameEditorCanvasWrap::-webkit-scrollbar-thumb {
  background: var(--aily-border-tertiary, #666);
  border-radius: 2px;
}
.u8g2AnimationFrameEditorCanvas {
  background: #151515;
  display: block;
  image-rendering: pixelated;
  touch-action: none;
}
.u8g2AnimationFrameEditorHint {
  color: var(--aily-text-tertiary, #cfcfcf);
  font-size: 12px;
  line-height: 1;
  text-align: center;
  white-space: nowrap;
}
.u8g2AnimationFrameStrip {
  align-items: flex-start;
  background: var(--aily-bg-elevated, #1b1b1b);
  border: 1px solid var(--aily-border-input, #666);
  border-radius: 4px;
  box-sizing: border-box;
  display: flex;
  gap: 8px;
  max-height: 360px;
  max-width: 100%;
  min-width: 0;
  overflow-x: scroll;
  padding: 8px 8px 0 8px;
  scrollbar-color: var(--aily-border-tertiary, #666) transparent;
  scrollbar-width: thin;
  width: 100%;
}
.u8g2AnimationFrameStrip::-webkit-scrollbar {
  height: 4px;
  width: 4px;
}
.u8g2AnimationFrameStrip::-webkit-scrollbar-track {
  background: transparent;
}
.u8g2AnimationFrameStrip::-webkit-scrollbar-thumb {
  background: var(--aily-border-tertiary, #666);
  border-radius: 2px;
}
.u8g2AnimationFrameStrip::-webkit-scrollbar-thumb:hover {
  background: var(--aily-scrollbar-thumb-hover, #888);
}
.u8g2AnimationFrameLoading {
  align-items: center;
  color: var(--aily-text-tertiary, #cfcfcf);
  display: inline-flex;
  flex: 0 0 auto;
  font-size: 12px;
  min-height: 72px;
}
.u8g2AnimationFrameItem {
  align-items: center;
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
}
.u8g2AnimationFramePreview {
  line-height: 0;
  position: relative;
}
.u8g2AnimationFrameActions {
  bottom: 4px;
  display: inline-flex;
  gap: 4px;
  opacity: 0;
  pointer-events: none;
  position: absolute;
  right: 4px;
  transition: opacity 120ms ease;
}
.u8g2AnimationFramePreview:hover .u8g2AnimationFrameActions,
.u8g2AnimationFramePreview:focus-within .u8g2AnimationFrameActions {
  opacity: 1;
  pointer-events: auto;
}
.u8g2AnimationFrameAction {
  align-items: center;
  background: color-mix(in srgb, var(--aily-bg-secondary, #232323) 92%, transparent);
  border: 1px solid var(--aily-border-input, rgba(255, 255, 255, 0.28));
  border-radius: 4px;
  color: var(--aily-text-primary, #fff);
  cursor: pointer;
  display: inline-flex;
  height: 22px;
  justify-content: center;
  margin: 0;
  padding: 0;
  width: 22px;
}
.u8g2AnimationFrameAction:hover {
  background: var(--aily-color-accent, #4db6ac);
  border-color: var(--aily-color-accent, #73d8d0);
  color: var(--aily-bg-primary, #111);
}
.u8g2AnimationFrameAction:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.u8g2AnimationFrameAction:disabled:hover {
  background: color-mix(in srgb, var(--aily-bg-secondary, #232323) 92%, transparent);
  border-color: var(--aily-border-input, rgba(255, 255, 255, 0.28));
  color: var(--aily-text-primary, #fff);
}
.u8g2AnimationFrameAction.is-active {
  background: var(--aily-color-warning, #f4c542);
  border-color: var(--aily-color-warning, #ffe27a);
  color: var(--aily-bg-primary, #111);
}
.u8g2AnimationFrameAction i,
.u8g2AnimationFrameEditorButton i {
  font-size: 12px;
  line-height: 1;
}
.u8g2AnimationFrameItem.is-editing .u8g2AnimationCanvas {
  border-color: var(--aily-color-accent, #4db6ac);
  box-shadow: 0 0 0 1px var(--aily-color-accent, #4db6ac);
}
.u8g2AnimationFrameItem.is-playing .u8g2AnimationCanvas {
  border-color: var(--aily-color-warning, #f4c542);
  box-shadow: 0 0 0 1px var(--aily-color-warning, #f4c542);
}
.u8g2AnimationFrameItem span,
.u8g2AnimationEmpty {
  color: var(--aily-text-tertiary, #cfcfcf);
  font-size: 12px;
}
.u8g2AnimationCanvas {
  background: #151515;
  border: 1px solid #444;
  display: block;
  image-rendering: pixelated;
}
.blocklyDropDownContent.contains-u8g2-animation-editor {
  background: #2a2a2a;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  max-height: none;
}
`);
