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

  if (authService.isSessionInvalidating) {
    return throwError(() => new Error('Authentication session invalidation is in progress'));
  }

  return from(addTokenHeader(req, authService)).pipe(
    switchMap(request => next(request)),
    catchError(error => {
      if (error instanceof HttpErrorResponse) {
        const disposition = classifyAuth401(req, error);
        if (disposition === 'terminal-token-invalid') {
          notifyMainWindowOfInvalidToken(authService);
          return throwError(() => error);
        }
        if (disposition === 'refreshable') {
          return handle401Error(req, next, authService);
        }
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

const REFRESHABLE_AUTH_401_ERROR_CODES = new Set([
  'AUTH_TOKEN_MISSING',
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

export type Auth401Disposition = 'ignore' | 'business' | 'refreshable' | 'terminal-token-invalid';

export function classifyAuth401(req: HttpRequest<any>, error: HttpErrorResponse): Auth401Disposition {
  if (
    error.status !== 401 ||
    req.url.includes('auth/login') ||
    req.url.includes('auth/logout')
  ) {
    return 'ignore';
  }

  const body = error.error;
  const errorCodes = collectAuthErrorCodes(body);
  if (errorCodes.includes('AUTH_TOKEN_INVALID')) {
    return 'terminal-token-invalid';
  }
  if (req.url.includes('auth/refresh')) {
    return 'ignore';
  }
  if (errorCodes.some(errorCode => REFRESHABLE_AUTH_401_ERROR_CODES.has(errorCode))) {
    return 'refreshable';
  }

  return collectAuthMessages(body).some(message =>
    (
      AUTH_401_MESSAGES.has(message) ||
      message.startsWith('Invalid user info:')
    )
  ) ? 'refreshable' : 'business';
}

export function shouldLogoutFor401(req: HttpRequest<any>, error: HttpErrorResponse): boolean {
  const disposition = classifyAuth401(req, error);
  return disposition === 'refreshable' || disposition === 'terminal-token-invalid';
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

function notifyMainWindowOfInvalidToken(authService: AuthService): void {
  const accepted = authService.requestSessionInvalidation('AUTH_TOKEN_INVALID', 'http-401');
  if (!accepted) {
    return;
  }

  const sendToMain = window['iWindow']?.send;
  if (typeof sendToMain !== 'function') {
    return;
  }

  // All Electron renderers report the terminal auth failure to the main
  // window. The main renderer's local Subject starts immediately; this IPC is
  // deduplicated there and also covers detached windows.
  void Promise.resolve(sendToMain({
    to: 'main',
    data: {
      action: 'auth-token-invalid',
      errorCode: 'AUTH_TOKEN_INVALID',
    },
    timeout: 30000,
  })).catch((error) => {
    console.warn('[Auth] Unable to report invalid token to main window:', error);
  });
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

      if (authService.isSessionInvalidating) {
        return throwError(() => new Error('Authentication session is invalid'));
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
