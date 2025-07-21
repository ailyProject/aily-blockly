/**
 * Wokwi元素引脚布局配置
 * 定义各种元素的引脚相对位置
 */

export interface PinLayout {
  [pinName: string]: {
    anchor: { name: string; args?: any };
    connectionPoint: { name: string };
  };
}

export interface ElementPinConfig {
  [elementType: string]: PinLayout;
}

export const ELEMENT_PIN_LAYOUTS: ElementPinConfig = {
  'wokwi-arduino-uno': {
    // 数字引脚（右侧，从上到下）
    '0': { anchor: { name: 'top', args: { dy: -85 } }, connectionPoint: { name: 'boundary' } },
    '1': { anchor: { name: 'top', args: { dy: -75 } }, connectionPoint: { name: 'boundary' } },
    '2': { anchor: { name: 'top', args: { dy: -65 } }, connectionPoint: { name: 'boundary' } },
    '3': { anchor: { name: 'top', args: { dy: -55 } }, connectionPoint: { name: 'boundary' } },
    '4': { anchor: { name: 'top', args: { dy: -45 } }, connectionPoint: { name: 'boundary' } },
    '5': { anchor: { name: 'top', args: { dy: -35 } }, connectionPoint: { name: 'boundary' } },
    '6': { anchor: { name: 'top', args: { dy: -25 } }, connectionPoint: { name: 'boundary' } },
    '7': { anchor: { name: 'top', args: { dy: -15 } }, connectionPoint: { name: 'boundary' } },
    '8': { anchor: { name: 'top', args: { dy: 5 } }, connectionPoint: { name: 'boundary' } },
    '9': { anchor: { name: 'top', args: { dy: 15 } }, connectionPoint: { name: 'boundary' } },
    '10': { anchor: { name: 'top', args: { dy: 25 } }, connectionPoint: { name: 'boundary' } },
    '11': { anchor: { name: 'top', args: { dy: 35 } }, connectionPoint: { name: 'boundary' } },
    '12': { anchor: { name: 'top', args: { dy: 45 } }, connectionPoint: { name: 'boundary' } },
    '13': { anchor: { name: 'top', args: { dy: 55 } }, connectionPoint: { name: 'boundary' } },
    'GND': { anchor: { name: 'top', args: { dy: 65 } }, connectionPoint: { name: 'boundary' } },
    'AREF': { anchor: { name: 'top', args: { dy: 75 } }, connectionPoint: { name: 'boundary' } },
    'SDA': { anchor: { name: 'top', args: { dy: 85 } }, connectionPoint: { name: 'boundary' } },
    'SCL': { anchor: { name: 'top', args: { dy: 95 } }, connectionPoint: { name: 'boundary' } },
    
    // 模拟引脚（左侧，从下到上）
    'A0': { anchor: { name: 'left', args: { dy: 85 } }, connectionPoint: { name: 'boundary' } },
    'A1': { anchor: { name: 'left', args: { dy: 75 } }, connectionPoint: { name: 'boundary' } },
    'A2': { anchor: { name: 'left', args: { dy: 65 } }, connectionPoint: { name: 'boundary' } },
    'A3': { anchor: { name: 'left', args: { dy: 55 } }, connectionPoint: { name: 'boundary' } },
    'A4': { anchor: { name: 'left', args: { dy: 45 } }, connectionPoint: { name: 'boundary' } },
    'A5': { anchor: { name: 'left', args: { dy: 35 } }, connectionPoint: { name: 'boundary' } },
    
    // 电源引脚（左侧，上半部分）
    'VIN': { anchor: { name: 'left', args: { dy: -85 } }, connectionPoint: { name: 'boundary' } },
    'GND2': { anchor: { name: 'left', args: { dy: -75 } }, connectionPoint: { name: 'boundary' } }, // 电源侧GND
    '5V': { anchor: { name: 'left', args: { dy: -65 } }, connectionPoint: { name: 'boundary' } },
    '3V3': { anchor: { name: 'left', args: { dy: -55 } }, connectionPoint: { name: 'boundary' } },
    'RESET': { anchor: { name: 'left', args: { dy: -45 } }, connectionPoint: { name: 'boundary' } },
    'IOREF': { anchor: { name: 'left', args: { dy: -35 } }, connectionPoint: { name: 'boundary' } },
  },

  'wokwi-arduino-mega': {
    // 数字引脚 0-13 (右侧上半部分)
    '0': { anchor: { name: 'right', args: { dy: -90 } }, connectionPoint: { name: 'boundary' } },
    '1': { anchor: { name: 'right', args: { dy: -80 } }, connectionPoint: { name: 'boundary' } },
    '2': { anchor: { name: 'right', args: { dy: -70 } }, connectionPoint: { name: 'boundary' } },
    '3': { anchor: { name: 'right', args: { dy: -60 } }, connectionPoint: { name: 'boundary' } },
    '4': { anchor: { name: 'right', args: { dy: -50 } }, connectionPoint: { name: 'boundary' } },
    '5': { anchor: { name: 'right', args: { dy: -40 } }, connectionPoint: { name: 'boundary' } },
    '6': { anchor: { name: 'right', args: { dy: -30 } }, connectionPoint: { name: 'boundary' } },
    '7': { anchor: { name: 'right', args: { dy: -20 } }, connectionPoint: { name: 'boundary' } },
    '8': { anchor: { name: 'right', args: { dy: -10 } }, connectionPoint: { name: 'boundary' } },
    '9': { anchor: { name: 'right', args: { dy: 0 } }, connectionPoint: { name: 'boundary' } },
    '10': { anchor: { name: 'right', args: { dy: 10 } }, connectionPoint: { name: 'boundary' } },
    '11': { anchor: { name: 'right', args: { dy: 20 } }, connectionPoint: { name: 'boundary' } },
    '12': { anchor: { name: 'right', args: { dy: 30 } }, connectionPoint: { name: 'boundary' } },
    '13': { anchor: { name: 'right', args: { dy: 40 } }, connectionPoint: { name: 'boundary' } },
    
    // 数字引脚 14-53 (右侧下半部分)
    '14': { anchor: { name: 'right', args: { dy: 50 } }, connectionPoint: { name: 'boundary' } },
    '15': { anchor: { name: 'right', args: { dy: 60 } }, connectionPoint: { name: 'boundary' } },
    // ... 可根据需要添加更多引脚
    
    // 模拟引脚 A0-A15 (左侧)
    'A0': { anchor: { name: 'left', args: { dy: 90 } }, connectionPoint: { name: 'boundary' } },
    'A1': { anchor: { name: 'left', args: { dy: 80 } }, connectionPoint: { name: 'boundary' } },
    'A2': { anchor: { name: 'left', args: { dy: 70 } }, connectionPoint: { name: 'boundary' } },
    'A3': { anchor: { name: 'left', args: { dy: 60 } }, connectionPoint: { name: 'boundary' } },
    'A4': { anchor: { name: 'left', args: { dy: 50 } }, connectionPoint: { name: 'boundary' } },
    'A5': { anchor: { name: 'left', args: { dy: 40 } }, connectionPoint: { name: 'boundary' } },
    // ... 可添加更多模拟引脚
    
    // 电源引脚
    'VIN': { anchor: { name: 'left', args: { dy: -90 } }, connectionPoint: { name: 'boundary' } },
    'GND': { anchor: { name: 'left', args: { dy: -80 } }, connectionPoint: { name: 'boundary' } },
    '5V': { anchor: { name: 'left', args: { dy: -70 } }, connectionPoint: { name: 'boundary' } },
    '3V3': { anchor: { name: 'left', args: { dy: -60 } }, connectionPoint: { name: 'boundary' } },
  },

  'wokwi-esp32-devkit-v1': {
    // GPIO引脚 (左侧)
    'TX': { anchor: { name: 'left', args: { dy: -90 } }, connectionPoint: { name: 'boundary' } },
    'RX': { anchor: { name: 'left', args: { dy: -80 } }, connectionPoint: { name: 'boundary' } },
    '22': { anchor: { name: 'left', args: { dy: -70 } }, connectionPoint: { name: 'boundary' } },
    '21': { anchor: { name: 'left', args: { dy: -60 } }, connectionPoint: { name: 'boundary' } },
    '19': { anchor: { name: 'left', args: { dy: -50 } }, connectionPoint: { name: 'boundary' } },
    '18': { anchor: { name: 'left', args: { dy: -40 } }, connectionPoint: { name: 'boundary' } },
    '5': { anchor: { name: 'left', args: { dy: -30 } }, connectionPoint: { name: 'boundary' } },
    '17': { anchor: { name: 'left', args: { dy: -20 } }, connectionPoint: { name: 'boundary' } },
    '16': { anchor: { name: 'left', args: { dy: -10 } }, connectionPoint: { name: 'boundary' } },
    '4': { anchor: { name: 'left', args: { dy: 0 } }, connectionPoint: { name: 'boundary' } },
    '2': { anchor: { name: 'left', args: { dy: 10 } }, connectionPoint: { name: 'boundary' } },
    '15': { anchor: { name: 'left', args: { dy: 20 } }, connectionPoint: { name: 'boundary' } },
    'GND': { anchor: { name: 'left', args: { dy: 30 } }, connectionPoint: { name: 'boundary' } },
    '13': { anchor: { name: 'left', args: { dy: 40 } }, connectionPoint: { name: 'boundary' } },
    '12': { anchor: { name: 'left', args: { dy: 50 } }, connectionPoint: { name: 'boundary' } },
    '14': { anchor: { name: 'left', args: { dy: 60 } }, connectionPoint: { name: 'boundary' } },
    '27': { anchor: { name: 'left', args: { dy: 70 } }, connectionPoint: { name: 'boundary' } },
    '26': { anchor: { name: 'left', args: { dy: 80 } }, connectionPoint: { name: 'boundary' } },
    '25': { anchor: { name: 'left', args: { dy: 90 } }, connectionPoint: { name: 'boundary' } },
    
    // GPIO引脚 (右侧)
    '3V3': { anchor: { name: 'right', args: { dy: -90 } }, connectionPoint: { name: 'boundary' } },
    'EN': { anchor: { name: 'right', args: { dy: -80 } }, connectionPoint: { name: 'boundary' } },
    'VP': { anchor: { name: 'right', args: { dy: -70 } }, connectionPoint: { name: 'boundary' } },
    'VN': { anchor: { name: 'right', args: { dy: -60 } }, connectionPoint: { name: 'boundary' } },
    '34': { anchor: { name: 'right', args: { dy: -50 } }, connectionPoint: { name: 'boundary' } },
    '35': { anchor: { name: 'right', args: { dy: -40 } }, connectionPoint: { name: 'boundary' } },
    '32': { anchor: { name: 'right', args: { dy: -30 } }, connectionPoint: { name: 'boundary' } },
    '33': { anchor: { name: 'right', args: { dy: -20 } }, connectionPoint: { name: 'boundary' } },
    '1': { anchor: { name: 'right', args: { dy: -10 } }, connectionPoint: { name: 'boundary' } },
    '3': { anchor: { name: 'right', args: { dy: 0 } }, connectionPoint: { name: 'boundary' } },
    '0': { anchor: { name: 'right', args: { dy: 10 } }, connectionPoint: { name: 'boundary' } },
    'VCC': { anchor: { name: 'right', args: { dy: 20 } }, connectionPoint: { name: 'boundary' } },
    'GND2': { anchor: { name: 'right', args: { dy: 30 } }, connectionPoint: { name: 'boundary' } },
    '23': { anchor: { name: 'right', args: { dy: 40 } }, connectionPoint: { name: 'boundary' } },
  },

  'wokwi-led': {
    'anode': { anchor: { name: 'top' }, connectionPoint: { name: 'boundary' } },
    'cathode': { anchor: { name: 'bottom' }, connectionPoint: { name: 'boundary' } }
  },

  'wokwi-buzzer': {
    '1': { anchor: { name: 'left' }, connectionPoint: { name: 'boundary' } },
    '2': { anchor: { name: 'right' }, connectionPoint: { name: 'boundary' } }
  },

  'wokwi-pushbutton': {
    '1.l': { anchor: { name: 'left', args: { dy: -10 } }, connectionPoint: { name: 'boundary' } },
    '1.r': { anchor: { name: 'right', args: { dy: -10 } }, connectionPoint: { name: 'boundary' } },
    '2.l': { anchor: { name: 'left', args: { dy: 10 } }, connectionPoint: { name: 'boundary' } },
    '2.r': { anchor: { name: 'right', args: { dy: 10 } }, connectionPoint: { name: 'boundary' } }
  },

  'wokwi-dht22': {
    'VCC': { anchor: { name: 'bottom', args: { dx: -15 } }, connectionPoint: { name: 'boundary' } },
    'SDA': { anchor: { name: 'bottom', args: { dx: -5 } }, connectionPoint: { name: 'boundary' } },
    'NC': { anchor: { name: 'bottom', args: { dx: 5 } }, connectionPoint: { name: 'boundary' } },
    'GND': { anchor: { name: 'bottom', args: { dx: 15 } }, connectionPoint: { name: 'boundary' } }
  },

  'wokwi-hc-sr04': {
    'VCC': { anchor: { name: 'bottom', args: { dx: -22 } }, connectionPoint: { name: 'boundary' } },
    'TRIG': { anchor: { name: 'bottom', args: { dx: -7 } }, connectionPoint: { name: 'boundary' } },
    'ECHO': { anchor: { name: 'bottom', args: { dx: 7 } }, connectionPoint: { name: 'boundary' } },
    'GND': { anchor: { name: 'bottom', args: { dx: 22 } }, connectionPoint: { name: 'boundary' } }
  },

  'wokwi-lcd1602': {
    'VSS': { anchor: { name: 'top', args: { dx: -136 } }, connectionPoint: { name: 'boundary' } },
    'VDD': { anchor: { name: 'top', args: { dx: -120 } }, connectionPoint: { name: 'boundary' } },
    'V0': { anchor: { name: 'top', args: { dx: -104 } }, connectionPoint: { name: 'boundary' } },
    'RS': { anchor: { name: 'top', args: { dx: -88 } }, connectionPoint: { name: 'boundary' } },
    'E': { anchor: { name: 'top', args: { dx: -72 } }, connectionPoint: { name: 'boundary' } },
    'D4': { anchor: { name: 'top', args: { dx: -56 } }, connectionPoint: { name: 'boundary' } },
    'D5': { anchor: { name: 'top', args: { dx: -40 } }, connectionPoint: { name: 'boundary' } },
    'D6': { anchor: { name: 'top', args: { dx: -24 } }, connectionPoint: { name: 'boundary' } },
    'D7': { anchor: { name: 'top', args: { dx: -8 } }, connectionPoint: { name: 'boundary' } },
    'A': { anchor: { name: 'top', args: { dx: 8 } }, connectionPoint: { name: 'boundary' } },
    'K': { anchor: { name: 'top', args: { dx: 24 } }, connectionPoint: { name: 'boundary' } }
  },

  // 添加更多元素的引脚布局...
};

/**
 * 获取指定元素类型和引脚名称的布局信息
 */
export function getPinLayout(elementType: string, pinName: string): { anchor: any, connectionPoint: any } | null {
  const elementLayout = ELEMENT_PIN_LAYOUTS[elementType];
  if (!elementLayout) {
    return null;
  }
  
  return elementLayout[pinName] || null;
}

/**
 * 获取元素所有引脚名称
 */
export function getElementPins(elementType: string): string[] {
  const elementLayout = ELEMENT_PIN_LAYOUTS[elementType];
  return elementLayout ? Object.keys(elementLayout) : [];
}
