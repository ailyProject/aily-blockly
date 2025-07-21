import { Component, CUSTOM_ELEMENTS_SCHEMA, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import "@wokwi/elements";
import { dia, shapes, util } from '@joint/core';
import { ELEMENTS_CONFIG } from './elements.config';
import { getPinLayout } from './pin-layout.config';
import { v4 as uuidv4 } from 'uuid'; // 需要添加uuid依赖包
import { SimulatorService } from './simulator.service';

// 硬件连接配置接口
export interface HardwareConfig {
  version: number;
  author: string;
  editor: string;
  parts: Part[];
  connections: Connection[];
}

export interface Part {
  id: string;
  type: string;
  left: number;
  top: number;
  attrs?: Record<string, any>;
}

export interface Connection extends Array<string> {
  0: string; // 源引脚，格式：part_id:pin_name
  1: string; // 目标引脚，格式：part_id:pin_name
  2: string; // 连接线颜色
}

@Component({
  selector: 'app-simulator-editor',
  imports: [CommonModule, FormsModule],
  templateUrl: './simulator-editor.component.html',
  styleUrl: './simulator-editor.component.scss',
  schemas: [CUSTOM_ELEMENTS_SCHEMA]
})
export class SimulatorEditorComponent {
  @ViewChild('paper', { static: true }) paperContainer!: ElementRef<HTMLDivElement>;
  private graph!: dia.Graph;
  private paper!: dia.Paper;

  // 元素ID到JointJS元素的映射
  private elementMap: Map<string, dia.Element> = new Map();
  // 连接线映射
  private connectionMap: Map<string, dia.Link> = new Map();

  // UI控制
  showJsonDialog = false;
  jsonInput = '';

  // 当前加载的硬件配置
  private currentConfig: HardwareConfig | null = null;

  constructor(
    private simulatorService: SimulatorService
  ) { }

  ngOnInit() {
    this.initializeJoint();
    this.setupPinStateListener();
    this.loadDefaultExample();
  }

  // 初始化JointJS画布
  private initializeJoint() {
    const namespace = shapes;

    this.graph = new dia.Graph({}, { cellNamespace: namespace });

    this.paper = new dia.Paper({
      el: this.paperContainer.nativeElement,
      model: this.graph,
      width: '100%',
      height: '100%',
      background: { color: '#f9f9f9' },
      cellViewNamespace: namespace,
      preventDefaultViewAction: false,
      gridSize: 10,
      drawGrid: true
    });
  }

  // 加载默认示例
  private loadDefaultExample() {
    const defaultConfig: HardwareConfig = {
      version: 1,
      author: "aily",
      editor: "simulator",
      parts: [
        {
          id: "uno1",
          type: "wokwi-arduino-uno",
          left: 100,
          top: 200
        },
        {
          id: "led1",
          type: "wokwi-led",
          left: 100,
          top: 50,
          attrs: {
            color: "red"
          }
        },
        {
          id: "buzzer1",
          type: "wokwi-buzzer",
          left: 250,
          top: 50
        }
      ],
      connections: [
        ["uno1:13", "led1:anode", "#FF0000"],
        ["uno1:GND", "led1:cathode", "#000000"],
        ["uno1:8", "buzzer1:1", "#FFA500"],
        ["uno1:GND2", "buzzer1:2", "#000000"]
      ]
    };

    this.loadHardwareConfig(defaultConfig);
  }

  // JSON对话框控制方法
  loadFromJson() {
    this.showJsonDialog = true;
    // 如果当前有配置就显示当前配置，否则显示示例
    if (this.currentConfig) {
      this.jsonInput = JSON.stringify(this.currentConfig, null, 2);
    } else {
      // 提供一个示例配置
      const exampleConfig = {
        "version": 1,
        "author": "aily",
        "editor": "simulator",
        "parts": [
          {
            "id": "uno1",
            "type": "wokwi-arduino-uno",
            "left": 200,
            "top": 300
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
      };
      this.jsonInput = JSON.stringify(exampleConfig, null, 2);
    }
  }

  closeJsonDialog() {
    this.showJsonDialog = false;
  }

  parseAndLoadJson() {
    try {
      const config = JSON.parse(this.jsonInput) as HardwareConfig;
      
      // 基本验证
      if (!this.validateConfig(config)) {
        alert('配置格式不正确，请检查必需的字段');
        return;
      }
      
      this.loadHardwareConfig(config);
      this.closeJsonDialog();
    } catch (error) {
      alert('JSON格式错误：' + (error as Error).message);
    }
  }

  // 验证配置格式
  private validateConfig(config: any): config is HardwareConfig {
    if (!config || typeof config !== 'object') {
      return false;
    }
    
    if (!config.parts || !Array.isArray(config.parts)) {
      return false;
    }
    
    if (!config.connections || !Array.isArray(config.connections)) {
      return false;
    }
    
    // 验证parts格式
    for (const part of config.parts) {
      if (!part.id || !part.type || typeof part.left !== 'number' || typeof part.top !== 'number') {
        return false;
      }
    }
    
    // 验证connections格式
    for (const connection of config.connections) {
      if (!Array.isArray(connection) || connection.length !== 3) {
        return false;
      }
    }
    
    return true;
  }

  clearSimulator() {
    this.graph.clear();
    this.elementMap.clear();
    this.connectionMap.clear();
    this.currentConfig = null;
  }

  exportToJson() {
    if (this.currentConfig) {
      const dataStr = JSON.stringify(this.currentConfig, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'hardware-config.json';
      link.click();
      URL.revokeObjectURL(url);
    }
  }

  // 加载硬件配置
  private loadHardwareConfig(config: HardwareConfig) {
    this.clearSimulator();
    this.currentConfig = config;

    // 首先加载所有零件
    config.parts.forEach(part => {
      this.loadPart(part);
    });

    // 然后创建连接
    config.connections.forEach(connection => {
      this.createConnection(connection);
    });

    // 设置模拟器使用的开发板
    const arduinoBoard = config.parts.find(p => p.type.includes('arduino'));
    if (arduinoBoard) {
      this.simulatorService.setBoard(arduinoBoard.type);
    }
  }

  // 加载单个零件
  private loadPart(part: Part) {
    const element = this.loadWokwiElement(
      part.type,
      { x: part.left, y: part.top },
      part.attrs || {}
    );
    
    // 设置元素的自定义ID
    element.prop('partId', part.id);
    this.elementMap.set(part.id, element);
  }

  // 创建连接
  private createConnection(connection: Connection) {
    const [sourceSpec, targetSpec, color] = connection;
    
    // 解析连接规格（格式：part_id:pin_name）
    const [sourcePartId, sourcePin] = sourceSpec.split(':');
    const [targetPartId, targetPin] = targetSpec.split(':');

    const sourceElement = this.elementMap.get(sourcePartId);
    const targetElement = this.elementMap.get(targetPartId);

    if (!sourceElement || !targetElement) {
      console.error(`无法找到连接的元素: ${sourcePartId} 或 ${targetPartId}`);
      console.log('可用元素:', Array.from(this.elementMap.keys()));
      return;
    }

    console.log(`创建连接: ${sourceSpec} -> ${targetSpec}, 颜色: ${color}`);

    // 获取连接点位置
    const sourcePoint = this.getPinPosition(sourceElement, sourcePin);
    const targetPoint = this.getPinPosition(targetElement, targetPin);

    console.log('源位置:', sourcePoint, '目标位置:', targetPoint);

    // 创建连接线
    const link = new shapes.standard.Link({
      source: { 
        id: sourceElement.id, 
        anchor: sourcePoint.anchor,
        connectionPoint: sourcePoint.connectionPoint
      },
      target: { 
        id: targetElement.id, 
        anchor: targetPoint.anchor,
        connectionPoint: targetPoint.connectionPoint
      },
      attrs: {
        line: {
          stroke: color,
          strokeWidth: 2,
          strokeDasharray: '0',
          targetMarker: {
            type: 'path',
            d: 'M 10 -5 0 0 10 5 z',
            fill: color
          }
        }
      },
      connector: { name: 'rounded' },
      router: { name: 'orthogonal' }
    });

    link.addTo(this.graph);
    
    // 保存连接线引用
    const connectionId = `${sourceSpec}-${targetSpec}`;
    this.connectionMap.set(connectionId, link);

    console.log(`连接已创建: ${connectionId}`);
  }

  // 获取引脚位置（使用配置文件）
  private getPinPosition(element: dia.Element, pinName: string): { anchor: any, connectionPoint: any } {
    const elementType = element.get('type').split('.')[1].replace('Element', '').toLowerCase();
    
    // 从配置文件获取引脚布局
    const pinLayout = getPinLayout(elementType, pinName);
    if (pinLayout) {
      return pinLayout;
    }
    
    // 如果没有找到配置，尝试常见的引脚名称映射
    if (elementType === 'wokwi-arduino-uno') {
      return this.getArduinoUnoPinPosition(pinName);
    } else if (elementType === 'wokwi-led') {
      return this.getLedPinPosition(pinName);
    } else if (elementType === 'wokwi-buzzer') {
      return this.getBuzzerPinPosition(pinName);
    }
    
    // 默认返回中心点
    return {
      anchor: { name: 'center' },
      connectionPoint: { name: 'boundary' }
    };
  }

  // Arduino UNO 引脚位置映射
  private getArduinoUnoPinPosition(pinName: string): { anchor: any, connectionPoint: any } {
    const pinPositions: Record<string, any> = {
      // 数字引脚（右侧）
      '0': { anchor: { name: 'right', args: { dy: -80 } }, connectionPoint: { name: 'boundary' } },
      '1': { anchor: { name: 'right', args: { dy: -70 } }, connectionPoint: { name: 'boundary' } },
      '2': { anchor: { name: 'right', args: { dy: -60 } }, connectionPoint: { name: 'boundary' } },
      '3': { anchor: { name: 'right', args: { dy: -50 } }, connectionPoint: { name: 'boundary' } },
      '4': { anchor: { name: 'right', args: { dy: -40 } }, connectionPoint: { name: 'boundary' } },
      '5': { anchor: { name: 'right', args: { dy: -30 } }, connectionPoint: { name: 'boundary' } },
      '6': { anchor: { name: 'right', args: { dy: -20 } }, connectionPoint: { name: 'boundary' } },
      '7': { anchor: { name: 'right', args: { dy: -10 } }, connectionPoint: { name: 'boundary' } },
      '8': { anchor: { name: 'right', args: { dy: 10 } }, connectionPoint: { name: 'boundary' } },
      '9': { anchor: { name: 'right', args: { dy: 20 } }, connectionPoint: { name: 'boundary' } },
      '10': { anchor: { name: 'right', args: { dy: 30 } }, connectionPoint: { name: 'boundary' } },
      '11': { anchor: { name: 'right', args: { dy: 40 } }, connectionPoint: { name: 'boundary' } },
      '12': { anchor: { name: 'right', args: { dy: 50 } }, connectionPoint: { name: 'boundary' } },
      '13': { anchor: { name: 'right', args: { dy: 60 } }, connectionPoint: { name: 'boundary' } },
      'GND': { anchor: { name: 'right', args: { dy: 70 } }, connectionPoint: { name: 'boundary' } },
      'AREF': { anchor: { name: 'right', args: { dy: 80 } }, connectionPoint: { name: 'boundary' } },
      // 模拟引脚（左侧）
      'A0': { anchor: { name: 'left', args: { dy: 80 } }, connectionPoint: { name: 'boundary' } },
      'A1': { anchor: { name: 'left', args: { dy: 70 } }, connectionPoint: { name: 'boundary' } },
      'A2': { anchor: { name: 'left', args: { dy: 60 } }, connectionPoint: { name: 'boundary' } },
      'A3': { anchor: { name: 'left', args: { dy: 50 } }, connectionPoint: { name: 'boundary' } },
      'A4': { anchor: { name: 'left', args: { dy: 40 } }, connectionPoint: { name: 'boundary' } },
      'A5': { anchor: { name: 'left', args: { dy: 30 } }, connectionPoint: { name: 'boundary' } },
      // 电源引脚
      'VIN': { anchor: { name: 'left', args: { dy: -80 } }, connectionPoint: { name: 'boundary' } },
      '5V': { anchor: { name: 'left', args: { dy: -60 } }, connectionPoint: { name: 'boundary' } },
      '3V3': { anchor: { name: 'left', args: { dy: -40 } }, connectionPoint: { name: 'boundary' } },
    };

    return pinPositions[pinName] || { anchor: { name: 'center' }, connectionPoint: { name: 'boundary' } };
  }

  // LED 引脚位置映射
  private getLedPinPosition(pinName: string): { anchor: any, connectionPoint: any } {
    const pinPositions: Record<string, any> = {
      'anode': { anchor: { name: 'top' }, connectionPoint: { name: 'boundary' } },
      'cathode': { anchor: { name: 'bottom' }, connectionPoint: { name: 'boundary' } }
    };

    return pinPositions[pinName] || { anchor: { name: 'center' }, connectionPoint: { name: 'boundary' } };
  }

  // 蜂鸣器引脚位置映射
  private getBuzzerPinPosition(pinName: string): { anchor: any, connectionPoint: any } {
    const pinPositions: Record<string, any> = {
      'pos': { anchor: { name: 'left' }, connectionPoint: { name: 'boundary' } },
      'neg': { anchor: { name: 'right' }, connectionPoint: { name: 'boundary' } }
    };

    return pinPositions[pinName] || { anchor: { name: 'center' }, connectionPoint: { name: 'boundary' } };
  }

  // 监听引脚状态变化
  private setupPinStateListener() {
    this.simulatorService.pinStateChange.subscribe(pinState => {
      // 更新所有使用该引脚的元素
      this.elementMap.forEach((element, id) => {
        const elementType = element.get('type').split('.')[1].replace('Element', '').toLowerCase();

        // 获取组件ID属性
        const componentId = element.prop('componentId');
        if (!componentId) return;

        // 更新Wokwi元素属性
        // 这里需要根据不同元素类型进行自定义处理
        if (elementType === 'wokwi-led') {
          // 如果是LED元素，更新其状态
          this.updateWokwiElementState(element, pinState);
        } else if (elementType === 'wokwi-buzzer') {
          // 如果是蜂鸣器，更新其状态
          this.updateWokwiElementState(element, pinState);
        }
        // 添加其他元素类型的处理...
      });
    });
  }

  // 更新Wokwi元素的状态
  private updateWokwiElementState(element: dia.Element, pinState: any) {
    // 获取元素的DOM引用
    const elementId = element.id;
    const elementView = this.paper.findViewByModel(elementId);
    if (!elementView) return;

    // 获取foreignObject中的Wokwi元素
    const wokwiElement = elementView.el.querySelector('foreignObject > *') as any;
    if (!wokwiElement) return;

    // 根据元素类型来设置属性
    const elementType = element.get('type').split('.')[1].replace('Element', '').toLowerCase();

    if (elementType === 'wokwi-led') {
      // LED亮灭取决于引脚状态
      if (wokwiElement.getAttribute('pin') === pinState.pin) {
        wokwiElement.setAttribute('value', pinState.value ? 'true' : 'false');
      }
    } else if (elementType === 'wokwi-buzzer') {
      // 蜂鸣器状态设置
      if (wokwiElement.getAttribute('pin') === pinState.pin) {
        wokwiElement.setAttribute('value', pinState.value ? 'true' : 'false');
      }
    }
    // 添加其他元素类型的处理...
  }

  /**
   * 加载Wokwi元素并创建JointJS元素
   * @param elementType 元素类型，如'wokwi-led'、'wokwi-arduino-uno'等
   * @param position 位置{x, y}
   * @param props 元素属性，如LED的color、pin等
   * @param options 可选配置项
   * @returns 创建的JointJS元素
   */
  loadWokwiElement(
    elementType: string,
    position: { x: number, y: number },
    props: Record<string, any> = {},
    options: {
      size?: { width: number, height: number },
      autoResize?: boolean,
      padding?: number,
      backgroundColor?: string
    } = {}
  ): dia.Element {
    // 生成组件唯一ID
    const componentId = uuidv4();

    // 默认选项
    const defaultOptions = {
      autoResize: true,
      padding: 10,
      backgroundColor: 'transparent'
    };

    const mergedOptions = { ...defaultOptions, ...options };

    // 将componentId添加到属性中
    const allProps = { ...props, 'data-component-id': componentId };

    // 创建属性字符串
    const propsString = Object.entries(allProps)
      .map(([key, value]) => `${key}="${value}"`)
      .join(' ');

    // 创建元素定义
    const elementName = elementType.charAt(0).toUpperCase() + elementType.slice(1) + 'Element';
    const CustomElement = dia.Element.define(`example.${elementName}`, {
      attrs: {
        body: {
          width: 'calc(w)',
          height: 'calc(h)',
          fill: 'transparent',
        },
        foreignObject: {
          width: `calc(w)`,
          height: `calc(h)`,
        }
      },
      componentId: componentId // 保存组件ID到元素属性
    }, {
      markup: util.svg`
        <rect @selector="body"/>
        <foreignObject @selector="foreignObject">
            <${elementType} ${propsString}></${elementType}>
        </foreignObject>
      `
    });

    // 创建元素实例
    const element = new CustomElement();
    element.position(position.x, position.y);

    // 获取元素配置尺寸
    const p = ELEMENTS_CONFIG[elementType.toLowerCase()];
    if (p) {
      const size = { width: p.width, height: p.height };
      element.resize(size.width, size.height);
    } else {
      console.warn(`未找到元素配置: ${elementType}`);
    }

    // 添加到图表
    element.addTo(this.graph);

    // 向模拟器服务注册组件
    if (elementType !== 'wokwi-arduino-uno') { // 开发板本身不需要注册
      // 提取引脚配置
      const pinConfig: Record<string, string> = {};
      if (props['pin']) {
        pinConfig['pin'] = props['pin'];
      }

      // 注册组件
      this.simulatorService.registerComponent(componentId, elementType, pinConfig);
    }

    // 添加事件监听
    this.setupElementEventListeners(element, elementType, componentId, props);

    return element;
  }

  // 设置元素事件监听器
  private setupElementEventListeners(element: dia.Element, elementType: string, componentId: string, props: any) {
    // 这里添加针对不同元素类型的事件监听
    // 例如按钮的点击、开关的切换等

    // 为按钮元素添加点击事件
    if (elementType === 'wokwi-pushbutton') {
      const pin = props.pin;
      if (pin) {
        const buttonView = this.paper.findViewByModel(element.id);
        if (buttonView) {
          buttonView.el.addEventListener('mousedown', () => {
            // 按钮按下，设置引脚为高电平
            this.simulatorService.setPinState(pin, true);
          });

          buttonView.el.addEventListener('mouseup', () => {
            // 按钮释放，设置引脚为低电平
            this.simulatorService.setPinState(pin, false);
          });
        }
      }
    }

    // 可添加其他元素类型的事件处理...
  }

  // 连接两个元素
  connectParts(source: dia.Element, sourcePin: string, target: dia.Element, targetPin: string) {
    // 连线逻辑实现
    // 例如创建连接两个元件的导线
    // 这需要根据实际UI设计来实现
  }
}
