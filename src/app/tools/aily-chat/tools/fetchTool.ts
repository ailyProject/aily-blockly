import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { injectTodoReminder } from './todoWriteTool';

export interface FetchToolArgs {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: { [key: string]: string };
  body?: any;
  timeout?: number | string;
  maxSize?: number | string; // 最大文件大小（字节）
  responseType?: 'text' | 'json' | 'blob' | 'arraybuffer';
}

export interface FetchToolResult {
  content: string;
  is_error: boolean;
  metadata?: {
    status: number;
    statusText: string;
    headers: { [key: string]: string };
    size: number;
    contentType?: string;
  };
}

@Injectable({
  providedIn: 'root'
})
export class FetchToolService {
  constructor(private http: HttpClient) {}

  async executeFetch(args: FetchToolArgs): Promise<FetchToolResult> {
    try {
      let {
        url,
        method = 'GET',
        headers = {},
        body,
        timeout: timeoutMs = 30000,
        maxSize = 50 * 1024 * 1024, // 默认50MB
        responseType = 'text'
      } = args;

      // 确保超时值是数字类型
      const timeoutNumber = typeof timeoutMs === 'string' ? parseInt(timeoutMs, 10) : timeoutMs;
      const maxSizeNumber = typeof maxSize === 'string' ? parseInt(maxSize, 10) : maxSize;

      // 验证URL
      if (!url || !this.isValidUrl(url)) {
        return {
          content: '无效的URL地址',
          is_error: true
        };
      }

      // 如果headers是字符串，尝试解析为JSON对象
      if (headers && typeof headers === 'string') {
        try {
          headers = JSON.parse(headers);
        } catch (error) {
          console.warn('Headers字符串解析失败，使用默认空对象:', error);
          headers = {};
        }
      }

      // 设置请求头
      const httpHeaders = new HttpHeaders(headers);

      let response: HttpResponse<any>;

      // 根据不同的响应类型发送请求
      if (method === 'GET') {
        if (responseType === 'json') {
          response = await firstValueFrom(
            this.http.get(url, {
              headers: httpHeaders,
              observe: 'response',
              responseType: 'json'
            }).pipe(timeout(timeoutNumber))
          );
        } else if (responseType === 'blob') {
          response = await firstValueFrom(
            this.http.get(url, {
              headers: httpHeaders,
              observe: 'response',
              responseType: 'blob'
            }).pipe(timeout(timeoutNumber))
          );
        } else if (responseType === 'arraybuffer') {
          response = await firstValueFrom(
            this.http.get(url, {
              headers: httpHeaders,
              observe: 'response',
              responseType: 'arraybuffer'
            }).pipe(timeout(timeoutNumber))
          );
        } else {
          response = await firstValueFrom(
            this.http.get(url, {
              headers: httpHeaders,
              observe: 'response',
              responseType: 'text'
            }).pipe(timeout(timeoutNumber))
          );
        }
      } else {
        // 其他HTTP方法
        if (responseType === 'json') {
          response = await firstValueFrom(
            this.http.request(method, url, {
              headers: httpHeaders,
              observe: 'response',
              responseType: 'json',
              body: body
            }).pipe(timeout(timeoutNumber))
          );
        } else if (responseType === 'blob') {
          response = await firstValueFrom(
            this.http.request(method, url, {
              headers: httpHeaders,
              observe: 'response',
              responseType: 'blob',
              body: body
            }).pipe(timeout(timeoutNumber))
          );
        } else if (responseType === 'arraybuffer') {
          response = await firstValueFrom(
            this.http.request(method, url, {
              headers: httpHeaders,
              observe: 'response',
              responseType: 'arraybuffer',
              body: body
            }).pipe(timeout(timeoutNumber))
          );
        } else {
          response = await firstValueFrom(
            this.http.request(method, url, {
              headers: httpHeaders,
              observe: 'response',
              responseType: 'text',
              body: body
            }).pipe(timeout(timeoutNumber))
          );
        }
      }

      // 检查响应大小
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > maxSizeNumber) {
        return {
          content: `文件大小 (${this.formatFileSize(parseInt(contentLength))}) 超过限制 (${this.formatFileSize(maxSizeNumber)})`,
          is_error: true
        };
      }

      // 处理响应数据
      let content: string;
      const responseBody = response.body;
      
      if (responseType === 'json') {
        content = JSON.stringify(responseBody, null, 2);
      } else if (responseType === 'blob') {
        const blob = responseBody as Blob;
        if (blob.size > maxSizeNumber) {
          return {
            content: `文件大小 (${this.formatFileSize(blob.size)}) 超过限制 (${this.formatFileSize(maxSizeNumber)})`,
            is_error: true
          };
        }
        content = await this.blobToText(blob);
      } else if (responseType === 'arraybuffer') {
        const buffer = responseBody as ArrayBuffer;
        if (buffer.byteLength > maxSizeNumber) {
          return {
            content: `文件大小 (${this.formatFileSize(buffer.byteLength)}) 超过限制 (${this.formatFileSize(maxSizeNumber)})`,
            is_error: true
          };
        }
        content = this.arrayBufferToString(buffer);
      } else {
        content = responseBody as string;
        if (content && content.length > maxSizeNumber) {
          return {
            content: `响应内容大小 (${this.formatFileSize(content.length)}) 超过限制 (${this.formatFileSize(maxSizeNumber)})`,
            is_error: true
          };
        }
      }

      // 构建响应头对象
      const responseHeaders: { [key: string]: string } = {};
      response.headers.keys().forEach(key => {
        responseHeaders[key] = response.headers.get(key) || '';
      });

      return {
        content: content || '',
        is_error: false,
        metadata: {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          size: content?.length || 0,
          contentType: response.headers.get('content-type') || undefined
        }
      };

    } catch (error: any) {
      console.warn('Fetch工具执行失败:', error);
      
      let errorMessage = '网络请求失败';
      if (error.status === 0) {
        errorMessage = '网络连接失败，请检查网络连接或CORS配置';
      } else if (error.status === 404) {
        errorMessage = '请求的资源不存在 (404)';
      } else if (error.status === 403) {
        errorMessage = '访问被拒绝 (403)';
      } else if (error.status === 500) {
        errorMessage = '服务器内部错误 (500)';
      } else if (error.name === 'TimeoutError') {
        errorMessage = '请求超时';
      } else if (error.message) {
        errorMessage = error.message;
      }

      return {
        content: errorMessage,
        is_error: true,
        metadata: error.status ? {
          status: error.status,
          statusText: error.statusText || '',
          headers: {},
          size: 0
        } : undefined
      };
    }
  }

  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return url.startsWith('http://') || url.startsWith('https://');
    } catch {
      return false;
    }
  }

  private async blobToText(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsText(blob);
    });
  }

  private arrayBufferToString(buffer: ArrayBuffer): string {
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(buffer);
  }

  private formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

export async function fetchTool(fetchService: FetchToolService, args: FetchToolArgs): Promise<FetchToolResult> {
  const toolResult = await fetchService.executeFetch(args);
  return injectTodoReminder(toolResult, 'fetchTool');
}
