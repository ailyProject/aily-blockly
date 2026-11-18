import { BehaviorSubject, of, Subject, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { setServerUrl } from '../../../configs/api.config';
import { HubClientLoginService } from './hub-client-login.service';

describe('Hub browser login with client confirmation', () => {
  let service: HubClientLoginService, listener: (request: any) => void, auth: any, http: any, bridge: any, electron: any, previous: any, theme: any;
  let config: { data: { region: string } };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const request = (state = 's'.repeat(43)) => ({ state, code_challenge: 'c'.repeat(43), redirect_uri: 'https://hub.aily.pro/auth/callback', region: 'cn' });
  beforeEach(() => {
    previous = window.electronAPI; setServerUrl('https://api.example');
    auth = { isLoggedIn: true, isSessionInvalidating: false, currentUser: { id: 'b' },
      initializeAuth: jasmine.createSpy().and.resolveTo(), getToken2: jasmine.createSpy().and.resolveTo('token-b'),
      getAuthCredentialGeneration: jasmine.createSpy().and.returnValue(1), requestLogin: jasmine.createSpy(),
      isLoggedIn$: new BehaviorSubject(true), loginDialogRequest$: new BehaviorSubject({ requestId: 1 }) };
    bridge = { ready: jasmine.createSpy().and.resolveTo(true), confirm: jasmine.createSpy().and.resolveTo(true),
      setTheme: jasmine.createSpy().and.resolveTo(true),
      finish: jasmine.createSpy().and.resolveTo(true), onAuthorize: (fn: any) => { listener = fn; return () => {}; } };
    window.electronAPI = { hubClientLogin: bridge } as any;
    http = { get: jasmine.createSpy().and.returnValue(of({ status: 200, data: { id: 'b', nickname: '账号 B', email: 'b@example.test' } })),
      post: jasmine.createSpy().and.callFake((_url: string, body: any) => of({ status: 200,
        data: { redirect_url: `https://hub.aily.pro/auth/callback?code=code-b&state=${body.state}` } })) };
    electron = { openUrl: jasmine.createSpy() };
    theme = { theme: jasmine.createSpy().and.returnValue('dark'), themeChanged$: new Subject() };
    config = { data: { region: 'cn' } };
    service = new HubClientLoginService(auth, http, electron, { run: (fn: any) => fn() } as any, theme, config as any); service.initialize();
  });
  afterEach(() => { service.ngOnDestroy(); window.electronAPI = previous; setServerUrl('https://api.aily.pro'); });

  it('does not request a code before the native confirmation resolves', async () => {
    let approve!: (value: boolean) => void;
    bridge.confirm.and.returnValue(new Promise(resolve => { approve = resolve; }));
    listener(request()); await settle();
    expect(bridge.confirm).toHaveBeenCalledOnceWith({ state: 's'.repeat(43), account: '账号 B · b@example.test', theme: 'dark' });
    expect(http.post).not.toHaveBeenCalled(); expect(electron.openUrl).not.toHaveBeenCalled();
    approve(true); await settle();
    expect(http.post.calls.mostRecent().args[2].headers.Authorization).toBe('Bearer token-b');
    const callback = new URL(electron.openUrl.calls.mostRecent().args[0]);
    expect(callback.pathname).toBe('/auth/desktop'); expect(callback.searchParams.get('sourceApiUrl')).toBe('https://api.example');
    expect(callback.searchParams.get('code')).toBe('code-b');
  });

  it('cancels without creating a code or reusing a previous browser identity', async () => {
    bridge.confirm.and.resolveTo(false); listener(request()); await settle();
    expect(http.post).not.toHaveBeenCalled();
    expect(new URL(electron.openUrl.calls.mostRecent().args[0]).searchParams.get('error')).toBe('access_denied');
    expect(bridge.finish).toHaveBeenCalledWith('s'.repeat(43));
  });

  it('continues in the initiating browser tab for successful and failed authorization without opening another tab', async () => {
    bridge.deliver = jasmine.createSpy().and.resolveTo(true);
    listener(request()); await settle();
    expect(bridge.deliver).toHaveBeenCalledWith(request().state, jasmine.stringMatching('/auth/desktop'));
    expect(electron.openUrl).not.toHaveBeenCalled();
    bridge.confirm.and.resolveTo(false); listener(request('t'.repeat(43))); await settle();
    expect(bridge.deliver.calls.mostRecent().args[1]).toContain('error=access_denied');
    expect(electron.openUrl).not.toHaveBeenCalled();
  });

  it('opens the normal receipt only when the initiating tab cannot receive it', async () => {
    bridge.deliver = jasmine.createSpy().and.resolveTo(false);
    listener(request()); await settle(); expect(electron.openUrl).toHaveBeenCalledTimes(1);
    expect(bridge.finish).toHaveBeenCalledWith(request().state);
  });

  it('starts a fresh authorization for the newly signed-in client account', async () => {
    listener(request()); await settle();
    auth.currentUser = { id: 'c' }; auth.getToken2.and.resolveTo('token-c'); auth.getAuthCredentialGeneration.and.returnValue(2);
    http.get.and.returnValue(of({ status: 200, data: { id: 'c', nickname: '账号 C' } }));
    listener(request('t'.repeat(43))); await settle();
    expect(bridge.confirm.calls.mostRecent().args[0].account).toBe('账号 C');
    expect(http.post.calls.mostRecent().args[2].headers.Authorization).toBe('Bearer token-c');
  });

  it('rejects an account switch while the consent dialog is open', async () => {
    let approve!: (value: boolean) => void;
    bridge.confirm.and.returnValue(new Promise(resolve => { approve = resolve; }));
    listener(request()); await settle(); auth.currentUser = { id: 'c' }; approve(true); await settle();
    expect(http.post).not.toHaveBeenCalled();
    expect(new URL(electron.openUrl.calls.mostRecent().args[0]).searchParams.has('code')).toBeFalse();
  });

  it('rejects a late code after the client credentials change', async () => {
    const result = new Subject<any>(); http.post.and.returnValue(result);
    listener(request()); await settle(); auth.getAuthCredentialGeneration.and.returnValue(2);
    result.next({ status: 200, data: { redirect_url: request().redirect_uri + '?code=old&state=' + request().state } });
    result.complete(); await settle();
    expect(new URL(electron.openUrl.calls.mostRecent().args[0]).searchParams.has('code')).toBeFalse();
  });

  it('verifies the token owner rather than trusting a stale client user snapshot', async () => {
    http.get.and.returnValue(of({ status: 200, data: { id: 'different-account' } })); listener(request()); await settle();
    expect(bridge.confirm).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
  });

  it('does not authorize an expired request', async () => {
    listener({ ...request(), expiresAt: Date.now() - 1 }); await settle();
    expect(bridge.confirm).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
  });

  it('continues after signing in when AuthService closes the login dialog before notifying later subscribers', async () => {
    auth.isLoggedIn = false; auth.isLoggedIn$.next(false);
    const dismissal = auth.isLoggedIn$.subscribe((loggedIn: boolean) => {
      if (loggedIn) { auth.isLoggedIn = true; auth.loginDialogRequest$.next(null); }
    });
    listener(request()); await settle();
    expect(auth.requestLogin).toHaveBeenCalledWith('hub-client-login');
    expect(bridge.confirm).not.toHaveBeenCalled();
    auth.isLoggedIn$.next(true); await settle(); dismissal.unsubscribe();
    expect(bridge.confirm).toHaveBeenCalled(); expect(http.post).toHaveBeenCalled();
  });

  it('cancels when the client login dialog closes without an authenticated account', async () => {
    auth.isLoggedIn = false; auth.isLoggedIn$.next(false);
    listener(request()); await settle(); auth.loginDialogRequest$.next(null); await settle();
    expect(bridge.confirm).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
    expect(new URL(electron.openUrl.calls.mostRecent().args[0]).searchParams.get('error')).toBe('access_denied');
  });

  it('uses the application theme and follows theme changes until the service is destroyed', async () => {
    expect(bridge.setTheme).toHaveBeenCalledWith('dark');
    theme.theme.and.returnValue('light'); theme.themeChanged$.next('light');
    expect(bridge.setTheme.calls.mostRecent().args[0]).toBe('light');
    listener(request()); await settle(); expect(bridge.confirm.calls.mostRecent().args[0].theme).toBe('light');
    service.ngOnDestroy(); bridge.setTheme.calls.reset(); theme.themeChanged$.next('dark');
    expect(bridge.setTheme).not.toHaveBeenCalled();
  });
  it('uses the registered provider callback while returning the code to the local browser', async () => {
    listener({ ...request(), redirect_uri: 'http://localhost:65469/auth/callback',
      authorization_redirect_uri: 'https://hub.aily.pro/auth/callback' }); await settle();
    expect(http.post.calls.mostRecent().args[1].redirect_uri).toBe('https://hub.aily.pro/auth/callback');
    const receipt = new URL(electron.openUrl.calls.mostRecent().args[0]);
    expect(receipt.origin).toBe('http://localhost:65469'); expect(receipt.searchParams.get('code')).toBe('code-b');
  });

  it('refuses another site before confirmation without switching the signed-in account', async () => {
    auth.isLoggedIn = false; auth.isLoggedIn$.next(false);
    listener({ ...request(), region: 'intl' }); await settle();
    expect(bridge.confirm).not.toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
    expect(auth.requestLogin).not.toHaveBeenCalled();
    expect(new URL(electron.openUrl.calls.mostRecent().args[0]).searchParams.get('error')).toBe('region_mismatch');
    expect(auth.currentUser.id).toBe('b');
  });

  for (const [region, api, redirect] of [
    ['cn', 'https://api.yiyu.pro', 'https://hub.aily.pro/auth/callback'],
    ['eu', 'https://api.aily.pro', 'https://projects.aily.pro/auth/callback'],
  ]) {
    it('uses the configured ' + region + ' server and its registered callback for a regionless request', async () => {
      config.data.region = region; setServerUrl(api);
      bridge.deliver = jasmine.createSpy().and.resolveTo(true);
      http.post.and.returnValue(of({ status: 200, data: { redirect_url: redirect + '?state=' + request().state + '&code=code-b' } }));
      listener({ ...request(), region: undefined, authorization_redirect_uri: 'https://hub.aily.pro/auth/callback',
        authorization_redirect_uri_intl: 'https://projects.aily.pro/auth/callback' });
      await settle();
      expect(http.get.calls.mostRecent().args[0]).toBe(api + '/api/v1/auth/me');
      expect(http.post.calls.mostRecent().args[0]).toBe(api + '/api/v1/auth/hub/authorize');
      expect(http.post.calls.mostRecent().args[1].redirect_uri).toBe(redirect);
      const returned = new URL(bridge.deliver.calls.mostRecent().args[1]);
      expect(returned.searchParams.get('sourceApiUrl')).toBe(api);
      expect(returned.searchParams.get('code')).toBe('code-b');
      expect(electron.openUrl).not.toHaveBeenCalled();
    });
  }

  it('reports a failed authorization service separately from user cancellation', async () => {
    http.post.and.returnValue(throwError(() => new HttpErrorResponse({ status: 404 })));
    listener(request()); await settle();
    expect(new URL(electron.openUrl.calls.mostRecent().args[0]).searchParams.get('error')).toBe('authorization_unavailable');
  });

});
