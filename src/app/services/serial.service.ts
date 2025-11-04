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
      const currentSerialPortList = await window['SerialPort'].list();

      // console.log("Detected serial ports: ", currentSerialPortList);

      let serialList: PortItem[] = [];

      if (window['platform'].isWindows) {
        serialList = currentSerialPortList.map((item) => {
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
      } else if (window['platform'].isMacOS) {
        // 只返回usb串口设备
        serialList = currentSerialPortList.map((item) => {
          // 将 tty 路径转换为 cu 路径
          let devicePath = item.path.replace('/dev/tty.', '/dev/cu.');
          
          let friendlyName: string = item.manufacturer? item.manufacturer : devicePath.replace('/dev/cu.usbserial-', '').replace('/dev/cu.', '');
          let keywords = ["usb", "serial", "uart", "ftdi", "ch340", "cp210x"];
          let icon: string = keywords.some(keyword => devicePath.toLowerCase().includes(keyword.toLowerCase())) ? "fa-light fa-usb-drive" : 'fa-light fa-computer';
          return {
            name: devicePath, // 使用转换后的 cu 路径
            text: friendlyName,
            type: 'serial',
            icon: icon,
          }
        });
      } else if (window['platform'].isLinux) {
        //
      }
      
      return serialList;
    } else {
      const port = await navigator['serial'].requestPort();
      return [{ port: port, name: '' }];
    }
  }
}


export interface PortItem {
  port?: string,
  name?: string,
  text?: string,
  type?: string,
  icon?: string,
  disabled?: boolean
}
