import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class IwindowService {
  windows: IWindowOpts[] = [];

  // bounds: HTMLElement;

  constructor() {}

  openWindow(opts: IWindowOpts) {
    opts.zindex = opts.zindex == 0 ? opts.zindex : this.getMaxZindex() + 1;
    opts.size = opts.size || { width: 400, height: 600 };
    opts.position = opts.position || {
      x: window.innerWidth - opts.size.width,
      y: 65,
    };
    this.windows.push(opts);
  }

  closeWindow(opts: IWindowOpts) {
    let index = this.windows.indexOf(opts);
    this.windows.splice(index, 1);
  }

  getMaxZindex() {
    if (this.windows.length === 0) return 0;
    return this.windows.reduce((prev, curr) => {
      return prev.zindex > curr.zindex ? prev : curr;
    }).zindex;
  }
}

export interface IWindowOpts {
  position?: {
    x: number;
    y: number;
  };
  size?: {
    width: number;
    height: number;
    minWidth?: number;
    minHeight?: number;
  };
  type?: string;
  title: string;
  zindex?: number;
}
