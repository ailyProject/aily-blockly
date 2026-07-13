import { extractApiErrorDetails, createApiError } from './api-error.utils';

describe('api-error utils', () => {
  it('extracts messages from a common API response body', () => {
    const details = extractApiErrorDetails({
      status: 400,
      data: null,
      messages: 'This GitHub account is already bound to another user',
      errorCode: null,
      errorArgs: {},
      errorMessage: null,
    });

    expect(details.message).toBe('This GitHub account is already bound to another user');
    expect(details.errorCode).toBeNull();
  });

  it('extracts nested detail messages and error codes', () => {
    const details = extractApiErrorDetails({
      error: {
        detail: {
          errorCode: 'github_token_invalid',
          message: 'GitHub token is invalid; please reconnect GitHub',
        },
      },
    });

    expect(details.message).toBe('GitHub token is invalid; please reconnect GitHub');
    expect(details.errorCode).toBe('github_token_invalid');
  });

  it('creates a normalized error while preserving the raw source', () => {
    const source = {
      status: 400,
      messages: 'This GitHub account is already bound to another user',
    };
    const error = createApiError(source, 'fallback');

    expect(error.message).toBe('This GitHub account is already bound to another user');
    expect(error.status).toBe(400);
    expect(error.raw).toBe(source);
  });
});
