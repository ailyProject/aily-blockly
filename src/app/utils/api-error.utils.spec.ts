import { createApiError, extractApiErrorDetails, resolveTranslatedApiErrorMessage } from './api-error.utils';

describe('API error messages', () => {
  it('extracts strings and Error instances', () => {
    expect(extractApiErrorDetails('  提交失败  ').message).toBe('提交失败');
    expect(extractApiErrorDetails(new Error('本地文件读取失败')).message).toBe('本地文件读取失败');
  });

  it('prefers the HTTP response body over the transport message', () => {
    expect(extractApiErrorDetails({
      error: '当前版本已经存在',
      message: 'Http failure response for /api/library: 409 Conflict',
    }).message).toBe('当前版本已经存在');
    expect(extractApiErrorDetails({ error: {}, message: '网络连接失败' }).message).toBe('网络连接失败');
  });

  it('reads nested messages and keeps backend error codes and arguments', () => {
    expect(extractApiErrorDetails({
      error: {
        detail: {
          error_code: 'LIBRARY_VERSION_EXISTS',
          error_args: { version: '1.0.0' },
          message: { message: '当前版本已经存在' },
        },
      },
    })).toEqual({
      errorCode: 'LIBRARY_VERSION_EXISTS',
      errorArgs: { version: '1.0.0' },
      message: '当前版本已经存在',
    });
  });

  it('skips empty and unusable preferred message fields', () => {
    expect(extractApiErrorDetails({
      errorMessage: '  ',
      messages: { unsupported: '内部内容' },
      message: { message: '[object Object]', detail: '库名格式不正确' },
    }).message).toBe('库名格式不正确');
  });

  it('formats FastAPI validation details with field locations', () => {
    expect(extractApiErrorDetails({
      error: {
        detail: [
          { loc: ['body', 'name'], msg: 'Field required', type: 'missing' },
          { loc: ['body', 'keywords', 0], msg: 'Input should be a valid string', type: 'string_type' },
        ],
      },
    }).message).toBe('body.name: Field required, body.keywords.0: Input should be a valid string');
  });

  it('uses the fallback for unknown objects and meaningless text', () => {
    for (const source of [null, {}, { detail: { unsupported: true } }, '[object Object]']) {
      expect(extractApiErrorDetails(source, '发布失败，请重试').message).toBe('发布失败，请重试');
    }
    const circular: Record<string, unknown> = {};
    circular['message'] = circular;
    expect(extractApiErrorDetails(circular, '发布失败，请重试').message).toBe('发布失败，请重试');
  });

  it('preserves normalized errors, HTTP status and the raw source', () => {
    const source = {
      errorCode: 'LIBRARY_VERSION_EXISTS',
      errorArgs: { version: '1.0.0' },
      message: '当前版本已经存在',
      status: 409,
    };
    const result = createApiError(source);
    expect(result).toEqual({ ...source, raw: source });
    expect(result.raw).toBe(source);
  });

  it('uses AUTH_ERRORS translations and falls back when a translation is missing', () => {
    const source = { errorCode: 'TOKEN_EXPIRED', errorArgs: { minutes: 10 }, message: '登录已过期' };
    const translate = { instant: jasmine.createSpy('instant').and.returnValue('请重新登录') };
    expect(resolveTranslatedApiErrorMessage(source, translate)).toBe('请重新登录');
    expect(translate.instant).toHaveBeenCalledWith('AUTH_ERRORS.TOKEN_EXPIRED', { minutes: 10 });

    translate.instant.and.returnValue('AUTH_ERRORS.TOKEN_EXPIRED');
    expect(resolveTranslatedApiErrorMessage(source, translate)).toBe('登录已过期');
  });
});
