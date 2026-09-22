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
  @Input() state: 'default' | 'doing' | 'done' | 'error' | 'warn' | 'running' | 'stopping' = 'default';

  @Output() stateChange = new EventEmitter<'default' | 'doing' | 'done' | 'error' | 'warn' | 'running' | 'stopping'>();

  constructor() {
  }

  ngOnInit() {

  }

  toWink = false;
  private resetStateTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnChanges(changes: SimpleChanges) {
    if (changes['state']) {
      if (this.resetStateTimer) {
        clearTimeout(this.resetStateTimer);
        this.resetStateTimer = null;
      }
      if (this.state != 'doing' && this.state != 'default' && this.state != 'running' && this.state != 'stopping') {
        this.resetStateTimer = setTimeout(() => {
          this.resetStateTimer = null;
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
}
