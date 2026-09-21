import { Injectable } from '@angular/core';
import { Subject, Observable } from 'rxjs';

/** 位图上传请求接口 */
export interface BitmapUploadRequest {
  fieldId: string;            // 字段唯一ID
  currentBitmap: number[][];  // 当前位图数据
  width: number;              // 宽度
  height: number;             // 高度
  timestamp: number;          // 时间戳
}
/** 位图上传响应接口 */
export interface BitmapUploadResponse {
  fieldId?: string;           // 字段唯一ID（用于匹配请求）
  data?: {
    "bitmapArray": number[][],  // 改为number[][]类型以保持一致性
    "width": number,
    "height": number,
    "option": {
      "endian": boolean,
      "invert": boolean,
      "dither": boolean,
      "threshold": number
    }
  },
  processedBitmap?: number[][]; // 处理后的位图数据
  success: boolean;            // 是否成功
  message?: string;            // 消息（可选）
  timestamp?: number;           // 时间戳
}

/**
 * 位图上传服务
 * 提供位图字段与主程序之间的通信功能
 */
@Injectable()
export class BitmapUploadService {
  uploadRequestSubject = new Subject<BitmapUploadRequest>();
  uploadResponseSubject = new Subject<BitmapUploadResponse>();

  /**
   * 来自位图字段的上传请求的可观察对象
   */
  uploadRequest$ = this.uploadRequestSubject.asObservable();

  /**
   * 发送给位图字段的上传响应的可观察对象
   */
  uploadResponse$ = this.uploadResponseSubject.asObservable();
  /**
   * 从位图字段发送上传请求到Angular主程序
   * @param request 上传请求数据
   */
  sendUploadRequest(request: BitmapUploadRequest): void {
    // console.log('Bitmap upload request sent:', request);
    this.uploadRequestSubject.next(request);
  }

  /**
   * 从Angular主程序发送上传响应到位图字段
   * @param response 上传响应数据
   */
  sendUploadResponse(response: BitmapUploadResponse): void {
    console.log('Bitmap upload response sent:', response);
    this.uploadResponseSubject.next(response);
  }
  /**
   * 处理上传请求（占位符实现）
   * 此方法应该被重写或替换为实际的处理逻辑
   * @param request 上传请求数据
   * @returns 返回处理后的响应Promise
   */
  async processUpload(request: BitmapUploadRequest): Promise<BitmapUploadResponse> {
    // 占位符实现 - 请替换为实际的处理逻辑
    return new Promise((resolve) => {
      setTimeout(() => {
        // 示例：简单返回相同的位图和成功消息
        const response: BitmapUploadResponse = {
          processedBitmap: request.currentBitmap,
          success: true,
          message: '上传处理成功',
          timestamp: Date.now()
        };
        resolve(response);
      }, 1000); // 模拟处理延迟
    });
  }
}
