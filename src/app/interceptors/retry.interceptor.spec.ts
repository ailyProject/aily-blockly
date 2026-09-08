import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { API, getServerUrl } from '../configs/api.config';
import { retryInterceptor } from './retry.interceptor';

describe('retryInterceptor for library publishing', () => {
  let http: HttpClient;
  let httpTesting: HttpTestingController;
  let fetchSpy: jasmine.Spy;
  const payload = { package: { packageJson: { name: '@aily-project/lib-test', version: '1.0.0' } } };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([retryInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    httpTesting = TestBed.inject(HttpTestingController);
    fetchSpy = spyOn(window, 'fetch');
  });

  afterEach(() => {
    httpTesting.verify();
  });

  it('reposts the same submission once after a network error and a successful health check', fakeAsync(() => {
    fetchSpy.and.resolveTo({ status: 200 } as Response);
    const next = jasmine.createSpy('next');
    const error = jasmine.createSpy('error');
    http.post(API.librarySubmissions, payload).subscribe({ next, error });

    httpTesting.expectOne(API.librarySubmissions).error(new ProgressEvent('error'));
    tick(499);
    expect(fetchSpy).not.toHaveBeenCalled();
    httpTesting.expectNone(API.librarySubmissions);

    tick(1);
    expect(fetchSpy).toHaveBeenCalledOnceWith(`${getServerUrl()}/health`, jasmine.objectContaining({ method: 'GET' }));
    const retry = httpTesting.expectOne(API.librarySubmissions);
    expect(retry.request.method).toBe('POST');
    expect(retry.request.body).toEqual(payload);
    const response = { status: 200, data: { id: 17, status: 'processing' } };
    retry.flush(response);
    tick(3500);

    expect(next).toHaveBeenCalledOnceWith(response);
    expect(error).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    httpTesting.expectNone(API.librarySubmissions);
  }));

  it('reports a second 502 without entering another health check or repost loop', fakeAsync(() => {
    fetchSpy.and.resolveTo({ status: 200 } as Response);
    const error = jasmine.createSpy('error');
    http.post(API.librarySubmissions, payload).subscribe({ error });
    httpTesting.expectOne(API.librarySubmissions).flush('first failure', { status: 502, statusText: 'Bad Gateway' });

    tick(500);
    const retry = httpTesting.expectOne(API.librarySubmissions);
    expect(retry.request.method).toBe('POST');
    expect(retry.request.body).toEqual(payload);
    const failure = { detail: { message: 'GitHub 暂时不可用', github_request_id: 'GH-502' } };
    retry.flush(failure, { status: 502, statusText: 'Bad Gateway' });
    tick(10000);

    expect(error).toHaveBeenCalledOnceWith(jasmine.objectContaining({ status: 502, error: failure }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    httpTesting.expectNone(API.librarySubmissions);
  }));

  for (const status of [400, 409]) {
    it(`does not retry a business HTTP ${status} or replace its details`, fakeAsync(() => {
      const error = jasmine.createSpy('error');
      http.post(API.librarySubmissions, payload).subscribe({ error });
      const failure = { detail: { errorCode: 'library_submission_failed', message: '提交内容不符合要求' } };
      httpTesting.expectOne(API.librarySubmissions).flush(failure, { status, statusText: 'Business Error' });
      tick(10000);

      expect(error).toHaveBeenCalledTimes(1);
      const result: HttpErrorResponse = error.calls.mostRecent().args[0];
      expect(result.status).toBe(status);
      expect(result.error).toBe(failure);
      expect(fetchSpy).not.toHaveBeenCalled();
      httpTesting.expectNone(API.librarySubmissions);
    }));
  }

  it('keeps the original HTTP error after all three health checks fail without reposting', fakeAsync(() => {
    let healthAttempts = 0;
    fetchSpy.and.callFake(() => ++healthAttempts === 2
      ? Promise.reject(new TypeError('Failed to fetch'))
      : Promise.resolve({ status: 503 } as Response));
    const error = jasmine.createSpy('error');
    http.post(API.librarySubmissions, payload).subscribe({ error });
    const failure = { detail: { message: '发布服务不可用', github_request_id: 'GH-ORIGINAL' } };
    httpTesting.expectOne(API.librarySubmissions).flush(failure, { status: 502, statusText: 'Bad Gateway' });

    tick(500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    httpTesting.expectNone(API.librarySubmissions);
    tick(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
    httpTesting.expectNone(API.librarySubmissions);
    tick(2000);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(1);
    const result: HttpErrorResponse = error.calls.mostRecent().args[0];
    expect(result.status).toBe(502);
    expect(result.error).toBe(failure);
    expect(result.url).toBe(API.librarySubmissions);
    httpTesting.expectNone(API.librarySubmissions);
    tick(10000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  }));
});
