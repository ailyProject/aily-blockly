import { AuthService, normalizeAuthCreditSnapshot, normalizeCreditLedgerSnapshot, normalizeAuthQuotaInfoSnapshotPayload,
  resolveAuthQuotaInfoSnapshotOverride, type AuthSnapshot } from '@core/auth/public-api';
import { buildChildAuthStateSnapshot } from '../child-tool-host/child-auth-state';
import { formatCreditQuota, isProCreditPlan } from './credit-display';
import { ApplicationRef } from '@angular/core';
import { TestBed, ComponentFixture, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { API, getServerUrl, setServerUrl } from '../../configs/api.config';
import { authInterceptor } from '../../interceptors/auth.interceptor';
import { BehaviorSubject, of } from 'rxjs';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ElectronService } from '@core/platform/public-api';
import { UiService } from '@core/app-shell/public-api';
import { ToolI18nService } from '@core/preferences/public-api';
import { ChildAppSafetyService } from '@integration/subapps/public-api';
import { UserCenterComponent } from './user-center.component';

const payload = {
  unit: 'credits',
  available_micros: 29_993_290,
  reserved_micros: 0,
  included_granted_micros: 30_000_000,
  subscription_plan: 'free',
  next_reset_at: '2026-09-15T00:00:00Z',
};

// Public /api/v1/credits/me response, rather than the legacy quota-info route.
const ledgerPayload = {
  balance_micros: 29_993_290,
  reserved_micros: 0,
  overage_enabled: false,
  overage_limit_micros: 0,
  overage_used_micros: 0,
  spending_cap_micros: 0,
  grace_per_call_micros: 0,
  uncovered_micros: 0,
  available_micros: 29_993_290,
  included_granted_micros: 30_000_000,
  included_remaining_micros: 29_993_290,
  included_used_micros: 6_710,
  included_percent_used: 0.022366666666666666,
  next_reset_at: payload.next_reset_at,
  subscription_plan: 'free',
};

