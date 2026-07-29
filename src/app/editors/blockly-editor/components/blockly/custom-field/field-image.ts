import * as Blockly from 'blockly/core';
import { projectDataRuntime } from '../../../../../services/project-data/project-data-runtime';
import { AilyDataRef, isAilyDataRef } from '../../../../../services/project-data/project-data.types';

/**
 * 自定义图片选择器字段类
 */
export class FieldImageSelector extends Blockly.FieldImage {
  // 默认图片和尺寸
  private static DEFAULT_IMAGE = 'data:image/png;base64,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';
  private static DEFAULT_WIDTH = 64;
  private static DEFAULT_HEIGHT = 64;

  // 存储图片数据
  private imageData: string;
  private renderedImageData = FieldImageSelector.DEFAULT_IMAGE;
  private renderedRefId = '';
  private loadingImage: Promise<void> | null = null;

  /**
   * 构造函数
   */
  constructor(value?: string, validator?: Blockly.FieldValidator<string>) {
    const state = parseImageSelectorState(value);
    const src = FieldImageSelector.DEFAULT_IMAGE;

    super(
      src,
      FieldImageSelector.DEFAULT_WIDTH,
      FieldImageSelector.DEFAULT_HEIGHT,
      '点击选择图片',  // 鼠标悬停提示
      (field) => {
        // 点击时的回调函数
        (field as FieldImageSelector).openFilePicker();
      }
    );

    this.imageData = JSON.stringify(state);

    // 添加验证器
    if (validator) {
      this.setValidator(validator);
    }
  }

  /**
   * 从JSON创建字段实例
   */
  static override fromJson(options: any): FieldImageSelector {
    return new FieldImageSelector(options['value']);
  }

  /**
   * 初始化UI
   */
  public override initView() {
    super.initView();
    void this.ensureImageLoaded().catch((error) => console.error('图片资源加载失败:', error));
    if (this.getClickTarget_()) {
      (this.getClickTarget_() as HTMLElement).style.cursor = 'pointer';
    }
  }

