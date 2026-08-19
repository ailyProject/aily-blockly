import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {
  fakeAsync,
  flushMicrotasks,
  TestBed,
  tick,
} from '@angular/core/testing';

import { API } from '../configs/api.config';
import { authInterceptor } from '../interceptors/auth.interceptor';
import { retryInterceptor } from '../interceptors/retry.interceptor';
import { AuthService } from './auth.service';
import { CompileValidationService } from './compile-validation.service';

describe('CompileValidationService', () => {
  const storageKey = 'aily_compile_validated_users';
  const invitedUser = {
    id: 'invited-user',
    invitation: {
      is_invited: true,
      compile_validated: false,
    },
  };

  let service: CompileValidationService;
  let http: HttpTestingController;
  let authState: 'idle' | 'checking' | 'authenticated' | 'signed_out' | 'unavailable';
  let auth: {
    isAuthenticated: boolean;
    isSessionInvalidating: boolean;
    currentUser: any;
    getAuthInitializationState: jasmine.Spy;
    initializeAuth: jasmine.Spy;
    getToken2: jasmine.Spy;
    refreshMe: jasmine.Spy;
    refreshAuthToken: jasmine.Spy;
    requestSessionInvalidation: jasmine.Spy;
    logout: jasmine.Spy;
  };

  beforeEach(() => {
    localStorage.removeItem(storageKey);
    spyOn(console, 'debug');
    spyOn(console, 'warn');

    authState = 'authenticated';
    auth = {
      isAuthenticated: true,
      isSessionInvalidating: false,
      currentUser: invitedUser,
      getAuthInitializationState: jasmine.createSpy('getAuthInitializationState')
        .and.callFake(() => authState),
      initializeAuth: jasmine.createSpy('initializeAuth').and.resolveTo(undefined),
      getToken2: jasmine.createSpy('getToken2').and.resolveTo('unit-test-token'),
      refreshMe: jasmine.createSpy('refreshMe').and.resolveTo(undefined),
      refreshAuthToken: jasmine.createSpy('refreshAuthToken').and.resolveTo(false),
      requestSessionInvalidation: jasmine.createSpy('requestSessionInvalidation').and.returnValue(false),
      logout: jasmine.createSpy('logout').and.resolveTo(undefined),
    };

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor, retryInterceptor])),
        provideHttpClientTesting(),
        CompileValidationService,
        { provide: AuthService, useValue: auth },
      ],
    });

    service = TestBed.inject(CompileValidationService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify({ ignoreCancelled: true });
    localStorage.removeItem(storageKey);
  });

  it('reports an invited user once and keeps the standard auth interceptor', fakeAsync(() => {
    service.triggerAfterSuccessfulCompile();
    flushMicrotasks();

    const request = http.expectOne(API.invitationValidateCompile);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({});
    expect(request.request.headers.get('Authorization')).toBe('Bearer unit-test-token');

    request.flush({
      status: 200,
      data: { validated: true },
    });
    flushMicrotasks();

    expect(auth.refreshMe).toHaveBeenCalledTimes(1);

    service.triggerAfterSuccessfulCompile();
    flushMicrotasks();
    http.expectNone(API.invitationValidateCompile);
  }));

  it('uses the standard auth refresh flow when the first request gets an expired token', fakeAsync(() => {
    auth.refreshAuthToken.and.callFake(async () => {
      auth.getToken2.and.resolveTo('refreshed-unit-test-token');
      return true;
    });

    service.triggerAfterSuccessfulCompile();
    flushMicrotasks();

    const firstRequest = http.expectOne(API.invitationValidateCompile);
    expect(firstRequest.request.headers.get('Authorization')).toBe('Bearer unit-test-token');
    firstRequest.flush(
      { errorCode: 'AUTH_TOKEN_EXPIRED' },
      { status: 401, statusText: 'Unauthorized' },
    );
    flushMicrotasks();

    expect(auth.refreshAuthToken).toHaveBeenCalledTimes(1);
    const retriedRequest = http.expectOne(API.invitationValidateCompile);
    expect(retriedRequest.request.headers.get('Authorization')).toBe('Bearer refreshed-unit-test-token');
    retriedRequest.flush({ status: 200, data: { validated: true } });
    flushMicrotasks();
  }));

  it('waits for an in-progress auth initialization before reporting', fakeAsync(() => {
    let completeInitialization!: () => void;
    auth.isAuthenticated = false;
    auth.currentUser = null;
    authState = 'checking';
    auth.initializeAuth.and.callFake(() => new Promise<void>((resolve) => {
      completeInitialization = () => {
        auth.isAuthenticated = true;
        auth.currentUser = invitedUser;
        authState = 'authenticated';
        resolve();
      };
    }));

    service.triggerAfterSuccessfulCompile();
    flushMicrotasks();

    expect(auth.initializeAuth).toHaveBeenCalledTimes(1);
    http.expectNone(API.invitationValidateCompile);

    completeInitialization();
    flushMicrotasks();

    const request = http.expectOne(API.invitationValidateCompile);
    request.flush({ status: 200, data: { validated: true } });
    flushMicrotasks();
  }));

  it('does not attribute a compile after the stored session changes during auth initialization', fakeAsync(() => {
    let completeInitialization!: () => void;
    auth.isAuthenticated = false;
    auth.currentUser = null;
    authState = 'checking';
    auth.getToken2.and.returnValues(
      Promise.resolve('compile-session-token'),
      Promise.resolve('different-session-token'),
    );
    auth.initializeAuth.and.callFake(() => new Promise<void>((resolve) => {
      completeInitialization = () => {
        auth.isAuthenticated = true;
        auth.currentUser = invitedUser;
        authState = 'authenticated';
        resolve();
      };
    }));

    service.triggerAfterSuccessfulCompile();
    flushMicrotasks();
    completeInitialization();
    flushMicrotasks();

    expect(auth.getToken2).toHaveBeenCalledTimes(2);
    http.expectNone(API.invitationValidateCompile);
  }));

  it('refreshes a missing invitation snapshot once before reporting', fakeAsync(() => {
    auth.currentUser = { id: invitedUser.id };
    auth.refreshMe.and.callFake(async () => {
      auth.currentUser = invitedUser;
    });

    service.triggerAfterSuccessfulCompile();
    flushMicrotasks();

    expect(auth.refreshMe).toHaveBeenCalledTimes(1);
    const request = http.expectOne(API.invitationValidateCompile);
    request.flush({ status: 200, data: { validated: true } });
    flushMicrotasks();
  }));

  it('does not refresh the same complete snapshot on every compile when invitation stays absent', fakeAsync(() => {
    auth.currentUser = { id: 'ordinary-user-without-invitation' };

    service.triggerAfterSuccessfulCompile();
    flushMicrotasks();

    expect(auth.refreshMe).toHaveBeenCalledTimes(1);
    http.expectNone(API.invitationValidateCompile);

    service.triggerAfterSuccessfulCompile();
    flushMicrotasks();

    expect(auth.refreshMe).toHaveBeenCalledTimes(1);
    http.expectNone(API.invitationValidateCompile);
  }));

  it('does not refresh or report a user explicitly marked as not invited', fakeAsync(() => {
    auth.currentUser = {
      id: 'ordinary-user',
      invitation: { is_invited: false },
    };

    service.triggerAfterSuccessfulCompile();
    flushMicrotasks();

    expect(auth.refreshMe).not.toHaveBeenCalled();
    http.expectNone(API.invitationValidateCompile);
  }));

  it('does not let a later login claim an anonymous compile', fakeAsync(() => {
    auth.isAuthenticated = false;
    auth.currentUser = null;
    authState = 'checking';
    auth.getToken2.and.resolveTo(null);

    service.triggerAfterSuccessfulCompile();
    flushMicrotasks();

    expect(auth.initializeAuth).not.toHaveBeenCalled();
    http.expectNone(API.invitationValidateCompile);
  }));

  it('clears the in-flight guard after timeout so a later compile can retry', fakeAsync(() => {
    service.triggerAfterSuccessfulCompile();
    flushMicrotasks();

    const firstRequest = http.expectOne(API.invitationValidateCompile);
    tick(20_001);
    flushMicrotasks();

    expect(firstRequest.cancelled).toBeTrue();
    expect(console.warn).toHaveBeenCalledWith(
      '[CompileValidation] 编译验证后台上报失败:',
      jasmine.objectContaining({ reason: 'timeout' }),
    );

    service.triggerAfterSuccessfulCompile();
    flushMicrotasks();

    const secondRequest = http.expectOne(API.invitationValidateCompile);
    secondRequest.flush({
      status: 200,
      data: { validated: false, message: '已验证过' },
    });
    flushMicrotasks();

    service.triggerAfterSuccessfulCompile();
    flushMicrotasks();
    http.expectNone(API.invitationValidateCompile);
  }));
});
