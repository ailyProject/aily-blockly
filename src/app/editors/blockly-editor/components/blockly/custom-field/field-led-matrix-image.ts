import * as Blockly from 'blockly/core';
import { projectDataRuntime, AilyDataRef, isAilyDataRef } from '@domain/project/public-api';

Blockly.Msg['LED_MATRIX_IMAGE_BUTTON_CLEAR'] = 'Clear';
Blockly.Msg['LED_MATRIX_IMAGE_BUTTON_FILL'] = 'Fill';
Blockly.Msg['LED_MATRIX_IMAGE_LABEL_COLOR'] = 'Color';
Blockly.Msg['LED_MATRIX_IMAGE_HINT_MOUSE'] = '鼠标左键绘制，右键擦除';

export const DEFAULT_HEIGHT = 8;
export const DEFAULT_WIDTH = 8;

const DEFAULT_MIN_SIZE = 1;
const DEFAULT_MAX_SIZE = 128;
const DEFAULT_EDITOR_MAX_WIDTH = 420;
const DEFAULT_EDITOR_MAX_HEIGHT = 360;
const DEFAULT_BLOCK_MAX_WIDTH = 96;
const DEFAULT_BLOCK_MAX_HEIGHT = 72;
const DEFAULT_SELECTED_COLOUR = '#ff3b30';
const DEFAULT_PIXEL_COLOURS: LedMatrixImageColours = {
    empty: '#151515',
    mono: '#ffffff',
    border: '#4f4f4f',
    background: '#262626',
};
const DEFAULT_BUTTONS: LedMatrixImageButtons = {
    fill: true,
    clear: true,
};

export type LedMatrixImageMode = 'mono' | 'rgb';
export type LedMatrixImagePixel = 0 | 1 | string | null;
export type LedMatrixImageEncoding = 'mono-bitpack-v1' | 'rgba8888-v1';

export interface LedMatrixImageValue {
    readonly schemaVersion: 1;
    mode: LedMatrixImageMode;
    encoding: LedMatrixImageEncoding;
    width: number;
    height: number;
    pixels: AilyDataRef | null;
}

export interface ResolvedLedMatrixImageValue {
    mode: LedMatrixImageMode;
    width: number;
    height: number;
    pixels: LedMatrixImagePixel[][];
}

/**
 * Field for editing monochrome and RGB LED matrix images.
 */
export class FieldLedMatrixImage extends Blockly.Field<LedMatrixImageValue> {
    private imgHeight = DEFAULT_HEIGHT;
    private imgWidth = DEFAULT_WIDTH;
    private defaultMode: LedMatrixImageMode = 'mono';
    private minWidth = DEFAULT_MIN_SIZE;
    private maxWidth = DEFAULT_MAX_SIZE;
    private minHeight = DEFAULT_MIN_SIZE;
    private maxHeight = DEFAULT_MAX_SIZE;
    private configuredEditorPixelSize?: number;
    private configuredBlockPixelSize?: number;
    private fieldHeight?: number;

    private boundEvents: Blockly.browserEvents.Data[] = [];

    private editorCanvas: HTMLCanvasElement | null = null;
    private editorContext: CanvasRenderingContext2D | null = null;
    private blockDisplayImage: SVGImageElement | null = null;
    private widthInput: HTMLInputElement | null = null;
    private heightInput: HTMLInputElement | null = null;
    private colourInput: HTMLInputElement | null = null;
    private colourControl: HTMLElement | null = null;

    private pointerIsDown = false;
    private lastPaintedRow = -1;
    private lastPaintedCol = -1;
    private dragPixelValue: LedMatrixImagePixel | undefined;
    private selectedColour = DEFAULT_SELECTED_COLOUR;
    private resolvedValue: ResolvedLedMatrixImageValue = createEmptyResolvedValue(
        DEFAULT_WIDTH,
        DEFAULT_HEIGHT,
        'mono',
    );
    private resolvedValueRefId = '';
    private loadingValue: Promise<ResolvedLedMatrixImageValue> | null = null;
    private mutationVersion = 0;
    private sourceBlockRenderScheduled = false;

    buttonOptions: LedMatrixImageButtons;
    pixelColours: LedMatrixImageColours;
    editorPixelSize = 24;
    blockPixelSize = 8;

    constructor(
        value: LedMatrixImageValue | typeof Blockly.Field.SKIP_SETUP = Blockly.Field.SKIP_SETUP,
        validator?: Blockly.FieldValidator<LedMatrixImageValue>,
        config?: FieldLedMatrixImageConfig,
    ) {
        super(
            value === Blockly.Field.SKIP_SETUP
                ? value
                : FieldLedMatrixImage.normalizeValue(value, config) ??
                    FieldLedMatrixImage.createDefaultValue(config),
            validator,
            config,
        );

        this.SERIALIZABLE = true;
        this.CURSOR = 'pointer';
        this.defaultMode = FieldLedMatrixImage.normalizeMode(config?.mode);
        this.minWidth = FieldLedMatrixImage.normalizeLimit(config?.minWidth, DEFAULT_MIN_SIZE);
        this.maxWidth = FieldLedMatrixImage.normalizeLimit(config?.maxWidth, DEFAULT_MAX_SIZE);
        this.minHeight = FieldLedMatrixImage.normalizeLimit(config?.minHeight, DEFAULT_MIN_SIZE);
        this.maxHeight = FieldLedMatrixImage.normalizeLimit(config?.maxHeight, DEFAULT_MAX_SIZE);
        this.configuredEditorPixelSize = config?.pixelSize;
        this.configuredBlockPixelSize = config?.blockPixelSize;
        this.fieldHeight = config?.fieldHeight;
        this.selectedColour = FieldLedMatrixImage.normalizeHexColour(
            config?.selectedColour ?? DEFAULT_SELECTED_COLOUR,
        );
        this.buttonOptions = { ...DEFAULT_BUTTONS, ...config?.buttons };
        this.pixelColours = { ...DEFAULT_PIXEL_COLOURS, ...config?.colours };

        const currentValue = FieldLedMatrixImage.normalizeValue(this.getValue(), config)
            ?? FieldLedMatrixImage.createDefaultValue(config);
        this.value_ = currentValue;
        this.resolvedValue = createEmptyResolvedValue(
            currentValue.width,
            currentValue.height,
            currentValue.mode,
        );
        this.syncDimensionsFromValue(currentValue);
    }

