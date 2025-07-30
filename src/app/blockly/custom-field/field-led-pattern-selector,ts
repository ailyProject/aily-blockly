/**
 * @license
 * Copyright 2024 Aily Blockly
 * SPDX-License-Identifier: Apache-2.0
 */

import * as Blockly from 'blockly/core';

export const DEFAULT_PATTERN_SIZE = 8;
const DEFAULT_PREVIEW_SIZE = 32; // 下拉选择器中预览图案的像素大小
const DEFAULT_BLOCK_DISPLAY_SIZE = 32; // 块上显示图案的像素大小
const DEFAULT_GRID_COLS = 5; // 网格列数
const DEFAULT_PIXEL_COLOURS: PatternColours = {
    empty: '#2a2a2a',
    filled: '#ffffff',
    border: '#666666',
    background: '#4a4a4a',
    selected: '#ff4444'
};

/**
 * Field for selecting LED matrix patterns from predefined options.
 * Shows a grid of pattern previews for selection.
 */
export class FieldLedPatternSelector extends Blockly.Field<number[][]> {
    private initialValue: number[][] | null = null;
    private patternWidth: number;
    private patternHeight: number;
    private presetPatterns: PresetPattern[];
    private selectedPatternIndex: number = 0;
    
    /**
     * Array holding info needed to unbind events.
     */
    private boundEvents: Blockly.browserEvents.Data[] = [];
    
    /** References to UI elements */
    private blockDisplayCanvas: HTMLCanvasElement | null = null;
    private blockDisplayContext: CanvasRenderingContext2D | null = null;
    private patternImage: SVGImageElement | null = null;
    
    pixelColours: PatternColours;
    previewSize: number;
    blockDisplaySize: number;
    gridCols: number;

    /**
     * Constructor for the LED pattern selector field.
     */
    constructor(
        value: number[][] | typeof Blockly.Field.SKIP_SETUP,
        validator?: Blockly.FieldValidator<number[][]>,
        config?: FieldLedPatternSelectorConfig,
    ) {
        super(value, validator, config);

        this.SERIALIZABLE = true;
        this.CURSOR = 'pointer';
        // 禁用默认的下拉箭头
        this.clickTarget_ = null;
        this.pixelColours = { ...DEFAULT_PIXEL_COLOURS, ...config?.colours };
        this.previewSize = config?.previewSize ?? DEFAULT_PREVIEW_SIZE;
        this.blockDisplaySize = config?.blockDisplaySize ?? DEFAULT_BLOCK_DISPLAY_SIZE;
        this.gridCols = config?.gridCols ?? DEFAULT_GRID_COLS;
        
        // 设置图案尺寸
        this.patternWidth = config?.patternWidth ?? DEFAULT_PATTERN_SIZE;
        this.patternHeight = config?.patternHeight ?? DEFAULT_PATTERN_SIZE;
        
        // 设置预设图案，支持 data 和 pattern 两种字段名
        const rawPatterns = config?.patterns ?? this.getDefaultPatterns();
        this.presetPatterns = rawPatterns.map(preset => ({
            name: preset.name,
            pattern: (preset as any).data || preset.pattern || []
        }));
        
        // 初始化值
        const currentValue = this.getValue();
        if (currentValue !== null && Array.isArray(currentValue)) {
            this.findMatchingPattern(currentValue);
        } else {
            // 设置默认值为第一个预设图案，如果没有预设图案则使用空图案
            const defaultPattern = (this.presetPatterns && this.presetPatterns.length > 0)
                ? this.presetPatterns[0].pattern
                : this.getEmptyPattern();
            this.setValue(defaultPattern);
        }
    }

    /**
     * Constructs a FieldLedPatternSelector from a JSON arg object.
     */
    static override fromJson(options: FieldLedPatternSelectorConfig) {
        return new this(
            options.value ?? Blockly.Field.SKIP_SETUP,
            undefined,
            options,
        );
    }

