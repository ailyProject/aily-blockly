import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { API } from '../configs/api.config';

@Injectable({
  providedIn: 'root'
})
export class NpmService {
  constructor(
    private http: HttpClient
  ) { }


  // 指定获取packageName的可用版本列表
  async getPackageVersionList(packageName: string): Promise<string[]> {
    let data = await window['npm'].run({ cmd: `npm view ${packageName} versions --registry https://registry.openjumper.cn --json` })
    let packageVersionList = [];
    if (typeof data === 'string') {
      packageVersionList.push(data);
    } else {
      packageVersionList = data;
    }
    return packageVersionList;
  }

  async getInstalledPackageList(path) {
    let data = await window['npm'].run({ cmd: `npm list --depth=0 --json --prefix ${path}` });
    let installedPackageList = [];
    for (let key in data.dependencies) {
      const item = data.dependencies[key];
      installedPackageList.push(key + '@' + item.version);
    }
    return installedPackageList;
  }

  /**
   * 库列表
   * @param data
   */
  list(data: any) {
    return this.http.get<ResponseModel>(API.projectList, {
      params: data,
    });
  }

  /**
   * 库搜索
   * @param data
   * @param data.text 搜索关键字
   * @param data.size
   * @param data.from
   * @param data.quality
   * @param data.popularity
   * @param data.maintenance
   */
  search(data: any) {
    return this.http.get<SearchResponseModel>(API.projectSearch, {
      params: data,
    });
  }
}

export interface SearchResponseModel {
  objects: any[],
  time: string,
  total: number
}

export interface ResponseModel {
  status: number;
  messages: string;
  data: any;
}

