import { Component, OnDestroy, Input, ViewChild, ElementRef, HostListener } from '@angular/core';
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
import { BaseDialogComponent } from '../../../../../../components/base-dialog/base-dialog.component';

@Component({
  selector: 'app-image-upload-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, NzButtonModule, NzIconModule, NzSwitchModule,
    NzInputNumberModule, BaseDialogComponent],
  providers: [ConverterService],
  templateUrl: './image-upload-dialog.component.html',
  styleUrls: ['./image-upload-dialog.component.scss']
})
export class ImageUploadDialogComponent implements OnDestroy {
  @Input() title = '图片取模';
  @Input() defaultWidth = 128;
  @Input() defaultHeight = 64;
  @Input() maxFileSize = 10 * 1024 * 1024;
  @Input() acceptedTypes = ['image/jpeg', 'image/png', 'image/webp'];

  @ViewChild('cropperImage') cropperImage!: ElementRef<HTMLImageElement>;
  @ViewChild('myCanvas') myCanvas!: ElementRef<HTMLCanvasElement>;
  imageUrl: string | null = null;
  cropper: Cropper | null = null;
  isLoading = false;
  isReady = false;
  isConfirming = false;
  isDragOver = false;
  private cropChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private fileReader: FileReader | null = null;
  private imageVersion = 0;
  private conversionVersion = 0;
  private destroyed = false;

  CropRatio = 2;
  _currentCropSize = { width: 0, height: 0 };

  get currentCropSize() {
    return {
      width: Math.round(this._currentCropSize.width / this.CropRatio),
      height: Math.round(this._currentCropSize.height / this.CropRatio)
    };
  }

  options = { endian: false, invert: false, dither: false, threshold: 127 };
  bitmapArray: number[][] = [];

  constructor(
    private modal: NzModalRef,
    private message: NzMessageService,
    private converterService: ConverterService
  ) {
    const request = this.modal.getConfig().nzData?.request;
    if (request) {
      this.defaultWidth = request.width;
      this.defaultHeight = request.height;
    }
  }

