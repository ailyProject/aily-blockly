/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as Blockly from 'blockly/core';
import { GlobalServiceManager } from '../global-service-manager';

Blockly.Msg['BUTTON_LABEL_BROWSE'] = '打开';
Blockly.Msg['BUTTON_LABEL_CLEAR'] = '清除';

export const DEFAULT_WIDTH = 100;
export const DEFAULT_HEIGHT = 100;
const DEFAULT_PREVIEW_SIZE = 150;

/**
 * 图片预览字段，支持文件选择、预览和尺寸调整
 */
export class FieldImagePreview extends Blockly.Field<ImagePreviewValue> {
    private initialValue: ImagePreviewValue | null = null;
    private globalServiceManager: GlobalServiceManager;
    private fieldId: string;
    
    // UI元素引用
    private previewContainer: HTMLElement | null = null;
    private previewImage: HTMLImageElement | null = null;
    private filePathInput: HTMLInputElement | null = null;
    private widthInput: HTMLInputElement | null = null;
    private heightInput: HTMLInputElement | null = null;
    private xInput: HTMLInputElement | null = null;
    private yInput: HTMLInputElement | null = null;
    private screenWidthInput: HTMLInputElement | null = null;
    private screenHeightInput: HTMLInputElement | null = null;
    private rotationSelect: HTMLSelectElement | null = null;
    private blockDisplayImage: SVGImageElement | null = null;
    
    // 事件绑定数组
    private boundEvents: Blockly.browserEvents.Data[] = [];
    
    // 配置选项
    previewSize: number;

    /**
     * 构造函数
     */
    constructor(
        value: ImagePreviewValue | typeof Blockly.Field.SKIP_SETUP,
        validator?: Blockly.FieldValidator<ImagePreviewValue>,
        config?: FieldImagePreviewConfig,
    ) {
        super(value, validator, config);
        
        this.SERIALIZABLE = true;
        this.previewSize = config?.previewSize ?? DEFAULT_PREVIEW_SIZE;
        
        // 生成唯一ID
        this.fieldId = 'field_image_preview_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        
        // 初始化全局服务管理器
        this.globalServiceManager = GlobalServiceManager.getInstance();
        
        // 设置默认值
        const currentValue = this.getValue();
        if (!currentValue) {
            this.setValue({
                filePath: '',
                width: config?.defaultWidth ?? DEFAULT_WIDTH,
                height: config?.defaultHeight ?? DEFAULT_HEIGHT,
                imageData: null
            });
        }
    }

    /**
     * 从JSON配置创建字段实例
     */
    static override fromJson(options: FieldImagePreviewConfig) {
        return new this(
            options.value ?? Blockly.Field.SKIP_SETUP,
            undefined,
            options,
        );
    }

    /**
     * 验证新值
     */
    protected override doClassValidation_(
        newValue: ImagePreviewValue,
    ): ImagePreviewValue | null {
        if (!newValue || typeof newValue !== 'object') {
            return null;
        }
        
        // 确保必要的属性存在
        return {
            filePath: newValue.filePath || '',
            width: Math.max(1, Math.min(1000, newValue.width || DEFAULT_WIDTH)),
            height: Math.max(1, Math.min(1000, newValue.height || DEFAULT_HEIGHT)),
            imageData: newValue.imageData || null
        };
    }

    /**
     * 显示编辑器
     */
    protected override showEditor_(e?: Event) {
        const editor = this.createEditor();
        Blockly.DropDownDiv.getContentDiv().appendChild(editor);
        Blockly.DropDownDiv.showPositionedByField(
            this,
            this.disposeEditor.bind(this),
        );
    }

    /**
     * 创建编辑器界面
     */
    private createEditor(): HTMLElement {
        const editor = this.createElement('div', 'imagePreviewEditor');
        
        // 创建文件选择区域
        const fileSection = this.createFileSection();
        editor.appendChild(fileSection);
        
        // 创建尺寸控制区域
        const sizeSection = this.createSizeSection();
        editor.appendChild(sizeSection);

        // 创建坐标控制区域
        const positionSection = this.createPositionSection();
        editor.appendChild(positionSection);

        // 创建屏幕设置区域
        const screenSection = this.createScreenSection();
        editor.appendChild(screenSection);

        // 创建预览区域
        const previewSection = this.createPreviewSection();
        editor.appendChild(previewSection);
        
        // 创建按钮区域
        const buttonSection = this.createButtonSection();
        editor.appendChild(buttonSection);
        
        // 存储初始值
        this.initialValue = this.getValue();
        
        return editor;
    }

