import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DATA_BITS_LIST, STOP_BITS_LIST, PARITY_LIST, FLOW_CONTROL_LIST } from '../../config';
import { MenuComponent } from '../../../../components/menu/menu.component';


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
  selectedDataBits;
  selectedStopBits;
  selectedParity;
  selectedFlowControl;

  // 菜单控制
  showDataBitsList = false;
  showStopBitsList = false;
  showParityList = false;
  showFlowControlList = false;

  showMenu = false;

  dataBits = '8';
  stopBits = '1';
  parity = 'none';
  flowControl = 'none';

  @Output() settingsChanged = new EventEmitter<any>();

  // 接收初始配置
  @Input() initialDataBits: string = '8';
  @Input() initialStopBits: string = '1';
  @Input() initialParity: string = 'none';
  @Input() initialFlowControl: string = 'none';

  ngOnInit(): void {
    // 根据传入的初始值查找对应的选项，如果找不到则使用默认值
    // dataBits 和 stopBits 的 value 是 number 类型，需要转换比较
    this.selectedDataBits = this.dataBitsList.find(item => item.value === Number(this.initialDataBits)) 
      || this.dataBitsList.find(item => item.isDefault) 
      || this.dataBitsList[0];
    this.selectedStopBits = this.stopBitsList.find(item => item.value === Number(this.initialStopBits)) 
      || this.stopBitsList.find(item => item.isDefault) 
      || this.stopBitsList[0];
    this.selectedParity = this.parityList.find(item => item.value === this.initialParity) 
      || this.parityList.find(item => item.isDefault) 
      || this.parityList[0];
    this.selectedFlowControl = this.flowControlList.find(item => item.value === this.initialFlowControl) 
      || this.flowControlList.find(item => item.isDefault) 
      || this.flowControlList[0];
  }

  // 当设置更改时触发事件
  onSettingChange(): void {
    this.settingsChanged.emit({
      dataBits: this.selectedDataBits,
      stopBits: this.selectedStopBits,
      parity: this.selectedParity,
      flowControl: this.selectedFlowControl
    });
  }

  position = { x: 0, y: 0 };
  menuList = [];
  openMenu(el, menuList): void {
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

  select(item) {
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
