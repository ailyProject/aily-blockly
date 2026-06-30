/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as Blockly from 'blockly/core';
import { BitmapUploadRequest, GlobalServiceManager } from '../../../services/bitmap-upload.service';

Blockly.Msg['BUTTON_LABEL_CLEAR'] = 'Clear';
Blockly.Msg['BUTTON_LABEL_UPLOAD'] = 'Upload';
Blockly.Msg['BITMAP_U8G2_HINT_MOUSE'] = '鼠标左键绘制，右键擦除';

export const DEFAULT_HEIGHT = 128;
export const DEFAULT_WIDTH = 64;
const DEFAULT_PIXEL_SIZE = 2;
const DEFAULT_PIXEL_COLOURS: PixelColours = {
    empty: '#151515',
    filled: '#363d80',
};
const DEFAULT_BUTTONS: Buttons = {
    upload: true,
    clear: true,
};
const ERASER_RADIUS = 1;
const PAINT_CURSOR = createSvgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M18 2.5 21.5 6 10.8 16.7l-4.5 1 1-4.5L18 2.5Z" fill="#f5f5f5" stroke="#1a1a1a" stroke-width="1.5" stroke-linejoin="round"/><path d="m5.6 18.1 5.2-1.4L7.5 22H3l2.6-3.9Z" fill="#363d80" stroke="#1a1a1a" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
    5,
    21,
    'crosshair',
);
const ERASER_CURSOR = createSvgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g transform="rotate(-45 12 12)"><rect x="4" y="8" width="16" height="9" rx="2" fill="#f5f5f5" stroke="#1a1a1a" stroke-width="1.5"/><path d="M12 8v9" stroke="#1a1a1a" stroke-width="1.2"/><rect x="5.5" y="9.5" width="5" height="6" rx="1" fill="#ff8da1"/></g></svg>`,
    12,
    12,
    'cell',
);

function createSvgCursor(svg: string, hotX: number, hotY: number, fallback: string) {
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotX} ${hotY}, ${fallback}`;
}
/**
 * Field for inputting a small bitmap image.
 * Includes a grid of clickable pixels that's exported as a bitmap.
 */
export class FieldBitmapU8g2 extends Blockly.Field<number[][]> {
    private initialValue: number[][] | null = null;
    private imgHeight: number;
    private imgWidth: number;
    private globalServiceManager: GlobalServiceManager;
      // 为每个字段实例生成唯一ID
    private fieldId: string;
    
    // 存储订阅以便清理
    private uploadResponseSubscription: any = null;

    // 添加输入框的引用作为类属性
    private widthInput: HTMLInputElement | null = null;
    private heightInput: HTMLInputElement | null = null;

    /**
     * Array holding info needed to unbind events.
     * Used for disposing.
     */
    private boundEvents: Blockly.browserEvents.Data[] = [];    /** References to UI elements */
    private editorCanvas: HTMLCanvasElement | null = null;
    private editorContext: CanvasRenderingContext2D | null = null;
    private blockPreviewCanvas: HTMLCanvasElement | null = null;
    private blockPreviewContext: CanvasRenderingContext2D | null = null;
    private blockDisplayImage: SVGImageElement | null = null;    /** Stateful variables */
    private pointerIsDown = false;
    private valToPaintWith?: number;
    private lastPaintedRow: number = -1;
    private lastPaintedCol: number = -1;
    private pendingUpdates: Set<string> = new Set();
    private updateTimer: number | null = null;
    private skipNextEditorRender = false;
    buttonOptions: Buttons;
    pixelSize: number;
    pixelColours: { empty: string; filled: string };
    private emptyColour: RgbColour;
    private filledColour: RgbColour;
    fieldHeight?: number;

    /**
     * Constructor for the bitmap field.
     *
     * @param value 2D rectangular array of 1s and 0s.
     * @param validator A function that is called to validate.
     * @param config Config A map of options used to configure the field.
     */    constructor(
        value: number[][] | typeof Blockly.Field.SKIP_SETUP,
        validator?: Blockly.FieldValidator<number[][]>,
        config?: FieldBitmapFromJsonConfig,
    ) {
        super(value, validator, config); this.SERIALIZABLE = true;
        // this.CURSOR = 'default';
        this.buttonOptions = { ...DEFAULT_BUTTONS, ...config?.buttons };
        this.pixelColours = { ...DEFAULT_PIXEL_COLOURS, ...config?.colours };
        this.emptyColour = this.hexToRgb(this.pixelColours.empty);
        this.filledColour = this.hexToRgb(this.pixelColours.filled);
        
        // 生成更加唯一的ID，包含更多随机性和时间戳
        this.fieldId = 'field_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9) + '_' + Math.floor(Math.random() * 1000000);
          // Initialize global service manager
        this.globalServiceManager = GlobalServiceManager.getInstance();

        // 延迟设置上传响应处理器，确保字段完全初始化
        setTimeout(() => {
            this.setupUploadResponseHandler();
        }, 0);

        // Configure value, height, and width
        const currentValue = this.getValue();
        if (currentValue !== null) {
            this.imgHeight = currentValue.length;
            this.imgWidth = currentValue[0].length || 0;
        } else {
            this.imgHeight = config?.height ?? DEFAULT_HEIGHT;
            this.imgWidth = config?.width ?? DEFAULT_WIDTH;
            // Set a default empty value
            this.setValue(this.getEmptyArray());
        }
        this.fieldHeight = config?.fieldHeight;
        if (this.fieldHeight) {
            this.pixelSize = this.fieldHeight / this.imgHeight;
        } else {
            this.pixelSize = DEFAULT_PIXEL_SIZE;
        }
    }