    /**
     * 创建文件选择区域
     */
    private createFileSection(): HTMLElement {
        const section = this.createElement('div', 'fileSection');
        
        const label = this.createElement('label', 'sectionLabel');
        label.textContent = '图像地址';
        section.appendChild(label);
        
        const inputContainer = this.createElement('div', 'inputContainer');
        
        this.filePathInput = document.createElement('input');
        this.filePathInput.type = 'text';
        this.filePathInput.className = 'filePathInput';
        this.filePathInput.placeholder = '点击"打开"选择图片文件...';
        this.filePathInput.value = this.getValue()?.filePath || '';
        this.filePathInput.style.color = '#333';
        this.filePathInput.style.backgroundColor = '#fff';
        this.filePathInput.style.border = '2px solid #007acc';
        this.filePathInput.style.padding = '8px 12px';
        this.filePathInput.style.fontSize = '14px';
        this.filePathInput.style.borderRadius = '6px';
        this.filePathInput.style.transition = 'all 0.2s ease';
        this.bindEvent(this.filePathInput, 'input', this.onFilePathChange.bind(this));
        this.bindEvent(this.filePathInput, 'blur', this.onFilePathBlur.bind(this));
        this.bindEvent(this.filePathInput, 'keydown', this.onFilePathKeydown.bind(this));
        inputContainer.appendChild(this.filePathInput);
        
        const browseButton = this.createElement('button', 'browseButton');
        browseButton.textContent = '📁 ' + Blockly.Msg['BUTTON_LABEL_BROWSE'];
        this.bindEvent(browseButton, 'click', this.openFileDialog.bind(this));
        inputContainer.appendChild(browseButton);

        // 添加提示文字
        const hintText = this.createElement('div', 'hintText');
        hintText.textContent = '💡 点击"打开"按钮选择图片文件';
        hintText.style.fontSize = '12px';
        hintText.style.color = '#666';
        hintText.style.marginTop = '4px';
        hintText.style.fontStyle = 'italic';
        section.appendChild(hintText);
        
        section.appendChild(inputContainer);
        
        return section;
    }

    /**
     * 创建尺寸控制区域
     */
    private createSizeSection(): HTMLElement {
        const section = this.createElement('div', 'sizeSection');

        const label = this.createElement('label', 'sectionLabel');
        label.textContent = '图像尺寸';
        section.appendChild(label);

        const sizeContainer = this.createElement('div', 'sizeContainer');

        // 宽度输入
        const widthLabel = this.createElement('span', 'sizeLabel');
        widthLabel.textContent = '宽:';
        sizeContainer.appendChild(widthLabel);

        this.widthInput = document.createElement('input');
        this.widthInput.type = 'number';
        this.widthInput.className = 'sizeInput';
        this.widthInput.min = '1';
        this.widthInput.max = '1000';
        this.widthInput.value = (this.getValue()?.width || DEFAULT_WIDTH).toString();
        this.widthInput.style.color = '#333';
        this.widthInput.style.backgroundColor = '#fff';
        this.widthInput.style.border = '1px solid #ddd';
        this.widthInput.style.padding = '4px 8px';
        this.widthInput.style.fontSize = '14px';
        this.widthInput.style.borderRadius = '4px';
        this.bindEvent(this.widthInput, 'input', this.onSizeChange.bind(this));
        sizeContainer.appendChild(this.widthInput);

        // 高度输入
        const heightLabel = this.createElement('span', 'sizeLabel');
        heightLabel.textContent = '高:';
        sizeContainer.appendChild(heightLabel);

        this.heightInput = document.createElement('input');
        this.heightInput.type = 'number';
        this.heightInput.className = 'sizeInput';
        this.heightInput.min = '1';
        this.heightInput.max = '1000';
        this.heightInput.value = (this.getValue()?.height || DEFAULT_HEIGHT).toString();
        this.heightInput.style.color = '#333';
        this.heightInput.style.backgroundColor = '#fff';
        this.heightInput.style.border = '1px solid #ddd';
        this.heightInput.style.padding = '4px 8px';
        this.heightInput.style.fontSize = '14px';
        this.heightInput.style.borderRadius = '4px';
        this.bindEvent(this.heightInput, 'input', this.onSizeChange.bind(this));
        sizeContainer.appendChild(this.heightInput);

        section.appendChild(sizeContainer);

        return section;
    }

