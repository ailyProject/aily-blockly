import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ParentBridgeService } from './parent-bridge.service';

export interface PortItem {
  path?: string;
  name?: string;
  text?: string;
  type?: string;
  icon?: string;
  disabled?: boolean;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  friendlyName?: string;
  vendorId?: string;
  productId?: string;
}

/**
 * 串口服务 - 子应用适配版本
 * 通过 ParentBridgeService 与主应用通信
 */
@Injectable({
  providedIn: 'root'
})
export class SerialService {
  currentPort: string | null = null;
  currentBaudRate = 9600;
  
  ports = new BehaviorSubject<PortItem[]>([]);

  constructor(private parentBridge: ParentBridgeService) {}
  
  async getPortsList(): Promise<PortItem[]> {
    try {
      const ports = await this.parentBridge.getSerialPorts();
      this.ports.next(ports);
      return ports;
    } catch (error) {
      console.error('Failed to get ports list:', error);
      return [];
    }
  }

  async getSerialPorts(): Promise<PortItem[]> {
    return this.getPortsList();
  }
}
