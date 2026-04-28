import { inject } from '@angular/core';
import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError, catchError, from, switchMap, shareReplay, finalize } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { API } from '../configs/api.config';

// 用于跟踪401错误处理状态的变量
let isHandling401 = false;
let handle401Error$: Observable<HttpEvent<any>> | null = null;

function shouldInterceptRequest(url: string): boolean {
  // 获取API配置中的所有URL
  const apiUrls = Object.values(API);
  
  // 检查请求URL是否匹配任何配置的API地址
  return apiUrls.some(apiUrl => url.startsWith(apiUrl));
}

export const authInterceptor: HttpInterceptorFn = (req: HttpRequest<any>, next: HttpHandlerFn): Observable<HttpEvent<any>> => {
  const authService = inject(AuthService);

  // 检查是否需要拦截此请求
  if (!shouldInterceptRequest(req.url)) {
    return next(req);
  }

  return from(addTokenHeader(req, authService)).pipe(
    switchMap(request => next(request)),
    catchError(error => {
      if (error instanceof HttpErrorResponse && !req.url.includes('auth/login') && error.status === 401) {
        return handle401Error(authService);
      }
      return throwError(() => error);
    })
  );
};

async function addTokenHeader(request: HttpRequest<any>, authService: AuthService, token?: string | null): Promise<HttpRequest<any>> {
  // console.log('Auth Interceptor - Adding token to request:', request.url);
  if (!token) {
    token = await authService.getToken2();
  }

  if (token) {
    return request.clone({
      setHeaders: {
        Authorization: `Bearer ${token}`
      }
    });
  }

  return request;
}

function handle401Error(authService: AuthService): Observable<HttpEvent<any>> {
  // 如果正在处理401错误，返回共享的Observable
  if (isHandling401 && handle401Error$) {
    return handle401Error$;
  }

  // 标记开始处理401错误
  isHandling401 = true;

  // 创建处理401错误的Observable，使用shareReplay确保多个订阅者共享同一个执行
  handle401Error$ = from(authService.logout()).pipe(
    switchMap(() => {
      // 返回错误，让调用方处理登录逻辑
      return throwError(() => new Error('Token已过期，请重新登录'));
    }),
    catchError((error) => {
      // 即使logout失败，也要返回错误
      return throwError(() => error);
    }),
    // 使用shareReplay确保多个订阅者共享同一个执行，并且缓存错误结果
    shareReplay({ bufferSize: 1, refCount: false }),
    // 使用finalize确保在处理完成后清理状态
    finalize(() => {
      // 延迟清理状态，确保所有订阅者都能收到错误
      setTimeout(() => {
        isHandling401 = false;
        handle401Error$ = null;
      }, 100);
    })
  );

  return handle401Error$;
}
