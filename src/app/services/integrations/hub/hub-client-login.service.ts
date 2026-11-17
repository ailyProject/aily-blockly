import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { AuthService } from '@core/auth/public-api';
import { ElectronService } from '@core/platform/public-api';
import { ConfigService, ThemeService } from '@core/preferences/public-api';
import { firstValueFrom, filter, map, merge, take, timeout, Subscription } from 'rxjs';
import { getServerUrl } from '../../../configs/api.config';

interface ClientLoginRequest { state: string; code_challenge: string; redirect_uri: string;
  region?: 'cn' | 'intl'; authorization_redirect_uri?: string; expiresAt?: number; }

@Injectable({ providedIn: 'root' })
export class HubClientLoginService implements OnDestroy {
  private removeListener?: () => void;
  private active = false;
  private destroyed = false;
  private themeSubscription?: Subscription;
  constructor(private auth: AuthService, private http: HttpClient, private electron: ElectronService, private zone: NgZone,
    private theme: ThemeService, private config: ConfigService) {}
  private get bridge() { return window.electronAPI?.hubClientLogin; }

  initialize(): void {
    if (this.removeListener || !this.bridge) return;
    this.removeListener = this.bridge.onAuthorize(request => this.zone.run(() => { void this.authorize(request); }));
    const synchronizeTheme = (theme: 'light' | 'dark') => { void this.bridge?.setTheme?.(theme).catch(() => false); };
    this.themeSubscription = this.theme.themeChanged$.subscribe(synchronizeTheme);
    synchronizeTheme(this.theme.theme());
    void this.bridge.ready();
  }

  private async signedIn(region?: 'cn' | 'intl'): Promise<boolean> {
    await this.auth.initializeAuth();
    const clientRegion = this.config.data?.region;
    if (region && region !== (clientRegion === 'cn' ? 'cn' : ['eu', 'intl'].includes(clientRegion) ? 'intl' : undefined)) {
      throw new Error('region_mismatch');
    }
    if (this.auth.isLoggedIn) return true;
    this.auth.requestLogin('hub-client-login');
    return firstValueFrom(merge(
      this.auth.isLoggedIn$.pipe(filter(Boolean), map(() => true)),
      // AuthService closes this dialog synchronously before later login subscribers run.
      this.auth.loginDialogRequest$.pipe(filter(value => value === null), map(() => this.auth.isLoggedIn)),
    ).pipe(take(1), timeout(120_000)));
  }

  private async authorize(request: ClientLoginRequest): Promise<void> {
    if (this.active || this.destroyed) return;
    this.active = true;
    const expiresAt = Math.min(request.expiresAt ?? Date.now() + 120_000, Date.now() + 120_000);
    const callback = new URL('/auth/desktop', request.redirect_uri);
    const authorizationCallback = new URL(request.authorization_redirect_uri ?? request.redirect_uri);
    callback.searchParams.set('state', request.state);
    try {
      if (!await this.signedIn(request.region) || this.destroyed) throw new Error('cancelled');
      const generation = this.auth.getAuthCredentialGeneration(), account = this.auth.currentUser?.id;
      const api = getServerUrl().replace(/\/+$/, ''), token = await this.auth.getToken2();
      const current = () => !this.destroyed && Date.now() < expiresAt && this.auth.isLoggedIn && !this.auth.isSessionInvalidating
        && account && this.auth.currentUser?.id === account && generation === this.auth.getAuthCredentialGeneration()
        && api === getServerUrl().replace(/\/+$/, '');
      if (!token || !current()) throw new Error('account_changed');
      const identity = await firstValueFrom(this.http.get<{ status: number; data: { id: string; nickname?: string; email?: string } }>(
        `${api}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } }).pipe(timeout(12000)));
      if (identity.status !== 200 || identity.data?.id !== account || !current() || await this.auth.getToken2() !== token) throw new Error('account_changed');
      const user = identity.data;
      const approved = await this.bridge?.confirm({ state: request.state,
        account: [user.nickname || user.id, user.email].filter(Boolean).join(' · ').slice(0, 512), theme: this.theme.theme() });
      if (!approved || !current() || await this.auth.getToken2() !== token) throw new Error('cancelled');
      const result = await firstValueFrom(this.http.post<{ status: number; data: { redirect_url: string } }>(
        `${api}/api/v1/auth/hub/authorize`, { client_id: 'aily-hub', redirect_uri: authorizationCallback.href,
          state: request.state, code_challenge: request.code_challenge, code_challenge_method: 'S256',
          scope: 'identity workspace:read', approved: true }, { headers: { Authorization: `Bearer ${token}` } }).pipe(timeout(15000)));
      if (!current() || await this.auth.getToken2() !== token) throw new Error('account_changed');
      const redirect = new URL(result.data?.redirect_url);
      if (result.status !== 200 || redirect.origin !== authorizationCallback.origin || redirect.pathname !== authorizationCallback.pathname
        || redirect.username || redirect.password || redirect.hash || [...redirect.searchParams.keys()].length !== 2
        || redirect.searchParams.getAll('code').length !== 1 || !redirect.searchParams.get('code')
        || redirect.searchParams.getAll('state').length !== 1 || redirect.searchParams.get('state') !== request.state) throw new Error('invalid_callback');
      callback.searchParams.set('code', redirect.searchParams.get('code')!);
      callback.searchParams.set('sourceApiUrl', api);
    } catch (error) {
      const known = ['account_changed', 'region_mismatch', 'invalid_callback'];
      const reason = error instanceof Error && error.message === 'cancelled' ? 'access_denied'
        : error instanceof Error && known.includes(error.message) ? error.message
        : error instanceof HttpErrorResponse && [0, 404, 502, 503, 504].includes(error.status) ? 'authorization_unavailable' : 'authorization_failed';
      callback.searchParams.set('error', reason);
      if (reason !== 'access_denied') console.warn('[HubLogin] Authorization failed', { reason,
        status: error instanceof HttpErrorResponse ? error.status : undefined });
    } finally {
      this.active = false;
      try { if (!this.destroyed) this.electron.openUrl(callback.toString()); }
      finally { await this.bridge?.finish(request.state).catch(() => false); }
    }
  }

  ngOnDestroy(): void { this.destroyed = true; this.removeListener?.(); this.themeSubscription?.unsubscribe(); }
}
