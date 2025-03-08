import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class SerialMonitorService {
  dataViewMode = {
    hex: true,
    ctrlChar: true,
    warp: true,
    scroll: true,
    time: true,
  }

  inputViewMode = {
    hex: false,
    enter: false,
  }

  data = [];

  constructor() { }
}
