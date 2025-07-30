/**
 * @license
 * Copyright 2024 Aily Blockly
 * SPDX-License-Identifier: Apache-2.0
 */

import * as Blockly from 'blockly/core';

Blockly.Msg['BUTTON_LABEL_CLEAR'] = 'Clear';
Blockly.Msg['BUTTON_LABEL_FILL'] = 'Fill';

export const DEFAULT_HEIGHT = 8;
export const DEFAULT_WIDTH = 8;
const DEFAULT_PIXEL_SIZE = 16;
const DEFAULT_PIXEL_COLOURS: PixelColours = {
    empty: '#2a2a2a',
    filled: '#ffffff',
    border: '#666666',
};
const DEFAULT_BUTTONS: Buttons = {
    fill: true,
    clear: true,
};

/**
 * Field for inputting LED matrix display.
 * Includes a grid of clickable pixels that represents an LED matrix.
 */
export class FieldLedMatrix extends Blockly.Field<number[][]> {
    private initialValue: number[][] | null = null;
    private imgHeight: number;
    private imgWidth: number;
    
    /**
     * Array holding info needed to unbind events.
     * Used for disposing.
     */
    private boundEvents: Blockly.browserEvents.Data[] = [];
    
    /** References to UI elements */
    private editorCanvas: HTMLCanvasElement | null = null;
    private editorContext: CanvasRenderingContext2D | null = null;
    private blockDisplayPixels: SVGElement[][] | null = null;
    
    /** Stateful variables */
    private pointerIsDown = false;
    private valToPaintWith?: number;
    private lastPaintedRow: number = -1;
    private lastPaintedCol: number = -1;
    private pendingUpdates: Set<string> = new Set();
    private updateTimer: number | null = null;
    
    buttonOptions: Buttons;
    pixelSize: number;
    pixelColours: PixelColours;
    fieldHeight?: number;

