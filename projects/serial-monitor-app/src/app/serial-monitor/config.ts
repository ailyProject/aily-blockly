export const BAUDRATE_LIST = [
    { name: '4800', value: 4800 },
    { name: '9600', value: 9600 },
    { name: '19200', value: 19200 },
    { name: '38400', value: 38400 },
    { name: '57600', value: 57600 },
    { name: '115200', value: 115200 },
    { name: '230400', value: 230400 },
    { name: '460800', value: 460800 },
    { name: '921600', value: 921600 },
    { name: '1000000', value: 1000000 },
    { name: '2000000', value: 2000000 },
    { name: '3000000', value: 3000000 },
    { name: '4000000', value: 4000000 },
]

// 数据位配置选项
export const DATA_BITS_LIST = [
    { name: '5', value: 5 },
    { name: '6', value: 6 },
    { name: '7', value: 7 },
    { name: '8', value: 8, isDefault: true }
]

// 停止位配置选项
export const STOP_BITS_LIST = [
    { name: '1', value: 1, isDefault: true },
    { name: '1.5', value: 1.5 },
    { name: '2', value: 2 }
]

// 校验位配置选项
export const PARITY_LIST = [
    { name: '无', value: 'none', isDefault: true },
    { name: '奇校验', value: 'odd' },
    { name: '偶校验', value: 'even' },
    { name: '标记', value: 'mark' },
    { name: '空格', value: 'space' }
]

// 流控制配置选项
export const FLOW_CONTROL_LIST = [
    { name: '无', value: 'none', isDefault: true },
    { name: 'RTS/CTS', value: 'hardware' },
    { name: 'XON/XOFF', value: 'software' }
]
