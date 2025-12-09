import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

/**
 * UI 服务 - 子应用适配版本
 */
@Injectable({
  providedIn: 'root'
})
export class UiService {
  topTool: string | null = 'serial-monitor';
  
  actionSubject = new Subject<any>();
  stateSubject = new BehaviorSubject<any>({ state: 'idle', text: '' });

  closeTool(toolName?: string) {
    // 在子应用中，通知父应用关闭
    console.log('closeTool:', toolName);
  }

  openWindow(opt: WindowOpts) {
    // 在子应用中暂不支持打开窗口
    console.log('openWindow not supported in child app:', opt);
  }
}

export interface WindowOpts {
  path: string;
  title?: string;
  alwaysOnTop?: boolean;
  width?: number;
  height?: number;
}

export interface ToolOpts {
  type: string;
  data: string;
  title?: string;
}
