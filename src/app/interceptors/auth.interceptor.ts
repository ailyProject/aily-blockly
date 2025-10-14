import { inject } from '@angular/core';
import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError, catchError, from, switchMap } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { API } from '../configs/api.config';

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
  console.log('Auth Interceptor - Adding token to request:', request.url);
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
  console.log('Auth Interceptor - Token过期，清理认证数据并要求重新登录');
  
  // 清理认证数据并登出
  authService.logout();
  
  // 返回错误，让调用方处理登录逻辑
  return throwError(() => new Error('Token已过期，请重新登录'));
}