    static override fromJson(options: FieldLedMatrixImageConfig) {
        return new this(
            options.value ?? Blockly.Field.SKIP_SETUP,
            undefined,
            options,
        );
    }

    getMatrixWidth() {
        return this.imgWidth;
    }

    getMatrixHeight() {
        return this.imgHeight;
    }

    getMode() {
        return this.getCurrentValue().mode;
    }

    protected override doClassValidation_(
        newValue?: LedMatrixImageValue,
    ): LedMatrixImageValue | null | undefined {
        if (!newValue) {
            return null;
        }

        return FieldLedMatrixImage.normalizeValue(newValue, {
            mode: this.defaultMode,
            minWidth: this.minWidth,
            maxWidth: this.maxWidth,
            minHeight: this.minHeight,
            maxHeight: this.maxHeight,
        });
    }

    protected override doValueUpdate_(newValue: LedMatrixImageValue) {
        const dimensionsChanged =
            this.imgWidth !== newValue.width || this.imgHeight !== newValue.height;
        const modeChanged = this.resolvedValue.mode !== newValue.mode;
        const nextRefId = newValue.pixels?.$ailyData.id || '';

        if (dimensionsChanged || modeChanged || nextRefId !== this.resolvedValueRefId) {
            this.resolvedValue = createEmptyResolvedValue(
                newValue.width,
                newValue.height,
                newValue.mode,
            );
            this.resolvedValueRefId = '';
            this.loadingValue = null;
        }

        this.value_ = { ...newValue };
        this.syncDimensionsFromValue(newValue);

        if (dimensionsChanged) {
            this.resizeEditorCanvas();
            this.updateSize_();
            this.rerenderSourceBlock();
        }

        this.updateBlockDisplayImage();
        this.renderCanvasEditor();
        this.updateControlsFromValue();
        if (nextRefId) {
            void this.ensureValueLoaded().catch((error) => {
                console.error('LED matrix resource load failed:', error);
            });
        }
    }

    override saveState(_doFullSerialization?: boolean): LedMatrixImageValue {
        return { ...this.getValue() };
    }

    protected override showEditor_(e?: Event) {
        void this.ensureValueLoaded().then(() => {
            if (!this.getSourceBlock() || this.getSourceBlock()?.isDisposed()) return;
            const editor = this.dropdownCreate();
            Blockly.DropDownDiv.getContentDiv().appendChild(editor);
            Blockly.DropDownDiv.showPositionedByField(
                this,
                this.dropdownDispose.bind(this),
            );
        }).catch((error) => console.error('LED matrix resource load failed:', error));
    }

    protected override render_() {
        super.render_();

        this.updateBlockDisplayImage();
        this.renderCanvasEditor();
        this.updateControlsFromValue();
    }

    override initView() {
        this.blockDisplayImage = Blockly.utils.dom.createSvgElement(
            'image',
            {
                x: 0,
                y: 0,
                width: this.blockPixelSize * this.imgWidth,
                height: this.blockPixelSize * this.imgHeight,
                style: 'image-rendering: pixelated; cursor: pointer;',
            },
            this.getSvgRoot(),
        ) as SVGImageElement;

        this.updateBlockDisplayImage();
        void this.ensureValueLoaded().catch((error) => {
            console.error('LED matrix resource load failed:', error);
        });
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
        const newWidth = this.blockPixelSize * this.imgWidth;
        const newHeight = this.blockPixelSize * this.imgHeight;

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
        this.unbindEditorEvents();
        this.editorCanvas = null;
        this.editorContext = null;
        this.blockDisplayImage = null;
        this.widthInput = null;
        this.heightInput = null;
        this.colourInput = null;
        this.colourControl = null;
        super.dispose();
    }

    private dropdownCreate() {
        const dropdownEditor = this.createElementWithClassname(
            'div',
            'dropdownEditor-ledMatrixImage',
        );
        this.bindEditorContainerEvents(dropdownEditor);

        const toolbar = this.createToolbar();
        dropdownEditor.appendChild(toolbar);

        const canvasContainer = this.createElementWithClassname(
            'div',
            'canvasContainer-ledMatrixImage',
        );
        this.editorCanvas = document.createElement('canvas');
        this.editorCanvas.className = 'ledMatrixImageCanvas';
        canvasContainer.appendChild(this.editorCanvas);
        dropdownEditor.appendChild(canvasContainer);

        const mouseHint = this.createElementWithClassname('div', 'hint-ledMatrixImage');
        mouseHint.textContent = Blockly.Msg['LED_MATRIX_IMAGE_HINT_MOUSE'];
        dropdownEditor.appendChild(mouseHint);

        this.editorContext = this.editorCanvas.getContext('2d');
        if (!this.editorContext) {
            throw new Error('Unable to get canvas 2d context');
        }

        Blockly.DropDownDiv.getContentDiv().classList.add(
            'contains-ledMatrixImage-editor',
        );

        this.bindCanvasEvents();
        this.resizeEditorCanvas();
        this.renderCanvasEditor();
        this.updateControlsFromValue();
        return dropdownEditor;
    }