    /**
     * 创建坐标控制区域
     */
    private createPositionSection(): HTMLElement {
        const section = this.createElement('div', 'positionSection');

        const label = this.createElement('label', 'sectionLabel');
        label.textContent = '显示位置';
        section.appendChild(label);

        const positionContainer = this.createElement('div', 'positionContainer');

        // X坐标输入
        const xLabel = this.createElement('span', 'positionLabel');
        xLabel.textContent = 'X:';
        positionContainer.appendChild(xLabel);

        this.xInput = document.createElement('input');
        this.xInput.type = 'number';
        this.xInput.className = 'positionInput';
        this.xInput.min = '0';
        this.xInput.max = '320';
        this.xInput.value = (this.getValue()?.x || 0).toString();
        this.xInput.style.width = '60px';
        this.xInput.style.padding = '4px 8px';
        this.xInput.style.border = '1px solid #ddd';
        this.xInput.style.borderRadius = '4px';
        this.xInput.style.fontSize = '14px';
        this.xInput.style.color = '#333';
        this.xInput.style.backgroundColor = '#fff';
        this.bindEvent(this.xInput, 'input', this.onPositionChange.bind(this));
        positionContainer.appendChild(this.xInput);

        // Y坐标输入
        const yLabel = this.createElement('span', 'positionLabel');
        yLabel.textContent = 'Y:';
        positionContainer.appendChild(yLabel);

        this.yInput = document.createElement('input');
        this.yInput.type = 'number';
        this.yInput.className = 'positionInput';
        this.yInput.min = '0';
        this.yInput.max = '240';
        this.yInput.value = (this.getValue()?.y || 0).toString();
        this.yInput.style.width = '60px';
        this.yInput.style.padding = '4px 8px';
        this.yInput.style.border = '1px solid #ddd';
        this.yInput.style.borderRadius = '4px';
        this.yInput.style.fontSize = '14px';
        this.yInput.style.color = '#333';
        this.yInput.style.backgroundColor = '#fff';
        this.bindEvent(this.yInput, 'input', this.onPositionChange.bind(this));
        positionContainer.appendChild(this.yInput);

        section.appendChild(positionContainer);

        return section;
    }