  /**
   * 打开文件选择器
   */
  openFilePicker() {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('class', 'image-cropper-dialog');
    dialog.innerHTML = `
    <div class="image-cropper-container">
      <div class="header">
        <div class="title">图片裁剪</div>
        <div class="win-btns">
          <div class="btn ccenter close">
            <i class="fa-light fa-xmark"></i>
          </div>
        </div>
      </div>

      <div class="crop-container">
        <div class="crop-wait">
           <input class="crop-file" type="file" accept="image/*" style="display: none;">
           <div class="crop-wait__label">选择图片</div>
           <div class="crop-wait__tip">支持JPG、PNG格式</div>
        </div>
        <img class="preview-image">
        <div class="crop-area"></div>

        <div class="controls">
          <button class="reset">重置</button>
          <button class="reload">重选</button>
          <input type="range" class="zoom" min="0.1" max="3" step="0.1" value="1">
          <button class="rotate-left">↺</button>
          <button class="rotate-right">↻</button>
          <button class="confirm">确认</button>
        </div>
      </div>
    </div>
  `;
    dialog.style.backgroundColor = '#2b2d30';
    dialog.style.borderRadius = '5px';
    dialog.style.boxShadow = '0 0 10px rgba(0, 0, 0, 0.2)';
    dialog.style.padding = '0';
    dialog.style.color = '#fff';
    dialog.style.overflow = 'hidden';
    dialog.style.border = 'none';

    // 初始化状态
    let scale: number = 1;
    let rotation: number = 0;
    let isDragging: boolean = false;
    let startX: number = 0;
    let startY: number = 0;
    let posX: number = 0;
    let posY: number = 0;

    // 获取元素引用
    const waitBox = dialog.querySelector('.crop-wait') as HTMLDivElement;
    const fileLabelBtn = dialog.querySelector('.crop-wait__label') as HTMLDivElement;
    const closeBtn = dialog.querySelector('.close.btn') as HTMLDivElement;
    const fileInput = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
    const previewImg = dialog.querySelector<HTMLImageElement>('.preview-image')!;
    const cropArea = dialog.querySelector<HTMLDivElement>('.crop-area')!;
    const zoomSlider = dialog.querySelector<HTMLInputElement>('.zoom')!;
    const rotateLeftBtn = dialog.querySelector<HTMLButtonElement>('.rotate-left')!;
    const rotateRightBtn = dialog.querySelector<HTMLButtonElement>('.rotate-right')!;
    const resetBtn = dialog.querySelector<HTMLButtonElement>('.reset')!;
    const reloadBtn = dialog.querySelector<HTMLButtonElement>('.reload')!;
    const confirmBtn = dialog.querySelector<HTMLButtonElement>('.confirm')!;

    fileLabelBtn.addEventListener('click', () => {
      fileInput.click();
    });

    // 设置裁剪区域尺寸
    const setCropAreaSize = (): void => {
      cropArea.style.width = `${FieldImageSelector.DEFAULT_WIDTH}px`;
      cropArea.style.height = `${FieldImageSelector.DEFAULT_HEIGHT}px`;
      cropArea.style.left = `calc(50% - ${FieldImageSelector.DEFAULT_WIDTH/2}px)`;
      cropArea.style.top = `calc(50% - ${FieldImageSelector.DEFAULT_HEIGHT/2}px)`;
    };

    // 更新图片变换
    const updateImageTransform = (): void => {
      previewImg.style.transform = `
      translate(${posX}px, ${posY}px)
      scale(${scale})
      rotate(${rotation}deg)
    `;
    };

    // 文件选择处理
    fileInput.addEventListener('change', (e: Event) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) return;

      const reader = new FileReader();

      reader.onload = (e: ProgressEvent<FileReader>) => {
        if (!e.target?.result) return;
        waitBox.style.display = 'none';

        previewImg.src = e.target.result as string;
        setCropAreaSize();

        // 重置状态
        scale = 1;
        rotation = 0;
        posX = 0;
        posY = 0;
        zoomSlider.value = '1';
        updateImageTransform();
      };

      reader.readAsDataURL(file);
    });

    // 鼠标事件处理
    const handleMouseDown = (e: MouseEvent): void => {
      isDragging = true;
      startX = e.clientX - posX;
      startY = e.clientY - posY;
    };

    const handleMouseMove = (e: MouseEvent): void => {
      if (!isDragging) return;
      posX = e.clientX - startX;
      posY = e.clientY - startY;
      updateImageTransform();
    };

    const handleMouseUp = (): void => {
      isDragging = false;
    };

    previewImg.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    // 缩放控制
    zoomSlider.addEventListener('input', (e: Event) => {
      const target = e.target as HTMLInputElement;
      scale = parseFloat(target.value);
      updateImageTransform();
    });

    // 旋转控制
    rotateLeftBtn.addEventListener('click', () => {
      rotation -= 90;
      updateImageTransform();
    });

    rotateRightBtn.addEventListener('click', () => {
      rotation += 90;
      updateImageTransform();
    });

    // 重置功能
    resetBtn.addEventListener('click', () => {
      scale = 1;
      rotation = 0;
      posX = 0;
      posY = 0;
      zoomSlider.value = '1';
      updateImageTransform();
    });

    // 重选功能
    reloadBtn.addEventListener('click', () => {
      fileInput.click();
    });

    // 确认裁剪
    confirmBtn.addEventListener('click', () => {
      const canvas = document.createElement('canvas');
      canvas.width = FieldImageSelector.DEFAULT_WIDTH;
      canvas.height = FieldImageSelector.DEFAULT_HEIGHT;
      const ctx = canvas.getContext('2d');

      if (!ctx || !previewImg.complete) {
        alert('裁剪失败，请选择有效图片');
        return;
      }

      // 计算裁剪参数
      const imgRect = previewImg.getBoundingClientRect();
      const cropRect = cropArea.getBoundingClientRect();

      const scaleX = previewImg.naturalWidth / imgRect.width;
      const scaleY = previewImg.naturalHeight / imgRect.height;

      const sourceX = (cropRect.left - imgRect.left) * scaleX;
      const sourceY = (cropRect.top - imgRect.top) * scaleY;
      const sourceWidth = FieldImageSelector.DEFAULT_WIDTH * scaleX;
      const sourceHeight = FieldImageSelector.DEFAULT_HEIGHT * scaleY;

      // 执行裁剪
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(
          previewImg,
          sourceX, sourceY, sourceWidth, sourceHeight,
          -canvas.width / 2, -canvas.height / 2,
          canvas.width, canvas.height
      );
      ctx.restore();

      // 更新字段值
      try {
        const dataUrl = canvas.toDataURL('image/png');
        this.persistSelectedImage(dataUrl, 'canvas.png');
      } catch (error) {
        console.error('图片导出失败:', error);
      }

      dialog.close();
      document.body.removeChild(dialog);
    });

    // 关闭对话框
    closeBtn.addEventListener('click', () => {
      dialog.close();
      document.body.removeChild(dialog);
    });

    document.body.appendChild(dialog);
    dialog.showModal();

    // 清理事件监听器
    dialog.addEventListener('close', () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    });
  }

  /**
   * 处理选择的图片
   */
  private handleImageSelection(file: File) {
    const reader = new FileReader();
    reader.onload = (event) => {
      const imageData = event.target?.result as string;
      this.resizeImage(imageData).then(resizedImage => {
        this.persistSelectedImage(resizedImage, file.name);
      });
    };
    reader.readAsDataURL(file);
  }

  /**
   * 调整图片尺寸
   */
  private async resizeImage(dataUrl: string): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        canvas.width = FieldImageSelector.DEFAULT_WIDTH;
        canvas.height = FieldImageSelector.DEFAULT_HEIGHT;

        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        } else {
          resolve(dataUrl); // 如果无法获取上下文，返回原图
        }
      };
      img.src = dataUrl;
    });
  }

  /**
   * 获取序列化值
   */
  override saveState(): unknown {
    return this.imageData;
  }

  /**
   * 获取字段值
   */
  override getValue(): string {
    return this.imageData;
  }

  /**
   * 设置字段值
   */
  override setValue(newValue: string): void {
    if (newValue === null || newValue === this.imageData) {
      return;
    }

    const nextState = parseImageSelectorState(newValue);
    const normalizedValue = JSON.stringify(nextState);
    const oldValue = this.imageData;
    this.imageData = normalizedValue;
    const nextRefId = nextState.image?.$ailyData.id || '';
    if (nextRefId !== this.renderedRefId) {
      this.renderedRefId = '';
      this.renderedImageData = FieldImageSelector.DEFAULT_IMAGE;
      this.loadingImage = null;
    }

    if (this.imageElement) {
      // this.imageElement.setAttribute('src', newValue);
      const img = new Image();
      img.onload = () => {
        this.updateImageElement();
      };
      img.src = this.renderedImageData;
      // TODO base64 图片不显示 @downey @coloz
    }

    // 触发变更事件
    if (this.sourceBlock_ && Blockly.Events.isEnabled()) {
      Blockly.Events.fire(new Blockly.Events.BlockChange(
        this.sourceBlock_, 'field', this.name, oldValue, normalizedValue));
    }
    if (nextRefId) void this.ensureImageLoaded().catch((error) => console.error('图片资源加载失败:', error));
  }

  /**
   * 获取可序列化的值
   */
  override toXml(fieldElement: Element): Element {
    fieldElement.setAttribute('src', this.imageData);
    return fieldElement;
  }

  /**
   * 从XML恢复状态
   */
  override fromXml(fieldElement: Element): void {
    const src = fieldElement.getAttribute('src');
    if (src) {
      this.setValue(src);
    }
  }

  private persistSelectedImage(dataUrl: string, sourceName: string): void {
    const parsed = parseImageDataUrl(dataUrl);
    this.renderedImageData = dataUrl;
    const mutation = projectDataRuntime.put({
      codec: 'image-original-v1',
      storage: 'raw-v1',
      value: parsed.bytes,
    }).then((image) => {
      this.renderedRefId = image.$ailyData.id;
      this.setValue(JSON.stringify({
        schemaVersion: 1,
        mediaType: parsed.mediaType,
        width: FieldImageSelector.DEFAULT_WIDTH,
        height: FieldImageSelector.DEFAULT_HEIGHT,
        sourceName,
        image,
      } satisfies ImageSelectorState));
      this.updateImageElement(dataUrl);
    });
    projectDataRuntime.trackMutation(mutation);
    void mutation.catch((error) => console.error('图片资源保存失败:', error));
  }

  private async ensureImageLoaded(): Promise<void> {
    const state = parseImageSelectorState(this.imageData);
    const ref = state.image;
    if (!ref) return;
    const refId = ref.$ailyData.id;
    if (this.renderedRefId === refId) {
      this.updateImageElement();
      return;
    }
    if (this.loadingImage) return this.loadingImage;
    const loading = projectDataRuntime.resolve<Uint8Array>(ref).then((bytes) => {
      if (parseImageSelectorState(this.imageData).image?.$ailyData.id !== refId) return;
      this.renderedImageData = `data:${state.mediaType};base64,${bytesToBase64(bytes)}`;
      this.renderedRefId = refId;
      this.updateImageElement();
    }).finally(() => {
      if (this.loadingImage === loading) this.loadingImage = null;
    });
    this.loadingImage = loading;
    return loading;
  }

  private updateImageElement(source = this.renderedImageData): void {
    if (!this.imageElement) return;
    this.imageElement.setAttribute('href', source);
    this.imageElement.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', source);
  }
}

