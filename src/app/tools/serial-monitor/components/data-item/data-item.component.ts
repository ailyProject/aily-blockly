import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SerialMonitorService } from '../../serial-monitor.service';
import { ShowNRPipe } from './show-nr.pipe';
import { ShowHexPipe } from './show-hex.pipe';
import { AddNewLinePipe } from './add-newline.pipe';

@Component({
  selector: 'app-data-item',
  imports: [CommonModule, ShowNRPipe, ShowHexPipe, AddNewLinePipe],
  templateUrl: './data-item.component.html',
  styleUrl: './data-item.component.scss',
})
export class DataItemComponent {
  @Input() data;
  @Input() searchKeyword: string = '';

  get viewMode() {
    return this.serialMonitorService.viewMode;
  }

  constructor(
    private serialMonitorService: SerialMonitorService,
  ) { }

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
