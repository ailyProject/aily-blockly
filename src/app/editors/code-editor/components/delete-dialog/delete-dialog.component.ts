import { Component, Inject, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';

@Component({
  selector: 'app-delete-dialog',
  imports: [NzButtonModule, CommonModule, NzIconModule],
  templateUrl: './delete-dialog.component.html',
  styleUrls: ['./delete-dialog.component.scss']
})
export class DeleteDialogComponent implements OnInit, OnDestroy {
  title: string;
  text: string;
  nodes: any[];

  constructor(
    @Inject(NZ_MODAL_DATA) public data: any,
    private modal: NzModalRef,
  ) {
    this.title = data.title || '确认删除';
    this.text = data.text || '';
    this.nodes = data.nodes || [];
    // console.log('DeleteDialogComponent data:', data);
  }

  ngOnInit() {
  }

  ngOnDestroy() {
  }

  getFormattedText(): string {
    return this.nodes.map(node => node.title).join(', ');
  }

  close(result: string = '') {
    this.modal.close(result);
  }

  cancel() {
    this.close('cancel');
  }

  deleteFile() {
    this.close('confirm');
  }
}