    /**
     * Constructs a FieldBitmap from a JSON arg object.
     *
     * @param options A JSON object with options.
     * @returns The new field instance.
     */
    static override fromJson(options: FieldBitmapFromJsonConfig) {
        // `this` might be a subclass of FieldBitmap if that class doesn't override the static fromJson method.
        return new this(
            options.value ?? Blockly.Field.SKIP_SETUP,
            undefined,
            options,
        );
    }

    /**
     * Returns the width of the image in pixels.
     *
     * @returns The width in pixels.
     */
    getImageWidth() {
        return this.imgWidth;
    }

    /**
     * Returns the height of the image in pixels.
     *
     * @returns The height in pixels.
     */
    getImageHeight() {
        return this.imgHeight;
    }

    /**
     * Validates that a new value meets the requirements for a valid bitmap array.
     *
     * @param newValue The new value to be tested.
     * @returns The new value if it's valid, or null.
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention
    protected override doClassValidation_(
        newValue: number[][],
    ): number[][] | null | undefined;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    protected override doClassValidation_(
        newValue?: number[][],
    ): number[][] | null;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    protected override doClassValidation_(
        newValue?: number[][],
    ): number[][] | null | undefined {
        if (!newValue) {
            return null;
        }
        // Check if the new value is an array
        if (!Array.isArray(newValue)) {
            return null;
        }
        const newHeight = newValue.length;
        // The empty list is not an acceptable bitmap
        if (newHeight == 0) {
            return null;
        }

        // Check that the width matches the existing width of the image if it
        // already has a value.
        const newWidth = newValue[0].length;
        for (const row of newValue) {
            if (!Array.isArray(row)) {
                return null;
            }
            if (row.length !== newWidth) {
                return null;
            }
        }

        // Check if all contents of the arrays are either 0 or 1
        for (const row of newValue) {
            for (const cell of row) {
                if (cell !== 0 && cell !== 1) {
                    return null;
                }
            }
        }
        return newValue;
    }

    /**
     * Called when a new value has been validated and is about to be set.
     *
     * @param newValue The value that's about to be set.
     */
    // eslint-disable-next-line
    protected override doValueUpdate_(newValue: number[][]) {
        const newHeight = newValue.length;
        const newWidth = newValue[0] ? newValue[0].length : 0;
        const dimensionsChanged = this.imgHeight !== newHeight || this.imgWidth !== newWidth;

        this.value_ = newValue;
        this.imgHeight = newHeight;
        this.imgWidth = newWidth;
        this.refreshPixelSize();

        if (dimensionsChanged) {
            this.resizeEditorCanvas();
            this.updateSize_();
            this.rerenderSourceBlockAfterResize();
        }

        if (this.skipNextEditorRender) {
            this.skipNextEditorRender = false;
        } else {
            this.renderCanvasEditor();
        }
        this.updateBlockDisplayImage();
        this.updateControlsFromValue();
    }

    /**
     * Show the bitmap editor dialog.
     *
     * @param e Optional mouse event that triggered the field to open, or
     *    undefined if triggered programmatically.
     */
    // eslint-disable-next-line
    protected override showEditor_(e?: Event) {
        const editor = this.dropdownCreate();
        Blockly.DropDownDiv.getContentDiv().appendChild(editor);
        Blockly.DropDownDiv.showPositionedByField(
            this,
            this.dropdownDispose.bind(this),
        );
    }

    /**
     * Updates the block display and editor dropdown when the field re-renders.
     */
    // eslint-disable-next-line
    protected override render_() {
        super.render_();

        if (!this.getValue()) {
            return;
        }

        // 更新block显示的图片
        if (this.blockDisplayImage) {
            this.updateBlockDisplayImage();
        }

        // 更新canvas编辑器（如果存在）
        if (this.editorCanvas && this.editorContext) {
            this.renderCanvasEditor();
        }
    }

    /**
     * Determines whether the field is editable.
     *
     * @returns True since it is always editable.
     */
    override updateEditable() {
        const editable = super.updateEditable();
        // Blockly.Field's implementation sets these classes as appropriate, but
        // since this field has no text they just mess up the rendering of the grid
        // lines.
        const svgRoot = this.getSvgRoot();
        if (svgRoot) {
            Blockly.utils.dom.removeClass(svgRoot, 'blocklyNonEditableText');
            Blockly.utils.dom.removeClass(svgRoot, 'blocklyEditableText');
        }
        return editable;
    }

    /**
     * Gets the rectangle built out of dimensions matching SVG's <g> element.
     *
     * @returns The newly created rectangle of same size as the SVG element.
     */
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

