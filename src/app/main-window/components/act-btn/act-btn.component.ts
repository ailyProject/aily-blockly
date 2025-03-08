import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, SimpleChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-act-btn',
  imports: [CommonModule, FormsModule],
  templateUrl: './act-btn.component.html',
  styleUrl: './act-btn.component.scss'
})
export class ActBtnComponent {
  @Input() icon: string;
  @Input() color: string = '#FFF';
  @Input() state: 'default' | 'doing' | 'done' | 'error' | 'warn' = 'default';

  @Output() stateChange = new EventEmitter<'default' | 'doing' | 'done' | 'error' | 'warn'>();

  disabled = false;

  onClick() {

  }

  constructor() {
  }

  ngOnInit() {

  }

  toWink = false;
  ngOnChanges(changes: SimpleChanges) {
    if (changes['state']) {
      if (this.state != 'doing' && this.state != 'default') {
        setTimeout(() => {
          this.stateChange.emit('default');
          this.toWink = false;
        }, 6000);
      }
      if (this.state == 'done') {
        setTimeout(() => {
          this.toWink = true;
          setTimeout(() => {
            this.toWink = false;
          }, 1000);
        }, 1000);
      }
    }
  }


  // test() {
  //   const states: ('default' | 'loading' | 'success' | 'error' | 'warn')[] =
  //     ['default', 'loading', 'success', 'error', 'warn'];
  //   let currentIndex = 0;

  //   console.log('开始状态循环测试');

  //   // 先立即设置一次，然后每10秒改变一次状态
  //   this.state = states[currentIndex];
  //   console.log(`状态已设置为: ${this.state}`);

  //   setInterval(() => {
  //     currentIndex = (currentIndex + 1) % states.length;
  //     this.state = states[currentIndex];
  //     console.log(`状态已更改为: ${this.state}`);
  //   }, 10000);
  // }
}