    /**
     * Constructor for the LED matrix field.
     *
     * @param value 2D rectangular array of 1s and 0s.
     * @param validator A function that is called to validate.
     * @param config Config A map of options used to configure the field.
     */
    constructor(
        value: number[][] | typeof Blockly.Field.SKIP_SETUP,
        validator?: Blockly.FieldValidator<number[][]>,
        config?: FieldLedMatrixFromJsonConfig,
    ) {
        super(value, validator, config);
        
        this.SERIALIZABLE = true;
        this.buttonOptions = { ...DEFAULT_BUTTONS, ...config?.buttons };
        this.pixelColours = { ...DEFAULT_PIXEL_COLOURS, ...config?.colours };
        
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
            // 根据矩阵大小自动调整像素尺寸
            this.pixelSize = this.getOptimalPixelSize(this.imgWidth, this.imgHeight);
        }
    }

    /**
     * Constructs a FieldLedMatrix from a JSON arg object.
     *
     * @param options A JSON object with options.
     * @returns The new field instance.
     */
    static override fromJson(options: FieldLedMatrixFromJsonConfig) {
        return new this(
            options.value ?? Blockly.Field.SKIP_SETUP,
            undefined,
            options,
        );
    }

    /**
     * Returns the width of the matrix in pixels.
     */
    getMatrixWidth() {
        return this.imgWidth;
    }

    /**
     * Returns the height of the matrix in pixels.
     */
    getMatrixHeight() {
        return this.imgHeight;
    }

    /**
     * Validates that a new value meets the requirements for a valid LED matrix array.
     */
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
        // The empty list is not an acceptable matrix
        if (newHeight == 0) {
            return null;
        }

        // Check that all rows have the same width
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
     */
    protected override doValueUpdate_(newValue: number[][]) {
        super.doValueUpdate_(newValue);
        if (newValue) {
            this.imgHeight = newValue.length;
            this.imgWidth = newValue[0] ? newValue[0].length : 0;
            // If the field height is static, adjust the pixel size to fit.
            if (this.fieldHeight) {
                this.pixelSize = this.fieldHeight / this.imgHeight;
            } else {
                // 根据矩阵大小自动调整像素尺寸
                this.pixelSize = this.getOptimalPixelSize(this.imgWidth, this.imgHeight);
            }
        }
    }

    /**
     * Show the LED matrix editor dialog.
     * Disabled since we support direct editing on the block.
     */
    protected override showEditor_(e?: Event) {
        // Direct editing is enabled on the block display
        // No need to show additional editor
        return;
    }

    /**
     * Updates the block display and editor dropdown when the field re-renders.
     */
    protected override render_() {
        super.render_();

        if (!this.getValue()) {
            return;
        }

        // Update block display pixels
        if (this.blockDisplayPixels) {
            this.updateBlockDisplayPixels();
        }

        // Update canvas editor (if exists)
        if (this.editorCanvas && this.editorContext) {
            this.renderCanvasEditor();
        }
    }

    /**
     * Determines whether the field is editable.
     */
    override updateEditable() {
        const editable = super.updateEditable();
        const svgRoot = this.getSvgRoot();
        if (svgRoot) {
            Blockly.utils.dom.removeClass(svgRoot, 'blocklyNonEditableText');
            Blockly.utils.dom.removeClass(svgRoot, 'blocklyEditableText');
        }
        return editable;
    }

    /**
     * Gets the rectangle built out of dimensions matching SVG's <g> element.
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
     * Constructs an array of zeros with the specified width and height.
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

    /**
     * Constructs an array of ones with the specified width and height.
     */
    private getFilledArray(): number[][] {
        const newVal: number[][] = [];
        for (let r = 0; r < this.imgHeight; r++) {
            newVal.push([]);
            for (let c = 0; c < this.imgWidth; c++) {
                newVal[r].push(1);
            }
        }
        return newVal;
    }

    /**
     * 根据矩阵尺寸自动选择合适的像素大小
     */
    private getOptimalPixelSize(width: number, height: number): number {
        const totalPixels = width * height;

        if (totalPixels <= 64) {        // 8x8 或更小
            return 30;  // 大尺寸，便于编辑
        } else if (totalPixels <= 256) { // 16x16 或更小
            return 20;  // 中等尺寸
        } else if (totalPixels <= 512) { // 32x16 或更小
            return 15;  // 较小尺寸
        } else {                        // 更大的矩阵
            return 10;  // 最小尺寸
        }
    }

    /**
     * Creates the LED matrix editor and add event listeners.
     */
    private dropdownCreate() {
        const dropdownEditor = this.createElementWithClassname(
            'div',
            'dropdownEditor-ledmatrix',
        );

        if (this.buttonOptions.clear || this.buttonOptions.fill) {
            dropdownEditor.classList.add('has-buttons-ledmatrix');
        }

        // Create Canvas editor
        const canvasContainer = this.createElementWithClassname(
            'div',
            'canvasContainer-ledmatrix',
        );
        this.editorCanvas = document.createElement('canvas');
        this.editorCanvas.className = 'ledmatrixCanvas';
        this.editorCanvas.width = this.imgWidth * this.pixelSize;
        this.editorCanvas.height = this.imgHeight * this.pixelSize;

        this.editorContext = this.editorCanvas.getContext('2d');
        if (!this.editorContext) {
            throw new Error('无法获取canvas 2d context');
        }

        canvasContainer.appendChild(this.editorCanvas);
        dropdownEditor.appendChild(canvasContainer);

        // This prevents the normal max-height from adding a scroll bar for large images.
        Blockly.DropDownDiv.getContentDiv().classList.add('contains-ledmatrix-editor');

        // Bind canvas events
        this.bindCanvasEvents();

        // Render initial canvas content
        this.renderCanvasEditor();

        // Add control buttons below the canvas
        if (this.buttonOptions.clear || this.buttonOptions.fill) {
            const buttonContainer = this.createElementWithClassname('div', 'buttonContainer-ledmatrix');

            if (this.buttonOptions.fill) {
                this.addControlButton(
                    buttonContainer,
                    Blockly.Msg['BUTTON_LABEL_FILL'],
                    this.fillPixels,
                );
            }
            if (this.buttonOptions.clear) {
                this.addControlButton(
                    buttonContainer,
                    Blockly.Msg['BUTTON_LABEL_CLEAR'],
                    this.clearPixels,
                );
            }

            dropdownEditor.appendChild(buttonContainer);
        }

        // Store the initial value at the start of the edit.
        this.initialValue = this.getValue();

        return dropdownEditor;
    }

    /**
     * Initializes the on-block display.
     */
    override initView() {
        // Create SVG pixel grid for direct interaction
        this.blockDisplayPixels = [];
        for (let r = 0; r < this.imgHeight; r++) {
            const row = [];
            for (let c = 0; c < this.imgWidth; c++) {
                const pixel = Blockly.utils.dom.createSvgElement(
                    'rect',
                    {
                        x: c * this.pixelSize,
                        y: r * this.pixelSize,
                        width: this.pixelSize,
                        height: this.pixelSize,
                        fill: this.pixelColours.empty,
                        stroke: this.pixelColours.border,
                        'stroke-width': 0.5,
                        'data-row': r,
                        'data-col': c,
                        style: 'cursor: pointer;'
                    },
                    this.getSvgRoot(),
                );

                // Add click event listener
                this.boundEvents.push(
                    Blockly.browserEvents.bind(pixel, 'click', this, this.onPixelClick)
                );

                row.push(pixel);
            }
            this.blockDisplayPixels.push(row);
        }

        // Initial render
        this.updateBlockDisplayPixels();
    }

    /**
     * Handles pixel click events on the block display.
     */
    private onPixelClick(e: Event) {
        if (!this.blockDisplayPixels) return;

        const target = e.target as SVGElement;
        const row = parseInt(target.getAttribute('data-row') || '0');
        const col = parseInt(target.getAttribute('data-col') || '0');

        // Toggle pixel value
        const currentValue = this.getValue();
        if (currentValue && row < this.imgHeight && col < this.imgWidth) {
            const newValue = JSON.parse(JSON.stringify(currentValue));
            newValue[row][col] = 1 - newValue[row][col]; // Toggle 0/1

            this.setValue(newValue);
            this.updateBlockDisplayPixels();
        }
    }

    /**
     * Updates the block display pixels.
     */
    private updateBlockDisplayPixels() {
        if (!this.blockDisplayPixels) return;

        const matrix = this.getValue();
        if (!matrix) return;

        for (let r = 0; r < this.imgHeight; r++) {
            for (let c = 0; c < this.imgWidth; c++) {
                if (this.blockDisplayPixels[r] && this.blockDisplayPixels[r][c]) {
                    const pixel = this.blockDisplayPixels[r][c];
                    const isOn = matrix[r][c];
                    pixel.setAttribute('fill', isOn ? this.pixelColours.filled : this.pixelColours.empty);
                }
            }
        }
    }

    /**
     * Updates the size of the block based on the size of the underlying matrix.
     */
    protected override updateSize_() {
        const newWidth = this.pixelSize * this.imgWidth;
        const newHeight = this.pixelSize * this.imgHeight;
        if (this.borderRect_) {
            this.borderRect_.setAttribute('width', String(newWidth));
            this.borderRect_.setAttribute('height', String(newHeight));
        }

        // Update pixel positions if they exist
        if (this.blockDisplayPixels) {
            for (let r = 0; r < this.imgHeight; r++) {
                for (let c = 0; c < this.imgWidth; c++) {
                    if (this.blockDisplayPixels[r] && this.blockDisplayPixels[r][c]) {
                        const pixel = this.blockDisplayPixels[r][c];
                        pixel.setAttribute('x', String(c * this.pixelSize));
                        pixel.setAttribute('y', String(r * this.pixelSize));
                        pixel.setAttribute('width', String(this.pixelSize));
                        pixel.setAttribute('height', String(this.pixelSize));
                    }
                }
            }
        }

        this.size_.width = newWidth;
        this.size_.height = newHeight;
    }

    /**
     * Create control button.
     */
    private addControlButton(
        parent: HTMLElement,
        buttonText: string,
        onClick: () => void,
    ) {
        const button = this.createElementWithClassname('button', 'controlButton-ledmatrix');
        button.innerText = buttonText;
        parent.appendChild(button);
        this.bindEvent(button, 'click', onClick);
    }

    /**
     * Sets all the pixels to 0.
     */
    private clearPixels() {
        const cleared = this.getEmptyArray();
        this.fireIntermediateChangeEvent(cleared);
        this.setValue(cleared, false);

        // Update canvas display
        if (this.editorCanvas && this.editorContext) {
            this.renderCanvasEditor();
        }

        // Update block display
        this.updateBlockDisplayPixels();
    }

    /**
     * Sets all the pixels to 1.
     */
    private fillPixels() {
        const filled = this.getFilledArray();
        this.fireIntermediateChangeEvent(filled);
        this.setValue(filled, false);

        // Update canvas display
        if (this.editorCanvas && this.editorContext) {
            this.renderCanvasEditor();
        }

        // Update block display
        this.updateBlockDisplayPixels();
    }

    /**
     * Disposes of events belonging to the LED matrix editor.
     */
    private dropdownDispose() {
        // Clear timer
        if (this.updateTimer !== null) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }

        // Ensure all pending updates are applied
        this.flushPendingUpdates();

        if (
            this.getSourceBlock() &&
            this.initialValue !== null &&
            this.initialValue !== this.getValue()
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
        }

        for (const event of this.boundEvents) {
            Blockly.browserEvents.unbind(event);
        }
        this.boundEvents.length = 0;

        // Clear editor references
        this.editorCanvas = null;
        this.editorContext = null;
        this.pendingUpdates.clear();

        // Set this.initialValue back to null.
        this.initialValue = null;

        Blockly.DropDownDiv.getContentDiv().classList.remove(
            'contains-ledmatrix-editor',
        );
    }

    /**
     * Dispose of this field and clean up
     */
    override dispose() {
        // Clear timer
        if (this.updateTimer !== null) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }

        // Clear pending updates
        this.pendingUpdates.clear();

        // Clear DOM references
        this.editorCanvas = null;
        this.editorContext = null;
        this.blockDisplayPixels = null;

        // Call parent dispose method
        super.dispose();
    }

    /**
     * Checks if a down event is on a pixel in this editor and starts an edit gesture.
     */
    private onPointerStart(e: PointerEvent) {
        if (!this.editorCanvas) return;

        const rect = this.editorCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const col = Math.floor(x / this.pixelSize);
        const row = Math.floor(y / this.pixelSize);

        if (row >= 0 && row < this.imgHeight && col >= 0 && col < this.imgWidth) {
            this.onPointerDownInPixel(row, col);
            this.lastPaintedRow = row;
            this.lastPaintedCol = col;
            this.pointerIsDown = true;
            e.preventDefault();
        }
    }

    /**
     * Updates the editor if we're in an edit gesture and the pointer is over a pixel.
     */
    private onPointerMove(e: PointerEvent) {
        if (!this.pointerIsDown || !this.editorCanvas) {
            return;
        }

        const rect = this.editorCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const col = Math.floor(x / this.pixelSize);
        const row = Math.floor(y / this.pixelSize);

        if (row >= 0 && row < this.imgHeight && col >= 0 && col < this.imgWidth) {
            // Draw continuous line if current position differs from last painted position
            if (this.lastPaintedRow !== row || this.lastPaintedCol !== col) {
                this.drawLine(this.lastPaintedRow, this.lastPaintedCol, row, col);
                this.lastPaintedRow = row;
                this.lastPaintedCol = col;
            }
        }
        e.preventDefault();
    }

    /**
     * Starts an interaction with the LED matrix dropdown when there's a pointerdown
     * within one of the pixels in the editor.
     */
    private onPointerDownInPixel(r: number, c: number) {
        // Toggle that pixel to the opposite of its value
        const newPixelValue = 1 - this.getPixel(r, c);
        this.setPixelBatch(r, c, newPixelValue);
        this.pointerIsDown = true;
        this.valToPaintWith = newPixelValue;

        // Immediately flush the first point update
        this.flushPendingUpdates();
    }

    /**
     * Resets pointer state.
     */
    private onPointerEnd() {
        // Ensure all pending updates are applied
        this.flushPendingUpdates();

        this.pointerIsDown = false;
        this.valToPaintWith = undefined;
        this.lastPaintedRow = -1;
        this.lastPaintedCol = -1;
    }

    /**
     * Sets the value of a particular pixel.
     */
    private setPixel(r: number, c: number, newValue: number) {
        const newGrid = JSON.parse(JSON.stringify(this.getValue()));
        newGrid[r][c] = newValue;
        this.fireIntermediateChangeEvent(newGrid);
        this.setValue(newGrid, false);
    }

    /**
     * Gets the value of a particular pixel.
     */
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
     */
    private createElementWithClassname(elementType: string, className: string) {
        const newElt = document.createElement(elementType);
        newElt.className = className;
        return newElt;
    }

    /**
     * Binds an event listener to the specified element.
     */
    private bindEvent(
        element: HTMLElement,
        eventName: string,
        callback: (e: PointerEvent) => void,
    ) {
        this.boundEvents.push(
            Blockly.browserEvents.bind(element, eventName, this, callback),
        );
    }

    /**
     * Fires an intermediate change event.
     */
    private fireIntermediateChangeEvent(newValue: number[][]) {
        if (this.getSourceBlock()) {
            Blockly.Events.fire(
                new (Blockly.Events.get(
                    Blockly.Events.BLOCK_FIELD_INTERMEDIATE_CHANGE,
                ))(this.getSourceBlock(), this.name || null, this.getValue(), newValue),
            );
        }
    }



    /**
     * Renders canvas editor.
     */
    private renderCanvasEditor() {
        if (!this.editorContext || !this.editorCanvas) return;
        const matrix = this.getValue();
        if (!matrix) return;

        // Clear canvas
        this.editorContext.clearRect(0, 0, this.editorCanvas.width, this.editorCanvas.height);

        // Draw grid and pixels
        for (let r = 0; r < this.imgHeight; r++) {
            for (let c = 0; c < this.imgWidth; c++) {
                const x = c * this.pixelSize;
                const y = r * this.pixelSize;

                // Draw pixel
                this.editorContext.fillStyle = matrix[r][c] ? this.pixelColours.filled : this.pixelColours.empty;
                this.editorContext.fillRect(x, y, this.pixelSize, this.pixelSize);

                // Draw border
                this.editorContext.strokeStyle = this.pixelColours.border;
                this.editorContext.lineWidth = 0.5;
                this.editorContext.strokeRect(x, y, this.pixelSize, this.pixelSize);
            }
        }
    }

    /**
     * Binds canvas events.
     */
    private bindCanvasEvents() {
        if (!this.editorCanvas) return;

        this.bindEvent(this.editorCanvas, 'pointermove', this.onPointerMove);
        this.bindEvent(this.editorCanvas, 'pointerup', this.onPointerEnd);
        this.bindEvent(this.editorCanvas, 'pointerleave', this.onPointerEnd);
        this.bindEvent(this.editorCanvas, 'pointerdown', this.onPointerStart);
        this.bindEvent(this.editorCanvas, 'pointercancel', this.onPointerEnd);

        // Prevent default behavior for touch events
        this.bindEvent(this.editorCanvas, 'touchmove', (e: Event) => {
            e.preventDefault();
        });
    }



    /**
     * Uses Bresenham's line algorithm to draw continuous lines between two points.
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
            // Draw current point
            if (r >= 0 && r < this.imgHeight && c >= 0 && c < this.imgWidth) {
                if (this.getPixel(r, c) !== this.valToPaintWith) {
                    this.setPixelBatch(r, c, this.valToPaintWith);
                }
            }

            // If we reach the end point, exit loop
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

        // Apply batch updates
        this.flushPendingUpdates();
    }

    /**
     * Batch set pixel value to improve performance.
     */
    private setPixelBatch(r: number, c: number, newValue: number) {
        const currentValue = this.getValue();
        if (!currentValue) return;

        // If value hasn't changed, skip
        if (currentValue[r][c] === newValue) return;

        // Record pixel to be updated
        const key = `${r},${c}`;
        this.pendingUpdates.add(key);

        // Immediately update data
        currentValue[r][c] = newValue;
    }

    /**
     * Apply all pending pixel updates in batch.
     */
    private flushPendingUpdates() {
        if (this.pendingUpdates.size === 0) return;

        // Clear previous timer
        if (this.updateTimer !== null) {
            clearTimeout(this.updateTimer);
        }

        // Set new timer, delay updates to improve performance
        this.updateTimer = window.setTimeout(() => {
            const currentValue = this.getValue();
            if (currentValue) {
                // Fire intermediate change event
                this.fireIntermediateChangeEvent(currentValue);

                // Update field value
                this.setValue(currentValue, false);

                // Immediately update canvas display
                if (this.editorCanvas && this.editorContext) {
                    this.renderCanvasEditor();
                }

                // Update block display
                this.updateBlockDisplayPixels();
            }

            this.pendingUpdates.clear();
            this.updateTimer = null;
        }, 16); // About 60fps update frequency
    }
}

