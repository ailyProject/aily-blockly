import { CommonModule } from '@angular/common';
import { Component, ElementRef, Input, ViewChild } from '@angular/core';
import {
  AngularDraggableModule,
  AngularResizableDirective,
} from 'angular2-draggable';
import { IWindowOpts, IwindowService } from '@core/app-shell/public-api';
@Component({
  selector: 'app-inner-window',
  imports: [AngularDraggableModule, CommonModule],
  templateUrl: './inner-window.component.html',
  styleUrl: './inner-window.component.scss',
})
export class InnerWindowComponent {
  @Input() opts: IWindowOpts;

  optsDefault = {
    position: { x: 0, y: 0 },
    size: { width: 400, height: 600, minWidth: 400, minHeight: 600 },
    zindex: 0,
  };

  @ViewChild('block') block: AngularResizableDirective;

  isMinimize = false;
  isMaximize = false;
  isClose = false;

  constructor(private iwindowService: IwindowService) {}

  ngOnInit(): void {
    // console.log(this.opts);
    this.opts.position = this.opts.position || this.optsDefault.position;
    this.opts.size = this.opts.size || this.optsDefault.size;
    this.opts.zindex = this.opts.zindex || this.optsDefault.zindex;
    // this.sourcePosition = JSON.parse(JSON.stringify(this.opts.position));
  }

  ngAfterViewInit(): void {}

  oldSize;
  oldPosition;
  offsetPosition = { x: 0, y: 0 };

  maximize() {
    // console.log(JSON.stringify(this.opts.position));

    if (
      this.opts.size.width == window.innerWidth &&
      this.opts.size.height == window.innerHeight &&
      this.opts.position.x == 0 - this.offsetPosition.x &&
      this.opts.position.y == 0 - this.offsetPosition.y
    ) {
      this.isMaximize = true;
    } else {
      this.isMaximize = false;
    }

    if (this.isMaximize) {
      // 恢复size
      console.log(
        '恢复 ' + this.opts.title,
        JSON.parse(JSON.stringify(this.oldSize)),
      );
      this.isMaximize = false;
      this.opts.size = JSON.parse(JSON.stringify(this.oldSize));
      this.opts.position = JSON.parse(JSON.stringify(this.oldPosition));
    } else {
      // 最大化size
      console.log('最大化 ' + this.opts.title);
      this.isMaximize = true;
      this.oldSize = JSON.parse(JSON.stringify(this.opts.size));
      this.oldPosition = JSON.parse(JSON.stringify(this.opts.position));
      this.opts.position = {
        x: 0 - this.offsetPosition.x,
        y: 0 - this.offsetPosition.y,
      };
      this.opts.size.width = window.innerWidth;
      this.opts.size.height = window.innerHeight;
    }
  }

  minimize() {
    this.isMinimize = true;
    this.opts.zindex = -999;
  }

  close() {
    this.isClose = true;
    setTimeout(() => {
      this.iwindowService.closeWindow(this.opts);
    }, 300);
  }

  onFoucs(event) {
    if (this.opts.zindex > 0)
      this.opts.zindex = this.iwindowService.getMaxZindex() + 1;
  }

  onMoveEnd(event) {
    this.opts.position.x = event.x;
    this.opts.position.y = event.y;
  }

  onResizeStop(event) {
    console.log(event);
    this.opts.size.width = event.size.width;
    this.opts.size.height = event.size.height;
    this.offsetPosition = { x: event.position.left, y: event.position.top };
  }
}
