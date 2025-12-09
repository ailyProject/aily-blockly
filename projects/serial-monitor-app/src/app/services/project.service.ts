import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/**
 * 项目服务 - 子应用适配版本
 */
@Injectable({
  providedIn: 'root'
})
export class ProjectService {
  currentPackageData: any = {
    board: '',
    name: '',
    version: ''
  };

  projectDataSubject = new BehaviorSubject<any>(this.currentPackageData);
}