  @HostListener('dragover', ['$event'])
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = !this.isConfirming;
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
    const file = event.dataTransfer?.files[0];
    if (file) this.handleFileSelect(file);
  }

  onClose(): void {
    this.releaseImageResources();
    this.modal.triggerCancel();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.releaseImageResources();
  }

  async onConfirm(): Promise<void> {
    if (!this.isReady || !this.cropper || this.isConfirming) return;
    const version = this.imageVersion;
    const cropper = this.cropper;
    this.isConfirming = true;
    this.clearCropChangeTimer();
    cropper.disable();
    try {
      // Flush the latest crop/options immediately; a queued preview must not
      // cancel the confirmation's worker or return the previous bitmap.
      if (!await this.convert2bitmap() || version !== this.imageVersion || this.destroyed) return;
      this.modal.close({
        bitmapArray: this.bitmapArray,
        width: this.currentCropSize.width,
        height: this.currentCropSize.height,
        option: { ...this.options }
      });
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError' && version === this.imageVersion && !this.destroyed) {
        console.error('图片转换失败:', error);
        this.message.error('图片转换失败，请重试');
      }
    } finally {
      if (version === this.imageVersion && !this.destroyed) {
        this.isConfirming = false;
        cropper.enable();
      }
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Selecting the same file again must also trigger a change event.
    input.value = '';
    if (file) this.handleFileSelect(file);
  }

  handleFileSelect(file: File): void {
    if (this.destroyed || this.isConfirming) return;
    if (!this.acceptedTypes.includes(file.type)) {
      this.message.error('请选择支持的图片格式 (JPEG, PNG, WebP)');
      return;
    }
    if (file.size > this.maxFileSize) {
      this.message.error(`图片大小不能超过 ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
      return;
    }

    this.releaseImageResources();
    const version = this.imageVersion;
    this.isLoading = true;
    const reader = this.fileReader = new FileReader();
    reader.onload = () => {
      if (version !== this.imageVersion || this.destroyed) return;
      this.fileReader = null;
      this.imageUrl = reader.result as string;
      this.initCropper();
    };
    reader.onerror = () => this.failImageLoad(version, '文件读取失败');
    reader.readAsDataURL(file);
  }

  initCropper(): void {
    const image = this.cropperImage?.nativeElement;
    if (!image || !this.imageUrl || this.destroyed) return;
    this.destroyCropper();
    const version = this.imageVersion;

    // This is the only owner of img.src. Angular's [src] plus a delayed second
    // assignment used to deliver multiple loads and replace the live Cropper
    // with an unready duplicate (issue #738).
    image.onload = () => {
      image.onload = null;
      image.onerror = null;
      if (version !== this.imageVersion || this.destroyed) return;
      try {
        this.cropper = new Cropper(image, {
          aspectRatio: NaN,
          viewMode: 0,
          dragMode: 'move',
          autoCrop: true,
          autoCropArea: 0.6,
          movable: true,
          zoomable: true,
          zoomOnWheel: true,
          cropBoxMovable: true,
          cropBoxResizable: true,
          guides: true,
          center: true,
          highlight: true,
          background: false,
          modal: false,
          responsive: true,
          restore: false,
          checkCrossOrigin: false,
          checkOrientation: false,
          ready: () => {
            if (version !== this.imageVersion || this.destroyed) return;
            this.isReady = true;
            this.isLoading = false;
            this.setDefaultCropBoxSize();
            this.onCropChange();
          },
          // crop fires after geometry changes, including reset and wheel zoom.
          crop: () => {
            if (version === this.imageVersion) this.onCropChange();
          }
        });
      } catch (error) {
        console.error('图片裁剪器初始化失败:', error);
        this.failImageLoad(version, '图片裁剪器初始化失败');
      }
    };
    image.onerror = () => this.failImageLoad(version, '图片加载失败');
    image.src = this.imageUrl;
  }

  private failImageLoad(version: number, message: string): void {
    if (version !== this.imageVersion || this.destroyed) return;
    this.releaseImageResources();
    this.message.error(message);
  }

  setDefaultCropBoxSize(): void {
    if (!this.isReady || !this.cropper) return;
    const container = this.cropper.getContainerData();
    const width = Math.min(container.width, this.defaultWidth * this.CropRatio);
    const height = Math.min(container.height, this.defaultHeight * this.CropRatio);
    this.cropper.setCropBoxData({
      left: (container.width - width) / 2,
      top: (container.height - height) / 2,
      width, height
    });
    this.updateCropSize();
  }

  onCropChange(): void {
    if (!this.isReady || this.isConfirming || this.destroyed) return;
    this.updateCropSize();
    this.clearCropChangeTimer();
    ++this.conversionVersion;
    this.converterService.cancel();
    this.cropChangeTimer = setTimeout(() => {
      this.cropChangeTimer = null;
      void this.handleCropChange();
    }, 120);
  }

  async handleCropChange(): Promise<void> {
    if (!this.isReady || this.isConfirming || this.destroyed) return;
    try {
      await this.convert2bitmap();
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError' && !this.destroyed) {
        console.error('处理裁剪变化失败:', error);
      }
    }
  }

  updateCropSize(): void {
    const data = this.isReady ? this.cropper?.getCropBoxData() : null;
    this._currentCropSize = data && Number.isFinite(data.width) && Number.isFinite(data.height)
      ? { width: Math.max(0, Math.round(data.width)), height: Math.max(0, Math.round(data.height)) }
      : { width: 0, height: 0 };
  }

  private clearCropChangeTimer(): void {
    if (this.cropChangeTimer !== null) clearTimeout(this.cropChangeTimer);
    this.cropChangeTimer = null;
  }

  destroyCropper(): void {
    this.clearCropChangeTimer();
    this.isReady = false;
    this.cropper?.destroy();
    this.cropper = null;
  }

  releaseImageResources(): void {
    ++this.imageVersion;
    ++this.conversionVersion;
    if (this.fileReader) {
      this.fileReader.onload = null;
      this.fileReader.onerror = null;
      if (this.fileReader.readyState === FileReader.LOADING) this.fileReader.abort();
      this.fileReader = null;
    }
    const image = this.cropperImage?.nativeElement;
    if (image) {
      image.onload = null;
      image.onerror = null;
    }
    this.converterService.cancel();
    this.destroyCropper();
    image?.removeAttribute('src');
    if (this.imageUrl?.startsWith('blob:')) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl = null;
    this.isLoading = false;
    this.isConfirming = false;
    this.bitmapArray = [];
    this._currentCropSize = { width: 0, height: 0 };
    const canvas = this.myCanvas?.nativeElement;
    if (canvas) canvas.width = canvas.height = 0;
  }

  resetComponent(): void {
    this.releaseImageResources();
    this.isDragOver = false;
  }

  centerCropBox(): void {
    this.resetCropper();
  }

  resetCropper(): void {
    if (this.isReady && !this.isConfirming) {
      this.cropper?.reset();
      this.setDefaultCropBoxSize();
    }
  }

  async convert2bitmap(): Promise<boolean> {
    const cropper = this.cropper;
    const canvas = this.myCanvas?.nativeElement;
    if (!this.isReady || !cropper || !canvas || this.destroyed) return false;
    this.updateCropSize();
    const { width, height } = this.currentCropSize;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return false;
    const croppedCanvas = cropper.getCroppedCanvas({
      width, height,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
      fillColor: 'transparent'
    });
    // Never pass an unready/empty Cropper result to drawImage or submit old data.
    if (!croppedCanvas || !croppedCanvas.width || !croppedCanvas.height) return false;
    const context = canvas.getContext('2d');
    if (!context) return false;
    const version = ++this.conversionVersion;
    this.converterService.cancel();
    canvas.width = width;
    canvas.height = height;
    canvas.style.transform = 'scale(1.5)';
    context.drawImage(croppedCanvas, 0, 0, width, height);
    await this.converterService.convert(context, context.getImageData(0, 0, width, height), { ...this.options });
    if (version !== this.conversionVersion || cropper !== this.cropper || this.destroyed) return false;
    this.bitmapArray = this.converterService.getBitmap2DArray();
    return true;
  }
}
