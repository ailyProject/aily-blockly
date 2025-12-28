import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DATA_BITS_LIST, STOP_BITS_LIST, PARITY_LIST, FLOW_CONTROL_LIST } from '../../config/serial.config';
import { MenuComponent } from '../menu/menu.component';

@Component({
  selector: 'app-setting-more',
  imports: [CommonModule, FormsModule, MenuComponent],
  templateUrl: './setting-more.component.html',
  styleUrl: './setting-more.component.scss'
})
export class SettingMoreComponent {
  dataBitsList = DATA_BITS_LIST;
  stopBitsList = STOP_BITS_LIST;
  parityList = PARITY_LIST;
  flowControlList = FLOW_CONTROL_LIST;

  // 当前选中的值
  selectedDataBits: any;
  selectedStopBits: any;
  selectedParity: any;
  selectedFlowControl: any;

  showMenu = false;

  @Output() settingsChanged = new EventEmitter<any>();

  ngOnInit(): void {
    this.selectedDataBits = this.dataBitsList.find(item => item.isDefault) || this.dataBitsList[0];
    this.selectedStopBits = this.stopBitsList.find(item => item.isDefault) || this.stopBitsList[0];
    this.selectedParity = this.parityList.find(item => item.isDefault) || this.parityList[0];
    this.selectedFlowControl = this.flowControlList.find(item => item.isDefault) || this.flowControlList[0];
  }

  onSettingChange(): void {
    this.settingsChanged.emit({
      dataBits: this.selectedDataBits,
      stopBits: this.selectedStopBits,
      parity: this.selectedParity,
      flowControl: this.selectedFlowControl
    });
  }

  position = { x: 0, y: 0 };
  menuList: any[] | null = null;

  openMenu(el: any, menuList: any[]): void {
    let rect = el.srcElement.getBoundingClientRect();
    this.position.x = rect.left;
    this.position.y = rect.bottom + 2;
    this.menuList = menuList;
    this.showMenu = !this.showMenu;
  }

  closeMenu(): void {
    this.showMenu = false;
    this.menuList = null;
  }

  select(item: any) {
    if (this.menuList === this.dataBitsList) {
      this.selectedDataBits = item;
    } else if (this.menuList === this.stopBitsList) {
      this.selectedStopBits = item;
    } else if (this.menuList === this.parityList) {
      this.selectedParity = item;
    } else if (this.menuList === this.flowControlList) {
      this.selectedFlowControl = item;
    }
    this.onSettingChange();
    this.closeMenu();
  }
}