    /**
     * Creates the bitmap editor and add event listeners.
     *
     * @returns The newly created dropdown menu.
     */
    private dropdownCreate() {
        const dropdownEditor = this.createElementWithClassname(
            'div',
            'dropdownEditor-u8g2',
        );
        this.bindEditorContainerEvents(dropdownEditor);

        const toolbar = this.createToolbar();
        dropdownEditor.appendChild(toolbar);

        const canvasContainer = this.createElementWithClassname(
            'div',
            'canvasContainer-u8g2',
        );
        this.editorCanvas = document.createElement('canvas');
        this.editorCanvas.className = 'bitmapCanvas-u8g2';
        this.setCanvasCursor(false);
        canvasContainer.appendChild(this.editorCanvas);
        dropdownEditor.appendChild(canvasContainer);

        const mouseHint = this.createElementWithClassname('div', 'hint-u8g2');
        mouseHint.textContent = Blockly.Msg['BITMAP_U8G2_HINT_MOUSE'];
        dropdownEditor.appendChild(mouseHint);

        this.editorContext = this.editorCanvas.getContext('2d');
        if (!this.editorContext) {
            throw new Error('无法获取canvas 2d context');
        }

        // This prevents the normal max-height from adding a scroll bar for large images.
        Blockly.DropDownDiv.getContentDiv().classList.add('contains-bitmap-editor-u8g2');

        this.bindCanvasEvents();
        this.resizeEditorCanvas();
        this.renderCanvasEditor();
        this.updateControlsFromValue();

        // Store the initial value at the start of the edit.
        this.initialValue = this.cloneBitmap(this.getValue());

        return dropdownEditor;
    }

    /**
     * Initializes the on-block display.
     */
    override initView() {
        // 创建SVG图片元素来显示bitmap
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

        // 初始渲染
        this.updateBlockDisplayImage();
    }

    /**
     * Updates the size of the block based on the size of the underlying image.
     */
    // eslint-disable-next-line
    protected override updateSize_() {
        {
            const newWidth = this.pixelSize * this.imgWidth;
            const newHeight = this.pixelSize * this.imgHeight;
            if (this.borderRect_) {
                this.borderRect_.setAttribute('width', String(newWidth));
                this.borderRect_.setAttribute('height', String(newHeight));
            }

            // Update the block display image size
            if (this.blockDisplayImage) {
                this.blockDisplayImage.setAttribute('width', String(newWidth));
                this.blockDisplayImage.setAttribute('height', String(newHeight));
            }

            this.size_.width = newWidth;
            this.size_.height = newHeight;
        }
    }

    private refreshPixelSize() {
        if (this.fieldHeight) {
            this.pixelSize = this.fieldHeight / this.imgHeight;
        } else {
            this.pixelSize = DEFAULT_PIXEL_SIZE;
        }
    }

    private resizeEditorCanvas() {
        if (!this.editorCanvas) return;

        this.editorCanvas.width = this.imgWidth * this.pixelSize;
        this.editorCanvas.height = this.imgHeight * this.pixelSize;
    }

    private bindEditorContainerEvents(dropdownEditor: HTMLElement) {
        const stopEventPropagation = (e: Event) => e.stopPropagation();
        const stopContextMenu = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
        };