    private createToolbar() {
        const toolbar = this.createElementWithClassname('div', 'toolbar-ledMatrixImage');

        const dimensionGroup = this.createElementWithClassname('div', 'dimensionGroup-ledMatrixImage');
        this.widthInput = this.createDimensionInput('W', this.imgWidth, this.minWidth, this.maxWidth);
        this.heightInput = this.createDimensionInput('H', this.imgHeight, this.minHeight, this.maxHeight);
        this.bindDimensionInputEvents(this.widthInput);
        this.bindDimensionInputEvents(this.heightInput);
        dimensionGroup.appendChild(this.createDimensionControl('W', this.widthInput));
        dimensionGroup.appendChild(this.createDimensionControl('H', this.heightInput));
        toolbar.appendChild(dimensionGroup);

        const rightControls = this.createElementWithClassname('div', 'rightControls-ledMatrixImage');

        this.colourControl = this.createElementWithClassname('label', 'controlGroup-ledMatrixImage');
        this.colourControl.appendChild(this.createLabel(Blockly.Msg['LED_MATRIX_IMAGE_LABEL_COLOR']));
        this.colourInput = document.createElement('input');
        this.colourInput.type = 'color';
        this.colourInput.className = 'colourInput-ledMatrixImage';
        this.colourInput.value = this.selectedColour;
        this.bindEvent(this.colourInput, 'input', this.onColourInputChange.bind(this));
        this.colourControl.appendChild(this.colourInput);
        rightControls.appendChild(this.colourControl);

        const actionGroup = this.createElementWithClassname('div', 'buttonGroup-ledMatrixImage');
        if (this.buttonOptions.fill) {
            this.addControlButton(
                actionGroup,
                Blockly.Msg['LED_MATRIX_IMAGE_BUTTON_FILL'],
                this.fillPixels.bind(this),
            );
        }
        if (this.buttonOptions.clear) {
            this.addControlButton(
                actionGroup,
                Blockly.Msg['LED_MATRIX_IMAGE_BUTTON_CLEAR'],
                this.clearPixels.bind(this),
            );
        }
        rightControls.appendChild(actionGroup);
        toolbar.appendChild(rightControls);

        return toolbar;
    }

    private createLabel(text: string) {
        const label = document.createElement('span');
        label.className = 'label-ledMatrixImage';
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
        input.className = 'dimensionInput-ledMatrixImage';
        input.min = String(min);
        input.max = String(max);
        input.value = String(value);
        input.setAttribute('aria-label', ariaLabel);
        return input;
    }

    private createDimensionControl(labelText: string, input: HTMLInputElement) {
        const control = this.createElementWithClassname('label', 'dimensionControl-ledMatrixImage');
        control.appendChild(this.createLabel(labelText));
        control.appendChild(input);
        return control;
    }

    private bindDimensionInputEvents(input: HTMLInputElement) {
        this.bindEvent(input, 'input', this.onDimensionInputChange.bind(this));
        this.bindEvent(input, 'change', this.onDimensionInputChange.bind(this));
    }

    private addControlButton(
        parent: HTMLElement,
        buttonText: string,
        onClick: (e?: Event) => void,
    ) {
        const button = this.createElementWithClassname(
            'button',
            'controlButton-ledMatrixImage',
        ) as HTMLButtonElement;
        button.innerText = buttonText;
        parent.appendChild(button);
        this.bindEvent(button, 'click', onClick);
        return button;
    }

