import { Injectable } from '@angular/core';
import { ElectronService } from './electron.service';

// export const BOARD_NAME: Record<string, string> = {
//   'VID_303A&PID_1001': 'XIAO ESP32S3'
// };

// export function getBoardNameByVidPid(vendorId: string | undefined, productId: string | undefined): string | undefined {
//   if (!vendorId || !productId) return undefined;
//   const key = `VID_${vendorId.toUpperCase()}&PID_${productId.toUpperCase()}`;
//   return BOARD_NAME[key];
// }

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

      // const parseVidPidFromPnp = (pnpId: string | undefined) => {
      //   if (!pnpId) return { vendorId: undefined, productId: undefined };
      //   // 常见 Windows PNP 示例: USB\\VID_10C4&PID_EA60\\6&2b9f0b4a&0&3
      //   const m = /VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i.exec(pnpId);
      //   if (m) return { vendorId: m[1].toLowerCase(), productId: m[2].toLowerCase() };
      //   return { vendorId: undefined, productId: undefined };
      // };

      if (window['platform'].isWindows) {
        serialList = currentSerialPortList.map((item) => {
          let friendlyName: string = (item.friendlyName || item.manufacturer || item.path || '').replace(/ \(COM\d+\)$/, '');
          let keywords = ["蓝牙", "ble", "bluetooth"];
          let icon: string = keywords.some(keyword => (item.friendlyName || '').toLowerCase().includes(keyword.toLowerCase())) ? "fa-light fa-bluetooth" : 'fa-light fa-usb-drive';
          // const parsed = parseVidPidFromPnp(item.pnpId);
          // const vendorId = (item.vendorId || parsed.vendorId || '').toString().replace(/^0x/i, '').toLowerCase() || undefined;
          // const productId = (item.productId || parsed.productId || '').toString().replace(/^0x/i, '').toLowerCase() || undefined;
          // const boardName = getBoardNameByVidPid(vendorId, productId);
          // console.log('Serial Port:', item.path, 'VID:', vendorId, 'PID:', productId, 'Board:', boardName);
          return {
            name: item.path,
            text: friendlyName,
            // boardName: boardName,
            type: 'serial',
            icon: icon,
            // vendorId,
            // productId,
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
          // const parsed = parseVidPidFromPnp(item.pnpId);
          // const vendorId = (item.vendorId || parsed.vendorId || '').toString().replace(/^0x/i, '').toLowerCase() || undefined;
          // const productId = (item.productId || parsed.productId || '').toString().replace(/^0x/i, '').toLowerCase() || undefined;
          // const boardName = getBoardNameByVidPid(vendorId, productId);
          return {
            name: devicePath, // 使用转换后的 cu 路径
            text: friendlyName,
            // boardName: boardName,
            type: 'serial',
            icon: icon,
            // vendorId,
            // productId,
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
  port?: any,  // SerialPort 对象（浏览器环境）或字符串（Electron 环境）
  name?: string,
  // boardName?: string,
  text?: string,
  type?: string,
  icon?: string,
  disabled?: boolean
}

