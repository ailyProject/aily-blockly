import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/**
 * 配置服务 - 子应用适配版本
 */
@Injectable({
  providedIn: 'root'
})
export class ConfigService {
  config: any = {};
  
  configSubject = new BehaviorSubject<any>(this.config);

  get(key: string): any {
    return this.config[key];
  }

  set(key: string, value: any): void {
    this.config[key] = value;
    this.configSubject.next(this.config);
  }
}
