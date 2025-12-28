import { ChangeDetectorRef, Component, HostListener, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Buffer } from 'buffer';
import { SerialMonitorService } from '../../services/serial-monitor.service';
import { ShowNRPipe } from './show-nr.pipe';
import { ShowHexPipe } from './show-hex.pipe';
import { AddNewLinePipe } from './add-newline.pipe';
import { MenuComponent } from '../menu/menu.component';
import { RIGHT_MENU } from '../../config/right-menu.config';
import { PenpalService } from '../../penpal/penpal.service';

@Component({
  selector: 'app-data-item',
  imports: [CommonModule, ShowNRPipe, ShowHexPipe, AddNewLinePipe, MenuComponent],
  templateUrl: './data-item.component.html',
  styleUrl: './data-item.component.scss',
})
export class DataItemComponent {
  rightMenu = JSON.parse(JSON.stringify(RIGHT_MENU));

  @Input() data: any;
  @Input() searchKeyword: string = '';

  position = { x: 0, y: 0 };
  showMenu = false;

  get viewMode() {
    return this.serialMonitorService.viewMode;
  }

  @HostListener('contextmenu', ['$event'])
  onRightClick(event: MouseEvent) {
    if (this.viewMode.showTimestamp) {
      event.preventDefault();
      this.position.x = event.clientX;
      this.position.y = event.clientY;
      this.viewMode.autoScroll = false;
      setTimeout(() => {
        this.showMenu = true;
        this.cd.detectChanges();
      });
    }
    return false;
  }

  constructor(
    private serialMonitorService: SerialMonitorService,
    private cd: ChangeDetectorRef,
    private penpalService: PenpalService
  ) { }

  closeMenu() {
    this.showMenu = false;
  }

  menuClick(item: any) {
    console.log(item.data.action);
    switch (item.data.action) {
      case 'copy':
        this.copyText();
        break;
      case 'copyAll':
        this.copyAllText();
        break;
      case 'copyAsHex':
        this.copyAsHex();
        break;
    }
    this.closeMenu();
    this.cd.detectChanges();
  }

  copyText() {
    let text = '';
    if (Buffer.isBuffer(this.data.data)) {
      text = this.data.data.toString();
    } else {
      text = String(this.data.data);
    }
    navigator.clipboard.writeText(text).then(() => {
      this.penpalService.showMessage('info', '已复制到剪贴板');
    });
  }

  copyAllText() {
    let text = '';
    for (const item of this.serialMonitorService.dataList) {
      if (Buffer.isBuffer(item.data)) {
        text += item.data.toString();
      } else {
        text += String(item.data);
      }
      text += '\n';
    }
    navigator.clipboard.writeText(text).then(() => {
      this.penpalService.showMessage('info', '已复制到剪贴板');
    });
  }

  copyAsHex() {
    let hexText = '';
    if (Buffer.isBuffer(this.data.data)) {
      hexText = Array.from(this.data.data as Buffer)
        .map((byte: number) => byte.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
    } else {
      const buffer = Buffer.from(String(this.data.data));
      hexText = Array.from(buffer)
        .map((byte: number) => byte.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
    }
    navigator.clipboard.writeText(hexText).then(() => {
      this.penpalService.showMessage('info', '已复制HEX到剪贴板');
    });
  }

  showHex = false;
  toggleHex() {
    this.showHex = !this.showHex;
    if (this.showHex) {
      this.rightMenu[1].name = '文本显示';
    } else {
      this.rightMenu[1].name = 'Hex显示';
    }
  }

  showHighlight = false;
  toggleHighlight() {
    this.showHighlight = !this.showHighlight;
    if (this.showHighlight) {
      this.rightMenu[2].name = '取消高亮';
    } else {
      this.rightMenu[2].name = '高亮标记';
    }
  }

  highlightSearchTerm(text: string, searchTerm: string): string {
    if (!searchTerm || searchTerm.trim() === '') return text;
    const regex = new RegExp(searchTerm, 'gi');
    return text.replace(regex, match => `<span class="search-highlight">${match}</span>`);
  }

  getDisplayText() {
    if (!this.data || !this.data.data) return '';

    let text = '';
    if (Buffer.isBuffer(this.data.data)) {
      text = this.data.data.toString();
    } else {
      text = String(this.data.data);
    }

    return this.highlightSearchTerm(text, this.searchKeyword);
  }
}
