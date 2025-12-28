import { Component, EventEmitter, Output, ViewChild } from '@angular/core';
import { SimplebarAngularComponent, SimplebarAngularModule } from 'simplebar-angular';
import { SerialMonitorService } from '../../services/serial-monitor.service';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-quick-send-list',
  imports: [SimplebarAngularModule, CommonModule],
  templateUrl: './quick-send-list.component.html',
  styleUrl: './quick-send-list.component.scss'
})
export class QuickSendListComponent {

  @ViewChild(SimplebarAngularComponent) simplebar!: SimplebarAngularComponent;

  options2 = {
    autoHide: true,
    clickOnTrack: true,
    scrollbarMinSize: 10
  };

  get quickSendList() {
    return this.serialMonitorService.quickSendList;
  }

  constructor(private serialMonitorService: SerialMonitorService) { }

  ngAfterViewInit() {
    if (this.simplebar && this.simplebar.SimpleBar) {
      const simplebarElement = this.simplebar.SimpleBar.getScrollElement();

      simplebarElement.addEventListener('wheel', (event: WheelEvent) => {
        event.preventDefault();
        const scrollAmount = event.deltaY || event.deltaX;
        simplebarElement.scrollLeft += scrollAmount * 0.2;
      }, { passive: false });
    }
  }

  async send(item: any) {
    switch (item.type) {
      case 'text':
        await this.serialMonitorService.sendData(item.data, 'text', true);
        break;
      case 'hex':
        await this.serialMonitorService.sendData(item.data, 'hex');
        break;
      case 'signal':
        await this.serialMonitorService.sendSignal(item.data);
        break;
      default:
        break;
    }
  }

  @Output() openMore = new EventEmitter();
  showMore = false;
  edit() {
    this.showMore = !this.showMore;
    this.openMore.emit(this.showMore);
  }
}
