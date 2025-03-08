import { Injectable } from '@angular/core';
import { ElectronService } from './electron.service';

@Injectable({
  providedIn: 'root'
})
export class SerialService {

  // 编译上传时，通过这里获取串口
  currentPort;

  constructor(
    private electronService: ElectronService
  ) { }

  // 此处还未考虑linux、macos适配
  async getSerialPorts(): Promise<PortItem[]> {
    if (this.electronService.isElectron) {
      let serialList = (await window['SerialPort'].list()).map((item) => {
        let friendlyName: string = item.friendlyName.replace(/ \(COM\d+\)$/, '');
        let keywords = ["蓝牙", "ble", "bluetooth"];
        let icon: string = keywords.some(keyword => item.friendlyName.toLowerCase().includes(keyword.toLowerCase())) ? "fa-light fa-bluetooth" : 'fa-light fa-usb-drive';
        return {
          name: item.path,
          text: friendlyName,
          type: 'serial',
          icon: icon,
        }
      });
      return serialList;
    } else {
      const port = await navigator['serial'].requestPort();
      return [{ port: port, name: '' }];
    }
  }
}


export interface PortItem {
  port: string,
  name?: string,
  text?: string,
  type?: string,
  icon?: string
}
