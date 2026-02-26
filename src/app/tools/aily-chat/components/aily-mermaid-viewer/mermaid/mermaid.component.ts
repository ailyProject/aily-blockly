import { Component, Inject, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';

export interface MermaidModalData {
  svg?: string;
  rawCode?: string;
}

@Component({
  selector: 'app-mermaid',
  standalone: true,
  imports: [CommonModule, NzButtonModule, NzIconModule],
  templateUrl: './mermaid.component.html',
  styleUrl: './mermaid.component.scss'
})
export class MermaidComponent implements OnInit, OnDestroy {
  renderedSvg: SafeHtml = '';
  
  // 缩放和拖拽相关属性
  scale = 1;
  translateX = 0;
  translateY = 0;
  
  // 拖拽状态
  isDragging = false;
  dragStartX = 0;
  dragStartY = 0;
  lastTranslateX = 0;
  lastTranslateY = 0;
  
  // 缩放参数
  readonly MIN_SCALE = 0.1;
  readonly MAX_SCALE = 5;
  readonly SCALE_STEP = 0.1;
  
  constructor(
    private modal: NzModalRef,
    private sanitizer: DomSanitizer,
    @Inject(NZ_MODAL_DATA) public data: MermaidModalData
  ) {}

  ngOnInit(): void {
    if (this.data?.svg) {
      this.renderedSvg = this.sanitizer.bypassSecurityTrustHtml(this.data.svg);
    }
  }

  ngOnDestroy(): void {
    // 清理全局事件监听器，防止内存泄漏
    document.removeEventListener('mousemove', this.onDocumentMouseMove);
    document.removeEventListener('mouseup', this.onDocumentMouseUp);
    document.body.style.userSelect = '';
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
      // 以鼠标位置为中心缩放
      const scaleRatio = newScale / this.scale;
      this.translateX = mouseX - (mouseX - this.translateX) * scaleRatio;
      this.translateY = mouseY - (mouseY - this.translateY) * scaleRatio;
      this.scale = newScale;
    }
  }

  // 鼠标按下开始拖拽
  onMouseDown(event: MouseEvent): void {
    if (event.button === 0) { // 左键
      this.isDragging = true;
      this.dragStartX = event.clientX;
      this.dragStartY = event.clientY;
      this.lastTranslateX = this.translateX;
      this.lastTranslateY = this.translateY;
      
      // 防止文本选择
      event.preventDefault();
      document.body.style.userSelect = 'none';
      
      // 添加全局鼠标事件监听，确保在整个窗口范围内都能拖拽
      document.addEventListener('mousemove', this.onDocumentMouseMove);
      document.addEventListener('mouseup', this.onDocumentMouseUp);
    }
  }

  // 全局鼠标移动事件
  onDocumentMouseMove = (event: MouseEvent): void => {
    if (this.isDragging) {
      const deltaX = event.clientX - this.dragStartX;
      const deltaY = event.clientY - this.dragStartY;
      
      this.translateX = this.lastTranslateX + deltaX;
      this.translateY = this.lastTranslateY + deltaY;
    }
  }

  // 全局鼠标松开事件
  onDocumentMouseUp = (event: MouseEvent): void => {
    this.isDragging = false;
    document.body.style.userSelect = '';
    
    // 移除全局事件监听
    document.removeEventListener('mousemove', this.onDocumentMouseMove);
    document.removeEventListener('mouseup', this.onDocumentMouseUp);
  }

  // 获取变换样式
  getTransform(): string {
    return `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
  }

  close(): void {
    this.modal.close();
  }
}
