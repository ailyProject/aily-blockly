import { Component, CUSTOM_ELEMENTS_SCHEMA, ElementRef, ViewChild, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import "@wokwi/elements";
import Konva from 'konva';
import { SimulatorService } from './simulator.service';

// 组件类型定义
interface Pin {
  id: string;
  x: number;
  y: number;
  type: 'digital' | 'analog' | 'power' | 'ground';
  label: string;
  connected: boolean;
  circle?: Konva.Circle;
}

interface CircuitComponent {
  id: string;
  type: 'arduino' | 'temperature' | 'led' | 'resistor';
  x: number;
  y: number;
  width: number;
  height: number;
  pins: Pin[];
  shape?: Konva.Group;
  element?: HTMLElement;
}

interface Connection {
  id: string;
  fromComponent: string;
  fromPin: string;
  toComponent: string;
  toPin: string;
  line?: Konva.Line;
}

@Component({
  selector: 'app-simulator-editor',
  imports: [CommonModule, FormsModule],
  templateUrl: './simulator-editor.component.html',
  styleUrl: './simulator-editor.component.scss',
  schemas: [CUSTOM_ELEMENTS_SCHEMA]
})
export class SimulatorEditorComponent implements AfterViewInit, OnDestroy {
  @ViewChild('simulatorContainer', { static: false }) containerRef!: ElementRef<HTMLDivElement>;

  private stage!: Konva.Stage;
  private layer!: Konva.Layer;
  public components: Map<string, CircuitComponent> = new Map();
  public connections: Map<string, Connection> = new Map();
  
  // 连接状态
  public isConnecting = false;
  private currentConnection: {
    fromComponent: string;
    fromPin: string;
    tempLine?: Konva.Line;
  } | null = null;

  constructor(
    private simulatorService: SimulatorService
  ) { }

  ngAfterViewInit() {
    this.initializeStage();
  }

  ngOnDestroy() {
    // 清理@wokwi组件
    for (const [id, component] of this.components) {
      if (component.element && component.element.parentNode) {
        component.element.parentNode.removeChild(component.element);
      }
    }
    
    // 清理事件监听器
    window.removeEventListener('resize', this.handleResize.bind(this));
    
    if (this.stage) {
      this.stage.destroy();
    }
  }

  private initializeStage() {
    const container = this.containerRef.nativeElement;
    
    this.stage = new Konva.Stage({
      container: container,
      width: container.offsetWidth,
      height: container.offsetHeight,
      draggable: false
    });

    this.layer = new Konva.Layer();
    this.stage.add(this.layer);

    // 监听画布点击事件（取消连接）
    this.stage.on('click', (e) => {
      if (e.target === this.stage) {
        this.cancelConnection();
      }
    });

    // 窗口大小变化时调整画布
    window.addEventListener('resize', this.handleResize.bind(this));
  }

  private handleResize() {
    const container = this.containerRef.nativeElement;
    this.stage.width(container.offsetWidth);
    this.stage.height(container.offsetHeight);
  }

  // 添加组件
  addComponent(type: string, x: number, y: number) {
    const componentId = `${type}_${Date.now()}`;
    
    let component: CircuitComponent;
    
    switch (type) {
      case 'arduino':
        component = this.createArduinoComponent(componentId, x, y);
        break;
      case 'temperature':
        component = this.createTemperatureComponent(componentId, x, y);
        break;
      case 'led':
        component = this.createLEDComponent(componentId, x, y);
        break;
      default:
        return;
    }

    this.components.set(componentId, component);
    this.createComponentShape(component);
  }

  private createArduinoComponent(id: string, x: number, y: number): CircuitComponent {
    return {
      id,
      type: 'arduino',
      x,
      y,
      width: 320,
      height: 180,
      pins: [
        // 左侧引脚排列 (顶部)
        { id: 'RESET', x: 40, y: 10, type: 'digital', label: 'RESET', connected: false },
        { id: '3V3', x: 60, y: 10, type: 'power', label: '3.3V', connected: false },
        { id: '5V', x: 80, y: 10, type: 'power', label: '5V', connected: false },
        { id: 'GND1', x: 100, y: 10, type: 'ground', label: 'GND', connected: false },
        { id: 'GND2', x: 120, y: 10, type: 'ground', label: 'GND', connected: false },
        { id: 'VIN', x: 140, y: 10, type: 'power', label: 'VIN', connected: false },
        
        // 右侧引脚排列 (顶部)
        { id: 'A0', x: 180, y: 10, type: 'analog', label: 'A0', connected: false },
        { id: 'A1', x: 200, y: 10, type: 'analog', label: 'A1', connected: false },
        { id: 'A2', x: 220, y: 10, type: 'analog', label: 'A2', connected: false },
        { id: 'A3', x: 240, y: 10, type: 'analog', label: 'A3', connected: false },
        { id: 'A4', x: 260, y: 10, type: 'analog', label: 'A4 (SDA)', connected: false },
        { id: 'A5', x: 280, y: 10, type: 'analog', label: 'A5 (SCL)', connected: false },
        
        // 左侧引脚排列 (底部)
        { id: 'D0', x: 40, y: 170, type: 'digital', label: 'D0 (RX)', connected: false },
        { id: 'D1', x: 60, y: 170, type: 'digital', label: 'D1 (TX)', connected: false },
        { id: 'D2', x: 80, y: 170, type: 'digital', label: 'D2', connected: false },
        { id: 'D3', x: 100, y: 170, type: 'digital', label: 'D3 (PWM)', connected: false },
        { id: 'D4', x: 120, y: 170, type: 'digital', label: 'D4', connected: false },
        { id: 'D5', x: 140, y: 170, type: 'digital', label: 'D5 (PWM)', connected: false },
        { id: 'D6', x: 160, y: 170, type: 'digital', label: 'D6 (PWM)', connected: false },
        { id: 'D7', x: 180, y: 170, type: 'digital', label: 'D7', connected: false },
        
        // 右侧引脚排列 (底部)
        { id: 'D8', x: 200, y: 170, type: 'digital', label: 'D8', connected: false },
        { id: 'D9', x: 220, y: 170, type: 'digital', label: 'D9 (PWM)', connected: false },
        { id: 'D10', x: 240, y: 170, type: 'digital', label: 'D10 (PWM)', connected: false },
        { id: 'D11', x: 260, y: 170, type: 'digital', label: 'D11 (PWM)', connected: false },
        { id: 'D12', x: 280, y: 170, type: 'digital', label: 'D12', connected: false },
        { id: 'D13', x: 300, y: 170, type: 'digital', label: 'D13 (LED)', connected: false },
        
        // ICSP引脚 (右上角)
        { id: 'ICSP_MISO', x: 240, y: 30, type: 'digital', label: 'MISO', connected: false },
        { id: 'ICSP_VCC', x: 260, y: 30, type: 'power', label: '5V', connected: false },
        { id: 'ICSP_SCK', x: 240, y: 45, type: 'digital', label: 'SCK', connected: false },
        { id: 'ICSP_MOSI', x: 260, y: 45, type: 'digital', label: 'MOSI', connected: false },
        { id: 'ICSP_RESET', x: 280, y: 30, type: 'digital', label: 'RST', connected: false },
        { id: 'ICSP_GND', x: 280, y: 45, type: 'ground', label: 'GND', connected: false },
        
        // AREF引脚 (顶部右侧)
        { id: 'AREF', x: 160, y: 10, type: 'analog', label: 'AREF', connected: false }
      ]
    };
  }

  private createTemperatureComponent(id: string, x: number, y: number): CircuitComponent {
    return {
      id,
      type: 'temperature',
      x,
      y,
      width: 80,
      height: 60,
      pins: [
        { id: 'VCC', x: 10, y: 50, type: 'power', label: 'VCC', connected: false },
        { id: 'OUT', x: 40, y: 50, type: 'analog', label: 'OUT', connected: false },
        { id: 'GND', x: 70, y: 50, type: 'ground', label: 'GND', connected: false }
      ]
    };
  }

  private createLEDComponent(id: string, x: number, y: number): CircuitComponent {
    return {
      id,
      type: 'led',
      x,
      y,
      width: 60,
      height: 40,
      pins: [
        { id: 'A', x: 10, y: 30, type: 'digital', label: 'A', connected: false },
        { id: 'K', x: 50, y: 30, type: 'digital', label: 'K', connected: false }
      ]
    };
  }

  private createComponentShape(component: CircuitComponent) {
    const group = new Konva.Group({
      x: component.x,
      y: component.y,
      draggable: true
    });

    // 创建@wokwi/elements组件的容器
    const foreignObject = this.createWokwiComponent(component);
    
    // 创建组件背景（用于Konva交互）
    const rect = new Konva.Rect({
      width: component.width,
      height: component.height,
      fill: 'transparent',
      stroke: '#333',
      strokeWidth: 2,
      cornerRadius: 5,
      opacity: 0.1
    });

    // 创建组件标签
    const label = new Konva.Text({
      x: 10,
      y: component.height + 10,
      text: component.type.toUpperCase(),
      fontSize: 12,
      fontFamily: 'Arial',
      fill: '#333'
    });

    group.add(rect);
    group.add(label);

    // 创建引脚
    component.pins.forEach(pin => {
      const circle = new Konva.Circle({
        x: pin.x,
        y: pin.y,
        radius: 8,
        fill: pin.connected ? '#4CAF50' : this.getPinColor(pin.type),
        stroke: '#000',
        strokeWidth: 2
      });

      const pinLabel = new Konva.Text({
        x: pin.x - 15,
        y: pin.y - 20,
        text: pin.label,
        fontSize: 10,
        fontFamily: 'Arial',
        fill: '#000',
        align: 'center'
      });

      // 引脚点击事件
      circle.on('click', (e) => {
        e.cancelBubble = true;
        this.handlePinClick(component.id, pin.id);
      });

      circle.on('mouseenter', () => {
        circle.scale({ x: 1.3, y: 1.3 });
        circle.fill(pin.connected ? '#81C784' : '#FFC107');
        document.body.style.cursor = 'pointer';
        this.layer.batchDraw();
      });

      circle.on('mouseleave', () => {
        circle.scale({ x: 1, y: 1 });
        circle.fill(pin.connected ? '#4CAF50' : this.getPinColor(pin.type));
        document.body.style.cursor = 'default';
        this.layer.batchDraw();
      });

      pin.circle = circle;
      group.add(circle);
      group.add(pinLabel);
    });

    // 拖拽事件
    group.on('dragstart', () => {
      group.opacity(0.8);
      this.layer.batchDraw();
    });

    group.on('dragmove', () => {
      component.x = group.x();
      component.y = group.y();
      this.updateComponentElement(component);
      this.updateConnectionLines(component.id);
    });

    group.on('dragend', () => {
      group.opacity(1);
      this.layer.batchDraw();
    });

    // 组件悬停效果
    group.on('mouseenter', () => {
      if (!group.isDragging()) {
        rect.opacity(0.2);
        this.layer.batchDraw();
      }
    });

    group.on('mouseleave', () => {
      rect.opacity(0.1);
      this.layer.batchDraw();
    });

    component.shape = group;
    this.layer.add(group);
    this.layer.draw();

    // 将@wokwi组件添加到DOM
    if (foreignObject) {
      this.containerRef.nativeElement.appendChild(foreignObject);
      component.element = foreignObject;
      this.updateComponentElement(component);
    }
  }

  private createWokwiComponent(component: CircuitComponent): HTMLElement | null {
    let element: HTMLElement;

    switch (component.type) {
      case 'arduino':
        element = document.createElement('wokwi-arduino-uno');
        break;
      case 'temperature':
        element = document.createElement('wokwi-tmp36');
        break;
      case 'led':
        element = document.createElement('wokwi-led');
        (element as any).color = 'red';
        break;
      default:
        return null;
    }

    element.style.position = 'absolute';
    element.style.pointerEvents = 'none';
    element.style.zIndex = '1';
    
    return element;
  }

  private updateComponentElement(component: CircuitComponent) {
    if (component.element) {
      const containerRect = this.containerRef.nativeElement.getBoundingClientRect();
      const stageRect = this.stage.container().getBoundingClientRect();
      
      component.element.style.left = `${component.x + (stageRect.left - containerRect.left)}px`;
      component.element.style.top = `${component.y + (stageRect.top - containerRect.top)}px`;
    }
  }

  private getComponentColor(type: string): string {
    switch (type) {
      case 'arduino': return '#2196F3';
      case 'temperature': return '#FF9800';
      case 'led': return '#4CAF50';
      default: return '#9E9E9E';
    }
  }

  private getPinColor(type: string): string {
    switch (type) {
      case 'digital': return '#2196F3';
      case 'analog': return '#FF9800';
      case 'power': return '#F44336';
      case 'ground': return '#424242';
      default: return '#9E9E9E';
    }
  }

  private handlePinClick(componentId: string, pinId: string) {
    if (!this.isConnecting) {
      // 开始连接
      this.startConnection(componentId, pinId);
    } else {
      // 完成连接
      this.completeConnection(componentId, pinId);
    }
  }

  private startConnection(componentId: string, pinId: string) {
    const component = this.components.get(componentId);
    if (!component) return;

    const pin = component.pins.find(p => p.id === pinId);
    if (!pin || pin.connected) return;

    this.isConnecting = true;
    this.currentConnection = {
      fromComponent: componentId,
      fromPin: pinId
    };

    // 创建临时连线
    const startPos = this.getPinGlobalPosition(component, pin);
    const tempLine = new Konva.Line({
      points: [startPos.x, startPos.y, startPos.x, startPos.y],
      stroke: '#FF0000',
      strokeWidth: 2,
      dash: [5, 5]
    });

    this.currentConnection.tempLine = tempLine;
    this.layer.add(tempLine);

    // 跟随鼠标移动
    this.stage.on('mousemove', this.handleMouseMove.bind(this));
  }

  private handleMouseMove() {
    if (!this.currentConnection?.tempLine) return;

    const pos = this.stage.getPointerPosition();
    if (!pos) return;

    const line = this.currentConnection.tempLine;
    const points = line.points();
    line.points([points[0], points[1], pos.x, pos.y]);
    this.layer.batchDraw();
  }

  private completeConnection(toComponentId: string, toPinId: string) {
    if (!this.currentConnection) return;

    const fromComponent = this.components.get(this.currentConnection.fromComponent);
    const toComponent = this.components.get(toComponentId);

    if (!fromComponent || !toComponent) {
      this.cancelConnection();
      return;
    }

    const fromPin = fromComponent.pins.find(p => p.id === this.currentConnection!.fromPin);
    const toPin = toComponent.pins.find(p => p.id === toPinId);

    if (!fromPin || !toPin || fromPin.connected || toPin.connected) {
      this.cancelConnection();
      return;
    }

    // 创建连接
    const connectionId = `${this.currentConnection.fromComponent}_${this.currentConnection.fromPin}_${toComponentId}_${toPinId}`;
    
    const connection: Connection = {
      id: connectionId,
      fromComponent: this.currentConnection.fromComponent,
      fromPin: this.currentConnection.fromPin,
      toComponent: toComponentId,
      toPin: toPinId
    };

    this.createConnectionLine(connection);
    this.connections.set(connectionId, connection);

    // 更新引脚状态
    fromPin.connected = true;
    toPin.connected = true;

    this.cancelConnection();
  }

  public cancelConnection() {
    if (this.currentConnection?.tempLine) {
      this.currentConnection.tempLine.destroy();
    }
    
    this.currentConnection = null;
    this.isConnecting = false;
    this.stage.off('mousemove');
    this.layer.batchDraw();
  }

  private createConnectionLine(connection: Connection) {
    const fromComponent = this.components.get(connection.fromComponent);
    const toComponent = this.components.get(connection.toComponent);

    if (!fromComponent || !toComponent) return;

    const fromPin = fromComponent.pins.find(p => p.id === connection.fromPin);
    const toPin = toComponent.pins.find(p => p.id === connection.toPin);

    if (!fromPin || !toPin) return;

    const startPos = this.getPinGlobalPosition(fromComponent, fromPin);
    const endPos = this.getPinGlobalPosition(toComponent, toPin);

    // 计算避障路径
    const pathPoints = this.calculateAvoidancePath(startPos, endPos, fromComponent, toComponent);

    // 创建连接线
    const line = new Konva.Line({
      points: pathPoints,
      stroke: this.getConnectionColor(fromPin.type, toPin.type),
      strokeWidth: 3,
      lineCap: 'round',
      lineJoin: 'round',
      tension: 0.2, // 添加曲线张力使路径更平滑
      shadowColor: 'rgba(0,0,0,0.3)',
      shadowBlur: 2,
      shadowOffset: { x: 1, y: 1 }
    });

    // 添加点击删除功能
    line.on('click', (e) => {
      e.cancelBubble = true;
      this.showConnectionMenu(connection, e.evt.clientX, e.evt.clientY);
    });

    line.on('mouseenter', () => {
      line.stroke('#FF5722');
      line.strokeWidth(4);
      document.body.style.cursor = 'pointer';
      this.layer.batchDraw();
    });

    line.on('mouseleave', () => {
      line.stroke(this.getConnectionColor(fromPin.type, toPin.type));
      line.strokeWidth(3);
      document.body.style.cursor = 'default';
      this.layer.batchDraw();
    });

    connection.line = line;
    this.layer.add(line);
    this.layer.batchDraw();

    // 更新引脚视觉状态
    if (fromPin.circle) {
      fromPin.circle.fill('#4CAF50');
    }
    if (toPin.circle) {
      toPin.circle.fill('#4CAF50');
    }
  }

  private getConnectionColor(fromPinType: string, toPinType: string): string {
    // 根据引脚类型返回不同颜色
    if (fromPinType === 'power' || toPinType === 'power') return '#F44336';
    if (fromPinType === 'ground' || toPinType === 'ground') return '#424242';
    if (fromPinType === 'analog' || toPinType === 'analog') return '#FF9800';
    return '#4CAF50'; // digital
  }

  private showConnectionMenu(connection: Connection, x: number, y: number) {
    // 简单的确认删除对话框
    const result = confirm('是否删除此连接？');
    if (result) {
      this.removeConnection(connection.id);
    }
  }

  private getPinGlobalPosition(component: CircuitComponent, pin: Pin) {
    return {
      x: component.x + pin.x,
      y: component.y + pin.y
    };
  }

  private calculateAvoidancePath(start: {x: number, y: number}, end: {x: number, y: number}, 
                                 fromComponent: CircuitComponent, toComponent: CircuitComponent): number[] {
    // 高级避障算法：A*路径查找的简化版本
    const obstacles = this.getObstacles(fromComponent, toComponent);
    
    if (obstacles.length === 0) {
      // 没有障碍物，直接连接
      return [start.x, start.y, end.x, end.y];
    }

    // 计算避障路径
    const path = this.findPath(start, end, obstacles);
    
    // 平滑路径
    return this.smoothPath(path);
  }

  private getObstacles(excludeComp1: CircuitComponent, excludeComp2: CircuitComponent) {
    const obstacles: {x: number, y: number, width: number, height: number}[] = [];
    
    for (const [id, component] of this.components) {
      if (id === excludeComp1.id || id === excludeComp2.id) continue;
      
      obstacles.push({
        x: component.x - 10, // 增加边距
        y: component.y - 10,
        width: component.width + 20,
        height: component.height + 20
      });
    }
    
    return obstacles;
  }

  private findPath(start: {x: number, y: number}, end: {x: number, y: number}, 
                   obstacles: {x: number, y: number, width: number, height: number}[]): {x: number, y: number}[] {
    // 简化的A*算法
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    
    // 检查直线路径是否被阻挡
    if (!this.pathBlocked(start, end, obstacles)) {
      return [start, end];
    }
    
    // 尝试L形路径
    const midPoint1 = { x: end.x, y: start.y };
    const midPoint2 = { x: start.x, y: end.y };
    
    // 尝试第一种L形路径
    if (!this.pathBlocked(start, midPoint1, obstacles) && 
        !this.pathBlocked(midPoint1, end, obstacles)) {
      return [start, midPoint1, end];
    }
    
    // 尝试第二种L形路径
    if (!this.pathBlocked(start, midPoint2, obstacles) && 
        !this.pathBlocked(midPoint2, end, obstacles)) {
      return [start, midPoint2, end];
    }
    
    // 使用更复杂的绕行路径
    return this.findComplexPath(start, end, obstacles);
  }

  private pathBlocked(start: {x: number, y: number}, end: {x: number, y: number}, 
                     obstacles: {x: number, y: number, width: number, height: number}[]): boolean {
    for (const obstacle of obstacles) {
      if (this.lineIntersectsRect(start, end, {
        x1: obstacle.x,
        y1: obstacle.y,
        x2: obstacle.x + obstacle.width,
        y2: obstacle.y + obstacle.height
      })) {
        return true;
      }
    }
    return false;
  }

  private findComplexPath(start: {x: number, y: number}, end: {x: number, y: number}, 
                         obstacles: {x: number, y: number, width: number, height: number}[]): {x: number, y: number}[] {
    // 找到最大的障碍物，绕过它
    let maxObstacle = obstacles[0];
    for (const obstacle of obstacles) {
      if ((obstacle.width * obstacle.height) > (maxObstacle.width * maxObstacle.height)) {
        maxObstacle = obstacle;
      }
    }
    
    if (!maxObstacle) return [start, end];
    
    // 计算绕行点
    const margin = 20;
    const obstacleCenter = {
      x: maxObstacle.x + maxObstacle.width / 2,
      y: maxObstacle.y + maxObstacle.height / 2
    };
    
    let waypoint: {x: number, y: number};
    
    // 根据起点和终点的相对位置选择绕行方向
    if (start.x < obstacleCenter.x && end.x > obstacleCenter.x) {
      // 从左到右，选择上方或下方绕行
      if (Math.abs(start.y - maxObstacle.y) < Math.abs(start.y - (maxObstacle.y + maxObstacle.height))) {
        waypoint = { x: obstacleCenter.x, y: maxObstacle.y - margin };
      } else {
        waypoint = { x: obstacleCenter.x, y: maxObstacle.y + maxObstacle.height + margin };
      }
    } else if (start.y < obstacleCenter.y && end.y > obstacleCenter.y) {
      // 从上到下，选择左方或右方绕行
      if (Math.abs(start.x - maxObstacle.x) < Math.abs(start.x - (maxObstacle.x + maxObstacle.width))) {
        waypoint = { x: maxObstacle.x - margin, y: obstacleCenter.y };
      } else {
        waypoint = { x: maxObstacle.x + maxObstacle.width + margin, y: obstacleCenter.y };
      }
    } else {
      // 默认右上方绕行
      waypoint = { 
        x: maxObstacle.x + maxObstacle.width + margin, 
        y: maxObstacle.y - margin 
      };
    }
    
    return [start, waypoint, end];
  }

  private smoothPath(path: {x: number, y: number}[]): number[] {
    if (path.length <= 2) {
      return path.flatMap(p => [p.x, p.y]);
    }
    
    // 将路径转换为贝塞尔曲线点
    const points: number[] = [];
    
    for (let i = 0; i < path.length; i++) {
      if (i === 0) {
        points.push(path[i].x, path[i].y);
      } else if (i === path.length - 1) {
        points.push(path[i].x, path[i].y);
      } else {
        // 在转折点添加圆角
        const prev = path[i - 1];
        const curr = path[i];
        const next = path[i + 1];
        
        const radius = 15;
        const d1 = Math.sqrt((curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2);
        const d2 = Math.sqrt((next.x - curr.x) ** 2 + (next.y - curr.y) ** 2);
        
        const r1 = Math.min(radius, d1 / 2);
        const r2 = Math.min(radius, d2 / 2);
        
        const p1 = {
          x: curr.x - (curr.x - prev.x) * r1 / d1,
          y: curr.y - (curr.y - prev.y) * r1 / d1
        };
        
        const p2 = {
          x: curr.x + (next.x - curr.x) * r2 / d2,
          y: curr.y + (next.y - curr.y) * r2 / d2
        };
        
        points.push(p1.x, p1.y, curr.x, curr.y, p2.x, p2.y);
      }
    }
    
    return points;
  }

  private checkComponentOverlap(start: {x: number, y: number}, end: {x: number, y: number}, 
                               fromComponent: CircuitComponent, toComponent: CircuitComponent): boolean {
    // 简单检查：如果线段会穿过其他组件则需要避障
    for (const [id, component] of this.components) {
      if (id === fromComponent.id || id === toComponent.id) continue;

      const rect = {
        x1: component.x,
        y1: component.y,
        x2: component.x + component.width,
        y2: component.y + component.height
      };

      if (this.lineIntersectsRect(start, end, rect)) {
        return true;
      }
    }
    return false;
  }

  private lineIntersectsRect(start: {x: number, y: number}, end: {x: number, y: number}, 
                            rect: {x1: number, y1: number, x2: number, y2: number}): boolean {
    // 简化的线段与矩形相交检测
    return !(end.x < rect.x1 || start.x > rect.x2 || end.y < rect.y1 || start.y > rect.y2);
  }

  private updateConnectionLines(componentId: string) {
    for (const [id, connection] of this.connections) {
      if (connection.fromComponent === componentId || connection.toComponent === componentId) {
        // 重新计算连线路径
        if (connection.line) {
          connection.line.destroy();
        }
        this.createConnectionLine(connection);
      }
    }
  }

  private removeConnection(connectionId: string) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    // 移除连线
    if (connection.line) {
      connection.line.destroy();
    }

    // 更新引脚状态
    const fromComponent = this.components.get(connection.fromComponent);
    const toComponent = this.components.get(connection.toComponent);

    if (fromComponent) {
      const fromPin = fromComponent.pins.find(p => p.id === connection.fromPin);
      if (fromPin) {
        fromPin.connected = false;
        if (fromPin.circle) {
          fromPin.circle.fill(this.getPinColor(fromPin.type));
        }
      }
    }

    if (toComponent) {
      const toPin = toComponent.pins.find(p => p.id === connection.toPin);
      if (toPin) {
        toPin.connected = false;
        if (toPin.circle) {
          toPin.circle.fill(this.getPinColor(toPin.type));
        }
      }
    }

    this.connections.delete(connectionId);
    this.layer.batchDraw();
  }

  // 清空画布
  clearAll() {
    // 移除所有@wokwi组件
    for (const [id, component] of this.components) {
      if (component.element && component.element.parentNode) {
        component.element.parentNode.removeChild(component.element);
      }
    }
    
    this.components.clear();
    this.connections.clear();
    this.cancelConnection();
    this.layer.destroyChildren();
    this.layer.draw();
  }

  // 导出连接信息
  exportConnections() {
    const exportData = {
      components: Array.from(this.components.values()).map(comp => ({
        id: comp.id,
        type: comp.type,
        x: comp.x,
        y: comp.y
      })),
      connections: Array.from(this.connections.values()).map(conn => ({
        id: conn.id,
        fromComponent: conn.fromComponent,
        fromPin: conn.fromPin,
        toComponent: conn.toComponent,
        toPin: conn.toPin
      }))
    };

    console.log('Circuit Export:', exportData);
    // 这里可以添加保存到文件的逻辑
  }
}