interface ImageSelectorState {
  readonly schemaVersion: 1;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
  readonly sourceName?: string;
  readonly image: AilyDataRef | null;
}

function parseImageSelectorState(value: unknown): ImageSelectorState {
  let candidate = value;
  if (typeof candidate === 'string' && candidate.trim().startsWith('{')) {
    try { candidate = JSON.parse(candidate); } catch { candidate = null; }
  }
  const state = candidate && typeof candidate === 'object' ? candidate as Partial<ImageSelectorState> : {};
  return {
    schemaVersion: 1,
    mediaType: typeof state.mediaType === 'string' && state.mediaType ? state.mediaType : 'image/png',
    width: 64,
    height: 64,
    ...(typeof state.sourceName === 'string' ? { sourceName: state.sourceName } : {}),
    image: isAilyDataRef(state.image) ? state.image : null,
  };
}

function parseImageDataUrl(value: string): { mediaType: string; bytes: Uint8Array } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match) throw new Error('只支持 Base64 Data URL 图片');
  const binary = atob(match[2]);
  return { mediaType: match[1].toLowerCase(), bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)) };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

// 注册自定义字段
Blockly.fieldRegistry.register('field_image_selector', FieldImageSelector);

Blockly.Css.register(`
.image-cropper-dialog {
  &::backdrop {
    background: rgba(0, 0, 0, 0.75);
  }

  .header {
    display: flex;
    align-items: center;
    height: 35px;
    border-bottom: 1px solid #222427;
    background: #2b2d30;
  }

  .title {
    height: 100%;
    padding-left: 10px;
    display: flex;
    align-items: center;
    flex-grow: 1;
  }

  .win-btns {
    display: flex;
    align-items: center;
    font-size: 15px;

    .btn {
      font-size: 16px;
      width: 33px;
      height: 33px;
      margin-right: 0;

      &:hover {
        background: #3a3c3f;
      }
    }

    .minimize {
      font-size: 18px;
    }

    .go-main{
      // border-right: 1px solid #333;
      margin-right: 10px;
      font-size: 17px;
      background: transparent !important;
      &:hover {
        color: rgb(75, 151, 221);
      }
    }

    .close {
      font-size: 19px;

      &:hover {
        color: rgb(145, 0, 0);
      }
    }
  }

  .image-cropper-container {
    position: relative;
    width: 70vw;
    height: 70vh;
    background: #2b2d30;
    border-radius: 5px;
    overflow: hidden;
  }

  .crop-container {
    position: relative;
    width: 100%;
    height: calc(100% - 40px);
    overflow: hidden;
  }

  .preview-image {
    position: absolute;
    cursor: move;
    transform-origin: center;
    user-select: none;
    -webkit-user-drag: none;
  }

  .crop-area {
    position: absolute;
    border: 2px solid #1890ff;
    box-shadow: 0 0 0 9999px rgba(0,0,0,0.5);
    pointer-events: none;
  }

  .controls {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 8px;
    background: rgba(40,40,40,0.8);
    padding: 8px;
    border-radius: 4px;
  }

  button {
    padding: 6px 12px;
    background: #1890ff;
    border: none;
    border-radius: 4px;
    color: white;
    cursor: pointer;
  }

  input[type="range"] {
    width: 120px;
  }

  .crop-wait {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;

    .crop-wait__label {
      line-height: 1.5715;
      position: relative;
      display: inline-block;
      font-weight: 400;
      white-space: nowrap;
      text-align: center;
      background-image: none;
      border: 1px solid transparent;
      box-shadow: 0 2px 0 rgba(0, 0, 0, 0.015);
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.645, 0.045, 0.355, 1);
      user-select: none;
      touch-action: manipulation;
      height: 32px;
      padding: 4px 15px;
      font-size: 14px;
      border-radius: 2px;
      color: rgba(255, 255, 255, 0.95);
      border-color: #434343;
      background: transparent;

      &:hover {
        color: #165996;
        border-color: #165996;
        background: transparent;
      }
    }

    .crop-wait__tip {
      margin-top: 10px;
      color: #888;
      font-size: 12px;
    }

    .crop-file {
      position: absolute;
      inset: 0;
    }
  }
}
`);
