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
        // 禁用默认的下拉箭头
        this.clickTarget_ = null;
        this.pixelColours = { ...DEFAULT_PIXEL_COLOURS, ...config?.colours };
        this.previewSize = config?.previewSize ?? DEFAULT_PREVIEW_SIZE;
        this.blockDisplaySize = config?.blockDisplaySize ?? DEFAULT_BLOCK_DISPLAY_SIZE;
        this.gridCols = config?.gridCols ?? DEFAULT_GRID_COLS;
        
        // 设置图案尺寸
        this.patternWidth = config?.patternWidth ?? DEFAULT_PATTERN_SIZE;
        this.patternHeight = config?.patternHeight ?? DEFAULT_PATTERN_SIZE;
        
        // 设置预设图案，支持 data、pattern 和 hex 三种字段名
        const rawPatterns = config?.patterns ?? this.getDefaultPatterns();
        this.presetPatterns = rawPatterns.map(preset => {
            let pattern: number[][];

            // 检查是否有十六进制格式的数据
            if ((preset as any).hex && Array.isArray((preset as any).hex)) {
                try {
                    pattern = FieldLedPatternSelector.hexArrayToPattern(
                        (preset as any).hex,
                        this.patternWidth,
                        this.patternHeight
                    );
                } catch (error) {
                    console.warn(`Failed to parse hex pattern for "${preset.name}":`, error);
                    pattern = this.getEmptyPattern();
                }
            } else {
                // 使用原有的 data 或 pattern 字段
                pattern = (preset as any).data || preset.pattern || [];
            }

            return {
                name: preset.name,
                pattern: pattern
            };
        });
        
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
     * 将十六进制数组转换为二维数组格式
     * 支持格式: [0x7f, 0xed437fe0, 0x0] 或 ["0x7f", "0xed437fe0", "0x0"]
     *
     * 基于Arduino R4正确的转换逻辑：
     * - 每个uint32值从最高位(bit 31)开始提取到最低位(bit 0)
     * - 按行优先顺序填充矩阵
     * - 修复了"左移3列"的显示问题
     */
    static hexArrayToPattern(hexArray: (number | string)[], width: number, height: number): number[][] {
        if (!Array.isArray(hexArray) || hexArray.length === 0) {
            throw new Error('Invalid hex array');
        }

        const pattern: number[][] = [];

        // 将所有十六进制值转换为位数组（基于Arduino R4正确逻辑）
        const bits: number[] = [];
        for (const hex of hexArray) {
            let hexValue: number;
            if (typeof hex === 'string') {
                hexValue = parseInt(hex, 16);
            } else {
                hexValue = hex;
            }

            if (isNaN(hexValue)) {
                throw new Error(`Invalid hex value: ${hex}`);
            }

            // 从最高位(bit 31)开始提取到最低位(bit 0)
            for (let bit = 31; bit >= 0; bit--) {
                bits.push((hexValue >> bit) & 1);
            }
        }

        // 将位数组映射到矩阵 (按行填充)
        const totalBits = width * height;
        for (let row = 0; row < height; row++) {
            pattern[row] = [];
            for (let col = 0; col < width; col++) {
                const bitIndex = row * width + col;
                if (bitIndex < bits.length && bitIndex < totalBits) {
                    pattern[row][col] = bits[bitIndex];
                } else {
                    pattern[row][col] = 0;
                }
            }
        }

        return pattern;
    }

    /**
     * 将二维数组格式转换为十六进制数组
     */
    static patternToHexArray(pattern: number[][], bitsPerHex: number = 32): (string | number)[] {
        if (!pattern || !Array.isArray(pattern) || pattern.length === 0) {
            return [];
        }

        // 将二维数组转换为一维二进制字符串
        let binaryString = '';
        for (let row = 0; row < pattern.length; row++) {
            if (!pattern[row] || !Array.isArray(pattern[row])) continue;
            for (let col = 0; col < pattern[row].length; col++) {
                binaryString += (pattern[row][col] ? '1' : '0');
            }
        }

        // 按指定位数分组转换为十六进制
        const hexArray: string[] = [];
        for (let i = 0; i < binaryString.length; i += bitsPerHex) {
            const chunk = binaryString.slice(i, i + bitsPerHex);
            const paddedChunk = chunk.padEnd(bitsPerHex, '0'); // 右侧补0
            const hexValue = parseInt(paddedChunk, 2);
            hexArray.push('0x' + hexValue.toString(16).toUpperCase());
        }

        return hexArray;
    }

    /**
     * 验证新值
     */
    protected override doClassValidation_(
        newValue?: number[][] | (number | string)[],
    ): number[][] | null | undefined {
        if (!newValue) {
            return null;
        }

        // 检查是否为十六进制数组格式
        if (Array.isArray(newValue) && newValue.length > 0) {
            const firstElement = newValue[0];

            // 如果第一个元素是数字或十六进制字符串，尝试作为十六进制数组处理
            if (typeof firstElement === 'number' ||
                (typeof firstElement === 'string' && firstElement.startsWith('0x'))) {
                try {
                    const pattern = FieldLedPatternSelector.hexArrayToPattern(
                        newValue as (number | string)[],
                        this.patternWidth,
                        this.patternHeight
                    );
                    return this.validatePattern(pattern);
                } catch (error) {
                    console.warn('Failed to parse hex array:', error);
                    return null;
                }
            }
        }

        // 原有的二维数组验证逻辑
        if (!Array.isArray(newValue)) {
            return null;
        }

        return this.validatePattern(newValue as number[][]);
    }

    /**
     * 验证图案格式
     */
    private validatePattern(pattern: number[][]): number[][] | null {
        if (!pattern || !Array.isArray(pattern)) {
            return null;
        }

        const newHeight = pattern.length;
        if (newHeight == 0) {
            return null;
        }

        const newWidth = pattern[0]?.length || 0;
        for (const row of pattern) {
            if (!Array.isArray(row)) {
                return null;
            }
            if (row.length !== newWidth) {
                return null;
            }
        }

        for (const row of pattern) {
            for (const cell of row) {
                if (cell !== 0 && cell !== 1) {
                    return null;
                }
            }
        }
        return pattern;
    }

    /**
     * 从十六进制数组设置值
     * 使用示例: field.setValueFromHex([0x7f, 0xed437fe0, 0x0])
     */
    setValueFromHex(hexArray: (number | string)[]): void {
        try {
            const pattern = FieldLedPatternSelector.hexArrayToPattern(
                hexArray,
                this.patternWidth,
                this.patternHeight
            );
            this.setValue(pattern);
        } catch (error) {
            console.error('Failed to set value from hex array:', error);
        }
    }

    /**
     * 获取当前值的十六进制数组表示
     */
    getValueAsHex(bitsPerHex: number = 32): (string | number)[] {
        const pattern = this.getValue();
        if (!pattern) {
            return [];
        }
        return FieldLedPatternSelector.patternToHexArray(pattern, bitsPerHex);
    }

    /**
     * 获取当前选中图案的名称
     */
    getSelectedPatternName(): string | null {
        if (this.selectedPatternIndex >= 0 &&
            this.selectedPatternIndex < this.presetPatterns.length &&
            this.presetPatterns[this.selectedPatternIndex]) {
            return this.presetPatterns[this.selectedPatternIndex].name;
        }
        return null;
    }

    /**
     * 获取当前选中图案的完整信息
     */
    getSelectedPatternInfo(): { name: string; pattern: number[][]; index: number } | null {
        if (this.selectedPatternIndex >= 0 &&
            this.selectedPatternIndex < this.presetPatterns.length &&
            this.presetPatterns[this.selectedPatternIndex]) {
            const preset = this.presetPatterns[this.selectedPatternIndex];
            return {
                name: preset.name,
                pattern: preset.pattern,
                index: this.selectedPatternIndex
            };
        }
        return null;
    }

    /**
     * 根据图案查找对应的名称
     */
    getPatternName(pattern?: number[][]): string | null {
        const targetPattern = pattern || this.getValue();
        if (!targetPattern) {
            return null;
        }

        // 查找匹配的预设图案
        for (let i = 0; i < this.presetPatterns.length; i++) {
            if (this.presetPatterns[i] && this.patternsEqual(targetPattern, this.presetPatterns[i].pattern)) {
                return this.presetPatterns[i].name;
            }
        }

        return null; // 没有找到匹配的预设图案
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

        // 让最外层的Blockly下拉容器处理滚动
        const dropdownContent = Blockly.DropDownDiv.getContentDiv() as HTMLElement;
        dropdownContent.style.padding = '0';
        dropdownContent.style.border = 'none';
        dropdownContent.style.background = 'transparent';
        dropdownContent.style.maxHeight = '350px';
        dropdownContent.style.overflowY = 'auto';
        dropdownContent.style.overflowX = 'hidden';

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
            overflow: visible;
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
            padding-bottom: 0px;
            box-sizing: border-box;
        `;

        // 添加每个预设图案
        this.presetPatterns.forEach((preset, index) => {
            const patternItem = this.createPatternItem(preset, index);
            grid.appendChild(patternItem);
        });

        container.appendChild(grid);

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
            svgRoot.classList.remove('blocklyEditableField');
            svgRoot.classList.remove('blocklyNonEditableField');
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
    pattern?: number[][];
    hex?: (number | string)[]; // 支持十六进制格式
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
    // 基础图案集合 - 使用十六进制格式
    basic: [
        {
            name: '空白',
            hex: [0x00000000, 0x00000000]
        },
        {
            name: '全亮',
            hex: [0xFFFFFFFF, 0xFFFFFFFF]
        },
        {
            name: '边框',
            hex: [0xFF818181, 0x818181FF]
        },
        {
            name: '十字',
            hex: [0x18181818, 0xFF181818]
        }
    ],

    // 表情图案集合 - 使用十六进制格式
    emotions: [
        {
            name: '笑脸',
            hex: [0x3C424299, 0xA5817E3C]
        },
        {
            name: '哭脸',
            hex: [0x3C424299, 0x99A5423C]
        },
        {
            name: '眨眼',
            hex: [0x3C427A99, 0xA5817E3C]
        },
        {
            name: '惊讶',
            hex: [0x3C424299, 0x81993C3C]
        }
    ],

    // 箭头图案集合 - 使用十六进制格式
    arrows: [
        {
            name: '上箭头',
            hex: [0x18247E18, 0x18181800]
        },
        {
            name: '下箭头',
            hex: [0x00181818, 0x187E2418]
        },
        {
            name: '左箭头',
            hex: [0x08183878, 0x18080000]
        },
        {
            name: '右箭头',
            hex: [0x10181C18, 0x10000000]
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
 * 十六进制格式支持工具函数
 */
export const HEX_PATTERN_UTILS = {
    /**
     * 将十六进制数组转换为LED图案
     * 示例: hexToPattern([0x7f, 0xed437fe0, 0x0], 8, 8)
     */
    hexToPattern: (hexArray: (number | string)[], width: number, height: number): number[][] => {
        return FieldLedPatternSelector.hexArrayToPattern(hexArray, width, height);
    },

    /**
     * 将LED图案转换为十六进制数组
     * 示例: patternToHex(pattern, 32)
     */
    patternToHex: (pattern: number[][], bitsPerHex: number = 32): (string | number)[] => {
        return FieldLedPatternSelector.patternToHexArray(pattern, bitsPerHex);
    },

    /**
     * 常用的十六进制图案示例
     */
    examples: {
        // 8x8 笑脸 (64位，可以用两个32位十六进制数表示)
        smile8x8: [0x3C424299, 0xA5817E00], // 对应 {0x3C424299, 0xA5817E00}

        // 8x8 心形
        heart8x8: [0x66FFFF7E, 0x3C180000], // 对应 {0x66FFFF7E, 0x3C180000}

        // 8x8 箭头向上
        arrowUp8x8: [0x18247E18, 0x18181800], // 对应 {0x18247E18, 0x18181800}

        // 8x8 全亮
        full8x8: [0xFFFFFFFF, 0xFFFFFFFF], // 对应 {0xFFFFFFFF, 0xFFFFFFFF}

        // 8x8 空白
        empty8x8: [0x00000000, 0x00000000], // 对应 {0x00000000, 0x00000000}
    }
};

/**
 * 简化的使用示例 - 现在可以直接使用十六进制格式！
 */
export const SIMPLE_HEX_EXAMPLES = {
    /**
     * 最简单的使用方式 - 直接在patterns中使用hex字段
     */
    simpleUsage: `
// 现在可以直接这样使用，无需调用转换函数！
{
    "type": "field_led_pattern_selector",
    "name": "PATTERN",
    "patterns": [
        {
            "name": "笑脸",
            "hex": [0x7f, 0xed437fe0, 0x0]  // 直接使用您的格式！
        },
        {
            "name": "心形",
            "hex": [0x66FFFF7E, 0x3C180000]
        }
    ]
}
`,

    /**
     * 支持的所有格式
     */
    supportedFormats: `
// 支持多种十六进制格式：
patterns: [
    {
        "name": "数字格式",
        "hex": [0x7f, 0xed437fe0, 0x0]
    },
    {
        "name": "字符串格式",
        "hex": ["0x7f", "0xed437fe0", "0x0"]
    },
    {
        "name": "混合格式",
        "hex": [0x7f, "0xed437fe0", 0x0]
    },
    {
        "name": "传统格式仍然支持",
        "pattern": [[1,0,1,0], [0,1,0,1]]
    }
]
`
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

/* 内部容器不需要滚动条，由外层Blockly容器处理滚动 */
.pattern-selector-container {
    overflow: visible;
    box-sizing: border-box;
}

/* 确保网格内容正确显示 */
.pattern-grid {
    min-height: min-content;
    width: 100%;
    box-sizing: border-box;
}
`);

