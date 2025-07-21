import { Injectable } from '@angular/core';
import { ConfigService } from '../../services/config.service';
import { BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class PlaygroundService {
  private _examplesList: any[] = [];
  private _processedExamplesList: any[] = [];
  private examplesListSubject = new BehaviorSubject<any[]>([]);
  
  // 公开的Observable，组件可以订阅
  public examplesList$ = this.examplesListSubject.asObservable();
  
  private _isLoaded = false;
  
  constructor(private configService: ConfigService) { }

  // 获取示例列表数据
  async loadExamplesList(): Promise<any[]> {
    if (this._isLoaded && this._examplesList.length > 0) {
      return this._processedExamplesList;
    }

    try {
      const data = await this.configService.loadExamplesList();
      this._examplesList = data;
      this._processedExamplesList = this.processExamples(data);
      this._isLoaded = true;
      
      // 通知所有订阅者数据已更新
      this.examplesListSubject.next(this._processedExamplesList);
      
      return this._processedExamplesList;
    } catch (error) {
      console.error('加载示例列表失败:', error);
      return [];
    }
  }

  // 处理示例列表数据，为搜索做准备
  private processExamples(array: any[]): any[] {
    return array.map(item => ({
      ...item,
      // 为全文搜索做准备，将所有可能需要搜索的字段组合起来
      fulltext: `${item.title || ''}${item.description || ''}${item.tags?.join(' ') || ''}${item.difficulty || ''}${item.author || ''}`.replace(/\s/g, '').toLowerCase()
    }));
  }

  // 根据名称查找特定示例
  findExampleByName(name: string): any {
    return this._processedExamplesList.find(item => 
      item.name.replace('@aily-project/', '') === name
    );
  }

  // 搜索示例
  searchExamples(keyword: string): any[] {
    if (!keyword) {
      return [...this._processedExamplesList];
    }
    
    const searchKeyword = keyword.replace(/\s/g, '').toLowerCase();
    return this._processedExamplesList.filter(item => 
      item.fulltext.includes(searchKeyword)
    );
  }

  // 获取原始示例列表
  get rawExamplesList(): any[] {
    return [...this._examplesList];
  }

  // 获取处理后的示例列表
  get processedExamplesList(): any[] {
    return [...this._processedExamplesList];
  }

  // 检查数据是否已加载
  get isLoaded(): boolean {
    return this._isLoaded;
  }
}