        this.bindEvent(dropdownEditor, 'pointerdown', stopEventPropagation);
        this.bindEvent(dropdownEditor, 'pointermove', stopEventPropagation);
        this.bindEvent(dropdownEditor, 'pointerup', stopEventPropagation);
        this.bindEvent(dropdownEditor, 'mousedown', stopEventPropagation);
        this.bindEvent(dropdownEditor, 'mousemove', stopEventPropagation);
        this.bindEvent(dropdownEditor, 'mouseup', stopEventPropagation);
        this.bindEvent(dropdownEditor, 'click', stopEventPropagation);
        this.bindEvent(dropdownEditor, 'dblclick', stopEventPropagation);
        this.bindEvent(dropdownEditor, 'touchstart', stopEventPropagation);
        this.bindEvent(dropdownEditor, 'touchmove', stopEventPropagation);
        this.bindEvent(dropdownEditor, 'touchend', stopEventPropagation);
        this.bindEvent(dropdownEditor, 'contextmenu', stopContextMenu);
    }

    private createToolbar() {
        const toolbar = this.createElementWithClassname('div', 'toolbar-u8g2');

        const dimensionGroup = this.createElementWithClassname('div', 'dimensionGroup-u8g2');
        this.widthInput = this.createDimensionInput('W', this.imgWidth, 1, 256);
        this.heightInput = this.createDimensionInput('H', this.imgHeight, 1, 128);
        this.bindDimensionInputEvents(this.widthInput);
        this.bindDimensionInputEvents(this.heightInput);
        dimensionGroup.appendChild(this.createDimensionControl('W', this.widthInput));
        dimensionGroup.appendChild(this.createDimensionControl('H', this.heightInput));
        toolbar.appendChild(dimensionGroup);

        const rightControls = this.createElementWithClassname('div', 'rightControls-u8g2');
        const actionGroup = this.createElementWithClassname('div', 'buttonGroup-u8g2');
        if (this.buttonOptions.upload) {
            this.addControlButton(
                actionGroup,
                Blockly.Msg['BUTTON_LABEL_UPLOAD'],
                this.uploadBitmap.bind(this),
            );
        }
        if (this.buttonOptions.clear) {
            this.addControlButton(
                actionGroup,
                Blockly.Msg['BUTTON_LABEL_CLEAR'],
                this.clearPixels.bind(this),
            );
        }
        rightControls.appendChild(actionGroup);
        toolbar.appendChild(rightControls);

        return toolbar;
    }

    private createLabel(text: string) {
        const label = document.createElement('span');
        label.className = 'label-u8g2';
        label.textContent = text;
        return label;
    }

    private createDimensionInput(
        ariaLabel: string,
        value: number,
        min: number,
        max: number,
    ) {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'dimensionInput-u8g2';
        input.min = String(min);
        input.max = String(max);
        input.value = String(value);
        input.setAttribute('aria-label', ariaLabel);
        return input;
    }

    private createDimensionControl(labelText: string, input: HTMLInputElement) {
        const control = this.createElementWithClassname('label', 'dimensionControl-u8g2');
        control.appendChild(this.createLabel(labelText));
        control.appendChild(input);
        return control;
    }

    /**
     * Create control button.
     *
     * @param parent Parent HTML element to which control button will be added.
     * @param buttonText Text of the control button.
     * @param onClick Callback that will be attached to the control button.
     */
    private addControlButton(
        parent: HTMLElement,
        buttonText: string,
        onClick: (e?: Event) => void,
    ) {
        const button = this.createElementWithClassname('button', 'controlButton-u8g2');
        button.innerText = buttonText;
        parent.appendChild(button);
        this.bindEvent(button, 'click', onClick);
        return button;
    }

    private bindDimensionInputEvents(input: HTMLInputElement) {
        this.bindEvent(input, 'input', this.onDimensionInputChange.bind(this));
        this.bindEvent(input, 'change', this.onDimensionInputChange.bind(this));
    }

    private onDimensionInputChange() {
        if (!this.widthInput || !this.heightInput) return;
        if (this.widthInput.value === '' || this.heightInput.value === '') return;

        const newWidth = this.clampDimension(
            Number(this.widthInput.value),
            Number(this.widthInput.min),
            Number(this.widthInput.max),
        );
        const newHeight = this.clampDimension(
            Number(this.heightInput.value),
            Number(this.heightInput.min),
            Number(this.heightInput.max),
        );

        this.widthInput.value = String(newWidth);
        this.heightInput.value = String(newHeight);

        if (newWidth === this.imgWidth && newHeight === this.imgHeight) return;

        this.resizeBitmap(newWidth, newHeight);
    }

    private updateControlsFromValue() {
        if (this.widthInput) {
            this.widthInput.value = String(this.imgWidth);
        }
        if (this.heightInput) {
            this.heightInput.value = String(this.imgHeight);
        }
    }

    private clampDimension(value: number, min: number, max: number) {
        const normalizedMin = Math.max(1, Math.floor(min));
        const normalizedMax = Math.max(normalizedMin, Math.floor(max));
        const normalizedValue = Number.isFinite(value) ? Math.floor(value) : normalizedMin;
        return Math.min(normalizedMax, Math.max(normalizedMin, normalizedValue));
    }

    /**
     * Resize the bitmap to new dimensions.
     *
     * @param newWidth New width in pixels.
     * @param newHeight New height in pixels.
     */
    private resizeBitmap(newWidth: number, newHeight: number) {
        const currentValue = this.getValue();
        if (!currentValue) return;

        // Create new bitmap with new dimensions
        const newBitmap: number[][] = [];
        for (let r = 0; r < newHeight; r++) {
            newBitmap.push([]);
            for (let c = 0; c < newWidth; c++) {
                // Copy existing pixel if within bounds, otherwise fill with 0
                if (r < this.imgHeight && c < this.imgWidth) {
                    newBitmap[r].push(currentValue[r][c]);
                } else {
                    newBitmap[r].push(0);
                }
            }
        }

        this.setValue(newBitmap, false);
    }

    private rerenderSourceBlock() {
        const sourceBlock = this.getSourceBlock();
        if (sourceBlock instanceof Blockly.BlockSvg && sourceBlock.rendered) {
            sourceBlock.render();
        }
    }

    private rerenderSourceBlockAfterResize() {
        this.rerenderSourceBlock();

        if (this.editorCanvas && Blockly.DropDownDiv.getOwner() === this) {
            Blockly.DropDownDiv.showPositionedByField(
                this,
                this.dropdownDispose.bind(this),
            );
        }
    }

    /**
     * Disposes of events belonging to the bitmap editor.
     */
    private dropdownDispose() {
        console.log('Disposing dropdown for field', this.fieldId);
        
        // 清理定时器
        if (this.updateTimer !== null) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }

        // 确保所有待更新的内容都被应用
        this.flushPendingUpdates(true);

        if (
            this.getSourceBlock() &&
            this.initialValue !== null &&
            !this.bitmapsEqual(this.initialValue, this.getValue())
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
        
        // 清理编辑器相关的引用，但不清理字段本身的引用
        this.editorCanvas = null;
        this.editorContext = null;
        this.pendingUpdates.clear();
        
        // Set this.initialValue back to null.
        this.initialValue = null;

        // 清理输入框引用
        this.widthInput = null;
        this.heightInput = null;

        Blockly.DropDownDiv.getContentDiv().classList.remove(
            'contains-bitmap-editor-u8g2',
        );
    }/**
     * Dispose of this field and clean up subscriptions
     */
    override dispose() {
        console.log('Disposing field', this.fieldId);
        
        // 清理上传响应订阅
        if (this.uploadResponseSubscription) {
            this.uploadResponseSubscription.unsubscribe();
            this.uploadResponseSubscription = null;
        }
        
        // 清理定时器
        if (this.updateTimer !== null) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }

        // 清理待更新的内容
        this.pendingUpdates.clear();
        
        // 清理DOM引用
        this.editorCanvas = null;
        this.editorContext = null;
        this.blockPreviewCanvas = null;
        this.blockPreviewContext = null;
        this.blockDisplayImage = null;
        this.widthInput = null;
        this.heightInput = null;
        
        // 调用父类的dispose方法
        super.dispose();
    }

    /**
     * Constructs an array of zeros with the specified width and height.
     *
     * @returns The new value.
     */
    private getEmptyArray(): number[][] {
        const newVal: number[][] = [];
        for (let r = 0; r < this.imgHeight; r++) {
            newVal.push([]);
            for (let c = 0; c < this.imgWidth; c++) {
                newVal[r].push(0);
            }
        }
        return newVal;
    }

    private cloneBitmap(bitmap: number[][] | null): number[][] | null {
        return bitmap ? bitmap.map(row => [...row]) : null;
    }

    private bitmapsEqual(left: number[][] | null, right: number[][] | null) {
        if (left === right) return true;
        if (!left || !right) return false;
        if (left.length !== right.length) return false;

        for (let row = 0; row < left.length; row++) {
            if (left[row].length !== right[row].length) return false;
            for (let col = 0; col < left[row].length; col++) {
                if (left[row][col] !== right[row][col]) return false;
            }
        }

        return true;
    }

    /**
     * Checks if a down event is on a pixel in this editor and if it is starts an
     * edit gesture.
     *
     * @param e The down event.
     */    
    private onPointerStart(e: Event) {
        if (!this.editorCanvas) return;

        this.stopCanvasEvent(e);
        const pointerEvent = e as PointerEvent;

        const rect = this.editorCanvas.getBoundingClientRect();
        const x = pointerEvent.clientX - rect.left;
        const y = pointerEvent.clientY - rect.top;

        const col = Math.floor(x / this.pixelSize);
        const row = Math.floor(y / this.pixelSize);

        if (pointerEvent.button !== 0 && pointerEvent.button !== 2) return;

        if (row < 0 || row >= this.imgHeight || col < 0 || col >= this.imgWidth) return;

        this.pointerIsDown = true;
        this.valToPaintWith = pointerEvent.button === 2 ? 0 : 1;
        this.setCanvasCursor(this.valToPaintWith === 0);
        this.lastPaintedRow = row;
        this.lastPaintedCol = col;
        this.drawLine(row, col, row, col);
        this.flushPendingUpdates(true);
    }

    /**
     * Updates the editor if we're in an edit gesture and the pointer is over a
     * pixel.
     *
     * @param e The move event.
     */
    private onPointerMove(e: Event) {
        this.stopCanvasEvent(e);

        if (!this.pointerIsDown || this.valToPaintWith === undefined || !this.editorCanvas) {
            return;
        }

        const pointerEvent = e as PointerEvent;

        const rect = this.editorCanvas.getBoundingClientRect();
        const x = pointerEvent.clientX - rect.left;
        const y = pointerEvent.clientY - rect.top;

        const col = Math.floor(x / this.pixelSize);
        const row = Math.floor(y / this.pixelSize);

        if (row >= 0 && row < this.imgHeight && col >= 0 && col < this.imgWidth) {
            // 如果当前位置与上次绘制位置不同，绘制连续线条
            if (this.lastPaintedRow !== row || this.lastPaintedCol !== col) {
                this.drawLine(this.lastPaintedRow, this.lastPaintedCol, row, col);
                this.lastPaintedRow = row;
                this.lastPaintedCol = col;
            }
        }
    }

    /**
     * Resets pointer state (e.g. After either a pointerup event or if the
     * gesture is canceled).
     */
    private onPointerEnd(e?: Event) {
        if (e) {
            this.stopCanvasEvent(e);
        }

        // 确保所有待更新的内容都被应用
        this.flushPendingUpdates(true);

        this.pointerIsDown = false;
        this.valToPaintWith = undefined;
        this.setCanvasCursor(false);
        this.lastPaintedRow = -1;
        this.lastPaintedCol = -1;
    }

    /**
     * Sets all the pixels to 0.
     */
    private clearPixels() {
        const cleared = this.getEmptyArray();
        this.setValue(cleared, false);
    }    /**
     * Upload current bitmap to Angular main program for processing.
     */    private uploadBitmap() {
        const currentBitmap = this.getValue();
        if (!currentBitmap) {
            console.error('No bitmap data to upload for field', this.fieldId);
            return;
        }

        // 确保字段仍然有效
        if (!this.getSourceBlock() || this.getSourceBlock()?.isDisposed()) {
            console.error('Field is disposed, cannot upload bitmap for field', this.fieldId);
            return;
        }

        const uploadRequest: BitmapUploadRequest = {
            fieldId: this.fieldId,  // 使用当前字段的唯一ID
            currentBitmap: currentBitmap,
            width: this.imgWidth,
            height: this.imgHeight,
            timestamp: Date.now()
        };

        console.log('Uploading bitmap from field', this.fieldId, ':', uploadRequest);

        // Get upload service through global service manager
        const uploadService = this.globalServiceManager.getBitmapUploadService();
        if (uploadService) {
            uploadService.sendUploadRequest(uploadRequest);
        } else {
            console.error('BitmapUploadService not available for field', this.fieldId);
        }
    }/**
     * Setup upload response handler
     */
    private setupUploadResponseHandler() {
        const uploadService = this.globalServiceManager.getBitmapUploadService();
        if (uploadService) {
            // 确保之前的订阅已经清理
            if (this.uploadResponseSubscription) {
                this.uploadResponseSubscription.unsubscribe();
                this.uploadResponseSubscription = null;
            }
            
            // 存储订阅以便后续清理
            this.uploadResponseSubscription = uploadService.uploadResponse$.subscribe(response => {
                // 严格匹配字段ID - 只处理属于当前字段的响应
                if (response.fieldId !== this.fieldId) {
                    return;
                }
                
                console.log('Field', this.fieldId, 'received response:', response);
                
                if (response.success && response.data) {
                    const data = response.data;
                    const responseWidth = Number(data.width);
                    const responseHeight = Number(data.height);
                    const hasDimensions = Number.isFinite(responseWidth) && Number.isFinite(responseHeight);
                    
                    // 处理位图数据
                    if (data.bitmapArray) {
                        // 确保当前字段仍然存在且可编辑
                        if (this.getSourceBlock() && !this.getSourceBlock()?.isDisposed()) {
                            this.setValue(this.cloneBitmap(data.bitmapArray), false);
                            if (
                                hasDimensions &&
                                (responseWidth !== this.imgWidth || responseHeight !== this.imgHeight)
                            ) {
                                this.resizeBitmap(responseWidth, responseHeight);
                            }
                        }
                    } else if (hasDimensions) {
                        this.resizeBitmap(responseWidth, responseHeight);
                    }
                    
                    // 更新输入框值（如果编辑器当前打开）
                    if (this.widthInput && this.widthInput.parentNode) {
                        this.widthInput.value = String(hasDimensions ? responseWidth : this.imgWidth);
                    }
                    if (this.heightInput && this.heightInput.parentNode) {
                        this.heightInput.value = String(hasDimensions ? responseHeight : this.imgHeight);
                    }
                } else {
                    console.error('Upload processing failed for field', this.fieldId, ':', response.message);
                }
            });
        } else {
            console.warn('BitmapUploadService not available for response handling');
        }
    }

    private getPixel(row: number, column: number): number {
        const value = this.getValue();
        if (!value) {
            throw new Error(
                'Attempted to retrieve a pixel value when no value is set',
            );
        }

        return value[row][column];
    }

    /**
     * Creates a new element with the specified type and class.
     *
     * @param elementType Type of html element.
     * @param className ClassName of html element.
     * @returns The created element.
     */
    private createElementWithClassname(elementType: string, className: string) {
        const newElt = document.createElement(elementType);
        newElt.className = className;
        return newElt;
    }

    /**
     * Binds an event listener to the specified element.
     *
     * @param element Specified element.
     * @param eventName Name of the event to bind.
     * @param callback Function to be called on specified event.
     */
    private bindEvent(
        element: EventTarget,
        eventName: string,
        callback: (e: Event) => void,
    ) {
        this.boundEvents.push(
            Blockly.browserEvents.bind(element, eventName, this, callback),
        );
    }

    private stopCanvasEvent(e: Event) {
        e.preventDefault();
        e.stopPropagation();
    }

    private setCanvasCursor(isErasing: boolean) {
        if (!this.editorCanvas) return;
        this.editorCanvas.style.cursor = isErasing ? ERASER_CURSOR : PAINT_CURSOR;
    }

    /**
     * 更新block显示的图片
     */
    private updateBlockDisplayImage() {
        this.updateBlockDisplayImageFast();
    }

    /**
     * 使用复用的离屏canvas生成block预览图。
     */
    private updateBlockDisplayImageFast() {
        if (!this.blockDisplayImage || this.imgWidth <= 0 || this.imgHeight <= 0) return;

        const bitmap = this.getValue();
        if (!bitmap) return;

        const ctx = this.getBlockPreviewContext();
        const canvas = this.blockPreviewCanvas;
        if (!ctx || !canvas) return;

        const imageData = ctx.createImageData(this.imgWidth, this.imgHeight);
        const data = imageData.data;
        const filled = this.filledColour;
        const empty = this.emptyColour;

        for (let r = 0; r < this.imgHeight; r++) {
            const row = bitmap[r];
            for (let c = 0; c < this.imgWidth; c++) {
                const pixelIndex = (r * this.imgWidth + c) * 4;
                const color = row[c] ? filled : empty;
                data[pixelIndex] = color.r;
                data[pixelIndex + 1] = color.g;
                data[pixelIndex + 2] = color.b;
                data[pixelIndex + 3] = 255;
            }
        }

        ctx.putImageData(imageData, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        this.blockDisplayImage.setAttribute('href', dataUrl);
        this.blockDisplayImage.setAttributeNS('http://www.w3.org/1999/xlink', 'href', dataUrl);
    }

    private getBlockPreviewContext() {
        if (!this.blockPreviewCanvas) {
            this.blockPreviewCanvas = document.createElement('canvas');
        }

        if (
            this.blockPreviewCanvas.width !== this.imgWidth ||
            this.blockPreviewCanvas.height !== this.imgHeight
        ) {
            this.blockPreviewCanvas.width = this.imgWidth;
            this.blockPreviewCanvas.height = this.imgHeight;
            this.blockPreviewContext = null;
        }

        if (!this.blockPreviewContext) {
            this.blockPreviewContext = this.blockPreviewCanvas.getContext('2d');
        }

        return this.blockPreviewContext;
    }

    /**
     * 渲染canvas编辑器
     */
    private renderCanvasEditor() {
        if (!this.editorContext || !this.editorCanvas) return;
        const bitmap = this.getValue();
        if (!bitmap) return;
        // 清除canvas
        this.editorContext.clearRect(0, 0, this.editorCanvas.width, this.editorCanvas.height);
        // 绘制网格和像素
        for (let r = 0; r < this.imgHeight; r++) {
            for (let c = 0; c < this.imgWidth; c++) {
                const x = c * this.pixelSize;
                const y = r * this.pixelSize;
                // 绘制像素
                this.editorContext.fillStyle = bitmap[r][c] ? this.pixelColours.filled : this.pixelColours.empty;
                this.editorContext.fillRect(x, y, this.pixelSize, this.pixelSize);

                if (this.pixelSize >= 5) {
                    this.editorContext.strokeStyle = '#4f4f4f';
                    this.editorContext.lineWidth = 1;
                    this.editorContext.strokeRect(x + 0.5, y + 0.5, this.pixelSize, this.pixelSize);
                }
            }
        }
    }

    /**
     * 绘制单个编辑器像素。
     */
    private paintEditorPixel(row: number, column: number, value: number) {
        if (!this.editorContext) return;

        const x = column * this.pixelSize;
        const y = row * this.pixelSize;
        this.editorContext.fillStyle = value ? this.pixelColours.filled : this.pixelColours.empty;
        this.editorContext.fillRect(x, y, this.pixelSize, this.pixelSize);

        if (this.pixelSize >= 5) {
            this.editorContext.strokeStyle = '#4f4f4f';
            this.editorContext.lineWidth = 1;
            this.editorContext.strokeRect(x + 0.5, y + 0.5, this.pixelSize, this.pixelSize);
        }
    }

    /**
     * 绑定canvas事件
     */
    private bindCanvasEvents() {
        if (!this.editorCanvas) return;

        this.bindEvent(this.editorCanvas, 'pointermove', this.onPointerMove);
        this.bindEvent(this.editorCanvas, 'pointerup', this.onPointerEnd);
        this.bindEvent(this.editorCanvas, 'pointerleave', this.onPointerEnd);
        this.bindEvent(this.editorCanvas, 'pointerdown', this.onPointerStart);
        this.bindEvent(this.editorCanvas, 'pointercancel', this.onPointerEnd);
        this.bindEvent(this.editorCanvas, 'contextmenu', this.stopCanvasEvent);

        // 防止触摸事件的默认行为
        this.bindEvent(this.editorCanvas, 'touchmove', (e: Event) => {
            this.stopCanvasEvent(e);
        });
    }
    /**
   * 将十六进制颜色转换为RGB
   */
    private hexToRgb(hex: string): { r: number, g: number, b: number } {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : { r: 0, g: 0, b: 0 };
    }    /**
     * 使用布雷森汉姆直线算法在两个点之间绘制连续线条
     * @param r0 起始行
     * @param c0 起始列
     * @param r1 结束行
     * @param c1 结束列
     */
    private drawLine(r0: number, c0: number, r1: number, c1: number) {
        if (this.valToPaintWith === undefined) return;

        const dx = Math.abs(c1 - c0);
        const dy = Math.abs(r1 - r0);
        const sx = c0 < c1 ? 1 : -1;
        const sy = r0 < r1 ? 1 : -1;
        let err = dx - dy;

        let r = r0;
        let c = c0;

        while (true) {
            // 绘制当前点
            this.paintAt(r, c);

            // 如果到达终点，退出循环
            if (r === r1 && c === c1) break;

            const e2 = 2 * err;
            if (e2 > -dy) {
                err -= dy;
                c += sx;
            }
            if (e2 < dx) {
                err += dx;
                r += sy;
            }
        }

        // 批量应用更新
        this.flushPendingUpdates();
    }

    /**
     * 批量设置像素值，提高性能
     * @param r Row number
     * @param c Column number  
     * @param newValue New pixel value
     */
    private paintAt(row: number, column: number) {
        if (this.valToPaintWith === undefined) return;

        const radius = this.valToPaintWith === 0 ? ERASER_RADIUS : 0;
        for (let r = row - radius; r <= row + radius; r++) {
            for (let c = column - radius; c <= column + radius; c++) {
                if (r < 0 || r >= this.imgHeight || c < 0 || c >= this.imgWidth) {
                    continue;
                }
                if (this.getPixel(r, c) !== this.valToPaintWith) {
                    this.setPixelBatch(r, c, this.valToPaintWith);
                }
            }
        }
    }

    private setPixelBatch(r: number, c: number, newValue: number) {
        const currentValue = this.getValue();
        if (!currentValue) return;

        // 如果值没有改变，跳过
        if (currentValue[r][c] === newValue) return;

        // 记录待更新的像素
        const key = `${r},${c}`;
        this.pendingUpdates.add(key);

        // 立即更新数据
        currentValue[r][c] = newValue;
        this.paintEditorPixel(r, c, newValue);
    }

    /**
     * 批量应用所有待更新的像素
     */
    private flushPendingUpdates(immediate = false) {
        if (this.pendingUpdates.size === 0) return;

        // 清除之前的定时器
        if (this.updateTimer !== null) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }

        const applyUpdates = () => {
            const currentValue = this.getValue();
            if (currentValue) {
                this.skipNextEditorRender = true;
                this.setValue(this.cloneBitmap(currentValue), false);
            }

            this.pendingUpdates.clear();
            this.updateTimer = null;
        };

        if (immediate) {
            applyUpdates();
            return;
        }

        // 设置新的定时器，延迟更新以提高性能
        this.updateTimer = window.setTimeout(applyUpdates, 16); // 约60fps的更新频率
    }
}