describe('Credit quota contract', () => {
  it('preserves integer micros and the server reset time', () => {
    const snapshot = normalizeAuthQuotaInfoSnapshotPayload(payload, { source: 'token' });
    expect(snapshot?.source).toBe('token');
    expect(snapshot?.creditSnapshot?.available_micros).toBe(29_993_290);
    expect(snapshot?.creditSnapshot?.next_reset_at).toBe(payload.next_reset_at);
    expect(snapshot?.quotaSnapshots).toBeUndefined();
  });

  it('accepts the public ledger response without a synthetic unit field', () => {
    const snapshot = normalizeAuthQuotaInfoSnapshotPayload(ledgerPayload, { source: 'token' });
    expect(snapshot?.creditSnapshot).toEqual(normalizeAuthCreditSnapshot(payload));
    expect(snapshot?.quotaSnapshots).toBeUndefined();
  });

  it('allows absent optional ledger fields without inventing values', () => {
    expect(normalizeCreditLedgerSnapshot({ available_micros: 1, reserved_micros: 0 })).toEqual({
      available_micros: 1, reserved_micros: 0,
      included_granted_micros: null, next_reset_at: null, subscription_plan: null,
    });
  });

  it('rejects an explicit non-Credit unit even when micros are present', () => {
    expect(normalizeAuthCreditSnapshot({ ...ledgerPayload, unit: 'interactions' })).toBeUndefined();
  });

  for (const response of [ledgerPayload, { status: 200, data: ledgerPayload }]) {
    it('loads Credit balances from the ledger route with the current credential', async () => {
      const service = Object.create(AuthService.prototype) as any;
      service.http = { get: jasmine.createSpy().and.returnValue(of(response)) };
      service.authQuotaRequestTimeoutMs = 8000;
      const snapshot = await service.getAuthQuotaInfoSnapshot('test-current-account-token');
      expect(service.http.get).toHaveBeenCalledOnceWith(API.creditSnapshot, {
        headers: { Authorization: 'Bearer test-current-account-token' },
      });
      expect(API.creditSnapshot).toMatch(/\/api\/v1\/credits\/me$/);
      expect(snapshot).toEqual({ source: 'token', creditSnapshot: normalizeAuthCreditSnapshot(payload) });
    });
  }

  it('rejects legacy counters returned from the ledger route', async () => {
    const service = Object.create(AuthService.prototype) as any;
    service.http = { get: () => of({ status: 200, data: {
      quota_snapshots: { premium_interactions: { entitlement: 30, remaining: 22, percent_remaining: 73.33 } },
    } }) };
    service.authQuotaRequestTimeoutMs = 8000;
    await expectAsync(service.getAuthQuotaInfoSnapshot('test-current-account-token'))
      .toBeRejectedWithError(/Invalid Credit snapshot from \/api\/v1\/credits\/me/);
  });

  it('does not relabel an old count snapshot as Credits', () => {
    expect(normalizeAuthCreditSnapshot({
      quota_snapshots: { premium_interactions: { entitlement: 30, remaining: 22, percent_remaining: 73.33 } },
    })).toBeUndefined();
  });

  it('accepts the unwrapped ledger response only through its explicit endpoint adapter', () => {
    expect(normalizeCreditLedgerSnapshot(ledgerPayload)).toEqual(normalizeAuthCreditSnapshot(payload));
    expect(normalizeAuthCreditSnapshot(ledgerPayload)).toBeUndefined();
    expect(normalizeCreditLedgerSnapshot({ status: 200, data: ledgerPayload })).toBeUndefined();
    expect(normalizeCreditLedgerSnapshot({ ...ledgerPayload, unit: 'interactions' })).toBeUndefined();
    expect(normalizeCreditLedgerSnapshot({ quota_snapshots: {} })).toBeUndefined();
  });

  it('allows omitted nullable schema fields but still requires both ledger amounts', () => {
    expect(normalizeCreditLedgerSnapshot({ available_micros: 0, reserved_micros: 0 })).toEqual({
      available_micros: 0, reserved_micros: 0,
      included_granted_micros: null, subscription_plan: null, next_reset_at: null,
    });
    expect(normalizeCreditLedgerSnapshot({ available_micros: 0 })).toBeUndefined();
  });

  for (const [field, value] of [
    ['available_micros', -1], ['available_micros', 1.5], ['available_micros', NaN],
    ['available_micros', '29993290'], ['available_micros', Number.MAX_SAFE_INTEGER + 1],
    ['reserved_micros', undefined], ['included_granted_micros', '30'],
    ['next_reset_at', 'invalid'], ['subscription_plan', {}],
  ]) {
    it(`rejects invalid ${field}: ${String(value)}`, () => {
      expect(normalizeAuthCreditSnapshot({ ...payload, [field as string]: value })).toBeUndefined();
      expect(normalizeCreditLedgerSnapshot({ ...ledgerPayload, [field as string]: value })).toBeUndefined();
    });
  }

  it('never falls back to legacy fields in an invalid Credit response', () => {
    expect(normalizeAuthQuotaInfoSnapshotPayload({
      ...payload, available_micros: 'bad',
      quota_snapshots: { premium_interactions: { entitlement: 30, remaining: 22, percent_remaining: 73.33 } },
    })).toBeUndefined();
  });

  it('never falls back to legacy fields in an invalid unmarked ledger response', () => {
    expect(normalizeAuthQuotaInfoSnapshotPayload({
      ...ledgerPayload, available_micros: 'bad',
      quota_snapshots: { premium_interactions: { entitlement: 30, remaining: 22, percent_remaining: 73.33 } },
    })).toBeUndefined();
  });

  it('shows the Free balance with micros precision', () => {
    expect(formatCreditQuota(normalizeAuthCreditSnapshot(payload)!, 'en-US')).toBe('29.99329/30 Credit');
    expect(formatCreditQuota(normalizeAuthCreditSnapshot({ ...payload, available_micros: 1 })!, 'en-US'))
      .toBe('0.000001/30 Credit');
    expect(formatCreditQuota(normalizeAuthCreditSnapshot({ ...payload, available_micros: 0 })!, 'en-US'))
      .toBe('0/30 Credit');
  });

  it('uses available balance without subtracting the hold a second time', () => {
    expect(formatCreditQuota(normalizeAuthCreditSnapshot({ ...payload, reserved_micros: 1_000_000 })!, 'en-US'))
      .toBe('29.99329/30 Credit');
  });

  it('shows Pro infinity only as a display policy', () => {
    const snapshot = normalizeAuthCreditSnapshot({ ...payload, subscription_plan: 'pro', included_granted_micros: 300_000_000 })!;
    expect(formatCreditQuota(snapshot, 'en-US')).toBe('\u267e\ufe0f');
    expect(snapshot.available_micros).toBe(29_993_290);
    expect(snapshot.included_granted_micros).toBe(300_000_000);
  });

  it('recognizes subscription plans, not names that happen to contain pro', () => {
    expect(isProCreditPlan('pro_plus')).toBeTrue();
    expect(isProCreditPlan('PRO')).toBeTrue();
    expect(isProCreditPlan('free')).toBeFalse();
    expect(isProCreditPlan('prototype')).toBeFalse();
    expect(isProCreditPlan(null)).toBeFalse();
  });

  it('shows no fabricated quota when a snapshot is unavailable', () => {
    expect(formatCreditQuota(null, 'en-US')).toBe('--');
    expect(formatCreditQuota(null, 'en-US', 'free')).toBe('--');
  });

  it('shows confirmed Pro membership without requiring a Credit balance', () => {
    expect(formatCreditQuota(null, 'en-US', 'pro')).toBe('\u267e\ufe0f');
    expect(formatCreditQuota(null, 'en-US', 'pro_plus')).toBe('\u267e\ufe0f');
  });

  it('prefers the current ledger plan over a stale profile plan', () => {
    expect(formatCreditQuota(normalizeAuthCreditSnapshot(payload)!, 'en-US', 'pro'))
      .toBe('29.99329/30 Credit');
  });

  it('does not invent a denominator or reset time for a missing included bucket', () => {
    const snapshot = normalizeAuthCreditSnapshot({ ...payload, included_granted_micros: null, next_reset_at: null })!;
    expect(formatCreditQuota(snapshot, 'en-US')).toBe('29.99329 Credit');
    expect(snapshot.next_reset_at).toBeNull();
  });

  it('keeps the last same-account snapshot on a failed refresh, never across logout or accounts', () => {
    const snapshot = normalizeAuthQuotaInfoSnapshotPayload(payload)!;
    expect(resolveAuthQuotaInfoSnapshotOverride(snapshot, null, { id: 'a' }, { id: 'a' })).toBe(snapshot);
    expect(resolveAuthQuotaInfoSnapshotOverride(snapshot, null, { id: 'b' }, { id: 'a' })).toBeNull();
    expect(resolveAuthQuotaInfoSnapshotOverride(snapshot, undefined, { id: 'b' }, { id: 'a' })).toBeNull();
    expect(resolveAuthQuotaInfoSnapshotOverride(snapshot, undefined, null, { id: 'a' })).toBeNull();
  });

  it('does not broadcast stale count quotas to Lex once a Credit snapshot is loaded', () => {
    const child = buildChildAuthStateSnapshot(true, { id: 'a' }, {
      quotaInfoSnapshot: normalizeAuthQuotaInfoSnapshotPayload(payload),
      quotaSummary: { totalToken: 30, usedToken: 8, remainingToken: 22 },
    });
    expect(child.authenticated).toBeTrue();
    expect(child.user?.id).toBe('a');
    expect(child.quotaSnapshot).toBeUndefined();
  });
});

