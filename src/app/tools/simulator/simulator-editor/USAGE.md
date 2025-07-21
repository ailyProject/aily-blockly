# 模拟器编辑器组件使用指南

## 功能概述

模拟器编辑器组件 (`SimulatorEditorComponent`) 是一个基于Angular的硬件电路模拟器，支持通过JSON配置加载和显示各种电子元件及其连接关系。

## 主要特性

- 🔧 支持多种Wokwi电子元件（Arduino、LED、蜂鸣器、传感器等）
- 🔌 可视化连接线绘制
- 📝 JSON配置导入/导出
- 🎨 自定义元件位置和属性
- ⚡ 引脚状态模拟和更新

## JSON配置格式

### 基本结构

```json
{
  "version": 1,
  "author": "作者名称",
  "editor": "simulator",
  "parts": [...],      // 元件数组
  "connections": [...]  // 连接数组
}
```

### Parts（元件）配置

```json
{
  "id": "唯一标识符",
  "type": "wokwi元件类型",
  "left": 100,    // X坐标
  "top": 50,      // Y坐标
  "attrs": {      // 可选属性
    "color": "red",
    "pin": "13"
  }
}
```

### Connections（连接）配置

```json
["源元件:引脚", "目标元件:引脚", "连接线颜色"]
```

## 支持的元件类型

### 开发板
- `wokwi-arduino-uno` - Arduino UNO开发板
- `wokwi-arduino-mega` - Arduino MEGA开发板
- `wokwi-esp32-devkit-v1` - ESP32开发板

### 基础元件
- `wokwi-led` - LED灯（支持颜色属性）
- `wokwi-buzzer` - 蜂鸣器
- `wokwi-pushbutton` - 按钮

### 传感器
- `wokwi-dht22` - 温湿度传感器
- `wokwi-hc-sr04` - 超声波传感器

### 显示器
- `wokwi-lcd1602` - 16x2字符液晶显示器

## 引脚命名规范

### Arduino UNO引脚
- 数字引脚: `0`, `1`, `2`, ..., `13`
- 模拟引脚: `A0`, `A1`, `A2`, ..., `A5`
- 电源引脚: `5V`, `3V3`, `GND`, `GND2`, `VIN`

### 其他元件引脚
- LED: `anode`（正极）, `cathode`（负极）
- 蜂鸣器: `1`, `2`
- 按钮: `1.l`, `1.r`, `2.l`, `2.r`
- DHT22: `VCC`, `SDA`, `NC`, `GND`
- HC-SR04: `VCC`, `TRIG`, `ECHO`, `GND`

## 使用示例

### 简单LED电路

```json
{
  "version": 1,
  "author": "示例",
  "editor": "simulator",
  "parts": [
    {
      "id": "uno1",
      "type": "wokwi-arduino-uno",
      "left": 200,
      "top": 200
    },
    {
      "id": "led1",
      "type": "wokwi-led",
      "left": 100,
      "top": 50,
      "attrs": {
        "color": "red"
      }
    }
  ],
  "connections": [
    ["uno1:13", "led1:anode", "#FF0000"],
    ["uno1:GND", "led1:cathode", "#000000"]
  ]
}
```

### 多彩LED灯组

```json
{
  "version": 1,
  "author": "彩灯示例",
  "editor": "simulator",
  "parts": [
    {
      "id": "uno1",
      "type": "wokwi-arduino-uno",
      "left": 200,
      "top": 300
    },
    {
      "id": "led_red",
      "type": "wokwi-led",
      "left": 50,
      "top": 50,
      "attrs": { "color": "red" }
    },
    {
      "id": "led_green",
      "type": "wokwi-led",
      "left": 150,
      "top": 50,
      "attrs": { "color": "green" }
    },
    {
      "id": "led_blue",
      "type": "wokwi-led",
      "left": 250,
      "top": 50,
      "attrs": { "color": "blue" }
    }
  ],
  "connections": [
    ["uno1:13", "led_red:anode", "#FF0000"],
    ["uno1:12", "led_green:anode", "#00FF00"],
    ["uno1:11", "led_blue:anode", "#0000FF"],
    ["uno1:GND", "led_red:cathode", "#000000"],
    ["uno1:GND2", "led_green:cathode", "#000000"],
    ["uno1:GND", "led_blue:cathode", "#000000"]
  ]
}
```

## 组件方法

### 公共方法
- `loadFromJson()` - 打开JSON输入对话框
- `clearSimulator()` - 清空当前电路
- `exportToJson()` - 导出当前配置为JSON文件

### 私有方法
- `loadHardwareConfig(config)` - 加载硬件配置
- `loadPart(part)` - 加载单个元件
- `createConnection(connection)` - 创建连接线
- `getPinPosition(element, pinName)` - 获取引脚位置

## 注意事项

1. **引脚命名**: 确保引脚名称与实际Wokwi元件的引脚名称匹配
2. **元件ID**: 每个元件的`id`必须在配置中唯一
3. **连接格式**: 连接数组必须包含exactly 3个元素
4. **坐标系统**: 左上角为原点(0,0)，向右向下为正方向
5. **颜色格式**: 连接线颜色使用十六进制格式（如`#FF0000`）

## 扩展开发

要添加新的元件类型：

1. 在 `elements.config.ts` 中添加元件尺寸配置
2. 在 `pin-layout.config.ts` 中添加引脚布局
3. 如有需要，在组件中添加特殊事件处理逻辑

## 故障排除

### 常见问题

**Q: 连接线没有显示**
A: 检查引脚名称是否正确，确保源元件和目标元件都存在

**Q: 元件位置不正确**
A: 确认`left`和`top`值为数字类型，不是字符串

**Q: JSON解析失败**
A: 检查JSON格式是否正确，特别注意逗号和引号的使用

**Q: 元件显示异常**
A: 确认元件类型名称正确，并检查是否已加载对应的Wokwi元件

### 调试方法

1. 打开浏览器开发者工具查看控制台输出
2. 检查元素映射表是否正确建立
3. 验证引脚位置计算是否正确
