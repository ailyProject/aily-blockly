import { ChangeDetectorRef, Component, HostListener, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RIGHT_MENU } from '../right-menu.config';
import { ShowNRPipe } from './show-nr.pipe';
import { ShowHexPipe } from './show-hex.pipe';
import { AddNewLinePipe } from './add-newline.pipe';
import { NzMessageService } from 'ng-zorro-antd/message';
import { MenuComponent } from '../../components/menu/menu.component';
import { SerialMonitorService } from '../../services/serial-monitor.service';

@Component({
  selector: 'app-data-item',
  imports: [MenuComponent, CommonModule, ShowNRPipe, ShowHexPipe, AddNewLinePipe],
  templateUrl: './data-item.component.html',
  styleUrl: './data-item.component.scss',
})
export class DataItemComponent {
  rightMenu = JSON.parse(JSON.stringify(RIGHT_MENU));

  @Input() data;
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
    private message: NzMessageService
  ) { }


  closeMenu() {
    this.showMenu = false;
  }

  menuClick(item) {
    console.log(item.data.action);
    switch (item.data.action) {
      case 'copy':
        this.copyText();
        break;
      case 'hex':
        this.toggleHex();
        break;
      case 'highlight':
        this.toggleHighlight();
        break;
    }
    this.closeMenu()
    this.cd.detectChanges();
  }

  copyText() {
    const text = this.data.data;
    navigator.clipboard.writeText(text).then(() => {
      this.message.info('已复制到剪贴板');
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

  // 添加一个方法来高亮搜索关键词
  highlightSearchTerm(text: string, searchTerm: string): string {
    if (!searchTerm || searchTerm.trim() === '') return text;
    const regex = new RegExp(searchTerm, 'gi');
    return text.replace(regex, match => `<span class="search-highlight">${match}</span>`);
  }

  // 添加一个获取文本内容的方法
  getDisplayText() {
    if (!this.data || !this.data.data) return '';

    let text = '';
    if (Buffer.isBuffer(this.data.data)) {
      text = this.data.data.toString();
    } else {
      text = String(this.data.data);
    }

    // 应用高亮
    return this.highlightSearchTerm(text, this.searchKeyword);
  }
}