interface Buttons {
    readonly fill: boolean;
    readonly clear: boolean;
}

interface PixelColours {
    readonly empty: string;
    readonly filled: string;
    readonly border: string;
}

export interface FieldLedMatrixFromJsonConfig extends Blockly.FieldConfig {
    value?: number[][];
    width?: number;
    height?: number;
    buttons?: Buttons;
    fieldHeight?: number;
    colours?: PixelColours;
}

Blockly.fieldRegistry.register('field_led_matrix', FieldLedMatrix);

/**
 * CSS for LED matrix field.
 */
Blockly.Css.register(`
.dropdownEditor-ledmatrix {
  align-items: center;
  flex-direction: column;
  display: flex;
  justify-content: center;
}
.dropdownEditor-ledmatrix.has-buttons-ledmatrix {
  padding-bottom: 5px;
}
.canvasContainer-ledmatrix {
  border: 2px solid #666;
  margin: 10px;
  display: inline-block;
  border-radius: 4px;
  background: #1a1a1a;
}
.ledmatrixCanvas {
  display: block;
  cursor: crosshair;
}
.buttonContainer-ledmatrix {
  display: flex;
  flex-direction: row;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.controlButton-ledmatrix {
  height: 28px;
  margin: 0;
  padding: 0 12px;
  color: #fff;
  border: 1px solid #666;
  border-radius: 4px;
  background: #333;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s ease;
}
.controlButton-ledmatrix:hover {
  background: #444;
  border-color: #888;
}
.controlButton-ledmatrix:active {
  background: #222;
  transform: translateY(1px);
}
.blocklyDropDownContent.contains-ledmatrix-editor {
  max-height: none;
  background: #2a2a2a;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
`);