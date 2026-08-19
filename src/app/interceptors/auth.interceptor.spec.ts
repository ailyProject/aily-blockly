import { HttpErrorResponse, HttpRequest } from '@angular/common/http';

import { classifyAuth401, shouldLogoutFor401 } from './auth.interceptor';

describe('shouldLogoutFor401', () => {
  const request = new HttpRequest('GET', 'https://api.aily.pro/api/v1/cloud/projects');

  it('returns true for auth token errors', () => {
    const error = new HttpErrorResponse({
      status: 401,
      error: {
        status: 401,
        errorCode: 'AUTH_TOKEN_EXPIRED',
        messages: 'Token expired',
      },
    });

    expect(shouldLogoutFor401(request, error)).toBeTrue();
    expect(classifyAuth401(request, error)).toBe('refreshable');
  });

  it('treats AUTH_TOKEN_INVALID as terminal without entering refresh', () => {
    const error = new HttpErrorResponse({
      status: 401,
      error: {
        status: 401,
        errorCode: 'AUTH_TOKEN_INVALID',
        messages: 'Invalid token',
      },
    });

    expect(classifyAuth401(request, error)).toBe('terminal-token-invalid');
    expect(shouldLogoutFor401(request, error)).toBeTrue();
  });

  it('returns true for Kong token errors', () => {
    const error = new HttpErrorResponse({
      status: 401,
      error: { message: 'Invalid token signature' },
    });

    expect(shouldLogoutFor401(request, error)).toBeTrue();
  });

  it('returns false for business 401 errors', () => {
    const error = new HttpErrorResponse({
      status: 401,
      error: {
        detail: {
          errorCode: 'github_token_invalid',
          message: 'GitHub token is invalid; please reconnect GitHub',
        },
      },
    });

    expect(shouldLogoutFor401(request, error)).toBeFalse();
    expect(classifyAuth401(request, error)).toBe('business');
  });

  it('returns true for nested auth token errors', () => {
    const error = new HttpErrorResponse({
      status: 401,
      error: {
        detail: {
          errorCode: 'AUTH_TOKEN_INVALID',
          message: 'Invalid token',
        },
      },
    });

    expect(shouldLogoutFor401(request, error)).toBeTrue();
    expect(classifyAuth401(request, error)).toBe('terminal-token-invalid');
  });

  it('returns false for login requests', () => {
    const loginRequest = new HttpRequest('POST', 'https://api.aily.pro/api/v1/auth/login', null);
    const error = new HttpErrorResponse({
      status: 401,
      error: {
        status: 401,
        errorCode: 'AUTH_TOKEN_INVALID',
      },
    });

    expect(shouldLogoutFor401(loginRequest, error)).toBeFalse();
  });

  it('treats AUTH_TOKEN_INVALID from refresh as terminal', () => {
    const refreshRequest = new HttpRequest('POST', 'https://api.aily.pro/api/v1/auth/refresh', null);
    const error = new HttpErrorResponse({
      status: 401,
      error: {
        detail: {
          errorCode: 'AUTH_TOKEN_INVALID',
          message: 'Invalid refresh token',
        },
      },
    });

    expect(classifyAuth401(refreshRequest, error)).toBe('terminal-token-invalid');
    expect(shouldLogoutFor401(refreshRequest, error)).toBeTrue();
  });

  it('ignores non-terminal refresh errors', () => {
    const refreshRequest = new HttpRequest('POST', 'https://api.aily.pro/api/v1/auth/refresh', null);
    const error = new HttpErrorResponse({
      status: 401,
      error: {
        detail: {
          errorCode: 'AUTH_REFRESH_TOKEN_INVALID',
          message: 'Invalid refresh token',
        },
      },
    });

    expect(classifyAuth401(refreshRequest, error)).toBe('ignore');
    expect(shouldLogoutFor401(refreshRequest, error)).toBeFalse();
  });
});
