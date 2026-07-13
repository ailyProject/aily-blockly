import { HttpErrorResponse, HttpRequest } from '@angular/common/http';

import { shouldLogoutFor401 } from './auth.interceptor';

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

  it('returns false for refresh requests', () => {
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

    expect(shouldLogoutFor401(refreshRequest, error)).toBeFalse();
  });
});
