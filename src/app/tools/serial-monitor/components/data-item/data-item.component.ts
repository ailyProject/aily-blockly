import { Component, HostListener, Input } from '@angular/core';
import { MenuComponent } from '../../../../components/menu/menu.component';
import { CommonModule } from '@angular/common';
import { RIGHT_MENU } from '../../right-menu.config';

@Component({
  selector: 'app-data-item',
  imports: [MenuComponent, CommonModule],
  templateUrl: './data-item.component.html',
  styleUrl: './data-item.component.scss',
})
export class DataItemComponent {
  rightMenu = RIGHT_MENU;

  @Input() data;

  position = { x: 0, y: 0 };
  showMenu = false;

  mode = 1; //1:文本查看 2:Hex查看

  @HostListener('contextmenu', ['$event'])
  onRightClick(event: MouseEvent) {
    event.preventDefault();
    this.position.x = event.clientX;
    this.position.y = event.clientY;
    this.showMenu = true;
    // 可在此处根据需求记录右键菜单触发的相关数据
    return false;
  }

  constructor() {}

  closeMenu() {
    this.showMenu = false;
  }

  menuClick(item) {
    this.convert2Hex(this.data.data)
    this.mode = 2;

    this.closeMenu()
  }

  convert2Hex(data) {
    const hexArray = [];
    for (let i = 0; i < data.length; i++) {
      const hex = data.charCodeAt(i).toString(16).padStart(2, '0');
      hexArray.push(hex);
    }
    // 返回由空格分隔的 HEX 字符串，也可以根据需求修改格式
    this.data['source'] = hexArray.join(' ');
    console.log(this.data['source']);
    
  }
}
