import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';

export interface FileTextViewerData {
  name: string;
  data: Uint8Array;
  /** 超过此大小则截断显示；默认 256 KB */
  maxBytes?: number;
}

@Component({
  selector: 'app-file-text-viewer',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './file-text-viewer.component.html',
  styleUrl: './file-text-viewer.component.scss',
})
export class FileTextViewerComponent implements OnInit {
  text = '';
  truncated = false;
  totalSizeText = '';
  shownSizeText = '';

  constructor(
    private modal: NzModalRef,
    @Inject(NZ_MODAL_DATA) public data: FileTextViewerData,
  ) {}

  ngOnInit(): void {
    const max = this.data.maxBytes ?? 256 * 1024;
    const bytes = this.data.data || new Uint8Array();
    this.totalSizeText = this.formatBytes(bytes.byteLength);
    this.truncated = bytes.byteLength > max;
    const slice = this.truncated ? bytes.subarray(0, max) : bytes;
    this.shownSizeText = this.formatBytes(slice.byteLength);
    try {
      this.text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
    } catch {
      this.text = '';
    }
  }

  async copyAll(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.text);
    } catch {
      // ignore
    }
  }

  close(): void {
    this.modal.close();
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
}