    /**
     * 创建屏幕设置区域
     */
    private createScreenSection(): HTMLElement {
        const section = this.createElement('div', 'screenSection');

        const label = this.createElement('label', 'sectionLabel');
        label.textContent = '屏幕设置';
        section.appendChild(label);

        const screenContainer = this.createElement('div', 'screenSettingsContainer');

        // 屏幕宽度输入
        const widthLabel = this.createElement('span', 'screenLabel');
        widthLabel.textContent = '屏幕宽:';
        screenContainer.appendChild(widthLabel);

        this.screenWidthInput = document.createElement('input');
        this.screenWidthInput.type = 'number';
        this.screenWidthInput.className = 'screenInput';
        this.screenWidthInput.min = '1';
        this.screenWidthInput.max = '1000';
        this.screenWidthInput.value = (this.getValue()?.screenWidth || 320).toString();
        this.screenWidthInput.style.width = '80px';
        this.screenWidthInput.style.padding = '4px 8px';
        this.screenWidthInput.style.border = '1px solid #ddd';
        this.screenWidthInput.style.borderRadius = '4px';
        this.screenWidthInput.style.fontSize = '14px';
        this.screenWidthInput.style.color = '#333';
        this.screenWidthInput.style.backgroundColor = '#fff';
        this.bindEvent(this.screenWidthInput, 'input', this.onScreenChange.bind(this));
        screenContainer.appendChild(this.screenWidthInput);

        // 屏幕高度输入
        const heightLabel = this.createElement('span', 'screenLabel');
        heightLabel.textContent = '屏幕高:';
        screenContainer.appendChild(heightLabel);

        this.screenHeightInput = document.createElement('input');
        this.screenHeightInput.type = 'number';
        this.screenHeightInput.className = 'screenInput';
        this.screenHeightInput.min = '1';
        this.screenHeightInput.max = '1000';
        this.screenHeightInput.value = (this.getValue()?.screenHeight || 240).toString();
        this.screenHeightInput.style.width = '80px';
        this.screenHeightInput.style.padding = '4px 8px';
        this.screenHeightInput.style.border = '1px solid #ddd';
        this.screenHeightInput.style.borderRadius = '4px';
        this.screenHeightInput.style.fontSize = '14px';
        this.screenHeightInput.style.color = '#333';
        this.screenHeightInput.style.backgroundColor = '#fff';
        this.bindEvent(this.screenHeightInput, 'input', this.onScreenChange.bind(this));
        screenContainer.appendChild(this.screenHeightInput);

        // 旋转选择
        const rotationLabel = this.createElement('span', 'screenLabel');
        rotationLabel.textContent = '旋转:';
        screenContainer.appendChild(rotationLabel);

        this.rotationSelect = document.createElement('select');
        this.rotationSelect.className = 'rotationSelect';
        this.rotationSelect.style.padding = '4px 8px';
        this.rotationSelect.style.border = '1px solid #ddd';
        this.rotationSelect.style.borderRadius = '4px';
        this.rotationSelect.style.fontSize = '14px';
        this.rotationSelect.style.color = '#333';
        this.rotationSelect.style.backgroundColor = '#fff';

        const rotations = [
            { value: '0', text: '0°' },
            { value: '90', text: '90°' },
            { value: '180', text: '180°' },
            { value: '270', text: '270°' }
        ];

        rotations.forEach(rotation => {
            const option = document.createElement('option');
            option.value = rotation.value;
            option.textContent = rotation.text;
            this.rotationSelect!.appendChild(option);
        });

        this.rotationSelect.value = (this.getValue()?.rotation || 0).toString();
        this.bindEvent(this.rotationSelect, 'change', this.onScreenChange.bind(this));
        screenContainer.appendChild(this.rotationSelect);

        section.appendChild(screenContainer);

        return section;
    }

    /**
     * 处理尺寸变化
     */
    private onSizeChange() {
        this.updateValue();
        this.updatePreview();
    }

    /**
     * 处理坐标变化
     */
    private onPositionChange() {
        this.updateValue();
        this.updatePreview();
    }

    /**
     * 处理屏幕设置变化
     */
    private onScreenChange() {
        this.updateValue();
        this.updatePreview();
    }

    /**
     * 处理文件路径输入变化
     */
    private onFilePathChange() {
        // 实时更新值，但不立即加载图片
        this.updateValue();
    }

    /**
     * 处理文件路径输入失焦
     */
    private onFilePathBlur() {
        // 失焦时尝试加载图片预览
        const filePath = this.filePathInput?.value || '';
        if (filePath && filePath !== this.getValue()?.filePath) {
            this.loadImageFromPath(filePath);
        }
    }

