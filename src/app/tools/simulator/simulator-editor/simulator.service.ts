import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import * as AVR8js from 'avr8js';

export interface PinState {
  pin: string;
  value: boolean;
}

export interface ComponentConfig {
  id: string;
  type: string;
  pins: Record<string, string>;
}

@Injectable({
  providedIn: 'root'
})
export class SimulatorService {
  // 引脚状态变化的可观察对象
  pinStateChange = new Subject<PinState>();

  // 模拟器状态
  private isRunning = false;
  private boardType = '';
  private components: Map<string, ComponentConfig> = new Map();
  
  // AVR8js 相关
  private cpu: AVR8js.CPU | null = null;
  private ports: Map<string, AVR8js.AVRIOPort> = new Map();
  
  constructor() { }

}