    private bindCanvasEvents() {
        if (!this.editorCanvas) return;

        this.bindEvent(this.editorCanvas, 'pointerdown', this.onPointerStart.bind(this));
        this.bindEvent(this.editorCanvas, 'pointermove', this.onPointerMove.bind(this));
        this.bindEvent(this.editorCanvas, 'pointerup', this.onPointerEnd.bind(this));
        this.bindEvent(this.editorCanvas, 'pointerleave', this.onPointerEnd.bind(this));
        this.bindEvent(this.editorCanvas, 'pointercancel', this.onPointerEnd.bind(this));
        this.bindEvent(this.editorCanvas, 'contextmenu', this.stopCanvasEvent);
        this.bindEvent(this.editorCanvas, 'touchmove', this.stopCanvasEvent);
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

    private onPointerStart(e: Event) {
        const pointerEvent = e as PointerEvent;
        this.stopCanvasEvent(pointerEvent);

        const cell = this.getCellFromPointer(pointerEvent);
        if (!cell) return;

        if (pointerEvent.button !== 0 && pointerEvent.button !== 2) {
            return;
        }

        this.pointerIsDown = true;
        this.lastPaintedRow = cell.row;
        this.lastPaintedCol = cell.col;
        const mode = this.getCurrentValue().mode;
        this.dragPixelValue = pointerEvent.button === 2
            ? this.getOffPixelValue(mode)
            : this.getOnPixelValue(mode);
        this.paintLine(cell.row, cell.col, cell.row, cell.col, this.dragPixelValue);
    }

    private onPointerMove(e: Event) {
        this.stopCanvasEvent(e);

        if (!this.pointerIsDown || this.dragPixelValue === undefined) {
            return;
        }

        const pointerEvent = e as PointerEvent;
        const cell = this.getCellFromPointer(pointerEvent);
        if (!cell) return;

        if (cell.row !== this.lastPaintedRow || cell.col !== this.lastPaintedCol) {
            this.paintLine(
                this.lastPaintedRow,
                this.lastPaintedCol,
                cell.row,
                cell.col,
                this.dragPixelValue,
            );
            this.lastPaintedRow = cell.row;
            this.lastPaintedCol = cell.col;
        }
    }

    private onPointerEnd(e?: Event) {
        if (e) {
            this.stopCanvasEvent(e);
        }

        this.pointerIsDown = false;
        this.dragPixelValue = undefined;
        this.lastPaintedRow = -1;
        this.lastPaintedCol = -1;
        this.commitResolvedValue();
    }

    private getCellFromPointer(e: PointerEvent) {
        if (!this.editorCanvas) return null;

        const rect = this.editorCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const col = Math.floor(x / this.editorPixelSize);
        const row = Math.floor(y / this.editorPixelSize);

        if (row < 0 || row >= this.imgHeight || col < 0 || col >= this.imgWidth) {
            return null;
        }

        return { row, col };
    }

    private paintLine(
        r0: number,
        c0: number,
        r1: number,
        c1: number,
        pixelValue: LedMatrixImagePixel,
    ) {
        const nextValue = this.cloneValue(this.getCurrentValue());
        let changed = false;

        const dx = Math.abs(c1 - c0);
        const dy = Math.abs(r1 - r0);
        const sx = c0 < c1 ? 1 : -1;
        const sy = r0 < r1 ? 1 : -1;
        let err = dx - dy;
        let row = r0;
        let col = c0;

        while (true) {
            if (row >= 0 && row < nextValue.height && col >= 0 && col < nextValue.width) {
                if (!this.pixelValuesEqual(nextValue.pixels[row][col], pixelValue)) {
                    nextValue.pixels[row][col] = pixelValue;
                    changed = true;
                }
            }

            if (row === r1 && col === c1) break;

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

        if (changed) {
            this.applyValue(nextValue);
        }
    }

    private onColourInputChange() {
        if (!this.colourInput) return;
        this.selectedColour = FieldLedMatrixImage.normalizeHexColour(this.colourInput.value);
    }

    private onDimensionInputChange() {
        if (!this.widthInput || !this.heightInput) return;
        if (this.widthInput.value === '' || this.heightInput.value === '') return;

        this.applyDimensionInputs();
    }

    private applyDimensionInputs() {
        if (!this.widthInput || !this.heightInput) return;

        const newWidth = FieldLedMatrixImage.clampDimension(
            Number(this.widthInput.value),
            this.minWidth,
            this.maxWidth,
        );
        const newHeight = FieldLedMatrixImage.clampDimension(
            Number(this.heightInput.value),
            this.minHeight,
            this.maxHeight,
        );

        this.widthInput.value = String(newWidth);
        this.heightInput.value = String(newHeight);

        if (newWidth === this.imgWidth && newHeight === this.imgHeight) return;

        this.resizeMatrix(newWidth, newHeight);
    }

    private resizeMatrix(newWidth: number, newHeight: number) {
        const currentValue = this.getCurrentValue();
        const nextValue = this.createEmptyValue(newWidth, newHeight, currentValue.mode);
        const copyHeight = Math.min(currentValue.height, newHeight);
        const copyWidth = Math.min(currentValue.width, newWidth);

        for (let row = 0; row < copyHeight; row++) {
            for (let col = 0; col < copyWidth; col++) {
                nextValue.pixels[row][col] = currentValue.pixels[row][col];
            }
        }

        this.applyValue(nextValue);
    }

    private fillPixels() {
        const currentValue = this.getCurrentValue();
        const nextValue = this.createEmptyValue(
            currentValue.width,
            currentValue.height,
            currentValue.mode,
        );
        const fillPixel = this.getOnPixelValue(currentValue.mode);

        for (let row = 0; row < nextValue.height; row++) {
            for (let col = 0; col < nextValue.width; col++) {
                nextValue.pixels[row][col] = fillPixel;
            }
        }

        this.applyValue(nextValue);
    }

    private clearPixels() {
        const currentValue = this.getCurrentValue();
        this.applyValue(
            this.createEmptyValue(currentValue.width, currentValue.height, currentValue.mode),
        );
    }

    private updateControlsFromValue() {
        const currentValue = this.getCurrentValue();

        if (this.widthInput) {
            this.widthInput.value = String(currentValue.width);
        }
        if (this.heightInput) {
            this.heightInput.value = String(currentValue.height);
        }
        if (this.colourInput) {
            this.colourInput.value = this.selectedColour;
        }
        if (this.colourControl) {
            this.colourControl.classList.toggle('hidden-ledMatrixImage', currentValue.mode !== 'rgb');
        }
    }

    private applyValue(value: ResolvedLedMatrixImageValue) {
        const normalizedValue = FieldLedMatrixImage.normalizeResolvedValue(value, {
            mode: this.defaultMode,
            minWidth: this.minWidth,
            maxWidth: this.maxWidth,
            minHeight: this.minHeight,
            maxHeight: this.maxHeight,
        });
        if (!normalizedValue) return;

        const dimensionsChanged = this.imgWidth !== normalizedValue.width
            || this.imgHeight !== normalizedValue.height;
        this.resolvedValue = normalizedValue;
        this.imgWidth = normalizedValue.width;
        this.imgHeight = normalizedValue.height;
        if (dimensionsChanged) {
            this.resizeEditorCanvas();
            this.rerenderSourceBlock();
        }
        this.updateSize_();
        this.updateBlockDisplayImage();
        this.renderCanvasEditor();
        this.updateControlsFromValue();
        if (!this.pointerIsDown) {
            this.commitResolvedValue();
        }
    }

    private rerenderSourceBlock() {
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
            if (Blockly.DropDownDiv.getOwner() === this) {
                Blockly.DropDownDiv.repositionForWindowResize();
            }
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(renderBlock);
        } else {
            Promise.resolve().then(renderBlock);
        }
    }

    private dropdownDispose() {
        this.commitResolvedValue();

        this.unbindEditorEvents();
        this.editorCanvas = null;
        this.editorContext = null;
        this.widthInput = null;
        this.heightInput = null;
        this.colourInput = null;
        this.colourControl = null;
        Blockly.DropDownDiv.getContentDiv().classList.remove(
            'contains-ledMatrixImage-editor',
        );
    }

    private updateBlockDisplayImage() {
        if (!this.blockDisplayImage) return;

        const currentValue = this.getCurrentValue();

        const canvas = this.renderValueToCanvas(currentValue, 1, false);
        const dataUrl = canvas.toDataURL();
        this.blockDisplayImage.setAttribute('href', dataUrl);
        this.blockDisplayImage.setAttributeNS('http://www.w3.org/1999/xlink', 'href', dataUrl);
    }

    private renderCanvasEditor() {
        if (!this.editorContext || !this.editorCanvas) return;

        const currentValue = this.getCurrentValue();

        this.editorContext.clearRect(0, 0, this.editorCanvas.width, this.editorCanvas.height);

        for (let row = 0; row < currentValue.height; row++) {
            for (let col = 0; col < currentValue.width; col++) {
                const x = col * this.editorPixelSize;
                const y = row * this.editorPixelSize;
                this.editorContext.fillStyle = this.getPixelColour(currentValue.pixels[row][col], currentValue.mode);
                this.editorContext.fillRect(x, y, this.editorPixelSize, this.editorPixelSize);

                if (this.editorPixelSize >= 5) {
                    this.editorContext.strokeStyle = this.pixelColours.border;
                    this.editorContext.lineWidth = 1;
                    this.editorContext.strokeRect(x + 0.5, y + 0.5, this.editorPixelSize, this.editorPixelSize);
                }
            }
        }
    }

    private renderValueToCanvas(
        value: ResolvedLedMatrixImageValue,
        scale: number,
        showGrid: boolean,
    ) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, value.width * scale);
        canvas.height = Math.max(1, value.height * scale);

