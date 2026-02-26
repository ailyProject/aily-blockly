import { Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-image-viewer',
  imports: [CommonModule],
  templateUrl: './image-viewer.component.html',
  styleUrl: './image-viewer.component.scss'
})
export class ImageViewerComponent implements OnDestroy {
  visible = false;
  img = '';

  // 缩放和拖拽相关属性
  scale = 1;
  translateX = 0;
  translateY = 0;

  // 拖拽状态
  isDragging = false;
  hasDragged = false;
  dragStartX = 0;
  dragStartY = 0;
  lastTranslateX = 0;
  lastTranslateY = 0;

  // 缩放参数
  readonly MIN_SCALE = 0.1;
  readonly MAX_SCALE = 10;
  readonly SCALE_STEP = 0.1;

  /**
   * 打开图片查看器
   * @param imgPath 图片路径
   */
  open(imgPath: string): void {
    this.img = imgPath;
    this.resetView();
    this.visible = true;
  }

  /**
   * 关闭图片查看器
   */
  close(): void {
    this.visible = false;
    this.img = '';
  }

  ngOnDestroy(): void {
    document.removeEventListener('mousemove', this.onDocumentMouseMove);
    document.removeEventListener('mouseup', this.onDocumentMouseUp);
    document.body.style.userSelect = '';
  }

  // 点击背景关闭（只在未拖拽时触发）
  onBackdropClick(event: MouseEvent): void {
    if (!this.hasDragged) {
      this.close();
    }
  }

  // 阻止图片点击事件冒泡（防止误关闭）
  onImageClick(event: MouseEvent): void {
    if (!this.hasDragged) {
      event.stopPropagation();
    }
  }

  // 图片加载完成
  onImageLoad(event: Event): void {
    // 加载完成后自动居中
    this.resetView();
  }

  // 鼠标滚轮缩放
  onWheel(event: WheelEvent): void {
    event.preventDefault();

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const delta = event.deltaY > 0 ? -this.SCALE_STEP : this.SCALE_STEP;
    const newScale = Math.max(this.MIN_SCALE, Math.min(this.MAX_SCALE, this.scale + delta));

    if (newScale !== this.scale) {
      const scaleRatio = newScale / this.scale;
      this.translateX = mouseX - (mouseX - this.translateX) * scaleRatio;
      this.translateY = mouseY - (mouseY - this.translateY) * scaleRatio;
      this.scale = newScale;
    }
  }

  // 鼠标按下开始拖拽
  onMouseDown(event: MouseEvent): void {
    if (event.button === 0) {
      this.isDragging = true;
      this.hasDragged = false;
      this.dragStartX = event.clientX;
      this.dragStartY = event.clientY;
      this.lastTranslateX = this.translateX;
      this.lastTranslateY = this.translateY;

      event.preventDefault();
      document.body.style.userSelect = 'none';

      document.addEventListener('mousemove', this.onDocumentMouseMove);
      document.addEventListener('mouseup', this.onDocumentMouseUp);
    }
  }

  // 全局鼠标移动事件
  onDocumentMouseMove = (event: MouseEvent): void => {
    if (this.isDragging) {
      const deltaX = event.clientX - this.dragStartX;
      const deltaY = event.clientY - this.dragStartY;

      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
        this.hasDragged = true;
      }

      this.translateX = this.lastTranslateX + deltaX;
      this.translateY = this.lastTranslateY + deltaY;
    }
  };

  // 全局鼠标松开事件
  onDocumentMouseUp = (event: MouseEvent): void => {
    this.isDragging = false;
    document.body.style.userSelect = '';

    document.removeEventListener('mousemove', this.onDocumentMouseMove);
    document.removeEventListener('mouseup', this.onDocumentMouseUp);

    // 延迟重置 hasDragged，让 click 事件先判断
    setTimeout(() => {
      this.hasDragged = false;
    }, 0);
  };

  // 重置视图
  resetView(): void {
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
  }

  // 获取变换样式
  getTransform(): string {
    return `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
  }
}