interface Buttons {
    readonly upload: boolean;
    readonly clear: boolean;
}
interface PixelColours {
    readonly empty: string;
    readonly filled: string;
}
interface RgbColour {
    readonly r: number;
    readonly g: number;
    readonly b: number;
}

export interface FieldBitmapFromJsonConfig extends Blockly.FieldConfig {
    value?: number[][];
    width?: number;
    height?: number;
    buttons?: Buttons;
    fieldHeight?: number;
    colours?: PixelColours;
}

Blockly.fieldRegistry.register('field_bitmap_u8g2', FieldBitmapU8g2);

/**
 * CSS for bitmap field.
 */
Blockly.Css.register(`
.dropdownEditor-u8g2 {
    align-items: stretch;
    display: flex;
    flex-direction: column;
    gap: 10px;
    justify-content: center;
    max-width: 520px;
    padding: 10px;
}
.toolbar-u8g2 {
    align-items: flex-start;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: space-between;
}
.dimensionControl-u8g2 {
    align-items: center;
    display: inline-flex;
    gap: 5px;
}
.dimensionGroup-u8g2,
.buttonGroup-u8g2 {
    align-items: center;
    display: inline-flex;
    gap: 6px;
}
.rightControls-u8g2 {
    align-items: center;
    display: inline-flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
    margin-left: auto;
}
.label-u8g2 {
    color: #e8e8e8;
    font-size: 12px;
    line-height: 1;
    white-space: nowrap;
}
.hint-u8g2 {
    color: #cfcfcf;
    font-size: 12px;
    line-height: 1;
    text-align: center;
    white-space: nowrap;
    width: 100%;
}
.canvasContainer-u8g2 {
    align-self: center;
    background: #1b1b1b;
    border: 2px solid #666;
    border-radius: 4px;
  display: inline-block;
    line-height: 0;
    max-height: 420px;
    max-width: 480px;
    overflow: auto;
}
.bitmapCanvas-u8g2 {
    background: #151515;
  display: block;
  cursor: ${PAINT_CURSOR};
    image-rendering: pixelated;
    touch-action: none;
}
.dimensionInput-u8g2 {
    background: #ffffff;
    border: 1px solid #777;
    border-radius: 4px;
    color: #222;
  font-size: 12px;
    height: 26px;
    padding: 0 4px;
  text-align: center;
    width: 48px;
}
.dimensionInput-u8g2:focus {
  outline: none;
  border-color: #007acc;
  box-shadow: 0 0 0 1px rgba(0, 122, 204, 0.3);
}
.controlButton-u8g2 {
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
.controlButton-u8g2:hover {
    background: #444;
    border-color: #888;
}
.blocklyDropDownContent.contains-bitmap-editor-u8g2 {
    background: #2a2a2a;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  max-height: none;
}
`);