    /**
     * 处理文件路径输入键盘事件
     */
    private onFilePathKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter') {
            event.preventDefault();
            this.onFilePathBlur();
        }
    }

    /**
     * 从文件路径加载图片
     */
    private loadImageFromPath(filePath: string) {
        if (this.previewImage) {
            this.previewImage.onload = () => {
                console.log('图片加载成功:', filePath);
            };
            this.previewImage.onerror = () => {
                console.warn('图片加载失败:', filePath);
                // 可以显示默认图标或错误提示
            };
            this.previewImage.src = filePath;
        }
    }

    /**
     * 创建预览区域
     */
    private createPreviewSection(): HTMLElement {
        const section = this.createElement('div', 'previewSection');

        const label = this.createElement('label', 'sectionLabel');
        label.textContent = '图像预览';
        section.appendChild(label);

        // 创建屏幕模拟容器 (动态尺寸)
        const screenContainer = this.createElement('div', 'screenContainer');
        screenContainer.id = 'previewScreenContainer';
        screenContainer.style.border = '2px solid #333';
        screenContainer.style.backgroundColor = '#000';
        screenContainer.style.position = 'relative';
        screenContainer.style.overflow = 'hidden';
        screenContainer.style.margin = '8px auto';

        // 创建图片预览容器
        this.previewContainer = this.createElement('div', 'previewContainer');
        this.previewContainer.style.position = 'absolute';
        this.previewContainer.style.top = '0px';
        this.previewContainer.style.left = '0px';

        this.previewImage = document.createElement('img');
        this.previewImage.className = 'previewImage';
        this.previewImage.style.display = 'block';

        // 加载当前图片
        this.loadPreviewImage();

        this.previewContainer.appendChild(this.previewImage);
        screenContainer.appendChild(this.previewContainer);
        section.appendChild(screenContainer);

        return section;
    }

    /**
     * 创建按钮区域
     */
    private createButtonSection(): HTMLElement {
        const section = this.createElement('div', 'buttonSection');
        
        const clearButton = this.createElement('button', 'actionButton');
        clearButton.textContent = Blockly.Msg['BUTTON_LABEL_CLEAR'];
        this.bindEvent(clearButton, 'click', this.clearImage.bind(this));
        section.appendChild(clearButton);
        
        return section;
    }

    /**
     * 工具方法：创建元素
     */
    private createElement(tag: string, className: string): HTMLElement {
        const element = document.createElement(tag);
        element.className = className;
        return element;
    }

    /**
     * 工具方法：绑定事件
     */
    private bindEvent(element: HTMLElement, eventName: string, callback: (e: Event) => void) {
        this.boundEvents.push(
            Blockly.browserEvents.bind(element, eventName, this, callback),
        );
    }

    /**
     * 打开文件选择对话框
     */
    private openFileDialog() {
        // 这里需要通过Electron的IPC调用文件选择对话框
        // 暂时使用简单的文件输入
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';
        
        fileInput.onchange = (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (file) {
                this.handleFileSelected(file);
            }
        };
        
        document.body.appendChild(fileInput);
        fileInput.click();
        document.body.removeChild(fileInput);
    }

    /**
     * 处理文件选择
     */
    private handleFileSelected(file: File) {
        if (this.filePathInput) {
            this.filePathInput.value = file.name;
        }

        // 读取文件并显示预览
        const reader = new FileReader();
        reader.onload = (e) => {
            const imageData = e.target?.result as string;
            this.updatePreview(imageData);
            // 处理图片并缓存到全局存储
            this.processAndCacheImage(file, imageData);
            // 直接更新值，包含新的图片数据
            this.updateValueWithImageData(imageData);
        };
        reader.readAsDataURL(file);
    }

    /**
     * 处理图片并缓存到全局存储
     */
    private processAndCacheImage(file: File, imageData: string) {
        console.log(`🔍 [图片处理] 开始处理文件: ${file.name}`);

        // 初始化全局图片缓存
        if (!(window as any).tftImageCache) {
            (window as any).tftImageCache = {};
        }

        const img = new Image();
        img.onload = () => {
            console.log(`🖼️ 图片加载完成: ${img.width}x${img.height}`);

            try {
                // 处理所有可能用到的尺寸
                const processedSizes: { [key: number]: string[] } = {};
                const sizesToProcess = [8, 16, 24, 32, 48, 64, 96, 128];

                let processedCount = 0;
                sizesToProcess.forEach(size => {
                    try {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        if (!ctx) return;

                        canvas.width = size;
                        canvas.height = size;

                        // 绘制缩放后的图片，保持宽高比
                        const aspectRatio = img.width / img.height;
                        let drawWidth = size;
                        let drawHeight = size;
                        let offsetX = 0;
                        let offsetY = 0;

                        if (aspectRatio > 1) {
                            drawHeight = size / aspectRatio;
                            offsetY = (size - drawHeight) / 2;
                        } else {
                            drawWidth = size * aspectRatio;
                            offsetX = (size - drawWidth) / 2;
                        }

                        ctx.fillStyle = '#000000';
                        ctx.fillRect(0, 0, size, size);
                        ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);

                        // 获取像素数据
                        const pixelData = ctx.getImageData(0, 0, size, size);
                        const data = pixelData.data;

                        // 转换为RGB565数组
                        const rgb565Array: string[] = [];
                        for (let i = 0; i < data.length; i += 4) {
                            const r = data[i];
                            const g = data[i + 1];
                            const b = data[i + 2];

                            // 转换为RGB565
                            const r5 = (r >> 3) & 0x1F;
                            const g6 = (g >> 2) & 0x3F;
                            const b5 = (b >> 3) & 0x1F;
                            const rgb565 = (r5 << 11) | (g6 << 5) | b5;

                            rgb565Array.push(`0x${rgb565.toString(16).padStart(4, '0').toUpperCase()}`);
                        }

                        processedSizes[size] = rgb565Array;
                        processedCount++;
                        console.log(`✅ 处理尺寸 ${size}x${size}: ${rgb565Array.length} 像素`);

                    } catch (sizeError) {
                        console.error(`❌ 处理尺寸 ${size} 时出错:`, sizeError);
                    }
                });

                // 存储到全局缓存（使用多个key确保能找到）
                const cacheKeys = [file.name, file.name.toLowerCase(), file.name.replace(/\s+/g, '_')];
                cacheKeys.forEach(key => {
                    (window as any).tftImageCache[key] = {
                        fileName: file.name,
                        originalWidth: img.width,
                        originalHeight: img.height,
                        processedSizes: processedSizes,
                        imageElement: img,
                        processedAt: Date.now(),
                        processedCount: processedCount
                    };
                });

                console.log(`🎉 图片 ${file.name} 处理完成，已缓存 ${processedCount} 个尺寸`);

            } catch (error) {
                console.error('处理图片时出错:', error);
            }
        };

        img.onerror = () => {
            console.error('图片加载失败:', file.name);
        };

        img.src = imageData;
    }

    /**
     * 更新预览图片
     */
    private updatePreview(imageData?: string) {
        if (this.previewImage) {
            if (imageData) {
                this.previewImage.src = imageData;
            }

            // 更新图片位置和尺寸
            this.updatePreviewPosition();
        }
    }

    /**
     * 更新预览图片的位置和尺寸
     */
    private updatePreviewPosition() {
        if (!this.previewImage || !this.previewContainer) return;

        // 获取屏幕设置
        const screenWidth = parseInt(this.screenWidthInput?.value || '320', 10);
        const screenHeight = parseInt(this.screenHeightInput?.value || '240', 10);
        const rotation = parseInt(this.rotationSelect?.value || '0', 10);

        // 根据旋转调整屏幕尺寸
        let displayWidth = screenWidth;
        let displayHeight = screenHeight;
        if (rotation === 90 || rotation === 270) {
            displayWidth = screenHeight;
            displayHeight = screenWidth;
        }

        // 计算缩放比例，保持最大150px宽度
        const scale = Math.min(150 / displayWidth, 150 / displayHeight);
        const scaledWidth = Math.round(displayWidth * scale);
        const scaledHeight = Math.round(displayHeight * scale);

        // 更新屏幕容器尺寸
        const screenContainer = document.getElementById('previewScreenContainer');
        if (screenContainer) {
            screenContainer.style.width = scaledWidth + 'px';
            screenContainer.style.height = scaledHeight + 'px';

            // 应用旋转
            let transform = '';
            if (rotation !== 0) {
                transform = `rotate(${rotation}deg)`;
                // 旋转后需要调整位置
                if (rotation === 90) {
                    transform += ` translate(${(scaledHeight - scaledWidth) / 2}px, ${(scaledWidth - scaledHeight) / 2}px)`;
                } else if (rotation === 180) {
                    // 180度旋转不需要额外位移
                } else if (rotation === 270) {
                    transform += ` translate(${(scaledHeight - scaledWidth) / 2}px, ${(scaledWidth - scaledHeight) / 2}px)`;
                }
            }
            screenContainer.style.transform = transform;
        }

        // 获取图片位置和尺寸
        const x = parseInt(this.xInput?.value || '0', 10);
        const y = parseInt(this.yInput?.value || '0', 10);
        const width = parseInt(this.widthInput?.value || DEFAULT_WIDTH.toString(), 10);
        const height = parseInt(this.heightInput?.value || DEFAULT_HEIGHT.toString(), 10);

        // 应用缩放和位置
        this.previewContainer.style.left = Math.round(x * scale) + 'px';
        this.previewContainer.style.top = Math.round(y * scale) + 'px';
        this.previewImage.style.width = Math.round(width * scale) + 'px';
        this.previewImage.style.height = Math.round(height * scale) + 'px';
    }

    /**
     * 加载预览图片
     */
    private loadPreviewImage() {
        const value = this.getValue();
        if (value?.imageData) {
            this.updatePreview(value.imageData);
        } else if (value?.filePath) {
            // 尝试加载文件路径的图片
            if (this.previewImage) {
                this.previewImage.src = value.filePath;
                this.updatePreviewPosition();
            }
        } else {
            // 即使没有图片也要更新位置
            this.updatePreviewPosition();
        }
    }

    /**
     * 清除图片
     */
    private clearImage() {
        if (this.filePathInput) {
            this.filePathInput.value = '';
        }
        if (this.previewImage) {
            this.previewImage.src = '';
        }
        this.updateValue();
    }

    /**
     * 更新字段值
     */
    private updateValue() {
        const currentValue = this.getValue();
        const newValue: ImagePreviewValue = {
            filePath: this.filePathInput?.value || '',
            width: parseInt(this.widthInput?.value || DEFAULT_WIDTH.toString(), 10),
            height: parseInt(this.heightInput?.value || DEFAULT_HEIGHT.toString(), 10),
            x: parseInt(this.xInput?.value || '0', 10),
            y: parseInt(this.yInput?.value || '0', 10),
            screenWidth: parseInt(this.screenWidthInput?.value || '320', 10),
            screenHeight: parseInt(this.screenHeightInput?.value || '240', 10),
            rotation: parseInt(this.rotationSelect?.value || '0', 10),
            // 保持现有的imageData，除非有新的图片数据
            imageData: this.previewImage?.src || currentValue?.imageData || null
        };

        this.setValue(newValue);
    }

    /**
     * 更新字段值（包含新的图片数据）
     */
    private updateValueWithImageData(imageData: string) {
        const newValue: ImagePreviewValue = {
            filePath: this.filePathInput?.value || '',
            width: parseInt(this.widthInput?.value || DEFAULT_WIDTH.toString(), 10),
            height: parseInt(this.heightInput?.value || DEFAULT_HEIGHT.toString(), 10),
            x: parseInt(this.xInput?.value || '0', 10),
            y: parseInt(this.yInput?.value || '0', 10),
            screenWidth: parseInt(this.screenWidthInput?.value || '320', 10),
            screenHeight: parseInt(this.screenHeightInput?.value || '240', 10),
            rotation: parseInt(this.rotationSelect?.value || '0', 10),
            imageData: imageData
        };

        this.setValue(newValue);
    }

    /**
     * 销毁编辑器
     */
    private disposeEditor() {
        // 清理事件绑定
        for (const event of this.boundEvents) {
            Blockly.browserEvents.unbind(event);
        }
        this.boundEvents.length = 0;
        
        // 清理DOM引用
        this.previewContainer = null;
        this.previewImage = null;
        this.filePathInput = null;
        this.widthInput = null;
        this.heightInput = null;
        this.xInput = null;
        this.yInput = null;
        this.screenWidthInput = null;
        this.screenHeightInput = null;
        this.rotationSelect = null;
        
        // 重置初始值
        this.initialValue = null;
    }

    /**
     * 初始化block上的显示
     */
    override initView() {
        // 创建SVG图片元素来显示预览
        this.blockDisplayImage = Blockly.utils.dom.createSvgElement(
            'image',
            {
                x: 0,
                y: 0,
                width: 32,
                height: 32,
            },
            this.getSvgRoot(),
        ) as SVGImageElement;

        // 初始渲染
        this.updateBlockDisplay();
    }

    /**
     * 更新block上的显示
     */
    private updateBlockDisplay() {
        if (!this.blockDisplayImage) return;

        const value = this.getValue();
        if (value?.imageData) {
            // 显示实际的图片
            this.blockDisplayImage.setAttributeNS('http://www.w3.org/1999/xlink', 'href', value.imageData);
        } else {
            // 显示简单的图片图标
            this.blockDisplayImage.setAttributeNS('http://www.w3.org/1999/xlink', 'href',
                'data:image/svg+xml;base64,' + btoa(`
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="#666">
                    <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
                </svg>
            `));
        }
    }

    /**
     * 更新字段大小
     */
    protected override updateSize_() {
        const newWidth = 32;
        const newHeight = 32;

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

    /**
     * 渲染字段
     */
    protected override render_() {
        super.render_();
        this.updateBlockDisplay();
    }

    /**
     * 销毁字段
     */
    override dispose() {
        // 清理DOM引用
        this.blockDisplayImage = null;

        // 调用父类的dispose方法
        super.dispose();
    }
}