describe('Auth Credit HTTP contract and refresh lifecycle', () => {
  let service: AuthService;
  let http: HttpTestingController;
  let warnings: jasmine.Spy;
  let previousServer: string;
  const user = { id: 'account-a', quota: { total_token: 30, used_token: 8, remaining_token: 22 } };

  beforeEach(fakeAsync(() => {
    previousServer = getServerUrl();
    setServerUrl('https://auth-contract.example');
    TestBed.configureTestingModule({ providers: [
      provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting(),
      { provide: ElectronService, useValue: { isElectron: false } },
    ] });
    spyOn(TestBed.inject(ApplicationRef), 'tick').and.stub();
    service = TestBed.inject(AuthService);
    spyOn(service, 'getToken2').and.resolveTo('test-token');
    warnings = spyOn(console, 'warn');
    http = TestBed.inject(HttpTestingController);
    tick();
  }));

  afterEach(() => {
    http.verify();
    setServerUrl(previousServer);
  });

  function beginRefresh(profile = user) {
    const operation = service.refreshCurrentUser();
    flushMicrotasks();
    const me = http.expectOne(API.me);
    expect(me.request.headers.get('Authorization')).toBe('Bearer test-token');
    me.flush({ status: 200, data: profile });
    flushMicrotasks();
    return operation;
  }

  it('uses /credits/me directly even when /auth/me still contains legacy counts', fakeAsync(() => {
    beginRefresh();
    const credits = http.expectOne('https://auth-contract.example/api/v1/credits/me');
    expect(credits.request.headers.get('Authorization')).toBe('Bearer test-token');
    credits.flush(ledgerPayload);
    flushMicrotasks();
    expect(service.currentUser?.id).toBe('account-a');
    expect(service.getAuthSnapshot()?.quotaInfoSnapshot?.creditSnapshot)
      .toEqual(normalizeCreditLedgerSnapshot(ledgerPayload));
    tick(20000);
    http.expectNone(request => request.url.endsWith('/quota-info'));
    expect(warnings).not.toHaveBeenCalled();
  }));

  it('accepts a gateway success envelope without scheduling a retry', fakeAsync(() => {
    beginRefresh();
    http.expectOne(API.creditSnapshot).flush({ status: 200, data: ledgerPayload });
    flushMicrotasks();
    expect(service.getAuthSnapshot()?.quotaInfoSnapshot?.creditSnapshot)
      .toEqual(normalizeCreditLedgerSnapshot(ledgerPayload));
    tick(20000);
    http.expectNone(API.creditSnapshot);
    expect(warnings).not.toHaveBeenCalled();
  }));

  for (const endpoint of ['profile', 'credit']) {
    it(`allows the real auth interceptor to refresh an expired token during ${endpoint} loading`, fakeAsync(() => {
      const storedToken = localStorage.getItem('aily_auth_token');
      const storedRefresh = localStorage.getItem('aily_refresh_token');
      try {
        spyOn(service, 'refreshAuthToken').and.callFake(async () => {
          await service.saveToken2('rotated-token', 'rotated-refresh', 'test-refresh');
          (service.getToken2 as jasmine.Spy).and.resolveTo('rotated-token');
          return true;
        });
        localStorage.setItem('aily_refresh_token', 'test-refresh');
        if (endpoint === 'profile') {
          void service.refreshCurrentUser();
          flushMicrotasks();
          http.expectOne(API.me).flush({ errorCode: 'AUTH_TOKEN_EXPIRED' }, { status: 401, statusText: 'Expired' });
          flushMicrotasks();
          http.expectOne(API.me).flush({ status: 200, data: user });
          flushMicrotasks();
        } else {
          beginRefresh();
          http.expectOne(API.creditSnapshot).flush({ errorCode: 'AUTH_TOKEN_EXPIRED' }, { status: 401, statusText: 'Expired' });
          flushMicrotasks();
        }
        const credits = http.expectOne(API.creditSnapshot);
        expect(credits.request.headers.get('Authorization')).toBe('Bearer rotated-token');
        credits.flush(ledgerPayload);
        flushMicrotasks();
        expect(service.getAuthSnapshot()?.quotaInfoSnapshot?.creditSnapshot?.available_micros).toBe(29_993_290);
        expect(service.refreshAuthToken).toHaveBeenCalledTimes(1);
        tick(20000);
      } finally {
        if (storedToken === null) localStorage.removeItem('aily_auth_token');
        else localStorage.setItem('aily_auth_token', storedToken);
        if (storedRefresh === null) localStorage.removeItem('aily_refresh_token');
        else localStorage.setItem('aily_refresh_token', storedRefresh);
      }
    }));
  }

  for (const invalid of [
    { quota_snapshots: { premium_interactions: { remaining: 22 } } },
    { status: 500, data: ledgerPayload },
    { status: 200, data: { ...ledgerPayload, available_micros: '30' } },
    { ...ledgerPayload, available_micros: '30' },
  ]) {
    it('keeps the user signed in and never retries an invalid Credit contract', fakeAsync(() => {
      void service.initializeAuth();
      flushMicrotasks();
      http.expectOne(API.me).flush({ status: 200, data: user });
      flushMicrotasks();
      http.expectOne(API.creditSnapshot).flush(invalid);
      flushMicrotasks();
      expect(service.getAuthInitializationState()).toBe('authenticated');
      expect(service.getAuthSnapshot()?.quotaInfoSnapshot?.creditSnapshot).toBeUndefined();
      tick(20000);
      http.expectNone(API.creditSnapshot);
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(String(warnings.calls.mostRecent().args[1])).toContain('/api/v1/credits/me');
    }));
  }

  for (const status of [401, 403, 404]) {
    it(`does not retry HTTP ${status}`, fakeAsync(() => {
      beginRefresh();
      http.expectOne(API.creditSnapshot).flush({}, { status, statusText: 'Unavailable' });
      flushMicrotasks();
      tick(20000);
      http.expectNone(API.creditSnapshot);
      expect(warnings).toHaveBeenCalledTimes(1);
    }));
  }

  it('retries transient failures only twice with backoff, without an immediate duplicate request', fakeAsync(() => {
    beginRefresh();
    http.expectOne(API.creditSnapshot).flush({}, { status: 503, statusText: 'Unavailable' });
    flushMicrotasks();
    http.expectNone(API.creditSnapshot);
    tick(1000);
    http.expectOne(API.creditSnapshot).flush({}, { status: 503, statusText: 'Unavailable' });
    flushMicrotasks();
    tick(5000);
    http.expectOne(API.creditSnapshot).flush({}, { status: 503, statusText: 'Unavailable' });
    flushMicrotasks();
    tick(20000);
    http.expectNone(API.creditSnapshot);
    expect(warnings).toHaveBeenCalledTimes(3);
  }));

  it('recovers after a transport timeout', fakeAsync(() => {
    beginRefresh();
    const pending = http.expectOne(API.creditSnapshot);
    tick(8000);
    expect(pending.cancelled).toBeTrue();
    tick(1000);
    http.expectOne(API.creditSnapshot).flush(ledgerPayload);
    flushMicrotasks();
    expect(service.getAuthSnapshot()?.quotaInfoSnapshot?.creditSnapshot?.available_micros).toBe(29_993_290);
    tick(20000);
  }));

  it('stops retrying when a background request returns a malformed schema', fakeAsync(() => {
    beginRefresh();
    http.expectOne(API.creditSnapshot).error(new ProgressEvent('error'));
    flushMicrotasks();
    tick(1000);
    http.expectOne(API.creditSnapshot).flush({ quota_snapshots: {} });
    flushMicrotasks();
    tick(20000);
    http.expectNone(API.creditSnapshot);
    expect(warnings).toHaveBeenCalledTimes(2);
  }));

  it('preserves confirmed same-account Credits but never copies them to another account', fakeAsync(() => {
    beginRefresh();
    http.expectOne(API.creditSnapshot).flush(ledgerPayload);
    flushMicrotasks();
    beginRefresh();
    http.expectOne(API.creditSnapshot).flush({ quota_snapshots: {} });
    flushMicrotasks();
    expect(service.getAuthSnapshot()?.quotaInfoSnapshot?.creditSnapshot?.available_micros).toBe(29_993_290);
    beginRefresh({ ...user, id: 'account-b' });
    http.expectOne(API.creditSnapshot).flush({ quota_snapshots: {} });
    flushMicrotasks();
    expect(service.currentUser?.id).toBe('account-b');
    expect(service.getAuthSnapshot()?.quotaInfoSnapshot?.creditSnapshot).toBeUndefined();
    tick(20000);
  }));

  it('does not publish an in-flight balance after the auth session is invalidated', fakeAsync(() => {
    beginRefresh();
    const pending = http.expectOne(API.creditSnapshot);
    service.requestSessionInvalidation('AUTH_TOKEN_INVALID', 'http-401');
    pending.flush(ledgerPayload);
    flushMicrotasks();
    expect(service.currentUser).toBeNull();
    expect(service.getAuthSnapshot()).toBeNull();
    tick(20000);
  }));

  it('cancels scheduled refreshes on session invalidation', fakeAsync(() => {
    beginRefresh();
    http.expectOne(API.creditSnapshot).flush({}, { status: 503, statusText: 'Unavailable' });
    flushMicrotasks();
    service.requestSessionInvalidation('AUTH_TOKEN_INVALID', 'http-401');
    tick(20000);
    http.expectNone(API.creditSnapshot);
  }));
});