    /**
     * 获取默认图案集合
     */
    private getDefaultPatterns(): PresetPattern[] {
        return [
            {
                name: '空白',
                pattern: this.getEmptyPattern()
            },
            {
                name: '全亮',
                pattern: this.getFullPattern()
            },
            {
                name: '笑脸',
                pattern: [
                    [0, 0, 1, 1, 1, 1, 0, 0],
                    [0, 1, 0, 0, 0, 0, 1, 0],
                    [1, 0, 1, 0, 0, 1, 0, 1],
                    [1, 0, 0, 0, 0, 0, 0, 1],
                    [1, 0, 1, 0, 0, 1, 0, 1],
                    [1, 0, 0, 1, 1, 0, 0, 1],
                    [0, 1, 0, 0, 0, 0, 1, 0],
                    [0, 0, 1, 1, 1, 1, 0, 0]
                ]
            },
            {
                name: '心形',
                pattern: [
                    [0, 1, 1, 0, 0, 1, 1, 0],
                    [1, 1, 1, 1, 1, 1, 1, 1],
                    [1, 1, 1, 1, 1, 1, 1, 1],
                    [1, 1, 1, 1, 1, 1, 1, 1],
                    [0, 1, 1, 1, 1, 1, 1, 0],
                    [0, 0, 1, 1, 1, 1, 0, 0],
                    [0, 0, 0, 1, 1, 0, 0, 0],
                    [0, 0, 0, 0, 0, 0, 0, 0]
                ]
            },
            {
                name: '箭头上',
                pattern: [
                    [0, 0, 0, 1, 1, 0, 0, 0],
                    [0, 0, 1, 1, 1, 1, 0, 0],
                    [0, 1, 1, 1, 1, 1, 1, 0],
                    [1, 1, 1, 1, 1, 1, 1, 1],
                    [0, 0, 0, 1, 1, 0, 0, 0],
                    [0, 0, 0, 1, 1, 0, 0, 0],
                    [0, 0, 0, 1, 1, 0, 0, 0],
                    [0, 0, 0, 1, 1, 0, 0, 0]
                ]
            },
            {
                name: '箭头右',
                pattern: [
                    [0, 0, 0, 1, 0, 0, 0, 0],
                    [0, 0, 0, 1, 1, 0, 0, 0],
                    [0, 0, 0, 1, 1, 1, 0, 0],
                    [1, 1, 1, 1, 1, 1, 1, 0],
                    [1, 1, 1, 1, 1, 1, 1, 0],
                    [0, 0, 0, 1, 1, 1, 0, 0],
                    [0, 0, 0, 1, 1, 0, 0, 0],
                    [0, 0, 0, 1, 0, 0, 0, 0]
                ]
            }
        ];
    }

    /**
     * 获取空白图案
     */
    private getEmptyPattern(): number[][] {
        const pattern: number[][] = [];
        for (let r = 0; r < this.patternHeight; r++) {
            pattern.push([]);
            for (let c = 0; c < this.patternWidth; c++) {
                pattern[r].push(0);
            }
        }
        return pattern;
    }

    /**
     * 获取全亮图案
     */
    private getFullPattern(): number[][] {
        const pattern: number[][] = [];
        for (let r = 0; r < this.patternHeight; r++) {
            pattern.push([]);
            for (let c = 0; c < this.patternWidth; c++) {
                pattern[r].push(1);
            }
        }
        return pattern;
    }

    /**
     * 查找匹配的图案索引
     */
    private findMatchingPattern(pattern: number[][]): void {
        if (!pattern || !this.presetPatterns || this.presetPatterns.length === 0) {
            return;
        }

        for (let i = 0; i < this.presetPatterns.length; i++) {
            if (this.presetPatterns[i] && this.patternsEqual(pattern, this.presetPatterns[i].pattern)) {
                this.selectedPatternIndex = i;
                return;
            }
        }
        // 如果没有找到匹配的图案，保持当前选择
    }

    /**
     * 比较两个图案是否相等
     */
    private patternsEqual(pattern1: number[][], pattern2: number[][]): boolean {
        if (!pattern1 || !pattern2) return false;
        if (pattern1.length !== pattern2.length) return false;
        for (let r = 0; r < pattern1.length; r++) {
            if (!pattern1[r] || !pattern2[r]) return false;
            if (pattern1[r].length !== pattern2[r].length) return false;
            for (let c = 0; c < pattern1[r].length; c++) {
                if (pattern1[r][c] !== pattern2[r][c]) return false;
            }
        }
        return true;
    }