        const context = canvas.getContext('2d');
        if (!context) return canvas;

        context.fillStyle = this.pixelColours.background;
        context.fillRect(0, 0, canvas.width, canvas.height);

        for (let row = 0; row < value.height; row++) {
            for (let col = 0; col < value.width; col++) {
                const x = col * scale;
                const y = row * scale;
                context.fillStyle = this.getPixelColour(value.pixels[row][col], value.mode);
                context.fillRect(x, y, scale, scale);

                if (showGrid && scale >= 5) {
                    context.strokeStyle = this.pixelColours.border;
                    context.lineWidth = 1;
                    context.strokeRect(x + 0.5, y + 0.5, scale, scale);
                }
            }
        }

        return canvas;
    }

    private resizeEditorCanvas() {
        this.refreshPixelSizes();
        if (!this.editorCanvas) return;

        this.editorCanvas.width = this.imgWidth * this.editorPixelSize;
        this.editorCanvas.height = this.imgHeight * this.editorPixelSize;
    }

    private syncDimensionsFromValue(value: Pick<LedMatrixImageValue, 'width' | 'height'> | null) {
        if (!value) return;

        this.imgWidth = value.width;
        this.imgHeight = value.height;
        this.refreshPixelSizes();
    }

    private refreshPixelSizes() {
        this.editorPixelSize = this.configuredEditorPixelSize ?? this.getOptimalEditorPixelSize();
        this.blockPixelSize = this.fieldHeight
            ? this.fieldHeight / Math.max(1, this.imgHeight)
            : this.configuredBlockPixelSize ?? this.getOptimalBlockPixelSize();
    }

    private getOptimalEditorPixelSize() {
        const fitSize = Math.floor(Math.min(
            DEFAULT_EDITOR_MAX_WIDTH / Math.max(1, this.imgWidth),
            DEFAULT_EDITOR_MAX_HEIGHT / Math.max(1, this.imgHeight),
        ));
        return Math.max(4, Math.min(28, fitSize));
    }

    private getOptimalBlockPixelSize() {
        const fitSize = Math.floor(Math.min(
            DEFAULT_BLOCK_MAX_WIDTH / Math.max(1, this.imgWidth),
            DEFAULT_BLOCK_MAX_HEIGHT / Math.max(1, this.imgHeight),
        ));
        return Math.max(2, Math.min(12, fitSize));
    }

    private getOnPixelValue(mode: LedMatrixImageMode): LedMatrixImagePixel {
        return mode === 'rgb' ? this.selectedColour : 1;
    }

    private getOffPixelValue(mode: LedMatrixImageMode): LedMatrixImagePixel {
        return mode === 'rgb' ? null : 0;
    }

    private getPixelColour(pixel: LedMatrixImagePixel, mode: LedMatrixImageMode) {
        if (mode === 'rgb') {
            return typeof pixel === 'string'
                ? FieldLedMatrixImage.normalizeHexColour(pixel)
                : this.pixelColours.empty;
        }
        return pixel === 1 ? this.pixelColours.mono : this.pixelColours.empty;
    }

    private createEmptyValue(
        width: number,
        height: number,
        mode: LedMatrixImageMode,
    ): ResolvedLedMatrixImageValue {
        const offValue = this.getOffPixelValue(mode);
        const pixels: LedMatrixImagePixel[][] = [];

        for (let row = 0; row < height; row++) {
            pixels.push([]);
            for (let col = 0; col < width; col++) {
                pixels[row].push(offValue);
            }
        }

        return { mode, width, height, pixels };
    }

    private getCurrentValue() {
        return this.resolvedValue;
    }

    private cloneValue(value: ResolvedLedMatrixImageValue): ResolvedLedMatrixImageValue {
        return {
            mode: value.mode,
            width: value.width,
            height: value.height,
            pixels: value.pixels.map(row => [...row]),
        };
    }

    private commitResolvedValue() {
        const snapshot = this.cloneValue(this.resolvedValue);
        const hasPixels = hasEnabledLedMatrixPixel(snapshot);
        const bytes = packLedMatrixValue(snapshot);
        const codec = snapshot.mode === 'rgb'
            ? 'led-matrix-rgba8888-v1'
            : 'led-matrix-mono-v1';
        const encoding: LedMatrixImageEncoding = snapshot.mode === 'rgb'
            ? 'rgba8888-v1'
            : 'mono-bitpack-v1';
        const mutationVersion = ++this.mutationVersion;
        const operation = (hasPixels
            ? projectDataRuntime.put({ codec, storage: 'raw-v1', value: bytes })
            : Promise.resolve(null)
        ).then((pixels) => {
            if (mutationVersion !== this.mutationVersion) return;
            const nextValue: LedMatrixImageValue = {
                schemaVersion: 1,
                mode: snapshot.mode,
                encoding,
                width: snapshot.width,
                height: snapshot.height,
                pixels,
            };
            this.resolvedValueRefId = pixels?.$ailyData.id || '';
            this.resolvedValue = snapshot;
            this.setValue(nextValue);
        });
        projectDataRuntime.trackMutation(operation);
        void operation.catch((error) => console.error('LED matrix resource save failed:', error));
    }

    private async ensureValueLoaded(): Promise<ResolvedLedMatrixImageValue> {
        const value = this.getValue();
        const ref = value.pixels;
        if (!ref) {
            this.resolvedValue = createEmptyResolvedValue(value.width, value.height, value.mode);
            this.resolvedValueRefId = '';
            return this.resolvedValue;
        }
        const refId = ref.$ailyData.id;
        if (this.resolvedValueRefId === refId) return this.resolvedValue;
        if (this.loadingValue) return this.loadingValue;
        const loading = projectDataRuntime.resolve<Uint8Array>(ref).then((bytes) => {
            const current = this.getValue();
            if (current.pixels?.$ailyData.id !== refId) return this.resolvedValue;
            const expectedLength = current.mode === 'rgb'
                ? current.width * current.height * 4
                : Math.ceil(current.width / 8) * current.height;
            if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expectedLength) {
                throw new Error(
                    `LED matrix resource length mismatch: expected ${expectedLength}, got ${bytes.byteLength}`,
                );
            }
            this.resolvedValue = unpackLedMatrixValue(
                bytes,
                current.width,
                current.height,
                current.mode,
            );
            this.resolvedValueRefId = refId;
            this.updateBlockDisplayImage();
            this.renderCanvasEditor();
            return this.resolvedValue;
        }).finally(() => {
            if (this.loadingValue === loading) this.loadingValue = null;
        });
        this.loadingValue = loading;
        return loading;
    }

    private pixelValuesEqual(
        left: LedMatrixImagePixel,
        right: LedMatrixImagePixel,
    ) {
        return left === right;
    }

    private stopCanvasEvent(e: Event) {
        e.preventDefault();
        e.stopPropagation();
    }

    private createElementWithClassname(elementType: string, className: string) {
        const newElt = document.createElement(elementType);
        newElt.className = className;
        return newElt;
    }

    private bindEvent(
        element: EventTarget,
        eventName: string,
        callback: (e: Event) => void,
    ) {
        this.boundEvents.push(
            Blockly.browserEvents.bind(element, eventName, this, callback),
        );
    }

    private unbindEditorEvents() {
        for (const event of this.boundEvents) {
            Blockly.browserEvents.unbind(event);
        }
        this.boundEvents.length = 0;
    }

    private static createDefaultValue(config?: FieldLedMatrixImageConfig): LedMatrixImageValue {
        const mode = FieldLedMatrixImage.normalizeMode(config?.mode);
        const width = FieldLedMatrixImage.clampDimension(
            config?.width ?? DEFAULT_WIDTH,
            config?.minWidth ?? DEFAULT_MIN_SIZE,
            config?.maxWidth ?? DEFAULT_MAX_SIZE,
        );
        const height = FieldLedMatrixImage.clampDimension(
            config?.height ?? DEFAULT_HEIGHT,
            config?.minHeight ?? DEFAULT_MIN_SIZE,
            config?.maxHeight ?? DEFAULT_MAX_SIZE,
        );
        return {
            schemaVersion: 1,
            mode,
            encoding: mode === 'rgb' ? 'rgba8888-v1' : 'mono-bitpack-v1',
            width,
            height,
            pixels: null,
        };
    }

    private static normalizeValue(
        value: LedMatrixImageValue,
        config?: FieldLedMatrixImageConfig,
    ): LedMatrixImageValue | null {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return null;
        }

        if (value.schemaVersion !== 1 || (value.pixels !== null && !isAilyDataRef(value.pixels))) {
            return null;
        }
        const mode = FieldLedMatrixImage.normalizeMode(config?.mode ?? value.mode);
        const width = FieldLedMatrixImage.clampDimension(
            value.width ?? config?.width ?? DEFAULT_WIDTH,
            config?.minWidth ?? DEFAULT_MIN_SIZE,
            config?.maxWidth ?? DEFAULT_MAX_SIZE,
        );
        const height = FieldLedMatrixImage.clampDimension(
            value.height ?? config?.height ?? DEFAULT_HEIGHT,
            config?.minHeight ?? DEFAULT_MIN_SIZE,
            config?.maxHeight ?? DEFAULT_MAX_SIZE,
        );
        const encoding: LedMatrixImageEncoding = mode === 'rgb'
            ? 'rgba8888-v1'
            : 'mono-bitpack-v1';
        const expectedCodec = mode === 'rgb'
            ? 'led-matrix-rgba8888-v1'
            : 'led-matrix-mono-v1';
        if (value.encoding !== encoding) return null;
        if (value.pixels && value.pixels.$ailyData.codec !== expectedCodec) return null;

        return {
            schemaVersion: 1,
            mode,
            encoding,
            width,
            height,
            pixels: value.pixels,
        };
    }

    private static normalizeResolvedValue(
        value: ResolvedLedMatrixImageValue,
        config?: FieldLedMatrixImageConfig,
    ): ResolvedLedMatrixImageValue | null {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const sourcePixels = Array.isArray(value.pixels) ? value.pixels : [];
        const inferredHeight = sourcePixels.length || config?.height || DEFAULT_HEIGHT;
        const inferredWidth = Array.isArray(sourcePixels[0])
            ? sourcePixels[0].length
            : config?.width || DEFAULT_WIDTH;
        const mode = FieldLedMatrixImage.normalizeMode(config?.mode ?? value.mode);
        const width = FieldLedMatrixImage.clampDimension(
            value.width ?? inferredWidth,
            config?.minWidth ?? DEFAULT_MIN_SIZE,
            config?.maxWidth ?? DEFAULT_MAX_SIZE,
        );
        const height = FieldLedMatrixImage.clampDimension(
            value.height ?? inferredHeight,
            config?.minHeight ?? DEFAULT_MIN_SIZE,
            config?.maxHeight ?? DEFAULT_MAX_SIZE,
        );
        const pixels = FieldLedMatrixImage.normalizePixels(sourcePixels, width, height, mode);
        return { mode, width, height, pixels };
    }

    private static normalizePixels(
        sourcePixels: LedMatrixImagePixel[][],
        width: number,
        height: number,
        mode: LedMatrixImageMode,
    ) {
        const offValue: LedMatrixImagePixel = mode === 'rgb' ? null : 0;
        const pixels: LedMatrixImagePixel[][] = [];

        for (let row = 0; row < height; row++) {
            pixels.push([]);
            for (let col = 0; col < width; col++) {
                pixels[row].push(
                    FieldLedMatrixImage.normalizePixel(sourcePixels[row]?.[col], mode, offValue),
                );
            }
        }

        return pixels;
    }

    private static normalizePixel(
        pixel: LedMatrixImagePixel | undefined,
        mode: LedMatrixImageMode,
        offValue: LedMatrixImagePixel,
    ): LedMatrixImagePixel {
        if (mode === 'rgb') {
            if (typeof pixel === 'string' && FieldLedMatrixImage.isHexColour(pixel)) {
                return FieldLedMatrixImage.normalizeHexColour(pixel);
            }
            if (pixel === 1) {
                return DEFAULT_SELECTED_COLOUR;
            }
            return offValue;
        }

        return pixel === 1 || (typeof pixel === 'string' && FieldLedMatrixImage.isHexColour(pixel))
            ? 1
            : 0;
    }

    private static normalizeMode(mode?: string): LedMatrixImageMode {
        return mode === 'rgb' ? 'rgb' : 'mono';
    }

    private static normalizeLimit(value: number | undefined, fallback: number) {
        if (!Number.isFinite(value)) return fallback;
        return Math.max(1, Math.floor(Number(value)));
    }

    private static clampDimension(value: number, min: number, max: number) {
        const normalizedMin = Math.max(1, Math.floor(min));
        const normalizedMax = Math.max(normalizedMin, Math.floor(max));
        const normalizedValue = Number.isFinite(value) ? Math.floor(value) : normalizedMin;
        return Math.min(normalizedMax, Math.max(normalizedMin, normalizedValue));
    }

    private static isHexColour(value: string) {
        return /^#[0-9a-f]{6}$/i.test(value);
    }

    private static normalizeHexColour(value: string) {
        return FieldLedMatrixImage.isHexColour(value)
            ? value.toLowerCase()
            : DEFAULT_SELECTED_COLOUR;
    }
}

