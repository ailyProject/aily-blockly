import { CommonModule } from '@angular/common';
import { Component, Input, Output, EventEmitter } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzMessageService } from 'ng-zorro-antd/message';

@Component({
  selector: 'app-user',
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule
  ],
  templateUrl: './user.component.html',
  styleUrl: './user.component.scss'
})
export class UserComponent {

  @Input() position = {
    x: 0,
    y: 40,
  };

  @Input() width = 300;

  @Output() closeEvent = new EventEmitter<void>();

  constructor(
    private message: NzMessageService
  ) {
  }

  onLogin() {
    console.log('用户登录');
    // 这里可以添加登录逻辑
    this.closeEvent.emit();
  }

  onRegister() {
    console.log('用户注册');
    // 这里可以添加注册逻辑
    this.closeEvent.emit();
  }

  onSettings() {
    console.log('用户设置');
    // 这里可以添加设置逻辑
    this.closeEvent.emit();
  }

  more() {
    this.message.warning('服务暂不可用');
  }

}