    /**
     * 验证新值
     */
    protected override doClassValidation_(
        newValue?: number[][],
    ): number[][] | null | undefined {
        if (!newValue) {
            return null;
        }
        
        if (!Array.isArray(newValue)) {
            return null;
        }
        
        const newHeight = newValue.length;
        if (newHeight == 0) {
            return null;
        }

        const newWidth = newValue[0].length;
        for (const row of newValue) {
            if (!Array.isArray(row)) {
                return null;
            }
            if (row.length !== newWidth) {
                return null;
            }
        }

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
     * 当新值被设置时调用
     */
    protected override doValueUpdate_(newValue: number[][]) {
        super.doValueUpdate_(newValue);
        if (newValue && Array.isArray(newValue)) {
            this.findMatchingPattern(newValue);
            this.updateBlockDisplay();
        }
    }

    /**
     * 显示图案选择器
     */
    protected override showEditor_(e?: Event) {
        const editor = this.createPatternSelector();

        // 设置 Blockly 下拉容器的样式，隐藏其滚动条
        const dropdownContent = Blockly.DropDownDiv.getContentDiv() as HTMLElement;
        dropdownContent.style.overflow = 'hidden';
        dropdownContent.style.padding = '0';
        dropdownContent.style.border = 'none';
        dropdownContent.style.background = 'transparent';

        dropdownContent.appendChild(editor);
        Blockly.DropDownDiv.showPositionedByField(
            this,
            this.dropdownDispose.bind(this),
        );
    }

    /**
     * 创建图案选择器
     */
    private createPatternSelector(): HTMLElement {
        const container = document.createElement('div');
        container.className = 'pattern-selector-container';
        // 计算容器最大宽度，基于预览尺寸和网格列数
        const estimatedItemWidth = this.previewSize + 32; // 预览尺寸 + 内边距
        const estimatedContainerWidth = (estimatedItemWidth * this.gridCols) + (12 * (this.gridCols - 1)) + 32; // 项目宽度 * 列数 + 间距 + 容器内边距
        const maxContainerWidth = Math.max(400, estimatedContainerWidth); // 至少400px

        container.style.cssText = `
            background: #6a4c93;
            border-radius: 8px;
            padding: 16px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            max-width: ${maxContainerWidth}px;
            max-height: 350px;
            overflow-y: auto;
            box-sizing: border-box;
        `;

        // 创建图案网格
        const grid = document.createElement('div');
        grid.className = 'pattern-grid';
        grid.style.cssText = `
            display: grid;
            grid-template-columns: repeat(${this.gridCols}, 1fr);
            gap: 12px;
            padding: 0;
            padding-bottom: 40px;
            box-sizing: border-box;
        `;

        // 添加每个预设图案
        this.presetPatterns.forEach((preset, index) => {
            const patternItem = this.createPatternItem(preset, index);
            grid.appendChild(patternItem);
        });

        container.appendChild(grid);

        // 确保容器能正确计算内容高度
        setTimeout(() => {
            const gridHeight = grid.scrollHeight;
            const containerPadding = 32; // 16px * 2 (top + bottom padding)
            const totalHeight = gridHeight + containerPadding;

            if (totalHeight > 350) {
                container.style.height = '350px';
            } else {
                container.style.height = 'auto';
                container.style.maxHeight = 'none';
            }
        }, 0);

        return container;
    }

    /**
     * 创建单个图案项
     */
    private createPatternItem(preset: PresetPattern, index: number): HTMLElement {
        const item = document.createElement('div');
        item.className = 'pattern-item';

        const isSelected = index === this.selectedPatternIndex;

        // 计算容器最小尺寸，基于图案比例
        const maxPreviewSize = this.previewSize;
        const patternAspectRatio = this.patternWidth / this.patternHeight;
        const minWidth = patternAspectRatio > 1 ? maxPreviewSize + 16 : (maxPreviewSize * patternAspectRatio) + 16;

        item.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 8px 8px 12px 8px;
            margin-bottom: 6px;
            border-radius: 6px;
            cursor: pointer;
            border: 2px solid ${isSelected ? '#ff6600' : 'transparent'};
            background: ${isSelected ? 'rgba(255, 102, 0, 0.2)' : 'rgba(255, 255, 255, 0.1)'};
            transition: all 0.2s ease;
            min-width: ${minWidth}px;
            min-height: 85px;
            box-sizing: border-box;
        `;

        // 创建图案预览canvas，保持正确的宽高比
        const canvas = document.createElement('canvas');

        let canvasWidth: number, canvasHeight: number;
        if (patternAspectRatio > 1) {
            // 宽度大于高度
            canvasWidth = maxPreviewSize;
            canvasHeight = maxPreviewSize / patternAspectRatio;
        } else {
            // 高度大于等于宽度
            canvasHeight = maxPreviewSize;
            canvasWidth = maxPreviewSize * patternAspectRatio;
        }

        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        canvas.style.cssText = `
            border: 1px solid #888;
            border-radius: 4px;
            background: #2a2a2a;
            width: ${canvasWidth}px;
            height: ${canvasHeight}px;
        `;

        // 绘制图案预览
        this.drawPatternPreview(canvas, preset.pattern);

        // 添加图案名称（可选，如果需要的话）
        const label = document.createElement('div');
        label.textContent = preset.name;
        label.style.cssText = `
            font-size: 10px;
            color: #fff;
            margin-top: 4px;
            text-align: center;
            max-width: 60px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        `;

        // 添加点击事件
        item.addEventListener('click', () => {
            this.selectPattern(index);
        });

        // 添加悬停效果
        item.addEventListener('mouseenter', () => {
            if (!isSelected) {
                item.style.background = 'rgba(255, 255, 255, 0.2)';
                item.style.transform = 'translateY(-2px)';
            }
        });

        item.addEventListener('mouseleave', () => {
            if (!isSelected) {
                item.style.background = 'rgba(255, 255, 255, 0.1)';
                item.style.transform = 'translateY(0)';
            }
        });

        item.appendChild(canvas);
        item.appendChild(label);
        return item;
    }

    /**
     * 绘制图案预览
     */
    private drawPatternPreview(canvas: HTMLCanvasElement, pattern: number[][]) {
        const ctx = canvas.getContext('2d');
        if (!ctx || !pattern || !Array.isArray(pattern) || pattern.length === 0) return;

        const rows = pattern.length;
        const cols = pattern[0]?.length || 1;
        const pixelWidth = canvas.width / cols;
        const pixelHeight = canvas.height / rows;

        // 清除canvas
        ctx.fillStyle = this.pixelColours.empty;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // 绘制图案
        for (let r = 0; r < rows; r++) {
            if (!pattern[r] || !Array.isArray(pattern[r])) continue;

            for (let c = 0; c < pattern[r].length; c++) {
                const x = c * pixelWidth;
                const y = r * pixelHeight;

                ctx.fillStyle = pattern[r][c] ? this.pixelColours.filled : this.pixelColours.empty;
                ctx.fillRect(x, y, pixelWidth, pixelHeight);

                // 绘制边框（如果像素足够大）
                if (pixelWidth > 2 && pixelHeight > 2) {
                    ctx.strokeStyle = this.pixelColours.border;
                    ctx.lineWidth = 0.5;
                    ctx.strokeRect(x, y, pixelWidth, pixelHeight);
                }
            }
        }
    }

    /**
     * 选择图案
     */
    private selectPattern(index: number) {
        if (index >= 0 && index < this.presetPatterns.length) {
            this.selectedPatternIndex = index;
            const selectedPattern = this.presetPatterns[index].pattern;
            this.setValue(JSON.parse(JSON.stringify(selectedPattern)));

            // 关闭选择器
            Blockly.DropDownDiv.hide();
        }
    }

    /**
     * 清理选择器
     */
    private dropdownDispose() {
        for (const event of this.boundEvents) {
            Blockly.browserEvents.unbind(event);
        }
        this.boundEvents.length = 0;
    }

    /**
     * 初始化块上的显示
     */
    override initView() {
        // 计算实际显示尺寸，保持宽高比
        const maxSize = this.blockDisplaySize;
        const aspectRatio = this.patternWidth / this.patternHeight;
        let displayWidth: number, displayHeight: number;

        if (aspectRatio > 1) {
            // 宽度大于高度
            displayWidth = maxSize;
            displayHeight = maxSize / aspectRatio;
        } else {
            // 高度大于等于宽度
            displayHeight = maxSize;
            displayWidth = maxSize * aspectRatio;
        }

        // 创建容器
        const container = Blockly.utils.dom.createSvgElement(
            'g',
            {},
            this.getSvgRoot(),
        );

        // 创建背景
        const background = Blockly.utils.dom.createSvgElement(
            'rect',
            {
                x: 0,
                y: 0,
                width: displayWidth + 20, // 为箭头留出空间
                height: Math.max(displayHeight + 4, 20),
                fill: '#4a4a4a',
                stroke: '#666666',
                'stroke-width': 1,
                rx: 3,
                ry: 3
            },
            container,
        );

        // 创建图案显示区域
        this.blockDisplayCanvas = document.createElement('canvas');
        this.blockDisplayCanvas.width = displayWidth;
        this.blockDisplayCanvas.height = displayHeight;

        this.blockDisplayContext = this.blockDisplayCanvas.getContext('2d');

        // 创建SVG image来显示图案
        this.patternImage = Blockly.utils.dom.createSvgElement(
            'image',
            {
                x: 2,
                y: 2,
                width: displayWidth,
                height: displayHeight,
            },
            container,
        ) as SVGImageElement;

        // 创建下拉箭头
        const arrowX = displayWidth + 6;
        const arrowY = Math.max(displayHeight + 4, 20) / 2;
        const arrow = Blockly.utils.dom.createSvgElement(
            'polygon',
            {
                points: `${arrowX},${arrowY-3} ${arrowX+6},${arrowY-3} ${arrowX+3},${arrowY+3}`,
                fill: '#ffffff',
                stroke: 'none'
            },
            container,
        );

        // 更新显示
        this.updateBlockDisplay();
    }



    /**
     * 更新块上的显示
     */
    private updateBlockDisplay() {
        if (!this.blockDisplayCanvas || !this.blockDisplayContext) return;

        const pattern = this.getValue();
        if (!pattern) return;

        this.drawPatternPreview(this.blockDisplayCanvas, pattern);

        // 更新SVG image
        if (this.patternImage) {
            const dataUrl = this.blockDisplayCanvas.toDataURL();
            this.patternImage.setAttributeNS('http://www.w3.org/1999/xlink', 'href', dataUrl);
        }
    }

    /**
     * 重写此方法以移除默认的下拉箭头样式
     */
    override updateEditable() {
        const editable = super.updateEditable();
        const svgRoot = this.getSvgRoot();
        if (svgRoot) {
            // 移除可能的下拉箭头类名
            svgRoot.classList.remove('blocklyEditableText');
            svgRoot.classList.remove('blocklyNonEditableText');
            svgRoot.style.cursor = 'pointer';
        }
        return editable;
    }

    /**
     * 更新字段大小
     */
    protected override updateSize_() {
        // 计算实际显示尺寸，保持宽高比
        const maxSize = this.blockDisplaySize;
        const aspectRatio = this.patternWidth / this.patternHeight;
        let displayWidth: number, displayHeight: number;

        if (aspectRatio > 1) {
            displayWidth = maxSize;
            displayHeight = maxSize / aspectRatio;
        } else {
            displayHeight = maxSize;
            displayWidth = maxSize * aspectRatio;
        }

        const width = displayWidth + 20; // 为箭头留出空间
        const height = Math.max(displayHeight + 4, 20);

        if (this.borderRect_) {
            this.borderRect_.setAttribute('width', String(width));
            this.borderRect_.setAttribute('height', String(height));
        }
        this.size_.width = width;
        this.size_.height = height;
    }

    /**
     * 渲染更新
     */
    protected override render_() {
        super.render_();
        this.updateBlockDisplay();
    }

    /**
     * 清理资源
     */
    override dispose() {
        this.blockDisplayCanvas = null;
        this.blockDisplayContext = null;
        this.patternImage = null;
        super.dispose();
    }
}

// 接口定义
interface PresetPattern {
    name: string;
    pattern: number[][];
}

interface PatternColours {
    readonly empty: string;
    readonly filled: string;
    readonly border: string;
    readonly background: string;
    readonly selected: string;
}

export interface FieldLedPatternSelectorConfig extends Blockly.FieldConfig {
    value?: number[][];
    patternWidth?: number;
    patternHeight?: number;
    patterns?: PresetPattern[];
    colours?: PatternColours;
    previewSize?: number;
    blockDisplaySize?: number;
    gridCols?: number;
}

// 注册字段
Blockly.fieldRegistry.register('field_led_pattern_selector', FieldLedPatternSelector);

/**
 * 使用示例和预设图案集合
 */
export const PRESET_PATTERN_COLLECTIONS = {
    // 基础图案集合
    basic: [
        {
            name: '空白',
            pattern: Array(8).fill(null).map(() => Array(8).fill(0))
        },
        {
            name: '全亮',
            pattern: Array(8).fill(null).map(() => Array(8).fill(1))
        },
        {
            name: '边框',
            pattern: [
                [1, 1, 1, 1, 1, 1, 1, 1],
                [1, 0, 0, 0, 0, 0, 0, 1],
                [1, 0, 0, 0, 0, 0, 0, 1],
                [1, 0, 0, 0, 0, 0, 0, 1],
                [1, 0, 0, 0, 0, 0, 0, 1],
                [1, 0, 0, 0, 0, 0, 0, 1],
                [1, 0, 0, 0, 0, 0, 0, 1],
                [1, 1, 1, 1, 1, 1, 1, 1]
            ]
        }
    ],

    // 表情图案集合
    emotions: [
        {
            name: '笑脸',
            pattern: [
                [0, 0, 1, 1, 1, 1, 0, 0],
                [0, 1, 0, 0, 0, 0, 1, 0],
                [1, 0, 1, 0, 0, 1, 0, 1],
                [1, 0, 0, 0, 0, 0, 0, 1],
                [1, 0, 1, 0, 0, 1, 0, 1],
                [1, 0, 0, 1, 1, 0, 0, 1],
                [0, 1, 0, 0, 0, 0, 1, 0],
                [0, 0, 1, 1, 1, 1, 0, 0]
            ]
        },
        {
            name: '哭脸',
            pattern: [
                [0, 0, 1, 1, 1, 1, 0, 0],
                [0, 1, 0, 0, 0, 0, 1, 0],
                [1, 0, 1, 0, 0, 1, 0, 1],
                [1, 0, 0, 0, 0, 0, 0, 1],
                [1, 0, 0, 1, 1, 0, 0, 1],
                [1, 0, 1, 0, 0, 1, 0, 1],
                [0, 1, 0, 0, 0, 0, 1, 0],
                [0, 0, 1, 1, 1, 1, 0, 0]
            ]
        }
    ],

    // 箭头图案集合
    arrows: [
        {
            name: '上箭头',
            pattern: [
                [0, 0, 0, 1, 1, 0, 0, 0],
                [0, 0, 1, 1, 1, 1, 0, 0],
                [0, 1, 1, 1, 1, 1, 1, 0],
                [1, 1, 1, 1, 1, 1, 1, 1],
                [0, 0, 0, 1, 1, 0, 0, 0],
                [0, 0, 0, 1, 1, 0, 0, 0],
                [0, 0, 0, 1, 1, 0, 0, 0],
                [0, 0, 0, 1, 1, 0, 0, 0]
            ]
        },
        {
            name: '右箭头',
            pattern: [
                [0, 0, 0, 1, 0, 0, 0, 0],
                [0, 0, 0, 1, 1, 0, 0, 0],
                [0, 0, 0, 1, 1, 1, 0, 0],
                [1, 1, 1, 1, 1, 1, 1, 0],
                [1, 1, 1, 1, 1, 1, 1, 0],
                [0, 0, 0, 1, 1, 1, 0, 0],
                [0, 0, 0, 1, 1, 0, 0, 0],
                [0, 0, 0, 1, 0, 0, 0, 0]
            ]
        }
    ],

    // 8x12 点阵图案集合
    matrix8x12: [
        {
            name: '8x12笑脸',
            pattern: [
                [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],  // 第1行 - 头部轮廓
                [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // 第2行 - 头部轮廓
                [1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1],  // 第3行 - 眼睛
                [1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1],  // 第4行 - 眼睛
                [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],  // 第5行 - 脸颊
                [1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1],  // 第6行 - 嘴巴开始
                [0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0],  // 第7行 - 嘴巴微笑
                [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]   // 第8行 - 下巴轮廓
            ]
        },
        {
            name: '8x12爱心',
            pattern: [
                [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0],  // 第1行
                [0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],  // 第2行
                [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],  // 第3行
                [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],  // 第4行
                [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],  // 第5行
                [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0],  // 第6行
                [0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],  // 第7行
                [0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]   // 第8行
            ]
        },
        {
            name: '8x12星星',
            pattern: [
                [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],  // 第1行
                [0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0],  // 第2行
                [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0],  // 第3行
                [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // 第4行
                [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],  // 第5行
                [0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],  // 第6行
                [0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 0, 0],  // 第7行
                [1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0]   // 第8行
            ]
        }
    ]
};

/**
 * 块定义示例
 */
export const PATTERN_SELECTOR_BLOCK_EXAMPLES = {
    // 基础图案选择器
    basic_pattern_selector: {
        "type": "led_pattern_basic",
        "message0": "LED图案 %1",
        "args0": [
            {
                "type": "field_led_pattern_selector",
                "name": "PATTERN",
                "patterns": PRESET_PATTERN_COLLECTIONS.basic
            }
        ],
        "output": "Array",
        "colour": 230,
        "tooltip": "选择基础LED图案",
        "helpUrl": ""
    },

    // 表情图案选择器
    emotion_pattern_selector: {
        "type": "led_pattern_emotion",
        "message0": "表情图案 %1",
        "args0": [
            {
                "type": "field_led_pattern_selector",
                "name": "PATTERN",
                "patterns": PRESET_PATTERN_COLLECTIONS.emotions,
                "colours": {
                    "empty": "#2a2a2a",
                    "filled": "#ffeb3b",
                    "border": "#666666",
                    "background": "#4a4a4a",
                    "selected": "#ff4444"
                }
            }
        ],
        "output": "Array",
        "colour": 45,
        "tooltip": "选择表情LED图案",
        "helpUrl": ""
    },

    // 8x12 点阵图案选择器
    matrix8x12_pattern_selector: {
        "type": "led_pattern_8x12",
        "message0": "8x12点阵图案 %1",
        "args0": [
            {
                "type": "field_led_pattern_selector",
                "name": "PATTERN",
                "patternWidth": 12,
                "patternHeight": 8,
                "patterns": PRESET_PATTERN_COLLECTIONS.matrix8x12,
                "gridCols": 3,
                "previewSize": 48,
                "blockDisplaySize": 40,
                "colours": {
                    "empty": "#1a1a1a",
                    "filled": "#00ff88",
                    "border": "#555555",
                    "background": "#333333",
                    "selected": "#ff6600"
                }
            }
        ],
        "output": "Array",
        "colour": 160,
        "tooltip": "选择8x12点阵LED图案",
        "helpUrl": ""
    }
};

/**
 * 8x12 点阵笑脸使用示例
 */
export const SMILE_8x12_EXAMPLE = {
    // 完整的8x12笑脸图案数据
    pattern: [
        [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],  // 第1行 - 头部轮廓
        [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // 第2行 - 头部轮廓
        [1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1],  // 第3行 - 眼睛
        [1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1],  // 第4行 - 眼睛
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],  // 第5行 - 脸颊
        [1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1],  // 第6行 - 嘴巴开始
        [0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0],  // 第7行 - 嘴巴微笑
        [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]   // 第8行 - 下巴轮廓
    ],

    // 在块定义中的使用方法
    blockDefinition: {
        "type": "display_smile_8x12",
        "message0": "显示8x12笑脸 %1",
        "args0": [
            {
                "type": "field_led_pattern_selector",
                "name": "SMILE_PATTERN",
                "patternWidth": 12,
                "patternHeight": 8,
                "patterns": [
                    {
                        "name": "开心笑脸",
                        "pattern": [
                            [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],
                            [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
                            [1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1],
                            [1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1],
                            [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                            [1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1],
                            [0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0],
                            [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]
                        ]
                    },
                    {
                        "name": "眨眼笑脸",
                        "pattern": [
                            [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],
                            [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
                            [1, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1],
                            [1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1],
                            [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                            [1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1],
                            [0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0],
                            [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]
                        ]
                    }
                ],
                "colours": {
                    "empty": "#000000",
                    "filled": "#ffff00",
                    "border": "#888888",
                    "background": "#2a2a2a",
                    "selected": "#ff4444"
                }
            }
        ],
        "previousStatement": null,
        "nextStatement": null,
        "colour": 60,
        "tooltip": "在8x12点阵屏上显示笑脸图案",
        "helpUrl": ""
    },

    // Arduino 代码生成示例
    arduinoCode: `
// 8x12 LED 矩阵笑脸显示
byte smilePattern[8][12] = {
  {0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0},  // 第1行
  {0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0},  // 第2行
  {1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1},  // 第3行
  {1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1},  // 第4行
  {1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1},  // 第5行
  {1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1},  // 第6行
  {0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0},  // 第7行
  {0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0}   // 第8行
};

void displaySmile() {
  for (int row = 0; row < 8; row++) {
    for (int col = 0; col < 12; col++) {
      if (smilePattern[row][col] == 1) {
        // 点亮LED
        setLED(row, col, HIGH);
      } else {
        // 熄灭LED
        setLED(row, col, LOW);
      }
    }
  }
}`,

    // Python 代码生成示例
    pythonCode: `
# 8x12 LED 矩阵笑脸显示
smile_pattern = [
    [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],  # 第1行
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  # 第2行
    [1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1],  # 第3行
    [1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1],  # 第4行
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],  # 第5行
    [1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1],  # 第6行
    [0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0],  # 第7行
    [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]   # 第8行
]

def display_smile():
    for row in range(8):
        for col in range(12):
            if smile_pattern[row][col] == 1:
                # 点亮LED
                set_led(row, col, True)
            else:
                # 熄灭LED
                set_led(row, col, False)`
};

/**
 * CSS for LED pattern selector field.
 */
Blockly.Css.register(`
.pattern-selector-container {
    font-family: sans-serif;
    background: #6a4c93 !important;
    border: 2px solid #8b5fbf;
}

.pattern-grid {
    background: transparent;
}

.pattern-item {
    transition: all 0.2s ease;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 6px;
}

.pattern-item:hover {
    background: rgba(255, 255, 255, 0.2) !important;
    transform: translateY(-2px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.pattern-item.selected {
    background: rgba(255, 102, 0, 0.2) !important;
    border: 2px solid #ff6600 !important;
}

.pattern-item canvas {
    transition: transform 0.2s ease;
    background: #2a2a2a;
    border: 1px solid #888;
}

.pattern-item:hover canvas {
    transform: scale(1.05);
}

/* 隐藏 Blockly 默认的下拉容器滚动条 */
.blocklyDropDownContent {
    overflow: hidden !important;
    padding: 0 !important;
    border: none !important;
    background: transparent !important;
}

/* 只在我们的容器上显示自定义滚动条 */
.pattern-selector-container {
    max-height: 350px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    scrollbar-color: #8b5fbf #6a4c93;
    box-sizing: border-box;
}

.pattern-selector-container::-webkit-scrollbar {
    width: 8px;
}

.pattern-selector-container::-webkit-scrollbar-track {
    background: #6a4c93;
    border-radius: 4px;
}

.pattern-selector-container::-webkit-scrollbar-thumb {
    background: #8b5fbf;
    border-radius: 4px;
    border: 1px solid #6a4c93;
}

.pattern-selector-container::-webkit-scrollbar-thumb:hover {
    background: #9d6fd3;
}

.pattern-selector-container::-webkit-scrollbar-corner {
    background: #6a4c93;
}

/* 确保网格内容正确显示 */
.pattern-grid {
    min-height: min-content;
    width: 100%;
    box-sizing: border-box;
}
`);