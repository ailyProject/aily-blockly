import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TranslateService } from '@ngx-translate/core';
import { Observable, map, catchError, of } from 'rxjs';
import { API } from '../../configs/api.config';

export interface ModelItem {
  id: string;
  name: string;
  description: string;
  author: string;
  author_name: string;
  pic_url: string;
  model_size: string;
  task: string;
  scenario: string;
  model_format: string;
  ai_framework: string;
  be_public: string;
  precision: string;
  created: string;
  like_num: string;
  follow_num: string;
  deploy_num: string;
  priority: string;
  adapteds: string[];
  uniform_types: string[];
  follow_time: string;
  like_time: string;
}

export interface ModelListResponse {
  code: string;
  data: {
    total: string;  // 总模型数量
    list: ModelItem[];
  };
  [key: string]: any;
}

export interface ModelListResult {
  list: ModelItem[];
  total: number;  // 总数
  totalPages: number;  // 总页数
}

export interface ModelLabel {
  object_id: string;
  object_name: string;
}

export interface ModelDetail {
  id: string;
  name: string;
  description: string;
  content: string;
  author: string;
  author_name: string;
  pic_url: string;
  file_url: string;
  model_size: string;
  be_public: string;
  deploy_num: string;
  view_num: string;
  like_num: string;
  follow_num: string;
  priority: string;
  scenario: string;
  precision: string;
  ai_framework: string;
  model_format: string;
  task: string;
  preparation: string[];
  checksum: string;
  attr: {
    iou: string;
    conf: string;
  };
  is_enabled: boolean;
  version: string;
  created: string;
  deleted: string;
  adapteds: string[];
  labels: ModelLabel[];
  uniform_types: string[];
}

export interface ModelDetailResponse {
  status: number;
  code: string;
  data: ModelDetail;
}

@Injectable({
  providedIn: 'root'
})
export class ModelStoreService {
  // private baseUrl = 'https://sensecraft.seeed.cc/aiserverapi/model/list_model';
  // private detailApiUrl = 'https://sensecraft.seeed.cc/aiserverapi/model/view_model';

  private baseUrl = API.modelList;
  private detailApiUrl = API.modelDetails;

  private readonly pageSize = 12;  // 每页显示数量
  // private readonly uniformType = 32;  // XIAO ESP32S3 Sense

  constructor(
    private translateService: TranslateService,
    private http: HttpClient
  ) { }

  /**
   * 获取模型列表
   * @param page 页码（从1开始）
   * @param pageSize 每页数量
   * @param uniformType 开发板类型（可选）
   * @returns Observable<ModelListResult>
   */
  getModelList(page: number = 1, pageSize: number = 12, uniformType?: number, search?: string): Observable<ModelListResult> {
    // const type = uniformType || this.uniformType;
    const type = uniformType || '';
    const url = `${this.baseUrl}?page=${page}&length=${pageSize}&uniform_type=${type}&lang=${this.translateService.currentLang}&search=${search || ''}`;
    console.log('请求模型列表URL:', url);
    return this.http.get<ModelListResponse>(url).pipe(
      map(response => {
        const total = parseInt(response.data.total || '0', 10);
        const totalPages = Math.ceil(total / pageSize);
        
        return {
          list: response.data.list || [],
          total,
          totalPages
        };
      }),
      catchError(error => {
        console.error('获取模型列表失败:', error);
        return of({ list: [], total: 0, totalPages: 0 });
      })
    );
  }

  /**
   * 获取模型详情
   * @param id 模型ID
   * @returns Observable<ModelDetail | null>
   */
  getModelDetail(id: string): Observable<ModelDetail | null> {
    return this.http.get<ModelDetailResponse>(`${this.detailApiUrl}?model_id=${id}&lang=${this.translateService.currentLang}`).pipe(
      map(response => {
        // console.log('模型详情响应:', response);
        if (response.status === 200 && response.data) {
          // console.log('模型详情:', response.data);
          return response.data;
        }
        return null;
      }),
      catchError(error => {
        console.error('获取模型详情失败:', error);
        return of(null);
      })
    );
  }
}