export function createEmptyResolvedValue(
    width: number,
    height: number,
    mode: LedMatrixImageMode,
): ResolvedLedMatrixImageValue {
    const offValue: LedMatrixImagePixel = mode === 'rgb' ? null : 0;
    return {
        mode,
        width,
        height,
        pixels: Array.from({ length: height }, () => Array(width).fill(offValue)),
    };
}

export function hasEnabledLedMatrixPixel(value: ResolvedLedMatrixImageValue): boolean {
    return value.pixels.some((row) => row.some((pixel) => (
        value.mode === 'rgb' ? typeof pixel === 'string' : pixel === 1
    )));
}

export function packLedMatrixValue(value: ResolvedLedMatrixImageValue): Uint8Array {
    if (value.mode === 'mono') {
        const rowBytes = Math.ceil(value.width / 8);
        const bytes = new Uint8Array(rowBytes * value.height);
        for (let row = 0; row < value.height; row++) {
            for (let col = 0; col < value.width; col++) {
                if (value.pixels[row]?.[col] === 1) {
                    bytes[row * rowBytes + (col >> 3)] |= 1 << (col & 7);
                }
            }
        }
        return bytes;
    }

    const bytes = new Uint8Array(value.width * value.height * 4);
    for (let row = 0; row < value.height; row++) {
        for (let col = 0; col < value.width; col++) {
            const pixel = value.pixels[row]?.[col];
            if (typeof pixel !== 'string' || !/^#[0-9a-f]{6}$/i.test(pixel)) continue;
            const offset = (row * value.width + col) * 4;
            bytes[offset] = parseInt(pixel.slice(1, 3), 16);
            bytes[offset + 1] = parseInt(pixel.slice(3, 5), 16);
            bytes[offset + 2] = parseInt(pixel.slice(5, 7), 16);
            bytes[offset + 3] = 255;
        }
    }
    return bytes;
}

export function unpackLedMatrixValue(
    bytes: Uint8Array,
    width: number,
    height: number,
    mode: LedMatrixImageMode,
): ResolvedLedMatrixImageValue {
    const value = createEmptyResolvedValue(width, height, mode);
    if (mode === 'mono') {
        const rowBytes = Math.ceil(width / 8);
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                value.pixels[row][col] = ((bytes[row * rowBytes + (col >> 3)] >> (col & 7)) & 1)
                    ? 1
                    : 0;
            }
        }
        return value;
    }

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const offset = (row * width + col) * 4;
            if (bytes[offset + 3] === 0) continue;
            value.pixels[row][col] = `#${bytes[offset].toString(16).padStart(2, '0')}${bytes[offset + 1].toString(16).padStart(2, '0')}${bytes[offset + 2].toString(16).padStart(2, '0')}`;
        }
    }
    return value;
}

