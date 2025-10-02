import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { TranslateModule } from '@ngx-translate/core';

export interface DialogButton {
  text: string;
  type?: 'default' | 'primary' | 'dashed' | 'link' | 'text';
  danger?: boolean;
  disabled?: boolean;
  loading?: boolean;
  size?: 'small' | 'default' | 'large';
  action: string; // 按钮点击时触发的动作标识
}

@Component({
  selector: 'app-base-dialog',
  standalone: true,
  imports: [CommonModule, NzButtonModule, TranslateModule],
  templateUrl: './base-dialog.component.html',
  styleUrl: './base-dialog.component.scss'
})
export class BaseDialogComponent {
  // Dialog 标题
  @Input() title: string = '';
  
  // 是否显示关闭按钮
  @Input() showCloseButton: boolean = true;
  
  // 是否显示 footer
  @Input() showFooter: boolean = true;
  
  // footer 按钮配置
  @Input() buttons: DialogButton[] = [];
  
  // 自定义类名
  @Input() customClass: string = '';
  
  // 是否加载中
  @Input() loading: boolean = false;
  
  // 关闭事件
  @Output() closeDialog = new EventEmitter<void>();
  
  // 按钮点击事件
  @Output() buttonClick = new EventEmitter<string>();

  onClose(): void {
    this.closeDialog.emit();
  }

  onButtonClick(action: string): void {
    this.buttonClick.emit(action);
  }
}
