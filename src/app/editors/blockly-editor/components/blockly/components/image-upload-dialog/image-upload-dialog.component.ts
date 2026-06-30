import { Component, OnInit, OnDestroy, Input, ViewChild, ElementRef, AfterViewInit, HostListener, Renderer2 } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzMessageService } from 'ng-zorro-antd/message';
import { FormsModule } from '@angular/forms';
import { NzModalRef } from 'ng-zorro-antd/modal';
import Cropper from 'cropperjs';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzInputNumberModule } from 'ng-zorro-antd/input-number';
import { ConverterService } from './converter.service';

@Component({
  selector: 'app-image-upload-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzSwitchModule,
    NzInputNumberModule
  ],
  templateUrl: './image-upload-dialog.component.html',
  styleUrls: ['./image-upload-dialog.component.scss']
})
export class ImageUploadDialogComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input() title = '图片取模';
  @Input() defaultWidth = 128;  // 可配置输出宽度
  @Input() defaultHeight = 64;  // 可配置输出高度
  @Input() maxFileSize = 10 * 1024 * 1024; // 10MB
  @Input() acceptedTypes = ['image/jpeg', 'image/png', 'image/webp'];

  @ViewChild('cropperImage') cropperImage!: ElementRef<HTMLImageElement>;
  @ViewChild("myCanvas") myCanvas;
  imageUrl: string | null = null;
  cropper: Cropper | null = null;
  isLoading = false;
  isDragOver = false;
  private cropChangeTimer: any = null; // 添加防抖定时器

  // 当前裁剪区域尺寸
  CropRatio = 2; // 为了显示图像大点，设置了一个缩放比例
  _currentCropSize = {
    width: 0,
    height: 0
  };

  get currentCropSize() {
    return {
      width: Math.round(this._currentCropSize.width / this.CropRatio),
      height: Math.round(this._currentCropSize.height / this.CropRatio)
    };
  }

  options = {
    endian: false,
    invert: false,
    dither: false,
    threshold: 127,
  }

  bitmapString;
  bitmapArray: number[][] = []; // 二维数组，0表示空白，1表示填充

  constructor(
    private modal: NzModalRef,
    private message: NzMessageService,
    private renderer: Renderer2,
    private converterService: ConverterService
  ) {
    // 从modal数据中获取请求信息
    const modalData = this.modal.getConfig().nzData;
    if (modalData && modalData.request) {
      const request = modalData.request;
      this.defaultWidth = request.width;
      this.defaultHeight = request.height;
    }
  }

  // 拖拽事件处理
  @HostListener('dragover', ['$event'])
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = true;
  }

  @HostListener('dragleave', ['$event'])
  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;
  }

  @HostListener('drop', ['$event'])
  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.handleFileSelect(files[0]);
    }
  }

  onClose(): void {
    this.releaseImageResources();
    this.modal.triggerCancel();
  }

  ngOnInit(): void {

  }

  ngAfterViewInit(): void {

  }

  ngOnDestroy(): void {
    // 清除防抖定时器
    if (this.cropChangeTimer) {
      clearTimeout(this.cropChangeTimer);
    }
    this.converterService.cancel();
    this.releaseImageResources();
  }

  // 确认按钮处理
  async onConfirm() {
    if (!this.cropper) {
      this.message.error('请先选择图片');
      return;
    }
    await this.convert2bitmap();
    // const blob = await new Promise<Blob>((resolve) => {
    //   this.myCanvas.nativeElement.toBlob(resolve, 'image/png');
    // });
    this.modal.close({
      // blob: blob,
      // bitmapString: this.bitmapString,
      bitmapArray: this.bitmapArray,
      width: this.currentCropSize.width,
      height: this.currentCropSize.height,
      option: JSON.parse(JSON.stringify(this.options))
    });
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.handleFileSelect(input.files[0]);
    }
  }

  handleFileSelect(file: File): void {
    // 验证文件类型
    if (!this.acceptedTypes.includes(file.type)) {
      this.message.error('请选择支持的图片格式 (JPEG, PNG, GIF, WebP)');
      return;
    }

    // 验证文件大小
    if (file.size > this.maxFileSize) {
      this.message.error(`图片大小不能超过 ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
      return;
    }

    // 在加载新图片前释放之前的资源
    this.releaseImageResources();

    this.isLoading = true;
    console.log('Starting file processing...');

    const reader = new FileReader(); reader.onload = (e) => {
      this.imageUrl = e.target?.result as string;
      console.log('File read complete, imageUrl set');

      // 等待DOM更新完成，然后初始化cropper
      setTimeout(() => {
        this.initCropper();
      }, 50); // 减少延迟时间
    };

    reader.onerror = () => {
      console.error('FileReader error');
      this.message.error('文件读取失败');
      this.isLoading = false;
    };

    reader.readAsDataURL(file);
  }

  initCropper(): void {
    if (!this.cropperImage?.nativeElement || !this.imageUrl) {
      console.warn('Cropper initialization failed: missing image element or imageUrl');
      return;
    }

    // 销毁已存在的cropper
    this.destroyCropper();

    const image = this.cropperImage.nativeElement;

    // 清除之前的事件监听器，避免事件处理器冲突
    image.onload = null;
    image.onerror = null;

    // 设置图片样式 - 确保初始状态就是隐藏的
    image.style.display = 'none';
    image.style.width = 'auto';
    image.style.height = 'auto';
    image.style.maxWidth = '100%';
    image.style.maxHeight = '100%';

    console.log('Initializing cropper with imageUrl:', this.imageUrl.substring(0, 50) + '...');

    // 设置新的事件处理器
    image.onload = () => {
      try {
        this.cropper = new Cropper(image, {
          aspectRatio: NaN, // 保持输出比例
          viewMode: 0, // 限制裁剪框在图片内
          dragMode: 'move',
          autoCrop: true,
          autoCropArea: 0.6, // 初始裁剪区域占比
          movable: true,
          zoomable: true,
          zoomOnWheel: true,
          cropBoxMovable: true,
          cropBoxResizable: true, // 允许调整裁剪框大小
          guides: true,
          center: true,
          highlight: true,
          background: false,
          modal: false,
          responsive: true,
          restore: false,
          checkCrossOrigin: false,
          checkOrientation: false, ready: () => {
            this.isLoading = false;
            if (this.cropper) {
              this.cropper.crop();
              // 设置默认裁剪框大小
              setTimeout(() => {
                this.setDefaultCropBoxSize();
                this.updateCropSize(); // 立即更新尺寸显示
                this.onCropChange();
              }, 50);
            }
          },// 添加裁剪内容变化事件监听器
          cropend: () => {
            this.updateCropSize(); // 立即更新尺寸显示
            this.onCropChange();
          },
          cropmove: () => {
            this.updateCropSize(); // 立即更新尺寸显示
            this.onCropChange();
          },
          zoom: () => {
            this.updateCropSize(); // 立即更新尺寸显示
            this.onCropChange();
          }
        });
      } catch (error) {
        console.error('Failed to initialize cropper:', error);
        this.message.error('图片裁剪器初始化失败');
        this.isLoading = false;
      }
    };

    image.onerror = () => {
      console.error('Image load failed for src:', image.src);
      this.message.error('图片加载失败');
      this.isLoading = false;
    };

    // 最后设置图片源，触发加载
    image.src = this.imageUrl;
  }
  // 设置默认裁剪框大小
  setDefaultCropBoxSize(): void {
    if (!this.cropper) {
      return;
    }

    try {
      // 获取容器尺寸
      const containerData = this.cropper.getContainerData();
      let cropBoxWidth = 128 * this.CropRatio;
      let cropBoxHeight = 64 * this.CropRatio;

      // 计算居中位置（相对于容器）
      const left = (containerData.width - cropBoxWidth) / 2;
      const top = (containerData.height - cropBoxHeight) / 2;

      // 设置裁剪框数据
      this.cropper.setCropBoxData({
        left: left,
        top: top,
        width: cropBoxWidth,
        height: cropBoxHeight
      });
    } catch (error) {
      console.error('设置默认裁剪框大小失败:', error);
    }
  }

  // 添加裁剪内容变化处理方法（带防抖）
  onCropChange(): void {
    // 清除之前的定时器
    if (this.cropChangeTimer) {
      clearTimeout(this.cropChangeTimer);
    }

    // 设置新的定时器，1秒后执行
    this.cropChangeTimer = setTimeout(() => {
      this.handleCropChange();
    }, 1000);
  }

  // 实际处理裁剪变化的方法
  async handleCropChange() {
    if (!this.cropper) {
      return;
    }

    try {
      // 获取当前裁剪框数据
      const cropBoxData = this.cropper.getCropBoxData();
      // 更新当前裁剪框尺寸
      this._currentCropSize = {
        width: Math.round(cropBoxData.width),
        height: Math.round(cropBoxData.height)
      };
      // 转换成bitmap
      await this.convert2bitmap();
    } catch (error) {
      if ((error as any)?.name === 'AbortError') {
        return;
      }
      console.error('处理裁剪变化失败:', error);
    }
  }

  // 更新当前裁剪框尺寸显示
  updateCropSize(): void {
    if (!this.cropper) {
      this._currentCropSize = { width: 0, height: 0 };
      return;
    }

    try {
      const cropBoxData = this.cropper.getCropBoxData();
      this._currentCropSize = {
        width: Math.round(cropBoxData.width),
        height: Math.round(cropBoxData.height)
      };
    } catch (error) {
      console.error('更新裁剪尺寸失败:', error);
      this._currentCropSize = { width: 0, height: 0 };
    }
  }

  destroyCropper(): void {
    // 清除防抖定时器
    if (this.cropChangeTimer) {
      clearTimeout(this.cropChangeTimer);
      this.cropChangeTimer = null;
    }

    if (this.cropper) {
      this.cropper.destroy();
      this.cropper = null;
    }
  }

  // 释放图片资源，避免内存泄漏
  releaseImageResources(): void {
    // 销毁现有的cropper
    this.destroyCropper();

    // 清除图片元素的事件监听器
    if (this.cropperImage?.nativeElement) {
      const image = this.cropperImage.nativeElement;
      image.onload = null;
      image.onerror = null;
    }

    // 如果当前的imageUrl是blob URL，需要释放它
    if (this.imageUrl && this.imageUrl.startsWith('data:')) {
      // data URL不需要特殊释放，但我们仍然清空引用
      this.imageUrl = null;
    } else if (this.imageUrl && this.imageUrl.startsWith('blob:')) {
      // 如果是blob URL，使用URL.revokeObjectURL释放
      URL.revokeObjectURL(this.imageUrl);
      this.imageUrl = null;
    } else {
      // 其他情况直接清空引用
      this.imageUrl = null;
    }
  }
  // 重置组件状态
  resetComponent(): void {
    this.releaseImageResources();
    this.isLoading = false;
    this.isDragOver = false;
  }

  // 重新居中裁剪框
  centerCropBox(): void {
    if (this.cropper) {
      this.cropper.reset();
    }
  }

  // 重置图片和裁剪框到初始状态
  resetCropper(): void {
    if (this.cropper) {
      this.cropper.reset();
      this.cropper.clear();
      this.cropper.crop();
    }
  }

  // 显示到右侧的canvas中
  async convert2bitmap() {
    let canvas: HTMLCanvasElement = this.myCanvas.nativeElement;
    let context = canvas.getContext("2d");
    if (!context || !this.cropper) {
      return;
    }

    this.renderer.setAttribute(canvas, "width", this.currentCropSize.width.toString());
    this.renderer.setAttribute(canvas, "height", this.currentCropSize.height.toString());
    this.renderer.setStyle(canvas, "transform", `scale(${1.5})`);

    context.clearRect(0, 0, this.currentCropSize.width, this.currentCropSize.height);

    const croppedCanvas = this.cropper.getCroppedCanvas({
      width: this.currentCropSize.width,
      height: this.currentCropSize.height,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
      fillColor: 'transparent' // 设置填充色为透明
    });

    // 将图像缩放填满整个canvas
    context.drawImage(croppedCanvas, 0, 0);

    // 获取imageData时使用正确的canvas尺寸
    let imageData = context.getImageData(0, 0, this.currentCropSize.width, this.currentCropSize.height);
    await this.converterService.convert(context, imageData, this.options);
    this.bitmapArray = this.converterService.getBitmap2DArray();
  }
}
