import { Component, Inject, OnInit, ChangeDetectorRef, ViewChild, ElementRef } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { TranslateModule } from '@ngx-translate/core';
import { BaseDialogComponent, DialogButton } from '../../../components/base-dialog/base-dialog.component';
import { HttpClient } from '@angular/common/http';
import { marked } from 'marked';

@Component({
  selector: 'app-markdown-dialog',
  imports: [CommonModule, NzIconModule, TranslateModule, BaseDialogComponent],
  templateUrl: './markdown-dialog.component.html',
  styleUrls: ['./markdown-dialog.component.scss']
})
export class MarkdownDialogComponent implements OnInit {
  title: string;
  docUrl: string;
  loading = true;

  @ViewChild('markdown', { static: false }) markdownEl: ElementRef<HTMLDivElement>;

  buttons: DialogButton[] = [
    { text: 'COMMON.CLOSE', type: 'default', action: 'close' }
  ];

  constructor(
    @Inject(NZ_MODAL_DATA) public data: any,
    private modal: NzModalRef,
    private cd: ChangeDetectorRef,
    private http: HttpClient,
  ) {
    this.title = data.title || '';
    this.docUrl = data.docUrl || '';
    if (data.buttons?.length) {
      this.buttons = data.buttons;
    }
  }

  ngOnInit() {
    this.loadMarkdown();
  }

  onClose(): void {
    this.modal.close();
  }

  onButtonClick(action: string): void {
    this.modal.close(action);
  }

  private loadMarkdown() {
    if (!this.docUrl) {
      this.loading = false;
      return;
    }
    this.http.get(this.docUrl, { responseType: 'text' }).subscribe({
      next: async (md) => {
        const renderer = new marked.Renderer();
        renderer.link = ({ href, text }) => text || href || '';
        const html = await marked.parse(md, { renderer });
        if (this.markdownEl?.nativeElement) {
          this.markdownEl.nativeElement.innerHTML = html as string;
        }
        this.loading = false;
        this.cd.detectChanges();
      },
      error: () => {
        this.loading = false;
        this.cd.detectChanges();
      }
    });
  }
}
