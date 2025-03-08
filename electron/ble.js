// 蓝牙设备相关功能

var noble = require('noble');


function registerTerminalHandlers(mainWindow) {

  noble.on('discover', peripheral => {
    const name = peripheral.advertisement.localName || 'Unknown';
    console.log(`发现设备: ${name} - ${peripheral.uuid}`);
  });
}


export function startScan() {
  noble.on('stateChange', state => {
    console.log("BLE适配器状态:", state);
    if (state === 'poweredOn') {
      noble.startScanning([], true);
      console.log("开始扫描蓝牙设备...");
    } else {
      noble.stopScanning();
      console.log("停止扫描，适配器状态:", state);
    }
  });
}