/**
 * 图片预览值接口
 */
export interface ImagePreviewValue {
    filePath: string;
    width: number;
    height: number;
    x?: number;
    y?: number;
    screenWidth?: number;
    screenHeight?: number;
    rotation?: number; // 0, 90, 180, 270
    imageData: string | null;
}

/**
 * 字段配置接口
 */
export interface FieldImagePreviewConfig extends Blockly.FieldConfig {
    value?: ImagePreviewValue;
    defaultWidth?: number;
    defaultHeight?: number;
    previewSize?: number;
}

// 注册字段类型
Blockly.fieldRegistry.register('field_image_preview', FieldImagePreview);

/**
 * CSS样式
 */
Blockly.Css.register(`
.imagePreviewEditor {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    min-width: 300px;
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}

.fileSection, .sizeSection, .previewSection, .buttonSection {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.sectionLabel {
    font-size: 14px;
    font-weight: 600;
    color: #333;
    margin: 0;
}

.inputContainer {
    display: flex;
    gap: 8px;
    align-items: center;
}

.filePathInput {
    flex: 1;
    height: 32px;
    padding: 6px 12px;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 14px;
    color: #333;
}

.filePathInput:focus {
    outline: none;
    border-color: #007acc;
    box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.2);
}

.browseButton, .actionButton {
    height: 36px;
    padding: 8px 20px;
    border: 2px solid #007acc;
    border-radius: 6px;
    background: #007acc;
    color: white;
    font-size: 14px;
    font-weight: bold;
    cursor: pointer;
    transition: all 0.2s;
    box-shadow: 0 2px 4px rgba(0, 122, 204, 0.3);
}

.browseButton:hover, .actionButton:hover {
    background: #005a9e;
    border-color: #005a9e;
    transform: translateY(-1px);
    box-shadow: 0 4px 8px rgba(0, 122, 204, 0.4);
}

.sizeContainer {
    display: flex;
    align-items: center;
    gap: 8px;
}

.sizeLabel {
    font-size: 14px;
    color: #666;
    white-space: nowrap;
}

.sizeInput {
    width: 80px;
    height: 32px;
    padding: 6px 8px;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 14px;
    text-align: center;
}

.sizeInput:focus {
    outline: none;
    border-color: #007acc;
    box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.2);
}

.previewContainer {
    border: 2px dashed #ddd;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f9f9f9;
    position: relative;
    overflow: hidden;
}

.previewContainer:empty::before {
    content: "暂无图片预览";
    color: #999;
    font-size: 14px;
}

.previewImage {
    display: block;
    border-radius: 4px;
}

.buttonSection {
    flex-direction: row;
    justify-content: flex-end;
    gap: 8px;
}

.actionButton {
    background: #f44336;
    border-color: #f44336;
}

.actionButton:hover {
    background: #d32f2f;
    border-color: #d32f2f;
}

.positionContainer {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
}

.positionLabel {
    font-weight: 500;
    color: #333;
    min-width: 20px;
}

.positionInput {
    width: 60px;
    height: 32px;
    padding: 4px 8px;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 14px;
    text-align: center;
}

.positionInput:focus {
    outline: none;
    border-color: #007acc;
    box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.2);
}

.screenContainer {
    border: 2px solid #333;
    background-color: #000;
    position: relative;
    overflow: hidden;
    margin: 8px auto;
}

.screenSettingsContainer {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
}

.screenLabel {
    font-weight: 500;
    color: #333;
    min-width: 60px;
}

.screenInput {
    width: 80px;
    height: 32px;
    padding: 4px 8px;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 14px;
    text-align: center;
    color: #333;
    background-color: #fff;
}

.screenInput:focus {
    outline: none;
    border-color: #007acc;
    box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.2);
}

.rotationSelect {
    height: 32px;
    padding: 4px 8px;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 14px;
    color: #333;
    background-color: #fff;
    cursor: pointer;
}

.rotationSelect:focus {
    outline: none;
    border-color: #007acc;
    box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.2);
}
`);
