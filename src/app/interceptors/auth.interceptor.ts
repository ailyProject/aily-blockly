import { inject } from '@angular/core';
import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError, catchError, from, switchMap, shareReplay, finalize } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { API } from '../configs/api.config';

let refreshAuthToken$: Observable<boolean> | null = null;

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
      if (error instanceof HttpErrorResponse && shouldLogoutFor401(req, error)) {
        return handle401Error(req, next, authService);
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

const AUTH_401_ERROR_CODES = new Set([
  'AUTH_TOKEN_MISSING',
  'AUTH_TOKEN_INVALID',
  'AUTH_TOKEN_EXPIRED',
  'AUTH_USER_NOT_FOUND',
]);

const AUTH_401_MESSAGES = new Set([
  'Missing authorization header',
  'Invalid authorization header format',
  'Invalid token format',
  'Invalid token signature',
  'Invalid token payload',
  'Invalid token payload JSON',
  'Token expired',
  'Not authenticated',
  'Invalid token',
  'User not found',
  'Could not validate credentials',
  'User info not found',
]);

export function shouldLogoutFor401(req: HttpRequest<any>, error: HttpErrorResponse): boolean {
  if (
    error.status !== 401 ||
    req.url.includes('auth/login') ||
    req.url.includes('auth/logout') ||
    req.url.includes('auth/refresh')
  ) {
    return false;
  }

  const body = error.error;
  if (collectAuthErrorCodes(body).some(errorCode => AUTH_401_ERROR_CODES.has(errorCode))) {
    return true;
  }

  return collectAuthMessages(body).some(message =>
    (
      AUTH_401_MESSAGES.has(message) ||
      message.startsWith('Invalid user info:')
    )
  );
}

function collectAuthErrorCodes(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(item => collectAuthErrorCodes(item));
  }

  const record = value as Record<string, unknown>;
  const current = typeof record['errorCode'] === 'string' ? [record['errorCode']] : [];
  return current.concat(collectAuthErrorCodes(record['detail']));
}

function collectAuthMessages(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(item => collectAuthMessages(item));
  }

  const record = value as Record<string, unknown>;
  return [
    record['message'],
    record['messages'],
    record['detail'],
    record['errorMessage'],
  ].flatMap(item => collectAuthMessages(item));
}

function getRefreshAuthToken$(authService: AuthService): Observable<boolean> {
  if (refreshAuthToken$) {
    return refreshAuthToken$;
  }

  refreshAuthToken$ = from(authService.refreshAuthToken()).pipe(
    shareReplay({ bufferSize: 1, refCount: false }),
    finalize(() => {
      refreshAuthToken$ = null;
    })
  );

  return refreshAuthToken$;
}

function handle401Error(req: HttpRequest<any>, next: HttpHandlerFn, authService: AuthService): Observable<HttpEvent<any>> {
  return getRefreshAuthToken$(authService).pipe(
    switchMap(refreshed => {
      if (refreshed) {
        return from(addTokenHeader(req, authService)).pipe(
          switchMap(request => next(request))
        );
      }

      return from(authService.logout()).pipe(
        switchMap(() => throwError(() => new Error('Token已过期，请重新登录')))
      );
    }),
    catchError((error) => {
      // 即使logout失败，也要返回错误
      return throwError(() => error);
    })
  );
}