describe('User center Credit rendering', () => {
  let fixture: ComponentFixture<UserCenterComponent>;
  let snapshots: BehaviorSubject<AuthSnapshot | null>;
  let users: BehaviorSubject<any>;
  let auth: { isLoggedIn: boolean; refreshMe: jasmine.Spy };

  beforeEach(async () => {
    snapshots = new BehaviorSubject<AuthSnapshot | null>({
      quotaInfoSnapshot: normalizeAuthQuotaInfoSnapshotPayload(payload),
    });
    auth = { isLoggedIn: true, refreshMe: jasmine.createSpy().and.resolveTo() };
    users = new BehaviorSubject({ subscription_plan: { name: 'free', service_tier: 'pro' } });
    await TestBed.configureTestingModule({
      imports: [UserCenterComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AuthService, useValue: {
          ...auth, authSnapshot$: snapshots, isLoggedIn$: new BehaviorSubject(true),
          userInfo$: users,
          checkAndSyncAuthStatus: () => Promise.resolve(),
          getBenefits: () => of({ status: 200, data: {
            ai_calls: { total: 30, used: 8, resetDate: '2026-10-01T00:00:00Z' },
          } }),
        } },
        { provide: ElectronService, useValue: {} },
        { provide: UiService, useValue: {} },
        { provide: ChildAppSafetyService, useValue: {} },
        { provide: NzMessageService, useValue: {} },
        { provide: ToolI18nService, useValue: { load: () => Promise.resolve() } },
      ],
    }).compileComponents();
    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(UserCenterComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('renders the Credit snapshot instead of legacy benefits or service tier', () => {
    expect(fixture.nativeElement.querySelector('.user-data .value').textContent).toContain('29.99329/30 Credit');
    expect(fixture.nativeElement.textContent).not.toContain('22/30');
    expect(fixture.componentInstance.isProPlanSubscriber).toBeFalse();
    expect(fixture.componentInstance.displayCreditResetDate).toContain('09/15');
  });

  it('updates the existing panel after a new snapshot and shows Pro infinity', () => {
    snapshots.next({ quotaInfoSnapshot: normalizeAuthQuotaInfoSnapshotPayload({ ...payload, subscription_plan: 'pro' }) });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.user-data .value').textContent).toContain('\u267e\ufe0f');
  });

  it('clears the balance on logout without displaying legacy benefits', () => {
    snapshots.next(null);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.user-data .value').textContent.trim()).toBe('--');
    expect(fixture.componentInstance.displayCreditResetDate).toBe('');
  });

  it('shows Pro infinity when the Credit snapshot is unavailable', () => {
    snapshots.next(null);
    users.next({ subscription_plan: { name: 'pro' } });
    fixture.detectChanges();
    expect(fixture.componentInstance.isProPlanSubscriber).toBeTrue();
    expect(fixture.nativeElement.querySelector('.user-data .value').textContent).toContain('\u267e\ufe0f');
    expect(fixture.componentInstance.displayCreditResetDate).toBe('');
  });

  it('does not infer infinity from a service tier or an old unlimited count', () => {
    snapshots.next(null);
    users.next({ subscription_plan: { name: 'free', service_tier: 'pro' }, quota: { total_token: -1 } });
    fixture.detectChanges();
    expect(fixture.componentInstance.isProPlanSubscriber).toBeFalse();
    expect(fixture.nativeElement.querySelector('.user-data .value').textContent.trim()).toBe('--');
  });

  it('clears Pro infinity on logout even before the user stream is cleared', () => {
    snapshots.next(null);
    users.next({ subscription_plan: { name: 'pro' } });
    Object.defineProperty(TestBed.inject(AuthService), 'isLoggedIn', { value: false });
    fixture.detectChanges();
    expect(fixture.componentInstance.isProPlanSubscriber).toBeFalse();
    expect(fixture.nativeElement.querySelector('.user-data .value').textContent.trim()).toBe('--');
  });

  it('refreshes on focus and coalesces concurrent refreshes', async () => {
    let release!: () => void;
    auth.refreshMe.calls.reset();
    auth.refreshMe.and.returnValue(new Promise<void>(resolve => { release = resolve; }));
    fixture.componentInstance.onWindowFocus();
    fixture.componentInstance.onWindowFocus();
    expect(auth.refreshMe).toHaveBeenCalledTimes(1);
    release();
    await fixture.whenStable();
  });

  for (const width of [360, 720]) {
    it(`keeps the Credit value inside the panel at ${width}px`, () => {
      fixture.nativeElement.style.display = 'block';
      fixture.nativeElement.style.width = `${width}px`;
      fixture.detectChanges();
      const panel = fixture.nativeElement.getBoundingClientRect();
      const value = fixture.nativeElement.querySelector('.user-data .value').getBoundingClientRect();
      expect(value.right).toBeLessThanOrEqual(panel.right + 1);
      expect(value.left).toBeGreaterThanOrEqual(panel.left);
    });
  }
});