/**
 * 十六进制格式使用示例
 */
export const HEX_FORMAT_EXAMPLES = {
    /**
     * 基本使用方法
     */
    basicUsage: `
// 1. 创建支持十六进制输入的LED图案选择器
const field = new FieldLedPatternSelector(
    Blockly.Field.SKIP_SETUP,
    undefined,
    {
        patternWidth: 8,
        patternHeight: 8,
        patterns: [
            {
                name: '笑脸',
                pattern: FieldLedPatternSelector.hexArrayToPattern([0x3C424299, 0xA5817E00], 8, 8)
            }
        ]
    }
);

// 2. 从十六进制数组设置值
field.setValueFromHex([0x7f, 0xed437fe0, 0x0]);

// 3. 获取十六进制格式的值
const hexValue = field.getValueAsHex(32);
console.log(hexValue); // ['0x7F000000', '0xED437FE0', '0x00000000']
`,

    /**
     * 在块定义中使用十六进制格式
     */
    blockDefinition: `
// 支持十六进制输入的块定义 - 现在可以直接使用hex字段！
{
    "type": "led_pattern_hex",
    "message0": "LED图案(十六进制) %1",
    "args0": [
        {
            "type": "field_led_pattern_selector",
            "name": "PATTERN",
            "patternWidth": 8,
            "patternHeight": 8,
            "patterns": [
                {
                    "name": "笑脸",
                    "hex": [0x3C424299, 0xA5817E00]
                },
                {
                    "name": "心形",
                    "hex": [0x66FFFF7E, 0x3C180000]
                },
                {
                    "name": "箭头上",
                    "hex": [0x18247E18, 0x18181800]
                },
                {
                    "name": "传统格式",
                    "pattern": [[1,0,1,0],[0,1,0,1],[1,0,1,0],[0,1,0,1]]
                }
            ]
        }
    ],
    "output": "Array",
    "colour": 230
}
`,

    /**
     * 代码生成器示例
     */
    codeGenerator: `
// Arduino 代码生成器 - 现在可以获取图案名称！
Blockly.Arduino['led_pattern_hex'] = function(block) {
    const field = block.getField('PATTERN');
    const hexArray = field.getValueAsHex(8); // 每8位一个十六进制数
    const patternName = field.getSelectedPatternName(); // 获取图案名称

    const hexString = hexArray.map(hex =>
        typeof hex === 'string' ? hex : '0x' + hex.toString(16).toUpperCase()
    ).join(', ');

    // 生成带注释的代码
    const comment = patternName ? \`// \${patternName} 图案\` : '';
    const code = \`{\${hexString}} \${comment}\`;

    return [code, Blockly.Arduino.ORDER_ATOMIC];
};

// 生成的代码示例:
// {0x7F, 0xED, 0x43, 0x7F, 0xE0, 0x00, 0x00, 0x00} // 蓝牙 图案

// 或者生成常量定义：
Blockly.Arduino['led_pattern_const'] = function(block) {
    const field = block.getField('PATTERN');
    const patternInfo = field.getSelectedPatternInfo();

    if (patternInfo) {
        const hexArray = field.getValueAsHex(32);
        const constName = patternInfo.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        return \`const uint32_t PATTERN_\${constName}[] = {\${hexArray.join(', ')}};\`;
    }
    return '';
};

// 生成的代码示例:
// const uint32_t PATTERN_BLUETOOTH[] = {0x10428, 0xA4517FF0, 0x50088104};
`,

    /**
     * 常用十六进制图案
     */
    commonPatterns: {
        // 8x8 图案 (64位，分为8个8位十六进制数)
        patterns8x8: {
            smile: [0x3C, 0x42, 0x42, 0x99, 0xA5, 0x81, 0x7E, 0x00],
            heart: [0x66, 0xFF, 0xFF, 0x7E, 0x3C, 0x18, 0x00, 0x00],
            arrowUp: [0x18, 0x24, 0x7E, 0x18, 0x18, 0x18, 0x18, 0x00],
            arrowDown: [0x00, 0x18, 0x18, 0x18, 0x18, 0x7E, 0x24, 0x18],
            arrowLeft: [0x00, 0x08, 0x18, 0x38, 0x18, 0x08, 0x00, 0x00],
            arrowRight: [0x00, 0x10, 0x18, 0x1C, 0x18, 0x10, 0x00, 0x00],
            cross: [0x18, 0x18, 0x18, 0xFF, 0xFF, 0x18, 0x18, 0x18],
            circle: [0x3C, 0x42, 0x81, 0x81, 0x81, 0x81, 0x42, 0x3C],
            square: [0xFF, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xFF],
            diamond: [0x18, 0x3C, 0x7E, 0xFF, 0xFF, 0x7E, 0x3C, 0x18]
        },

        // 8x8 图案 (64位，分为2个32位十六进制数)
        patterns8x8_32bit: {
            smile: [0x3C424299, 0xA5817E00],
            heart: [0x66FFFF7E, 0x3C180000],
            arrowUp: [0x18247E18, 0x18181800],
            full: [0xFFFFFFFF, 0xFFFFFFFF],
            empty: [0x00000000, 0x00000000]
        }
    }
};

