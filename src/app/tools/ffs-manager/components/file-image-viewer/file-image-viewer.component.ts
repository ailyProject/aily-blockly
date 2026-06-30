import { Component, ElementRef, Inject, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';

export interface FileImageViewerData {
  name: string;
  data: Uint8Array;
  mime?: string;
}

@Component({
  selector: 'app-file-image-viewer',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './file-image-viewer.component.html',
  styleUrl: './file-image-viewer.component.scss',
})
export class FileImageViewerComponent implements OnInit, OnDestroy {
  @ViewChild('contentEl') contentEl!: ElementRef<HTMLElement>;

  imageUrl = '';
  sizeText = '';

  scale = 1;
  translateX = 0;
  translateY = 0;
  isDragging = false;

  readonly MIN_SCALE = 0.1;
  readonly MAX_SCALE = 8;
  readonly SCALE_STEP = 0.1;

  private dragStartX = 0;
  private dragStartY = 0;
  private lastTranslateX = 0;
  private lastTranslateY = 0;
  private hasDragged = false;
  private rafId = 0;

  constructor(
    private modal: NzModalRef,
    private ngZone: NgZone,
    @Inject(NZ_MODAL_DATA) public data: FileImageViewerData,
  ) {}

  ngOnInit(): void {
    const bytes = this.data.data || new Uint8Array();
    this.sizeText = this.formatBytes(bytes.byteLength);
    const mime = this.data.mime || this.guessMime(this.data.name);
    this.imageUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
  }

  ngOnDestroy(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    document.removeEventListener('mousemove', this.onDocumentMouseMove);
    document.removeEventListener('mouseup', this.onDocumentMouseUp);
    document.body.style.userSelect = '';
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
  }

  getTransform(): string {
    return `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const delta = event.deltaY > 0 ? -this.SCALE_STEP : this.SCALE_STEP;
    const newScale = Math.max(this.MIN_SCALE, Math.min(this.MAX_SCALE, this.scale + delta));
    if (newScale !== this.scale) {
      const ratio = newScale / this.scale;
      this.translateX = mouseX - (mouseX - this.translateX) * ratio;
      this.translateY = mouseY - (mouseY - this.translateY) * ratio;
      this.scale = newScale;
    }
  }

  onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    this.hasDragged = false;
    this.isDragging = true;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.lastTranslateX = this.translateX;
    this.lastTranslateY = this.translateY;

    if (this.contentEl?.nativeElement) {
      this.contentEl.nativeElement.style.transition = 'none';
    }
    event.preventDefault();
    document.body.style.userSelect = 'none';

    this.ngZone.runOutsideAngular(() => {
      document.addEventListener('mousemove', this.onDocumentMouseMove);
      document.addEventListener('mouseup', this.onDocumentMouseUp);
    });
  }

  onContainerClick(event: MouseEvent): void {
    if (this.hasDragged) return;
    const target = event.target as Element;
    // 点击图片本体不关闭
    if (target && target.tagName?.toLowerCase() === 'img') return;
    this.close();
  }

  zoomIn(): void {
    this.scale = Math.min(this.MAX_SCALE, this.scale + this.SCALE_STEP * 2);
  }

  zoomOut(): void {
    this.scale = Math.max(this.MIN_SCALE, this.scale - this.SCALE_STEP * 2);
  }

  resetTransform(): void {
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
  }

  close(): void {
    this.modal.close();
  }

  private onDocumentMouseMove = (event: MouseEvent): void => {
    if (!this.isDragging) return;
    const dx = event.clientX - this.dragStartX;
    const dy = event.clientY - this.dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.hasDragged = true;
    this.translateX = this.lastTranslateX + dx;
    this.translateY = this.lastTranslateY + dy;
    if (!this.rafId) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = 0;
        if (this.contentEl?.nativeElement) {
          this.contentEl.nativeElement.style.transform = this.getTransform();
        }
      });
    }
  };

  private onDocumentMouseUp = (_event: MouseEvent): void => {
    this.isDragging = false;
    document.body.style.userSelect = '';
    if (this.contentEl?.nativeElement) {
      this.contentEl.nativeElement.style.transition = '';
    }
    document.removeEventListener('mousemove', this.onDocumentMouseMove);
    document.removeEventListener('mouseup', this.onDocumentMouseUp);
    this.ngZone.run(() => {});
  };

  private guessMime(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    if (ext === 'svg') return 'image/svg+xml';
    if (ext === 'ico') return 'image/x-icon';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    return ext ? `image/${ext}` : 'application/octet-stream';
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
}
