import zhCN from '../../../public/i18n/zh_cn/zh_cn.json';
import { getLibrarySubmissionErrorMessage } from './library-submission-error.utils';

describe('library submission error messages', () => {
  const translate = {
    instant: (key: string) => key.split('.').reduce((value: any, part) => value?.[part], zhCN) || key,
  };

  it('includes the readable reason, backend error code and GitHub request ID', () => {
    expect(getLibrarySubmissionErrorMessage({
      message: 'GitHub 请求失败，请稍后重试',
      errorCode: 'GITHUB_REQUEST_FAILED',
      errorArgs: { githubRequestId: '  ABCD:1234  ' },
      status: 502,
    }, translate)).toBe('GitHub 请求失败，请稍后重试 (GITHUB_REQUEST_FAILED; GitHub Request ID: ABCD:1234)');
  });

  it('replaces transport messages with the network fallback', () => {
    expect(getLibrarySubmissionErrorMessage({
      message: 'Http failure response for /api/library: 0 Unknown Error',
      status: 0,
    }, translate)).toBe(zhCN.LIBRARY_PUBLISH.NETWORK_ERROR);
  });

  it('replaces proxy HTML with the service fallback and HTTP status', () => {
    expect(getLibrarySubmissionErrorMessage({
      error: '<!DOCTYPE html><html><body>Bad Gateway</body></html>',
      status: 502,
    }, translate)).toBe(`${zhCN.LIBRARY_PUBLISH.SERVICE_ERROR} (HTTP 502)`);
  });

  it('uses the unknown-error fallback for unrecognized objects', () => {
    expect(getLibrarySubmissionErrorMessage({ unexpected: { value: true } }, translate))
      .toBe(zhCN.LIBRARY_PUBLISH.UNKNOWN_ERROR);
  });
});
