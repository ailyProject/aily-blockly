import { Component, EventEmitter, Input, Output } from '@angular/core';
import { NzTabsModule } from 'ng-zorro-antd/tabs';
import { UiService, WindowOpts } from '../../services/ui.service';

@Component({
  selector: 'app-tool-container',
  imports: [NzTabsModule],
  templateUrl: './tool-container.component.html',
  styleUrl: './tool-container.component.scss',
})
export class ToolContainerComponent {
  @Input() title: string = '工具';
  @Input() path: string;

  @Output() closeEvent = new EventEmitter();

  @Output() copyEvent = new EventEmitter();

  @Output() trashEvent = new EventEmitter();

  @Output() refreshEvent = new EventEmitter();

  constructor(private uiService: UiService) {}

  close() {
    this.closeEvent.emit();
  }

  trash() {
    this.trashEvent.emit();
  }

  refresh() {
    this.refreshEvent.emit();
  }

  copy() {
    this.copyEvent.emit();
  }

  openWindow() {
    this.uiService.openWindow({
      path: this.path,
      title: this.title,
      // alwaysOnTop: true,
      width: 1200,
      height: 800,
    });
    this.close();
  }
}
