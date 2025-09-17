import { Component, CUSTOM_ELEMENTS_SCHEMA, ElementRef, ViewChild, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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

  }

  ngOnDestroy() {
    
  }

}