/**
 * 工具函数：验证十六进制数组格式
 */
export function validateHexArray(hexArray: any[]): boolean {
    if (!Array.isArray(hexArray)) return false;

    return hexArray.every(item => {
        if (typeof item === 'number') {
            return Number.isInteger(item) && item >= 0;
        }
        if (typeof item === 'string') {
            return /^0x[0-9A-Fa-f]+$/.test(item);
        }
        return false;
    });
}

/**
 * 工具函数：格式化十六进制数组为字符串
 */
export function formatHexArray(hexArray: (number | string)[]): string {
    return '{' + hexArray.map(hex => {
        if (typeof hex === 'string') return hex;
        return '0x' + hex.toString(16).toUpperCase();
    }).join(', ') + '}';
}

/**
 * 获取图案名称的使用示例
 */
export const PATTERN_NAME_EXAMPLES = {
    /**
     * 基本使用方法
     */
    basicUsage: `
// 1. 获取当前选中图案的名称
const field = block.getField('PATTERN');
const patternName = field.getSelectedPatternName();
console.log('当前图案:', patternName); // 输出: "蓝牙" 或 "笑脸" 等

// 2. 获取完整的图案信息
const patternInfo = field.getSelectedPatternInfo();
if (patternInfo) {
    console.log('图案名称:', patternInfo.name);
    console.log('图案数据:', patternInfo.pattern);
    console.log('图案索引:', patternInfo.index);
}

// 3. 根据图案数组查找名称
const customPattern = [[1,0,1], [0,1,0], [1,0,1]];
const name = field.getPatternName(customPattern);
console.log('图案名称:', name); // 如果匹配预设图案则返回名称，否则返回null
`,

    /**
     * 在代码生成器中使用
     */
    codeGeneratorUsage: `
// 生成带图案名称注释的Arduino代码
Blockly.Arduino['display_led_pattern'] = function(block) {
    const field = block.getField('PATTERN');
    const patternName = field.getSelectedPatternName();
    const hexArray = field.getValueAsHex(32);

    const arrayStr = hexArray.join(', ');
    const comment = patternName ? \` // \${patternName}图案\` : '';

    return \`uint32_t pattern[] = {\${arrayStr}};\${comment}\\n\`;
};

// 生成的代码:
// uint32_t pattern[] = {0x10428, 0xA4517FF0, 0x50088104}; // 蓝牙图案
`,

    /**
     * 在事件处理中使用
     */
    eventHandlerUsage: `
// 监听图案变化事件
field.setValidator(function(newValue) {
    const patternName = this.getPatternName(newValue);
    if (patternName) {
        console.log('选择了预设图案:', patternName);
        // 可以根据图案名称执行特定逻辑
        if (patternName === '蓝牙') {
            // 蓝牙图案的特殊处理
        }
    } else {
        console.log('选择了自定义图案');
    }
    return newValue;
});
`,

    /**
     * 动态更新图案名称显示
     */
    dynamicDisplayUsage: `
// 在UI中显示当前图案名称
function updatePatternDisplay() {
    const field = block.getField('PATTERN');
    const patternName = field.getSelectedPatternName();

    const displayElement = document.getElementById('pattern-name');
    if (patternName) {
        displayElement.textContent = \`当前图案: \${patternName}\`;
        displayElement.className = 'preset-pattern';
    } else {
        displayElement.textContent = '自定义图案';
        displayElement.className = 'custom-pattern';
    }
}
`
};