interface LedMatrixImageButtons {
    readonly fill: boolean;
    readonly clear: boolean;
}

interface LedMatrixImageColours {
    readonly empty: string;
    readonly mono: string;
    readonly border: string;
    readonly background: string;
}

export interface FieldLedMatrixImageConfig extends Blockly.FieldConfig {
    value?: LedMatrixImageValue;
    mode?: LedMatrixImageMode;
    width?: number;
    height?: number;
    minWidth?: number;
    maxWidth?: number;
    minHeight?: number;
    maxHeight?: number;
    pixelSize?: number;
    blockPixelSize?: number;
    fieldHeight?: number;
    selectedColour?: string;
    buttons?: Partial<LedMatrixImageButtons>;
    colours?: Partial<LedMatrixImageColours>;
}

Blockly.fieldRegistry.register('field_led_matrix_image', FieldLedMatrixImage);

Blockly.Css.register(`
.dropdownEditor-ledMatrixImage {
  align-items: stretch;
  display: flex;
  flex-direction: column;
  gap: 10px;
  justify-content: center;
  max-width: 520px;
  padding: 10px;
}
.toolbar-ledMatrixImage {
    align-items: flex-start;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
    justify-content: space-between;
}
.controlGroup-ledMatrixImage,
.dimensionControl-ledMatrixImage {
  align-items: center;
  display: inline-flex;
  gap: 5px;
}
.dimensionGroup-ledMatrixImage,
.buttonGroup-ledMatrixImage {
  align-items: center;
  display: inline-flex;
  gap: 6px;
}
.rightControls-ledMatrixImage {
    align-items: center;
    display: inline-flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
    margin-left: auto;
}
.label-ledMatrixImage {
  color: #e8e8e8;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
}
.hint-ledMatrixImage {
    color: #cfcfcf;
    font-size: 12px;
    line-height: 1;
    text-align: center;
    white-space: nowrap;
    width: 100%;
}
.dimensionInput-ledMatrixImage {
  background: #ffffff;
  border: 1px solid #777;
  border-radius: 4px;
  color: #222;
  font-size: 12px;
  height: 26px;
}
.dimensionInput-ledMatrixImage {
  padding: 0 4px;
  text-align: center;
  width: 48px;
}
.colourInput-ledMatrixImage {
  background: transparent;
  border: 1px solid #777;
  border-radius: 4px;
  cursor: pointer;
  height: 26px;
  padding: 1px;
  width: 34px;
}
.canvasContainer-ledMatrixImage {
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
.ledMatrixImageCanvas {
  cursor: crosshair;
  display: block;
  image-rendering: pixelated;
  touch-action: none;
}
.controlButton-ledMatrixImage {
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
.controlButton-ledMatrixImage:hover {
  background: #444;
  border-color: #888;
}
.hidden-ledMatrixImage {
  display: none;
}
.blocklyDropDownContent.contains-ledMatrixImage-editor {
  background: #2a2a2a;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  max-height: none;
}
`);
