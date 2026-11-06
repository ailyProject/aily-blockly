import { of, Subject } from 'rxjs';
import { setServerUrl } from '../../../configs/api.config';
import { HubNavigationService } from './hub-navigation.service';

describe('Hub desktop account navigation', () => {
  let service: HubNavigationService, listener: (data: any) => void;
  let auth: any, config: any, bridge: any, electron: any, http: any, message: any;
  let result: Subject<any>, previousBridge: any;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const returnUrl = '/publish?cloudProject=cloud&app=ailyblockly';

  beforeEach(() => {
    setServerUrl('https://api.example');
    previousBridge = window['electronAPI'];
    result = new Subject();
    auth = { isLoggedIn: true, isSessionInvalidating: false, currentUser: { id: 'account-a' },
      getAuthCredentialGeneration: jasmine.createSpy().and.returnValue(1), getToken2: jasmine.createSpy().and.resolveTo('fixture-token') };
    config = { getHubWebUrl: (path = '') => `https://hub.example${path}${path.includes('?') ? '&' : '?'}app=ailyblockly`,
      isCoderProduct: () => false };
    bridge = { begin: jasmine.createSpy().and.resolveTo(true), cancel: jasmine.createSpy().and.resolveTo(),
      onAuthorize: (callback: any) => { listener = callback; return () => {}; } };
    window['electronAPI'] = { hubDesktop: bridge } as any;
    electron = { openUrl: jasmine.createSpy('openUrl') };
    http = { get: jasmine.createSpy('get').and.returnValue(of({ status: 200, data: { id: 'account-a' } })),
      post: jasmine.createSpy('post').and.returnValue(result) };
    message = { error: jasmine.createSpy('error') };
    service = new HubNavigationService(auth, config, electron, http, message, { run: (fn: any) => fn() } as any);
  });

  afterEach(() => {
    service.ngOnDestroy();
    window['electronAPI'] = previousBridge;
    setServerUrl('https://api.aily.pro');
  });

  function protocol() {
    const initial = new URL(electron.openUrl.calls.mostRecent().args[0]);
    return { request: initial.searchParams.get('request'), state: 's'.repeat(43), code_challenge: 'c'.repeat(43),
      sourceApiUrl: 'https://api.example', redirect_uri: 'https://hub.example/auth/callback', returnUrl };
  }

  function respond(data: any, redirect = `https://hub.example/auth/callback?code=fixture-code&state=${data.state}`) {
    result.next({ status: 200, data: { redirect_url: redirect } });
    result.complete();
  }

  it('keeps anonymous browsing public and requires a client account for publishing', async () => {
    auth.isLoggedIn = false;
    await service.open('/projects');
    expect(electron.openUrl).toHaveBeenCalledOnceWith('https://hub.example/projects?app=ailyblockly');
    await service.open('/publish?cloudProject=cloud');
    expect(electron.openUrl).toHaveBeenCalledTimes(1);
    expect(bridge.begin).not.toHaveBeenCalled();
  });

  it('registers a random request locally before opening Hub and deduplicates concurrent clicks', async () => {
    await Promise.all([service.open('/publish?cloudProject=cloud'), service.open('/publish?cloudProject=cloud')]);
    const url = new URL(electron.openUrl.calls.mostRecent().args[0]);
    expect(url.pathname).toBe('/auth/desktop');
    expect(url.searchParams.get('request')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bridge.begin).toHaveBeenCalledOnceWith(url.searchParams.get('request'));
    expect(url.searchParams.get('sourceApiUrl')).toBe('https://api.example');
    expect(url.searchParams.get('product')).toBe('blockly');
    expect(url.searchParams.get('returnUrl')).toBe(returnUrl);
    expect(electron.openUrl).toHaveBeenCalledTimes(1);
  });

  it('rejects a stable replacement shared token when the client user snapshot still shows the old account', async () => {
    auth.getToken2.and.resolveTo('account-b-fixture-token');
    http.get.and.returnValue(of({ status: 200, data: { id: 'account-b' } }));
    await service.open('/publish?cloudProject=cloud');
    expect(http.get).toHaveBeenCalledOnceWith('https://api.example/api/v1/auth/me');
    expect(bridge.begin).not.toHaveBeenCalled();
    expect(electron.openUrl).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('authorizes a matching local request once, using the fixed Hub contract', async () => {
    await service.open('/publish?cloudProject=cloud');
    const data = protocol();
    listener({ ...data, request: 'another-device' });
    expect(http.post).not.toHaveBeenCalled();
    listener(data);
    listener(data);
    await settle();
    expect(http.post).toHaveBeenCalledOnceWith('https://api.example/api/v1/auth/hub/authorize', {
      client_id: 'aily-hub', redirect_uri: data.redirect_uri, state: data.state, code_challenge: data.code_challenge,
      code_challenge_method: 'S256', scope: 'identity workspace:read', approved: true,
    });
    respond(data);
    await settle();
    expect(electron.openUrl.calls.mostRecent().args[0]).toBe(`https://hub.example/auth/desktop?code=fixture-code&state=${data.state}`);
    listener(data);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  for (const change of ['account', 'credentials', 'shared-token', 'API', 'Hub', 'logout', 'expiry', 'source', 'redirect', 'returnUrl']) {
    it(`rejects a pending request after its ${change} changes`, async () => {
      await service.open('/publish?cloudProject=cloud');
      const data = protocol();
      if (change === 'account') auth.currentUser = { id: 'account-b' };
      if (change === 'credentials') auth.getAuthCredentialGeneration.and.returnValue(2);
      if (change === 'shared-token') auth.getToken2.and.resolveTo('replacement-fixture-token');
      if (change === 'API') setServerUrl('https://other-api.example');
      if (change === 'Hub') config.getHubWebUrl = () => 'https://other-hub.example';
      if (change === 'logout') auth.isLoggedIn = false;
      if (change === 'expiry') (service as any).pending.expiresAt = 0;
      if (change === 'source') data.sourceApiUrl = 'https://other-api.example';
      if (change === 'redirect') data.redirect_uri = 'https://other-hub.example/auth/callback';
      if (change === 'returnUrl') data.returnUrl = '/projects';
      listener(data);
      await settle();
      expect(http.post).not.toHaveBeenCalled();
      expect(electron.openUrl).toHaveBeenCalledTimes(1);
      expect(bridge.cancel).toHaveBeenCalledWith(data.request);
    });
  }

  it('discards a late authorization response after the client changes accounts', async () => {
    await service.open('/publish?cloudProject=cloud');
    const data = protocol();
    listener(data);
    await settle();
    auth.currentUser = { id: 'account-b' };
    respond(data);
    await settle();
    expect(electron.openUrl).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh handoff after account change instead of retaining the former account request', async () => {
    await service.open('/publish?cloudProject=cloud');
    const old = protocol();
    auth.currentUser = { id: 'account-b' };
    http.get.and.returnValue(of({ status: 200, data: { id: 'account-b' } }));
    await service.open('/projects');
    expect(electron.openUrl).toHaveBeenCalledTimes(2);
    expect(bridge.cancel).toHaveBeenCalledWith(old.request);
    listener(old);
    expect(http.post).not.toHaveBeenCalled();
  });

  for (const suffix of ['#fragment', '&extra=value', '&code=duplicate']) {
    it(`rejects an authorization redirect containing ${suffix}`, async () => {
      await service.open('/publish?cloudProject=cloud');
      const data = protocol();
      listener(data);
      await settle();
      respond(data, `https://hub.example/auth/callback?code=fixture-code&state=${data.state}${suffix}`);
      await settle();
      expect(electron.openUrl).toHaveBeenCalledTimes(1);
      expect(message.error).toHaveBeenCalled();
    });
  }

  for (const redirect of ['https://other.example/auth/callback?code=c&state=s',
    'https://hub.example/other?code=c&state=s', 'https://hub.example/auth/callback?code=c&state=wrong']) {
    it(`rejects a mismatched authorization destination: ${redirect}`, async () => {
      await service.open('/publish?cloudProject=cloud');
      const data = protocol();
      listener(data);
      await settle();
      respond(data, redirect);
      await settle();
      expect(electron.openUrl).toHaveBeenCalledTimes(1);
    });
  }
});
